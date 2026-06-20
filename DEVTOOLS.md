# DevTools Testing Cheat Sheet

Manually drive the site Lua commands (Amazon, Thumbtack) from the Chrome DevTools console.
See `SCHEMA.md` for the full parameter schema of every command.

## 1. Select the right execution context

`window._AXSDK` exists only when the extension runs in **debug mode**, and only in the
**content-script** context — not the page's default JS world.

1. Open the target site (`amazon.com` / `thumbtack.com`) in the dev Chrome with the extension loaded.
2. DevTools → **Console** → context dropdown (top-left) → select **`AXSDK Assistant`**
   (`chrome-extension://dldlgmekahifbogjphgglkhibclglmpf`).
3. Verify:

```js
const lua = window._AXSDK?.lua ?? window._AXLUA;
lua.listCommands();   // AX_ commands loaded for the current site
lua.status();         // enabled + loaded scripts
```

Scripts are fetched from `raw.githubusercontent.com/layorixinc/axsdk-sites/main/<site>/scripts/*`,
so only the current site's commands are present (Amazon on amazon.com, Thumbtack on thumbtack.com).

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

## 4. Thumbtack commands (on thumbtack.com)

| Command | Side effect | Example |
|---|---|---|
| `AX_resolve_zip` | net fetch | `axrun("AX_resolve_zip", { address: "San Francisco, CA" })` |
| `AX_search_service` | nav | `axrun("AX_search_service", { query: "house cleaning", zip_code: "94105" })` |
| `AX_view_service` | nav | `axrun("AX_view_service", { url: "<pro URL from search>" })` |
| `AX_update_search` | filter change | `axrun("AX_update_search", { value: "Every 2 weeks", option: "Frequency" })` |
| `AX_answer_quote` | quote-flow step | `axrun("AX_answer_quote", { value: "Home" })` or `axrun("AX_answer_quote", { selections: ["Inside cabinets"] })` |
| `AX_open_quote` | opens quote (never submits) | `axrun("AX_open_quote", { url: "<pro URL>", submit: false })` |
| `AX_submit_quote` | submits quote | `axrun("AX_submit_quote", { confirm: true })` |

- `AX_search_service` requires `query` plus `zip_code` **or** `address`.
- `AX_resolve_zip` / `address`: a full street address resolves via the US Census geocoder; a bare
  `"City, ST"` falls back to a representative city ZIP. A 5-digit ZIP in the text is used directly.
- `AX_view_service` / `AX_open_quote` `url` = a pro profile URL from `AX_search_service` results.

### Quote request flow test recipe

1. Open the flow: `let r = await axrun("AX_open_quote", { url: proUrl, submit: false })`.
2. If the active step is an intro with no fields, advance it: `r = await axrun("AX_answer_quote", {})`.
3. For radio steps, pass the exact visible option label: `r = await axrun("AX_answer_quote", { value: "Home" })`.
4. For checkbox steps, pass exact visible labels: `r = await axrun("AX_answer_quote", { selections: ["Inside cabinets"] })`.
5. For the details textarea, pass text only: `r = await axrun("AX_answer_quote", { text: "Need a standard cleaning estimate. Do not send yet." })`.
6. For contact steps, pass only test-safe/reserved data in dev: `r = await axrun("AX_answer_quote", { email: "thumbtack-test@example.com", first_name: "Test", last_name: "User", phone: "4155550100", zip_code: "94101" })`.
7. Optional photo upload steps are skipped automatically; do not upload test files.
8. Stop when `r.flow.reached_submit_step` is `true`, `r.flow.advance_reason` is `"unsafe_advance_button"`, or `r.flow.advance_reason` is `"advance_not_confirmed"`.
9. Submit only when intentional: `await axrun("AX_submit_quote", { confirm: true, email: "thumbtack-test@example.com", first_name: "Test", last_name: "User", phone: "4155550100" })`.

`AX_answer_quote` only clicks buttons labeled `Next`, `Continue`, or optional-step `Skip`; it refuses send/submit/quote-request buttons.
`AX_submit_quote` requires `confirm: true`, clicks the final `Submit`, and returns before/after quote details.
Set `advance: false` to select/fill the current step without moving forward.

### Live multi-service runner

```bash
node thumbtack/scripts/test_thumbtack_lua.mjs --cdp=http://127.0.0.1:9223 --multi-service --submit-quote --max-quote-steps=20 --keep-open
# Actual submit for one scenario:
node thumbtack/scripts/test_thumbtack_lua.mjs --cdp=http://127.0.0.1:9223 --scenario="handyman|San Francisco, CA" --actual-submit --max-quote-steps=20 --keep-open
```

Default multi-service scenarios: `house cleaning`, `lawn mowing`, `handyman` in San Francisco.
`--submit-quote` progresses every scenario until the final `Submit` button is visible, using
reserved/fake contact data. It never clicks `Submit`. `--actual-submit` calls `AX_submit_quote`
with `confirm:true`, clicks the final `Submit`, and may return `verification_required` when
Thumbtack opens reCAPTCHA/account verification.

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

```bash
chrome --remote-debugging-port=9223 --user-data-dir=%LOCALAPPDATA%/AXSDKSitesChromeDevProfile
```

The profile persists the login. Chrome exits when the last tab/connection closes; relaunch with the
same `--user-data-dir`. Override the port/profile in the test runners via `CDP_PORT` / `CHROME_PROFILE`.
