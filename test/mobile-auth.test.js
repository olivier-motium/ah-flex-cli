import assert from "node:assert/strict";
import { mkdtemp, lstat, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  MOBILE_AUTHORIZE_URL,
  MOBILE_REFRESH_URL,
  MOBILE_REDIRECT_URI,
  MOBILE_TOKEN_URL,
  createAuthorizationRequest,
  createMobileAuthClient,
  exchangeAuthorizationCallback,
  refreshSession,
  validateAuthorizationCallback,
} from "../src/mobile-auth.js";
import { MobileSessionStore } from "../src/mobile-session-store.js";

const CLIENT_ID = "test-mobile-client";
const NOW = new Date("2026-08-03T10:00:00.000Z");

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ah-flex-mobile-auth-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function deterministicRandomBytes() {
  let call = 0;
  return (size) => {
    call += 1;
    return Buffer.alloc(size, call);
  };
}

function requestFixture() {
  return createAuthorizationRequest({ clientId: CLIENT_ID, randomBytes: deterministicRandomBytes() });
}

function callbackFor(request, extra = "") {
  return `${MOBILE_REDIRECT_URI}?code=one-time-code&state=${encodeURIComponent(request.state)}${extra}`;
}

function tokenResponse(overrides = {}) {
  return {
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    token_type: "Bearer",
    expires_in: 3600,
    ...overrides,
  };
}

test("authorization requests use the Belgian tenant, exact callback, random state, and S256 PKCE", () => {
  const request = requestFixture();
  const url = new URL(request.authorizationUrl);
  const defaultRequest = createAuthorizationRequest({ randomBytes: deterministicRandomBytes() });

  assert.equal(url.origin + url.pathname, MOBILE_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.has("tenant"), false);
  assert.equal(url.searchParams.get("redirect_uri"), MOBILE_REDIRECT_URI);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), request.codeChallenge);
  assert.equal(url.searchParams.get("state"), request.state);
  assert.equal(request.redirectUri, MOBILE_REDIRECT_URI);
  assert.equal(request.codeVerifier.length, 43);
  assert.notEqual(request.state, request.codeVerifier);
  assert.equal(defaultRequest.clientId, "appie-be");
  assert.equal(new URL(defaultRequest.authorizationUrl).searchParams.get("client_id"), "appie-be");
});

test("callback validation fails closed for missing or mismatched state, callback errors, and incomplete callback URLs", () => {
  const request = requestFixture();

  assert.throws(
    () => validateAuthorizationCallback(`${MOBILE_REDIRECT_URI}?code=one-time-code`, request),
    (error) => error.code === "STATE_MISMATCH",
  );
  assert.throws(
    () => validateAuthorizationCallback(`${MOBILE_REDIRECT_URI}?code=one-time-code&state=wrong`, request),
    (error) => error.code === "STATE_MISMATCH",
  );
  assert.throws(
    () => validateAuthorizationCallback(`${MOBILE_REDIRECT_URI}?error=access_denied&state=${request.state}`, request),
    (error) => error.code === "AUTHORIZATION_ERROR",
  );
  assert.throws(
    () => validateAuthorizationCallback(`https://login.ah.be/callback?code=x&state=${request.state}`, request),
    (error) => error.code === "INVALID_CALLBACK",
  );
});

test("authorization-code exchange sends the verifier exactly once and keeps tokens out of the URL", async () => {
  const request = requestFixture();
  const calls = [];
  const session = await exchangeAuthorizationCallback(callbackFor(request), request, {
    now: NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(tokenResponse()), { status: 200 });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MOBILE_TOKEN_URL);
  assert.equal(new URL(calls[0].url).search, "");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    clientId: CLIENT_ID,
    code: "one-time-code",
    codeVerifier: request.codeVerifier,
  });
  assert.equal(session.access_token, "access-secret");
  assert.equal(session.refresh_token, "refresh-secret");
  assert.equal(session.expires_at, "2026-08-03T11:00:00.000Z");
});

test("token calls reject redirects, bounded-overflow responses, and HTTP errors without leaking response data", async () => {
  const request = requestFixture();
  await assert.rejects(
    () =>
      exchangeAuthorizationCallback(callbackFor(request), request, {
        fetch: async () => new Response("redirect", { status: 302, headers: { location: "https://evil.test/" } }),
      }),
    (error) => error.code === "REDIRECT_REJECTED",
  );

  const largeRequest = requestFixture();
  await assert.rejects(
    () =>
      exchangeAuthorizationCallback(callbackFor(largeRequest), largeRequest, {
        maxResponseBytes: 32,
        fetch: async () => new Response(JSON.stringify(tokenResponse({ access_token: "x".repeat(100) })), { status: 200 }),
      }),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );

  const errorRequest = requestFixture();
  await assert.rejects(
    () =>
      exchangeAuthorizationCallback(callbackFor(errorRequest), errorRequest, {
        fetch: async () => new Response(JSON.stringify({ access_token: "must-not-appear" }), { status: 401 }),
      }),
    (error) => error.code === "HTTP_ERROR" && !error.message.includes("must-not-appear"),
  );
});

test("token timeout aborts the injected fetch and does not retry without the verifier", async () => {
  const request = requestFixture();
  let calls = 0;
  let signal;
  await assert.rejects(
    () =>
      exchangeAuthorizationCallback(callbackFor(request), request, {
        timeoutMs: 10,
        fetch: async (_url, init) => {
          calls += 1;
          signal = init.signal;
          await new Promise((resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
          resolve();
        },
      }),
    (error) => error.code === "TIMEOUT",
  );
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test("session storage is atomic, private, symlink-resistant, and status is redacted", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "nested", "mobile-session.json");
    const store = new MobileSessionStore(filePath);
    const session = {
      version: 1,
      tenant: "appie-be",
      client_id: CLIENT_ID,
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "Bearer",
      scope: "basket",
      issued_at: NOW.toISOString(),
      expires_at: "2026-08-03T11:00:00.000Z",
    };

    await store.write(session);
    const parentStat = await lstat(path.dirname(filePath));
    const fileStat = await lstat(filePath);
    assert.equal(parentStat.mode & 0o7777, 0o700);
    assert.equal(fileStat.mode & 0o7777, 0o600);
    assert.deepEqual(await store.read(), session);

    const status = await store.status({ now: NOW });
    assert.equal(status.has_access_token, true);
    assert.equal(status.has_refresh_token, true);
    assert.equal(status.access_token, undefined);
    assert.equal(status.refresh_token, undefined);
    assert.equal(JSON.stringify(status).includes("access-secret"), false);
    assert.equal(JSON.stringify(status).includes("refresh-secret"), false);

    assert.equal(await store.delete(), true);
    assert.deepEqual(await store.status({ now: NOW }), { exists: false });
  });
});

test("session storage rejects symlink parents and targets", async () => {
  await withTempDirectory(async (directory) => {
    const outside = path.join(directory, "outside");
    const parentLink = path.join(directory, "parent-link");
    const targetPath = path.join(directory, "target.json");
    const targetLink = path.join(directory, "target-link.json");
    const session = {
      version: 1,
      tenant: "appie-be",
      client_id: CLIENT_ID,
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "Bearer",
      issued_at: NOW.toISOString(),
      expires_at: "2026-08-03T11:00:00.000Z",
    };

    await symlink(directory, parentLink, "dir");
    await assert.rejects(
      () => new MobileSessionStore(path.join(parentLink, "session.json")).write(session),
      (error) => error.code === "SYMLINK_SESSION_PATH",
    );

    await new MobileSessionStore(targetPath).write(session);
    await symlink(targetPath, targetLink, "file");
    await assert.rejects(
      () => new MobileSessionStore(targetLink).write(session),
      (error) => error.code === "SYMLINK_SESSION_PATH",
    );
    await rm(outside, { recursive: true, force: true });
  });
});

test("refresh rotates the stored refresh token and preserves safe metadata", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "session.json");
    const store = new MobileSessionStore(filePath);
    const initial = {
      version: 1,
      tenant: "appie-be",
      client_id: CLIENT_ID,
      access_token: "old-access-secret",
      refresh_token: "old-refresh-secret",
      token_type: "Bearer",
      issued_at: NOW.toISOString(),
      expires_at: "2026-08-03T11:00:00.000Z",
    };
    await store.write(initial);

    let call;
    const client = createMobileAuthClient({
      store,
      now: NOW,
      fetch: async (url, init) => {
        call = { url, init };
        return new Response(JSON.stringify(tokenResponse({ access_token: "new-access-secret", refresh_token: "new-refresh-secret" })), {
          status: 200,
        });
      },
    });
    const refreshed = await client.refresh();
    const body = JSON.parse(call.init.body);
    assert.equal(call.url, MOBILE_REFRESH_URL);
    assert.deepEqual(body, { clientId: CLIENT_ID, refreshToken: "old-refresh-secret" });
    assert.equal(refreshed.access_token, "new-access-secret");
    assert.equal(refreshed.refresh_token, "new-refresh-secret");
    assert.equal((await store.read()).refresh_token, "new-refresh-secret");
    assert.equal((await store.status({ now: NOW })).refresh_token, undefined);
  });
});

test("strict token response validation rejects unknown fields without a downgrade", async () => {
  const request = requestFixture();
  let calls = 0;
  await assert.rejects(
    () =>
      exchangeAuthorizationCallback(callbackFor(request), request, {
        fetch: async (_url, init) => {
          calls += 1;
          const body = JSON.parse(init.body);
          assert.equal(body.codeVerifier, request.codeVerifier);
          return new Response(JSON.stringify({ ...tokenResponse(), unexpected: "value" }), { status: 200 });
        },
      }),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(calls, 1);
});
