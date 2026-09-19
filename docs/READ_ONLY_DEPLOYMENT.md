# Read-only deployment

This variant defaults to `BRIDGE_READ_ONLY=true`.

- `GET /now` returns only song name, artist, play status, estimated progress,
  duration, nearby lyrics and freshness information. It contains no account,
  room or chat identifiers and no provider credentials.
- `/mcp` exposes only `netease_together_now` with a read-only annotation.
- `/events` and `/listener/events` are unavailable in read-only mode.
- Private chat events are not retained in the bridge queue in this mode.
- The native NIM chat transport is disabled in read-only mode. Invitations,
  room presence, playback and lyrics continue through the HTTP worker, normally
  polling every four seconds. Progress between observations is estimated.
- Data is public to anyone who knows the URL. `no-store` and `noindex` headers
  discourage caching and indexing; they are not access controls.
- If playback has not been refreshed for 20 seconds, `stale=true`, status is
  `UNKNOWN`, and progress and nearby lyrics are null.

Keep `NETEASE_COOKIE` only in Railway Variables. Set `NETEASE_INVITER_UID` to
the main account's numeric user ID to restrict invitation polling to that
account. The existing Together worker handles login and invitations; `/now`
only reads its cached state and never initiates an account operation.

The full original bridge is available only with `BRIDGE_READ_ONLY=false` and
a nonempty `BRIDGE_MCP_TOKEN`. Every request to full `/mcp` then requires that
Bearer credential. `/events` likewise requires a nonempty
`BRIDGE_INGEST_TOKEN`. No credentials means access is denied, not anonymous.

## Validation and remaining deployment steps

Local verification: 54 tests pass; TypeScript build passes; whitespace check
passes. Tests cover the public field allowlist, stale data, HTTP methods,
disabled event endpoints, MCP discovery and rejection of private tools.

Live acceptance on 2026-09-19: the secondary account authenticated and
automatically joined the main account's invitation. `/now` returned HTTP 200,
the actual song and nearby lyrics; successive samples showed advancing
progress. MCP discovery returned only `netease_together_now`; POST `/now`
returned 405 and event endpoints returned 404. The native NIM chat runtime
could not load in the Alpine container, so read-only mode explicitly skips
that unused transport. HTTP polling remains the playback source.

This endpoint supports on-demand reading, not unsolicited ChatGPT messages.
ChatGPT web can use the read-only `/mcp` endpoint through developer mode where
available. Use No Authentication: provider credentials remain on Railway and
the only public tool returns the same limited data as `/now`.
