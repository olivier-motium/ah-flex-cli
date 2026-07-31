import { readFile } from "node:fs/promises";

export const STORAGE_KINDS = Object.freeze(["pantry", "freezer", "fresh"]);
export const AVAILABILITY = Object.freeze(["available", "unavailable", "unknown"]);
export const MAX_BASKET_BYTES = 1024 * 1024;
export const DEFAULT_FRESHNESS_HOURS = 48;

export class BasketError extends Error {
  constructor(message, diagnostics = []) {
    super(message);
    this.name = "BasketError";
    this.diagnostics = diagnostics;
  }
}

function issue(level, code, path, message) {
  return { level, code, path, message };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(issue("error", "UNKNOWN_FIELD", `${path}.${key}`, `Unknown field ${key}`));
    }
  }
}

function requireText(value, path, errors, { max = 500, optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(issue("error", "REQUIRED_TEXT", path, "Must be a non-empty string"));
    return;
  }
  if (value.length > max) {
    errors.push(issue("error", "TEXT_TOO_LONG", path, `Must be at most ${max} characters`));
  }
}

export async function loadBasket(filePath) {
  const raw = await readFile(filePath);
  if (raw.byteLength > MAX_BASKET_BYTES) {
    throw new BasketError(`Basket file exceeds ${MAX_BASKET_BYTES} bytes`);
  }

  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new BasketError(`Basket is not valid JSON: ${error.message}`);
  }
}

export function assertExactProductUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BasketError("Selected product URL is not a valid URL");
  }

  if (url.protocol !== "https:" || url.hostname !== "www.ah.be" || url.port !== "") {
    throw new BasketError("Selected product URL must use https://www.ah.be");
  }
  if (!/^\/producten\/product\/wi\d+(?:\/[^/?#]+)?\/?$/.test(url.pathname)) {
    throw new BasketError("Selected product URL must be an exact AH Belgium product page");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new BasketError("Selected product URL may not contain credentials, query parameters, or fragments");
  }
  return url.toString();
}

export function parsePack(pack) {
  if (typeof pack !== "string" || pack.trim() === "") {
    throw new BasketError("Pack must be a non-empty string such as '500 g' or '6 stuks'");
  }

  const normalized = pack.trim().toLowerCase().replace(/,/g, ".");
  if (/\d\s*[x×*]\s*\d/.test(normalized) || /\b(van|à)\s*\d+(?:\.\d+)?\s*(g|kg|ml|l)\b/.test(normalized)) {
    throw new BasketError(`Ambiguous multipack '${pack}'; record a single total pack size instead`);
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(kg|g|l|ml|stuk|stuks|pcs)$/);
  if (!match) {
    throw new BasketError(`Unsupported pack '${pack}'; use g, kg, ml, l, or stuks`);
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BasketError("Pack amount must be greater than zero");
  }

  const unit = match[2];
  if (unit === "g") return { amount: amount / 1000, basis: "kg" };
  if (unit === "kg") return { amount, basis: "kg" };
  if (unit === "ml") return { amount: amount / 1000, basis: "l" };
  if (unit === "l") return { amount, basis: "l" };
  return { amount, basis: "stuk" };
}

export function calculateUnitPrice(priceEur, pack) {
  if (typeof priceEur !== "number" || !Number.isFinite(priceEur) || priceEur <= 0) {
    throw new BasketError("Price must be a positive number");
  }
  const parsed = parsePack(pack);
  return {
    amount: Math.round((priceEur / parsed.amount + Number.EPSILON) * 100) / 100,
    basis: parsed.basis,
  };
}

function validateSelected(selected, path, errors, warnings, now, freshnessHours) {
  if (!isObject(selected)) {
    errors.push(issue("error", "INVALID_SELECTED", path, "Must be an object or null"));
    return null;
  }

  hasOnlyKeys(
    selected,
    new Set([
      "name",
      "url",
      "product_id",
      "price_eur",
      "pack",
      "unit_price_eur",
      "unit_price_basis",
      "promotion",
      "availability",
      "checked_at",
    ]),
    path,
    errors,
  );
  requireText(selected.name, `${path}.name`, errors, { max: 200 });
  requireText(selected.url, `${path}.url`, errors, { max: 500 });
  requireText(selected.pack, `${path}.pack`, errors, { max: 80 });

  let canonicalUrl = null;
  if (typeof selected.url === "string") {
    try {
      canonicalUrl = assertExactProductUrl(selected.url);
    } catch (error) {
      errors.push(issue("error", "UNSAFE_PRODUCT_URL", `${path}.url`, error.message));
    }
  }

  if (selected.product_id !== undefined && !/^wi\d+$/.test(selected.product_id)) {
    errors.push(issue("error", "INVALID_PRODUCT_ID", `${path}.product_id`, "Must look like wi123456"));
  } else if (
    selected.product_id &&
    canonicalUrl &&
    new URL(canonicalUrl).pathname.match(/\/(wi\d+)(?:\/|$)/)?.[1] !== selected.product_id
  ) {
    errors.push(
      issue(
        "error",
        "PRODUCT_ID_MISMATCH",
        `${path}.product_id`,
        "Must match the product ID in the exact selected URL",
      ),
    );
  }
  if (typeof selected.price_eur !== "number" || !Number.isFinite(selected.price_eur) || selected.price_eur <= 0) {
    errors.push(issue("error", "INVALID_PRICE", `${path}.price_eur`, "Must be a positive number"));
  }
  if (!AVAILABILITY.includes(selected.availability)) {
    errors.push(
      issue(
        "error",
        "INVALID_AVAILABILITY",
        `${path}.availability`,
        `Must be one of ${AVAILABILITY.join(", ")}`,
      ),
    );
  } else if (selected.availability !== "available") {
    warnings.push(
      issue(
        "warning",
        "NOT_CONFIRMED_AVAILABLE",
        `${path}.availability`,
        "Product is not confirmed available",
      ),
    );
  }

  let calculated = null;
  if (typeof selected.price_eur === "number" && typeof selected.pack === "string") {
    try {
      calculated = calculateUnitPrice(selected.price_eur, selected.pack);
    } catch (error) {
      errors.push(issue("error", "INVALID_PACK", `${path}.pack`, error.message));
    }
  }

  const hasUnitAmount = selected.unit_price_eur !== undefined;
  const hasUnitBasis = selected.unit_price_basis !== undefined;
  if (hasUnitAmount !== hasUnitBasis) {
    errors.push(
      issue(
        "error",
        "INCOMPLETE_UNIT_PRICE",
        path,
        "unit_price_eur and unit_price_basis must be supplied together",
      ),
    );
  } else if (hasUnitAmount) {
    if (
      typeof selected.unit_price_eur !== "number" ||
      !Number.isFinite(selected.unit_price_eur) ||
      selected.unit_price_eur <= 0
    ) {
      errors.push(issue("error", "INVALID_UNIT_PRICE", `${path}.unit_price_eur`, "Must be a positive number"));
    }
    if (!new Set(["kg", "l", "stuk"]).has(selected.unit_price_basis)) {
      errors.push(
        issue("error", "INVALID_UNIT_BASIS", `${path}.unit_price_basis`, "Must be kg, l, or stuk"),
      );
    }
    if (
      calculated &&
      (selected.unit_price_basis !== calculated.basis ||
        Math.abs(selected.unit_price_eur - calculated.amount) > 0.02)
    ) {
      errors.push(
        issue(
          "error",
          "UNIT_PRICE_MISMATCH",
          path,
          `Recorded unit price does not match €${calculated.amount.toFixed(2)}/${calculated.basis}`,
        ),
      );
    }
  }

  if (selected.promotion !== undefined && selected.promotion !== null && typeof selected.promotion !== "string") {
    errors.push(issue("error", "INVALID_PROMOTION", `${path}.promotion`, "Must be text or null"));
  }

  let checkedAt = null;
  if (typeof selected.checked_at !== "string" || Number.isNaN(Date.parse(selected.checked_at))) {
    errors.push(issue("error", "INVALID_CHECKED_AT", `${path}.checked_at`, "Must be an ISO timestamp"));
  } else {
    checkedAt = new Date(selected.checked_at);
    const ageHours = (now.getTime() - checkedAt.getTime()) / 3_600_000;
    if (ageHours < -1) {
      errors.push(issue("error", "FUTURE_CHECK", `${path}.checked_at`, "Timestamp is in the future"));
    } else if (ageHours > freshnessHours) {
      warnings.push(
        issue(
          "warning",
          "STALE_PRODUCT_FACTS",
          `${path}.checked_at`,
          `Product facts are ${Math.floor(ageHours)} hours old; refresh before applying`,
        ),
      );
    }
  }

  return { canonicalUrl, calculated, checkedAt };
}

export function validateBasket(basket, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const freshnessHours = options.freshnessHours ?? DEFAULT_FRESHNESS_HOURS;
  const errors = [];
  const warnings = [];
  const facts = { total_packs: 0, storage_counts: {}, estimated_total_eur: 0, selected: 0, unresolved: 0 };

  if (!isObject(basket)) {
    return {
      ok: false,
      errors: [issue("error", "INVALID_BASKET", "$", "Basket must be a JSON object")],
      warnings,
      facts,
    };
  }

  hasOnlyKeys(basket, new Set(["$schema", "version", "region", "title", "brief", "items"]), "$", errors);
  if (basket.version !== 1) errors.push(issue("error", "INVALID_VERSION", "$.version", "Must equal 1"));
  if (basket.region !== "be") errors.push(issue("error", "INVALID_REGION", "$.region", "Must equal 'be'"));
  requireText(basket.title, "$.title", errors, { max: 120 });
  requireText(basket.brief, "$.brief", errors, { max: 500 });

  if (!Array.isArray(basket.items) || basket.items.length === 0) {
    errors.push(issue("error", "NO_ITEMS", "$.items", "Must contain at least one item"));
    return { ok: false, errors, warnings, facts };
  }
  if (basket.items.length > 100) {
    errors.push(issue("error", "TOO_MANY_ITEMS", "$.items", "May contain at most 100 items"));
  }

  const seenUrls = new Map();
  for (const [index, item] of basket.items.entries()) {
    const path = `$.items[${index}]`;
    if (!isObject(item)) {
      errors.push(issue("error", "INVALID_ITEM", path, "Must be an object"));
      continue;
    }
    hasOnlyKeys(
      item,
      new Set(["label", "query", "quantity", "storage", "uses", "note", "selected"]),
      path,
      errors,
    );
    requireText(item.label, `${path}.label`, errors, { max: 160 });
    requireText(item.query, `${path}.query`, errors, { max: 160 });
    requireText(item.note, `${path}.note`, errors, { max: 500, optional: true });

    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
      errors.push(issue("error", "INVALID_QUANTITY", `${path}.quantity`, "Must be an integer from 1 to 50"));
    } else {
      facts.total_packs += item.quantity;
    }
    if (!STORAGE_KINDS.includes(item.storage)) {
      errors.push(
        issue("error", "INVALID_STORAGE", `${path}.storage`, `Must be one of ${STORAGE_KINDS.join(", ")}`),
      );
    } else {
      facts.storage_counts[item.storage] = (facts.storage_counts[item.storage] ?? 0) + 1;
    }

    if (!Array.isArray(item.uses) || item.uses.length === 0 || item.uses.some((use) => typeof use !== "string" || !use.trim())) {
      errors.push(issue("error", "INVALID_USES", `${path}.uses`, "Must contain one or more non-empty strings"));
    } else if (item.uses.length < 2) {
      warnings.push(
        issue(
          "warning",
          "LOW_FLEXIBILITY",
          `${path}.uses`,
          "Only one use is listed; reusable components should normally support at least two",
        ),
      );
    }

    if (item.selected === undefined || item.selected === null) {
      facts.unresolved += 1;
      warnings.push(
        issue("warning", "UNRESOLVED_ITEM", `${path}.selected`, "No exact product has been selected yet"),
      );
      continue;
    }

    const selectedFacts = validateSelected(item.selected, `${path}.selected`, errors, warnings, now, freshnessHours);
    facts.selected += 1;
    if (typeof item.quantity === "number" && typeof item.selected.price_eur === "number") {
      facts.estimated_total_eur += item.quantity * item.selected.price_eur;
    }
    if (selectedFacts?.canonicalUrl) {
      if (seenUrls.has(selectedFacts.canonicalUrl)) {
        errors.push(
          issue(
            "error",
            "DUPLICATE_PRODUCT",
            `${path}.selected.url`,
            `Duplicates ${seenUrls.get(selectedFacts.canonicalUrl)}`,
          ),
        );
      } else {
        seenUrls.set(selectedFacts.canonicalUrl, path);
      }
    }
  }

  for (const storage of STORAGE_KINDS) {
    if (!facts.storage_counts[storage]) {
      warnings.push(
        issue(
          "warning",
          "MISSING_STORAGE_MIX",
          "$.items",
          `No ${storage} component is present; check whether the basket still preserves flexibility`,
        ),
      );
    }
  }
  const freshShare = (facts.storage_counts.fresh ?? 0) / basket.items.length;
  if (basket.items.length >= 3 && freshShare > 0.5) {
    warnings.push(
      issue(
        "warning",
        "HIGH_FRESH_SHARE",
        "$.items",
        `${Math.round(freshShare * 100)}% of lines are fresh; check spoilage risk`,
      ),
    );
  }

  facts.estimated_total_eur = Math.round((facts.estimated_total_eur + Number.EPSILON) * 100) / 100;
  return { ok: errors.length === 0, errors, warnings, facts };
}

export function assertActionableBasket(basket, options = {}) {
  const result = validateBasket(basket, options);
  const blockers = [...result.errors];
  for (const warning of result.warnings) {
    if (["UNRESOLVED_ITEM", "NOT_CONFIRMED_AVAILABLE", "STALE_PRODUCT_FACTS"].includes(warning.code)) {
      blockers.push({ ...warning, level: "error", code: `BLOCKED_${warning.code}` });
    }
  }
  if (blockers.length) {
    throw new BasketError("Basket is not safe to apply", blockers);
  }
  return result;
}

export function createTemplate(brief) {
  if (typeof brief !== "string" || !brief.trim()) {
    throw new BasketError("--brief must be a non-empty string");
  }
  return {
    $schema: "./schema/basket.schema.json",
    version: 1,
    region: "be",
    title: "Flexible AH basket",
    brief: brief.trim(),
    items: [
      {
        label: "Bulk or freezer component",
        query: "replace with an AH search phrase",
        quantity: 1,
        storage: "freezer",
        uses: ["quick dinner", "mixed bowl"],
        note: "Select an exact product after comparing pack and unit price.",
        selected: null,
      },
      {
        label: "Fresh component",
        query: "replace with an AH search phrase",
        quantity: 1,
        storage: "fresh",
        uses: ["salad", "side dish"],
        note: "Keep the fresh share small enough to avoid spoilage.",
        selected: null,
      },
      {
        label: "Pantry component",
        query: "replace with an AH search phrase",
        quantity: 1,
        storage: "pantry",
        uses: ["base", "backup meal"],
        selected: null,
      },
    ],
  };
}

export function formatDiagnostics(result) {
  const rows = [...result.errors, ...result.warnings];
  if (!rows.length) return "No errors or warnings.";
  return rows.map((row) => `${row.level.toUpperCase()} ${row.code} ${row.path}: ${row.message}`).join("\n");
}
