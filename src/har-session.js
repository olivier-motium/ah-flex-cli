import { readFile } from "node:fs/promises";
import { BasketError } from "./basket.js";
import { createMemberRequestBody, MEMBER_QUERY } from "./member-query.js";

const AH_GQL_URL = "https://www.ah.be/gql";
const MAX_HAR_BYTES = 5 * 1024 * 1024;
const COOKIE_NAMES = new Set([
  "jsessionid_myah",
  "ASC",
  "RCC",
  "Ahonlbe-Prd-01-DigitalDev-B2",
  "Ahonlbe-Prd-01-DigitalDev-F1",
  "viewport",
]);
const REQUIRED_COOKIE_NAMES = ["jsessionid_myah", "ASC", "RCC"];
const MEMBER_HEADER_NAMES = new Set([
  "accept",
  "accept-language",
  "content-type",
  "x-client-name",
  "x-client-platform-type",
  "x-client-version",
]);

function parseRequestBody(entry) {
  try {
    return JSON.parse(entry?.request?.postData?.text ?? "");
  } catch {
    return null;
  }
}

function hasEmptyVariables(body) {
  return Boolean(
    body?.variables &&
      typeof body.variables === "object" &&
      !Array.isArray(body.variables) &&
      Object.keys(body.variables).length === 0,
  );
}

function newestQuery(entries, operationName, expectedQuery = null) {
  return entries
    .map((entry) => ({ entry, body: parseRequestBody(entry) }))
    .filter(
      ({ entry, body }) =>
        entry?.request?.method === "POST" &&
        entry?.request?.url === AH_GQL_URL &&
        entry?.response?.status === 200 &&
        body?.operationName === operationName &&
        typeof body.query === "string" &&
        /^\s*query\b/i.test(body.query) &&
        (!expectedQuery || (hasEmptyVariables(body) && body.query === expectedQuery)),
    )
    .sort((left, right) => Date.parse(left.entry.startedDateTime ?? 0) - Date.parse(right.entry.startedDateTime ?? 0))
    .at(-1);
}

function extractCookies(entry) {
  const cookies = new Map();
  for (const candidate of entry?.request?.cookies ?? []) {
    if (!COOKIE_NAMES.has(candidate?.name) || typeof candidate.value !== "string") continue;
    if (!candidate.value || candidate.value.length > 8192 || /[\u0000-\u001f\u007f]/.test(candidate.value)) {
      throw new BasketError("The AH HAR contains a malformed session cookie");
    }
    const existing = cookies.get(candidate.name);
    if (existing && existing.value !== candidate.value) {
      throw new BasketError("The AH HAR contains conflicting session cookies");
    }
    cookies.set(candidate.name, { name: candidate.name, value: candidate.value, url: "https://www.ah.be" });
  }
  const missing = REQUIRED_COOKIE_NAMES.filter((name) => !cookies.has(name));
  if (missing.length) throw new BasketError("The AH HAR does not contain the required authenticated session cookies");
  return [...cookies.values()];
}

function extractMemberHeaders(entry) {
  const headers = {};
  for (const candidate of entry?.request?.headers ?? []) {
    const name = String(candidate?.name ?? "").toLowerCase();
    if (MEMBER_HEADER_NAMES.has(name) && typeof candidate.value === "string") headers[name] = candidate.value;
  }
  if (headers["content-type"] !== "application/json") {
    throw new BasketError("The AH HAR member query has an unsupported content type");
  }
  return headers;
}

export function parseAhHarSession(har) {
  if (!har || har.log?.version !== "1.2" || !Array.isArray(har.log.entries)) {
    throw new BasketError("The AH session file is not a valid HAR 1.2 capture");
  }
  const member = newestQuery(har.log.entries, "member", MEMBER_QUERY);
  const basket = newestQuery(har.log.entries, "basket");
  if (!member || !basket) {
    throw new BasketError(
      "The AH HAR lacks the pinned member query and successful basket query required for session verification",
    );
  }
  return {
    cookies: extractCookies(basket.entry),
    memberRequest: {
      headers: extractMemberHeaders(member.entry),
      body: createMemberRequestBody(),
    },
  };
}

export async function loadAhHarSession(filePath) {
  const raw = await readFile(filePath);
  if (raw.byteLength > MAX_HAR_BYTES) throw new BasketError(`AH HAR exceeds ${MAX_HAR_BYTES} bytes`);
  let har;
  try {
    har = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BasketError("The AH session file is not valid JSON");
  }
  return parseAhHarSession(har);
}
