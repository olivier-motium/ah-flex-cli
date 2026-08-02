# AH Flex CLI

Build a flexible Albert Heijn Belgium basket with an AI agent, review every
exact product, then add it to your AH basket in a browser you logged into once.

AH Flex is built around **components, not a weekly menu**. It helps an agent
combine pantry, freezer, and fresh food that can be used in several meals,
compare current pack and unit prices, and prepare the basket without automating
checkout or payment.

> [!IMPORTANT]
> AH Flex is an unofficial open-source project. It is not affiliated with,
> endorsed by, or supported by Albert Heijn. Product data and browser flows can
> change; review the basket on ah.be before ordering.

## Add it to local Codex

The easiest path is to paste this into Codex, including a Codex surface in the
ChatGPT desktop app when it has access to the filesystem and terminal on the
same computer:

```text
Install the AH Flex skill from https://github.com/olivier-motium/ah-flex-cli:
create `$HOME/.agents/skills`, clone the repository into
`$HOME/.agents/skills/ah-flex-cli`, run `npm install` there, and verify it with
`node "$HOME/.agents/skills/ah-flex-cli/src/cli.js" --help`. If that destination
already exists, stop and tell me instead of overwriting it. Do not sign in or
change my AH basket yet.
```

After installation, ask for it explicitly with `$ah-flex-cli` in Codex. For
example:

```text
$ah-flex-cli Build a protein-rich basket for two adults and two children for
3.5 days. One adult avoids gluten. Prefer versatile ingredients, freezer value,
and a small fresh-food top-up. Review everything before changing my cart.
```

If the skill does not appear immediately after installation, restart Codex.

ChatGPT and Codex share the same skill format, but ordinary ChatGPT web chats
cannot execute a CLI or control a browser on your computer merely from a GitHub
URL. A future skills-only plugin publication would make AH Flex discoverable on
supported ChatGPT and Codex surfaces, invoked with `@ah-flex-cli` in ChatGPT or
`$ah-flex-cli` in Codex. Until then, use local Codex or a local Codex surface in
ChatGPT desktop.

## Install manually

Requirements:

- macOS or Linux
- Git
- Node.js 20 or newer
- Firefox, Google Chrome, or Microsoft Edge for login and cart preparation
- an AH Belgium account if you want to add products to a basket

Install the CLI:

```sh
git clone https://github.com/olivier-motium/ah-flex-cli.git
cd ah-flex-cli
npm install
npm link
ah-flex --help
```

To install the repository as a personal Codex skill without `npm link`, clone it
directly into the personal skill directory:

```sh
mkdir -p "$HOME/.agents/skills"
git clone https://github.com/olivier-motium/ah-flex-cli.git \
  "$HOME/.agents/skills/ah-flex-cli"
npm --prefix "$HOME/.agents/skills/ah-flex-cli" install
node "$HOME/.agents/skills/ah-flex-cli/src/cli.js" --help
```

Codex detects the root [`SKILL.md`](SKILL.md). Restart Codex if the new skill is
not listed. The skill invokes the checked-out CLI directly, so a global npm link
is optional.

Change into the installed repository before using the examples below. They use
`node src/cli.js`, which works for either installation path. If you ran
`npm link`, `ah-flex` is an equivalent shorter command.

## First basket

Create a basket template from a plain-language brief:

```sh
node src/cli.js template \
  --brief "protein-rich family food for 3.5 days, gluten-free alternatives" \
  --out basket.json
```

Search current AH Belgium products and compare the returned candidates:

```sh
node src/cli.js search "kipfilet voordeelverpakking" --limit 8 --json
node src/cli.js search "glutenvrij brood" --limit 8 --json
```

Fill each `selected` field in `basket.json` with one exact result, then validate
and render a review:

```sh
node src/cli.js basket check basket.json
node src/cli.js basket review basket.json --out review.html --open
node src/cli.js cart apply basket.json
```

The last command is a dry-run. It shows what would change without touching your
AH basket.

When the exact products and quantities are correct, apply them in a visible
browser:

```sh
node src/cli.js cart apply basket.json --browser firefox --confirm-add
```

Confirmed apply and `session login` require an interactive terminal so the
visible browser can be handed to you. If the agent's shell is non-interactive,
have it print the exact reviewed command and paste that command into your own
terminal.

On the first confirmed run, AH Flex opens a dedicated browser profile. Log in
there once; later runs reuse that browser-owned session. Chrome and Edge are
also supported:

```sh
node src/cli.js session login --browser chrome
node src/cli.js session status --browser chrome
node src/cli.js cart apply basket.json --browser chrome --confirm-add
```

Each browser has a separate profile and therefore needs its own one-time login.
Safari is not supported because Safari automation cannot reuse the human-owned
persistent profile this workflow requires.

## What the agent should do

1. Ask for the household, time horizon, dietary constraints, priorities, and
   foods that are already available.
2. Plan versatile pantry, freezer, and fresh components instead of assigning a
   fixed meal to every day.
3. Search current products and compare exact pack sizes, unit prices,
   availability, and promotions. Never silently choose the first result.
4. Write the selected product URL and facts into the basket JSON.
5. Run `basket check`, create the review, and run the cart dry-run.
6. Change the live basket only after the user confirms the exact dry-run.
7. Leave checkout, substitutions, and payment to the user.

The checked-in [`examples/chicken-beef.json`](examples/chicken-beef.json) is an
unresolved example brief. It intentionally contains no stale or invented
product selection.

## Commands

```text
ah-flex template --brief "chicken and beef next week" [--out basket.json]
ah-flex schema
ah-flex basket check basket.json [--json]
ah-flex basket review basket.json --out review.html [--open]
ah-flex search "kipfilet" [--limit 8] [--transport http|browser] [--browser firefox|chrome|edge] [--json]
ah-flex session login [--browser firefox|chrome|edge]
ah-flex session status [--browser firefox|chrome|edge] [--json]
ah-flex cart apply basket.json [--browser firefox|chrome|edge] [--confirm-add] [--json]
```

`search` uses the cookie-free HTTP transport by default. The optional browser
transport uses the selected dedicated profile as a diagnostic fallback. Neither
transport retries automatically after an Access Denied response.

## Safety and privacy

- Basket changes are dry-run by default and require `--confirm-add` in an
  interactive terminal.
- AH Flex validates the complete current basket before writing, sends each
  required mutation at most once, and reads the result back. An uncertain write
  returns a partial receipt instead of retrying.
- Do not edit the same basket from another tab or device while a confirmed apply
  is running. AH does not expose transactional versioning for quantity updates.
- Browser profiles live at `~/.ah-flex/{firefox,chrome,edge}-profile` with
  private permissions. The CLI never reads, copies, prints, exports, or migrates
  cookies, tokens, passwords, or browser databases.
- Automated page navigation is guarded to bounded `https://www.ah.be/` pages
  until verified basket readback.
- Checkout, ordering, payment, accepting substitutions, and automatic product
  selection are deliberately out of scope.
- Prices, promotions, availability, and substitutions remain provisional until
  the final review on ah.be.

The basket operations are narrow, pinned calls made inside AH's own authenticated
`/mijnlijst` page. They are not a public or official AH API. Schema or page drift
fails closed.

## Development

```sh
npm install
npm test
npm run check
```

The optional installed-browser lifecycle check opens temporary visible Firefox,
Chrome, and Edge windows against a local `127.0.0.1` fixture only:

```sh
npm run test:e2e:browsers
```

That test proves local profile creation and persistence. It does not prove AH
authentication or make a live basket change.

Contributions are welcome. Keep live credentials and browser profiles out of
issues, fixtures, logs, and pull requests. For security-sensitive reports, open
a minimal issue without secrets or session material.

## License

[MIT](LICENSE)
