# Read-only deployment

This variant defaults to `BRIDGE_READ_ONLY=true`.

- `GET /now` returns only song name, artist, play status, estimated progress,
  duration, nearby lyrics and freshness information. It contains no account,
  room or chat identifiers and no provider credentials.
- `/mcp` exposes only `netease_together_now` with a read-only annotation.
- `/events` and `/listener/events` are unavailable in read-only mode.
- Private chat events are not retained in the bridge queue in this mode.
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

Local verification: 53 tests pass; TypeScript build passes; whitespace check
passes. Tests cover the public field allowlist, stale data, HTTP methods,
disabled event endpoints, MCP discovery and rejection of private tools.

Not yet deployed or verified against a live NetEase invitation. Railway
authentication and access to the actual deployment source repository are
still needed. After deployment, verify `/now`, send an invitation from the
main account to the secondary account, then verify song changes, pause/resume,
progress and nearby lyrics. A reachable health endpoint alone is not proof
that the NetEase session is valid.
