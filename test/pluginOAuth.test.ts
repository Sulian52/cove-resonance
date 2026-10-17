import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  OAUTH_SCOPE,
  PluginOAuthServer,
} from "../src/pluginOAuth.js";

const origin = "https://cove.example";
const resource = `${origin}/chatgpt/mcp`;
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const secret = "correct horse battery staple";

function register(oauth: PluginOAuthServer): string {
  return oauth.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
    token_endpoint_auth_method: "none",
  }).client_id;
}

test("OAuth metadata advertises PKCE, DCR, and the private MCP resource", () => {
  const oauth = new PluginOAuthServer(secret);
  assert.deepEqual(oauth.protectedResourceMetadata(origin, resource), {
    resource,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
  });
  const metadata = oauth.authorizationServerMetadata(origin);
  assert.equal(metadata.issuer, origin);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.registration_endpoint, `${origin}/oauth/register`);
});

test("OAuth authorization code flow uses the Railway secret and PKCE", () => {
  const oauth = new PluginOAuthServer(secret);
  const clientId = register(oauth);
  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: OAUTH_SCOPE,
    resource,
  });
  const start = oauth.beginAuthorization(params, resource);
  assert.equal(start.clientName, "ChatGPT");
  assert.throws(
    () => oauth.approveAuthorization(start.requestTicket, "wrong secret"),
    /口令不正确/,
  );

  const redirect = new URL(oauth.approveAuthorization(start.requestTicket, secret));
  assert.equal(redirect.origin + redirect.pathname, redirectUri);
  assert.equal(redirect.searchParams.get("state"), "state-1");
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  const token = oauth.exchangeToken(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }));
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.scope, OAUTH_SCOPE);
  assert.equal(oauth.verifyAccessToken(token.access_token, resource), true);
  assert.equal(oauth.verifyAccessToken(token.access_token, `${origin}/other`), false);
  assert.throws(
    () => oauth.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    })),
    /invalid or expired/,
  );
});

test("OAuth refresh rotates a valid access token without the user's secret", () => {
  const oauth = new PluginOAuthServer(secret);
  const clientId = register(oauth);
  const verifier = "b".repeat(64);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const start = oauth.beginAuthorization(new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }), resource);
  const redirect = new URL(oauth.approveAuthorization(start.requestTicket, secret));
  const first = oauth.exchangeToken(new URLSearchParams({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }));
  const refreshed = oauth.exchangeToken(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
    client_id: clientId,
  }));
  assert.equal(oauth.verifyAccessToken(refreshed.access_token, resource), true);
  assert.notEqual(refreshed.refresh_token, first.refresh_token);
});

test("OAuth rejects unregistered redirects and non-HTTPS client metadata", () => {
  const oauth = new PluginOAuthServer(secret);
  assert.throws(
    () => oauth.registerClient({ redirect_uris: ["http://evil.example/callback"] }),
    /HTTPS/,
  );
  const clientId = register(oauth);
  assert.throws(
    () => oauth.beginAuthorization(new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/callback",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      resource,
    }), resource),
    /not registered/,
  );
});

