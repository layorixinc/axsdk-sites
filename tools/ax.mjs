#!/usr/bin/env node
// ax — the daily driver for the AXSDK live harness.
//
// One command to launch/attach the dev Chrome, find the AXSDK Assistant context, and run any AX_*
// Lua command against the page you are actually looking at — no DevTools console, no git push.
//
//   node tools/ax.mjs chrome [site|url]      ensure dev Chrome is up (launch if needed)
//   node tools/ax.mjs open  <site|url>       navigate the dev tab to a site
//   node tools/ax.mjs run   <CMD> [json]     durable lua.run (use for everything)   [--local]
//   node tools/ax.mjs call  <CMD> [json]     single lua.call turn (read-only checks)
//   node tools/ax.mjs load  [site]           inject LOCAL working-copy Lua into the runtime
//   node tools/ax.mjs page                   current url + quick situational read (AX_read_page)
//   node tools/ax.mjs ls                     lua.listCommands()
//   node tools/ax.mjs status                 lua.status()
//   node tools/ax.mjs repl                   interactive loop
//
// Flags (any subcommand): --port=N --cdp=URL --chrome=PATH --profile=PATH --extension-id=ID
//   --extension=PATH --match=SUBSTR (pick tab by url) --site=SLUG --timeout=MS --local --no-launch
//
// Examples:
//   node tools/ax.mjs open thumbtack
//   node tools/ax.mjs load                                  # auto-detects site from the tab url
//   node tools/ax.mjs run AX_resolve_zip '{"address":"San Francisco, CA"}'
//   node tools/ax.mjs run AX_read_page '{"mode":"structure"}'
//   node tools/ax.mjs --local run AX_search_service '{"query":"house cleaning","zip_code":"94101"}'

import { createInterface } from 'node:readline/promises';
import {
  DEFAULTS, SITE_HOME, resolveOptions, ensureChrome, attachActive, listTargets,
  openPage, navigate, evaluatePage, run, call, loadLocal, listCommands, status, currentUrl, syncSitesIndex,
  syncStore, sendMessage, reloadExtension,
} from './harness/cdp.mjs';

const USAGE = `ax — daily driver for the AXSDK live harness

Usage: node tools/ax.mjs <command> [args] [flags]

Commands:
  chrome [site|url]     Ensure the dev Chrome is running (launch detached if down); optionally open a site.
  open <site|url>       Navigate the dev tab to a site (${Object.keys(SITE_HOME).join(' | ')}) or a full url.
  run <CMD> [json]      Durable lua.run — handles nav/reload flows. Prints the parsed result.
  call <CMD> [json]     Single lua.call turn — read-only / no-navigation checks.
  load [site]           Inject LOCAL working-copy Lua (_common + <site>) into the live runtime.
  sync [site|url]       Build+inject local Lua AND flows into the stores (":" + ":"+domain); turn OFF remote Lua+flows; reload; verify.
  page                  Print the current url + a quick AX_read_page situational read.
  ls                    lua.listCommands() for the current site.
  status                lua.status() (enabled + loaded scripts).
  send "<text>"         Drive the flow ENGINE: send a user message, wait for the turn, print the reply + tool parts.
  repl                  Interactive loop (type "AX_cmd {json}"; ".help" for meta-commands).

Flags:
  --port=N              CDP port (default ${DEFAULTS.port}; env CDP_PORT).
  --cdp=URL             Full CDP base url (overrides --port).
  --chrome=PATH         Chrome executable (env CHROME_PATH).
  --profile=PATH        Chrome profile dir (env CHROME_PROFILE).
  --extension-id=ID     AXSDK extension id (env AXSDK_EXTENSION_ID).
  --extension=PATH      Unpacked extension dir to --load-extension (env AXSDK_EXTENSION_PATH).
  --match=SUBSTR        Pick the tab whose url contains SUBSTR (when several are open).
  --site=SLUG           Force the site for "load" when off-domain.
  --local               For "run"/"call": inject local Lua before running.
  --store               For "run"/"call": build + store-inject Lua (remote off) before running.
  --no-build            With "sync"/"--store": skip the build step (use the existing dist/).
  --no-launch           Never auto-launch Chrome; fail if it is not already up.
  --timeout=MS          Durable run timeout (default 60000).`;

function parseFlags(argv) {
  const flags = {};
  const positionals = [];
  for (const arg of argv) {
    if (arg === '--local') flags.local = true;
    else if (arg === '--store') flags.store = true;
    else if (arg === '--no-build') flags.build = false;
    else if (arg === '--no-launch') flags.launch = false;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--cdp=')) flags.cdp = arg.slice(6);
    else if (arg.startsWith('--port=')) flags.port = Number(arg.slice(7));
    else if (arg.startsWith('--chrome=')) flags.chrome = arg.slice(9);
    else if (arg.startsWith('--profile=')) flags.profile = arg.slice(10);
    else if (arg.startsWith('--extension-id=')) flags.extensionId = arg.slice(15);
    else if (arg.startsWith('--extension=')) flags.extensionPath = arg.slice(12);
    else if (arg.startsWith('--match=')) flags.match = arg.slice(8);
    else if (arg.startsWith('--site=')) flags.site = arg.slice(7);
    else if (arg.startsWith('--timeout=')) flags.timeout = Number(arg.slice(10));
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    else positionals.push(arg);
  }
  return { flags, positionals };
}

function out(value) {
  if (value === undefined) return;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function resolveTarget(arg) {
  if (!arg) throw new Error('expected a site slug or url');
  if (/^https?:\/\//.test(arg)) return arg;
  const url = SITE_HOME[arg];
  if (!url) throw new Error(`unknown site "${arg}" (known: ${Object.keys(SITE_HOME).join(', ')})`);
  return url;
}

function parseJsonArg(arg) {
  if (arg === undefined) return {};
  try {
    return JSON.parse(arg);
  } catch (error) {
    throw new Error(`invalid JSON args: ${arg}\n  (wrap in single quotes, e.g. '{"query":"x"}') — ${error.message}`);
  }
}

async function fetchVersion(cdpUrl) {
  try {
    const res = await fetch(`${cdpUrl}/json/version`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Navigate the dev tab (reuse newest tab incl about:blank, else open one) to url; returns final url.
async function openSite(cdpUrl, options, url) {
  let page;
  try {
    ({ page } = await attachActive(cdpUrl, options, { match: options.match, allowBlank: true }));
    await navigate(page, url);
  } catch {
    page = await openPage(cdpUrl, url);
  }
  const finalUrl = await evaluatePage(page, 'location.href').catch(() => url);
  page.close();
  return finalUrl;
}

// Attach to the active site tab and run `fn(session)`; always closes the socket.
async function withSession(options, fn) {
  const { cdpUrl } = await ensureChrome(options, { launch: options.launch !== false });
  const { page } = await attachActive(cdpUrl, options, { match: options.match });
  const session = { page, options, cdpUrl };
  try {
    return await fn(session);
  } finally {
    page.close();
  }
}

async function cmdChrome(options, positionals) {
  if (positionals[0]) options.openUrl = resolveTarget(positionals[0]);
  const { cdpUrl, launched } = await ensureChrome(options, { launch: true });
  if (positionals[0] && !launched) options.openedUrl = await openSite(cdpUrl, options, resolveTarget(positionals[0]));
  else if (positionals[0] && launched) options.openedUrl = options.openUrl;
  const version = await fetchVersion(cdpUrl);
  const targets = (await listTargets(cdpUrl).catch(() => [])).filter(t => t.type === 'page').map(t => t.url);
  out({
    cdp: cdpUrl,
    browser: version?.Browser || null,
    launched: Boolean(launched),
    opened: options.openedUrl || null,
    tabs: targets,
  });
}

async function cmdOpen(options, positionals) {
  const url = resolveTarget(positionals[0]);
  const { cdpUrl } = await ensureChrome(options, { launch: options.launch !== false });
  const finalUrl = await openSite(cdpUrl, options, url);
  out({ opened: finalUrl });
}

async function cmdSync(options, positionals) {
  const { cdpUrl } = await ensureChrome(options, { launch: options.launch !== false });
  if (positionals[0]) await openSite(cdpUrl, options, resolveTarget(positionals[0]));
  const siteArg = (positionals[0] && !/^https?:\/\//.test(positionals[0])) ? positionals[0] : options.site;
  // Publish the local sites index first: an unpublished site layer has no assistant on its host, so
  // syncStore could not attach there at all.
  const index = await syncSitesIndex(cdpUrl, options, {
    destination: positionals[0] ? resolveTarget(positionals[0]) : undefined,
  });
  return withSession(options, async session => out({
    sitesIndex: index,
    ...(await syncStore(session, { site: siteArg, build: options.build !== false })),
  }));
}

async function cmdPage(session) {
  const url = await currentUrl(session);
  const read = await run(session, 'AX_read_page', { mode: 'auto', max_chars: 1500 }).catch(e => ({ error: String(e.message || e) }));
  out({ url, read: read?.value || read });
}

async function main() {
  const { flags, positionals } = parseFlags(process.argv.slice(2));
  const command = positionals[0];
  const rest = positionals.slice(1);
  if (!command || command === 'help' || flags.help) {
    out(USAGE);
    return;
  }
  const options = resolveOptions(flags);

  switch (command) {
    case 'chrome':
      return cmdChrome(options, rest);
    case 'open':
      return cmdOpen(options, rest);
    case 'run':
    case 'call': {
      if (!rest[0]) throw new Error(`${command} needs a command, e.g. ax ${command} AX_read_page '{}'`);
      const args = parseJsonArg(rest[1]);
      return withSession(options, async session => {
        if (flags.store) {
          const synced = await syncStore(session, { site: flags.site, build: options.build !== false });
          console.error(`[store] ${synced.site}@${synced.domain}: lua store=${synced.fromStore ?? '?'} remote=${synced.fromRemote ?? '?'}, flows=[${synced.flowsStoreKeys.join(', ')}]`);
        } else if (flags.local) {
          const loaded = await loadLocal(session, { site: flags.site });
          console.error(`[load] ${loaded.site || '?'}: ${loaded.loaded.length} files${loaded.failed.length ? `, ${loaded.failed.length} failed` : ''}`);
        }
        const res = command === 'run'
          ? await run(session, rest[0], args, { timeoutMs: options.timeout || 60000 })
          : await call(session, rest[0], args);
        out(res);
      });
    }
    case 'sync':
      return cmdSync(options, rest);
    case 'reload-ext': {
      const { cdpUrl } = await ensureChrome(options, { launch: options.launch !== false });
      const res = await reloadExtension(cdpUrl, options, { url: rest[0] ? resolveTarget(rest[0]) : undefined });
      try { res.page.close(); } catch { /* one-shot */ }
      out({ reloaded: res.reloaded, url: res.url });
      return;
    }
    case 'send':
      return withSession(options, async session => out(await sendMessage(session, rest.join(' '), { timeoutMs: options.timeout || 180000 })));
    case 'load':
      return withSession(options, async session => out(await loadLocal(session, { site: rest[0] || flags.site })));
    case 'page':
      return withSession(options, cmdPage);
    case 'ls':
      return withSession(options, async session => out(await listCommands(session)));
    case 'status':
      return withSession(options, async session => out(await status(session)));
    case 'repl':
      return repl(options);
    default:
      throw new Error(`unknown command "${command}". Run "ax help".`);
  }
}

async function repl(options) {
  const { cdpUrl } = await ensureChrome(options, { launch: options.launch !== false });
  const { page } = await attachActive(cdpUrl, options, { match: options.match });
  const session = { page, options, cdpUrl };
  const url = await currentUrl(session).catch(() => '?');
  console.log(`ax repl — ${cdpUrl} — ${url}`);
  console.log('Type "AX_cmd {json}" to run; ".help" for meta-commands; ".quit" to exit.');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'ax> ' });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    try {
      if (text === '.quit' || text === '.exit') break;
      else if (text === '.help') out('.open <site|url> | .load [site] | .page | .ls | .status | .url | .call <CMD> [json] | <CMD> [json] | .quit');
      else if (text === '.url') out(await currentUrl(session));
      else if (text === '.ls') out(await listCommands(session));
      else if (text === '.status') out(await status(session));
      else if (text === '.page') await cmdPage(session);
      else if (text.startsWith('.load')) out(await loadLocal(session, { site: text.slice(5).trim() || undefined }));
      else if (text.startsWith('.open')) { const u = await openSite(cdpUrl, options, resolveTarget(text.slice(5).trim())); out({ opened: u }); }
      else {
        const single = text.startsWith('.call');
        const body = single ? text.slice(5).trim() : text;
        const sp = body.indexOf(' ');
        const cmd = sp === -1 ? body : body.slice(0, sp);
        const args = sp === -1 ? {} : parseJsonArg(body.slice(sp + 1).trim());
        out(single ? await call(session, cmd, args) : await run(session, cmd, args, { timeoutMs: options.timeout || 60000 }));
      }
    } catch (error) {
      console.error(`! ${error.message || error}`);
    }
    rl.prompt();
  }
  rl.close();
  page.close();
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
