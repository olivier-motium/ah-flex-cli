import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBasketWithAdapter,
  assertApplySessionMode,
  assertAllowedAutomationUrl,
  assertCookiePopupAbsent,
  buildApplyPlan,
  extractPdpQuantity,
  findPdpAddButton,
  findPdpPlusButton,
  isAllowedAutomationUrl,
  normalizeConsentCookies,
  normalizeProductCandidate,
  verifyAnonymousMember,
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

test("visible browser uses stock Firefox in non-headless mode", () => {
  const options = visibleFirefoxLaunchOptions();
  assert.equal(options.channel, "moz-firefox");
  assert.equal(options.headless, false);
});

test("confirmed browser apply requires one explicit guest or HAR session mode", () => {
  const harSession = { cookies: [], memberRequest: {} };
  assert.equal(assertApplySessionMode({ sessionMode: "guest" }), "guest");
  assert.equal(assertApplySessionMode({ sessionMode: "har", harSession }), "har");
  assert.throws(() => assertApplySessionMode({}), /exactly one explicit session mode/);
  assert.throws(
    () => assertApplySessionMode({ sessionMode: "guest", harSession }),
    /exactly one explicit session mode/,
  );
  assert.throws(() => assertApplySessionMode({ sessionMode: "har" }), /exactly one explicit session mode/);
});

test("consent bootstrap copies only two bounded AH privacy-choice cookies", () => {
  const cookies = normalizeConsentCookies([
    { name: "_abck", value: "must-not-copy", domain: ".ah.be" },
    { name: "consentSettings", value: "settings", domain: ".ah.be", expires: 99 },
    { name: "consentBeta", value: "beta", path: "/" },
  ]);
  assert.deepEqual(cookies, [
    { name: "consentBeta", value: "beta", url: "https://www.ah.be" },
    { name: "consentSettings", value: "settings", url: "https://www.ah.be" },
  ]);
  assert.throws(() => normalizeConsentCookies(cookies.slice(0, 1)), /required privacy-choice cookies/);
  assert.throws(() => normalizeConsentCookies([...cookies, cookies[0]]), /duplicate consent cookies/);
});

test("the final cart context fails closed if the consent UI reappears", async () => {
  const page = { locator: () => ({ isVisible: async () => false }) };
  await assertCookiePopupAbsent(page);
  page.locator = () => ({ isVisible: async () => true });
  await assert.rejects(() => assertCookiePopupAbsent(page), /privacy choice reappeared/);
});

test("live member verification distinguishes authenticated and explicitly anonymous contexts", async () => {
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
  await assert.rejects(() => verifyAuthenticatedMember(page, memberRequest, productUrl), /not authenticated/);
  await verifyAnonymousMember(page, productUrl);
  page.evaluate = async () => ({
    status: 200,
    jsonObject: true,
    errorsClear: true,
    hasMember: false,
    memberState: "missing",
  });
  await assert.rejects(() => verifyAnonymousMember(page, productUrl), /not provably anonymous/);
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

test("existing exact lines are never silently changed or duplicated", async () => {
  const basket = actionableBasket();
  const adapter = {
    read: async () => [{ url: basket.items[0].selected.url, quantity: 1 }],
    addExact: async () => assert.fail("must not mutate after an existing-quantity conflict"),
  };
  await assert.rejects(() => applyBasketWithAdapter(basket, adapter), /Refusing to change existing/);
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
      assert.equal(error.partialReceipt.observed.length, 1);
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
