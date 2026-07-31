#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  BasketError,
  createTemplate,
  formatDiagnostics,
  loadBasket,
  validateBasket,
} from "./basket.js";
import {
  applyBasketInVisibleBrowser,
  buildApplyPlan,
  closeVisibleAhBrowser,
  openLoginSession,
} from "./browser.js";
import { loadAhHarSession } from "./har-session.js";
import { searchProducts, TRANSPORTS } from "./search.js";
import { writeReview } from "./report.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `ah-flex — flexible AH Belgium basket preparation

Usage:
  ah-flex template --brief "chicken and beef next week" [--out basket.json]
  ah-flex schema
  ah-flex basket check <basket.json> [--json]
  ah-flex basket review <basket.json> --out <review.html> [--open]
  ah-flex search <query> [--limit 8] [--transport http|browser] [--json]
  ah-flex session login
  ah-flex cart apply <basket.json> [--confirm-add (--guest | --har session.har)] [--json]

Safety:
  cart apply is a dry-run unless --confirm-add is present. Browser writes use a
  visible dedicated profile, exact product URLs, and a post-write readback.
  Search reads mimic a real browser over plain HTTPS (no cookies, no stored
  session); --transport browser uses a fresh visible Firefox context instead.
  --har imports only an allowlisted AH session subset into a nonpersistent
  Firefox context and verifies the live member query before any cart click.
  --guest prepares an unauthenticated browser cart and proves the live member is
  null before any cart click; it never reads account/session cookies.
  Checkout, ordering, payment, substitutions, and implicit product selection do
  not exist. After verified readback, the visible browser is released to you.`;
}

function takeFlag(args, name, { value = false, defaultValue } = {}) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
  args.splice(index, 1);
  if (!value) return true;
  if (index >= args.length || args[index].startsWith("--")) {
    throw new BasketError(`${name} requires a value`);
  }
  return args.splice(index, 1)[0];
}

function rejectUnknown(args) {
  if (args.length) throw new BasketError(`Unexpected argument(s): ${args.join(" ")}`);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function printValidation(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.ok ? "Basket structure is valid." : "Basket has structural errors.");
  console.log(
    `${result.facts.selected} selected, ${result.facts.unresolved} unresolved, ${result.facts.total_packs} packs, estimated €${result.facts.estimated_total_eur.toFixed(2)}`,
  );
  console.log(formatDiagnostics(result));
}

async function pauseVisibleBrowser(message) {
  if (!input.isTTY) return;
  const terminal = readline.createInterface({ input, output });
  try {
    await terminal.question(`${message}\nPress Enter when you want ah-flex to close its helper browser. `);
  } finally {
    terminal.close();
  }
}

function openLocalFile(filePath) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function handleTemplate(args) {
  const brief = takeFlag(args, "--brief", { value: true });
  const out = takeFlag(args, "--out", { value: true });
  rejectUnknown(args);
  const template = createTemplate(brief);
  if (out) {
    await writeJson(path.resolve(out), template);
    console.log(`Wrote ${path.resolve(out)}`);
  } else {
    console.log(JSON.stringify(template, null, 2));
  }
}

async function handleSchema(args) {
  rejectUnknown(args);
  console.log(await readFile(path.join(rootDir, "schema", "basket.schema.json"), "utf8"));
}

async function handleBasket(args) {
  const action = args.shift();
  const filePath = args.shift();
  if (!filePath) throw new BasketError(`basket ${action ?? "command"} requires a basket file`);
  const basket = await loadBasket(path.resolve(filePath));
  if (action === "check") {
    const asJson = takeFlag(args, "--json");
    rejectUnknown(args);
    const result = validateBasket(basket);
    printValidation(result, asJson);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === "review") {
    const out = takeFlag(args, "--out", { value: true });
    const shouldOpen = takeFlag(args, "--open");
    rejectUnknown(args);
    if (!out) throw new BasketError("basket review requires --out <review.html>");
    const validation = validateBasket(basket);
    const target = path.resolve(out);
    await writeReview(target, basket, validation);
    console.log(`Wrote ${target}${validation.errors.length || validation.warnings.length ? " with visible attention items" : ""}`);
    if (shouldOpen) openLocalFile(target);
    if (!validation.ok) process.exitCode = 1;
    return;
  }
  throw new BasketError(`Unknown basket command '${action ?? ""}'`);
}

async function handleSearch(args) {
  const query = args.shift();
  if (!query) throw new BasketError("search requires a query");
  const limitRaw = takeFlag(args, "--limit", { value: true, defaultValue: "8" });
  const transport = takeFlag(args, "--transport", { value: true, defaultValue: "http" });
  const asJson = takeFlag(args, "--json");
  rejectUnknown(args);
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new BasketError("--limit must be an integer from 1 to 25");
  }
  if (!TRANSPORTS.includes(transport)) {
    throw new BasketError(`--transport must be one of: ${TRANSPORTS.join(", ")}`);
  }
  const products = await searchProducts(query, { limit, transport });
  if (asJson) {
    console.log(JSON.stringify(products, null, 2));
    return;
  }
  for (const product of products) {
    console.log(
      `${product.name}\n  ${product.url}\n  ${product.price_eur === null ? "price unreadable" : `€${product.price_eur.toFixed(2)}`} · ${product.pack ?? "pack unreadable"} · ${product.availability}`,
    );
  }
}

async function handleSession(args) {
  const action = args.shift();
  rejectUnknown(args);
  if (action !== "login") throw new BasketError("Only 'session login' is supported");
  if (!input.isTTY) throw new BasketError("session login requires an interactive terminal for the visible browser handoff");
  const { context } = await openLoginSession();
  try {
    console.log("A dedicated visible AH Belgium browser is open and under your control. Complete login or verification there; ah-flex never reads the credentials.");
    await pauseVisibleBrowser("Leave the winkelmandje visible once login is complete.");
  } finally {
    await closeVisibleAhBrowser(context);
  }
}

async function handleCart(args) {
  const action = args.shift();
  const filePath = args.shift();
  if (action !== "apply" || !filePath) throw new BasketError("Use 'cart apply <basket.json>'");
  const confirmed = takeFlag(args, "--confirm-add");
  const guest = takeFlag(args, "--guest");
  const harPath = takeFlag(args, "--har", { value: true });
  const asJson = takeFlag(args, "--json");
  rejectUnknown(args);
  const basket = await loadBasket(path.resolve(filePath));
  if (!confirmed) {
    if (harPath || guest) {
      throw new BasketError("--guest and --har are only accepted with --confirm-add");
    }
    const plan = buildApplyPlan(basket);
    if (asJson) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log("DRY RUN — browser not opened; nothing changed.");
      for (const line of plan.lines) console.log(`ADD ${line.quantity} × ${line.expected_name}\n  ${line.url}`);
      console.log("Run again with --confirm-add only after reviewing these exact lines.");
    }
    return;
  }
  if (!input.isTTY) {
    throw new BasketError("--confirm-add requires an interactive terminal so the verified browser can be handed to you");
  }
  if (guest === Boolean(harPath)) {
    throw new BasketError("--confirm-add requires exactly one of --guest or --har <session.har>");
  }
  if (harPath && basket.items.length !== 1) {
    throw new BasketError("HAR-backed confirmed apply currently supports exactly one exact product line");
  }
  const harSession = harPath ? await loadAhHarSession(path.resolve(harPath)) : null;

  let context = null;
  try {
    const result = await applyBasketInVisibleBrowser(basket, {
      harSession,
      sessionMode: guest ? "guest" : "har",
    });
    context = result.context;
    if (asJson) console.log(JSON.stringify(result.receipt, null, 2));
    else {
      console.log("Visible winkelmandje readback matched every exact product URL and requested quantity.");
      for (const line of result.receipt.actions) console.log(`${line.action.toUpperCase()} ${line.quantity} × ${line.expected_name}`);
      for (const warning of result.receipt.warnings) console.log(`ATTENTION ${warning}`);
    }
    await pauseVisibleBrowser("The verified winkelmandje is open and browser control is now yours. You may log in and buy manually; ah-flex cannot operate checkout or payment.");
  } catch (error) {
    context = error.browserContext ?? context;
    if (error.partialReceipt) {
      if (asJson) {
        console.error(JSON.stringify({ partial_receipt: error.partialReceipt }, null, 2));
      } else {
        console.error("PARTIAL RECEIPT — one or more earlier lines may already have changed:");
        for (const line of error.partialReceipt.actions) {
          console.error(`${line.action.toUpperCase()} ${line.quantity} × ${line.expected_name}\n  ${line.url}`);
        }
        for (const row of error.partialReceipt.observed) {
          console.error(`OBSERVED ${row.quantity ?? "?"} × ${row.url}`);
        }
      }
    }
    if (context) {
      console.error("The browser operation stopped before verified completion. Inspect the visible cart; ah-flex cannot operate checkout.");
      await pauseVisibleBrowser("The visible page is being kept open for diagnosis.");
    }
    throw error;
  } finally {
    if (context) await closeVisibleAhBrowser(context);
  }
}

async function main(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "template") return handleTemplate(args);
  if (command === "schema") return handleSchema(args);
  if (command === "basket") return handleBasket(args);
  if (command === "search") return handleSearch(args);
  if (command === "session") return handleSession(args);
  if (command === "cart") return handleCart(args);
  throw new BasketError(`Unknown command '${command}'\n\n${usage()}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  if (error instanceof BasketError && error.diagnostics?.length) {
    console.error(error.diagnostics.map((row) => `${row.code} ${row.path}: ${row.message}`).join("\n"));
  }
  process.exitCode = 1;
});
