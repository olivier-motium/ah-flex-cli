import test from "node:test";
import assert from "node:assert/strict";
import { calculateUnitPrice, createTemplate, parsePack, validateBasket } from "../src/basket.js";

function selected(id, overrides = {}) {
  return {
    name: `Product ${id}`,
    url: `https://www.ah.be/producten/product/${id}/product-${id}`,
    product_id: id,
    price_eur: 4,
    pack: "500 g",
    availability: "available",
    checked_at: "2026-07-31T09:00:00.000Z",
    ...overrides,
  };
}

test("validation keeps unresolved planning useful but rejects unsafe exact selections", () => {
  const template = createTemplate("chicken and beef, healthy and flexible");
  const planning = validateBasket(template, { now: new Date("2026-07-31T10:00:00.000Z") });
  assert.equal(planning.ok, true);
  assert.equal(planning.facts.unresolved, 3);
  assert.equal(planning.warnings.filter((row) => row.code === "UNRESOLVED_ITEM").length, 3);

  template.items[0].selected = selected("wi123456", {
    url: "https://evil.example/producten/product/wi123456/not-ah",
  });
  const unsafe = validateBasket(template, { now: new Date("2026-07-31T10:00:00.000Z") });
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.errors.some((row) => row.code === "UNSAFE_PRODUCT_URL"));

  template.items[0].selected = selected("wi123456", { product_id: "wi999999" });
  const mismatchedId = validateBasket(template, { now: new Date("2026-07-31T10:00:00.000Z") });
  assert.ok(mismatchedId.errors.some((row) => row.code === "PRODUCT_ID_MISMATCH"));
});

test("unit prices normalize mass, volume, and pieces and refuse ambiguous multipacks", () => {
  assert.deepEqual(calculateUnitPrice(4, "500 g"), { amount: 8, basis: "kg" });
  assert.deepEqual(calculateUnitPrice(3, "1.5 l"), { amount: 2, basis: "l" });
  assert.deepEqual(calculateUnitPrice(6, "12 stuks"), { amount: 0.5, basis: "stuk" });
  assert.deepEqual(parsePack("750 ml"), { amount: 0.75, basis: "l" });
  assert.throws(() => calculateUnitPrice(8, "4 x 250 g"), /Ambiguous multipack/);
});

test("warnings make missing storage balance, low flexibility, freshness, and spoilage visible", () => {
  const basket = {
    version: 1,
    region: "be",
    title: "Fresh-heavy",
    brief: "A deliberately fresh-heavy test basket",
    items: [
      { label: "A", query: "a", quantity: 1, storage: "fresh", uses: ["one"], selected: selected("wi100001") },
      { label: "B", query: "b", quantity: 1, storage: "fresh", uses: ["one", "two"], selected: selected("wi100002") },
      { label: "C", query: "c", quantity: 1, storage: "fresh", uses: ["one", "two"], selected: selected("wi100003") },
      { label: "D", query: "d", quantity: 1, storage: "pantry", uses: ["one", "two"], selected: selected("wi100004") }
    ]
  };
  const result = validateBasket(basket, { now: new Date("2026-08-04T10:00:00.000Z") });
  const codes = new Set(result.warnings.map((row) => row.code));
  assert.equal(result.ok, true);
  assert.ok(codes.has("LOW_FLEXIBILITY"));
  assert.ok(codes.has("MISSING_STORAGE_MIX"));
  assert.ok(codes.has("HIGH_FRESH_SHARE"));
  assert.ok(codes.has("STALE_PRODUCT_FACTS"));
});
