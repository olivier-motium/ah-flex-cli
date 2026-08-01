import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importFirefoxAhCookies } from "../src/firefox-session.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.js");
const sqlite3 = "/usr/bin/sqlite3";
const baseSchema = `
PRAGMA user_version = 1;
CREATE TABLE moz_cookies (
  id INTEGER PRIMARY KEY,
  originAttributes TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  expiry INTEGER NOT NULL DEFAULT 0
);
`;

function runSqlite(databasePath, sql) {
  const result = spawnSync(sqlite3, ["-batch", "-bail", databasePath], { input: sql, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Synthetic SQLite fixture failed");
  return result.stdout.trim();
}

async function profiles(t, sourceSql, destinationSql, sourceSchema = baseSchema) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-flex-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source");
  const destinationDir = path.join(root, "destination");
  await Promise.all([mkdir(sourceDir), mkdir(destinationDir)]);
  const sourceDatabase = path.join(sourceDir, "cookies.sqlite");
  const destinationDatabase = path.join(destinationDir, "cookies.sqlite");
  runSqlite(sourceDatabase, `${sourceSchema}\n${sourceSql}`);
  runSqlite(destinationDatabase, `${baseSchema}\n${destinationSql}`);
  return { sourceDir, destinationDir, sourceDatabase, destinationDatabase };
}

test("scoped import replaces only AH-domain rows and reports only a count and paths", async (t) => {
  const fixture = await profiles(
    t,
    `INSERT INTO moz_cookies (originAttributes, name, value, host) VALUES
      ('', 'source-root', hex(randomblob(8)), 'ah.be'),
      ('', 'source-subdomain', hex(randomblob(8)), '.www.ah.be'),
      ('', 'source-unrelated', hex(randomblob(8)), '.example.com');`,
    `INSERT INTO moz_cookies (originAttributes, name, value, host) VALUES
      ('', 'destination-old-ah', hex(randomblob(8)), '.ah.be'),
      ('', 'destination-unrelated', hex(randomblob(8)), '.example.com');`,
  );

  const receipt = await importFirefoxAhCookies(fixture.sourceDir, { profileDir: fixture.destinationDir });
  assert.equal(receipt.imported_cookie_rows, 2);
  assert.equal(receipt.host_scope, "ah.be and *.ah.be");
  assert.deepEqual(Object.keys(receipt).sort(), [
    "destination_profile",
    "host_scope",
    "imported_cookie_rows",
    "source_profile",
  ]);
  assert.deepEqual(
    runSqlite(fixture.destinationDatabase, "SELECT name || ':' || host FROM moz_cookies ORDER BY name;").split("\n"),
    ["destination-unrelated:.example.com", "source-root:ah.be", "source-subdomain:.www.ah.be"],
  );
});

test("zero source matches and incompatible schemas preserve the destination", async (t) => {
  const zero = await profiles(
    t,
    "INSERT INTO moz_cookies (originAttributes, name, value, host) VALUES ('', 'source-unrelated', hex(randomblob(8)), '.example.com');",
    "INSERT INTO moz_cookies (originAttributes, name, value, host) VALUES ('', 'destination-ah', hex(randomblob(8)), '.ah.be');",
  );
  await assert.rejects(
    () => importFirefoxAhCookies(zero.sourceDir, { profileDir: zero.destinationDir }),
    /contains no AH Belgium cookies.*left unchanged/i,
  );
  assert.equal(runSqlite(zero.destinationDatabase, "SELECT name FROM moz_cookies;"), "destination-ah");

  const mismatchedSchema = baseSchema.replace(
    "expiry INTEGER NOT NULL DEFAULT 0",
    "expiry INTEGER NOT NULL DEFAULT 0, updateTime INTEGER NOT NULL DEFAULT 0",
  );
  const mismatch = await profiles(
    t,
    "INSERT INTO moz_cookies (originAttributes, name, value, host) VALUES ('', 'source-ah', hex(randomblob(8)), '.ah.be');",
    "INSERT INTO moz_cookies (originAttributes, name, value, host) VALUES ('', 'destination-ah', hex(randomblob(8)), '.ah.be');",
    mismatchedSchema,
  );
  await assert.rejects(
    () => importFirefoxAhCookies(mismatch.sourceDir, { profileDir: mismatch.destinationDir }),
    /cookie schemas differ/i,
  );
  assert.equal(runSqlite(mismatch.destinationDatabase, "SELECT name FROM moz_cookies;"), "destination-ah");
});

test("active, dangerous, and identical profiles fail before mutation", async (t) => {
  const fixture = await profiles(
    t,
    "INSERT INTO moz_cookies (originAttributes, name, value, host) VALUES ('', 'source-ah', hex(randomblob(8)), '.ah.be');",
    "INSERT INTO moz_cookies (originAttributes, name, value, host) VALUES ('', 'destination-ah', hex(randomblob(8)), '.ah.be');",
  );
  await assert.rejects(
    () => importFirefoxAhCookies(fixture.sourceDir, { profileDir: fixture.destinationDir, isOpen: async () => true }),
    /Close both Firefox profiles.*no rows were changed/i,
  );
  assert.equal(runSqlite(fixture.destinationDatabase, "SELECT name FROM moz_cookies;"), "destination-ah");
  await assert.rejects(() => importFirefoxAhCookies("/", { profileDir: fixture.destinationDir }), /Refusing to use/i);
  await assert.rejects(
    () => importFirefoxAhCookies(fixture.destinationDir, { profileDir: fixture.destinationDir }),
    /must be different/i,
  );
});

test("CLI requires the exact cookie-copy confirmation flag", () => {
  const result = spawnSync(process.execPath, [cliPath, "session", "import-firefox", "/tmp/source", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires the exact --confirm-ah-cookie-copy flag/i);
  assert.equal(result.stdout, "");
});
