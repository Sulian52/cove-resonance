import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRealtimePlaybackEvent,
  NeteaseRealtimeTransport,
  waitForNimLogin,
} from "../src/netease/realtimeTransport.js";

test("waits through a retryable NIM connection error until login succeeds", async () => {
  await waitForNimLogin(async (callback) => {
    callback({ res_code_: 415, login_step_: 1, retrying_: true });
    await Promise.resolve();
    callback({ res_code_: 200, login_step_: 3, retrying_: false });
  }, 100);
});

test("rejects a terminal NIM login failure", async () => {
  await assert.rejects(
    waitForNimLogin(async (callback) => {
      callback({ res_code_: 302, login_step_: 3, retrying_: false });
    }, 100),
    /code=302 step=3 retrying=false/,
  );
});

test("decodes event_type=20000 config string playback event", () => {
  const event = decodeRealtimePlaybackEvent({
    event_type: 20_000,
    config: JSON.stringify({
      serverSeq: 9,
      commandType: "PAUSE",
      formerSongId: 123,
      targetSongId: 456,
      progress: 2500,
      playStatus: "PAUSE",
    }),
  }, 123456);

  assert.deepEqual(event, {
    type: "playback",
    serverSeq: 9,
    commandType: "PAUSE",
    songId: "456",
    formerSongId: "123",
    progressMs: 2500,
    playStatus: "PAUSE",
    receivedAtMs: 123456,
  });
});

test("decodes nested content type=20000 playback event", () => {
  const event = decodeRealtimePlaybackEvent({
    msg_attach_: JSON.stringify({
      content: {
        type: 20_000,
        content: {
          serverSeq: 17,
          commandType: "GOTO",
          formerSongId: "11",
          targetSongId: "22",
          progress: 9001,
          playStatus: "PLAY",
        },
      },
    }),
  }, 500);

  assert.equal(event?.commandType, "GOTO");
  assert.equal(event?.serverSeq, 17);
  assert.equal(event?.songId, "22");
  assert.equal(event?.progressMs, 9001);
  assert.equal(event?.playStatus, "PLAY");
});

test("decodes PROGRESS event and clamps negative progress", () => {
  const event = decodeRealtimePlaybackEvent({
    type: 20_000,
    data: {
      commandType: "PROGRESS",
      targetSongId: 88,
      progress: -100,
      playStatus: "PLAY",
    },
  }, 42);

  assert.equal(event?.commandType, "PROGRESS");
  assert.equal(event?.progressMs, 0);
  assert.equal(event?.receivedAtMs, 42);
});

test("ignores malformed and unrelated events", () => {
  assert.equal(decodeRealtimePlaybackEvent("not-json"), null);
  assert.equal(decodeRealtimePlaybackEvent({ event_type: 19999, config: "{}" }), null);
  assert.equal(decodeRealtimePlaybackEvent({ event_type: 20_000, config: "{}" }), null);
});

test("realtime status never contains credentials", () => {
  const transport = new NeteaseRealtimeTransport(false);
  const status = transport.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.connected, false);
  assert.equal("token" in status, false);
  assert.equal("cookie" in status, false);
  assert.equal("addresses" in status, false);
});
