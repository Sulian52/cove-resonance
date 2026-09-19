import assert from "node:assert/strict";
import test from "node:test";
import { TogetherWorker } from "../src/netease/togetherWorker.js";
import type { RealtimeChatRoomMessage } from "../src/netease/realtimeTransport.js";

test("read-only worker skips native realtime credentials and connection", async () => {
  const worker = new TogetherWorker({ cookie: "", enabled: true, realtimeEnabled: false, onEvent: () => {} });
  const internal = worker as unknown as {
    client: { getRealtimeCredentials: () => Promise<never> };
    ensureRealtime: (roomId: string, chatRoomId: string) => Promise<void>;
  };
  internal.client.getRealtimeCredentials = async () => { throw new Error("must not fetch credentials"); };
  await internal.ensureRealtime("room", "chatroom");
  assert.equal(worker.getRealtimeStatus().enabled, false);
  assert.equal(worker.getRealtimeStatus().credentialsReady, false);
  assert.equal(worker.getRealtimeStatus().lastError, null);
  assert.equal(worker.getStatus().enabled, true);
});

test("deduplicates repeated realtime ChatRoom messages by message id", () => {
  const events: Array<{ source: string; text: string }> = [];
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    onEvent: (source, text) => {
      events.push({ source, text });
    },
  });

  const message: RealtimeChatRoomMessage = {
    type: "chatroom_message",
    category: "text",
    msgType: 0,
    senderId: "12345",
    senderNick: "user",
    text: "hello once",
    messageId: "same-message-id",
    timetagMs: 123456789,
    receivedAtMs: 123456789,
  };

  const handle = (worker as unknown as {
    handleRealtimeChatMessage: (message: RealtimeChatRoomMessage) => void;
  }).handleRealtimeChatMessage.bind(worker);

  handle(message);
  handle({ ...message, receivedAtMs: message.receivedAtMs + 50 });

  assert.deepEqual(events, [{ source: "netease.chatroom", text: "hello once" }]);
});
