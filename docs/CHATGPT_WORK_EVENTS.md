# ChatGPT Work MCP Events

This adapter keeps the model in an official ChatGPT Work conversation. It does
not call the OpenAI API and does not need an `OPENAI_API_KEY`.

The private endpoint is:

```text
https://<bridge-origin>/chatgpt/mcp
```

It implements MCP 2.0 (`2026-07-28`) plus the ChatGPT MCP Events methods:

- `events/list`
- `events/subscribe`
- `events/unsubscribe`
- Standard Webhooks callback verification and signed event delivery

The endpoint exposes only two tools:

- `netease_together_now` — read cached song, progress and nearby lyrics
- `cove_bridge_reply` — send the active event's idempotent reply back to the
  NetEase Listen Together ChatRoom

It does not expose playlist mutation or account-management tools.

## Railway variables

Keep the public `/now` deployment in read-only mode and enable the isolated
private plugin endpoint separately:

```dotenv
BRIDGE_READ_ONLY=true
BRIDGE_PLUGIN_TOKEN=<a long random secret entered only in Railway and the Cove authorization page>
# Optional: NETEASE_INVITER_UID=<the main account numeric user ID>
NETEASE_CHAT_TRIGGER_PREFIXES=小助手,@小助手
BRIDGE_EVENT_STATE_PATH=/data/cove-event-subscriptions.json
```

`BRIDGE_PLUGIN_TOKEN` protects the single-user OAuth authorization page and
signs short-lived access tokens plus renewable refresh tokens. ChatGPT receives
an OAuth token, not this secret. Never put its value in a plugin archive,
GitHub, logs, or chat messages.

When plugin mode is enabled, realtime room chat is denied unless the sender ID
matches the inviter of the room that the secondary account just accepted. You
may additionally pin `NETEASE_INVITER_UID`, but it is not required. Messages
must start with one of the configured trigger prefixes. The defaults are
`小助手` and `@小助手`.

The Docker image uses Debian/glibc because the native `node-nim` runtime does
not support Alpine/musl. Mount a Railway volume at `/data` so event subscription
state and its signing secret survive redeploys.

## Private plugin connection

Create a private ChatGPT plugin whose `mcp.json` points to the endpoint above,
uses Streamable HTTP, and declares OAuth authentication with dynamic client
registration and the `cove:listen` scope. During the first connection, the
bridge opens its own authorization page. Enter `BRIDGE_PLUGIN_TOKEN` there;
the value is submitted directly to the Railway service and is not stored in
the plugin package.

The bridge publishes OAuth protected-resource and authorization-server
metadata, uses Authorization Code + PKCE, supports dynamic client
registration, and rotates short-lived access tokens with signed refresh
tokens. Unauthorized MCP responses include `WWW-Authenticate` discovery
metadata so ChatGPT can start or repair the connection.

After installing the plugin, start a Work chat and ask ChatGPT to monitor the
`netease.message.created` event. Tell it to answer naturally and call
`cove_bridge_reply` exactly once for every event-triggered turn.

MCP event payloads contain only the user message plus the current public
playback context. NetEase Cookie, `MUSIC_U`, NIM credentials, MCP token,
callback URL and webhook signing secret are never placed in the event payload
or tool output.
