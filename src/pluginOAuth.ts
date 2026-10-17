import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const OAUTH_SCOPE = "cove:listen";
export const OAUTH_PATHS = {
  authorization: "/oauth/authorize",
  registration: "/oauth/register",
  token: "/oauth/token",
  metadata: "/.well-known/oauth-authorization-server",
  protectedResource: "/.well-known/oauth-protected-resource",
} as const;

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 365;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TICKET_TTL_SECONDS = 10 * 60;

type SignedPayload = {
  v: 1;
  typ: "access" | "refresh" | "client" | "request";
  iat: number;
  exp: number;
  jti: string;
  [key: string]: unknown;
};

type ClientPayload = SignedPayload & {
  typ: "client";
  redirectUris: string[];
  clientName: string;
};

type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  resource: string;
};

type AuthorizationCode = AuthorizationRequest & {
  expiresAtMs: number;
};

export type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export class OAuthRequestError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function normalizeScope(scope: string | undefined): string {
  if (!scope?.trim()) return OAUTH_SCOPE;
  const requested = new Set(scope.trim().split(/\s+/));
  if (requested.size !== 1 || !requested.has(OAUTH_SCOPE)) {
    throw new OAuthRequestError("invalid_scope", "Only cove:listen is supported.");
  }
  return OAUTH_SCOPE;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseHttpsUrl(value: string, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuthRequestError("invalid_request", `${field} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new OAuthRequestError("invalid_request", `${field} must use HTTPS.`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new OAuthRequestError("invalid_request", `${field} contains unsupported URL parts.`);
  }
  return parsed;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export class PluginOAuthServer {
  private readonly secret: Buffer;
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();

  constructor(secret: string) {
    if (!secret) throw new Error("plugin_oauth_secret_required");
    this.secret = Buffer.from(secret, "utf8");
  }

  protectedResourceMetadata(origin: string, resource: string) {
    return {
      resource,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: [OAUTH_SCOPE],
    };
  }

  authorizationServerMetadata(origin: string) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}${OAUTH_PATHS.authorization}`,
      token_endpoint: `${origin}${OAUTH_PATHS.token}`,
      registration_endpoint: `${origin}${OAUTH_PATHS.registration}`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [OAUTH_SCOPE],
    };
  }

  registerClient(input: unknown) {
    const body = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.map(safeString)
      : [];
    if (redirectUris.length === 0 || redirectUris.length > 8 || redirectUris.some((uri) => !uri)) {
      throw new OAuthRequestError("invalid_client_metadata", "One to eight redirect_uris are required.");
    }
    for (const uri of redirectUris) parseHttpsUrl(uri, "redirect_uri");

    const tokenMethod = safeString(body.token_endpoint_auth_method) || "none";
    if (tokenMethod !== "none") {
      throw new OAuthRequestError("invalid_client_metadata", "Only public PKCE clients are supported.");
    }
    const clientName = safeString(body.client_name).trim().slice(0, 120) || "ChatGPT";
    const clientId = this.sign({
      ...this.basePayload("client", CLIENT_TTL_SECONDS),
      redirectUris,
      clientName,
    });

    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  beginAuthorization(searchParams: URLSearchParams, expectedResource: string): {
    requestTicket: string;
    clientName: string;
  } {
    if (searchParams.get("response_type") !== "code") {
      throw new OAuthRequestError("unsupported_response_type", "Only response_type=code is supported.");
    }
    const clientId = searchParams.get("client_id") ?? "";
    const client = this.verifySigned<ClientPayload>(clientId, "client");
    const redirectUri = searchParams.get("redirect_uri") ?? "";
    if (!client.redirectUris.includes(redirectUri)) {
      throw new OAuthRequestError("invalid_request", "redirect_uri is not registered for this client.");
    }
    const codeChallenge = searchParams.get("code_challenge") ?? "";
    if (searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
      throw new OAuthRequestError("invalid_request", "PKCE S256 is required.");
    }
    const resource = searchParams.get("resource") || expectedResource;
    if (resource !== expectedResource) {
      throw new OAuthRequestError("invalid_target", "The requested resource is not supported.");
    }
    const scope = normalizeScope(searchParams.get("scope") ?? undefined);
    const request: AuthorizationRequest = {
      clientId,
      redirectUri,
      state: searchParams.get("state") ?? "",
      codeChallenge,
      scope,
      resource,
    };
    const requestTicket = this.sign({
      ...this.basePayload("request", REQUEST_TICKET_TTL_SECONDS),
      request,
    });
    return { requestTicket, clientName: client.clientName };
  }

  authorizationPage(requestTicket: string, clientName: string, error = ""): string {
    const message = error
      ? `<p class="error">${escapeHtml(error)}</p>`
      : "";
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接凛苍一起听小助手</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f6f3ff;color:#211b2d;margin:0;padding:24px}.card{max-width:460px;margin:8vh auto;background:#fff;border:1px solid #ded6ee;border-radius:20px;padding:26px;box-shadow:0 14px 42px #36245a18}h1{font-size:22px;margin:0 0 10px}p{line-height:1.55;color:#625873}.hint{font-size:13px}.error{color:#b42318;background:#fff1f0;padding:10px 12px;border-radius:10px}label{display:block;font-weight:650;margin:20px 0 8px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #b9adca;border-radius:11px;font:inherit}button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:11px;background:#6f4bd8;color:#fff;font:inherit;font-weight:700;cursor:pointer}</style></head>
<body><main class="card"><h1>连接凛苍一起听小助手</h1><p><strong>${escapeHtml(clientName)}</strong> 想连接你的私人 Cove Resonance 服务。</p><p class="hint">请输入你刚才在 Railway 里设置的 <code>BRIDGE_PLUGIN_TOKEN</code>。口令只会直接发送给你的 Railway 服务，不会写进插件。</p>${message}<form method="post" action="${OAUTH_PATHS.authorization}"><input type="hidden" name="request" value="${escapeHtml(requestTicket)}"><label for="secret">连接口令</label><input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus><button type="submit">授权并连接</button></form></main></body></html>`;
  }

  authorizationPageCsp(requestTicket: string): string {
    const payload = this.verifySigned<SignedPayload & { request: AuthorizationRequest }>(
      requestTicket,
      "request",
    );
    const redirectOrigin = parseHttpsUrl(payload.request.redirectUri, "redirect_uri").origin;
    return [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `form-action 'self' ${redirectOrigin}`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  }

  approveAuthorization(requestTicket: string, suppliedSecret: string): string {
    const payload = this.verifySigned<SignedPayload & { request: AuthorizationRequest }>(requestTicket, "request");
    const actual = Buffer.from(suppliedSecret, "utf8");
    if (actual.length !== this.secret.length || !timingSafeEqual(actual, this.secret)) {
      throw new OAuthRequestError("access_denied", "口令不正确，请再试一次。", 401);
    }
    const code = randomBytes(32).toString("base64url");
    this.pruneAuthorizationCodes();
    this.authorizationCodes.set(code, {
      ...payload.request,
      expiresAtMs: Date.now() + AUTHORIZATION_CODE_TTL_MS,
    });
    const redirect = new URL(payload.request.redirectUri);
    redirect.searchParams.set("code", code);
    if (payload.request.state) redirect.searchParams.set("state", payload.request.state);
    return redirect.toString();
  }

  exchangeToken(input: URLSearchParams): OAuthTokenResponse {
    const grantType = input.get("grant_type") ?? "";
    if (grantType === "authorization_code") return this.exchangeAuthorizationCode(input);
    if (grantType === "refresh_token") return this.exchangeRefreshToken(input);
    throw new OAuthRequestError("unsupported_grant_type", "Unsupported grant_type.");
  }

  verifyAccessToken(token: string, expectedResource: string): boolean {
    try {
      const payload = this.verifySigned<SignedPayload & {
        aud: string;
        scope: string;
      }>(token, "access");
      return payload.aud === expectedResource && payload.scope === OAUTH_SCOPE;
    } catch {
      return false;
    }
  }

  private exchangeAuthorizationCode(input: URLSearchParams): OAuthTokenResponse {
    const code = input.get("code") ?? "";
    const authorization = this.authorizationCodes.get(code);
    this.authorizationCodes.delete(code);
    if (!authorization || authorization.expiresAtMs < Date.now()) {
      throw new OAuthRequestError("invalid_grant", "Authorization code is invalid or expired.");
    }
    const clientId = input.get("client_id") ?? "";
    if (clientId !== authorization.clientId) {
      throw new OAuthRequestError("invalid_grant", "Authorization code was issued to another client.");
    }
    const redirectUri = input.get("redirect_uri") ?? "";
    if (redirectUri !== authorization.redirectUri) {
      throw new OAuthRequestError("invalid_grant", "redirect_uri does not match.");
    }
    const verifier = input.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      throw new OAuthRequestError("invalid_grant", "code_verifier is invalid.");
    }
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (!this.constantTimeStringEqual(challenge, authorization.codeChallenge)) {
      throw new OAuthRequestError("invalid_grant", "PKCE verification failed.");
    }
    return this.issueTokenPair(clientId, authorization.resource, authorization.scope);
  }

  private exchangeRefreshToken(input: URLSearchParams): OAuthTokenResponse {
    const refreshToken = input.get("refresh_token") ?? "";
    const payload = this.verifySigned<SignedPayload & {
      sub: string;
      aud: string;
      scope: string;
    }>(refreshToken, "refresh");
    const clientId = input.get("client_id") ?? payload.sub;
    if (clientId !== payload.sub) {
      throw new OAuthRequestError("invalid_grant", "Refresh token was issued to another client.");
    }
    normalizeScope(input.get("scope") ?? payload.scope);
    return this.issueTokenPair(payload.sub, payload.aud, payload.scope);
  }

  private issueTokenPair(clientId: string, resource: string, scope: string): OAuthTokenResponse {
    const accessToken = this.sign({
      ...this.basePayload("access", ACCESS_TOKEN_TTL_SECONDS),
      sub: clientId,
      aud: resource,
      scope,
    });
    const refreshToken = this.sign({
      ...this.basePayload("refresh", REFRESH_TOKEN_TTL_SECONDS),
      sub: clientId,
      aud: resource,
      scope,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    };
  }

  private basePayload(typ: SignedPayload["typ"], ttlSeconds: number): SignedPayload {
    const now = Math.floor(Date.now() / 1000);
    return {
      v: 1,
      typ,
      iat: now,
      exp: now + ttlSeconds,
      jti: randomBytes(16).toString("base64url"),
    };
  }

  private sign(payload: SignedPayload): string {
    const encoded = base64UrlJson(payload);
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `cove_${encoded}.${signature}`;
  }

  private verifySigned<T extends SignedPayload>(token: string, expectedType: SignedPayload["typ"]): T {
    if (!token.startsWith("cove_")) {
      throw new OAuthRequestError("invalid_token", "Malformed token.", 401);
    }
    const [encoded, signature, ...extra] = token.slice("cove_".length).split(".");
    if (!encoded || !signature || extra.length > 0) {
      throw new OAuthRequestError("invalid_token", "Malformed token.", 401);
    }
    const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    if (!this.constantTimeStringEqual(signature, expected)) {
      throw new OAuthRequestError("invalid_token", "Invalid token signature.", 401);
    }
    let payload: SignedPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedPayload;
    } catch {
      throw new OAuthRequestError("invalid_token", "Malformed token payload.", 401);
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.v !== 1 || payload.typ !== expectedType || !Number.isFinite(payload.exp) || payload.exp <= now) {
      throw new OAuthRequestError("invalid_token", "Token is invalid or expired.", 401);
    }
    return payload as T;
  }

  private constantTimeStringEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private pruneAuthorizationCodes(): void {
    const now = Date.now();
    for (const [code, value] of this.authorizationCodes) {
      if (value.expiresAtMs < now) this.authorizationCodes.delete(code);
    }
  }
}

