import test from "node:test";
import assert from "node:assert/strict";
import { parseAhHarSession } from "../src/har-session.js";
import { BasketError } from "../src/basket.js";
import { MEMBER_QUERY } from "../src/member-query.js";

function entry(operationName, { status = 200, url = "https://www.ah.be/gql", queryKind = "query" } = {}) {
  return {
    startedDateTime: "2026-07-31T15:40:42.000Z",
    request: {
      method: "POST",
      url,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "x-client-name", value: "ah-web" },
        { name: "cookie", value: "must-not-be-forwarded" },
      ],
      cookies: [
        { name: "jsessionid_myah", value: "sentinel-session" },
        { name: "ASC", value: "sentinel-asc" },
        { name: "RCC", value: "sentinel-rcc" },
        { name: "_abck", value: "sentinel-akamai-cookie" },
      ],
      postData: {
        text: JSON.stringify({
          operationName,
          query: operationName === "member" && queryKind === "query" ? MEMBER_QUERY : `${queryKind} ${operationName} { ok }`,
          variables: {},
        }),
      },
    },
    response: { status },
  };
}

function validHar() {
  return { log: { version: "1.2", entries: [entry("member"), entry("basket")] } };
}

test("HAR parser extracts only the narrow AH session and member verification request", () => {
  const session = parseAhHarSession(validHar());
  assert.deepEqual(session.cookies.map(({ name }) => name).sort(), ["ASC", "RCC", "jsessionid_myah"]);
  assert.equal(session.memberRequest.headers.cookie, undefined);
  assert.equal(session.memberRequest.headers["content-type"], "application/json");
  assert.equal(session.memberRequest.body.operationName, "member");
  assert.deepEqual(session.memberRequest.body.variables, {});
  assert.equal(session.memberRequest.body.extensions, undefined);
});

test("HAR parser rejects an unpinned member query", () => {
  const har = validHar();
  har.log.entries[0].request.postData.text = JSON.stringify({
    operationName: "member",
    query: "query member { member { __typename } }",
    variables: {},
  });
  assert.throws(() => parseAhHarSession(har), /pinned member query/);
});

test("HAR parser rejects off-origin, mutation, and incomplete session captures", () => {
  assert.throws(
    () => parseAhHarSession({ log: { version: "1.2", entries: [entry("member"), entry("basket", { url: "https://example.com/gql" })] } }),
    BasketError,
  );
  assert.throws(
    () => parseAhHarSession({ log: { version: "1.2", entries: [entry("member", { queryKind: "mutation" }), entry("basket")] } }),
    BasketError,
  );
  const incomplete = validHar();
  incomplete.log.entries[1].request.cookies = [];
  assert.throws(() => parseAhHarSession(incomplete), /required authenticated session cookies/);
});
