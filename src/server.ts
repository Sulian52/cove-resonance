import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createMcpServer } from "./mcp.js";
import { listenerWakeHub } from "./listenerWake.js";
import { PlaybackStateStore } from "./netease/playbackState.js";
import { createTogetherWorker } from "./netease/togetherWorker.js";
import { InMemoryEventQueue } from "./queue.js";
import { createReadOnlyMcpServer, publicNow } from "./now.js";
import type { BridgeEvent, BridgeStream, ReplyPolicy, ReplyRoute } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";
const INGEST_TOKEN = process.env.BRIDGE_INGEST_TOKEN ?? "";
// Safe by default for public deployments. Full bridge access requires a secret.
const READ_ONLY = process.env.BRIDGE_READ_ONLY !== "false";
const MCP_TOKEN = process.env.BRIDGE_MCP_TOKEN?.trim() ?? "";
const UNIX_SOCKET = process.env.BRIDGE_UNIX_SOCKET?.trim() ?? "";
const queue = new InMemoryEventQueue();
const playbackState = new PlaybackStateStore();

function replyRoutingFor(source: string): { replyRoute?: ReplyRoute; replyPolicy?: ReplyPolicy } {
  if (source === "netease.chatroom") {
    return { replyRoute: "netease.chatroom", replyPolicy: "required" };
  }
  if (source.startsWith("netease.")) {
    return { replyRoute: "netease.chatroom", replyPolicy: "optional" };
  }
  return {};
}

function streamRoutingFor(source: string): { stream: BridgeStream; stateKey?: string } {
  if (source === "netease.chatroom") {
    return { stream: "conversation" };
  }
  if (source.startsWith("netease.")) {
    return { stream: "state", stateKey: "netease.together.presence" };
  }
  return { stream: "conversation" };
}

function buildBridgeEvent(
  id: string,
  source: string,
  text: string,
  createdAt = new Date().toISOString(),
  additionalModelContext?: string,
): BridgeEvent {
  const routing = replyRoutingFor(source);
  const streamRouting = streamRoutingFor(source);
  const routeLines = routing.replyRoute
    ? [
        `replyRoute=${routing.replyRoute}`,
        `replyPolicy=${routing.replyPolicy ?? "optional"}`,
        routing.replyPolicy === "required"
          ? "ROUTING CONTRACT (mandatory): before completing this turn, call cove_bridge_reply exactly once and put the complete user-facing reply in messages[]. A reply shown only in ChatGPT is incomplete because the user is waiting in NetEase ChatRoom. For normal conversation, default to 2-5 short natural bubbles; use one bubble only for a genuinely brief reply. Do not pack a multi-sentence reply into one bubble, and do not invent filler merely to increase the count. eventId may be omitted because the Bridge binds to the active required event. Do not use netease_together_send_message directly."
          : "ROUTING CONTRACT (optional): if you choose to send a user-facing reaction for this event, deliver it through cove_bridge_reply using this exact eventId. If no reaction is useful, do not call the reply tool.",
      ]
    : [];

  return {
    id,
    correlationId: id,
    kind: "message",
    source,
    ...streamRouting,
    ...routing,
    createdAt,
    visibleText: text,
    modelContext: [
      "This message entered through Cove Bridge.",
      "Treat the visible text as the current foreground user message.",
      `eventId=${id}`,
      `correlationId=${id}`,
      `source=${source}`,
      `stream=${streamRouting.stream}`,
      ...(streamRouting.stateKey ? [`stateKey=${streamRouting.stateKey}`] : []),
      ...(streamRouting.stream === "state"
        ? ["STATE STREAM: this event is ephemeral/latest-state oriented. Do not assume older undelivered state events will be replayed."]
        : ["CONVERSATION STREAM: preserve ordering and complete any required reply before the next conversation turn is released."]),
      ...routeLines,
      ...(additionalModelContext ? [additionalModelContext] : []),
      `createdAt=${createdAt}`,
    ].join("\n"),
  };
}

function enqueueTogetherEvent(
  source: string,
  text: string,
  additionalModelContext?: string,
): boolean {
  // There is no event consumer in read-only mode; do not retain private chat.
  if (READ_ONLY) return false;
  const id = randomUUID();
  const created = queue.enqueue(buildBridgeEvent(
    id,
    source,
    text,
    new Date().toISOString(),
    additionalModelContext,
  ));
  if (created) listenerWakeHub.wake(source);
  return created;
}

const togetherWorker = createTogetherWorker(enqueueTogetherEvent, playbackState);

const eventInput = z.object({
  eventId: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(80).default("test"),
  text: z.string().trim().min(1).max(4000),
});

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function authorized(req: IncomingMessage): boolean {
  return bearerMatches(req, INGEST_TOKEN);
}

function bearerMatches(req: IncomingMessage, secret: string): boolean {
  if (!secret) return false;
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createHttpServer() {
  return createServer(async (req, res) => {
    if (!req.url || !req.method) {
      res.writeHead(400).end("Bad Request");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/now") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      writeJson(res, 200, publicNow(playbackState.getCurrentState()));
      return;
    }

    if (READ_ONLY && (url.pathname === "/events" || url.pathname === "/listener/events")) {
      writeJson(res, 404, { error: "not_found" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      writeJson(res, 200, {
        ok: true,
        service: "cove-bridge",
        version: "0.1.0",
        queue: queue.status(),
        listener: listenerWakeHub.status(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/listener/events") {
      const authorization = req.headers.authorization ?? "";
      const bearerToken = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      const token = bearerToken || url.searchParams.get("session")?.trim() || "";
      const session = token ? listenerWakeHub.consumeSession(token) : null;
      if (!session) {
        writeJson(res, 401, { error: "invalid_or_expired_listener_session" });
        return;
      }
      listenerWakeHub.subscribe(res, session.expiresAtMs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/events") {
      if (!authorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const parsed = eventInput.safeParse(await readJson(req));
        if (!parsed.success) {
          writeJson(res, 400, { error: parsed.error.flatten() });
          return;
        }
        const createdAt = new Date().toISOString();
        const id = parsed.data.eventId ?? randomUUID();
        const event = buildBridgeEvent(id, parsed.data.source, parsed.data.text, createdAt);
        const created = queue.enqueue(event);
        if (created) listenerWakeHub.wake(parsed.data.source);
        writeJson(res, created ? 201 : 200, { ok: true, created, eventId: id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        writeJson(res, message === "request_too_large" ? 413 : 400, { error: message });
      }
      return;
    }

    const mcpMethods = new Set(["POST", "GET", "DELETE"]);
    if (url.pathname === MCP_PATH && mcpMethods.has(req.method)) {
      if (!READ_ONLY && !bearerMatches(req, MCP_TOKEN)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.setHeader("Cache-Control", "no-store");
      const server = READ_ONLY
        ? createReadOnlyMcpServer(playbackState)
        : createMcpServer(queue, playbackState, togetherWorker);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("MCP request failed");
        if (!res.headersSent) writeJson(res, 500, { error: "internal_server_error" });
      }
      return;
    }

    res.writeHead(404).end("Not Found");
  });
}

if (process.env.NODE_ENV !== "test") {
  createHttpServer().listen(PORT, "0.0.0.0", () => {
    console.log(`Cove Bridge listening on http://0.0.0.0:${PORT}${MCP_PATH}`);
    togetherWorker.start();
  });

  if (UNIX_SOCKET) {
    if (existsSync(UNIX_SOCKET)) unlinkSync(UNIX_SOCKET);
    createHttpServer().listen(UNIX_SOCKET, () => {
      chmodSync(UNIX_SOCKET, 0o666);
      console.log(`Cove Bridge listening on unix://${UNIX_SOCKET}${MCP_PATH}`);
    });
  }
}
