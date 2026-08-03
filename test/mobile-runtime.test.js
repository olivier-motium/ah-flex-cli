import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MOBILE_TOKEN_URL } from "../src/mobile-auth.js";
import { MOBILE_API_ORIGIN } from "../src/mobile-api.js";
import { createMobileRuntime } from "../src/mobile-runtime.js";

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("one callback exchange creates a reusable member-proved mobile session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-flex-mobile-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === MOBILE_TOKEN_URL) {
      const body = JSON.parse(init.body);
      assert.equal(body.clientId, "appie-be");
      assert.equal(body.code, "fixture-code");
      assert.equal(typeof body.codeVerifier, "string");
      return jsonResponse({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    assert.equal(url, `${MOBILE_API_ORIGIN}/graphql`);
    assert.equal(JSON.parse(init.body).operationName, "member");
    assert.equal(init.headers.Authorization, "Bearer fixture-access");
    return jsonResponse({ data: { member: { __typename: "Member", analytics: { digimon: "fixture" } } } });
  };

  const runtime = createMobileRuntime({
    stateDir: path.join(root, ".ah-flex"),
    fetchImpl,
    now: new Date("2026-08-03T10:00:00.000Z"),
  });
  const request = runtime.beginLogin();
  await runtime.completeLogin(
    `appie://login-exit?code=fixture-code&state=${encodeURIComponent(request.state)}`,
    request,
  );

  assert.deepEqual(await runtime.status(), {
    transport: "mobile",
    state: "authenticated",
    authenticated: true,
    expires_at: "2026-08-03T11:00:00.000Z",
  });
  assert.equal(calls.length, 3);
});
