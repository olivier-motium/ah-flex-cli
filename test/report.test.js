import test from "node:test";
import assert from "node:assert/strict";
import { createTemplate, validateBasket } from "../src/basket.js";
import { renderReview } from "../src/report.js";

test("review is self-contained, escapes basket text, and surfaces attention", () => {
  const basket = createTemplate('<img src=x onerror="alert(1)"> chicken');
  basket.title = "Review <script>alert(1)</script>";
  const validation = validateBasket(basket, { now: new Date("2026-07-31T10:00:00.000Z") });
  const html = renderReview(basket, validation, { generatedAt: "2026-07-31T10:00:00.000Z" });

  assert.match(html, /ATTENTION REQUIRED/);
  assert.match(html, /UNRESOLVED_ITEM/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:css|js)/);
  assert.match(html, /cannot order or pay/i);
});

test("invalid product URLs never become active links in a review", () => {
  const basket = createTemplate("unsafe URL test");
  basket.items[0].selected = {
    name: "Bad link",
    url: "javascript:alert(1)",
    price_eur: 1,
    pack: "1 kg",
    availability: "available",
    checked_at: "2026-07-31T10:00:00.000Z",
  };
  const validation = validateBasket(basket, { now: new Date("2026-07-31T10:00:00.000Z") });
  const html = renderReview(basket, validation, { generatedAt: "2026-07-31T10:00:00.000Z" });
  assert.match(html, /unsafe product URL/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /Content-Security-Policy/);
});

test("structurally invalid uses render as attention instead of crashing", () => {
  const basket = createTemplate("invalid shape test");
  basket.items[0].uses = "oops";
  const validation = validateBasket(basket, { now: new Date("2026-07-31T10:00:00.000Z") });
  const html = renderReview(basket, validation, { generatedAt: "2026-07-31T10:00:00.000Z" });
  assert.match(html, /INVALID_USES/);
  assert.match(html, /Possible uses:<\/strong> Needs attention/);
});
