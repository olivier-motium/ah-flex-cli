import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBasketWithAdapter,
  assertAllowedAutomationUrl,
  assertCookiePopupAbsent,
  BASKET_ITEMS_ADD_OPERATION,
  buildApplyPlan,
  ensureNecessaryCookiePreference,
  interpretMemberProbe,
  isAllowedAutomationUrl,
  normalizeProductCandidate,
  normalizeVisibleListRows,
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
    applyExactBatch: async (changes, onDispatch) => {
      calls.push(changes.map((line) => ({ ...line })));
      onDispatch(changes, BASKET_ITEMS_ADD_OPERATION);
      for (const line of changes) {
        rows.push({ url: line.url, quantity: line.quantity, name: line.expectedName, price_eur: 5 });
      }
    },
  };
  const receipt = await applyBasketWithAdapter(basket, adapter);
  assert.deepEqual(
    calls[0].map(({ url, quantity }) => ({ url, quantity })),
    receipt.actions.map(({ url, quantity }) => ({ url, quantity })),
  );
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
    async applyExactBatch(_changes, onDispatch) {
      onDispatch(_changes, BASKET_ITEMS_ADD_OPERATION);
    },
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
    async applyExactBatch(_changes, onDispatch) {
      onDispatch(_changes, BASKET_ITEMS_ADD_OPERATION);
    },
  };
  const priceOnlyDrift = await applyBasketWithAdapter(basket, driftAdapter);
  assert.match(priceOnlyDrift.warnings[0], /not a hard DOM readback predicate/i);
});

test("equal lines are not duplicated and higher preflight quantities are left untouched", async () => {
  const basket = actionableBasket();
  const sameQuantity = {
    read: async () => [
      { url: basket.items[0].selected.url, quantity: 2 },
      { url: basket.items[1].selected.url, quantity: 1 },
      { url: basket.items[2].selected.url, quantity: 3 },
    ],
    applyExactBatch: async () => assert.fail("must not mutate an exact line that is already at the requested quantity"),
  };
  const sameReceipt = await applyBasketWithAdapter(basket, sameQuantity);
  assert.ok(sameReceipt.actions.every((row) => row.action === "already-present"));

  const higherAdapter = {
    read: async () => [
      { url: basket.items[0].selected.url, quantity: 5 },
      { url: basket.items[1].selected.url, quantity: 1 },
      { url: basket.items[2].selected.url, quantity: 3 },
    ],
    applyExactBatch: async () => assert.fail("must not reduce an exact line the human holds more of"),
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
    applyExactBatch: async (changes, onDispatch) => {
      calls.push(changes.map((line) => ({ ...line })));
      onDispatch(changes, BASKET_ITEMS_ADD_OPERATION);
      for (const line of changes) {
        const row = rows.find((candidate) => candidate.url === line.url);
        if (row) row.quantity = line.quantity;
        else rows.push({ url: line.url, quantity: line.quantity });
      }
    },
  };
  const receipt = await applyBasketWithAdapter(basket, adapter);
  assert.equal(receipt.actions[0].action, "topped-up");
  assert.equal(receipt.actions[0].from_quantity, 1);
  assert.equal(receipt.actions[0].quantity, 2);
  assert.deepEqual(calls[0].map(({ url, quantity }) => ({ url, quantity })), [
    { url: basket.items[0].selected.url, quantity: 2 },
    { url: basket.items[1].selected.url, quantity: 1 },
    { url: basket.items[2].selected.url, quantity: 3 },
  ]);
});

test("a dispatched batch failure carries an honest readback-backed partial receipt", async () => {
  const basket = actionableBasket();
  const rows = [];
  const adapter = {
    read: async () => rows.map((row) => ({ ...row })),
    applyExactBatch: async (changes, onDispatch) => {
      onDispatch(changes, BASKET_ITEMS_ADD_OPERATION);
      rows.push({ url: changes[0].url, quantity: changes[0].quantity });
      throw new Error("batch acknowledgement failed");
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

test("a failed add batch marks never-dispatched top-ups as not attempted", async () => {
  const basket = actionableBasket();
  const topUpUrl = basket.items[0].selected.url;
  const rows = [{ url: topUpUrl, quantity: 1 }];
  const adapter = {
    read: async () => rows.map((row) => ({ ...row })),
    applyExactBatch: async (changes, onDispatch) => {
      const addItems = changes.filter((line) => line.currentQuantity === 0);
      onDispatch(addItems, BASKET_ITEMS_ADD_OPERATION);
      rows.push({ url: addItems[0].url, quantity: addItems[0].quantity });
      throw new Error("add batch acknowledgement failed before any top-up dispatch");
    },
  };
  await assert.rejects(
    () => applyBasketWithAdapter(basket, adapter),
    (error) => {
      assert.equal(error.partialReceipt.actions[0].action, "not-attempted");
      assert.equal(error.partialReceipt.actions[1].action, "added");
      assert.equal(error.partialReceipt.actions[2].action, "attempted");
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
      { url, quantity: 3 },
    ],
    applyExactBatch: async () => assert.fail("ambiguous preflight must not mutate"),
  };
  await assert.rejects(
    () => applyBasketWithAdapter(basket, adapter),
    (error) => {
      assert.match(error.message, /Ambiguous duplicate observations/);
      assert.equal(error.partialReceipt, undefined);
      return true;
    },
  );
});
