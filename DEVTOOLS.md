# DevTools Testing Cheat Sheet

Manually drive site Lua commands for every published adapter from the Chrome DevTools console.
See `SCHEMA.md` for the full parameter schema of every command.

## Daily driver: the `ax` CLI (recommended)

`tools/ax.mjs` does everything below from your shell — launch/attach the dev Chrome, find the
`AXSDK Assistant` context, inject your LOCAL Lua, and run any `AX_*` command — without opening
DevTools, pushing to GitHub, or reloading the extension.

```bash
node tools/ax.mjs chrome thumbtack                 # launch dev Chrome (port 9224) + open the site
node tools/ax.mjs sync thumbtack                   # build -> store Lua + flows -> remote OFF -> reload -> verify
node tools/ax.mjs --local run AX_resolve_zip '{"address":"San Francisco, CA"}'
node tools/ax.mjs --local run AX_search_service '{"query":"house cleaning","zip_code":"94101"}'
node tools/ax.mjs run AX_detect_page '{}'          # page type + ids
node tools/ax.mjs page                             # current url + AX_read_page situational read
node tools/ax.mjs ls                               # loaded commands (shows local overrides)
node tools/ax.mjs repl                             # interactive loop
```

Two ways to run your LOCAL Lua (and flows) against the live extension:
- **`ax sync [site]`** (production-faithful): builds the Lua bundles + reads the local flows, writes
  both to the extension stores (`axsdk:lua` and `axsdk:flows`, keyed `":"` = _common, `":"+domain` =
  site), turns **OFF** "Use remote site Lua scripts" **and** "Use remote sites flows" (saved flows stay
  ON → `clientFlows {remoteSites:false, stored:true}`), and reloads so the SDK runs the STORED scripts
  (scriptId `stored-lua:` / `stored-lua:<domain>`) + STORED flows instead of remote GitHub. **Persisted
  → survives the navigations of a multi-step flow.** `sync` prints `fromStore`/`fromRemote` +
  `appliedClientFlows`; verify with `ax ls` (no `<site>/scripts/...` ids). `run --store` builds+syncs then runs.
- **`--local` / `ax load`** (quick, in-memory): `lua.load`-overrides the GitHub scripts (`ax ls`
  shows `overriddenBy: ax-local-...`). Fast, but overrides reset on a full navigation; re-run it.

`node tools/ax.mjs help` lists all commands/flags. The console workflow below remains valid for
ad-hoc poking inside DevTools.

## Isolated extension playground

Use the playground when a local workspace must run against a dedicated, persistent Chrome profile
without touching the daily `ax` profile on port `9224`.

```bash
# First-time manual development-extension setup. Creates only the dedicated profile directory,
# opens headed Chrome at chrome://extensions, and waits for you to install/configure the extension.
node tools/playground.mjs setup --root=playground

# After enabling Debug logging in the extension settings, store the local workspace and verify it.
node tools/playground.mjs sync --root=playground
node tools/playground.mjs repl --root=playground --no-sync
```

`setup` intentionally starts Chrome **without** `--load-extension`; install the unpacked extension
from the displayed directory yourself, then enter development credentials and enable Debug logging.
It never reads, prints, or writes credentials. `sync` uses port `9235` and
`%LOCALAPPDATA%/AXSDKPlaygroundChromeProfile`, writes the workspace's local index/Lua/flows to that
profile only, forces `remote_sites:false`, and verifies stored—not remote or in-memory—Lua sources.

## 1. Select the right execution context

`window._AXSDK` exists only when the extension runs in **debug mode**, and only in the
**content-script** context — not the page's default JS world.

1. Open the target published site in the dev Chrome with the extension loaded.
2. DevTools → **Console** → context dropdown (top-left) → select **`AXSDK Assistant`**
   (`chrome-extension://dldlgmekahifbogjphgglkhibclglmpf`).
3. Verify:

```js
const lua = window._AXSDK?.lua ?? window._AXLUA;
lua.listCommands();   // AX_ commands loaded for the current site
lua.status();         // enabled + loaded scripts
```

Scripts are fetched from `raw.githubusercontent.com/layorixinc/axsdk-sites/main/<site>/scripts/*`,
so common commands load everywhere and the active site's local commands load on its registered hosts.

## 2. Console helpers

```js
// Durable path — use this for everything (handles nav + reload-driven flows). result is JSON.
async function axrun(cmd, args = {}) {
  const lua = window._AXSDK?.lua ?? window._AXLUA;
  const r = await lua.run(cmd, args, { timeoutMs: 60000 });
  const out = { status: r.status, deferId: r.deferId, result: r.result ? JSON.parse(r.result) : null };
  console.log(cmd, out);
  return out;
}

// Single Lua turn (no deferred context). Read-only, no-navigation checks only;
// durable steps return { ok:false, reason:"pending" }. r.value is the command's return.
async function axcall(cmd, args = {}) {
  const lua = window._AXSDK?.lua ?? window._AXLUA;
  const r = await lua.call(cmd, args);
  console.log(cmd, r);
  return r;
}
```

## 3. Amazon commands (on amazon.com)

| Command | Side effect | Example |
|---|---|---|
| `AX_search_product` | none | `axrun("AX_search_product", { query: "coffee" })` |
| `AX_view_product` | nav | `axrun("AX_view_product", { product_id: "B0G4SWN34T" })` |
| `AX_update_product` | selection | `axrun("AX_update_product", { product_id: "B0…", variations: { Size: "Large" } })` |
| `AX_add_to_cart` | **adds to cart** | `axrun("AX_add_to_cart", { product_id: "B0G4SWN34T", quantity: 1 })` |
| `AX_view_cart` | nav | `axrun("AX_view_cart", {})` |
| `AX_update_cart` | **qty / delete** | `axrun("AX_update_cart", { product_id: "B0…", quantity: 0 })` (`0` = delete) |
| `AX_checkout` | nav (no order) | `axrun("AX_checkout", {})` |

- Next page: pass the previous result's `cursor` back into `AX_search_product`.
- `AX_checkout` stops at the checkout screen (`place_order_available`) and never places an order;
  the warranty / protection-plan upsell is auto-declined.

### Representative multi-store commerce commands

The common dispatcher supports `amazon`, `walmart`, `ebay`, `aliexpress`, `etsy`, `coupang`,
`naver-shopping`, `gmarket`, `11st`, and `ssg`.

```js
await axrun("AX_search_store_product", {
  site: "walmart",
  query: "Logitech M185",
  quantity: 1
});
```

Broad queries use the identity pipeline before exact comparison:

```js
await axrun("AX_prepare_product_identity", {
  product_category: "wireless mouse",
  requested_brand: "Logitech",
  stores: [{ site: "11st" }, { site: "walmart" }]
});
```

The flow searches at most three requested stores for grounded model options, pauses for a model
selection, verifies every final offer against the locked identity, and ranks only exact matches.
Ambiguous/mismatched listings are reported separately. `AX_resolve_product_option` rejects stale
option versions; `AX_resolve_store_offer` rejects stale comparison versions and any selection made
before a separate offer-presentation turn.

`AX_add_store_product_to_cart` is mutation-capable and rejects calls unless all three scoped approvals
are current: `cart_approval:"user_selected_compared_offer"`,
`identity_approval:"locked_product_identity"`, and
`comparison_approval:"current_comparison"`, with matching non-empty `identity_id` and `comparison_id`.
It revalidates the expected manufacturer model and price before clicking, and never checks out or places
an order. Naver Shopping returns `add_to_cart_unsupported`; CAPTCHA, login, security-verification, and
access-denied pages are reported as classified errors.

Verification:

```bash
npm run test:commerce
npm run test:commerce:live:all
npm run test:commerce:live:expanded
npm run test:commerce:live:discovery
```

## 4. Thumbtack commands (on thumbtack.com)

| Command | Side effect | Example |
|---|---|---|
| `AX_resolve_zip` | net fetch | `axrun("AX_resolve_zip", { address: "San Francisco, CA" })` |
| `AX_read_page` | read-only | `axrun("AX_read_page", { mode: "article" })` · `axrun("AX_read_page", { scope: "[data-test=\"request-flow-step--active\"]", mode: "structure" })` |
| `AX_search_service` | nav | `axrun("AX_search_service", { query: "house cleaning", zip_code: "94105" })` |
| `AX_view_service` | nav | `axrun("AX_view_service", { url: "<pro URL from search>" })` |
| `AX_update_search` | filter change | `axrun("AX_update_search", { value: "Every 2 weeks", option: "Frequency" })` |
| `AX_answer_quote` | quote-flow step | `axrun("AX_answer_quote", { auto: true, user_requirements: "Standard home cleaning, no pets." })` |
| `AX_open_quote` | opens quote (never submits) | `axrun("AX_open_quote", { url: "<pro URL>", submit: false })` |
| `AX_submit_quote` | submits quote | `axrun("AX_submit_quote", { confirm: true })` |

- `AX_search_service` requires `query` plus `zip_code` **or** `address`.
- `AX_resolve_zip` is **site-agnostic** — it lives in `_common/scripts/` and loads on every site, so you can
  call it from any page (e.g. google.com) before navigating to a provider. Resolution ladder: explicit 5-digit
  `zip_code` → a 5-digit ZIP embedded in the text → forward geocode (**Photon** primary, **Nominatim** fallback)
  + **US Census ZCTA** reverse (robust for `"City, ST"` and full addresses) → Census `onelineaddress` (full
  street only). No API key. US-only.
- `AX_read_page` is **site-agnostic** (in `_common/scripts/`, loads everywhere) and **read-only** — it converts
  the current page's HTML at `scope` (CSS selector, default `body`) to Markdown for LLM situational awareness.
  `mode`: `article` (Readability strips nav/ads — best for content/profile pages), `structure` (keeps forms,
  options, buttons — best for the quote dialog / results), `auto` (article when a real article is found, else
  structure). Returns `{ ok, markdown, mode_used, title, url, length, extracted, truncated }` or
  `{ ok: false, error }` (`scope_not_found` when the selector matches nothing). Output is capped by `max_chars`
  (default 6000; `truncated: true` when cut). Requires the rebuilt extension that exposes the `html` Lua namespace.
- `AX_view_service` / `AX_open_quote` `url` = a pro profile URL from `AX_search_service` results.

### Quote request flow test recipe

1. Open the flow: `let r = await axrun("AX_open_quote", { url: proUrl, submit: false })`.
2. Auto-progress ordinary project steps: `r = await axrun("AX_answer_quote", { auto: true, user_requirements: "Standard home cleaning, no pets." })`.
3. For exact radio control, pass the visible option label: `r = await axrun("AX_answer_quote", { value: "Home" })`.
4. For exact checkbox control, pass visible labels: `r = await axrun("AX_answer_quote", { selections: ["Inside cabinets"] })`.
5. For the details textarea, pass text only: `r = await axrun("AX_answer_quote", { text: "Need a standard cleaning estimate. Do not send yet." })`.
6. For contact steps, pass only test-safe/reserved data in dev: `r = await axrun("AX_answer_quote", { email: "thumbtack-test@example.com", first_name: "Test", last_name: "User", phone: "4155550100", zip_code: "94101" })`.
7. Optional photo upload and checkbox-only steps are skipped automatically when safe; do not upload test files.
8. Stop when `r.flow.reached_submit_step` is `true`, `r.flow.advance_reason` is `"unsafe_advance_button"`, or `r.flow.advance_reason` is `"advance_not_confirmed"`.
9. Submit only when intentional: `await axrun("AX_submit_quote", { confirm: true, email: "thumbtack-test@example.com", first_name: "Test", last_name: "User", phone: "4155550100" })`.

`AX_answer_quote` only clicks buttons labeled `Next`, `Continue`, or optional-step `Skip`; `auto:true` selects/fills ordinary project steps from `user_requirements`, refuses send/submit/quote-request buttons, and returns `contact_update_required` when Thumbtack rejects a contact field.
`AX_submit_quote` requires `confirm: true`, clicks the final `Submit`, and returns before/after quote details or a retryable contact error.
Set `advance: false` to select/fill the current step without moving forward.

### Live multi-service and multi-quote runners

```bash
# (removed with the durable layer — drive the flow with `node tools/ax.mjs send "<message>"`)
# (removed with the durable layer — drive the flow with `node tools/ax.mjs send "<message>"`)
# Actual submit for one scenario/item (default port 9224):
# (removed with the durable layer — drive the flow with `node tools/ax.mjs send "<message>"`)
```

Default multi-service scenarios: `house cleaning`, `lawn mowing`, `handyman` in San Francisco.
`--multi-quote` uses one query/address input, selects up to `--quote-count` candidates from the
same search result, and drives each quote item sequentially with the existing single-flow Lua tools.
`--submit-quote` progresses every scenario or quote item toward the final `Submit` button using
reserved/fake contact data. It never clicks `Submit`; logged-out/test accounts may stop at a safe
login/contact gate instead. `--actual-submit` calls `AX_submit_quote` with `confirm:true`, clicks the
final `Submit`, and may return `verification_required` for reCAPTCHA/account checks or
`contact_update_required` when Thumbtack rejects a contact field.

Each Lua tool call is logged with an elapsed/wall time (`[<elapsed>s] · AX_… <ms>`, flagged
`[SLOW >3s]` above 3s), and navigations log their duration, so a run is easy to profile/monitor.
`AX_search_service` is two-phase: the first call runs the search funnel and submit (returns
`status:"navigating"`); the runner waits for the results page (CDP, bounded — re-fires the submit if
it did not navigate) and calls again to read candidates, so no single call suspends across the
results navigation (which the SDK resumes slowly). The runner passes the already-resolved `zip_code`
to search, reuses one Lua load per navigation, and skips the redundant home navigation.
A `--multi-quote --quote-count=2` run completes in roughly 20–29s on the dev profile, with every
individual tool call under 3s.

## 5. Gotchas

- **`run` vs `call`**: prefer `axrun` (durable). `axcall` is a single turn and returns a pending
  marker for any step that navigates or fetches.
- **Parse the result**: `lua.run` returns `result` as a JSON string (the helper parses it).
- **New script files load after a cache-bust reload**: scripts are fetched from
  `raw.githubusercontent.com` (cached ~5 min). DevTools → Network → check **Disable cache**, reload,
  then confirm with `lua.listCommands()`.
- **Editing an existing file is stickier**: the site definition is cached in extension storage
  (`chrome.storage.local` key `axsdk:sites`) and site scripts are re-applied by script id (not by
  source hash), so an edited same-name file can keep serving the old source even after a cache-bust
  reload. **Reload the extension** (chrome://extensions → reload) to force a clean re-fetch; verify a
  helper landed with `(window._AXLUA||window._AXSDK.lua).eval('return tostring(type(AX_THUMBTACK.<fn>))')`.
- **Manual overrides are temporary**: `await window._AXSDK.lua.loadSiteScript("<lua>")` (or
  `window._AXLUA.load(src, { id, replace: true })`) is in-memory and lost on navigation.
- **Navigation changes the context id**: after a command that navigates, re-select the
  `AXSDK Assistant` context (or just re-run; the durable ledger continues the flow).
- **Login**: when sign-in is required, commands return `status: "login_required"`.

## 6. Relaunch the dev Chrome with CDP

Easiest: `node tools/ax.mjs chrome` (launches detached on port 9224 with the right flags; reuses the
running instance if already up). Manual equivalent:

```bash
chrome --remote-debugging-port=9224 --remote-allow-origins=* --user-data-dir=%LOCALAPPDATA%/AXSDKSitesChromeDevProfile --load-extension=../axsdk-sdk-js/packages/axsdk-extension/dist --disable-features=DisableLoadExtensionCommandLineSwitch
```

`--remote-allow-origins=*` is required for the Node CDP client to attach; **never** add
`--enable-unsafe-extension-debugging` (it breaks the WebSocket connect). The profile persists login +
the extension. Override port/profile via `CDP_PORT` / `CHROME_PROFILE` (also honored by the runners).
