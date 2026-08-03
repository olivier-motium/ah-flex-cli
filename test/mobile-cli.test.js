import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoDir, "src", "cli.js");

function runCli(args, env = {}) {
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
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function actionableBasket() {
  return {
    version: 1,
    region: "be",
    title: "Mobile CLI contract",
    brief: "A local dry-run only",
    items: [
      {
        label: "Exact item",
        query: "wi111111",
        quantity: 2,
        storage: "pantry",
        uses: ["fixture"],
        selected: {
          name: "Exact product",
          url: "https://www.ah.be/producten/product/wi111111/exact-product",
          product_id: "wi111111",
          price_eur: 2.5,
          pack: "500 g",
          availability: "available",
          checked_at: "2026-08-03T00:00:00.000Z",
        },
      },
    ],
  };
}

test("mobile is the authenticated default while an explicit browser keeps the legacy path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-flex-mobile-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, ".ah-flex");
  const status = await runCli(["session", "status", "--json"], { AH_FLEX_STATE_DIR: stateDir });
  assert.equal(status.code, 1);
  assert.deepEqual(JSON.parse(status.stdout), {
    transport: "mobile",
    state: "missing",
    authenticated: false,
  });

  const legacy = await runCli(["session", "status", "--browser", "chrome", "--json", "--parser-stop"]);
  assert.equal(legacy.code, 1);
  assert.match(legacy.stderr, /Unexpected argument\(s\): --parser-stop/);
  assert.doesNotMatch(legacy.stderr, /mobile session|fetch|Could not launch/i);
});

test("cart dry-run accepts the mobile transport without opening a browser or reading a session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-flex-mobile-dry-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const basketPath = path.join(root, "basket.json");
  await writeFile(basketPath, `${JSON.stringify(actionableBasket())}\n`, { mode: 0o600 });

  const result = await runCli(["cart", "apply", basketPath, "--transport", "mobile", "--json"], {
    AH_FLEX_STATE_DIR: path.join(root, ".ah-flex"),
  });
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.lines[0].quantity, 2);
});

test("invalid authenticated transports fail before session or basket I/O", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-flex-mobile-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const status = await runCli(["session", "status", "--transport", "telepathy", "--json"], {
    AH_FLEX_STATE_DIR: path.join(root, ".ah-flex"),
  });
  assert.equal(status.code, 1);
  assert.match(status.stderr, /--transport must be one of: mobile, browser/);

  const cart = await runCli([
    "cart",
    "apply",
    path.join(root, "deliberately-absent.json"),
    "--transport",
    "telepathy",
  ]);
  assert.equal(cart.code, 1);
  assert.match(cart.stderr, /--transport must be one of: mobile, browser/);
  assert.doesNotMatch(cart.stderr, /ENOENT|no such file or directory/i);
});
