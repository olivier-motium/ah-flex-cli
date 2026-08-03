import { BasketError } from "./basket.js";
import {
  BASKET_ITEMS_ADD_OPERATION,
  BASKET_ITEMS_UPDATE_OPERATION,
  basketCollectionItems,
  buildBasketMutationPlan,
  createBasketItemsAddRequest,
  createBasketItemsUpdateRequest,
  createBasketQueryRequest,
  normalizeBasketGraphqlResponse,
  normalizeRequestedLines,
  reconcileTopUpCandidates,
  validateBasketMutationResponse,
} from "./basket-graphql.js";
import { countUnreadable, mapSearchProduct } from "./search-rsc.js";

export const MOBILE_API_ORIGIN = "https://api.ah.be";
export const MOBILE_API_BASE_URL = MOBILE_API_ORIGIN;

export const MOBILE_API_ENDPOINTS = Object.freeze({
  graphql: "/graphql",
  productSearch: "/mobile-services/product/search/v2",
});

export const DEFAULT_MOBILE_TIMEOUT_MS = 15_000;
export const DEFAULT_MOBILE_MAX_BYTES = 512 * 1024;

// Keep the replaceable mobile application identity in one place. Belgian live
// verification can change this object at the integration boundary without
// spreading app-version literals through request code.
export const DEFAULT_MOBILE_APP_IDENTITY = Object.freeze({
  application: "appie",
  version: "8.22.3",
  userAgent: "Appie/8.22.3",
  headers: Object.freeze({ "User-Agent": "Appie/8.22.3" }),
});

export const DEFAULT_MOBILE_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-Require-Member": "true",
  "User-Agent": DEFAULT_MOBILE_APP_IDENTITY.userAgent,
});

export class MobileApiError extends BasketError {
  constructor(message, diagnostics = []) {
    super(message, diagnostics);
    this.name = "MobileApiError";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyHeaderSet(target, source) {
  if (!source) return;
  if (typeof source.forEach === "function" && typeof source.get === "function") {
    source.forEach((value, key) => setHeader(target, key, value));
    return;
  }
  if (!isObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) setHeader(target, key, value);
  }
}

function setHeader(target, key, value) {
  for (const existing of Object.keys(target)) {
    if (existing.toLowerCase() === key.toLowerCase()) delete target[existing];
  }
  target[key] = String(value);
}

function headersForIdentity(identity) {
  const headers = {};
  if (!isObject(identity)) return headers;
  copyHeaderSet(headers, identity.headers);
  if (typeof identity.userAgent === "string" && identity.userAgent.trim()) {
    setHeader(headers, "User-Agent", identity.userAgent);
  }
  return headers;
}

function assertAccessToken(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new MobileApiError("An access token provider did not return a usable token");
  }
  return value;
}

async function resolveAccessToken(source) {
  let value;
  try {
    value = typeof source === "function" ? await source() : source;
  } catch {
    throw new MobileApiError("The AH mobile API access-token provider failed");
  }
  if (isObject(value) && typeof value.access_token === "string") value = value.access_token;
  return assertAccessToken(value);
}

export function buildMobileHeaders({ accessToken, token, identity = DEFAULT_MOBILE_APP_IDENTITY, headers } = {}) {
  const bearer = assertAccessToken(accessToken ?? token);
  const result = {};
  copyHeaderSet(result, DEFAULT_MOBILE_HEADERS);
  copyHeaderSet(result, headersForIdentity(identity));
  copyHeaderSet(result, headers);
  setHeader(result, "Authorization", `Bearer ${bearer}`);
  // These are safety properties, not caller-overridable identity hints.
  setHeader(result, "X-Require-Member", "true");
  setHeader(result, "Accept", "application/json");
  return result;
}

export function assertMobileApiUrl(value) {
  let url;
  try {
    url = new URL(value, MOBILE_API_ORIGIN);
  } catch {
    throw new MobileApiError("AH mobile API request URL was malformed");
  }
  if (
    url.origin !== MOBILE_API_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith("/")
  ) {
    throw new MobileApiError(`AH mobile API requests are locked to ${MOBILE_API_ORIGIN}`);
  }
  return url;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  if (!isObject(headers)) return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function chunkBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new MobileApiError("AH mobile API response body was unreadable");
}

async function readBoundedText(response, maxBytes, path) {
  const contentLength = headerValue(response.headers, "content-length");
  if (contentLength !== null && contentLength !== "") {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maxBytes) {
      throw new MobileApiError(`AH mobile API response for ${path} exceeded the ${maxBytes}-byte limit`);
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = chunkBytes(part.value);
        total += bytes.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new MobileApiError(`AH mobile API response for ${path} exceeded the ${maxBytes}-byte limit`);
        }
        text += decoder.decode(bytes, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      if (error instanceof MobileApiError) throw error;
      throw new MobileApiError(`AH mobile API response for ${path} could not be read`);
    }
  }

  if (typeof response.text !== "function") {
    throw new MobileApiError(`AH mobile API response for ${path} had no readable body`);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new MobileApiError(`AH mobile API response for ${path} could not be read`);
  }
  if (typeof text !== "string") {
    throw new MobileApiError(`AH mobile API response for ${path} was not text`);
  }
  if (byteLength(text) > maxBytes) {
    throw new MobileApiError(`AH mobile API response for ${path} exceeded the ${maxBytes}-byte limit`);
  }
  return text;
}

async function parseJsonResponse(response, target, maxBytes) {
  if (!response || typeof response !== "object") {
    throw new MobileApiError("AH mobile API did not return a response");
  }
  const finalUrl = typeof response.url === "string" && response.url ? response.url : target;
  if (response.redirected === true || response.type === "opaqueredirect") {
    throw new MobileApiError("AH mobile API redirects are rejected");
  }
  let final;
  try {
    final = new URL(finalUrl);
  } catch {
    throw new MobileApiError("AH mobile API returned an invalid response URL");
  }
  if (final.origin !== MOBILE_API_ORIGIN || final.href !== target) {
    throw new MobileApiError(`AH mobile API redirected away from ${MOBILE_API_ORIGIN}`);
  }
  if (Number(response.status) >= 300 && Number(response.status) < 400) {
    throw new MobileApiError("AH mobile API redirects are rejected");
  }
  if (response.status !== 200) {
    throw new MobileApiError(`AH mobile API returned HTTP ${String(response.status)}`);
  }
  if (!isJsonContentType(headerValue(response.headers, "content-type"))) {
    throw new MobileApiError("AH mobile API returned a non-JSON response");
  }
  const text = await readBoundedText(response, maxBytes, new URL(target).pathname);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new MobileApiError("AH mobile API returned invalid JSON");
  }
  if (!isObject(payload)) {
    throw new MobileApiError("AH mobile API returned the wrong JSON envelope");
  }
  return payload;
}

function assertPositiveOption(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive`);
  return Math.ceil(value);
}

function normalizeTokenSource(options) {
  const source = options.getAccessToken ?? options.accessTokenProvider ?? options.accessToken ?? options.token;
  if (source === undefined) {
    throw new TypeError("An injected access-token provider is required");
  }
  if (typeof source !== "function" && typeof source !== "string" && !isObject(source)) {
    throw new TypeError("The injected access-token provider must be a function or token value");
  }
  return source;
}

function responseProductRows(payload) {
  const arrays = [
    payload.products,
    payload._embedded?.products,
    payload.data?.products,
    payload.items,
    ...(Array.isArray(payload.cards) ? payload.cards.map((card) => card?.products) : []),
  ].filter(Array.isArray);
  if (!arrays.length) throw new MobileApiError("AH mobile product search returned the wrong JSON envelope");
  return arrays.flat();
}

function mobileWebPath(raw) {
  const candidate = raw?.webPath ?? raw?.productUrl ?? raw?.url ?? raw?.link;
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  try {
    const url = new URL(candidate, "https://www.ah.be");
    if (url.origin !== "https://www.ah.be") return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function numericPrice(raw) {
  const candidates = [
    raw?.priceV2?.now?.amount,
    raw?.price?.now?.amount,
    raw?.price?.now,
    raw?.price?.amount,
    raw?.price,
  ];
  return candidates.find((value) => typeof value === "number" && Number.isFinite(value)) ?? null;
}

function mobileSearchRow(raw) {
  if (!isObject(raw)) return null;
  const product = isObject(raw.product) ? raw.product : raw;
  const availability = product.availability ?? raw.availability ?? {
    isOrderable: product.isOrderable ?? raw.isOrderable,
    availabilityLabel: product.availabilityLabel ?? raw.availabilityLabel,
  };
  const priceLabels = product.priceV2?.promotionLabels ?? product.price?.promotionLabels ?? raw.promotionLabels;
  const promotionLabels = Array.isArray(priceLabels)
    ? priceLabels
    : typeof product.promotion === "string" || typeof raw.promotion === "string"
      ? [{ topText: product.promotion ?? raw.promotion }]
      : undefined;
  return {
    webPath: mobileWebPath(product) ?? mobileWebPath(raw),
    title: product.title ?? product.name ?? raw.title ?? raw.name ?? "",
    priceV2: {
      now: { amount: numericPrice(product) ?? numericPrice(raw) },
      ...(promotionLabels ? { promotionLabels } : {}),
    },
    salesUnitSize:
      product.salesUnitSize ?? product.unitSize ?? product.packageSize ?? raw.salesUnitSize ?? raw.unitSize ?? null,
    availability,
  };
}

function snapshotRows(snapshot, lines) {
  const observed = new Map(basketCollectionItems(snapshot).map((item) => [item.id, item.quantity]));
  return lines
    .filter((line) => observed.has(line.id))
    .map((line) => ({ url: line.url, name: line.expected_name ?? line.name ?? "", quantity: observed.get(line.id) }));
}

function assertSameChangeSet(changes, mutationPlan) {
  const requestedIds = new Set(normalizeRequestedLines(changes).map((line) => line.id));
  const plannedIds = new Set([
    ...mutationPlan.addItems.map((item) => item.id),
    ...mutationPlan.topUpCandidates.map((item) => item.id),
  ]);
  if (requestedIds.size !== plannedIds.size || [...requestedIds].some((id) => !plannedIds.has(id))) {
    throw new BasketError("Basket changed between preflight and the batch plan; no mutation was dispatched");
  }
}

export class MobileApiClient {
  constructor(options = {}) {
    if (!isObject(options)) throw new TypeError("Mobile API client options must be an object");
    if (typeof options.fetchImpl !== "function") throw new TypeError("An injected fetch implementation is required");
    this.fetchImpl = options.fetchImpl;
    this.accessTokenSource = normalizeTokenSource(options);
    this.identity = { ...DEFAULT_MOBILE_APP_IDENTITY, ...(options.identity ?? options.appIdentity ?? {}) };
    this.timeoutMs = assertPositiveOption(Number(options.timeoutMs ?? DEFAULT_MOBILE_TIMEOUT_MS), "timeoutMs");
    this.maxBytes = assertPositiveOption(Number(options.maxBytes ?? DEFAULT_MOBILE_MAX_BYTES), "maxBytes");
  }

  async requestJson(path, options = {}) {
    const url = assertMobileApiUrl(path);
    const method = String(options.method ?? "GET").toUpperCase();
    const accessToken = await resolveAccessToken(this.accessTokenSource);
    const headers = buildMobileHeaders({
      accessToken,
      identity: this.identity,
      headers: options.headers,
    });
    const init = { method, headers, redirect: "error" };
    if (options.body !== undefined) {
      try {
        init.body = JSON.stringify(options.body);
      } catch {
        throw new MobileApiError("AH mobile API request body was not JSON-serializable");
      }
      setHeader(init.headers, "Content-Type", "application/json");
    }

    const controller = new AbortController();
    let externalAbort;
    if (options.signal) {
      externalAbort = () => controller.abort();
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", externalAbort, { once: true });
    }

    let timeoutId;
    let timedOut = false;
    let response;
    const fetchPromise = Promise.resolve().then(() => this.fetchImpl(url.href, { ...init, signal: controller.signal }));
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new MobileApiError(`AH mobile API request to ${url.pathname} timed out`));
      }, this.timeoutMs);
    });
    try {
      response = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error) {
      if (timedOut) throw error;
      if (options.signal?.aborted) throw new MobileApiError(`AH mobile API request to ${url.pathname} was aborted`);
      throw new MobileApiError(`AH mobile API request to ${url.pathname} failed`);
    } finally {
      clearTimeout(timeoutId);
      if (options.signal && externalAbort) options.signal.removeEventListener("abort", externalAbort);
    }
    return parseJsonResponse(response, url.href, this.maxBytes);
  }

  async graphql(request) {
    if (!isObject(request)) throw new MobileApiError("AH mobile GraphQL request was malformed");
    const body = isObject(request.body) ? request.body : request;
    return this.requestJson(MOBILE_API_ENDPOINTS.graphql, {
      method: "POST",
      headers: request.headers,
      body,
    });
  }

  async readBasket() {
    return normalizeBasketGraphqlResponse(await this.graphql(createBasketQueryRequest()));
  }

  async addBasketItems(items) {
    return validateBasketMutationResponse(
      await this.graphql(createBasketItemsAddRequest(items)),
      BASKET_ITEMS_ADD_OPERATION,
    );
  }

  async updateBasketItems(items) {
    return validateBasketMutationResponse(
      await this.graphql(createBasketItemsUpdateRequest(items)),
      BASKET_ITEMS_UPDATE_OPERATION,
    );
  }

  async searchProducts(query, options = {}) {
    if (typeof query !== "string" || !query.trim()) throw new MobileApiError("Search query must be non-empty");
    const limit = Math.min(Math.max(Number(options.limit ?? 8), 1), 25);
    const url = new URL(MOBILE_API_ENDPOINTS.productSearch, MOBILE_API_ORIGIN);
    url.searchParams.set("query", query.trim());
    url.searchParams.set("sortOn", String(options.sortOn ?? "RELEVANCE"));
    if (options.page !== undefined) url.searchParams.set("page", String(options.page));
    if (options.size !== undefined) url.searchParams.set("size", String(options.size));
    if (options.application !== undefined) url.searchParams.set("application", String(options.application));

    const payload = await this.requestJson(`${url.pathname}${url.search}`, { method: "GET" });
    const checkedAt = options.checkedAt ?? new Date().toISOString();
    const products = [];
    const seen = new Set();
    for (const raw of responseProductRows(payload)) {
      const product = mapSearchProduct(mobileSearchRow(raw), checkedAt);
      if (!product || seen.has(product.url)) continue;
      products.push(product);
      seen.add(product.url);
    }
    const limited = products.slice(0, limit);
    if (!limited.length) throw new MobileApiError("No usable products were present in the AH mobile search response");
    if (countUnreadable(limited) === limited.length) {
      throw new MobileApiError("Every product in the AH mobile search response had unreadable facts");
    }
    return limited;
  }
}

export function createMobileApiClient(options) {
  return new MobileApiClient(options);
}

export function createMobileBasketAdapter(client, lines) {
  if (
    !client ||
    typeof client.readBasket !== "function" ||
    typeof client.addBasketItems !== "function" ||
    typeof client.updateBasketItems !== "function"
  ) {
    throw new TypeError("Mobile basket adapter requires readBasket(), addBasketItems(), and updateBasketItems()");
  }
  const requested = normalizeRequestedLines(lines);
  let snapshot = null;
  return {
    async read() {
      snapshot = await client.readBasket();
      return snapshotRows(snapshot, requested);
    },
    async applyExactBatch(changes, onDispatch) {
      if (!snapshot) throw new BasketError("Basket batch was requested without a fresh preflight read");
      const initialPlan = buildBasketMutationPlan(requested, snapshot);
      assertSameChangeSet(changes, initialPlan);
      let outcomes = initialPlan.lines.map((line) => ({ ...line }));

      if (initialPlan.addItems.length) {
        if (typeof onDispatch === "function") onDispatch(initialPlan.addItems, BASKET_ITEMS_ADD_OPERATION);
        await client.addBasketItems(initialPlan.addItems);
        snapshot = await client.readBasket();
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
        snapshot = await client.readBasket();
      }

      const reconciled = reconcileTopUpCandidates({ ...initialPlan, lines: outcomes }, snapshot);
      outcomes = reconciled.lines;
      if (reconciled.updateItems.length) {
        if (typeof onDispatch === "function") onDispatch(reconciled.updateItems, BASKET_ITEMS_UPDATE_OPERATION);
        const acknowledgement = await client.updateBasketItems(reconciled.updateItems);
        const updatedSnapshot = new Map(
          basketCollectionItems(acknowledgement.snapshot).map((item) => [item.id, item.quantity]),
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
  };
}
