import assert from "node:assert/strict";
import test from "node:test";
import { TogetherWorker } from "../src/netease/togetherWorker.js";
import type { RealtimeChatRoomMessage } from "../src/netease/realtimeTransport.js";

test("worker startup logs do not expose the NetEase account id", async () => {
  const worker = new TogetherWorker({ cookie: "", enabled: true, onEvent: () => {} });
  const internal = worker as unknown as {
    running: boolean;
    client: { getAccountProfile: () => Promise<{
      id: string;
      nickname: null;
      avatarUrl: null;
      gender: null;
    }> };
    run: () => Promise<void>;
  };
  const privateAccountId = "private-account-id";
  internal.running = true;
  internal.client.getAccountProfile = async () => {
    internal.running = false;
    return { id: privateAccountId, nickname: null, avatarUrl: null, gender: null };
  };
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  try {
    await internal.run();
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.some((line) => line.includes(privateAccountId)), false);
  assert.equal(logs.includes("NetEase Together worker ready"), true);
});

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

test("private plugin chat accepts only the inviter and configured trigger", () => {
  const events: string[] = [];
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    inviterUid: "owner-1",
    restrictChatToInviter: true,
    chatTriggerPrefixes: ["小助手", "@小助手"],
    onEvent: (_source, text) => events.push(text),
  });
  const handle = (worker as unknown as {
    handleRealtimeChatMessage: (message: RealtimeChatRoomMessage) => void;
  }).handleRealtimeChatMessage.bind(worker);
  const base: RealtimeChatRoomMessage = {
    type: "chatroom_message",
    category: "text",
    msgType: 0,
    senderId: "owner-1",
    senderNick: "owner",
    text: "not addressed",
    messageId: "message-1",
    timetagMs: 1,
    receivedAtMs: 1,
  };

  handle(base);
  handle({ ...base, senderId: "stranger", text: "小助手，hello", messageId: "message-2" });
  handle({ ...base, text: "  小助手，这句像不像凛苍？", messageId: "message-3" });

  assert.deepEqual(events, ["  小助手，这句像不像凛苍？"]);
});

test("private plugin chat can learn the allowed sender from the accepted invite", () => {
  const events: string[] = [];
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    restrictChatToInviter: true,
    chatTriggerPrefixes: ["小助手"],
    onEvent: (_source, text) => events.push(text),
  });
  const internal = worker as unknown as {
    activeInviterId: string | null;
    handleRealtimeChatMessage: (message: RealtimeChatRoomMessage) => void;
  };
  internal.activeInviterId = "learned-owner";
  internal.handleRealtimeChatMessage({
    type: "chatroom_message",
    category: "text",
    msgType: 0,
    senderId: "learned-owner",
    senderNick: "owner",
    text: "小助手，听见了吗？",
    messageId: "learned-message",
    timetagMs: 1,
    receivedAtMs: 1,
  });

  assert.deepEqual(events, ["小助手，听见了吗？"]);
});

test("private plugin chat recovers the inviter after restarting inside an active room", async () => {
  const events: string[] = [];
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    restrictChatToInviter: true,
    chatTriggerPrefixes: ["小助手"],
    onEvent: (_source, text) => events.push(text),
  });
  const messageTime = Date.now() - 30 * 60_000;
  const internal = worker as unknown as {
    status: { accountId: string | null };
    client: {
      getRecentContacts: () => Promise<Record<string, unknown>>;
      getPrivateHistory: (uid: string) => Promise<Record<string, unknown>>;
    };
    recoverActiveInviter: (roomId: string) => Promise<void>;
    handleRealtimeChatMessage: (message: RealtimeChatRoomMessage) => void;
  };
  internal.status.accountId = "secondary-account";
  internal.client.getRecentContacts = async () => ({ data: [{ userId: "owner-account" }] });
  internal.client.getPrivateHistory = async () => ({
    msgs: [{
      type: 23,
      time: messageTime,
      msg: JSON.stringify({
        nativeUrl: "orpheus://listenTogether?roomId=active-room&inviterId=owner-account",
      }),
    }],
  });

  await internal.recoverActiveInviter("active-room");
  internal.handleRealtimeChatMessage({
    type: "chatroom_message",
    category: "text",
    msgType: 0,
    senderId: "owner-account",
    senderNick: "owner",
    text: "小助手，重启以后听得到吗？",
    messageId: "recovered-message",
    timetagMs: messageTime,
    receivedAtMs: messageTime,
  });

  assert.deepEqual(events, ["小助手，重启以后听得到吗？"]);
});
