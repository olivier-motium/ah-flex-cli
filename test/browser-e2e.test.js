import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchAhProfileContext } from "../src/browser.js";

const E2E_ENABLED = process.env.AH_FLEX_BROWSER_E2E === "1";

function assertLoopbackUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1", "The browser E2E URL must use the loopback address");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.ok(url.port, "The browser E2E URL must use an ephemeral port");
  return url;
}

function startLoopbackFixture() {
  const server = createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>ah-flex browser lifecycle fixture</body></html>");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function fixtureUrl(server) {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  return assertLoopbackUrl(`http://127.0.0.1:${address.port}/`).toString();
}

function isFixtureRequest(value, origin) {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password && url.origin === origin;
  } catch {
    return false;
  }
}

async function enforceFixtureOnly(context, url) {
  const origin = assertLoopbackUrl(url).origin;
  let blockedRequestCount = 0;
  await context.route("**/*", async (route) => {
    if (!isFixtureRequest(route.request().url(), origin)) {
      blockedRequestCount += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return () => blockedRequestCount;
}

async function openFixture(context, url) {
  const checkedUrl = assertLoopbackUrl(url).toString();
  const blockedRequestCount = await enforceFixtureOnly(context, checkedUrl);
  const page = context.pages()[0] ?? (await context.newPage());
  const response = await page.goto(checkedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assert.ok(response, "The localhost fixture must return a response");
  assert.equal(response.status(), 200);
  assertLoopbackUrl(response.url());
  assertLoopbackUrl(page.url());
  return { page, blockedRequestCount };
}

function assertBrandedIdentity(browser, identity) {
  if (browser === "firefox") {
    assert.match(identity.userAgent, /Firefox\//, `Firefox user agent was not branded: ${identity.userAgent}`);
    return;
  }
  if (browser === "chrome") {
    assert.match(identity.userAgent, /Chrome\//, `Chrome user agent was not branded: ${identity.userAgent}`);
    assert.doesNotMatch(identity.userAgent, /Edg\//, `Chrome user agent was Edge-branded: ${identity.userAgent}`);
    return;
  }
  assert.equal(browser, "edge");
  assert.match(identity.userAgent, /Edg\//, `Edge user agent was not branded: ${identity.userAgent}`);
}

async function proveBrowserLifecycle(browser, url) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ah-flex-browser-e2e-"));
  const profileDir = path.join(tempRoot, `${browser}-profile`);
  const storageKey = `ah-flex-e2e-marker-${randomUUID()}`;
  const marker = randomUUID();

  try {
    const firstContext = await launchAhProfileContext({ browser, profileDir, guarded: false });
    try {
      const profile = await stat(profileDir);
      assert.equal(profile.mode & 0o7777, 0o700, `${browser} profile must have effective mode 0700`);

      const first = await openFixture(firstContext, url);
      const identity = {
        userAgent: await first.page.evaluate(() => navigator.userAgent),
        browserVersion: firstContext.browser()?.version() ?? null,
      };
      assertBrandedIdentity(browser, identity);
      assert.ok(identity.browserVersion, `${browser} did not expose a browser version`);
      await first.page.evaluate(
        ({ key, value }) => window.localStorage.setItem(key, value),
        { key: storageKey, value: marker },
      );
      assert.equal(first.blockedRequestCount(), 0, `${browser} attempted a non-loopback request`);
    } finally {
      await firstContext.close();
    }

    const secondContext = await launchAhProfileContext({ browser, profileDir, guarded: false });
    try {
      const second = await openFixture(secondContext, url);
      const retainedMarker = await second.page.evaluate((key) => window.localStorage.getItem(key), storageKey);
      assert.equal(retainedMarker, marker, `${browser} did not retain localhost localStorage across relaunch`);
      assert.equal(second.blockedRequestCount(), 0, `${browser} attempted a non-loopback request`);
    } finally {
      await secondContext.close();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("installed branded browsers persist harmless localhost state across relaunch", { skip: !E2E_ENABLED }, async () => {
  const server = await startLoopbackFixture();
  try {
    const url = fixtureUrl(server);
    const failures = [];
    for (const browser of ["firefox", "chrome", "edge"]) {
      try {
        await proveBrowserLifecycle(browser, url);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        failures.push(new Error(`${browser} browser lifecycle proof failed: ${detail}`, { cause }));
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Installed browser lifecycle proof failed");
  } finally {
    await closeServer(server);
  }
});
