import { BasketError } from "./basket.js";

export const AH_ORIGIN = "https://www.ah.be";

// Header set proven against www.ah.be on 2026-07-31 (Chrome 150). If AH starts
// denying these requests, refresh the major version to the current Chrome.
const CHROME_MAJOR = "150";

export function browserMimicHeaders() {
  return {
    "user-agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "nl-BE,nl;q=0.9,en-US;q=0.8,en;q=0.7",
    "sec-ch-ua": `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
}

export function assertAhPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new BasketError(`Refusing to fetch non-local AH path '${path}'`);
  }
  return path;
}

function isAccessDenied(status, body) {
  return status === 403 || /access\s+denied|toegang\s+geweigerd/i.test(body);
}

export async function fetchAhDocument(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = options.headers ?? browserMimicHeaders();
  const target = `${AH_ORIGIN}${assertAhPath(path)}`;
  let response;
  try {
    response = await fetchImpl(target, { headers, redirect: "follow" });
  } catch (cause) {
    throw new BasketError(`AH request failed before a response: ${cause instanceof Error ? cause.message : cause}`);
  }
  const finalUrl = response.url || target;
  if (new URL(finalUrl).origin !== AH_ORIGIN) {
    throw new BasketError(`AH redirected off ${AH_ORIGIN} to ${finalUrl}; refusing to follow`);
  }
  const html = await response.text();
  if (isAccessDenied(response.status, html)) {
    throw new BasketError(
      `AH denied the request for ${path} (status ${response.status}). Stop rather than retrying automatically; try again later or use --transport browser`,
    );
  }
  if (!response.ok) {
    throw new BasketError(`AH returned status ${response.status} for ${path}`);
  }
  return { url: finalUrl, html };
}
