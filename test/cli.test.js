import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoDir, "src", "cli.js");

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function actionableBasket() {
  return {
    version: 1,
    region: "be",
    title: "CLI browser test",
    brief: "A temporary actionable basket for dry-run parsing",
    items: [
      {
        label: "Freezer component",
        query: "wi111111",
        quantity: 2,
        storage: "freezer",
        uses: ["quick dinner", "mixed bowl"],
        selected: {
          name: "Exact freezer component",
          url: "https://www.ah.be/producten/product/wi111111/exact-freezer-component",
          product_id: "wi111111",
          price_eur: 5,
          pack: "500 g",
          availability: "available",
          checked_at: new Date().toISOString(),
        },
      },
    ],
  };
}

test("CLI rejects missing, duplicate, unknown, Safari, and WebKit browser flags before any launch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-flex-cli-browser-flags-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const absentBasket = path.join(root, "deliberately-absent.json");
  const cases = [
    { args: ["cart", "apply", absentBasket, "--browser"], error: /--browser requires a value/ },
    {
      args: ["cart", "apply", absentBasket, "--browser", "chrome", "--browser", "edge"],
      error: /--browser may be specified only once/,
    },
    { args: ["cart", "apply", absentBasket, "--browser", "opera"], error: /Unknown browser 'opera'/ },
    { args: ["cart", "apply", absentBasket, "--browser", "safari"], error: /Safari is not supported/ },
    { args: ["cart", "apply", absentBasket, "--browser", "webkit"], error: /WebKit is not supported/ },
  ];

  for (const { args, error } of cases) {
    const result = await runCli(args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, error, args.join(" "));
    assert.doesNotMatch(result.stderr, /ENOENT|no such file or directory/i, args.join(" "));
  }
});

test("HTTP search rejects an explicit browser before making a network request", async () => {
  const result = await runCli(["search", "kipfilet", "--browser", "chrome"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--browser is only supported with --transport browser/);
  assert.doesNotMatch(result.stderr, /Could not launch|Access Denied|fetch|ECONN|network/i);
});

test("supported cart dry-runs validate each browser and open no browser or profile", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-flex-cli-dry-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const basketPath = path.join(root, "actionable.json");
  await writeFile(basketPath, `${JSON.stringify(actionableBasket())}\n`, { encoding: "utf8", mode: 0o600 });

  for (const browser of ["firefox", "chrome", "edge"]) {
    const result = await runCli(["cart", "apply", basketPath, "--browser", browser, "--json"], {
      env: { HOME: root },
    });
    assert.equal(result.code, 0, `${browser}: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.mode, "dry-run");
    assert.match(plan.warning, /No browser was opened and nothing was changed/);
    assert.equal(plan.lines.length, 1);
    assert.equal(plan.lines[0].quantity, 2);
    await assert.rejects(lstat(path.join(root, ".ah-flex", `${browser}-profile`)), (error) => error?.code === "ENOENT");
  }
});

test("a rejected dry-run browser is refused before a deliberately absent basket is read", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-flex-cli-parse-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runCli(["cart", "apply", path.join(root, "absent.json"), "--browser", "safari"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Safari is not supported/);
  assert.doesNotMatch(result.stderr, /ENOENT|no such file or directory/i);
});

test("browser flags are parsed on session status and browser-transport search before operation launch", async () => {
  const status = await runCli(["session", "status", "--browser", "chrome", "--json", "--parser-stop"]);
  assert.equal(status.code, 1);
  assert.match(status.stderr, /Unexpected argument\(s\): --parser-stop/);
  assert.doesNotMatch(status.stderr, /Unknown browser|Could not launch/);

  const browserSearch = await runCli([
    "search",
    "kipfilet",
    "--transport",
    "browser",
    "--browser",
    "edge",
    "--parser-stop",
  ]);
  assert.equal(browserSearch.code, 1);
  assert.match(browserSearch.stderr, /Unexpected argument\(s\): --parser-stop/);
  assert.doesNotMatch(browserSearch.stderr, /Unknown browser|Could not launch/);
});

test("session login --json remains rejected even when a supported browser is selected", async () => {
  const result = await runCli(["session", "login", "--json", "--browser", "chrome"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /session login does not support --json/);
  assert.doesNotMatch(result.stderr, /Could not launch|Opening the dedicated/);
});
