import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CurrentPlaybackState, PlaybackStateStore } from "./netease/playbackState.js";

// Public data must be built field by field. Never spread worker/provider objects.
export function publicNow(state: CurrentPlaybackState, now = Date.now()) {
  const stale = state.inRoom && now - Date.parse(state.stateUpdatedAt) > 20_000;
  return {
    inRoom: state.inRoom,
    song: state.song ? { name: state.song.name, artist: state.song.artist } : null,
    playStatus: stale ? "UNKNOWN" : state.playStatus,
    progressMs: stale ? null : Math.round(state.progressMs),
    durationMs: state.durationMs,
    lyric: !stale && state.lyric ? {
      previous: state.lyric.previous ?? null,
      current: state.lyric.current ?? null,
      next: state.lyric.next ?? null,
    } : null,
    stale,
    updatedAt: state.stateUpdatedAt,
  };
}

export function createReadOnlyMcpServer(playback: PlaybackStateStore): McpServer {
  const server = new McpServer({ name: "cove-now-readonly", version: "0.1.0" });
  server.registerTool("netease_together_now", {
    title: "Current song and nearby lyrics",
    description: "Read the current NetEase Listen Together song, artist, playback status, estimated progress and nearby lyrics. If stale is true, current progress is unknown. This tool cannot send messages or change the account.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const state = publicNow(playback.getCurrentState());
    return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) }] };
  });
  return server;
}
