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
- Confirmed writes use only the pinned `basketItemsAdd` and `basketItemsUpdate`
  operations shipped by AH's currently served `/mijnlijst` client. They run as
  same-origin requests inside the authenticated page; this is personal browser
  automation, not a public or official API. A separate pinned `member` query
  proves the trusted profile holds an authenticated account before any write.
- Default search reads fetch public `www.ah.be` pages over plain HTTPS with a
  pinned browser header set; the edge otherwise answers Access Denied on
  `/zoeken`. Product facts come from the structured payload embedded in those
  pages, not from screen scraping. This default transport sends no cookies or
  stored session values. The optional browser diagnostic transport uses the
  dedicated persistent profile described below.
- Browser writes use one fixed dedicated persistent profile per supported browser,
  selected with `--browser` and owned by the CLI:
  `firefox` is Firefox through the `moz-firefox` channel at
  `~/.ah-flex/firefox-profile`, `chrome` is Google Chrome through the `chrome`
  channel at `~/.ah-flex/chrome-profile`, and `edge` is Microsoft Edge through
  the `msedge` channel at `~/.ah-flex/edge-profile`. The unflagged default is
  Firefox, preserving the original default path and behavior. The CLI exposes
  no profile-directory override, fallback, browser discovery, config import, or
  everyday-browser profile import. Before any selected browser launches, its
  final path component must be a current-user-owned directory with exactly
  private mode `0700`; a missing target is created once with `0700` and its
  effective mode is verified. Existing symlinks, non-directories, wrong-owner
  targets, and broader modes are rejected without chmodding them. Each selected
  browser profile needs its own one-time visible login; profiles never share
  cookies, tokens, or profile databases. A confirmed apply uses the existing
  selected-browser session immediately; if AH says that profile is cleanly
  anonymous, it opens login in that same dedicated window and resumes the
  reviewed apply automatically. `session login` is an optional setup/repair
  command. Authentication stays in the browser-owned profile, which every
  later run reuses; the CLI does not inspect or copy browser cookie, token, or
  profile database data. Password entry and verification codes stay outside the
  CLI.
- Cart/list changes are dry-run by default and require an explicit execution
  flag. Checkout and payment automation do not exist. Once exact line/quantity
  readback succeeds, browser control is released for the human handoff. If AH
  presents its privacy prompt during a confirmed apply, the CLI selects
  **Weigeren** (necessary cookies only) before the first basket mutation; it never
  accepts optional advertising or personalization cookies on the user's behalf.
- Preflight reads the complete basket through `/mijnlijst`'s own narrow GraphQL
  query and validates every selected `wi` product ID before any write. Missing
  products are sent in one add batch; only still-unchanged lower quantities are
  sent in one update batch after a fresh intervening read. Mutations are never
  retried automatically. Final GraphQL readback is independently checked against
  the reloaded visible list. Any post-dispatch uncertainty produces a partial
  receipt instead of a false success or retry.
- AH's quantity update has no exposed compare-and-swap version. Do not edit the
  same basket in another tab or device while `cart apply` runs: the CLI rereads
  immediately before a top-up and aborts on drift it observes, but a simultaneous
  write after that read can still be overwritten. Final readback proves the ending
  state, not transactional isolation.
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

Requires Node.js 20+ and at least one current local installation of Firefox,
Google Chrome, or Microsoft Edge. Firefox remains the default. Select Chrome or
Edge explicitly with `--browser chrome` or `--browser edge`.

```sh
npm install
npm link
ah-flex --help
```

The opt-in installed-browser lifecycle proof runs with:

```sh
npm run test:e2e:browsers
```

This command launches visible temporary Firefox, Google Chrome, and Microsoft
Edge windows sequentially. Its automated page traffic is constrained to a
`127.0.0.1` fixture; Playwright page routing is not an OS-level firewall for a
browser's own background services. Passing proves installed-browser profile
creation and localStorage persistence across a close/relaunch; it is not AH
authentication proof or cart proof.

Confirmed writes use the selected installed browser through Playwright's
branded browser channel. All automation runs in that browser's dedicated
persistent profile, so the site sees the same returning browser you logged into
once — not a fresh throwaway profile on every run.

Safari is deliberately not a selector. Safari WebDriver creates isolated
automation sessions and cannot supply the reusable, browser-owned human-login
profile this CLI requires. Playwright's WebKit build is a test browser, not
Safari, so `--browser safari` and `--browser webkit` both fail with an explicit
explanation instead of silently launching a substitute or changing Safari
security settings.

## Command surface

```text
ah-flex template --brief "chicken and beef next week"
ah-flex basket check basket.json [--json]
ah-flex basket review basket.json --out review.html [--open]
ah-flex search "kipfilet" --limit 8 [--transport http|browser] [--browser firefox|chrome|edge] [--json]
ah-flex session login [--browser firefox|chrome|edge]       # optional setup/repair
ah-flex session status [--browser firefox|chrome|edge]
ah-flex cart apply basket.json [--browser firefox|chrome|edge]                 # dry-run
ah-flex cart apply basket.json --browser chrome --confirm-add
```

`search` defaults to the HTTP transport, which needs no login and no browser.
`--transport browser` reads through the trusted profile as a diagnostic
fallback. Neither transport retries automatically after an Access Denied.

`session login` is an optional setup/repair command: it opens the selected
browser's dedicated profile on ah.be and waits until the pinned member query
proves the account session is active, then closes the browser. A normal
confirmed apply does not require it first. If AH has expired the selected
profile's saved session, the confirmed command opens login in that same AH
window and resumes that reviewed apply automatically. If AH emails a login
link, open or paste it in that dedicated window so the session lands in the
reusable profile rather than your everyday browser. Each browser has its own
login; switching `--browser` does not copy session data. `session status`
additionally proves that `/mijnlijst` is usable and not denied; it exits
non-zero unless both checks make that selected profile ready for cart apply.

Authentication is established only through the visible browser login in the
dedicated profile. The CLI never sees credentials or session values.
`session status` uses the live member query and usable `/mijnlijst` page as the
authentication gate.

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
   saved profile is authenticated, resolves any delayed privacy prompt to
   necessary cookies only, computes the complete change set, sends at most one
   exact add batch, rereads before any safe top-up batch, and then checks every
   requested product and quantity through both fresh GraphQL and one reloaded
   `/mijnlijst` page before handing the visible browser to the user.
   An exact line that is already present at the requested quantity is reported
   `already-present` and left untouched; a line present below the requested
   quantity is topped up to exactly the reviewed quantity and reported
   `topped-up`; a line observed above the requested quantity before dispatch is
   left untouched and reported `kept-higher`. Confirmed commands
   require an interactive terminal so the final browser handoff cannot
   disappear into a background job. If AH has expired the saved session, the
   command asks you to log in in the dedicated AH window and resumes this same
   reviewed apply automatically. A separate `session login` is optional.

The checked-in chicken-and-beef example is intentionally unresolved: it is the
recombinable component brief, not fake or stale product data.

## Current live boundary

The data model, report, dry-run, URL guards, fact normalization, and
write/readback orchestration have local test coverage. Firefox, Google Chrome,
and Microsoft Edge branded-channel/profile lifecycle checks are available as a
local opt-in E2E suite. The live read canary
passed on 2026-07-31: `search` over the HTTP transport returned exact product
URLs, prices, packs, and unit prices from `www.ah.be` after the Akamai edge
had denied both curl and the automated browser profile on `/zoeken`. The
browser-mimicking header set is pinned in `src/http-ah.js`; if AH starts
denying it, refresh the pinned Chrome version there.

The earlier fresh-profile session modes (guest consent bootstrap and HAR replay)
were removed on 2026-08-01 after the live guest write was denied before the
first click. The dedicated persistent profile replaces them: it is initialized
once and then reused as the same returning browser. Authentication is established
only in that browser-owned profile, and `session status` remains the live gate.

The write target is the AH page at `/mijnlijst`, which AH labels
**Winkelmandje**. Turning that reviewed cart into an order remains a human
action.

The authenticated write/readback canary passed on 2026-08-01: 10 missing exact
lines were added in one batch, 26 existing exact lines were preserved, and
36 products / 42 packs were verified by fresh GraphQL and reloaded DOM
readbacks. No checkout or ordering page was opened. The anonymous-to-login
same-command continuation is covered locally; its first clean-profile live run
has not yet been repeated against AH.

## Session boundary

The CLI never replays captured traffic, copies a third-party client, or scrapes
runtime bundles to discover mutations. Its three basket operations are narrow
and pinned to the currently served AH `/mijnlijst` contract; schema drift fails
closed. The dedicated profile is created empty and reused afterwards. It can
earn and retain its session through the visible browser login flow; the CLI does
not inspect, copy, export, or migrate browser cookie or token data. Raw session
material never enters output, receipts, tests, intermediary files, command
arguments, or Git.

The implementation is custom. Public grocery MCPs informed the generic safety
shape—preview, exact SKU, explicit apply, reread—but no third-party AH client or
MCP code is copied or linked into the runtime.
