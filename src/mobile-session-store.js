import path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes as nodeRandomBytes } from "node:crypto";

export const MOBILE_SESSION_VERSION = 1;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const MAX_SESSION_BYTES = 64 * 1024;

const SESSION_KEYS = new Set([
  "version",
  "tenant",
  "client_id",
  "access_token",
  "refresh_token",
  "token_type",
  "scope",
  "issued_at",
  "expires_at",
]);

const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_CLIENT_ID_LENGTH = 1 * 1024;
const MAX_SCOPE_LENGTH = 4 * 1024;

export class MobileSessionStoreError extends Error {
  constructor(message, { code = "SESSION_STORE_ERROR", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MobileSessionStoreError";
    this.code = code;
  }
}

function invalidSession(message = "The stored mobile session is invalid") {
  return new MobileSessionStoreError(message, { code: "INVALID_SESSION" });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function assertString(value, field, { maxLength, nonEmpty = true } = {}) {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || value.length > maxLength) {
    throw invalidSession(`The stored mobile session has an invalid ${field}`);
  }
  return value;
}

function assertIsoTimestamp(value, field) {
  assertString(value, field, { maxLength: 64 });
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw invalidSession(`The stored mobile session has an invalid ${field}`);
  }
  return date;
}

function assertOwned(stat, label) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new MobileSessionStoreError(`The mobile session ${label} is not owned by the current user`, {
      code: "UNSAFE_SESSION_PATH",
    });
  }
}

function assertPrivateDirectory(stat, label) {
  if (stat.isSymbolicLink()) {
    throw new MobileSessionStoreError(`Refusing symbolic-link mobile session ${label}`, {
      code: "SYMLINK_SESSION_PATH",
    });
  }
  if (!stat.isDirectory()) {
    throw new MobileSessionStoreError(`The mobile session ${label} is not a directory`, {
      code: "UNSAFE_SESSION_PATH",
    });
  }
  assertOwned(stat, label);
  if ((stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
    throw new MobileSessionStoreError(`The mobile session ${label} must have mode 0700`, {
      code: "UNSAFE_SESSION_PATH",
    });
  }
}

function assertRegularFile(stat, label) {
  if (stat.isSymbolicLink()) {
    throw new MobileSessionStoreError(`Refusing symbolic-link mobile session ${label}`, {
      code: "SYMLINK_SESSION_PATH",
    });
  }
  if (!stat.isFile()) {
    throw new MobileSessionStoreError(`The mobile session ${label} is not a regular file`, {
      code: "UNSAFE_SESSION_PATH",
    });
  }
  assertOwned(stat, label);
}

function assertPrivateFile(stat, label) {
  assertRegularFile(stat, label);
  if ((stat.mode & 0o7777) !== PRIVATE_FILE_MODE) {
    throw new MobileSessionStoreError(`The mobile session ${label} must have mode 0600`, {
      code: "UNSAFE_SESSION_PATH",
    });
  }
}

function resolveSessionPath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("A non-empty mobile session path is required");
  }
  const resolved = path.resolve(filePath);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("The mobile session path must name a file, not a filesystem root");
  }
  return resolved;
}

function toFsError(error, message, code = "SESSION_STORE_ERROR") {
  if (error instanceof MobileSessionStoreError) return error;
  return new MobileSessionStoreError(message, { code, cause: error });
}

function pathParts(root, target) {
  const relative = path.relative(root, target);
  return relative.split(path.sep).filter(Boolean);
}

async function inspectOrCreatePrivateParent(parent, fsImpl, { create }) {
  const resolvedParent = path.resolve(parent);
  const root = path.parse(resolvedParent).root;
  if (resolvedParent === root) {
    throw new MobileSessionStoreError("The mobile session parent must be a private directory", {
      code: "UNSAFE_SESSION_PATH",
    });
  }

  let current = root;
  let missing = false;
  for (const part of pathParts(root, resolvedParent)) {
    current = path.join(current, part);
    let stat = null;
    try {
      stat = await fsImpl.lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw toFsError(error, "Unable to inspect the mobile session parent");
      }
      missing = true;
    }

    if (missing) {
      if (!create) return false;
      try {
        await fsImpl.mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw toFsError(error, "Unable to create the mobile session parent");
        }
      }
      try {
        stat = await fsImpl.lstat(current);
      } catch (error) {
        throw toFsError(error, "Unable to verify the mobile session parent");
      }
    }

    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      if (current === resolvedParent) {
        throw new MobileSessionStoreError("Refusing a symbolic-link mobile session parent", {
          code: "SYMLINK_SESSION_PATH",
        });
      }
      try {
        stat = await fsImpl.stat(current);
      } catch (error) {
        throw toFsError(error, "Unable to inspect the mobile session parent");
      }
    }
    if (!stat.isDirectory()) {
      throw new MobileSessionStoreError("A mobile session parent component is not a directory", {
        code: "UNSAFE_SESSION_PATH",
      });
    }
    if (current === resolvedParent) {
      assertPrivateDirectory(stat, "parent");
    }
  }

  return true;
}

async function inspectTarget(filePath, fsImpl) {
  try {
    const stat = await fsImpl.lstat(filePath);
    return stat;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw toFsError(error, "Unable to inspect the mobile session file");
  }
}

export function validateSession(value) {
  if (!isPlainObject(value)) throw invalidSession();

  for (const key of Object.keys(value)) {
    if (!SESSION_KEYS.has(key)) throw invalidSession();
  }

  if (value.version !== MOBILE_SESSION_VERSION) throw invalidSession();
  if (value.tenant !== "appie-be") throw invalidSession();
  assertString(value.client_id, "client_id", { maxLength: MAX_CLIENT_ID_LENGTH });
  assertString(value.access_token, "access_token", { maxLength: MAX_TOKEN_LENGTH });
  assertString(value.token_type, "token_type", { maxLength: 128 });
  const issuedAt = assertIsoTimestamp(value.issued_at, "issued_at");
  const expiresAt = assertIsoTimestamp(value.expires_at, "expires_at");
  if (expiresAt.getTime() <= issuedAt.getTime()) throw invalidSession();

  if (value.refresh_token !== undefined) {
    assertString(value.refresh_token, "refresh_token", { maxLength: MAX_TOKEN_LENGTH });
  }
  if (value.scope !== undefined) {
    assertString(value.scope, "scope", { maxLength: MAX_SCOPE_LENGTH });
  }

  return value;
}

async function readSessionAtPath(filePath, fsImpl) {
  const parentReady = await inspectOrCreatePrivateParent(path.dirname(filePath), fsImpl, { create: false });
  if (!parentReady) return null;

  const stat = await inspectTarget(filePath, fsImpl);
  if (!stat) return null;
  assertPrivateFile(stat, "file");
  if (stat.size > MAX_SESSION_BYTES) {
    throw new MobileSessionStoreError("The mobile session file is too large", {
      code: "SESSION_TOO_LARGE",
    });
  }

  let contents;
  try {
    contents = await fsImpl.readFile(filePath, { encoding: "utf8" });
  } catch (error) {
    throw toFsError(error, "Unable to read the mobile session file");
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_SESSION_BYTES) {
    throw new MobileSessionStoreError("The mobile session file is too large", {
      code: "SESSION_TOO_LARGE",
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new MobileSessionStoreError("The mobile session file is not valid JSON", {
      code: "INVALID_SESSION",
      cause: error,
    });
  }
  return validateSession(parsed);
}

async function openExclusive(fsImpl, filePath, mode, randomBytes) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const suffix = Buffer.from(randomBytes(12)).toString("hex");
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
    try {
      const handle = await fsImpl.open(temporaryPath, "wx", mode);
      return { handle, temporaryPath };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 3) {
        throw toFsError(error, "Unable to create the temporary mobile session file");
      }
    }
  }
  throw new MobileSessionStoreError("Unable to create the temporary mobile session file");
}

async function writeSessionAtPath(filePath, session, fsImpl, randomBytes) {
  validateSession(session);
  const serialized = `${JSON.stringify(session)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) {
    throw new MobileSessionStoreError("The mobile session is too large", { code: "SESSION_TOO_LARGE" });
  }

  await inspectOrCreatePrivateParent(path.dirname(filePath), fsImpl, { create: true });
  const existing = await inspectTarget(filePath, fsImpl);
  if (existing) {
    assertPrivateFile(existing, "file");
  }

  let temporaryPath = null;
  let handle = null;
  try {
    ({ handle, temporaryPath } = await openExclusive(fsImpl, filePath, PRIVATE_FILE_MODE, randomBytes));
    await handle.writeFile(serialized, { encoding: "utf8" });
    if (typeof handle.sync === "function") await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.chmod(temporaryPath, PRIVATE_FILE_MODE);
    await fsImpl.rename(temporaryPath, filePath);
    temporaryPath = null;

    const finalStat = await fsImpl.lstat(filePath);
    assertPrivateFile(finalStat, "file");
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original failure without logging or exposing session data.
      }
    }
    throw toFsError(error, "Unable to write the mobile session file");
  } finally {
    if (temporaryPath) {
      try {
        await fsImpl.unlink(temporaryPath);
      } catch {
        // The temporary path is best-effort cleanup only.
      }
    }
  }
}

async function deleteSessionAtPath(filePath, fsImpl) {
  const parentReady = await inspectOrCreatePrivateParent(path.dirname(filePath), fsImpl, { create: false });
  if (!parentReady) return false;

  const stat = await inspectTarget(filePath, fsImpl);
  if (!stat) return false;
  assertPrivateFile(stat, "file");
  try {
    await fsImpl.unlink(filePath);
  } catch (error) {
    throw toFsError(error, "Unable to delete the mobile session file");
  }
  return true;
}

function nowDate(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("A valid session status time is required");
  return date;
}

export class MobileSessionStore {
  constructor(filePath, options = {}) {
    this.path = resolveSessionPath(filePath);
    this.fs = options.fs ?? fs;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.now = options.now ?? (() => new Date());
  }

  async read() {
    return readSessionAtPath(this.path, this.fs);
  }

  async write(session) {
    return writeSessionAtPath(this.path, session, this.fs, this.randomBytes);
  }

  async delete() {
    return deleteSessionAtPath(this.path, this.fs);
  }

  async status(options = {}) {
    const parentReady = await inspectOrCreatePrivateParent(path.dirname(this.path), this.fs, { create: false });
    if (!parentReady) return { exists: false };

    const stat = await inspectTarget(this.path, this.fs);
    if (!stat) return { exists: false };
    try {
      assertPrivateFile(stat, "file");
    } catch (error) {
      if (error?.code !== "INVALID_SESSION") {
        return { exists: true, valid: false, reason: error.code ?? "UNSAFE_SESSION_PATH" };
      }
      return { exists: true, valid: false, reason: "INVALID_SESSION" };
    }

    let session;
    try {
      session = await this.read();
    } catch (error) {
      if (error?.code === "INVALID_SESSION" || error?.code === "SESSION_TOO_LARGE") {
        return { exists: true, valid: false, reason: "INVALID_SESSION" };
      }
      throw error;
    }
    if (!session) return { exists: false };

    const expiresAt = new Date(session.expires_at);
    const currentTime = nowDate(options.now ?? this.now);
    return {
      exists: true,
      valid: true,
      usable: expiresAt.getTime() > currentTime.getTime(),
      expired: expiresAt.getTime() <= currentTime.getTime(),
      tenant: session.tenant,
      client_id: session.client_id,
      token_type: session.token_type,
      scope: session.scope ?? null,
      issued_at: session.issued_at,
      expires_at: session.expires_at,
      has_access_token: true,
      has_refresh_token: Object.prototype.hasOwnProperty.call(session, "refresh_token"),
      updated_at: Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : null,
    };
  }
}

export async function readSession(filePath, options = {}) {
  return new MobileSessionStore(filePath, options).read();
}

export async function writeSession(filePath, session, options = {}) {
  return new MobileSessionStore(filePath, options).write(session);
}

export async function deleteSession(filePath, options = {}) {
  return new MobileSessionStore(filePath, options).delete();
}

export async function getSessionStatus(filePath, options = {}) {
  return new MobileSessionStore(filePath, options).status(options);
}
