import test from "node:test";
import assert from "node:assert/strict";
import { BasketError } from "../src/basket.js";
import {
  BASKET_ITEMS_ADD_OPERATION,
  BASKET_ITEMS_UPDATE_OPERATION,
  buildBasketMutationPlan,
  createBasketGraphqlAdapter,
  createBasketItemsAddRequest,
  normalizeBasketCollections,
  normalizeRequestedLines,
  parseProductIdFromUrl,
  reconcileTopUpCandidates,
  validateBasketMutationResponse,
} from "../src/browser.js";

const lines = [
  {
    url: "https://www.ah.be/producten/product/wi111111/exact-one",
    quantity: 2,
    expected_name: "Exact one",
  },
  {
    url: "https://www.ah.be/producten/product/wi222222/exact-two",
    quantity: 1,
    expected_name: "Exact two",
  },
];

const snapshot = (itemsInList = [], externalItems = [], itemsInOrder = []) => ({
  itemsInList,
  externalItems,
  itemsInOrder,
});

test("strict wi parsing rejects unsafe and duplicate numeric product IDs before mutation", () => {
  assert.equal(parseProductIdFromUrl(lines[0].url), 111111);
  assert.throws(
    () => parseProductIdFromUrl("https://www.ah.be/producten/product/wi9007199254740992/unsafe"),
    /unsafe AH product ID/,
  );
  assert.throws(
    () => normalizeRequestedLines([lines[0], { ...lines[0], url: `${lines[0].url}-different` }]),
    /Duplicate numeric AH product ID/,
  );
});

test("basket normalization covers nullable collections and rejects ambiguous or malformed rows", () => {
  assert.deepEqual(
    normalizeBasketCollections({
      itemsInList: [{ id: 111111, quantity: 2 }],
      externalItems: null,
      itemsInOrder: [{ id: 222222, quantity: 1 }],
    }),
    snapshot([{ id: 111111, quantity: 2 }], [], [{ id: 222222, quantity: 1 }]),
  );
  assert.throws(
    () => normalizeBasketCollections(snapshot([{ id: 111111, quantity: 1 }], [{ id: 111111, quantity: 1 }])),
    /Duplicate or ambiguous/,
  );
  assert.throws(
    () => normalizeBasketCollections(snapshot([{ id: 111111, quantity: 0 }])),
    /quantity was malformed/,
  );
  assert.throws(
    () => normalizeBasketCollections({ itemsInList: [], externalItems: [] }),
    /itemsInOrder was missing/,
  );
});

test("planning separates absent, equal, lower, and higher quantities without reducing", () => {
  const requested = [
    ...lines,
    { url: "https://www.ah.be/producten/product/wi333333/equal", quantity: 3 },
    { url: "https://www.ah.be/producten/product/wi444444/higher", quantity: 2 },
  ];
  const plan = buildBasketMutationPlan(
    requested,
    snapshot([
      { id: 111111, quantity: 1 },
      { id: 333333, quantity: 3 },
      { id: 444444, quantity: 5 },
    ]),
  );
  assert.deepEqual(plan.addItems, [{ id: 222222, quantity: 1, description: null }]);
  assert.deepEqual(plan.topUpCandidates.map(({ id, baseline_quantity }) => ({ id, baseline_quantity })), [
    { id: 111111, baseline_quantity: 1 },
  ]);
  assert.deepEqual(plan.lines.map(({ action }) => action), [
    "candidate-top-up",
    "absent",
    "already-present",
    "kept-higher",
  ]);

  assert.throws(
    () => reconcileTopUpCandidates(plan, snapshot([{ id: 111111, quantity: 1.5 }])),
    /quantity was malformed/,
  );
  const driftLine = [{ ...lines[0], quantity: 3 }];
  const driftPlan = buildBasketMutationPlan(driftLine, snapshot([{ id: 111111, quantity: 1 }]));
  assert.throws(
    () => reconcileTopUpCandidates(driftPlan, snapshot([{ id: 111111, quantity: 2 }])),
    /changed concurrently below/,
  );
});

test("pinned mutation request and acknowledgement validate only bounded basket state", () => {
  const request = createBasketItemsAddRequest([{ id: 222222, quantity: 1 }]);
  assert.equal(request.body.operationName, BASKET_ITEMS_ADD_OPERATION);
  assert.deepEqual(request.body.variables.items, [{ id: 222222, quantity: 1, description: null }]);
  assert.equal(request.headers["X-Require-Member"], "true");

  const result = validateBasketMutationResponse(
    {
      data: {
        basketItemsAdd: {
          result: snapshot([{ id: 222222, quantity: 1 }]),
        },
      },
    },
    BASKET_ITEMS_ADD_OPERATION,
  );
  assert.equal(result.acknowledged, true);
  assert.deepEqual(result.snapshot.itemsInList, [{ id: 222222, quantity: 1 }]);
  assert.throws(
    () =>
      validateBasketMutationResponse(
        { data: { basketItemsAdd: { result: null } } },
        BASKET_ITEMS_ADD_OPERATION,
      ),
    /no usable result/,
  );
});

test("browser adapter dispatches one add batch, rereads, then one safe update batch", async () => {
  const responses = [
    { status: 200, json: { data: { basket: snapshot([{ id: 111111, quantity: 1 }]) } } },
    {
      status: 200,
      json: {
        data: {
          basketItemsAdd: {
            result: snapshot([
              { id: 111111, quantity: 1 },
              { id: 222222, quantity: 1 },
            ]),
          },
        },
      },
    },
    {
      status: 200,
      json: {
        data: {
          basket: snapshot([
            { id: 111111, quantity: 1 },
            { id: 222222, quantity: 1 },
          ]),
        },
      },
    },
    {
      status: 200,
      json: {
        data: {
          basketItemsUpdate: {
            result: snapshot([
              { id: 111111, quantity: 2 },
              { id: 222222, quantity: 1 },
            ]),
          },
        },
      },
    },
  ];
  const operations = [];
  const page = {
    url: () => "https://www.ah.be/mijnlijst",
    evaluate: async (_fn, input) => {
      operations.push(input.body.operationName);
      return responses.shift();
    },
  };
  const adapter = createBasketGraphqlAdapter(page, lines);
  const before = await adapter.read();
  assert.deepEqual(before, [{ url: lines[0].url, name: "Exact one", quantity: 1 }]);
  let dispatches = 0;
  const result = await adapter.applyExactBatch(
    [
      { url: lines[0].url, quantity: 2 },
      { url: lines[1].url, quantity: 1 },
    ],
    () => {
      dispatches += 1;
    },
  );
  assert.equal(dispatches, 2);
  assert.deepEqual(operations, ["basket", BASKET_ITEMS_ADD_OPERATION, "basket", BASKET_ITEMS_UPDATE_OPERATION]);
  assert.deepEqual(result.outcomes.map(({ action }) => action), ["topped-up", "added"]);
  assert.equal(responses.length, 0);
});

test("top-up-only adapter rereads before one update and aborts on observed drift", async () => {
  const topUpLine = [lines[0]];
  const responses = [
    { status: 200, json: { data: { basket: snapshot([{ id: 111111, quantity: 1 }]) } } },
    { status: 200, json: { data: { basket: snapshot([{ id: 111111, quantity: 1 }]) } } },
    {
      status: 200,
      json: {
        data: {
          basketItemsUpdate: {
            result: snapshot([{ id: 111111, quantity: 2 }]),
          },
        },
      },
    },
  ];
  const operations = [];
  const page = {
    url: () => "https://www.ah.be/mijnlijst",
    evaluate: async (_fn, input) => {
      operations.push(input.body.operationName);
      return responses.shift();
    },
  };
  const adapter = createBasketGraphqlAdapter(page, topUpLine);
  await adapter.read();
  let dispatches = 0;
  const result = await adapter.applyExactBatch(
    [{ url: lines[0].url, quantity: 2 }],
    () => {
      dispatches += 1;
    },
  );
  assert.equal(dispatches, 1);
  assert.deepEqual(operations, ["basket", "basket", BASKET_ITEMS_UPDATE_OPERATION]);
  assert.deepEqual(result.outcomes.map(({ action }) => action), ["topped-up"]);
  assert.equal(responses.length, 0);
});

test("GraphQL errors stop after one dispatched mutation with no automatic retry", async () => {
  const responses = [
    { status: 200, json: { data: { basket: snapshot() } } },
    { status: 200, json: { errors: [{ message: "not projected" }] } },
  ];
  let calls = 0;
  const page = {
    url: () => "https://www.ah.be/mijnlijst",
    evaluate: async () => {
      calls += 1;
      return responses.shift();
    },
  };
  const adapter = createBasketGraphqlAdapter(page, [lines[1]]);
  await adapter.read();
  let dispatches = 0;
  await assert.rejects(
    () => adapter.applyExactBatch([{ url: lines[1].url, quantity: 1 }], () => (dispatches += 1)),
    (error) => error instanceof BasketError && /GraphQL returned an error/.test(error.message),
  );
  assert.equal(dispatches, 1);
  assert.equal(calls, 2);
});

test("page drift stops before a mutation is reported as dispatched", async () => {
  let currentUrl = "https://www.ah.be/mijnlijst";
  let calls = 0;
  const page = {
    url: () => currentUrl,
    evaluate: async () => {
      calls += 1;
      return { status: 200, json: { data: { basket: snapshot() } } };
    },
  };
  const adapter = createBasketGraphqlAdapter(page, [lines[1]]);
  await adapter.read();
  currentUrl = "https://www.ah.be/zoeken?query=drift";
  let dispatches = 0;
  await assert.rejects(
    () => adapter.applyExactBatch([{ url: lines[1].url, quantity: 1 }], () => (dispatches += 1)),
    /permitted only.*Mijn lijst/,
  );
  assert.equal(dispatches, 0);
  assert.equal(calls, 1);
});
