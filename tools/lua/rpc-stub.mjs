/**
 * A fake browser for RPC Lua scripts, so a script that drives a page can be unit tested without one.
 *
 * The value of this stub is only as high as its fidelity to the real channel, so it copies the runtime's
 * semantics rather than convenient ones (`tools/lua/harness.mjs` learned the same lesson: a permissive
 * `session_state` fixture hid a bug until a live run failed):
 *
 *  - `nav.navigate` is **fire-only**. It returns as soon as the request is accepted and never reports
 *    arrival, because the real document is unloading. Arrival is observed by polling the href.
 *  - `dom.wait_for_selector` / `nav.wait_for_navigation` are **not wire ops**. The runtime prelude
 *    synthesises them by polling `dom.exists` / `dom.get_location_href`, so the stub does too — a script
 *    that lists the helper in `rpc.allow` instead of the polled op is wrong, and only a polling stub can
 *    show that.
 *  - Waits return `false` on timeout; they do not raise. Op failures raise.
 *  - Every op is recorded, so a test can assert what a script COST (round trips) and what it never
 *    touched (write ops), not just what it returned.
 */

const WRITE_OPS = new Set([
  'dom.click', 'dom.set_value', 'dom.set_form_field_value', 'dom.submit_form', 'page.eval',
  'nav.navigate', 'nav.reload',
]);

/**
 * @param {object} spec
 * @param {string} spec.href                 current location
 * @param {Record<string, object[]>} [spec.dom]            selector → rows visible now
 * @param {Record<string, object[]>} [spec.afterNavigate]  selector → rows visible after a navigation
 * @param {boolean} [spec.navigationFails]   the navigation is accepted but the href never changes
 * @param {number} [spec.settleAfter]        polls the new document needs before it answers (default 1)
 */
export function makePage(spec) {
  const page = {
    href: spec.href,
    dom: { ...(spec.dom ?? {}) },
    ops: [],
    navigated: null,
    pollsSinceNavigate: 0,
  };

  page.record = (op, params) => { page.ops.push({ op, params }); };

  page.navigate = (url) => {
    page.navigated = url;
    if (spec.navigationFails) return true;          // accepted, but the document never changes
    page.pollsSinceNavigate = 0;
    page.pendingHref = url;
    page.pendingDom = { ...(spec.afterNavigate ?? {}) };
    return true;
  };

  // The new document becomes observable a poll later, the way a real navigation does.
  page.tick = () => {
    if (page.pendingHref === undefined) return;
    page.pollsSinceNavigate += 1;
    if (page.pollsSinceNavigate >= (spec.settleAfter ?? 1)) {
      page.href = page.pendingHref;
      page.dom = page.pendingDom;
      page.pendingHref = undefined;
    }
  };

  return page;
}

/** Installs `dom` / `nav` / `page` / `rpc` (and the prelude wait helpers) into a Lua state. */
export function installRpcStub(lua, page, { allow } = {}) {
  page.ops.length = 0;

  const guard = (op) => {
    if (allow && !allow.includes(op)) throw new Error(`rpc op '${op}' is not allowed`);
  };
  const rowsFor = (selector) => page.dom[selector] ?? [];

  const api = {
    'dom.get_location_href': () => { page.tick(); return page.href; },
    'dom.exists': (selector) => { page.tick(); return rowsFor(selector).length > 0; },
    'dom.get_text': (selector) => {
      page.tick();
      const first = rowsFor(selector)[0];
      if (!first) throw new Error(`rpc dom.get_text failed: no_element: ${selector}`);
      return first.text ?? '';
    },
    'dom.query_all': (selector, fields, limit) => {
      page.tick();
      const rows = rowsFor(selector).slice(0, limit ?? 24);
      // Mirrors `queryLuaElements`: a field that matches nothing is ABSENT, not null-ish. Our readers use
      // per-field fallback chains and branch on nil; a sentinel would stop the chain at the first
      // candidate and silently accept an empty value.
      return rows.map((row) => {
        const out = {};
        for (const [name, rule] of Object.entries(fields ?? {})) {
          const value = rule === true ? row.text : row[name] ?? row[String(rule.attr ?? rule.selector ?? name)];
          if (value !== undefined && value !== null) out[name] = value;
        }
        return out;
      });
    },
    'nav.navigate': (url) => page.navigate(url),
    'nav.reload': () => true,
    'dom.click': (selector) => { page.tick(); return true; },
    'dom.set_value': () => true,
    'dom.submit_form': () => true,
    'page.eval': () => null,
  };

  const call = (op, ...args) => {
    guard(op);
    page.record(op, describe(op, args));
    return api[op](...args);
  };

  lua.expose({
    dom: {
      get_location_href: () => call('dom.get_location_href'),
      exists: (selector) => call('dom.exists', selector),
      get_text: (selector) => call('dom.get_text', selector),
      query_all: (selector, fields, limit) => call('dom.query_all', selector, fields, limit),
      click: (selector) => call('dom.click', selector),
      set_value: (selector, value) => call('dom.set_value', selector, value),
      submit_form: (form) => call('dom.submit_form', form),
      // Prelude helper: polls dom.exists. NOT a wire op.
      wait_for_selector: (selector, opts) => poll(() => call('dom.exists', selector), opts),
    },
    nav: {
      navigate: (url) => call('nav.navigate', url),
      reload: () => call('nav.reload'),
      // Prelude helper: polls dom.get_location_href. NOT a wire op.
      wait_for_navigation: (from, opts) => poll(() => call('dom.get_location_href') !== from, opts),
    },
    page: { eval: (script) => call('page.eval', script) },
    rpc: {
      now: () => Date.now(),
      sleep: () => true,
      delivered_to: () => 1,
      fanout: () => ({ executed: 1, declined: 0, silent: 0 }),
    },
  });

  return page;
}

/** The prelude's poll shape: bounded attempts, `false` on exhaustion — never an error. */
function poll(probe, opts) {
  const timeout = opts?.timeout ?? 3000;
  const interval = opts?.interval ?? 150;
  const attempts = Math.max(1, Math.ceil(timeout / interval));
  for (let i = 0; i < attempts; i += 1) {
    if (probe()) return true;
  }
  return false;
}

function describe(op, args) {
  if (op === 'nav.navigate') return { url: args[0] };
  if (op === 'dom.query_all') return { selector: args[0], limit: args[2] };
  return { selector: args[0] };
}
