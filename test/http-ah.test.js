import test from "node:test";
import assert from "node:assert/strict";
import { assertAhPath, browserMimicHeaders, fetchAhDocument } from "../src/http-ah.js";
import { BasketError } from "../src/basket.js";

function stubResponse({ status = 200, body = "<html>ok</html>", url = "https://www.ah.be/zoeken?query=kip" } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    text: async () => body,
  };
}

test("browser-mimic headers carry a coherent Chrome identity", () => {
  const headers = browserMimicHeaders();
  assert.match(headers["user-agent"], /Chrome\/150\.0\.0\.0 Safari\/537\.36$/);
  assert.match(headers["sec-ch-ua"], /"Google Chrome";v="150"/);
  assert.match(headers["sec-ch-ua"], /"Chromium";v="150"/);
  assert.equal(headers["sec-ch-ua-mobile"], "?0");
  assert.match(headers["accept-language"], /^nl-BE,nl/);
  assert.equal(headers["sec-fetch-dest"], "document");
  assert.equal(headers["sec-fetch-mode"], "navigate");
  assert.equal(headers["sec-fetch-site"], "none");
});

test("fetchAhDocument returns the final url and html for a 200", async () => {
  const result = await fetchAhDocument("/zoeken?query=kip", {
    headers: {},
    fetchImpl: async () => stubResponse({ body: "<html>products</html>" }),
  });
  assert.equal(result.url, "https://www.ah.be/zoeken?query=kip");
  assert.equal(result.html, "<html>products</html>");
});

test("fetchAhDocument fails closed on an Access Denied status or body", async () => {
  await assert.rejects(
    fetchAhDocument("/zoeken?query=kip", { headers: {}, fetchImpl: async () => stubResponse({ status: 403 }) }),
    (error) => error instanceof BasketError && /denied/i.test(error.message),
  );
  await assert.rejects(
    fetchAhDocument("/zoeken?query=kip", {
      headers: {},
      fetchImpl: async () => stubResponse({ status: 200, body: "<TITLE>Access Denied</TITLE>" }),
    }),
    (error) => error instanceof BasketError && /denied/i.test(error.message),
  );
});

test("fetchAhDocument reports non-denial failures without retrying", async () => {
  await assert.rejects(
    fetchAhDocument("/zoeken?query=kip", { headers: {}, fetchImpl: async () => stubResponse({ status: 500 }) }),
    /status 500/,
  );
  await assert.rejects(
    fetchAhDocument("/zoeken?query=kip", {
      headers: {},
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    }),
    /socket hang up/,
  );
});

test("fetchAhDocument refuses redirects away from www.ah.be", async () => {
  await assert.rejects(
    fetchAhDocument("/mijnlijst", {
      headers: {},
      fetchImpl: async () => stubResponse({ url: "https://example.com/phish" }),
    }),
    /refusing to follow/,
  );
});

test("assertAhPath only accepts local absolute paths", () => {
  assert.equal(assertAhPath("/zoeken?query=kip"), "/zoeken?query=kip");
  assert.throws(() => assertAhPath("https://example.com/x"), BasketError);
  assert.throws(() => assertAhPath("//example.com/x"), BasketError);
});
