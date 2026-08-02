---
name: ah-flex-cli
description: Prepare flexible Albert Heijn Belgium grocery baskets with current exact-product searches, pack and unit-price comparison, dietary constraints, basket JSON validation, human review, one-time browser login, and guarded cart application. Use for AH Belgium grocery planning, healthy or protein-rich shopping, bulk/freezer/fresh combinations, gluten-free alternatives, or requests to prepare an AH basket without automating checkout or payment.
---

# AH Flex CLI

Use the CLI in this skill's directory to turn a household food brief into a
reviewed AH Belgium basket. Optimize for recombinable ingredients rather than a
fixed daily menu.

## Run the CLI

Treat the directory containing this `SKILL.md` as `<skill-root>`.

1. Verify Node.js 20 or newer with `node --version`.
2. Run `npm install` in `<skill-root>` if `node_modules` is absent.
3. Invoke commands as `node <skill-root>/src/cli.js ...`. Use `ah-flex ...`
   instead only when the package is already linked.

Never inspect, copy, print, export, or persist browser cookies, tokens,
credentials, profile databases, or session values.

## Prepare a basket

1. Gather the household size, number of days, dietary constraints, desired
   proteins or dishes, budget priorities, storage capacity, and relevant pantry
   items. Make reasonable assumptions only when they do not materially change
   the basket.
2. Split the plan across pantry, freezer, and a deliberately smaller fresh-food
   share. Prefer ingredients that support several meals and gluten-free sides or
   substitutions where requested.
3. Create a template with `template --brief "..." --out basket.json`.
4. Search each component with `search "..." --limit 8 --json`. Search returns
   candidates; never silently select the first one. Compare exact product,
   quantity, pack size, unit-price basis, availability, and promotion. Treat
   unparseable multipacks and provisional promotions visibly rather than
   guessing.
5. Put one reviewed exact `https://www.ah.be/producten/product/wi...` result in
   each item's `selected` field. Preserve the returned facts and timestamp.
6. Run `basket check basket.json`, then
   `basket review basket.json --out review.html`. Run
   `cart apply basket.json` without `--confirm-add` to produce the final dry-run.
7. Present the exact products, pack quantities, estimated price, unresolved
   lines, and important assumptions to the user.

Do not work around Access Denied responses, discover private endpoints, replay
captured sessions, or retry mutations. Report the failure and leave the basket
unchanged.

## Apply only after review

Treat a live cart change as a consequential external action. Obtain the user's
current confirmation of the exact dry-run before invoking
`cart apply basket.json --browser <browser> --confirm-add`.

Confirmed apply and `session login` require an interactive terminal for the
visible browser handoff. If the current agent shell is non-interactive, print
the exact reviewed command for the user to paste into their own terminal; do
not weaken or bypass the terminal guard.

Support `firefox`, `chrome`, and `edge`. The first confirmed apply opens the
selected browser's dedicated persistent profile; let the user complete login in
that window. Later runs reuse the browser-owned profile. `session login` is an
optional setup or repair command, and `session status --json` proves readiness.

After apply, report the CLI receipt, including added, topped-up, already-present,
kept-higher, unresolved, or uncertain lines. Never continue to checkout,
ordering, substitutions, or payment. Leave the verified visible basket for the
user.

## Guardrails

- Keep dry-run as the default.
- Require exact product URLs and reviewed quantities; never auto-substitute.
- Do not edit the same AH basket from another tab or device during apply.
- Keep credentials and browser state out of prompts, files, logs, tests, Git,
  and responses.
- Treat prices, promotions, stock, and nutrition claims as current but
  provisional until the user reviews ah.be.
- Use the local fixture tests for development. Never create an unrequested live
  authentication or cart canary.
