import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BasketError } from "./basket.js";
import { resolveProfileDir } from "./browser.js";

const SQLITE3 = "/usr/bin/sqlite3";
const LSOF = "/usr/sbin/lsof";
const FIELD_SEPARATOR = "\u001f";
const MAX_TOOL_OUTPUT = 1024 * 1024;
const HOST_SCOPE = "ah.be and *.ah.be";

function safeProfilePath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BasketError(`${label} Firefox profile directory must be a non-empty path`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
    throw new BasketError(`Refusing to use '${resolved}' as the ${label.toLowerCase()} Firefox profile directory`);
  }
  return resolved;
}

async function existingProfile(value, label, writable) {
  const requested = safeProfilePath(value, label);
  let profileDir;
  try {
    profileDir = await realpath(requested);
  } catch {
    throw new BasketError(`${label} Firefox profile directory does not exist: ${requested}`);
  }
  safeProfilePath(profileDir, label);

  const profileStat = await stat(profileDir).catch(() => null);
  if (!profileStat?.isDirectory()) {
    throw new BasketError(`${label} Firefox profile path is not a directory: ${profileDir}`);
  }

  const databasePath = path.join(profileDir, "cookies.sqlite");
  const databaseStat = await lstat(databasePath).catch(() => null);
  if (!databaseStat?.isFile() || databaseStat.isSymbolicLink()) {
    throw new BasketError(`${label} Firefox profile has no regular cookies.sqlite file: ${profileDir}`);
  }
  if (typeof process.getuid === "function" && databaseStat.uid !== process.getuid()) {
    throw new BasketError(`${label} Firefox cookies.sqlite is not owned by the current user`);
  }
  try {
    await access(databasePath, fsConstants.R_OK | (writable ? fsConstants.W_OK : 0));
  } catch {
    throw new BasketError(`${label} Firefox cookies.sqlite is not ${writable ? "readable and writable" : "readable"}`);
  }
  return { profileDir, databasePath };
}

function sqliteUri(databasePath, mode) {
  const uri = new URL(pathToFileURL(databasePath));
  uri.searchParams.set("mode", mode);
  return uri.toString();
}

function quoteSqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new BasketError("Firefox cookie schema contains an unsupported column name");
  }
  return `"${value}"`;
}

export function runLocalTool(command, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const append = (current, chunk) => {
      if (exceeded) return current;
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_TOOL_OUTPUT) {
        exceeded = true;
        child.kill();
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", () => reject(new BasketError(`Required local tool is unavailable: ${command}`)));
    child.once("close", (code) => {
      if (exceeded) {
        reject(new BasketError("A local Firefox session tool returned too much output; import stopped safely"));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.once("error", () => {});
    child.stdin.end(stdin);
  });
}

async function databaseIsOpen(databasePath, runTool) {
  const result = await runTool(LSOF, ["-Fn", "--", databasePath]);
  if (result.code === 0) return Boolean(result.stdout.trim());
  if (result.code === 1) return false;
  throw new BasketError("Could not verify that both Firefox profiles are closed; import stopped safely");
}

function decodeHex(value) {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new BasketError("Firefox cookie schema could not be read safely");
  }
  return Buffer.from(value, "hex").toString("utf8");
}

function parseCookieSchema(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const userVersion = Number(lines.shift());
  if (!Number.isInteger(userVersion)) {
    throw new BasketError("Firefox cookie schema version could not be read");
  }
  const columns = lines.map((line) => {
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length !== 7) throw new BasketError("Firefox cookie schema could not be read safely");
    const [cid, nameHex, typeHex, notNull, defaultValue, primaryKey, hidden] = fields;
    return {
      cid: Number(cid),
      name: decodeHex(nameHex),
      type: decodeHex(typeHex),
      notNull: Number(notNull),
      defaultValue,
      primaryKey: Number(primaryKey),
      hidden: Number(hidden),
    };
  });
  if (!columns.length || columns.some((column) => !Number.isInteger(column.cid))) {
    throw new BasketError("Firefox moz_cookies schema is missing or unreadable");
  }
  return { userVersion, columns };
}

async function readCookieSchema(databasePath, mode, runTool) {
  const sql = [
    "PRAGMA user_version;",
    "SELECT cid, hex(name), hex(type), \"notnull\",",
    "       CASE WHEN dflt_value IS NULL THEN '-' ELSE 'x' || hex(dflt_value) END,",
    "       pk, hidden",
    "FROM pragma_table_xinfo('moz_cookies')",
    "ORDER BY cid;",
  ].join("\n");
  const result = await runTool(
    SQLITE3,
    ["-batch", "-bail", "-noheader", "-separator", FIELD_SEPARATOR, sqliteUri(databasePath, mode)],
    sql,
  );
  if (result.code !== 0) {
    throw new BasketError("Firefox cookie schema could not be read; no cookie rows were changed");
  }
  return parseCookieSchema(result.stdout);
}

function assertCompatibleSchemas(source, destination) {
  if (source.userVersion !== destination.userVersion || JSON.stringify(source.columns) !== JSON.stringify(destination.columns)) {
    throw new BasketError(
      "Firefox cookie schemas differ. Open and close both profiles once with the same Firefox version, then retry",
    );
  }
  const primaryKeys = destination.columns.filter((column) => column.primaryKey > 0);
  const copyColumns = destination.columns.filter((column) => column.primaryKey === 0 && column.hidden === 0);
  if (
    primaryKeys.length !== 1 ||
    primaryKeys[0].name !== "id" ||
    !copyColumns.some((column) => column.name === "host") ||
    !copyColumns.some((column) => column.name === "name") ||
    !copyColumns.some((column) => column.name === "value")
  ) {
    throw new BasketError("Firefox moz_cookies schema is not compatible with the scoped importer");
  }
  return copyColumns.map((column) => column.name);
}

export function buildAhCookieImportSql(columnNames, sourceDatabaseUri) {
  const columns = columnNames.map(quoteIdentifier).join(", ");
  const host = quoteIdentifier("host");
  const predicate = `(lower(${host}) = 'ah.be' OR lower(${host}) LIKE '%.ah.be')`;
  return [
    `ATTACH DATABASE ${quoteSqlString(sourceDatabaseUri)} AS "ah_source";`,
    "BEGIN IMMEDIATE;",
    `DELETE FROM "main"."moz_cookies" WHERE ${predicate}`,
    `  AND EXISTS (SELECT 1 FROM "ah_source"."moz_cookies" WHERE ${predicate});`,
    `INSERT INTO "main"."moz_cookies" (${columns})`,
    `SELECT ${columns} FROM "ah_source"."moz_cookies" WHERE ${predicate};`,
    "SELECT changes();",
    "COMMIT;",
    "DETACH DATABASE \"ah_source\";",
  ].join("\n");
}

export async function importFirefoxAhCookies(sourceProfileDir, options = {}) {
  if (process.platform !== "darwin" && !options.allowUnsupportedPlatform) {
    throw new BasketError("Firefox AH cookie import currently supports macOS only");
  }
  const runTool = options.runTool ?? runLocalTool;
  const isOpen = options.isOpen ?? ((databasePath) => databaseIsOpen(databasePath, runTool));
  const destinationCandidate = resolveProfileDir({ profileDir: options.profileDir });
  const [source, destination] = await Promise.all([
    existingProfile(sourceProfileDir, "Source", false),
    existingProfile(destinationCandidate, "Destination", true),
  ]);
  if (source.profileDir === destination.profileDir || source.databasePath === destination.databasePath) {
    throw new BasketError("Source and destination Firefox profiles must be different");
  }
  if ((await isOpen(source.databasePath)) || (await isOpen(destination.databasePath))) {
    throw new BasketError("Close both Firefox profiles before importing AH cookies; no rows were changed");
  }

  const [sourceSchema, destinationSchema] = await Promise.all([
    readCookieSchema(source.databasePath, "ro", runTool),
    readCookieSchema(destination.databasePath, "rw", runTool),
  ]);
  const columnNames = assertCompatibleSchemas(sourceSchema, destinationSchema);

  if ((await isOpen(source.databasePath)) || (await isOpen(destination.databasePath))) {
    throw new BasketError("A Firefox profile opened during preflight; no rows were changed");
  }
  const sql = buildAhCookieImportSql(columnNames, sqliteUri(source.databasePath, "ro"));
  const result = await runTool(
    SQLITE3,
    ["-batch", "-bail", "-noheader", sqliteUri(destination.databasePath, "rw")],
    sql,
  );
  if (result.code !== 0) {
    throw new BasketError("AH cookie import failed safely; SQLite rolled back the destination transaction");
  }
  const importedCookieRows = Number(result.stdout.trim());
  if (!Number.isInteger(importedCookieRows) || importedCookieRows < 0) {
    throw new BasketError("AH cookie import completed without a readable row count; verify with 'session status'");
  }
  if (importedCookieRows === 0) {
    throw new BasketError("The source profile contains no AH Belgium cookies; the destination was left unchanged");
  }
  return {
    source_profile: source.profileDir,
    destination_profile: destination.profileDir,
    imported_cookie_rows: importedCookieRows,
    host_scope: HOST_SCOPE,
  };
}
