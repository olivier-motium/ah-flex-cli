import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { assertActionableBasket, assertExactProductUrl, BasketError, calculateUnitPrice } from "./basket.js";

const AH_ORIGIN = "https://www.ah.be";
const BLOCKED_PATH = /\/(?:checkout|afrekenen|bestellen|betaling|payment|order)(?:\/|$)/i;
const ALLOWED_PATH = /^(?:\/$|\/zoeken(?:\/|$)|\/producten\/product\/|\/mijnlijst(?:\/|$)|\/mijn(?:\/|$)|\/inloggen(?:\/|$))/;

const DEFAULT_BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const navigationGuards = new WeakMap();

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
    for (const line of plan.lines) {
      const existing = before.get(line.url);
      if (existing) {
        if (existing.quantity !== line.quantity) {
          throw new BasketError(
            `Refusing to change existing ${line.url}: current quantity ${existing.quantity ?? "unreadable"}, requested ${line.quantity}`,
          );
        }
        actions.push({ ...line, action: "already-present" });
        continue;
      }
      const action = { ...line, action: "attempted" };
      actions.push(action);
      await adapter.addExact({ url: line.url, quantity: line.quantity, expectedName: line.expected_name });
      action.action = "added";
    }

    afterRows = await adapter.read();
    const after = indexSnapshot(afterRows);
    const mismatches = [];
    for (const line of plan.lines) {
      const observed = after.get(line.url);
      if (!observed) {
        mismatches.push(`${line.url}: exact product missing after apply`);
      } else if (observed.quantity !== line.quantity) {
        mismatches.push(
          `${line.url}: expected quantity ${line.quantity}, observed ${observed.quantity ?? "unreadable"}`,
        );
      }
    }
    if (mismatches.length) {
      throw new BasketError(
        `Visible-cart readback failed after ${actions.filter((action) => action.action === "added").length} add(s)`,
        mismatches.map((message) => ({ level: "error", code: "READBACK_MISMATCH", path: "browser", message })),
      );
    }

    return {
      target: plan.target,
      actions,
      before: [...before.values()],
      after: afterRows,
      warnings: ["Current prices are visible for human review but are not a hard DOM readback predicate."],
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

async function findBrowserExecutable(explicitPath) {
  const candidates = [explicitPath, process.env.AH_FLEX_BROWSER, ...DEFAULT_BROWSER_PATHS].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next local browser without printing filesystem details.
    }
  }
  throw new BasketError(
    "No supported Chromium browser was found. Install Chrome/Chromium or set AH_FLEX_BROWSER to its executable path",
  );
}

export async function launchVisibleAhBrowser(options = {}) {
  const executablePath = await findBrowserExecutable(options.executablePath);
  const profileDir =
    options.profileDir ?? path.join(os.homedir(), "Library", "Application Support", "ah-flex-cli", "browser-profile");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    viewport: null,
    acceptDownloads: false,
  });

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
  return context;
}

export async function releaseAutomationGuard(context) {
  const navigationGuard = navigationGuards.get(context);
  if (!navigationGuard) return;
  await context.unroute("**/*", navigationGuard);
  navigationGuards.delete(context);
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

async function settle(page, options = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  if (options.waitForProducts) {
    await page.locator('a[href*="/producten/product/"]').first().waitFor({ state: "attached", timeout: 12_000 }).catch(() => {});
  }
}

export async function searchProducts(query, options = {}) {
  if (typeof query !== "string" || !query.trim()) throw new BasketError("Search query must be non-empty");
  const limit = Math.min(Math.max(Number(options.limit ?? 8), 1), 25);
  const context = await launchVisibleAhBrowser(options);
  try {
    const page = await activePage(context);
    const target = `${AH_ORIGIN}/zoeken?query=${encodeURIComponent(query.trim())}`;
    await safeGoto(page, target);
    await settle(page, { waitForProducts: true });
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/access\s+denied|toegang\s+geweigerd/i.test(bodyText)) {
      throw new BasketError(
        "AH denied this browser session. Stop rather than retrying automatically; use the visible site manually or try again later",
      );
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
    await context.close();
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

async function gotoExactProduct(page, url) {
  const exactUrl = assertExactProductUrl(url);
  await safeGoto(page, exactUrl);
  if (new URL(page.url()).pathname !== new URL(exactUrl).pathname) {
    throw new BasketError(`Exact product navigation drifted from ${exactUrl} to ${page.url()}`);
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/access\s+denied|toegang\s+geweigerd/i.test(bodyText)) {
    throw new BasketError("AH denied the visible browser session; stop rather than retrying automatically");
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
  const existingQuantity = await readPdpQuantity(page);
  if (Number.isInteger(existingQuantity) && existingQuantity >= 1) {
    throw new BasketError(`Exact product ${url} is already present; refusing a duplicate add`);
  }
  const addButton = await findPdpAddButton(page);
  if (!addButton) {
    throw new BasketError(
      `Exact product ${url} is already present or has unreadable controls; refusing a duplicate add`,
    );
  }
  if (!(await addButton.isEnabled())) throw new BasketError(`Exact product ${url} is not currently addable`);
  await addButton.click();
  assertAllowedAutomationUrl(page.url());
  await addButton.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {
    throw new BasketError(`No visible cart-state transition was observed after adding exact product ${url}`);
  });

  if (line.quantity > 1) {
    const plus = await findPdpPlusButton(page);
    if (!plus) throw new BasketError(`Quantity control for exact product ${url} could not be read`);
    for (let currentQuantity = 1; currentQuantity < line.quantity; currentQuantity += 1) {
      await plus.click();
      assertAllowedAutomationUrl(page.url());
    }
  }
}

export async function openLoginSession(options = {}) {
  const context = await launchVisibleAhBrowser(options);
  try {
    const page = await activePage(context);
    await safeGoto(page, `${AH_ORIGIN}/mijnlijst`);
    await releaseAutomationGuard(context);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function applyBasketInVisibleBrowser(basket, options = {}) {
  const plan = buildApplyPlan(basket, options);
  const context = await launchVisibleAhBrowser(options);
  const page = await activePage(context);
  const adapter = {
    read: () => readExactProductStates(page, plan.lines),
    addExact: (line) => addExactToVisibleList(page, line),
  };
  try {
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
