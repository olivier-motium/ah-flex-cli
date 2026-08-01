import os from "node:os";
import path from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import { firefox } from "playwright-core";
import { assertActionableBasket, assertExactProductUrl, BasketError, calculateUnitPrice } from "./basket.js";
import { createMemberRequestBody } from "./member-query.js";

const AH_ORIGIN = "https://www.ah.be";
const BLOCKED_PATH = /\/(?:checkout|afrekenen|bestellen|betaling|payment|order)(?:\/|$)/i;
const ALLOWED_PATH = /^(?:\/$|\/zoeken(?:\/|$)|\/producten\/product\/|\/mijnlijst(?:\/|$)|\/mijn(?:\/|$)|\/inloggen(?:\/|$))/;
const DEFAULT_PROFILE_DIR = path.join(".ah-flex", "firefox-profile");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 2_000;

const navigationGuards = new WeakMap();

export function resolveProfileDir(options = {}) {
  const candidate =
    options.profileDir ?? process.env.AH_FLEX_PROFILE_DIR ?? path.join(os.homedir(), DEFAULT_PROFILE_DIR);
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new BasketError("The AH browser profile directory must be a non-empty path");
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
    throw new BasketError(`Refusing to use '${resolved}' as the AH browser profile directory`);
  }
  return resolved;
}

async function ensureProfileDir(options = {}) {
  const dir = resolveProfileDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

export function isAllowedAutomationUrl(value) {
  if (value === "about:blank") return true;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== AH_ORIGIN || url.username || url.password) return false;
  if (BLOCKED_PATH.test(url.pathname)) return false;
  return ALLOWED_PATH.test(url.pathname);
}

export function assertAllowedAutomationUrl(value) {
  if (!isAllowedAutomationUrl(value)) {
    throw new BasketError(
      `Blocked browser navigation to '${value}'. ah-flex only permits AH Belgium search, product, login, and Mijn lijst pages`,
    );
  }
  return value;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parsePrice(text) {
  const match = text.match(/€\s*(\d{1,4})\s*[,.]\s*(\d{2})\b|\b(\d{1,4})\s*[,.]\s*(\d{2})\s*€/);
  if (!match) return null;
  return Number(`${match[1] ?? match[3]}.${match[2] ?? match[4]}`);
}

function parsePackText(text) {
  if (/\b\d+\s*[x×*]\s*\d+/i.test(text)) return null;
  const match = text.match(
    /\b(\d+(?:[,.]\d+)?)\s*(kilogram(?:men)?|kg|gram|g|milliliter|millilitre|ml|liter|litre|l|stuks?|stuk)\b/i,
  );
  if (!match) return null;
  const aliases = {
    gram: "g",
    kilogram: "kg",
    kilograms: "kg",
    kilogrammen: "kg",
    milliliter: "ml",
    millilitre: "ml",
    liter: "l",
    litre: "l",
  };
  const rawUnit = match[2].toLowerCase();
  return `${match[1].replace(",", ".")} ${aliases[rawUnit] ?? rawUnit}`;
}

function canonicalProductHref(href) {
  try {
    const url = new URL(href, AH_ORIGIN);
    url.search = "";
    url.hash = "";
    return assertExactProductUrl(url.toString());
  } catch {
    return null;
  }
}

function cleanCandidateName(value) {
  const text = normalizeText(value).replace(/^bekijk\s+product\s*/i, "").trim();
  const boundaries = [
    text.search(/\s+€\s*\d/i),
    text.search(/\s+\d+(?:[,.]\d+)?\s*(?:kilogram|kg|gram|g|milliliter|ml|liter|l|stuks?|stuk)\b/i),
  ].filter((index) => index > 0);
  return (boundaries.length ? text.slice(0, Math.min(...boundaries)) : text).replace(/[\s,·-]+$/, "").trim();
}

export function normalizeProductCandidate(raw, checkedAt = new Date().toISOString()) {
  const href = canonicalProductHref(raw.href);
  if (!href) return null;
  const text = normalizeText(raw.text);
  const accessibleFacts = normalizeText(raw.factText);
  const factSource = parsePrice(accessibleFacts) !== null && parsePackText(accessibleFacts) ? accessibleFacts : text;
  const priceEur = parsePrice(factSource);
  const pack = parsePackText(factSource);
  let unitPrice = null;
  try {
    unitPrice = calculateUnitPrice(priceEur, pack);
  } catch {
    // Null facts remain visible and cannot pass actionable-basket validation.
  }
  const unavailable =
    raw.addEnabled === false ||
    /niet\s+(?:beschikbaar|leverbaar)|uitverkocht|alleen\s+in\s+de\s+winkel/i.test(text);
  const available = raw.addEnabled === true || /voeg\s+toe/i.test(text);
  const productId = new URL(href).pathname.match(/\/(wi\d+)(?:\/|$)/)?.[1] ?? null;
  return {
    name: cleanCandidateName(raw.name || text),
    url: href,
    product_id: productId,
    price_eur: priceEur,
    pack,
    ...(unitPrice ? { unit_price_eur: unitPrice.amount, unit_price_basis: unitPrice.basis } : {}),
    promotion: null,
    availability: unavailable ? "unavailable" : available ? "available" : "unknown",
    checked_at: checkedAt,
  };
}

async function readProductCardsFromPage(page) {
  const rawRows = await page.locator('a[href*="/producten/product/"]').evaluateAll((links) =>
    links.map((link) => {
      const container =
        link.closest('[data-testid*="product-card"], [data-testhook*="product"], article, li') ?? link.parentElement;
      const heading = container?.querySelector(
        '[data-testid*="product-title"], [data-testid*="product-name"], h2, h3',
      );
      const buttons = [...(container?.querySelectorAll("button") ?? [])];
      const addButton = buttons.find((button) =>
        /^voeg toe(?: aan (?:je )?(?:winkelmand|boodschappenlijst|lijst))?$/i.test(
          (button.getAttribute("aria-label") || button.textContent || "").trim(),
        ),
      );
      return {
        href: link.href,
        name: (
          heading?.textContent ||
          link.getAttribute("aria-label") ||
          link.getAttribute("title") ||
          link.textContent ||
          ""
        ).trim(),
        factText: (link.getAttribute("aria-label") || link.textContent || "").trim(),
        text: container?.innerText ?? link.textContent ?? "",
        addEnabled: addButton ? !addButton.disabled && addButton.getAttribute("aria-disabled") !== "true" : undefined,
      };
    }),
  );
  const checkedAt = new Date().toISOString();
  const products = [];
  const seen = new Set();
  for (const row of rawRows) {
    const product = normalizeProductCandidate(row, checkedAt);
    if (!product || seen.has(product.url)) continue;
    products.push(product);
    seen.add(product.url);
  }
  return products;
}

export function buildApplyPlan(basket, options = {}) {
  assertActionableBasket(basket, options);
  return {
    target: `${AH_ORIGIN}/mijnlijst`,
    mode: "dry-run",
    lines: basket.items.map((item) => ({
      label: item.label,
      url: assertExactProductUrl(item.selected.url),
      quantity: item.quantity,
      expected_name: item.selected.name,
      expected_price_eur: item.selected.price_eur,
    })),
    warning: "No browser was opened and nothing was changed. Use --confirm-add for visible Mijn lijst changes.",
  };
}

function indexSnapshot(rows) {
  const result = new Map();
  for (const row of rows) {
    const url = canonicalProductHref(row.url);
    if (!url) continue;
    if (result.has(url)) {
      throw new BasketError(`Ambiguous duplicate observations for exact product ${url}`);
    }
    result.set(url, { ...row, url, quantity: row.quantity ?? null, name: row.name || "" });
  }
  return result;
}

export async function applyBasketWithAdapter(basket, adapter, options = {}) {
  const plan = buildApplyPlan(basket, options);
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.addExact !== "function") {
    throw new TypeError("Adapter must provide read() and addExact() methods");
  }

  let beforeRows = [];
  let afterRows = [];
  const actions = [];
  try {
    beforeRows = await adapter.read();
    const before = indexSnapshot(beforeRows);
    const expectedFinal = new Map();
    const warnings = [];
    for (const line of plan.lines) {
      const existing = before.get(line.url);
      if (existing) {
        if (Number.isInteger(existing.quantity) && existing.quantity > line.quantity) {
          actions.push({ ...line, action: "kept-higher", observed_quantity: existing.quantity });
          expectedFinal.set(line.url, existing.quantity);
          warnings.push(
            `${line.url}: cart already holds quantity ${existing.quantity}, above the requested ${line.quantity}; left untouched`,
          );
          continue;
        }
        if (existing.quantity === line.quantity) {
          actions.push({ ...line, action: "already-present" });
          expectedFinal.set(line.url, line.quantity);
          continue;
        }
      }
      const action = { ...line, action: "attempted", ...(existing ? { from_quantity: existing.quantity ?? null } : {}) };
      actions.push(action);
      await adapter.addExact({ url: line.url, quantity: line.quantity, expectedName: line.expected_name });
      action.action = existing ? "topped-up" : "added";
      expectedFinal.set(line.url, line.quantity);
    }

    afterRows = await adapter.read();
    const after = indexSnapshot(afterRows);
    const mismatches = [];
    for (const line of plan.lines) {
      const expected = expectedFinal.get(line.url) ?? line.quantity;
      const observed = after.get(line.url);
      if (!observed) {
        mismatches.push(`${line.url}: exact product missing after apply`);
      } else if (observed.quantity !== expected) {
        mismatches.push(
          `${line.url}: expected quantity ${expected}, observed ${observed.quantity ?? "unreadable"}`,
        );
      }
    }
    if (mismatches.length) {
      throw new BasketError(
        `Visible-cart readback failed after ${actions.filter((action) => action.action === "added" || action.action === "topped-up").length} cart change(s)`,
        mismatches.map((message) => ({ level: "error", code: "READBACK_MISMATCH", path: "browser", message })),
      );
    }

    return {
      target: plan.target,
      actions,
      before: [...before.values()],
      after: afterRows,
      warnings: [...warnings, "Current prices are visible for human review but are not a hard DOM readback predicate."],
    };
  } catch (cause) {
    if (!afterRows.length && actions.some((action) => action.action === "attempted" || action.action === "added")) {
      try {
        afterRows = await adapter.read();
      } catch {
        // The attempted lines below remain the authoritative partial-change warning.
      }
    }
    const error =
      cause instanceof BasketError ? cause : new BasketError(cause instanceof Error ? cause.message : String(cause));
    error.partialReceipt = {
      complete: false,
      target: plan.target,
      actions,
      observed: afterRows,
    };
    if (actions.some((action) => action.action === "attempted" || action.action === "added")) {
      error.diagnostics = [
        ...(error.diagnostics ?? []),
        {
          level: "error",
          code: "PARTIAL_CART_CHANGE",
          path: "browser",
          message: "One or more exact lines may already have changed; inspect the attached partial receipt and visible cart",
        },
      ];
    }
    throw error;
  }
}

async function installNavigationGuard(context) {
  const navigationGuard = async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      const target = request.url();
      if (!isAllowedAutomationUrl(target)) {
        await route.abort("blockedbyclient");
        return;
      }
    }
    await route.continue();
  };
  await context.route("**/*", navigationGuard);
  navigationGuards.set(context, navigationGuard);
}

export async function launchAhProfileContext(options = {}) {
  const profileDir = await ensureProfileDir(options);
  const context = await firefox.launchPersistentContext(profileDir, visibleFirefoxLaunchOptions());
  try {
    if (options.guarded !== false) await installNavigationGuard(context);
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function closeVisibleAhBrowser(context) {
  await context.close();
}

export async function releaseAutomationGuard(context) {
  const navigationGuard = navigationGuards.get(context);
  if (!navigationGuard) return;
  await context.unroute("**/*", navigationGuard);
  navigationGuards.delete(context);
}

export function visibleFirefoxLaunchOptions() {
  return {
    channel: "moz-firefox",
    headless: false,
    viewport: null,
    acceptDownloads: false,
    firefoxUserPrefs: {
      "browser.aboutwelcome.enabled": false,
      "trailhead.firstrun.didSeeAboutWelcome": true,
      "browser.shell.checkDefaultBrowser": false,
      "datareporting.policy.dataSubmissionEnabled": false,
    },
  };
}

async function activePage(context) {
  const pages = context.pages();
  return pages[0] ?? context.newPage();
}

async function safeGoto(page, value) {
  assertAllowedAutomationUrl(value);
  await page.goto(value, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assertAllowedAutomationUrl(page.url());
}

export function createMemberRequest() {
  return { headers: { "content-type": "application/json" }, body: createMemberRequestBody() };
}

async function probeMemberState(page, memberRequest) {
  let result;
  try {
    result = await page.evaluate(async ({ headers, body }) => {
      const response = await fetch("/gql", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body),
      });
      let json = null;
      try {
        json = await response.json();
      } catch {
        // Non-JSON responses cannot prove authentication.
      }
      const jsonObject = Boolean(json && typeof json === "object" && !Array.isArray(json));
      const hasErrors = jsonObject && Object.prototype.hasOwnProperty.call(json, "errors");
      const errorsClear = !hasErrors || (Array.isArray(json.errors) && json.errors.length === 0);
      const dataObject = Boolean(jsonObject && json.data && typeof json.data === "object" && !Array.isArray(json.data));
      const hasMember = dataObject && Object.prototype.hasOwnProperty.call(json.data, "member");
      const member = hasMember ? json.data.member : undefined;
      const memberState =
        member === null
          ? "null"
          : member && typeof member === "object" && !Array.isArray(member)
            ? "object"
            : hasMember
              ? "other"
              : "missing";
      return { status: response.status, jsonObject, errorsClear, hasMember, memberState };
    }, memberRequest);
  } catch {
    throw new BasketError("The live AH member state could not be verified; no cart action was attempted");
  }
  return result;
}

export function interpretMemberProbe(result) {
  return Boolean(
    result &&
      result.status === 200 &&
      result.jsonObject &&
      result.errorsClear &&
      result.hasMember &&
      result.memberState === "object",
  );
}

export async function verifyAuthenticatedMember(page, memberRequest, productUrl) {
  await safeGoto(page, assertExactProductUrl(productUrl));
  const result = await probeMemberState(page, memberRequest);
  if (!interpretMemberProbe(result)) {
    throw new BasketError(
      "The saved AH session is not authenticated. Run 'ah-flex session login' once to refresh it; no cart action was attempted",
    );
  }
}

async function settle(page, options = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  if (options.waitForProducts) {
    await page.locator('a[href*="/producten/product/"]').first().waitFor({ state: "attached", timeout: 12_000 }).catch(() => {});
  }
}

async function readAccessDenied(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /access\s+denied|toegang\s+geweigerd/i.test(bodyText);
}

const ACCESS_DENIED_MESSAGE =
  "AH denied this browser session. Stop rather than retrying automatically; run 'ah-flex session login' to refresh the trusted profile or try again later";

export async function searchProducts(query, options = {}) {
  if (typeof query !== "string" || !query.trim()) throw new BasketError("Search query must be non-empty");
  const limit = Math.min(Math.max(Number(options.limit ?? 8), 1), 25);
  const context = await launchAhProfileContext(options);
  try {
    const page = await activePage(context);
    const target = `${AH_ORIGIN}/zoeken?query=${encodeURIComponent(query.trim())}`;
    await safeGoto(page, target);
    await settle(page, { waitForProducts: true });
    if (await readAccessDenied(page)) {
      throw new BasketError(ACCESS_DENIED_MESSAGE);
    }
    const products = (await readProductCardsFromPage(page)).slice(0, limit);
    if (!products.length) {
      throw new BasketError(
        "No exact product cards could be read. AH may require login/region selection, or its visible UI may have changed",
      );
    }
    const unreadable = products.filter(
      (product) =>
        !product.name ||
        typeof product.price_eur !== "number" ||
        !product.pack ||
        !product.unit_price_basis ||
        product.availability === "unknown",
    );
    if (unreadable.length) {
      throw new BasketError(
        `AH search UI facts were incomplete for ${unreadable.length} of ${products.length} candidate(s); refusing a false-success result`,
        unreadable.map((product) => ({
          level: "error",
          code: "UNREADABLE_PRODUCT_CARD",
          path: product.url,
          message: "Name, price, pack/unit price, or availability could not be read",
        })),
      );
    }
    return products;
  } finally {
    await closeVisibleAhBrowser(context);
  }
}

async function firstVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  return null;
}

export async function assertCookiePopupAbsent(page) {
  const popup = page.locator('[data-testid="cookie-popup"]');
  if (await popup.isVisible().catch(() => false)) {
    throw new BasketError(
      "The AH privacy choice reappeared in the trusted profile; run 'ah-flex session login' and redo it there. No cart click was attempted",
    );
  }
}

const PDP_HERO_ACTIONS =
  '[data-testid^="pdp-hero-basket-actions"], [data-testhook^="pdp-hero-basket-actions"]';

export async function findPdpAddButton(page) {
  const exact = await firstVisible(
    page.locator(
      '[data-testid="pdp-hero-basket-actions-add-to-cart-button"], [data-testhook="pdp-hero-basket-actions-add-to-cart-button"]',
    ),
  );
  if (exact) return exact;
  return firstVisible(
    page
      .locator(PDP_HERO_ACTIONS)
      .getByRole("button", { name: /^voeg toe(?: aan (?:je )?(?:winkelmand|boodschappenlijst|lijst))?$/i }),
  );
}

export function extractPdpQuantity(controls) {
  const observed = new Set();
  for (const control of controls) {
    const tag = String(control.tagName ?? "").toLowerCase();
    const testId = String(control.testId ?? "");
    const aria = String(control.aria ?? "");
    const roleText = `${tag} ${testId} ${aria}`.toLowerCase();
    const isAction =
      tag === "button" ||
      /increase|decrease|increment|decrement|plus|minus|add|remove|verhoog|verlaag/.test(roleText);
    const isInput = tag === "input";
    const isCurrentDisplay = !isAction && /quantity|aantal/.test(roleText);
    if (!isInput && !isCurrentDisplay) continue;

    const candidates = isInput
      ? [control.value]
      : [String(control.text ?? "").match(/^\s*(\d+)\s*$/)?.[1], aria.match(/(?:huidig|aantal)\D*(\d+)/i)?.[1]];
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined || String(candidate).trim() === "") continue;
      const quantity = Number(candidate);
      if (Number.isInteger(quantity) && quantity >= 0) observed.add(quantity);
    }
  }
  if (observed.size > 1) {
    throw new BasketError(`Ambiguous product-page quantity controls: ${[...observed].join(", ")}`);
  }
  return observed.size === 1 ? [...observed][0] : null;
}

async function readPdpQuantity(page) {
  const controls = page.locator(
    [
      '[data-testid^="pdp-hero-basket-actions"] input',
      '[data-testid^="pdp-hero-basket-actions"] [data-testid*="quantity"]',
      '[data-testid^="pdp-hero-basket-actions"][data-testid*="quantity"]',
      '[data-testid^="pdp-hero-basket-actions"] [aria-label*="aantal" i]',
      '[data-testhook^="pdp-hero-basket-actions"] input',
      '[data-testhook^="pdp-hero-basket-actions"] [data-testid*="quantity"]',
    ].join(", "),
  );
  const rawControls = [];
  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    rawControls.push({
      tagName: await control.evaluate((node) => node.tagName),
      testId: (await control.getAttribute("data-testid")) ?? "",
      aria: (await control.getAttribute("aria-label")) ?? "",
      text: await control.innerText().catch(() => ""),
      value: await control.inputValue().catch(() => null),
    });
  }
  return extractPdpQuantity(rawControls);
}

async function waitForPdpQuantity(page, expected, url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let observed = null;
    try {
      observed = await readPdpQuantity(page);
    } catch {
      // Transient duplicate controls can exist while the basket widget rerenders.
    }
    if (observed === expected) return;
    if (Number.isInteger(observed) && observed > expected) {
      throw new BasketError(`Exact product ${url} advanced past quantity ${expected} to ${observed}`);
    }
    if (attempt < 79) await page.waitForTimeout(100);
  }
  throw new BasketError(`Exact product ${url} did not reach visible quantity ${expected}`);
}

async function gotoExactProduct(page, url) {
  const exactUrl = assertExactProductUrl(url);
  if (new URL(page.url()).pathname !== new URL(exactUrl).pathname) {
    await safeGoto(page, exactUrl);
  }
  if (new URL(page.url()).pathname !== new URL(exactUrl).pathname) {
    throw new BasketError(`Exact product navigation drifted from ${exactUrl} to ${page.url()}`);
  }
  if (await readAccessDenied(page)) {
    throw new BasketError(ACCESS_DENIED_MESSAGE);
  }
  return exactUrl;
}

async function readExactProductStates(page, lines) {
  const rows = [];
  for (const line of lines) {
    const url = await gotoExactProduct(page, line.url);
    const quantity = await readPdpQuantity(page);
    if (Number.isInteger(quantity) && quantity >= 1) {
      rows.push({ url, name: line.expected_name, quantity });
      continue;
    }
    const addButton = await findPdpAddButton(page);
    if (addButton) {
      if (!(await addButton.isEnabled())) {
        throw new BasketError(`Exact product ${url} is not currently addable`);
      }
      continue;
    }
    throw new BasketError(
      `Exact product ${url} has no scoped add button and no readable product-page quantity; refusing ambiguous cart state`,
    );
  }
  return rows;
}

export async function findPdpPlusButton(page) {
  const hero = page.locator(PDP_HERO_ACTIONS);
  return (
    (await firstVisible(
      page.locator(
        '[data-testid^="pdp-hero-basket-actions"][data-testid*="increase"], [data-testid^="pdp-hero-basket-actions"][data-testid*="plus"], [data-testhook^="pdp-hero-basket-actions"][data-testhook*="increase"], [data-testhook^="pdp-hero-basket-actions"][data-testhook*="plus"]',
      ),
    )) ??
    (await firstVisible(
      hero.getByRole("button", { name: /^(?:verhoog(?: het)? aantal.*|plus|voeg (?:nog )?één toe|\+)$/i }),
    ))
  );
}

async function addExactToVisibleList(page, line) {
  const url = await gotoExactProduct(page, line.url);
  await assertCookiePopupAbsent(page);
  let currentQuantity = await readPdpQuantity(page);
  if (Number.isInteger(currentQuantity) && currentQuantity > line.quantity) {
    throw new BasketError(
      `Exact product ${url} is already at quantity ${currentQuantity}, above the requested ${line.quantity}; refusing to reduce`,
    );
  }
  if (currentQuantity === line.quantity) {
    throw new BasketError(
      `Exact product ${url} is already at the requested quantity ${line.quantity}; refusing a duplicate add`,
    );
  }
  if (!Number.isInteger(currentQuantity) || currentQuantity < 1) {
    const addButton = await findPdpAddButton(page);
    if (!addButton) {
      throw new BasketError(
        `Exact product ${url} has no scoped add button and no readable quantity; refusing an ambiguous add`,
      );
    }
    if (!(await addButton.isEnabled())) throw new BasketError(`Exact product ${url} is not currently addable`);
    try {
      await addButton.click({ timeout: 12_000 });
    } catch {
      throw new BasketError(`The scoped add control for exact product ${url} could not be clicked`);
    }
    assertAllowedAutomationUrl(page.url());
    await waitForPdpQuantity(page, 1, url);
    currentQuantity = 1;
  }

  while (currentQuantity < line.quantity) {
    const plus = await findPdpPlusButton(page);
    if (!plus) throw new BasketError(`Quantity control for exact product ${url} could not be read`);
    try {
      await plus.click({ timeout: 12_000 });
    } catch {
      throw new BasketError(`The quantity control for exact product ${url} could not be clicked`);
    }
    assertAllowedAutomationUrl(page.url());
    await waitForPdpQuantity(page, currentQuantity + 1, url);
    currentQuantity += 1;
  }
}

async function ensureAhOriginPage(page) {
  let onAh = false;
  try {
    onAh = new URL(page.url()).origin === AH_ORIGIN;
  } catch {
    onAh = false;
  }
  if (!onAh) {
    await page.goto(`${AH_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  }
}

const LOGIN_LANDING_HTML = `<!doctype html>
<meta charset="utf-8">
<title>ah-flex login window</title>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#00a0e4;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="max-width:660px;text-align:center;padding:24px">
<h1 style="font-size:34px;margin:0 0 16px">This is the ah-flex window</h1>
<p style="font-size:20px;line-height:1.5">Your everyday Firefox login does <b>not</b> count here. This fresh, empty profile needs its own one-time AH account login.</p>
<p style="margin:32px 0"><a href="https://www.ah.be/inloggen" style="display:inline-block;background:#fff;color:#00a0e4;font-size:24px;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:700">Open ah.be login &rarr;</a></p>
<p style="font-size:14px;opacity:.85">ah-flex watches until the account session is active, then closes this window. It never sees your credentials.</p>
</div>`;

export async function runInteractiveLogin(options = {}) {
  const context = await launchAhProfileContext({ ...options, guarded: false });
  const memberRequest = createMemberRequest();
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? LOGIN_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    const page = await activePage(context);
    await page
      .goto(`data:text/html;charset=utf-8,${encodeURIComponent(LOGIN_LANDING_HTML)}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      })
      .catch(() => {});
    let probe = await context.newPage();
    let announced = false;
    for (;;) {
      if (probe.isClosed()) probe = await context.newPage();
      await ensureAhOriginPage(probe);
      const result = await probeMemberState(probe, memberRequest).catch(() => null);
      if (interpretMemberProbe(result)) {
        return { context, page };
      }
      if (Date.now() >= deadline) {
        throw new BasketError(
          "Login was not completed in time. The dedicated profile keeps whatever was done; run 'ah-flex session login' again to finish",
        );
      }
      if (!announced) {
        announced = true;
        options.onStatus?.("waiting");
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export async function sessionStatus(options = {}) {
  const context = await launchAhProfileContext(options);
  try {
    const page = await activePage(context);
    await safeGoto(page, `${AH_ORIGIN}/`);
    const homeDenied = await readAccessDenied(page);
    let probe = null;
    let probeError = false;
    try {
      probe = await probeMemberState(page, createMemberRequest());
    } catch {
      probeError = true;
    }
    await safeGoto(page, `${AH_ORIGIN}/mijnlijst`).catch(() => {});
    const listDenied = await readAccessDenied(page);
    const state = homeDenied
      ? "denied"
      : probeError
        ? "unknown"
        : interpretMemberProbe(probe)
          ? "authenticated"
          : "anonymous";
    return {
      state,
      home: { url: `${AH_ORIGIN}/`, accessDenied: homeDenied },
      memberProbe: probe,
      mijnlijst: { url: page.url(), accessDenied: listDenied },
    };
  } finally {
    await context.close();
  }
}

export async function applyBasketInVisibleBrowser(basket, options = {}) {
  const plan = buildApplyPlan(basket, options);
  const context = await launchAhProfileContext(options);
  const page = await activePage(context);
  const adapter = {
    read: () => readExactProductStates(page, plan.lines),
    addExact: (line) => addExactToVisibleList(page, line),
  };
  try {
    await verifyAuthenticatedMember(page, createMemberRequest(), plan.lines[0].url);
    const receipt = await applyBasketWithAdapter(basket, adapter, options);
    await safeGoto(page, `${AH_ORIGIN}/mijnlijst`);
    await releaseAutomationGuard(context);
    return { context, page, receipt };
  } catch (error) {
    error.browserContext = context;
    error.browserPage = page;
    throw error;
  }
}
