import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlaybackStateStore } from "../src/netease/playbackState.js";
import {
  McpEventBridge,
  NETEASE_MESSAGE_EVENT,
  validateWebhookSecret,
  type WebhookPoster,
} from "../src/pluginEvents.js";
import {
  handlePluginEventRpc,
  pluginDiscoverResult,
  receivePendingMessage,
} from "../src/pluginMcp.js";
import { InMemoryEventQueue } from "../src/queue.js";

const webhookSecret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test("ChatGPT plugin discovery advertises MCP 2.0 events and tools", () => {
  const result = pluginDiscoverResult();
  assert.deepEqual(result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(result.capabilities, { tools: {}, events: {} });
  assert.equal(result.resultType, "complete");
});

test("validates Standard Webhooks signing secrets without exposing them", () => {
  assert.doesNotThrow(() => validateWebhookSecret(webhookSecret));
  assert.throws(() => validateWebhookSecret("not-a-secret"), /invalid_secret/);
});

test("handles draft MCP event methods before the upstream SDK registry", async () => {
  const queue = new InMemoryEventQueue();
  const playback = new PlaybackStateStore();
  const poster: WebhookPoster = async (_url, body) => {
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    return parsed.type === "verification"
      ? { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) }
      : { status: 202, body: "" };
  };
  const storagePath = join(mkdtempSync(join(tmpdir(), "cove-events-rpc-")), "subscriptions.json");
  const bridge = new McpEventBridge(queue, playback, storagePath, poster);

  const listed = await handlePluginEventRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "events/list",
    params: {},
  }, bridge);
  assert.equal((listed as { result: { events: Array<{ name: string }> } }).result.events[0].name, NETEASE_MESSAGE_EVENT);

  const subscribed = await handlePluginEventRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "events/subscribe",
    params: {
      name: NETEASE_MESSAGE_EVENT,
      arguments: {},
      delivery: {
        mode: "webhook",
        url: "https://callbacks.openai.com/cove-rpc-test",
        secret: webhookSecret,
      },
    },
  }, bridge);
  assert.match((subscribed as { result: { id: string } }).result.id, /^sub_[a-f0-9]{32}$/);
  assert.equal(bridge.status().subscriptions, 1);

  const invalidSecret = "do-not-echo-this-secret";
  const rejected = await handlePluginEventRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "events/subscribe",
    params: {
      name: NETEASE_MESSAGE_EVENT,
      delivery: {
        mode: "webhook",
        url: "https://callbacks.openai.com/cove-rpc-test",
        secret: invalidSecret,
      },
    },
  }, bridge);
  assert.equal((rejected as { error: { code: number } }).error.code, -32015);
  assert.equal(JSON.stringify(rejected).includes(invalidSecret), false);
});

test("manually receives a waiting NetEase message when webhook events are unavailable", () => {
  const queue = new InMemoryEventQueue();
  const playback = new PlaybackStateStore();
  playback.enterRoom("private-room");
  playback.updateSong({ id: "song-2", name: "Quiet Room", artist: "artist", durationMs: 180_000 });
  playback.updatePlayback({
    songId: "song-2",
    playStatus: "PAUSE",
    progressMs: 12_000,
    observedAtMs: Date.now(),
  });
  queue.enqueue({
    id: "manual-event-1",
    correlationId: "manual-event-1",
    kind: "message",
    source: "netease.chatroom",
    stream: "conversation",
    replyRoute: "netease.chatroom",
    replyPolicy: "required",
    createdAt: new Date().toISOString(),
    visibleText: "小助手，你听得到吗？",
    modelContext: "hidden context",
  });

  const received = receivePendingMessage(queue, playback);

  assert.equal(received.hasMessage, true);
  if (!received.hasMessage) return;
  assert.equal(received.messageId, "manual-event-1");
  assert.equal(received.text, "小助手，你听得到吗？");
  assert.equal(received.playStatus, "PAUSE");
  assert.equal("roomId" in received, false);
  assert.equal("modelContext" in received, false);
  assert.equal(queue.status().delivered, 1);
  assert.equal(receivePendingMessage(queue, playback).hasMessage, true);
});

test("verifies, persists, and delivers a NetEase message event with playback context", async () => {
  const queue = new InMemoryEventQueue();
  const playback = new PlaybackStateStore();
  playback.enterRoom("room-1");
  playback.updateSong({ id: "song-1", name: "Quiet Room", artist: "artist", durationMs: 180_000 });
  playback.updateLyrics("song-1", {
    lrc: "[00:00.00]line one\n[00:10.00]line two",
    tlyric: null,
    romalrc: null,
    klyric: null,
    yrc: null,
    ytlrc: null,
    yromalrc: null,
    raw: {},
  });
  playback.updatePlayback({
    songId: "song-1",
    playStatus: "PAUSE",
    progressMs: 11_000,
    observedAtMs: Date.now(),
  });

  const posts: Array<{ body: unknown; headers: Record<string, string> }> = [];
  const poster: WebhookPoster = async (_url, body, headers) => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    posts.push({ body: parsed, headers });
    if (parsed.type === "verification") {
      return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    }
    return { status: 202, body: "" };
  };
  const storagePath = join(mkdtempSync(join(tmpdir(), "cove-events-")), "subscriptions.json");
  const bridge = new McpEventBridge(queue, playback, storagePath, poster);
  const subscription = await bridge.subscribe({
    name: NETEASE_MESSAGE_EVENT,
    arguments: {},
    delivery: {
      mode: "webhook",
      url: "https://callbacks.openai.com/cove-test",
      secret: webhookSecret,
    },
  });
  assert.match(subscription.id, /^sub_[a-f0-9]{32}$/);
  assert.equal(bridge.status().subscriptions, 1);

  queue.enqueue({
    id: "event-1",
    correlationId: "event-1",
    kind: "message",
    source: "netease.chatroom",
    stream: "conversation",
    replyRoute: "netease.chatroom",
    replyPolicy: "required",
    createdAt: new Date(0).toISOString(),
    visibleText: "小助手，这句像不像凛苍？",
    modelContext: "private full lyrics are not copied into the event payload",
  });
  bridge.wake();
  await waitFor(() => queue.status().delivered === 1);

  assert.equal(posts.length, 2);
  const delivered = posts[1].body as {
    eventId: string;
    name: string;
    data: Record<string, unknown>;
  };
  assert.equal(delivered.eventId, "event-1");
  assert.equal(delivered.name, NETEASE_MESSAGE_EVENT);
  assert.equal(delivered.data.text, "小助手，这句像不像凛苍？");
  assert.equal(delivered.data.play_status, "PAUSE");
  assert.deepEqual(delivered.data.lyric, { previous: "line one", current: "line two" });
  assert.equal(JSON.stringify(delivered).includes(webhookSecret), false);
  assert.equal(posts[1].headers["X-MCP-Subscription-Id"], subscription.id);
  assert.match(posts[1].headers["webhook-signature"], /^v1,/);
  assert.equal(queue.getOutstandingRequiredReplyEvent()?.id, "event-1");

  const restored = new McpEventBridge(queue, playback, storagePath, poster);
  assert.equal(restored.status().subscriptions, 1);
});
