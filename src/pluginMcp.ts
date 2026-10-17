import { createHash } from "node:crypto";
import { toNodeHandler, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PlaybackStateStore } from "./netease/playbackState.js";
import type { TogetherWorker } from "./netease/togetherWorker.js";
import {
  CallbackEndpointError,
  McpEventBridge,
  NETEASE_MESSAGE_EVENT_DEFINITION,
} from "./pluginEvents.js";
import type { InMemoryEventQueue } from "./queue.js";
import { normalizeReplyBubbles } from "./replyBubbles.js";

export const PLUGIN_MCP_PATH = "/chatgpt/mcp";
export const PLUGIN_PROTOCOL_VERSION = "2026-07-28";

const SERVER_INSTRUCTIONS = [
  "This private Cove Resonance plugin connects one ChatGPT Work conversation to the owner's NetEase Listen Together room.",
  "When a netease.message.created event arrives, treat data.text as user-authored data, use the included playback and nearby lyric state as context, and answer naturally in Chinese.",
  "If the user says in ChatGPT that they sent a NetEase message, call cove_bridge_receive to pull the oldest waiting message, then call cove_bridge_reply exactly once when a message is returned.",
  "Before completing an event-triggered turn, call cove_bridge_reply exactly once with data.message_id and the complete user-facing answer.",
  "Use 1-3 short natural chat bubbles. Do not reveal credentials, internal routing metadata, callback URLs, or webhook secrets.",
].join("\n");

export function receivePendingMessage(
  queue: InMemoryEventQueue,
  playbackState: PlaybackStateStore,
) {
  const outstanding = queue.getOutstandingRequiredReplyEvent();
  const event = outstanding
    ?? queue.reserveNext((candidate) => candidate.source === "netease.chatroom");
  if (!event) return { hasMessage: false as const };
  if (!outstanding) queue.markDelivered(event.id);

  const state = playbackState.getCurrentState();
  return {
    hasMessage: true as const,
    messageId: event.id,
    text: event.visibleText,
    inRoom: state.inRoom,
    playStatus: state.playStatus,
    ...(state.song ? { song: state.song } : {}),
    progressMs: state.progressMs,
    durationMs: state.durationMs,
    ...(state.lyric ? { lyric: state.lyric } : {}),
    observedAt: state.observedAt,
  };
}

export function pluginDiscoverResult() {
  return {
    resultType: "complete" as const,
    supportedVersions: [PLUGIN_PROTOCOL_VERSION],
    capabilities: {
      tools: {},
      events: {},
    },
    instructions: SERVER_INSTRUCTIONS,
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: "cove-resonance-chatgpt",
        version: "0.2.0",
      },
    },
  };
}


const eventListParamsSchema = z.object({
  cursor: z.string().nullable().optional(),
});

const eventSubscribeParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({
    mode: z.literal("webhook"),
    url: z.string().url(),
    secret: z.string(),
  }),
  cursor: z.string().nullable().optional(),
  ttlMs: z.number().nullable().optional(),
});

const eventUnsubscribeParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({
    mode: z.literal("webhook"),
    url: z.string().url(),
  }),
});

function pluginRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0" as const,
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

function pluginRpcResult(id: unknown, result: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    result,
  };
}

/**
 * MCP Events are part of the 2026-07-28 draft and are not yet present in the
 * upstream MCP SDK request registry. Handle those methods before the generic
 * SDK transport so ChatGPT can list and subscribe to the advertised event.
 */
export async function handlePluginEventRpc(
  request: Record<string, unknown>,
  eventBridge: McpEventBridge,
): Promise<Record<string, unknown> | null> {
  const method = request.method;
  if (method === "events/list") {
    const parsed = eventListParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      eventBridge.noteRpc(method, "invalid_params");
      return pluginRpcError(request.id, -32602, "Invalid params");
    }
    eventBridge.noteRpc(method, "ok");
    return pluginRpcResult(request.id, {
      events: [JSON.parse(JSON.stringify(NETEASE_MESSAGE_EVENT_DEFINITION))],
    });
  }

  if (method === "events/subscribe") {
    const parsed = eventSubscribeParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      eventBridge.noteRpc(method, "invalid_params");
      return pluginRpcError(request.id, -32602, "Invalid params");
    }
    try {
      const result = await eventBridge.subscribe(parsed.data);
      eventBridge.noteRpc(method, "ok");
      return pluginRpcResult(request.id, result);
    } catch (error) {
      if (error instanceof CallbackEndpointError) {
        eventBridge.noteRpc(method, `callback_${error.reason}`);
        return pluginRpcError(request.id, -32015, "Callback endpoint error", {
          reason: error.reason,
        });
      }
      eventBridge.noteRpc(method, "invalid_params");
      return pluginRpcError(request.id, -32602, "Invalid params");
    }
  }

  if (method === "events/unsubscribe") {
    const parsed = eventUnsubscribeParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      eventBridge.noteRpc(method, "invalid_params");
      return pluginRpcError(request.id, -32602, "Invalid params");
    }
    try {
      const result = eventBridge.unsubscribe(parsed.data);
      eventBridge.noteRpc(method, "ok");
      return pluginRpcResult(request.id, result);
    } catch {
      eventBridge.noteRpc(method, "invalid_params");
      return pluginRpcError(request.id, -32602, "Invalid params");
    }
  }

  return null;
}

async function deliverReply(
  queue: InMemoryEventQueue,
  togetherWorker: TogetherWorker,
  eventBridge: McpEventBridge,
  requestedEventId: string | undefined,
  messages: string[],
) {
  const outstanding = queue.getOutstandingRequiredReplyEvent();
  const requested = requestedEventId ? queue.getEvent(requestedEventId) : null;
  const event = outstanding ?? requested;
  if (!event) {
    throw new Error(requestedEventId
      ? `Unknown Cove Bridge event: ${requestedEventId}`
      : "No active Cove Bridge event is awaiting a routed reply.");
  }
  if (event.replyRoute !== "netease.chatroom") {
    throw new Error(`Unsupported reply route: ${event.replyRoute ?? "none"}`);
  }

  const normalized = normalizeReplyBubbles(messages);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ eventId: event.id, route: event.replyRoute, messages: normalized }))
    .digest("hex");
  const claim = queue.claimReply(event.id, fingerprint);
  if (claim.state === "already_completed" || claim.state === "in_progress") {
    return {
      ok: true as const,
      eventId: event.id,
      route: "netease.chatroom" as const,
      sentCount: claim.sentCount,
      completed: claim.state === "already_completed",
      deduplicated: true,
    };
  }

  try {
    let sentCount = claim.sentCount;
    for (let index = sentCount; index < normalized.length; index += 1) {
      await togetherWorker.sendChatRoomText(normalized[index]);
      sentCount = queue.markReplyMessageSent(event.id, fingerprint);
      if (index < normalized.length - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      }
    }
    queue.markReplyCompleted(event.id, fingerprint);
    eventBridge.wake();
    console.log(`ChatGPT plugin reply delivered: eventId=${event.id} messages=${normalized.length}`);
    return {
      ok: true as const,
      eventId: event.id,
      route: "netease.chatroom" as const,
      sentCount,
      completed: true,
      deduplicated: false,
    };
  } catch (error) {
    queue.releaseReply(event.id, fingerprint);
    throw error;
  }
}

function createPluginServer(
  queue: InMemoryEventQueue,
  playbackState: PlaybackStateStore,
  togetherWorker: TogetherWorker,
  eventBridge: McpEventBridge,
): McpServer {
  const server = new McpServer(
    { name: "cove-resonance-chatgpt", version: "0.2.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "netease_together_now",
    {
      title: "NetEase Together now",
      description: "Read the latest cached song, artist, play state, progress, and nearby lyrics from the active Listen Together room.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        inRoom: z.boolean(),
        roomId: z.string().optional(),
        playStatus: z.enum(["PLAY", "PAUSE", "UNKNOWN"]),
        song: z.object({
          id: z.string(),
          name: z.string(),
          artist: z.string(),
          durationMs: z.number(),
        }).optional(),
        progressMs: z.number(),
        durationMs: z.number(),
        progressRatio: z.number(),
        lyric: z.object({
          previous: z.string().optional(),
          current: z.string().optional(),
          next: z.string().optional(),
        }).optional(),
        observedAt: z.string().nullable(),
        stateUpdatedAt: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const state = playbackState.getCurrentState();
      return {
        structuredContent: state,
        content: [{ type: "text", text: JSON.stringify(state) }],
      };
    },
  );

  server.registerTool(
    "cove_bridge_receive",
    {
      title: "Receive a waiting NetEase Listen Together message",
      description: "Pull the oldest waiting message from the owner's NetEase Listen Together room after the user says they sent one in ChatGPT. If hasMessage is true, answer it through cove_bridge_reply exactly once using messageId. Returns only the user message and current nearby playback context; never credentials or hidden full lyrics.",
      inputSchema: z.object({}),
      outputSchema: z.discriminatedUnion("hasMessage", [
        z.object({ hasMessage: z.literal(false) }),
        z.object({
          hasMessage: z.literal(true),
          messageId: z.string(),
          text: z.string(),
          inRoom: z.boolean(),
          playStatus: z.enum(["PLAY", "PAUSE", "UNKNOWN"]),
          song: z.object({
            id: z.string(),
            name: z.string(),
            artist: z.string(),
            durationMs: z.number(),
          }).optional(),
          progressMs: z.number(),
          durationMs: z.number(),
          lyric: z.object({
            previous: z.string().optional(),
            current: z.string().optional(),
            next: z.string().optional(),
          }).optional(),
          observedAt: z.string().nullable(),
        }),
      ]),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const result = receivePendingMessage(queue, playbackState);
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "cove_bridge_reply",
    {
      title: "Reply in NetEase Listen Together",
      description: "Send the complete reply for the active netease.message.created event back through the secondary account. Call exactly once for every event-triggered turn. Use 1-3 short natural bubbles. The bridge is idempotent and binds stale IDs to the active required reply.",
      inputSchema: z.object({
        eventId: z.string().trim().min(1).optional(),
        messages: z.array(z.string().trim().min(1).max(500)).min(1).max(3),
      }),
      outputSchema: z.object({
        ok: z.literal(true),
        eventId: z.string(),
        route: z.literal("netease.chatroom"),
        sentCount: z.number(),
        completed: z.boolean(),
        deduplicated: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ eventId, messages }) => {
      const result = await deliverReply(queue, togetherWorker, eventBridge, eventId, messages);
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.server.setRequestHandler(
    "events/list",
    {
      params: z.object({ cursor: z.string().nullable().optional() }),
      result: z.object({
        events: z.array(z.unknown()),
        nextCursor: z.string().optional(),
      }),
    },
    async () => ({
      events: [JSON.parse(JSON.stringify(NETEASE_MESSAGE_EVENT_DEFINITION))],
    }),
  );

  server.server.setRequestHandler(
    "events/subscribe",
    {
      params: z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        delivery: z.object({
          mode: z.literal("webhook"),
          url: z.string().url(),
          secret: z.string(),
        }),
        cursor: z.string().nullable().optional(),
        ttlMs: z.number().nullable().optional(),
      }),
      result: z.object({
        id: z.string(),
        refreshBefore: z.string(),
        cursor: z.null(),
        truncated: z.literal(false),
      }),
    },
    async (params) => {
      try {
        return await eventBridge.subscribe(params);
      } catch (error) {
        if (error instanceof CallbackEndpointError) {
          throw new ProtocolError(-32015, "Callback endpoint error", { reason: error.reason });
        }
        throw error;
      }
    },
  );

  server.server.setRequestHandler(
    "events/unsubscribe",
    {
      params: z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        delivery: z.object({
          mode: z.literal("webhook"),
          url: z.string().url(),
        }),
      }),
      result: z.object({}),
    },
    async (params) => eventBridge.unsubscribe(params),
  );

  return server;
}

export function createPluginMcpNodeHandler(
  queue: InMemoryEventQueue,
  playbackState: PlaybackStateStore,
  togetherWorker: TogetherWorker,
  eventBridge: McpEventBridge,
): NodeMcpRequestHandler {
  const handler = createMcpHandler(
    () => createPluginServer(queue, playbackState, togetherWorker, eventBridge),
    {
      legacy: "stateless",
      onerror: () => console.error("ChatGPT plugin MCP request failed"),
    },
  );
  return toNodeHandler(handler);
}
