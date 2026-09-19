import assert from "node:assert/strict";
import test from "node:test";
import { publicNow } from "../src/now.js";
import { PlaybackStateStore } from "../src/netease/playbackState.js";

test("public output excludes room identity, song identity and unexpected nested fields", () => {
  const store = new PlaybackStateStore();
  store.enterRoom("private-room");
  store.updateSong({ id: "123", name: "Example", artist: "Artist", durationMs: 60_000 });
  const state = store.getCurrentState();
  const extra = { ...state, cookie: "test-secret", song: { ...state.song!, token: "test-secret" },
    lyric: { current: "Example line", token: "test-secret" } };
  const result = publicNow(extra);
  assert.deepEqual(result.song, { name: "Example", artist: "Artist" });
  assert.deepEqual(result.lyric, { previous: null, current: "Example line", next: null });
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
  assert.equal(JSON.stringify(result).includes("private-room"), false);
  assert.equal("id" in result.song!, false);
});

test("stale snapshots do not pretend progress or nearby lyrics are current", () => {
  const store = new PlaybackStateStore();
  store.enterRoom("room");
  store.updateSong({ id: "123", name: "Example", artist: "Artist", durationMs: 60_000 });
  store.updatePlayback({ songId: "123", playStatus: "PLAY", progressMs: 5000, observedAtMs: Date.now() });
  const state = store.getCurrentState();
  const result = publicNow(state, Date.parse(state.stateUpdatedAt) + 20_001);
  assert.equal(result.stale, true);
  assert.equal(result.playStatus, "UNKNOWN");
  assert.equal(result.progressMs, null);
  assert.equal(result.lyric, null);
});

test("public HTTP surface is read-only and MCP cannot call private tools", async () => {
  process.env.NODE_ENV = "test";
  process.env.NETEASE_COOKIE = "";
  process.env.BRIDGE_READ_ONLY = "true";
  const { createHttpServer } = await import("../src/server.js");
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/now`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    const state = await response.json() as Record<string, unknown>;
    assert.equal(state.inRoom, false);
    assert.equal(state.song, null);
    assert.equal((await fetch(`${base}/now`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/events`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/listener/events`)).status, 404);
    const rpc = async (method: string, params = {}) => {
      const result = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return await result.json() as any;
    };
    const list = await rpc("tools/list");
    assert.deepEqual(list.result.tools.map((tool: any) => tool.name), ["netease_together_now"]);
    assert.equal(list.result.tools[0].annotations.readOnlyHint, true);
    const privateCall = await rpc("tools/call", { name: "netease_like_song", arguments: { songId: "123" } });
    assert.ok(privateCall.error || privateCall.result?.isError);
    const now = await rpc("tools/call", { name: "netease_together_now", arguments: {} });
    assert.equal(now.result.structuredContent.inRoom, false);
    assert.equal("roomId" in now.result.structuredContent, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
