# ah-flex-cli

`ah-flex` is a personal, agent-friendly CLI for preparing a flexible Albert
Heijn Belgium basket without turning the week into a fixed meal plan.

The core idea is **components, not menus**: the agent chooses a useful mix of
pantry, freezer, and fresh ingredients that can be recombined in several ways.
The CLI validates the basket, normalizes unit prices, refreshes visible product
facts, renders a review sheet, and can prepare **Mijn lijst** through a visible
browser session. It never places an order or touches payment.

## Boundaries

- This is a custom personal-use browser helper, not an official AH integration.
- It does not call or clone AH's undocumented GraphQL or mobile APIs.
- It never imports cookies, passwords, tokens, or session values from a HAR.
- Login and verification stay inside a user-visible browser profile.
- Cart/list changes are dry-run by default and require an explicit execution
  flag. Checkout and payment automation do not exist.
- Prices, promotions, availability, and substitutions remain provisional until
  the final browser review.

## Intended workflow

```text
You:   "Next week: chicken and beef, healthy, flexible, buy bulk where useful."
Agent: searches current AH products, compares pack/unit prices, and writes one
       small basket JSON file across pantry/freezer/fresh.
CLI:   checks the basket, makes gaps and stale prices visible, renders review,
       and—after explicit confirmation—adds the selected products to Mijn lijst.
You:   review the visible list and place the order yourself.
```

No recipes, weekday slots, pantry database, inventory daemon, nutrition score,
or auto-substitution engine are part of the product.

## Planned command surface

```text
ah-flex template --brief "chicken and beef next week"
ah-flex basket check basket.json [--json]
ah-flex basket review basket.json --out review.html [--open]
ah-flex search "kipfilet" --limit 8 [--json]
ah-flex session login
ah-flex cart apply basket.json                 # dry-run
ah-flex cart apply basket.json --confirm-add   # visible browser writes only
```

The browser adapter targets `https://www.ah.be/` only and fails closed when the
site's accessible controls no longer match. It leaves the final list visible;
the user remains the only person who can continue to ordering or payment.

## Why the HAR is not a runtime dependency

The supplied capture proved that the current Belgian site uses cookie-backed
browser sessions and exposed read-only GraphQL operations, but it contained no
cart mutation. It is credential-bearing evidence, not configuration. No HAR
contents are copied into this repository.

