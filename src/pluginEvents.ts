import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import { dirname } from "node:path";
import { Webhook } from "standardwebhooks";
import type { PlaybackStateStore } from "./netease/playbackState.js";
import type { InMemoryEventQueue } from "./queue.js";

export const NETEASE_MESSAGE_EVENT = "netease.message.created";

export const NETEASE_MESSAGE_EVENT_DEFINITION = {
  name: NETEASE_MESSAGE_EVENT,
  description: "A new owner-authored message addressed to 小助手 arrived in the active NetEase Listen Together room.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      message_id: { type: "string" },
      text: { type: "string" },
      in_room: { type: "boolean" },
      play_status: { type: "string", enum: ["PLAY", "PAUSE", "UNKNOWN"] },
      progress_ms: { type: "number" },
      duration_ms: { type: "number" },
      song: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          artist: { type: "string" },
          duration_ms: { type: "number" },
        },
        required: ["id", "name", "artist", "duration_ms"],
        additionalProperties: false,
      },
      lyric: {
        type: "object",
        properties: {
          previous: { type: "string" },
          current: { type: "string" },
          next: { type: "string" },
        },
        additionalProperties: false,
      },
      observed_at: { type: ["string", "null"] },
    },
    required: ["message_id", "text", "in_room", "play_status", "progress_ms", "duration_ms", "observed_at"],
    additionalProperties: false,
  },
} as const;

type Delivery = {
  mode: "webhook";
  url: string;
  secret: string;
};

export type EventSubscribeInput = {
  name: string;
  arguments?: Record<string, unknown>;
  delivery: Delivery;
  cursor?: string | null;
  ttlMs?: number | null;
};

export type EventUnsubscribeInput = {
  name: string;
  arguments?: Record<string, unknown>;
  delivery: Omit<Delivery, "secret">;
};

type EventSubscription = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  expiresAt: string;
  previousSecret?: string;
  previousSecretUntil?: string;
};

type PostResult = {
  status: number;
  body: string;
};

export type WebhookPoster = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<PostResult>;

export class CallbackEndpointError extends Error {
  constructor(readonly reason: "invalid_url" | "invalid_secret" | "challenge_failed" | "timeout") {
    super(`MCP callback endpoint error: ${reason}`);
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const MIN_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60_000;
const SECRET_ROTATION_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [0, 1_000, 3_000];
const MAX_RESPONSE_BYTES = 16 * 1024;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateWebhookSecret(secret: string): void {
  if (!secret.startsWith("whsec_")) throw new CallbackEndpointError("invalid_secret");
  const encoded = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new CallbackEndpointError("invalid_secret");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length < 24 || decoded.length > 64) {
    throw new CallbackEndpointError("invalid_secret");
  }
}

function signatureHeaders(
  subscription: EventSubscription,
  messageId: string,
  body: string,
  signedAt = new Date(),
): Record<string, string> {
  const signatures = [new Webhook(subscription.secret).sign(messageId, signedAt, body)];
  if (
    subscription.previousSecret
    && subscription.previousSecretUntil
    && Date.parse(subscription.previousSecretUntil) > Date.now()
  ) {
    signatures.push(new Webhook(subscription.previousSecret).sign(messageId, signedAt, body));
  }
  return {
    "Content-Type": "application/json",
    "webhook-id": messageId,
    "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": subscription.id,
  };
}

export async function postWebhookPinned(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
): Promise<PostResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CallbackEndpointError("invalid_url");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || url.hostname === "localhost"
  ) {
    throw new CallbackEndpointError("invalid_url");
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new CallbackEndpointError("invalid_url");
  for (const entry of addresses) {
    const family = entry.family === 6 ? "ipv6" : "ipv4";
    if (blockedAddresses.check(entry.address, family)) {
      throw new CallbackEndpointError("invalid_url");
    }
  }
  const selected = addresses[0];

  return await new Promise<PostResult>((resolve, reject) => {
    const req = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      servername: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": String(Buffer.byteLength(body)),
      },
      lookup: (_hostname, _options, callback) => {
        callback(null, selected.address, selected.family);
      },
      signal: AbortSignal.timeout(10_000),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(buffer);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", (error) => {
      if (error instanceof Error && error.name === "AbortError") {
        reject(new CallbackEndpointError("timeout"));
        return;
      }
      reject(error);
    });
    req.end(body);
  });
}

export class McpEventBridge {
  private readonly subscriptions = new Map<string, EventSubscription>();
  private dispatching = false;

  constructor(
    private readonly queue: InMemoryEventQueue,
    private readonly playbackState: PlaybackStateStore,
    private readonly storagePath = process.env.BRIDGE_EVENT_STATE_PATH?.trim()
      || "/data/cove-event-subscriptions.json",
    private readonly poster: WebhookPoster = postWebhookPinned,
  ) {
    this.load();
  }

  status(): { subscriptions: number; dispatching: boolean } {
    this.purgeExpired();
    return { subscriptions: this.subscriptions.size, dispatching: this.dispatching };
  }

  async subscribe(input: EventSubscribeInput): Promise<{
    id: string;
    refreshBefore: string;
    cursor: null;
    truncated: false;
  }> {
    if (input.name !== NETEASE_MESSAGE_EVENT || Object.keys(input.arguments ?? {}).length > 0) {
      throw new Error("Unsupported MCP event subscription.");
    }
    if (input.delivery.mode !== "webhook") throw new Error("Only webhook delivery is supported.");
    validateWebhookSecret(input.delivery.secret);

    const argumentsValue = input.arguments ?? {};
    const id = `sub_${createHash("sha256")
      .update(`owner\n${input.delivery.url}\n${input.name}\n${canonicalJson(argumentsValue)}`)
      .digest("hex")
      .slice(0, 32)}`;
    const existing = this.subscriptions.get(id);
    const provisional: EventSubscription = {
      id,
      name: input.name,
      arguments: argumentsValue,
      url: input.delivery.url,
      secret: input.delivery.secret,
      expiresAt: new Date(Date.now() + this.grantedTtl(input.ttlMs)).toISOString(),
    };

    if (!existing || existing.secret !== input.delivery.secret) {
      await this.verifyCallback(provisional);
    }
    if (existing && existing.secret !== provisional.secret) {
      provisional.previousSecret = existing.secret;
      provisional.previousSecretUntil = new Date(Date.now() + SECRET_ROTATION_MS).toISOString();
    }

    // This private bridge intentionally has one active ChatGPT Work destination.
    this.subscriptions.clear();
    this.subscriptions.set(id, provisional);
    this.persist();
    this.wake();
    return {
      id,
      refreshBefore: provisional.expiresAt,
      cursor: null,
      truncated: false,
    };
  }

  unsubscribe(input: EventUnsubscribeInput): Record<string, never> {
    const argumentsValue = input.arguments ?? {};
    for (const [id, subscription] of this.subscriptions) {
      if (
        subscription.name === input.name
        && subscription.url === input.delivery.url
        && canonicalJson(subscription.arguments) === canonicalJson(argumentsValue)
      ) {
        this.subscriptions.delete(id);
      }
    }
    this.persist();
    return {};
  }

  wake(): void {
    if (this.dispatching) return;
    void this.dispatchLoop();
  }

  private async verifyCallback(subscription: EventSubscription): Promise<void> {
    const challenge = randomBytes(24).toString("base64url");
    const messageId = `msg_verification_${randomUUID()}`;
    const body = JSON.stringify({ type: "verification", challenge });
    let result: PostResult;
    try {
      result = await this.poster(
        subscription.url,
        body,
        signatureHeaders(subscription, messageId, body),
      );
    } catch (error) {
      if (error instanceof CallbackEndpointError) throw error;
      throw new CallbackEndpointError("challenge_failed");
    }
    if (result.status < 200 || result.status >= 300) {
      throw new CallbackEndpointError("challenge_failed");
    }
    let echoed = "";
    try {
      const parsed = JSON.parse(result.body) as { challenge?: unknown };
      if (typeof parsed.challenge === "string") echoed = parsed.challenge;
    } catch {
      throw new CallbackEndpointError("challenge_failed");
    }
    if (!constantTimeStringEqual(challenge, echoed)) {
      throw new CallbackEndpointError("challenge_failed");
    }
  }

  private async dispatchLoop(): Promise<void> {
    this.dispatching = true;
    try {
      while (true) {
        this.purgeExpired();
        const subscription = this.subscriptions.values().next().value as EventSubscription | undefined;
        if (!subscription) return;

        const event = this.queue.reserveNext((candidate) => candidate.source === "netease.chatroom");
        if (!event) return;

        const state = this.playbackState.getCurrentState();
        const payload = {
          eventId: event.id,
          name: NETEASE_MESSAGE_EVENT,
          timestamp: event.createdAt,
          data: {
            message_id: event.id,
            text: event.visibleText,
            in_room: state.inRoom,
            play_status: state.playStatus,
            progress_ms: state.progressMs,
            duration_ms: state.durationMs,
            ...(state.song ? {
              song: {
                id: state.song.id,
                name: state.song.name,
                artist: state.song.artist,
                duration_ms: state.song.durationMs,
              },
            } : {}),
            ...(state.lyric ? { lyric: state.lyric } : {}),
            observed_at: state.observedAt,
          },
          cursor: null,
        };
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body, "utf8") > 256 * 1024) {
          this.queue.release(event.id);
          console.error(`MCP event payload rejected locally: eventId=${event.id} reason=too_large`);
          return;
        }

        let accepted = false;
        for (const delay of RETRY_DELAYS_MS) {
          if (delay) await sleep(delay);
          try {
            const response = await this.poster(
              subscription.url,
              body,
              signatureHeaders(subscription, event.id, body),
            );
            if (response.status >= 200 && response.status < 300) {
              accepted = true;
              break;
            }
            if (response.status === 410) {
              this.subscriptions.delete(subscription.id);
              this.persist();
              break;
            }
            if (response.status === 413) break;
          } catch (error) {
            if (error instanceof CallbackEndpointError && error.reason === "invalid_url") break;
          }
        }

        if (!accepted) {
          this.queue.release(event.id);
          return;
        }
        this.queue.markDelivered(event.id);
        console.log(`MCP event delivered: eventId=${event.id} name=${NETEASE_MESSAGE_EVENT}`);
        // A required reply now owns the conversation lock. The reply tool wakes us again.
        return;
      }
    } finally {
      this.dispatching = false;
    }
  }

  private grantedTtl(requested: number | null | undefined): number {
    if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_TTL_MS;
    return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, requested));
  }

  private purgeExpired(): void {
    let changed = false;
    const now = Date.now();
    for (const [id, subscription] of this.subscriptions) {
      if (Date.parse(subscription.expiresAt) <= now) {
        this.subscriptions.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as {
        version?: unknown;
        subscriptions?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.subscriptions)) return;
      for (const value of parsed.subscriptions) {
        if (!value || typeof value !== "object") continue;
        const subscription = value as EventSubscription;
        if (
          typeof subscription.id !== "string"
          || subscription.name !== NETEASE_MESSAGE_EVENT
          || typeof subscription.url !== "string"
          || typeof subscription.secret !== "string"
          || typeof subscription.expiresAt !== "string"
          || Date.parse(subscription.expiresAt) <= Date.now()
        ) continue;
        try {
          validateWebhookSecret(subscription.secret);
        } catch {
          continue;
        }
        this.subscriptions.set(subscription.id, subscription);
      }
      if (this.subscriptions.size > 0) {
        console.log(`MCP event subscriptions restored: count=${this.subscriptions.size}`);
      }
    } catch {
      // First boot or an unavailable optional persistence path is safe.
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.storagePath}.tmp`;
      writeFileSync(temporary, JSON.stringify({
        version: 1,
        subscriptions: [...this.subscriptions.values()],
      }), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.storagePath);
    } catch {
      console.error("MCP event subscription persistence failed");
    }
  }
}
