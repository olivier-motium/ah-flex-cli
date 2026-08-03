import test from "node:test";
import assert from "node:assert/strict";
import {
  BASKET_ITEMS_ADD_OPERATION,
  BASKET_ITEMS_UPDATE_OPERATION,
} from "../src/basket-graphql.js";
import { BasketError } from "../src/basket.js";
import {
  MOBILE_API_ORIGIN,
  MobileApiError,
  createMobileApiClient,
  createMobileBasketAdapter,
} from "../src/mobile-api.js";

const lines = [
  { url: "https://www.ah.be/producten/product/wi111111/exact-one", quantity: 2, expected_name: "Exact one" },
  { url: "https://www.ah.be/producten/product/wi222222/exact-two", quantity: 1, expected_name: "Exact two" },
];

const snapshot = (itemsInList = [], externalItems = [], itemsInOrder = []) => ({
  itemsInList,
  externalItems,
  itemsInOrder,
});

function jsonResponse(payload, { url, status = 200, contentType = "application/json" } = {}) {
  const target = url ?? `${MOBILE_API_ORIGIN}/graphql`;
  const body = JSON.stringify(payload);
  return {
    status,
    url: target,
    headers: {
      "content-type": contentType,
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
    text: async () => body,
  };
}

function clientWith(fetchImpl, options = {}) {
  return createMobileApiClient({
    fetchImpl,
    getAccessToken: async () => "fixture-token",
    timeoutMs: 100,
    ...options,
  });
}

test("mobile GraphQL requests use the injected token, member guard, configurable identity, and locked origin", async () => {
  const calls = [];
  const client = clientWith(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: { basket: snapshot() } });
  }, {
    identity: { userAgent: "Appie/9.1.0", headers: { "X-Fixture-Device": "ios" } },
  });

  await client.readBasket();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${MOBILE_API_ORIGIN}/graphql`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Authorization, "Bearer fixture-token");
  assert.equal(calls[0].init.headers["X-Require-Member"], "true");
  assert.equal(calls[0].init.headers["User-Agent"], "Appie/9.1.0");
  assert.equal(calls[0].init.headers["X-Fixture-Device"], "ios");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(calls[0].init.body).operationName, "basket");
});

test("mobile transport rejects off-origin redirects, non-JSON bodies, and wrong envelopes", async () => {
  const redirected = clientWith(async () =>
    jsonResponse({ data: { basket: snapshot() } }, { url: "https://example.com/graphql" }),
  );
  await assert.rejects(() => redirected.readBasket(), (error) => error instanceof MobileApiError && /redirected|origin/i.test(error.message));

  const html = clientWith(async () =>
    jsonResponse("<html>denied</html>", { contentType: "text/html" }),
  );
  await assert.rejects(() => html.readBasket(), /non-JSON/);

  const wrongEnvelope = clientWith(async () => jsonResponse({ data: { notBasket: {} } }));
  await assert.rejects(() => wrongEnvelope.readBasket(), (error) => error instanceof BasketError && /no usable basket/i.test(error.message));
});

test("mobile transport rejects timeouts and bounded-response overflow", async () => {
  const timeoutClient = createMobileApiClient({
    fetchImpl: async () => new Promise(() => {}),
    getAccessToken: "fixture-token",
    timeoutMs: 5,
  });
  await assert.rejects(() => timeoutClient.readBasket(), /timed out/);

  const oversized = createMobileApiClient({
    fetchImpl: async () => ({
      status: 200,
      url: `${MOBILE_API_ORIGIN}/graphql`,
      headers: { "content-type": "application/json" },
      text: async () => JSON.stringify({ data: { basket: snapshot() }, padding: "x".repeat(200) }),
    }),
    getAccessToken: "fixture-token",
    maxBytes: 64,
  });
  await assert.rejects(() => oversized.readBasket(), /exceeded.*64-byte limit/);
});

test("mobile GraphQL basket parsing keeps all collections strict", async () => {
  const malformed = clientWith(async () =>
    jsonResponse({ data: { basket: { itemsInList: [{ id: 111111, quantity: 1 }], externalItems: [], itemsInOrder: [{ id: 111111, quantity: 1 }] } } }),
  );
  await assert.rejects(() => malformed.readBasket(), (error) => error instanceof BasketError && /Duplicate or ambiguous/i.test(error.message));

  const missing = clientWith(async () => jsonResponse({ data: { basket: { itemsInList: [], externalItems: [] } } }));
  await assert.rejects(() => missing.readBasket(), /itemsInOrder was missing/);
});

test("mobile basket adapter preflights, adds, rereads, tops up safely, and exposes idempotent readback", async () => {
  const responses = [
    jsonResponse({ data: { basket: snapshot([{ id: 111111, quantity: 1 }]) } }),
    jsonResponse({
      data: {
        basketItemsAdd: {
          result: snapshot([{ id: 111111, quantity: 1 }, { id: 222222, quantity: 1 }]),
        },
      },
    }),
    jsonResponse({ data: { basket: snapshot([{ id: 111111, quantity: 1 }, { id: 222222, quantity: 1 }]) } }),
    jsonResponse({
      data: {
        basketItemsUpdate: {
          result: snapshot([{ id: 111111, quantity: 2 }, { id: 222222, quantity: 1 }]),
        },
      },
    }),
    jsonResponse({ data: { basket: snapshot([{ id: 111111, quantity: 2 }, { id: 222222, quantity: 1 }]) } }),
  ];
  const operations = [];
  const client = clientWith(async (url, init) => {
    assert.equal(new URL(url).origin, MOBILE_API_ORIGIN);
    operations.push(JSON.parse(init.body).operationName);
    return responses.shift();
  });
  const adapter = createMobileBasketAdapter(client, lines);

  assert.deepEqual(await adapter.read(), [{ url: lines[0].url, name: "Exact one", quantity: 1 }]);
  let dispatches = 0;
  const result = await adapter.applyExactBatch(lines, () => {
    dispatches += 1;
  });
  assert.equal(dispatches, 2);
  assert.deepEqual(operations, [
    "basket",
    BASKET_ITEMS_ADD_OPERATION,
    "basket",
    BASKET_ITEMS_UPDATE_OPERATION,
  ]);
  assert.deepEqual(result.outcomes.map(({ action }) => action), ["topped-up", "added"]);
  assert.deepEqual(await adapter.read(), [
    { url: lines[0].url, name: "Exact one", quantity: 2 },
    { url: lines[1].url, name: "Exact two", quantity: 1 },
  ]);
  assert.equal(responses.length, 0);
});
