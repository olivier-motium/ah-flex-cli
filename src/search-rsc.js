import { BasketError, calculateUnitPrice } from "./basket.js";
import { AH_ORIGIN, fetchAhDocument } from "./http-ah.js";

const NEXT_F_CHUNK = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

export function decodeNextFPayloads(html) {
  let decoded = "";
  for (const match of html.matchAll(NEXT_F_CHUNK)) {
    try {
      decoded += JSON.parse(`"${match[1]}"`);
    } catch {
      // A single undecodable chunk must not discard the rest of the payload.
    }
  }
  return decoded;
}

function matchArrayEnd(text, openIndex) {
  if (text[openIndex] !== "[") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function extractProductArrays(decoded) {
  const arrays = [];
  let searchFrom = 0;
  for (;;) {
    const keyIndex = decoded.indexOf('"products":[', searchFrom);
    if (keyIndex === -1) return arrays;
    const openIndex = keyIndex + '"products":'.length;
    const closeIndex = matchArrayEnd(decoded, openIndex);
    if (closeIndex === -1) {
      searchFrom = openIndex + 1;
      continue;
    }
    try {
      const parsed = JSON.parse(decoded.slice(openIndex, closeIndex + 1));
      if (Array.isArray(parsed)) arrays.push(parsed);
    } catch {
      // Skip malformed slices; later arrays may still parse.
    }
    searchFrom = closeIndex + 1;
  }
}

const UNIT_ALIASES = {
  kilogram: "kg",
  kg: "kg",
  gram: "g",
  g: "g",
  milliliter: "ml",
  ml: "ml",
  liter: "l",
  l: "l",
  stuk: "stuks",
  stuks: "stuks",
};

export function normalizeSalesUnitSize(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let text = value.trim().toLowerCase().replace(/,/g, ".").replace(/^ca\.\s*/, "");
  // Multipacks such as "2 flessen van 355 ml" or "6 x 33 cl" are ambiguous:
  // the per-piece measure is not the pack size, so the pack stays unreadable.
  // (The visible-card parser cannot be reused here: it would grab the first
  // bare measure and mis-read "355 ml" as the pack.)
  if (/[x×]/.test(text) || /\bvan\b/.test(text)) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(kilogram|kg|gram|g|milliliter|ml|liter|l|cl|stuk|stuks)\b/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (match[2] === "cl") return `${amount * 10} ml`;
  return `${amount} ${UNIT_ALIASES[match[2]]}`;
}

function promotionText(labels) {
  if (!Array.isArray(labels)) return null;
  const parts = labels
    .map((label) => [label?.topText, label?.centerText, label?.bottomText].filter(Boolean).join(" "))
    .filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

export function mapSearchProduct(raw, checkedAt = new Date().toISOString()) {
  const webPath = typeof raw?.webPath === "string" ? raw.webPath.split(/[?#]/)[0] : null;
  if (!webPath || !webPath.startsWith("/producten/product/wi")) return null;
  const priceEur = typeof raw.priceV2?.now?.amount === "number" ? raw.priceV2.now.amount : null;
  const pack = normalizeSalesUnitSize(raw.salesUnitSize);
  let unitPrice = null;
  try {
    unitPrice = calculateUnitPrice(priceEur, pack);
  } catch {
    // Null facts stay visible and cannot pass actionable-basket validation.
  }
  const availabilityLabel = raw.availability?.availabilityLabel;
  const unavailable =
    raw.availability?.isOrderable === false ||
    /niet\s+(?:beschikbaar|leverbaar)|uitverkocht|alleen\s+in\s+de\s+winkel/i.test(availabilityLabel ?? "");
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim() : "";
  return {
    name: title,
    url: `${AH_ORIGIN}${webPath}`,
    product_id: webPath.match(/\/(wi\d+)(?:\/|$)/)?.[1] ?? null,
    price_eur: priceEur,
    pack,
    ...(unitPrice ? { unit_price_eur: unitPrice.amount, unit_price_basis: unitPrice.basis } : {}),
    promotion: promotionText(raw.priceV2?.promotionLabels),
    availability: unavailable ? "unavailable" : "available",
    checked_at: checkedAt,
  };
}

export function parseSearchResponse(html, checkedAt = new Date().toISOString()) {
  const decoded = decodeNextFPayloads(html);
  const products = [];
  const seen = new Set();
  for (const array of extractProductArrays(decoded)) {
    for (const raw of array) {
      const product = mapSearchProduct(raw, checkedAt);
      if (!product || seen.has(product.url)) continue;
      products.push(product);
      seen.add(product.url);
    }
  }
  return products;
}

export function countUnreadable(products) {
  return products.filter(
    (product) => !product.name || typeof product.price_eur !== "number" || !product.pack || !product.unit_price_basis,
  ).length;
}

export async function searchProductsHttp(query, options = {}) {
  if (typeof query !== "string" || !query.trim()) throw new BasketError("Search query must be non-empty");
  const limit = Math.min(Math.max(Number(options.limit ?? 8), 1), 25);
  const { html } = await fetchAhDocument(`/zoeken?query=${encodeURIComponent(query.trim())}`, options);
  const products = parseSearchResponse(html).slice(0, limit);
  if (!products.length) {
    throw new BasketError(
      "No products could be read from the AH search response. The site structure may have changed; inspect before retrying",
    );
  }
  if (countUnreadable(products) === products.length) {
    throw new BasketError(
      "Every product in the AH search response had unreadable facts; refusing a false-success result",
    );
  }
  return products;
}
