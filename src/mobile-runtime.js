import os from "node:os";
import path from "node:path";
import { BasketError } from "./basket.js";
import { applyBasketWithAdapter, buildApplyPlan } from "./browser.js";
import { createMobileAuthClient, MobileSessionStore } from "./mobile-auth.js";
import { createMobileApiClient, createMobileBasketAdapter } from "./mobile-api.js";

const DEFAULT_STATE_DIRECTORY = ".ah-flex";
const MOBILE_SESSION_FILE = "mobile-session.json";
const REFRESH_SKEW_MS = 60_000;

function assertSafeStateDirectory(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BasketError("The AH Flex state directory must be a non-empty path");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
    throw new BasketError(`Refusing to use '${resolved}' as the AH Flex state directory`);
  }
  return resolved;
}

export function resolveMobileStateDirectory(options = {}) {
  return assertSafeStateDirectory(
    options.stateDir ?? process.env.AH_FLEX_STATE_DIR ?? path.join(os.homedir(), DEFAULT_STATE_DIRECTORY),
  );
}

export function resolveMobileSessionPath(options = {}) {
  return path.join(resolveMobileStateDirectory(options), MOBILE_SESSION_FILE);
}

export function createMobileRuntime(options = {}) {
  const sessionPath = options.sessionPath ?? resolveMobileSessionPath(options);
  const store = options.store ?? new MobileSessionStore(sessionPath, options.storeOptions);
  const auth = createMobileAuthClient({
    store,
    fetch: options.fetchImpl ?? globalThis.fetch,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    now: options.now,
    randomBytes: options.randomBytes,
  });

  let cachedSession = null;
  async function usableSession() {
    let session = cachedSession ?? (await auth.readSession());
    if (!session) {
      throw new BasketError("No AH mobile session exists. Run 'ah-flex session login' once first");
    }
    const expiresAt = new Date(session.expires_at).getTime();
    if (!Number.isFinite(expiresAt)) {
      throw new BasketError("The stored AH mobile session is invalid. Run 'ah-flex session login' again");
    }
    const nowValue = typeof options.now === "function" ? options.now() : options.now ?? new Date();
    const now = nowValue instanceof Date ? nowValue.getTime() : new Date(nowValue).getTime();
    if (expiresAt <= now + REFRESH_SKEW_MS) {
      try {
        session = await auth.refresh();
      } catch {
        throw new BasketError("The AH mobile session could not be refreshed. Run 'ah-flex session login' again");
      }
    }
    cachedSession = session;
    return session;
  }

  const api = createMobileApiClient({
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    getAccessToken: async () => (await usableSession()).access_token,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    identity: options.identity,
  });

  return Object.freeze({
    sessionPath,
    beginLogin() {
      cachedSession = null;
      return auth.createAuthorizationRequest();
    },
    async completeLogin(callbackUrl, request) {
      cachedSession = await auth.completeLogin(callbackUrl, request);
      await api.verifyMember();
      return { authenticated: true };
    },
    async logout() {
      cachedSession = null;
      return auth.deleteSession();
    },
    async status() {
      const local = await auth.status();
      if (!local.exists) return { transport: "mobile", state: "missing", authenticated: false };
      if (!local.valid) return { transport: "mobile", state: "invalid", authenticated: false };
      try {
        const session = await usableSession();
        await api.verifyMember();
        return {
          transport: "mobile",
          state: "authenticated",
          authenticated: true,
          expires_at: session.expires_at,
        };
      } catch {
        return { transport: "mobile", state: "unavailable", authenticated: false };
      }
    },
    async applyBasket(basket, applyOptions = {}) {
      const plan = buildApplyPlan(basket, applyOptions);
      await api.verifyMember();
      const adapter = createMobileBasketAdapter(api, plan.lines);
      const receipt = await applyBasketWithAdapter(basket, adapter, applyOptions);
      receipt.warnings = receipt.warnings.map((warning) =>
        warning.includes("hard DOM readback predicate")
          ? "Current prices remain for human review and are not an API cart predicate."
          : warning,
      );
      return receipt;
    },
    api,
  });
}
