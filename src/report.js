import { writeFile } from "node:fs/promises";
import { assertExactProductUrl, calculateUnitPrice, STORAGE_KINDS } from "./basket.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Needs attention";
  return new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(value);
}

function renderDiagnostic(row) {
  return `<li class="${escapeHtml(row.level)}"><strong>${escapeHtml(row.code)}</strong> · ${escapeHtml(
    row.path,
  )}<br>${escapeHtml(row.message)}</li>`;
}

function renderItem(item) {
  const selected = item && typeof item.selected === "object" && item.selected !== null ? item.selected : null;
  const uses = Array.isArray(item?.uses) ? item.uses.filter((use) => typeof use === "string") : [];
  let product = '<p class="attention">Exact product not selected.</p>';
  if (selected) {
    let unitPrice = null;
    let safeProductUrl = null;
    try {
      unitPrice = calculateUnitPrice(selected.price_eur, selected.pack);
    } catch {
      // Validation already surfaces the exact pack problem.
    }
    try {
      safeProductUrl = assertExactProductUrl(selected.url);
    } catch {
      // Invalid URLs remain plain text and cannot become active local-report links.
    }
    const productName = escapeHtml(selected.name);
    product = `
      <p>${safeProductUrl ? `<a href="${escapeHtml(safeProductUrl)}" rel="noreferrer">${productName}</a>` : `${productName} <span class="attention">unsafe product URL</span>`}</p>
      <dl>
        <div><dt>Pack</dt><dd>${escapeHtml(selected.pack)}</dd></div>
        <div><dt>Price</dt><dd>${money(selected.price_eur)}</dd></div>
        <div><dt>Unit price</dt><dd>${unitPrice ? `${money(unitPrice.amount)} / ${escapeHtml(unitPrice.basis)}` : "Needs attention"}</dd></div>
        <div><dt>Availability</dt><dd>${escapeHtml(selected.availability)}</dd></div>
        <div><dt>Checked</dt><dd>${escapeHtml(selected.checked_at)}</dd></div>
        ${selected.promotion ? `<div><dt>Promotion</dt><dd>${escapeHtml(selected.promotion)}</dd></div>` : ""}
      </dl>`;
  }

  return `<article>
    <div class="item-heading"><h3>${escapeHtml(item?.label ?? "Invalid item")}</h3><span>${escapeHtml(item?.quantity ?? "?")} pack${
      item?.quantity === 1 ? "" : "s"
    }</span></div>
    ${product}
    <p><strong>Possible uses:</strong> ${uses.length ? uses.map(escapeHtml).join(" · ") : "Needs attention"}</p>
    ${item?.note ? `<p class="note">${escapeHtml(item.note)}</p>` : ""}
  </article>`;
}

export function renderReview(basket, validation, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const items = Array.isArray(basket?.items)
    ? basket.items.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
  const diagnostics = [...validation.errors, ...validation.warnings];
  const hasAttention = diagnostics.length > 0;
  const storageSections = STORAGE_KINDS.map((storage) => {
    const storageItems = items.filter((item) => item.storage === storage);
    return `<section>
      <h2>${escapeHtml(storage)}</h2>
      ${storageItems.length ? storageItems.map(renderItem).join("\n") : '<p class="attention">No components in this category.</p>'}
    </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(basket.title)} · AH Flex review</title>
  <style>
    :root { color-scheme: light; --ink:#183028; --soft:#f3f6f4; --line:#d8e1dc; --accent:#00754a; --warn:#fff3cd; --error:#ffe4e1; }
    * { box-sizing:border-box; }
    body { margin:0; background:#eef2ef; color:var(--ink); font:16px/1.5 system-ui,-apple-system,sans-serif; }
    main { width:min(960px,calc(100% - 32px)); margin:32px auto 64px; }
    header,section,.diagnostics { background:white; border:1px solid var(--line); border-radius:14px; padding:24px; margin-bottom:18px; }
    h1,h2,h3,p { margin-top:0; }
    h1 { margin-bottom:8px; }
    h2 { text-transform:capitalize; }
    .summary { display:flex; flex-wrap:wrap; gap:12px 24px; color:#41574e; }
    .banner { padding:12px 14px; border-radius:8px; background:${hasAttention ? "var(--warn)" : "#def7e9"}; font-weight:700; }
    article { padding:18px 0; border-top:1px solid var(--line); }
    article:first-of-type { border-top:0; }
    .item-heading { display:flex; justify-content:space-between; gap:16px; }
    .item-heading span { white-space:nowrap; font-weight:700; }
    a { color:var(--accent); }
    dl { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; }
    dl div { background:var(--soft); border-radius:8px; padding:10px; }
    dt { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:#5d7068; }
    dd { margin:3px 0 0; font-weight:650; }
    .note { color:#52635c; }
    .attention,.warning { background:var(--warn); padding:9px 11px; border-radius:7px; }
    .error { background:var(--error); padding:9px 11px; border-radius:7px; }
    li + li { margin-top:8px; }
    footer { color:#5d7068; font-size:13px; text-align:center; }
  </style>
</head>
<body>
<main>
  <header>
    <p class="banner">${hasAttention ? "ATTENTION REQUIRED before browser apply" : "READY for a visible-browser dry run"}</p>
    <h1>${escapeHtml(basket.title)}</h1>
    <p>${escapeHtml(basket.brief)}</p>
    <div class="summary">
      <span>${escapeHtml(validation.facts.total_packs)} packs</span>
      <span>${escapeHtml(validation.facts.selected)}/${escapeHtml(items.length)} selected</span>
      <span>Estimated ${money(validation.facts.estimated_total_eur)}</span>
    </div>
  </header>
  ${
    diagnostics.length
      ? `<aside class="diagnostics"><h2>Attention</h2><ul>${diagnostics.map(renderDiagnostic).join("\n")}</ul></aside>`
      : ""
  }
  ${storageSections}
  <footer>Generated ${escapeHtml(generatedAt)}. Prices and availability remain provisional until the visible AH review. This file cannot order or pay.</footer>
</main>
</body>
</html>`;
}

export async function writeReview(filePath, basket, validation, options) {
  const html = renderReview(basket, validation, options);
  await writeFile(filePath, html, { encoding: "utf8", mode: 0o600 });
  return filePath;
}
