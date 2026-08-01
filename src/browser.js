import os from "node:os";
import path from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { firefox } from "playwright-core";
import { assertActionableBasket, assertExactProductUrl, BasketError, calculateUnitPrice } from "./basket.js";
import {
  BASKET_ITEMS_ADD_OPERATION,
  BASKET_ITEMS_UPDATE_OPERATION,
  assertBasketHttpStatus,
  basketCollectionItems,
  buildBasketMutationPlan,
  createBasketItemsAddRequest,
  createBasketItemsUpdateRequest,
  createBasketQueryRequest,
  normalizeBasketGraphqlResponse,
  normalizeRequestedLines,
  parseProductIdFromUrl,
  reconcileTopUpCandidates,
  validateBasketMutationResponse,
} from "./basket-graphql.js";
import { createMemberRequestBody } from "./member-query.js";

const AH_ORIGIN = "https://www.ah.be";
const BLOCKED_PATH = /\/(?:checkout|afrekenen|bestellen|betaling|payment|order)(?:\/|$)/i;
const ALLOWED_PATH = /^(?:\/$|\/zoeken(?:\/|$)|\/producten\/product\/|\/mijnlijst(?:\/|$)|\/mijn(?:\/|$)|\/inloggen(?:\/|$))/;
const DEFAULT_PROFILE_DIR = path.join(".ah-flex", "firefox-profile");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 2_000;
const BASKET_GRAPHQL_TIMEOUT_MS = 15_000;
const MEMBER_GRAPHQL_TIMEOUT_MS = 15_000;
const BASKET_GRAPHQL_MAX_BYTES = 512 * 1024;
const PRIVATE_PROFILE_MODE = 0o700;

const navigationGuards = new WeakMap();

export function resolveProfileDir(options = {}) {
  const candidate = options.profileDir ?? path.join(os.homedir(), DEFAULT_PROFILE_DIR);
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new BasketError("The AH browser profile directory must be a non-empty path");
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
    throw new BasketError(`Refusing to use '${resolved}' as the AH browser profile directory`);
  }
  return resolved;
}

function assertProfileTarget(profileStat, dir) {
  if (profileStat.isSymbolicLink()) {
    throw new BasketError(`Refusing to use final-component symlink '${dir}' as the AH browser profile directory`);
  }
  if (!profileStat.isDirectory()) {
    throw new BasketError(`The AH browser profile path is not a directory: ${dir}`);
  }
  if (typeof process.getuid === "function" && profileStat.uid !== process.getuid()) {
    throw new BasketError(`The AH browser profile directory is not owned by the current user: ${dir}`);
  }
  if ((profileStat.mode & 0o7777) !== PRIVATE_PROFILE_MODE) {
    throw new BasketError(`The existing AH browser profile directory must already have private mode 0700: ${dir}`);
  }
}

export async function ensureProfileDir(options = {}) {
  const dir = resolveProfileDir(options);
  let existing = null;
  try {
    existing = await lstat(dir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing) assertProfileTarget(existing, dir);
  else await mkdir(dir, { recursive: true, mode: PRIVATE_PROFILE_MODE });

  const effective = await lstat(dir);
  assertProfileTarget(effective, dir);
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
  const lines = basket.items.map((item) => ({
    label: item.label,
    url: assertExactProductUrl(item.selected.url),
    quantity: item.quantity,
    expected_name: item.selected.name,
    expected_price_eur: item.selected.price_eur,
  }));
  normalizeRequestedLines(lines);
  return {
    target: `${AH_ORIGIN}/mijnlijst`,
    mode: "dry-run",
    lines,
    warning: "No browser was opened and nothing was changed. Use --confirm-add for visible Mijn lijst changes.",
  };
}

function indexSnapshot(rows) {
  if (!Array.isArray(rows)) throw new BasketError("AH basket readback was malformed");
  const result = new Map();
  for (const row of rows) {
    const url = canonicalProductHref(row.url);
    if (!url) continue;
    if (!Number.isInteger(row.quantity) || row.quantity < 1) {
      throw new BasketError(`Exact product ${url} has an unreadable basket quantity`);
    }
    if (result.has(url)) {
      throw new BasketError(`Ambiguous duplicate observations for exact product ${url}`);
    }
    result.set(url, { ...row, url, name: row.name || "" });
  }
  return result;
}

function readbackMismatches(lines, expectedFinal, rows, label) {
  const observedRows = indexSnapshot(rows);
  const mismatches = [];
  for (const line of lines) {
    const expected = expectedFinal.get(line.url);
    const observed = observedRows.get(line.url);
    if (!observed) {
      mismatches.push(`${line.url}: exact product missing from ${label}`);
    } else if (observed.quantity !== expected) {
      mismatches.push(`${line.url}: expected quantity ${expected}, observed ${observed.quantity}`);
    }
  }
  return mismatches;
}

function rebuildDispatchedAction(action, observed) {
  action.action = "attempted";
  delete action.observed_quantity;
  if (!observed) return;

  action.observed_quantity = observed.quantity;
  if (observed.quantity === action.quantity) {
    action.action = Object.prototype.hasOwnProperty.call(action, "from_quantity") ? "topped-up" : "added";
  } else if (observed.quantity > action.quantity) {
    action.action = "kept-higher";
  }
}

function rebuildUndispatchedAction(action, observed) {
  action.action = "not-attempted";
  delete action.observed_quantity;
  if (!observed) return;

  action.observed_quantity = observed.quantity;
  if (observed.quantity === action.quantity) {
    action.action = "already-present";
  } else if (observed.quantity > action.quantity) {
    action.action = "kept-higher";
  }
}

export async function applyBasketWithAdapter(basket, adapter, options = {}) {
  const plan = buildApplyPlan(basket, options);
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.applyExactBatch !== "function") {
    throw new TypeError("Adapter must provide read() and applyExactBatch() methods");
  }

  let beforeRows = [];
  let afterRows = [];
  let before = new Map();
  const dispatchedIds = new Set();
  const actions = [];
  try {
    beforeRows = await adapter.read();
    before = indexSnapshot(beforeRows);
    const expectedFinal = new Map();
    const warnings = [];
    const changes = [];
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
      const action = { ...line, action: "pending", ...(existing ? { from_quantity: existing.quantity ?? null } : {}) };
      actions.push(action);
      changes.push({
        url: line.url,
        quantity: line.quantity,
        expectedName: line.expected_name,
        currentQuantity: existing?.quantity ?? 0,
      });
      expectedFinal.set(line.url, line.quantity);
    }

    if (changes.length) {
      const changeIds = new Set(changes.map((line) => parseProductIdFromUrl(line.url)));
      const batchResult = await adapter.applyExactBatch(changes, (items, operation) => {
        if (operation !== BASKET_ITEMS_ADD_OPERATION && operation !== BASKET_ITEMS_UPDATE_OPERATION) {
          throw new BasketError("Basket adapter reported an unknown mutation; no request was dispatched");
        }
        if (!Array.isArray(items) || items.length === 0) {
          throw new BasketError("Basket adapter reported an empty mutation; no request was dispatched");
        }
        const ids = items.map((item) =>
          Number.isSafeInteger(item?.id) ? item.id : parseProductIdFromUrl(item?.url),
        );
        if (ids.some((id) => !changeIds.has(id))) {
          throw new BasketError("Basket adapter reported an unreviewed mutation; no request was dispatched");
        }
        for (const id of ids) dispatchedIds.add(id);
      });
      const outcomes = new Map(
        (batchResult?.outcomes ?? [])
          .map((outcome) => [canonicalProductHref(outcome.url), outcome])
          .filter(([url]) => Boolean(url)),
      );
      for (const action of actions) {
        if (action.action !== "pending") continue;
        const outcome = outcomes.get(action.url);
        action.action =
          outcome?.action ??
          (Object.prototype.hasOwnProperty.call(action, "from_quantity") ? "topped-up" : "added");
        if (Number.isInteger(outcome?.observed_quantity)) {
          action.observed_quantity = outcome.observed_quantity;
        }
        if (action.action === "kept-higher" && Number.isInteger(action.observed_quantity)) {
          expectedFinal.set(action.url, action.observed_quantity);
        }
      }
    }

    afterRows = await adapter.read();
    const mismatches = readbackMismatches(plan.lines, expectedFinal, afterRows, "fresh GraphQL basket readback");
    if (mismatches.length) {
      throw new BasketError(
        `Fresh basket readback failed after ${actions.filter((action) => action.action === "added" || action.action === "topped-up").length} cart change(s)`,
        mismatches.map((message) => ({ level: "error", code: "READBACK_MISMATCH", path: "browser", message })),
      );
    }

    let visibleAfter = null;
    if (typeof adapter.readVisible === "function") {
      visibleAfter = await adapter.readVisible();
      const visibleMismatches = readbackMismatches(plan.lines, expectedFinal, visibleAfter, "reloaded visible Mijn lijst");
      if (visibleMismatches.length) {
        throw new BasketError(
          "Reloaded visible Mijn lijst did not match the verified GraphQL basket",
          visibleMismatches.map((message) => ({
            level: "error",
            code: "VISIBLE_READBACK_MISMATCH",
            path: "browser",
            message,
          })),
        );
      }
    }

    return {
      complete: true,
      target: plan.target,
      actions,
      before: [...before.values()],
      after: afterRows,
      ...(visibleAfter ? { visible_after: visibleAfter } : {}),
      warnings: [...warnings, "Current prices are visible for human review but are not a hard DOM readback predicate."],
    };
  } catch (cause) {
    const error =
      cause instanceof BasketError ? cause : new BasketError(cause instanceof Error ? cause.message : String(cause));
    if (dispatchedIds.size) {
      let safeAfterRows = [];
      let safeObserved = null;
      try {
        const candidateRows = await adapter.read();
        const candidateObserved = indexSnapshot(candidateRows);
        afterRows = candidateRows;
        safeAfterRows = candidateRows;
        safeObserved = candidateObserved;
      } catch {
        // Preserve the original failure if a conservative readback is unavailable or malformed.
      }
      for (const action of actions) {
        const id = parseProductIdFromUrl(action.url);
        if (dispatchedIds.has(id)) {
          rebuildDispatchedAction(action, safeObserved?.get(action.url));
          continue;
        }
        if (safeObserved) rebuildUndispatchedAction(action, safeObserved.get(action.url));
        else if (action.action === "pending") action.action = "not-attempted";
      }
      error.partialReceipt = {
        complete: false,
        target: plan.target,
        actions,
        observed: safeAfterRows,
      };
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

export function attachVerifiedReceipt(error, receipt) {
  if (!error || typeof error !== "object") throw new TypeError("A handoff error is required");
  error.verifiedReceipt = receipt;
  error.diagnostics = [
    ...(error.diagnostics ?? []),
    {
      level: "error",
      code: "VERIFIED_CART_HANDOFF_FAILED",
      path: "browser",
      message: "The cart readbacks were verified, but browser handoff cleanup failed",
    },
  ];
  return error;
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
    result = await page.evaluate(
      async ({ headers, body, timeoutMs }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch("/gql", {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
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
        } finally {
          clearTimeout(timeout);
        }
      },
      { ...memberRequest, timeoutMs: MEMBER_GRAPHQL_TIMEOUT_MS },
    );
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

export async function verifyAuthenticatedMember(page, memberRequest, targetUrl) {
  await safeGoto(page, assertAllowedAutomationUrl(targetUrl));
  if (new URL(page.url()).pathname !== "/mijnlijst" || (await readAccessDenied(page))) {
    throw new BasketError("The AH Mijn lijst page is unavailable or denied; no cart action was attempted");
  }
  const result = await probeMemberState(page, memberRequest);
  if (!interpretMemberProbe(result)) {
    throw new BasketError(
      "The saved AH session is not authenticated. Run 'ah-flex session login' once to refresh it; no cart action was attempted",
    );
  }
}

function assertMijnlijstPage(page) {
  let current;
  try {
    current = new URL(page.url());
  } catch {
    throw new BasketError("The authenticated Mijn lijst page is not open; refusing a basket request");
  }
  if (current.origin !== AH_ORIGIN || current.pathname !== "/mijnlijst") {
    throw new BasketError("Basket GraphQL is permitted only from the authenticated AH Belgium Mijn lijst page");
  }
}

async function executeBasketGraphql(page, request, expectedMutation = null, onDispatch = null) {
  assertMijnlijstPage(page);
  if (expectedMutation && typeof onDispatch === "function") onDispatch();
  let result;
  try {
    result = await page.evaluate(
      async ({ headers, body, timeoutMs, maxBytes }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch("/gql", {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          const text = await response.text();
          if (new TextEncoder().encode(text).byteLength > maxBytes) {
            return { status: response.status, tooLarge: true, json: null };
          }
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // A non-JSON body cannot acknowledge or prove basket state.
          }
          return { status: response.status, tooLarge: false, json };
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        headers: request.headers,
        body: request.body,
        timeoutMs: BASKET_GRAPHQL_TIMEOUT_MS,
        maxBytes: BASKET_GRAPHQL_MAX_BYTES,
      },
    );
  } catch {
    throw new BasketError("AH basket GraphQL request did not complete; cart state is unverified");
  }
  assertBasketHttpStatus(result?.status);
  if (result.tooLarge || !result.json) {
    throw new BasketError("AH basket GraphQL response was not bounded JSON; cart state is unverified");
  }
  return expectedMutation
    ? validateBasketMutationResponse(result.json, expectedMutation)
    : normalizeBasketGraphqlResponse(result.json);
}

export async function readBasketGql(page) {
  return executeBasketGraphql(page, createBasketQueryRequest());
}

async function addBasketItemsGql(page, items, onDispatch) {
  const request = createBasketItemsAddRequest(items);
  return executeBasketGraphql(page, request, BASKET_ITEMS_ADD_OPERATION, () =>
    onDispatch(items, BASKET_ITEMS_ADD_OPERATION),
  );
}

async function updateBasketItemsGql(page, items, onDispatch) {
  const request = createBasketItemsUpdateRequest(items);
  return executeBasketGraphql(page, request, BASKET_ITEMS_UPDATE_OPERATION, () =>
    onDispatch(items, BASKET_ITEMS_UPDATE_OPERATION),
  );
}

function snapshotRows(snapshot, lines) {
  const observed = new Map(basketCollectionItems(snapshot).map((item) => [item.id, item.quantity]));
  return lines
    .filter((line) => observed.has(line.id))
    .map((line) => ({ url: line.url, name: line.expected_name, quantity: observed.get(line.id) }));
}

function assertSameChangeSet(changes, mutationPlan) {
  const requestedIds = new Set(normalizeRequestedLines(changes).map((line) => line.id));
  const plannedIds = new Set([
    ...mutationPlan.addItems.map((item) => item.id),
    ...mutationPlan.topUpCandidates.map((item) => item.id),
  ]);
  if (
    requestedIds.size !== plannedIds.size ||
    [...requestedIds].some((id) => !plannedIds.has(id))
  ) {
    throw new BasketError("Basket changed between preflight and the batch plan; no mutation was dispatched");
  }
}

export function createBasketGraphqlAdapter(page, lines) {
  const requested = normalizeRequestedLines(lines);
  let snapshot = null;
  return {
    async read() {
      snapshot = await readBasketGql(page);
      return snapshotRows(snapshot, requested);
    },
    async applyExactBatch(changes, onDispatch) {
      if (!snapshot) throw new BasketError("Basket batch was requested without a fresh preflight read");
      const initialPlan = buildBasketMutationPlan(requested, snapshot);
      assertSameChangeSet(changes, initialPlan);
      let outcomes = initialPlan.lines.map((line) => ({ ...line }));

      if (initialPlan.addItems.length) {
        await addBasketItemsGql(page, initialPlan.addItems, onDispatch);
        snapshot = await readBasketGql(page);
        const afterAdd = new Map(basketCollectionItems(snapshot).map((item) => [item.id, item.quantity]));
        for (const item of initialPlan.addItems) {
          const observed = afterAdd.get(item.id);
          if (!Number.isInteger(observed) || observed < item.quantity) {
            throw new BasketError("AH did not expose every added exact item in the fresh basket readback");
          }
          const outcome = outcomes.find((line) => line.id === item.id);
          outcome.action = observed === item.quantity ? "added" : "kept-higher";
          outcome.observed_quantity = observed;
        }
      } else if (initialPlan.topUpCandidates.length) {
        // A top-up-only run still rereads immediately before dispatch and
        // aborts when it can observe concurrent quantity drift.
        snapshot = await readBasketGql(page);
      }

      const reconciled = reconcileTopUpCandidates({ ...initialPlan, lines: outcomes }, snapshot);
      outcomes = reconciled.lines;
      if (reconciled.updateItems.length) {
        const updateAcknowledgement = await updateBasketItemsGql(page, reconciled.updateItems, onDispatch);
        const updatedSnapshot = new Map(
          basketCollectionItems(updateAcknowledgement.snapshot).map((item) => [item.id, item.quantity]),
        );
        const updatedIds = new Set(reconciled.updateItems.map((item) => item.id));
        outcomes = outcomes.map((line) => {
          if (!updatedIds.has(line.id)) return line;
          const observed = updatedSnapshot.get(line.id);
          if (!Number.isInteger(observed) || observed < line.quantity) {
            throw new BasketError("AH did not expose every updated exact item in the acknowledged basket snapshot");
          }
          return {
            ...line,
            action: observed === line.quantity ? "topped-up" : "kept-higher",
            observed_quantity: observed,
          };
        });
      }
      return { outcomes };
    },
    async readVisible() {
      assertMijnlijstPage(page);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      assertAllowedAutomationUrl(page.url());
      return readVisibleListStates(page, requested);
    },
  };
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
      "The AH privacy choice reappeared in the trusted profile; run 'ah-flex session login' and redo it there. No basket mutation was attempted",
    );
  }
}

export async function ensureNecessaryCookiePreference(page, options = {}) {
  const popup = page.locator('[data-testid="cookie-popup"]');
  const appeared = await popup
    .waitFor({ state: "visible", timeout: options.timeoutMs ?? 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return { changed: false, choice: null };

  const decline =
    (await firstVisible(popup.locator('[data-testid="decline-cookies"]'))) ??
    (await firstVisible(popup.getByRole("button", { name: /^weigeren$/i })));
  if (!decline || !(await decline.isEnabled())) {
    throw new BasketError(
      "The AH privacy prompt appeared without its necessary-cookies-only choice; no basket mutation was attempted",
    );
  }
  try {
    await decline.click({ timeout: 12_000 });
    await popup.waitFor({ state: "hidden", timeout: 12_000 });
  } catch {
    throw new BasketError(
      "The AH privacy prompt could not be set to necessary cookies only; no basket mutation was attempted",
    );
  }
  return { changed: true, choice: "necessary-only" };
}

export function normalizeVisibleListRows(rawRows, lines) {
  const expected = new Map(
    lines.map((line) => [canonicalProductHref(line.url), line]).filter(([url]) => Boolean(url)),
  );
  const observations = new Map();
  for (const row of rawRows) {
    const url = canonicalProductHref(row.href);
    if (!url || !expected.has(url)) continue;
    const entry = observations.get(url) ?? { quantities: new Set() };
    for (const value of row.values ?? []) {
      if (value === null || value === undefined || String(value).trim() === "") continue;
      const quantity = Number(value);
      if (Number.isInteger(quantity) && quantity >= 1) entry.quantities.add(quantity);
    }
    observations.set(url, entry);
  }

  const rows = [];
  for (const [url, observation] of observations) {
    if (observation.quantities.size !== 1) {
      const detail = observation.quantities.size
        ? [...observation.quantities].sort((a, b) => a - b).join(", ")
        : "none";
      throw new BasketError(`Exact product ${url} has ambiguous Mijn lijst quantities: ${detail}`);
    }
    const line = expected.get(url);
    rows.push({ url, name: line.expected_name, quantity: [...observation.quantities][0] });
  }
  return rows;
}

export async function readVisibleListStates(page, lines) {
  if (new URL(page.url()).pathname !== "/mijnlijst") {
    await safeGoto(page, `${AH_ORIGIN}/mijnlijst`);
  }
  await settle(page, { waitForProducts: true });
  if (await readAccessDenied(page)) throw new BasketError(ACCESS_DENIED_MESSAGE);
  await assertCookiePopupAbsent(page);
  const rawRows = await page.locator('a[href*="/producten/product/"]').evaluateAll((links) =>
    links.map((link) => {
      const container =
        link.closest('article, li, [data-testid*="product"], [data-testhook*="product"]') ?? link.parentElement;
      return {
        href: link.href,
        values: [...(container?.querySelectorAll("input") ?? [])]
          .filter((input) => input.offsetParent !== null)
          .map((input) => input.value),
      };
    }),
  );
  return normalizeVisibleListRows(rawRows, lines);
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
<p style="font-size:20px;line-height:1.5">Your everyday Firefox login does <b>not</b> count here. This dedicated profile needs its own active AH account session.</p>
<p style="margin:32px 0"><a href="https://www.ah.be/inloggen" style="display:inline-block;background:#fff;color:#00a0e4;font-size:24px;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:700">Open ah.be login &rarr;</a></p>
<p style="font-size:16px;line-height:1.5;background:rgba(0,0,0,.18);border-radius:10px;padding:14px 18px">If AH emails you a login link or code: <b>copy the link and paste it into THIS window's address bar</b> (or type the code here). Clicking the link in your mail opens your everyday browser and the login lands there instead.</p>
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
      if (probe.isClosed()) {
        probe = await context.newPage().catch(() => null);
        if (!probe) {
          throw new BasketError(
            "The login window was closed before the session became active; run 'ah-flex session login' again to continue",
          );
        }
      }
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
    let listNavigationError = false;
    try {
      await safeGoto(page, `${AH_ORIGIN}/mijnlijst`);
    } catch {
      listNavigationError = true;
    }
    const listDenied = listNavigationError ? null : await readAccessDenied(page);
    let listUrl = null;
    try {
      const url = new URL(page.url());
      listUrl = url.toString();
    } catch {
      // The page URL remains unusable for the status receipt.
    }
    const listUsable =
      !listNavigationError &&
      !listDenied &&
      (() => {
        try {
          const url = new URL(page.url());
          return url.origin === AH_ORIGIN && url.pathname === "/mijnlijst";
        } catch {
          return false;
        }
      })();
    const memberAuthenticated = !probeError && interpretMemberProbe(probe);
    const state = homeDenied || listDenied
      ? "denied"
      : probeError
        ? "unknown"
        : !memberAuthenticated
          ? "anonymous"
          : listUsable
            ? "authenticated"
            : "unknown";
    return {
      state,
      home: { url: `${AH_ORIGIN}/`, accessDenied: homeDenied },
      memberProbe: probe,
      mijnlijst: { url: listUrl ?? page.url(), accessDenied: listDenied, usable: listUsable },
    };
  } finally {
    await context.close();
  }
}

export async function applyBasketInVisibleBrowser(basket, options = {}) {
  const plan = buildApplyPlan(basket, options);
  const context = await launchAhProfileContext(options);
  let page = null;
  let verifiedReceipt = null;
  try {
    page = await activePage(context);
    const adapter = createBasketGraphqlAdapter(page, plan.lines);
    await verifyAuthenticatedMember(page, createMemberRequest(), plan.target);
    const privacy = await ensureNecessaryCookiePreference(page);
    const receipt = await applyBasketWithAdapter(basket, adapter, options);
    if (privacy.changed) {
      receipt.warnings.unshift("AH privacy prompt declined optional cookies; necessary cookies only.");
    }
    verifiedReceipt = receipt;
    if (new URL(page.url()).pathname !== "/mijnlijst") {
      await safeGoto(page, `${AH_ORIGIN}/mijnlijst`);
    }
    await releaseAutomationGuard(context);
    return { context, page, receipt };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new BasketError(String(cause));
    if (verifiedReceipt && !error.verifiedReceipt) attachVerifiedReceipt(error, verifiedReceipt);
    error.browserContext = context;
    if (page) error.browserPage = page;
    throw error;
  }
}
