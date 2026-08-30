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

## The CDP extension harness — **the shipping one**

`@axsdk/extension-cdp` is what goes to the Chrome Web Store. The two harnesses above drive the
**legacy** in-page extension, where a script runs in the page's isolated world; here a script runs in a
session worker and `dom`/`nav` reach the page over the DevTools protocol, one session per tab group,
several at once. Use this for day-to-day work; reach for the in-page harnesses only for the scenario
runners that have not been ported.

```bash
npm run cdp -- sources                 # what this workspace would store; no browser
npm run cdp                            # bring a session up (npm run chrome does the same)
npm run cdp -- ls                      # every AX_* command, and which script owns it
npm run cdp -- send '가격 알려줘'        # a real turn through the flow engine
npm run repl                           # all of it, interactively
```

Once, beside this repo: `bun install` then `bun run build` in `packages/axsdk-extension-cdp`.

It takes the workspace from the **current directory**, so that bundles this tree; `cd playground` for
that one. Credentials come from this repo's `.env` (`AXSDK_API_KEY`, `AXSDK_APP_ID`,
`AXSDK_BASE_URL`) and it prints which file it read. Then `… harness.mjs ls` shows every `AX_*` command
and which script owns it, `call`/`run`/`eval`/`page`/`open`/`send` drive the session, and `repl` does
all of it interactively.

Full guide, including what is and is not bundled and what to do when it misbehaves:
**`../axsdk-sdk-js/docs/cdp-harness-for-sites.md`**.

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

## 3. Commerce flows

Commerce ships through runtime flow tools, not site-local `AX_search_product`/`AX_add_to_cart`
commands. Drive the same path as the user:

```bash
npm run cdp -- send "Logitech M185를 amazon, ebay, walmart에서 총액 비교해줘"
```

The flow queues up to all ten requested stores and processes them one at a time in request order,
collecting a classified outcome for each store before it renders the bounded comparison window. It
locks a grounded manufacturer model, screens relevance, and verifies product-page identity and price.
Choosing a number is the cart-approval turn and can mutate a real cart. Use `취소` for a read-only
walkthrough. Checkout review never clicks a place-order control.

The ten configured storefronts are `amazon`, `walmart`, `ebay`, `aliexpress`, `etsy`, `coupang`,
`naver-shopping`, `gmarket`, `11st`, and `ssg`; Naver Shopping is read-only. CAPTCHA, login,
security-verification, and access-denied pages are classified instead of reported as empty stores.

Verification:

```bash
npm run test:commerce
npm run test:commerce:live:all
npm run test:commerce:live:expanded
npm run test:commerce:live:discovery
```

## 4. Thumbtack flow

Thumbtack also ships entirely through runtime flow tools. Start from any page and exercise the real
planner + flow engine:

```bash
npm run cdp -- send "San Francisco, CA에서 house cleaning 견적을 찾아줘"
```

The flow resolves a US ZIP, searches Thumbtack, presents a deterministic candidate window, opens the
selected quote overlay, and advances safe `Next`/`Continue`/optional `Skip` steps. It never clicks a
final request/submit control automatically. Use only reserved test data:
`thumbtack-test@example.com`, `415-555-01xx`, and public ZIP `94101`.

`AX_resolve_zip` and `AX_read_page` remain explicitly labelled dev shims because the harness calls them
directly. They are not the production Thumbtack command stack:

```bash
npm run cdp -- run AX_resolve_zip '{"address":"San Francisco, CA"}'
npm run cdp -- page
```

The ZIP ladder is explicit ZIP → embedded ZIP → Photon/Nominatim forward geocode + Census ZCTA reverse
→ Census one-line address. `AX_read_page` is read-only HTML-to-Markdown situational awareness.

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
