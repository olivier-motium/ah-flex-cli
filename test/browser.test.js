import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBasketWithAdapter,
  assertAllowedAutomationUrl,
  assertCookiePopupAbsent,
  buildApplyPlan,
  ensureNecessaryCookiePreference,
  extractPdpQuantity,
  findPdpAddButton,
  findPdpPlusButton,
  findVisibleListPlusButton,
  inspectBasketUpdateResponse,
  interpretMemberProbe,
  isAhBasketUpdateResponse,
  isAhCartWriteResponse,
  isAllowedAutomationUrl,
  normalizeProductCandidate,
  normalizeVisibleListRows,
  readGraphqlOperationNames,
  resolveProfileDir,
  verifyAuthenticatedMember,
  visibleFirefoxLaunchOptions,
} from "../src/browser.js";
import { BasketError } from "../src/basket.js";

function actionableBasket() {
  const checkedAt = new Date().toISOString();
  const make = (id, storage, quantity) => ({
    label: `${storage} ${id}`,
    query: id,
    quantity,
    storage,
    uses: ["use one", "use two"],
    selected: {
      name: `Exact ${id}`,
      url: `https://www.ah.be/producten/product/${id}/exact-${id}`,
      product_id: id,
      price_eur: 5,
      pack: "500 g",
      availability: "available",
      checked_at: checkedAt,
    },
  });
  return {
    version: 1,
    region: "be",
    title: "Actionable",
    brief: "Exact products across all storage types",
    items: [make("wi111111", "freezer", 2), make("wi222222", "fresh", 1), make("wi333333", "pantry", 3)],
  };
}

test("current visible-card facts normalize into one paste-ready exact selection", () => {
  const product = normalizeProductCandidate(
    {
      href: "https://www.ah.be/producten/product/wi123456/ah-scharrel-kipfilet",
      name: "AH Scharrel kipfilet naturel, 150 gram €3.49",
      factText: "AH Scharrel kipfilet naturel, 150 gram €3.49",
      text: "AH Scharrel kipfilet naturel 150 gram €3.49 Voeg toe",
      addEnabled: true,
    },
    "2026-07-31T10:00:00.000Z",
  );
  assert.deepEqual(product, {
    name: "AH Scharrel kipfilet naturel",
    url: "https://www.ah.be/producten/product/wi123456/ah-scharrel-kipfilet",
    product_id: "wi123456",
    price_eur: 3.49,
    pack: "150 g",
    unit_price_eur: 23.27,
    unit_price_basis: "kg",
    promotion: null,
    availability: "available",
    checked_at: "2026-07-31T10:00:00.000Z",
  });
  assert.equal(
    normalizeProductCandidate({ href: "https://evil.example/producten/product/wi999999/nope", text: "€0.01 1 g" }),
    null,
  );
});

test("navigation guard allows only bounded AH Belgium pages and hard-blocks checkout", () => {
  assert.equal(isAllowedAutomationUrl("https://www.ah.be/zoeken?query=kip"), true);
  assert.equal(isAllowedAutomationUrl("https://www.ah.be/producten/product/wi123456/kip"), true);
  assert.equal(isAllowedAutomationUrl("https://www.ah.be/mijnlijst"), true);
  assert.equal(isAllowedAutomationUrl("https://www.ah.be/checkout"), false);
  assert.equal(isAllowedAutomationUrl("https://www.ah.nl/mijnlijst"), false);
  assert.equal(isAllowedAutomationUrl("https://evil.example/zoeken"), false);
  assert.throws(() => assertAllowedAutomationUrl("https://www.ah.be/bestellen"), /Blocked browser navigation/);
});

test("visible browser uses stock Firefox in non-headless mode with a quiet dedicated profile", () => {
  const options = visibleFirefoxLaunchOptions();
  assert.equal(options.channel, "moz-firefox");
  assert.equal(options.headless, false);
  assert.equal(options.viewport, null);
  assert.equal(options.firefoxUserPrefs["browser.aboutwelcome.enabled"], false);
  assert.equal(options.firefoxUserPrefs["browser.shell.checkDefaultBrowser"], false);
});

test("the trusted profile fails closed if the consent UI reappears", async () => {
  const page = { locator: () => ({ isVisible: async () => false }) };
  await assertCookiePopupAbsent(page);
  page.locator = () => ({ isVisible: async () => true });
  await assert.rejects(() => assertCookiePopupAbsent(page), /privacy choice reappeared/);
});

test("confirmed automation declines optional cookies when the delayed privacy prompt appears", async () => {
  const waits = [];
  let clicked = false;
  const decline = {
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      clicked = true;
    },
  };
  const declineLocator = { count: async () => 1, nth: () => decline };
  const popup = {
    waitFor: async ({ state }) => {
      waits.push(state);
    },
    locator: () => declineLocator,
    getByRole: () => assert.fail("exact decline control should be preferred"),
  };
  const result = await ensureNecessaryCookiePreference({ locator: () => popup });
  assert.deepEqual(result, { changed: true, choice: "necessary-only" });
  assert.equal(clicked, true);
  assert.deepEqual(waits, ["visible", "hidden"]);

  const absent = await ensureNecessaryCookiePreference({
    locator: () => ({ waitFor: async () => { throw new Error("not visible"); } }),
  });
  assert.deepEqual(absent, { changed: false, choice: null });
});

test("the dedicated profile directory resolves safely and refuses dangerous roots", () => {
  const explicit = resolveProfileDir({ profileDir: "tmp/ah-profile-test" });
  assert.ok(explicit.endsWith("tmp/ah-profile-test"));
  assert.throws(() => resolveProfileDir({ profileDir: "/" }), /Refusing to use/);
  assert.throws(() => resolveProfileDir({ profileDir: "   " }), /non-empty path/);
  const home = process.env.HOME;
  assert.throws(() => resolveProfileDir({ profileDir: home }), /Refusing to use/);
  const previous = process.env.AH_FLEX_PROFILE_DIR;
  try {
    process.env.AH_FLEX_PROFILE_DIR = "tmp/env-ah-profile";
    assert.ok(resolveProfileDir().endsWith("tmp/env-ah-profile"));
    delete process.env.AH_FLEX_PROFILE_DIR;
    assert.ok(resolveProfileDir().includes(".ah-flex"));
  } finally {
    if (previous === undefined) delete process.env.AH_FLEX_PROFILE_DIR;
    else process.env.AH_FLEX_PROFILE_DIR = previous;
  }
});

test("member probe interpretation only accepts a clean authenticated member object", () => {
  const base = { status: 200, jsonObject: true, errorsClear: true, hasMember: true, memberState: "object" };
  assert.equal(interpretMemberProbe(base), true);
  assert.equal(interpretMemberProbe({ ...base, memberState: "null" }), false);
  assert.equal(interpretMemberProbe({ ...base, status: 403 }), false);
  assert.equal(interpretMemberProbe({ ...base, errorsClear: false }), false);
  assert.equal(interpretMemberProbe({ ...base, hasMember: false, memberState: "missing" }), false);
  assert.equal(interpretMemberProbe(null), false);
});

test("live member verification requires an authenticated account session", async () => {
  const memberRequest = { headers: { "content-type": "application/json" }, body: { operationName: "member" } };
  const productUrl = "https://www.ah.be/producten/product/wi111111/exact-wi111111";
  const page = {
    goto: async () => {},
    url: () => productUrl,
    evaluate: async () => ({
      status: 200,
      jsonObject: true,
      errorsClear: true,
      hasMember: true,
      memberState: "object",
    }),
  };
  await verifyAuthenticatedMember(page, memberRequest, productUrl);
  page.evaluate = async () => ({
    status: 200,
    jsonObject: true,
    errorsClear: true,
    hasMember: true,
    memberState: "null",
  });
  await assert.rejects(
    () => verifyAuthenticatedMember(page, memberRequest, productUrl),
    /not authenticated.*session login/,
  );
});

test("PDP quantity extraction ignores blank/action controls and reads one current value", () => {
  assert.equal(
    extractPdpQuantity([
      { tagName: "BUTTON", testId: "pdp-hero-basket-actions-add-to-cart-button", value: "", aria: "Voeg toe" },
      { tagName: "BUTTON", testId: "pdp-hero-basket-actions-increase", value: null, aria: "Verhoog aantal naar 2" },
    ]),
    null,
  );
  assert.equal(
    extractPdpQuantity([
      { tagName: "INPUT", testId: "pdp-hero-basket-actions-quantity", value: "1", aria: "Huidig aantal 1" },
      { tagName: "BUTTON", testId: "pdp-hero-basket-actions-increase", value: "", aria: "Verhoog aantal naar 2" },
      { tagName: "BUTTON", testId: "pdp-hero-basket-actions-decrease", value: "", aria: "Verlaag aantal naar 0" },
    ]),
    1,
  );
});

test("PDP control lookup ignores page-wide recommendation buttons", async () => {
  const emptyLocator = {
    count: async () => 0,
    nth: () => assert.fail("empty locator has no rows"),
    getByRole: () => emptyLocator,
  };
  let pageWideRoleLookups = 0;
  const page = {
    locator: () => emptyLocator,
    getByRole: () => {
      pageWideRoleLookups += 1;
      return {
        count: async () => 1,
        nth: () => ({ isVisible: async () => true }),
      };
    },
  };

  assert.equal(await findPdpAddButton(page), null);
  assert.equal(await findPdpPlusButton(page), null);
  assert.equal(pageWideRoleLookups, 0);
});

test("PDP quantity lookup accepts the current bare Verhoog label inside hero actions", async () => {
  const button = { isVisible: async () => true };
  const oneButton = { count: async () => 1, nth: () => button };
  const empty = { count: async () => 0, nth: () => assert.fail("empty locator has no rows") };
  const hero = {
    getByRole: (_role, { name }) => {
      assert.equal(name.test("Verhoog"), true);
      return oneButton;
    },
  };
  let calls = 0;
  const page = {
    locator: () => {
      calls += 1;
      return calls === 1 ? hero : empty;
    },
  };
  assert.equal(await findPdpPlusButton(page), button);
});

test("Mijn lijst quantity lookup stays scoped to the exact product card", async () => {
  const button = { isVisible: async () => true };
  const oneButton = { count: async () => 1, nth: () => button };
  const empty = { count: async () => 0, nth: () => assert.fail("empty locator has no rows") };
  const container = {
    locator: () => empty,
    getByRole: (_role, { name }) => {
      assert.equal(name.test("Verhoog"), true);
      return oneButton;
    },
  };
  assert.equal(await findVisibleListPlusButton(container), button);
});

test("cart persistence waits only for the browser's same-origin AH GraphQL POST", () => {
  const response = (url, method = "POST", body = { operationName: "ChangeBasket" }) => ({
    url: () => url,
    request: () => ({ method: () => method, postDataJSON: () => body }),
  });
  const cartResponse = response("https://www.ah.be/gql");
  assert.equal(isAhCartWriteResponse(cartResponse), true);
  assert.deepEqual(readGraphqlOperationNames(cartResponse), ["ChangeBasket"]);
  assert.deepEqual(
    readGraphqlOperationNames(response("https://www.ah.be/gql", "POST", [{ operationName: "One" }, { operationName: "Two" }])),
    ["One", "Two"],
  );
  assert.equal(isAhCartWriteResponse(response("https://www.ah.be/gql", "GET")), false);
  assert.equal(isAhCartWriteResponse(response("https://www.ah.be/events")), false);
  assert.equal(isAhCartWriteResponse(response("https://evil.example/gql")), false);
  assert.equal(isAhCartWriteResponse(null), false);
});

test("basket update inspection exposes only acknowledgement shape and bounded error codes", async () => {
  const summary = await inspectBasketUpdateResponse({
    json: async () => ({
      data: { basketItemsUpdate: { result: null, private: "not projected" } },
      errors: [
        { message: "not projected", extensions: { code: "CONFLICT" } },
        { message: "also not projected" },
      ],
    }),
  });
  assert.deepEqual(summary, {
    hasBasketUpdate: true,
    resultObject: false,
    errorCount: 2,
    errorCodes: ["CONFLICT"],
  });
  assert.equal(JSON.stringify(summary).includes("not projected"), false);
  const updateResponse = {
    url: () => "https://www.ah.be/gql",
    request: () => ({ method: () => "POST" }),
    json: async () => ({ data: { basketItemsUpdate: { result: {} } } }),
  };
  assert.equal(await isAhBasketUpdateResponse(updateResponse), true);
  assert.equal(
    await isAhBasketUpdateResponse({
      ...updateResponse,
      json: async () => ({ data: { basketItemsUpdate: { result: null } } }),
    }),
    true,
  );
  assert.equal(
    await isAhBasketUpdateResponse({ ...updateResponse, json: async () => ({ data: { member: {} } }) }),
    false,
  );
});

test("one Mijn lijst readback maps exact URLs to quantities and rejects ambiguity", () => {
  const lines = [
    {
      url: "https://www.ah.be/producten/product/wi111111/exact-one",
      expected_name: "Exact one",
    },
    {
      url: "https://www.ah.be/producten/product/wi222222/exact-two",
      expected_name: "Exact two",
    },
  ];
  assert.deepEqual(
    normalizeVisibleListRows(
      [
        { href: `${lines[0].url}?source=list`, values: ["2"] },
        { href: lines[0].url, values: ["2"] },
        { href: "https://www.ah.be/producten/product/wi999999/unrelated", values: ["9"] },
      ],
      lines,
    ),
    [{ url: lines[0].url, name: "Exact one", quantity: 2 }],
  );
  assert.throws(
    () => normalizeVisibleListRows([{ href: lines[0].url, values: ["1", "2"] }], lines),
    /ambiguous Mijn lijst quantities: 1, 2/,
  );
  assert.throws(
    () => normalizeVisibleListRows([{ href: lines[0].url, values: [] }], lines),
    /ambiguous Mijn lijst quantities: none/,
  );
});

test("dry-run emits exact URLs and quantities without constructing a browser adapter", () => {
  const plan = buildApplyPlan(actionableBasket());
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.lines.length, 3);
  assert.deepEqual(
    plan.lines.map(({ url, quantity }) => ({ url, quantity })),
    [
      { url: "https://www.ah.be/producten/product/wi111111/exact-wi111111", quantity: 2 },
      { url: "https://www.ah.be/producten/product/wi222222/exact-wi222222", quantity: 1 },
      { url: "https://www.ah.be/producten/product/wi333333/exact-wi333333", quantity: 3 },
    ],
  );
});

test("confirmed orchestration adds exact lines, rereads, and reports honest mismatches", async () => {
  const basket = actionableBasket();
  const rows = [];
  const calls = [];
  const adapter = {
    read: async () => rows.map((row) => ({ ...row })),
    addExact: async (line) => {
      calls.push({ ...line });
      rows.push({ url: line.url, quantity: line.quantity, name: line.expectedName, price_eur: 5 });
    },
  };
  const receipt = await applyBasketWithAdapter(basket, adapter);
  assert.deepEqual(calls.map(({ url, quantity }) => ({ url, quantity })), receipt.actions.map(({ url, quantity }) => ({ url, quantity })));
  assert.ok(receipt.actions.every((row) => row.action === "added"));
  assert.equal(receipt.after.length, 3);
  assert.match(receipt.warnings[0], /not a hard DOM readback predicate/i);

  const mismatchAdapter = {
    readCount: 0,
    async read() {
      this.readCount += 1;
      if (this.readCount === 1) return [];
      return basket.items.map((item, index) => ({
        url: item.selected.url,
        quantity: index === 0 ? 99 : item.quantity,
      }));
    },
    async addExact() {},
  };
  await assert.rejects(
    () => applyBasketWithAdapter(basket, mismatchAdapter),
    (error) => error instanceof BasketError && /readback failed/i.test(error.message) && error.diagnostics[0].code === "READBACK_MISMATCH",
  );

  const driftAdapter = {
    readCount: 0,
    async read() {
      this.readCount += 1;
      if (this.readCount === 1) return [];
      return basket.items.map((item) => ({ url: item.selected.url, quantity: item.quantity, price_eur: 7 }));
    },
    async addExact() {},
  };
  const priceOnlyDrift = await applyBasketWithAdapter(basket, driftAdapter);
  assert.match(priceOnlyDrift.warnings[0], /not a hard DOM readback predicate/i);
});

test("existing exact lines are never silently changed, reduced, or duplicated", async () => {
  const basket = actionableBasket();
  const sameQuantity = {
    read: async () => [
      { url: basket.items[0].selected.url, quantity: 2 },
      { url: basket.items[1].selected.url, quantity: 1 },
      { url: basket.items[2].selected.url, quantity: 3 },
    ],
    addExact: async () => assert.fail("must not mutate an exact line that is already at the requested quantity"),
  };
  const sameReceipt = await applyBasketWithAdapter(basket, sameQuantity);
  assert.ok(sameReceipt.actions.every((row) => row.action === "already-present"));

  const higherAdapter = {
    read: async () => [
      { url: basket.items[0].selected.url, quantity: 5 },
      { url: basket.items[1].selected.url, quantity: 1 },
      { url: basket.items[2].selected.url, quantity: 3 },
    ],
    addExact: async () => assert.fail("must not reduce an exact line the human holds more of"),
  };
  const higherReceipt = await applyBasketWithAdapter(basket, higherAdapter);
  assert.equal(higherReceipt.actions[0].action, "kept-higher");
  assert.equal(higherReceipt.actions[0].observed_quantity, 5);
  assert.match(higherReceipt.warnings[0], /above the requested 2; left untouched/);
});

test("an exact line present below the requested quantity is topped up, not duplicated", async () => {
  const basket = actionableBasket();
  const rows = [{ url: basket.items[0].selected.url, quantity: 1 }];
  const calls = [];
  const adapter = {
    read: async () => rows.map((row) => ({ ...row })),
    addExact: async (line) => {
      calls.push({ ...line });
      const row = rows.find((candidate) => candidate.url === line.url);
      if (row) row.quantity = line.quantity;
      else rows.push({ url: line.url, quantity: line.quantity });
    },
  };
  const receipt = await applyBasketWithAdapter(basket, adapter);
  assert.equal(receipt.actions[0].action, "topped-up");
  assert.equal(receipt.actions[0].from_quantity, 1);
  assert.equal(receipt.actions[0].quantity, 2);
  assert.deepEqual(calls.map(({ url, quantity }) => ({ url, quantity })), [
    { url: basket.items[0].selected.url, quantity: 2 },
    { url: basket.items[1].selected.url, quantity: 1 },
    { url: basket.items[2].selected.url, quantity: 3 },
  ]);
});

test("a later mutation failure carries an honest partial receipt", async () => {
  const basket = actionableBasket();
  let adds = 0;
  const rows = [];
  const adapter = {
    read: async () => rows.map((row) => ({ ...row })),
    addExact: async (line) => {
      adds += 1;
      if (adds === 2) throw new Error("second add failed");
      rows.push({ url: line.url, quantity: line.quantity });
    },
  };
  await assert.rejects(
    () => applyBasketWithAdapter(basket, adapter),
    (error) => {
      assert.equal(error.partialReceipt.complete, false);
      assert.equal(error.partialReceipt.actions[0].action, "added");
      assert.equal(error.partialReceipt.actions[1].action, "attempted");
      assert.equal(error.partialReceipt.observed.length, 0);
      assert.ok(error.diagnostics.some((row) => row.code === "PARTIAL_CART_CHANGE"));
      return true;
    },
  );
});

test("duplicate observations are rejected instead of merged", async () => {
  const basket = actionableBasket();
  const url = basket.items[0].selected.url;
  const adapter = {
    read: async () => [
      { url, quantity: 2 },
      { url, quantity: 0 },
    ],
    addExact: async () => assert.fail("ambiguous preflight must not mutate"),
  };
  await assert.rejects(() => applyBasketWithAdapter(basket, adapter), /Ambiguous duplicate observations/);
});
