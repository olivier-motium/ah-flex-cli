import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  MobileSessionStore,
  deleteSession,
  getSessionStatus,
  readSession,
  validateSession,
  writeSession,
} from "./mobile-session-store.js";

export const MOBILE_TENANT = "appie-be";
export const MOBILE_REDIRECT_URI = "appie://login-exit";
export const MOBILE_AUTHORIZE_URL = "https://login.ah.be/secure/oauth/authorize";
export const MOBILE_TOKEN_URL = "https://api.ah.be/mobile-auth/v1/auth/token";
export const MOBILE_REFRESH_URL = "https://api.ah.be/mobile-auth/v1/auth/token/refresh";
export const MOBILE_API_ORIGIN = "https://api.ah.be";
export const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

const RANDOM_BYTES = 32;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_EXPIRY_SECONDS = 10 * 365 * 24 * 60 * 60;
const MAX_CLIENT_ID_LENGTH = 1 * 1024;
const MAX_SCOPE_LENGTH = 4 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const TOKEN_RESPONSE_KEYS = new Set(["access_token", "refresh_token", "token_type", "expires_in", "scope"]);

export const MOBILE_AUTH_ENDPOINTS = Object.freeze({
  authorize: MOBILE_AUTHORIZE_URL,
  token: MOBILE_TOKEN_URL,
  refresh: MOBILE_REFRESH_URL,
});

export class MobileAuthError extends Error {
  constructor(message, { code = "MOBILE_AUTH_ERROR", status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MobileAuthError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function invalid(message, code = "INVALID_AUTH_INPUT") {
  return new MobileAuthError(message, { code });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function assertNonEmptyString(value, label, maxLength = 16 * 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalid(`The mobile OAuth ${label} is invalid`);
  }
  return value;
}

function assertTenant(value) {
  if (value !== MOBILE_TENANT) throw invalid("The mobile OAuth tenant must be appie-be");
  return value;
}

function assertRedirectUri(value) {
  if (value !== MOBILE_REDIRECT_URI) {
    throw invalid("The mobile OAuth redirect URI must be exactly appie://login-exit");
  }
  return value;
}

function base64UrlRandom(randomBytes, size) {
  let value;
  try {
    value = randomBytes(size);
  } catch (error) {
    throw new MobileAuthError("Unable to create cryptographic mobile OAuth material", {
      code: "RANDOMNESS_ERROR",
      cause: error,
    });
  }
  const bytes = Buffer.from(value);
  if (bytes.length !== size) throw new MobileAuthError("The cryptographic random source returned invalid data");
  return bytes.toString("base64url");
}

function codeChallengeFor(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function assertVerifier(value) {
  assertNonEmptyString(value, "PKCE verifier", 128);
  if (value.length < 43 || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw invalid("The mobile OAuth PKCE verifier is invalid");
  }
  return value;
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function parseNow(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("A valid mobile session time is required");
  return date;
}

function assertPendingRequest(request) {
  if (!isPlainObject(request)) throw invalid("The mobile OAuth authorization request is invalid");
  const clientId = assertNonEmptyString(request.clientId ?? request.client_id, "client ID", MAX_CLIENT_ID_LENGTH);
  const tenant = assertTenant(request.tenant ?? MOBILE_TENANT);
  const redirectUri = assertRedirectUri(request.redirectUri ?? request.redirect_uri ?? MOBILE_REDIRECT_URI);
  const state = assertNonEmptyString(request.state, "state", 512);
  const codeVerifier = assertVerifier(request.codeVerifier ?? request.code_verifier);
  const expectedChallenge = codeChallengeFor(codeVerifier);
  if (request.codeChallenge !== undefined && request.codeChallenge !== expectedChallenge) {
    throw invalid("The mobile OAuth PKCE challenge does not match the verifier");
  }
  return { clientId, tenant, redirectUri, state, codeVerifier, codeChallenge: expectedChallenge };
}

function parseCallbackUrl(callbackUrl) {
  let url;
  try {
    url = callbackUrl instanceof URL ? new URL(callbackUrl.href) : new URL(callbackUrl);
  } catch (error) {
    throw new MobileAuthError("The mobile OAuth callback URL is invalid", {
      code: "INVALID_CALLBACK",
      cause: error,
    });
  }
  if (
    url.protocol !== "appie:" ||
    url.hostname !== "login-exit" ||
    url.host !== "login-exit" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "" ||
    url.hash
  ) {
    throw invalid("The mobile OAuth callback must use the full appie://login-exit URL", "INVALID_CALLBACK");
  }
  return url;
}

function assertSingleParameter(params, name) {
  const values = params.getAll(name);
  if (values.length > 1) throw invalid(`The mobile OAuth callback has duplicate ${name}`, "INVALID_CALLBACK");
  return values[0] ?? null;
}

export function validateAuthorizationCallback(callbackUrl, authorizationRequest) {
  const pending = assertPendingRequest(authorizationRequest);
  const url = parseCallbackUrl(callbackUrl);
  const params = url.searchParams;

  const error = assertSingleParameter(params, "error");
  const errorDescription = assertSingleParameter(params, "error_description");
  const errorUri = assertSingleParameter(params, "error_uri");
  if (error !== null || errorDescription !== null || errorUri !== null) {
    throw new MobileAuthError("The mobile OAuth authorization was rejected by the callback", {
      code: "AUTHORIZATION_ERROR",
    });
  }

  const state = assertSingleParameter(params, "state");
  if (state === null || !safeEqual(state, pending.state)) {
    throw new MobileAuthError("The mobile OAuth callback state did not match", {
      code: "STATE_MISMATCH",
    });
  }

  const code = assertSingleParameter(params, "code");
  if (code === null || code.length === 0 || code.length > MAX_TOKEN_LENGTH) {
    throw new MobileAuthError("The mobile OAuth callback did not contain an authorization code", {
      code: "MISSING_AUTHORIZATION_CODE",
    });
  }

  return Object.freeze({
    code,
    state,
    redirectUri: pending.redirectUri,
    clientId: pending.clientId,
    tenant: pending.tenant,
  });
}

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("An injected fetch function is required in this runtime");
  }
  return fetchImpl;
}

function assertRequestOptions(options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("The mobile OAuth timeout must be an integer from 1 to 600000 milliseconds");
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new TypeError("The mobile OAuth response limit is invalid");
  }
  return { timeoutMs, maxResponseBytes };
}

function assertTokenEndpoint(urlString) {
  const url = new URL(urlString);
  if (
    url.origin !== MOBILE_API_ORIGIN ||
    url.search ||
    url.hash ||
    (url.href !== MOBILE_TOKEN_URL && url.href !== MOBILE_REFRESH_URL)
  ) {
    throw new MobileAuthError("The mobile OAuth token endpoint is not allowed", {
      code: "ENDPOINT_NOT_ALLOWED",
    });
  }
  return url.href;
}

function responseUrlIsAllowed(response, expectedUrl) {
  if (response.type === "opaqueredirect") return false;
  if (!response.url) return true;
  let responseUrl;
  try {
    responseUrl = new URL(response.url);
  } catch {
    return false;
  }
  const expected = new URL(expectedUrl);
  return (
    responseUrl.origin === MOBILE_API_ORIGIN &&
    responseUrl.origin === expected.origin &&
    responseUrl.pathname === expected.pathname &&
    responseUrl.search === "" &&
    responseUrl.hash === ""
  );
}

async function readResponseTextBounded(response, maxBytes) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let failed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          failed = true;
          throw new MobileAuthError("The mobile OAuth response exceeded its size limit", {
            code: "RESPONSE_TOO_LARGE",
          });
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      if (failed && typeof reader.cancel === "function") {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response failure.
        }
      }
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }
  }

  if (typeof response.text !== "function") {
    throw new MobileAuthError("The mobile OAuth response body is unreadable", {
      code: "INVALID_RESPONSE",
    });
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new MobileAuthError("The mobile OAuth response body is unreadable", {
      code: "INVALID_RESPONSE",
      cause: error,
    });
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new MobileAuthError("The mobile OAuth response exceeded its size limit", {
      code: "RESPONSE_TOO_LARGE",
    });
  }
  return text;
}

function assertTokenResponseShape(payload) {
  if (!isPlainObject(payload)) {
    throw new MobileAuthError("The mobile OAuth token response is not a JSON object", {
      code: "INVALID_RESPONSE",
    });
  }
  for (const key of Object.keys(payload)) {
    if (!TOKEN_RESPONSE_KEYS.has(key)) {
      throw new MobileAuthError("The mobile OAuth token response has an unexpected field", {
        code: "INVALID_RESPONSE",
      });
    }
  }
  return payload;
}

async function postTokenRequest(endpoint, form, options = {}) {
  const url = assertTokenEndpoint(endpoint);
  const fetchImpl = assertFetch(options.fetch ?? globalThis.fetch);
  const { timeoutMs, maxResponseBytes } = assertRequestOptions(options);
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  let timer = null;
  let removeAbortListener = null;

  if (options.signal !== undefined) {
    if (!(options.signal instanceof AbortSignal)) throw new TypeError("The mobile OAuth signal is invalid");
    if (options.signal.aborted) {
      throw new MobileAuthError("The mobile OAuth request was aborted", { code: "ABORTED" });
    }
    const onAbort = () => {
      externallyAborted = true;
      controller.abort();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.signal.removeEventListener("abort", onAbort);
  }

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: new URLSearchParams(form).toString(),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new MobileAuthError("The mobile OAuth request timed out", {
          code: "TIMEOUT",
        });
      }
      if (externallyAborted || controller.signal.aborted) {
        throw new MobileAuthError("The mobile OAuth request was aborted", {
          code: "ABORTED",
        });
      }
      throw new MobileAuthError("The mobile OAuth request failed", {
        code: "NETWORK_ERROR",
        cause: error,
      });
    }

    if (!response || !Number.isInteger(response.status)) {
      throw new MobileAuthError("The mobile OAuth response was malformed", { code: "INVALID_RESPONSE" });
    }
    if (!responseUrlIsAllowed(response, url)) {
      throw new MobileAuthError("The mobile OAuth token call returned a disallowed redirect", {
        code: "REDIRECT_REJECTED",
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new MobileAuthError("The mobile OAuth token call returned a redirect", {
        code: "REDIRECT_REJECTED",
        status: response.status,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MobileAuthError("The mobile OAuth token call failed", {
        code: "HTTP_ERROR",
        status: response.status,
      });
    }

    const text = await readResponseTextBounded(response, maxResponseBytes);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new MobileAuthError("The mobile OAuth response was not valid JSON", {
        code: "INVALID_RESPONSE",
        cause: error,
      });
    }
    return assertTokenResponseShape(payload);
  } finally {
    if (timer) clearTimeout(timer);
    if (removeAbortListener) removeAbortListener();
  }
}

function normalizeTokenResponse(payload, metadata, options = {}) {
  const response = assertTokenResponseShape(payload);
  const accessToken = assertNonEmptyString(response.access_token, "access token", MAX_TOKEN_LENGTH);
  const tokenType = response.token_type ?? metadata.previousTokenType ?? "Bearer";
  assertNonEmptyString(tokenType, "token type", 128);
  if (!Number.isInteger(response.expires_in) || response.expires_in < 1 || response.expires_in > MAX_EXPIRY_SECONDS) {
    throw new MobileAuthError("The mobile OAuth token response has an invalid expiry", {
      code: "INVALID_RESPONSE",
    });
  }
  if (response.scope !== undefined) assertNonEmptyString(response.scope, "scope", MAX_SCOPE_LENGTH);
  if (response.refresh_token !== undefined) {
    assertNonEmptyString(response.refresh_token, "refresh token", MAX_TOKEN_LENGTH);
  }

  const issuedAt = parseNow(metadata.now);
  const expiresAt = new Date(issuedAt.getTime() + response.expires_in * 1000);
  const refreshToken = response.refresh_token ?? metadata.previousRefreshToken;
  if (options.requireRefreshToken && !refreshToken) {
    throw new MobileAuthError("The mobile OAuth token response did not contain a refresh token", {
      code: "INVALID_RESPONSE",
    });
  }

  const session = {
    version: 1,
    tenant: metadata.tenant,
    client_id: metadata.clientId,
    access_token: accessToken,
    token_type: tokenType,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  if (refreshToken !== undefined) session.refresh_token = refreshToken;
  const scope = response.scope ?? metadata.previousScope;
  if (scope !== undefined) session.scope = scope;
  validateSession(session);
  return Object.freeze(session);
}

export function createAuthorizationRequest(options = {}) {
  const clientId = assertNonEmptyString(options.clientId ?? options.client_id, "client ID", MAX_CLIENT_ID_LENGTH);
  const tenant = assertTenant(options.tenant ?? MOBILE_TENANT);
  const redirectUri = assertRedirectUri(options.redirectUri ?? options.redirect_uri ?? MOBILE_REDIRECT_URI);
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  if (typeof randomBytes !== "function") throw new TypeError("The mobile OAuth random source is invalid");

  const codeVerifier = base64UrlRandom(randomBytes, RANDOM_BYTES);
  const codeChallenge = codeChallengeFor(codeVerifier);
  const state = base64UrlRandom(randomBytes, RANDOM_BYTES);
  const authorizationUrl = new URL(MOBILE_AUTHORIZE_URL);
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("tenant", tenant);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", state);
  if (options.scope !== undefined) {
    authorizationUrl.searchParams.set("scope", assertNonEmptyString(options.scope, "scope", MAX_SCOPE_LENGTH));
  }

  return Object.freeze({
    authorizationUrl: authorizationUrl.href,
    url: authorizationUrl.href,
    clientId,
    tenant,
    redirectUri,
    state,
    codeVerifier,
    codeChallenge,
  });
}

export async function exchangeAuthorizationCallback(callbackUrl, authorizationRequest, options = {}) {
  const pending = assertPendingRequest(authorizationRequest);
  const callback = validateAuthorizationCallback(callbackUrl, authorizationRequest);
  const payload = await postTokenRequest(
    MOBILE_TOKEN_URL,
    {
      grant_type: "authorization_code",
      code: callback.code,
      client_id: pending.clientId,
      tenant: pending.tenant,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    },
    options,
  );
  return normalizeTokenResponse(
    payload,
    {
      clientId: pending.clientId,
      tenant: pending.tenant,
      now: options.now,
    },
    { requireRefreshToken: options.requireRefreshToken ?? true },
  );
}

export async function refreshSession(session, options = {}) {
  validateSession(session);
  if (!session.refresh_token) {
    throw new MobileAuthError("The stored mobile session has no refresh token", {
      code: "NO_REFRESH_TOKEN",
    });
  }
  const payload = await postTokenRequest(
    MOBILE_REFRESH_URL,
    {
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
      client_id: session.client_id,
      tenant: session.tenant,
    },
    options,
  );
  return normalizeTokenResponse(
    payload,
    {
      clientId: session.client_id,
      tenant: session.tenant,
      now: options.now,
      previousRefreshToken: session.refresh_token,
      previousTokenType: session.token_type,
      previousScope: session.scope,
    },
    { requireRefreshToken: false },
  );
}

function assertStore(store) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    throw new TypeError("A mobile session store with read() and write() is required");
  }
  return store;
}

export function createMobileAuthClient(options = {}) {
  const store = options.store ?? (options.sessionPath ? new MobileSessionStore(options.sessionPath, options) : null);
  const config = { ...options };
  delete config.store;
  delete config.sessionPath;

  const client = {
    createAuthorizationRequest(requestOptions = {}) {
      return createAuthorizationRequest({ ...config, ...requestOptions });
    },
    validateCallback(callbackUrl, authorizationRequest) {
      return validateAuthorizationCallback(callbackUrl, authorizationRequest);
    },
    exchangeCallback(callbackUrl, authorizationRequest, requestOptions = {}) {
      return exchangeAuthorizationCallback(callbackUrl, authorizationRequest, { ...config, ...requestOptions });
    },
    async completeLogin(callbackUrl, authorizationRequest, requestOptions = {}) {
      const session = await this.exchangeCallback(callbackUrl, authorizationRequest, requestOptions);
      await assertStore(store).write(session);
      return session;
    },
    async refresh(requestOptions = {}) {
      const current = await assertStore(store).read();
      if (!current) {
        throw new MobileAuthError("No stored mobile session is available", { code: "NO_SESSION" });
      }
      const next = await refreshSession(current, { ...config, ...requestOptions });
      await assertStore(store).write(next);
      return next;
    },
    readSession() {
      return assertStore(store).read();
    },
    writeSession(session) {
      return assertStore(store).write(session);
    },
    deleteSession() {
      const target = assertStore(store);
      if (typeof target.delete !== "function") throw new TypeError("The mobile session store has no delete() method");
      return target.delete();
    },
    status() {
      const target = assertStore(store);
      if (typeof target.status !== "function") throw new TypeError("The mobile session store has no status() method");
      return target.status();
    },
  };
  return Object.freeze(client);
}

export const validateCallback = validateAuthorizationCallback;
export const exchangeCallback = exchangeAuthorizationCallback;
export const exchangeAuthorizationCode = exchangeAuthorizationCallback;
export const refreshAccessToken = refreshSession;

export { MobileSessionStore, deleteSession, getSessionStatus, readSession, validateSession, writeSession };
