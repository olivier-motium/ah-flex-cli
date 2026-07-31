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
  read-only `member` query is used only to prove that the final context is
  explicitly anonymous or authenticated before any cart click.
- Search reads fetch the same public `www.ah.be` pages a browser loads, over
  plain HTTPS with the browser's request headers (AH-authorized browser
  mimicry; the edge otherwise answers Access Denied on `/zoeken`). Product
  facts come from the structured payload embedded in those pages, not from
  screen scraping. No cookies or session values are sent or stored for reads.
- With explicit `--har`, it imports only six allowlisted AH session/routing
  cookies into a fresh nonpersistent Firefox context. Akamai cookies are
  excluded, values are never logged, and a live `member` query must prove the
  session before any cart click.
- With explicit `--guest`, a throwaway Firefox context selects **Weigeren** in
  AH's consent dialog. Only `consentBeta` and `consentSettings` are copied into
  a second fresh context; account, HAR, routing, and Akamai cookies are not.
  The pinned live member query must return an explicit `null` member before the
  guest cart can change.
- Password entry and verification stay outside the CLI.
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
All helper contexts are nonpersistent. Guest consent is bootstrapped entirely in
memory, and an explicitly supplied HAR session exists only for that process;
neither is copied into a browser profile.

## Command surface

```text
ah-flex template --brief "chicken and beef next week"
ah-flex basket check basket.json [--json]
ah-flex basket review basket.json --out review.html [--open]
ah-flex search "kipfilet" --limit 8 [--transport http|browser] [--json]
ah-flex session login
ah-flex cart apply basket.json                 # dry-run
ah-flex cart apply basket.json --confirm-add --guest
ah-flex cart apply basket.json --confirm-add --har /path/to/AH.har
```

`search` defaults to the HTTP transport, which needs no login and no browser.
`--transport browser` keeps the original visible-browser read as a diagnostic
fallback. Neither transport retries automatically after an Access Denied.

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
5. After reviewing the exact dry-run, use `--confirm-add --guest` for a fresh
   unauthenticated cart or `--confirm-add --har ...` for a captured account
   session. The CLI proves the live member state, changes the winkelmandje,
   rereads every exact URL and quantity, and hands the visible browser to the
   user. The HAR-backed path currently accepts one exact product line per run;
   guest mode accepts the actionable basket. Confirmed commands require an
   interactive terminal so the final browser handoff cannot disappear into a
   background job.

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

The first Chromium write canary reached an add click but could not verify the
state transition; its partial receipt was treated as ambiguous. The completed
Firefox guest canary on 2026-07-31 used exact product `wi481844`, added one
`AH Tomaten passata gezeefd`, reread that exact URL at quantity `1`, and opened
the verified `/mijnlijst` cart. The CLI receipt reported `ADDED`; the visible
cart total was €0.59. Checkout and payment were not opened.

The supplied HAR still parses against the pinned member request, but its live
session no longer proves an authenticated member. That path therefore stops
before any cart click, as designed. Guest mode does not read the HAR.

The write target is the AH page at `/mijnlijst`, which AH labels
**Winkelmandje**. Turning that reviewed cart into an order remains a human
action.

## HAR boundary

The supplied capture contains authenticated read queries but no cart mutation,
so the CLI never replays it or guesses a GraphQL write. `--har` uses the newest
successful basket request only to obtain a narrow cookie allowlist and requires
the capture to contain the exact pinned member query used by the CLI's live
authentication check. Everything stays in memory; raw HAR content and cookie
values never enter output, receipts, tests, or Git.

The implementation is custom. Public grocery MCPs informed the generic safety
shape—preview, exact SKU, explicit apply, reread—but no third-party AH client or
MCP code is copied or linked into the runtime.
