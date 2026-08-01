# ah-flex-cli

`ah-flex` is a personal, agent-friendly CLI for preparing a flexible Albert
Heijn Belgium basket without turning the week into a fixed meal plan.

The core idea is **components, not menus**: the agent chooses a useful mix of
pantry, freezer, and fresh ingredients that can be recombined in several ways.
The CLI validates the basket, normalizes unit prices, refreshes visible product
facts, renders a review sheet, and can prepare the **winkelmandje** at
`/mijnlijst` through a visible browser session. It never places an order or
touches payment.

## Boundaries

- This is a custom personal-use browser helper, not an official AH integration.
- It does not guess or call an undocumented cart mutation API. One pinned,
  read-only `member` query is used only to prove that the trusted profile holds
  an authenticated account session before any cart click.
- Search reads fetch the same public `www.ah.be` pages a browser loads, over
  plain HTTPS with the browser's request headers (AH-authorized browser
  mimicry; the edge otherwise answers Access Denied on `/zoeken`). Product
  facts come from the structured payload embedded in those pages, not from
  screen scraping. No cookies or session values are sent or stored for reads.
- Browser writes use one dedicated persistent Firefox profile owned by the CLI
  (default `~/.ah-flex/firefox-profile`, override with `AH_FLEX_PROFILE_DIR`,
  created `0700`). You complete the privacy choice and account login in that
  visible profile exactly once; the CLI then reuses the same trusted browser
  for every run. A login in your normal browser or any other profile does not
  transfer — sessions are bound to the profile that earned them.
- Password entry, verification codes, and the privacy choice stay outside the
  CLI. The CLI never reads, exports, or stores cookies or credentials; the
  profile on disk is the session, and only Firefox reads it.
- Cart/list changes are dry-run by default and require an explicit execution
  flag. Checkout and payment automation do not exist. Once exact line/quantity
  readback succeeds, browser control is released for the human handoff.
- Preflight and readback use each exact product page's scoped basket controls;
  the CLI does not infer cart state from recommendation cards. If a later line
  fails after an earlier click, the CLI prints a partial receipt instead of
  claiming that nothing changed.
- Prices, promotions, availability, and substitutions remain provisional until
  the final browser review.

## Intended workflow

```text
You:   "Next week: chicken and beef, healthy, flexible, buy bulk where useful."
Agent: searches current AH products, compares pack/unit prices, and writes one
       small basket JSON file across pantry/freezer/fresh.
CLI:   checks the basket, makes gaps and stale prices visible, renders review,
       and—after explicit confirmation—adds the selected products to the visible winkelmandje.
You:   review the visible list and place the order yourself.
```

No recipes, weekday slots, pantry database, inventory daemon, nutrition score,
or auto-substitution engine are part of the product.

## Install

Requires Node.js 20+ and a current local Firefox installation.

```sh
npm install
npm link
ah-flex --help
```

Confirmed writes use stock Firefox through Playwright's WebDriver BiDi channel.
All automation runs in the single dedicated persistent profile, so the site
sees the same returning browser you logged into once — not a fresh throwaway
profile on every run.

## Command surface

```text
ah-flex template --brief "chicken and beef next week"
ah-flex basket check basket.json [--json]
ah-flex basket review basket.json --out review.html [--open]
ah-flex search "kipfilet" --limit 8 [--transport http|browser] [--json]
ah-flex session login
ah-flex session status
ah-flex cart apply basket.json                 # dry-run
ah-flex cart apply basket.json --confirm-add
```

`search` defaults to the HTTP transport, which needs no login and no browser.
`--transport browser` reads through the trusted profile as a diagnostic
fallback. Neither transport retries automatically after an Access Denied.

`session login` opens the dedicated profile on ah.be and waits until the pinned
member query proves the account session is active, then closes the browser.
`session status` probes the saved profile without changing anything and exits
non-zero unless the session is authenticated.

During automation, the browser adapter targets bounded pages on
`https://www.ah.be/` only and fails closed when the site's accessible controls
no longer match. After verified readback it removes that automation guard and
leaves the final winkelmandje visible; the user remains the only person who can
continue to login, ordering, or payment.

## Agent workflow

1. Start from `ah-flex template --brief "..."` or
   [`examples/chicken-beef.json`](examples/chicken-beef.json).
2. Let the agent run `ah-flex search "..." --json` for each component and
   compare price per kg, litre, or piece. Search returns candidates; it never
   silently selects the first result.
3. The agent writes the chosen exact AH Belgium URL and current product facts
   into each `selected` field.
4. Run `basket check`, generate the static review, then run `cart apply` without
   the execution flag. Unresolved, unavailable, or stale lines block apply.
5. After reviewing the exact dry-run, use `--confirm-add`. The CLI proves the
   saved profile is authenticated, changes the winkelmandje, rereads every
   exact URL and quantity, and hands the visible browser to the user. An exact
   line that is already present at the requested quantity is reported
   `already-present` and left untouched; a line present below the requested
   quantity is topped up to exactly the reviewed quantity and reported
   `topped-up`; a line the cart already holds more of is never reduced and is
   reported `kept-higher`. Confirmed commands
   require an interactive terminal so the final browser handoff cannot
   disappear into a background job. If the saved session has expired, the CLI
   stops before any click and asks for one `ah-flex session login`.

The checked-in chicken-and-beef example is intentionally unresolved: it is the
recombinable component brief, not fake or stale product data.

## Current live boundary

The data model, report, dry-run, URL guards, fact normalization, and
write/readback orchestration have local test coverage. The live read canary
passed on 2026-07-31: `search` over the HTTP transport returned exact product
URLs, prices, packs, and unit prices from `www.ah.be` after the Akamai edge
had denied both curl and the automated browser profile on `/zoeken`. The
browser-mimicking header set is pinned in `src/http-ah.js`; if AH starts
denying it, refresh the pinned Chrome version there.

The earlier fresh-profile session modes (guest consent bootstrap and HAR cookie
transplant) were removed on 2026-08-01 after the live guest write was denied
before the first click: a brand-new throwaway profile cannot carry the site's
trust, no matter which cookies are copied into it. The dedicated persistent
profile replaces them — one human login, then the same returning browser for
every run.

The write target is the AH page at `/mijnlijst`, which AH labels
**Winkelmandje**. Turning that reviewed cart into an order remains a human
action.

## Session boundary

The CLI never replays captured traffic or guesses a GraphQL write, and it never
imports cookies or credentials from anywhere. The dedicated profile is created
empty, earns its session from exactly one visible human login, and is reused
verbatim afterwards. Raw session material never enters output, receipts, tests,
or Git.

The implementation is custom. Public grocery MCPs informed the generic safety
shape—preview, exact SKU, explicit apply, reread—but no third-party AH client or
MCP code is copied or linked into the runtime.
