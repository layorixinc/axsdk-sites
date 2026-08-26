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

import { BATCHABLE } from '../rpc-allow.mjs';

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
 * @param {string}  [spec.navigateRefusal]   `nav.navigate` answers `{ok:false, reason}` and nothing moves
 * @param {string}  [spec.navigateThrowsAfterFire] navigation fires, then its acknowledgement raises
 * @param {number}  [spec.settleAfter]        polls the new document needs before it answers (default 1)
 * @param {number}  [spec.fragmentLivesFor]  polls a navigated-to `#fragment` stays readable (default 1)
 */
export function makePage(spec) {
  const page = {
    href: spec.href,
    dom: { ...(spec.dom ?? {}) },
    ops: [],
    navigated: null,
    pollsSinceNavigate: 0,
    failHrefTimes: spec.failHrefTimes ?? 0,
    failQueryTimes: spec.failQueryTimes ?? 0,
    // Every Nth op is refused. The channel can drop ANY op while it re-attaches, and a script that lets
    // one raise reports a page fact it never established — measured live twice, on two different ops.
    flakyEvery: spec.flakyEvery ?? 0,
    opCount: 0,
    // `rpc.now` / `rpc.sleep` are HOST primitives: no round trip, no `maxCalls`. A test that wants to
    // watch a time budget expire needs to move time without waiting for it, so the clock is virtual once
    // `clockMs` is set and every sleep advances it. Left null it is the wall clock, as before.
    clockMs: spec.clockMs ?? null,
    // What was slept, in order. A wait that costs round trips instead of a sleep is the defect this
    // ledger exists to catch: `pace()` used to spend two reads for their latency alone.
    sleeps: [],
    // What one round trip costs the virtual clock. Measured on the live channel: median 461ms, max 910.
    // Zero would make a time budget untestable — the whole point is that ops are what spend it.
    opCostMs: spec.opCostMs ?? 460,
    // Ops the CLIENT refuses outright — `page.eval` without its opt-in answers `op_not_permitted`.
    refuseOps: spec.refuseOps ?? [],
    // Selectors that EXIST but refuse a value — a `<select>` without the requested option.
    rejectSetValue: spec.rejectSetValue ?? [],
    // Ops the client never REGISTERED. The platform can ship an op before the extension implements it, and
    // `executeRpcOp` answers `command_unresolved` for one it has no handler for. That is a different string
    // from `op_not_permitted`, and a script that only knows the latter retries the op forever.
    unresolvedOps: spec.unresolvedOps ?? [],
    sequence: spec.sequence ?? null,
    sequenceAt: {},
    // A click's EFFECT belongs to the page, not to the op: the runtime answers whether it found
    // something to click, and the site decides what that does. A stub whose click changes nothing can
    // only ever prove that a wizard reports `advance_not_confirmed`.
    onClick: spec.onClick ?? null,
    // `page.eval` runs JS in the page world. The stub cannot execute DOM JS, so a test can only assert
    // that the script was asked for and what the page answered — the script's own correctness is live
    // evidence, never unit evidence.
    onEval: spec.onEval ?? null,
    filled: [],
  };

  page.record = (op, params) => { page.ops.push({ op, params }); };

  page.navigate = (url) => {
    page.navigated = url;
    // A refusal is a real observed answer — measured live as `{ok=false, reason="window_not_available"}`
    // from a runtime that would not perform the move. The op is answered; the page never moves. A script
    // that ignores the return value turns that refusal into an arrival question it cannot win.
    if (spec.navigateRefusal) return { ok: false, reason: spec.navigateRefusal };
    if (spec.navigationFails) return null;          // accepted, but the document never changes
    page.pollsSinceNavigate = 0;
    // A navigation can land somewhere else — a login bounce, a canonical slug rewrite. The reader has to
    // classify where it ACTUALLY is, not where it aimed.
    page.pendingHref = spec.landsAt ?? url;
    page.pendingDom = { ...(spec.afterNavigate ?? {}) };
    if (spec.navigateThrowsAfterFire) throw new Error(spec.navigateThrowsAfterFire);
    return null;                                    // the runtime answers nil for a fired navigation
  };

  // The new document becomes observable a poll later, the way a real navigation does — unless
  // `settleAfter: 0`, which is the live race: measured, an Amazon search commits in ~460ms while an op round
  // trip costs about the same, so the document can be there BEFORE the waiter reads its baseline. A waiter
  // that asks "changed since I started" then compares the new page against itself and never sees a change.
  if (spec.settleAfter === 0) {
    const alreadyThere = page.navigate;
    page.navigate = (url) => {
      const answer = alreadyThere(url);
      if (page.pendingHref !== undefined) {
        page.href = page.pendingHref;
        page.dom = page.pendingDom;
        page.pendingHref = undefined;
      }
      return answer;
    };
  }

  page.tick = () => {
    if (page.pendingHref !== undefined) {
      page.pollsSinceNavigate += 1;
      if (page.pollsSinceNavigate >= (spec.settleAfter ?? 1)) {
        page.href = page.pendingHref;
        page.dom = page.pendingDom;
        page.pendingHref = undefined;
        // Measured live (bluemoonsoft): a fragment the navigation carried is readable immediately —
        // twenty consecutive reads held `#modal/...` — and then the site's own router consumes it and
        // rewrites the URL without it. A stub that kept the fragment forever would pass a reader that
        // looks for it AFTER a wait, which is exactly the read the live run showed is worthless.
        if (page.href.includes('#')) page.fragmentPollsLeft = spec.fragmentLivesFor ?? 1;
      }
      return;
    }
    if (page.fragmentPollsLeft !== undefined) {
      if (page.fragmentPollsLeft > 0) { page.fragmentPollsLeft -= 1; return; }
      page.href = page.href.slice(0, page.href.indexOf('#'));
      page.fragmentPollsLeft = undefined;
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
  // A CSS list matches ANY of its parts, the way `querySelectorAll` does. A stub that only matched the
  // whole string reported an empty page for a reader whose selector merely listed a fallback.
  const rowsFor = (selector) => {
    if (page.dom[selector]) return page.dom[selector];
    for (const part of String(selector ?? '').split(',')) {
      const key = part.trim();
      if (key && page.dom[key]) return page.dom[key];
    }
    return [];
  };

  const api = {
    'dom.get_location_href': () => {
      page.tick();
      // A real channel can refuse an op while it is still attaching — measured live as `rpc_timeout` on
      // the very first read after an extension reload.
      if (page.failHrefTimes > 0) { page.failHrefTimes -= 1; throw new Error('rpc dom.get_location_href failed: rpc_timeout'); }
      return page.href;
    },
    'dom.exists': (selector) => { page.tick(); return rowsFor(selector).length > 0; },
    'dom.get_text': (selector) => {
      page.tick();
      // A page's TEXT changes as it settles, exactly as its element count does — eBay's header cart badge
      // reads "5" for a moment after an add and then "6". `dom.query_all` has honoured `sequence` all
      // along; a reader that waits on text could not be tested without this.
      const seqKey = page.sequence && (page.sequence[selector] ? selector : null);
      if (seqKey) {
        const steps = page.sequence[seqKey];
        const rows = steps[Math.min(page.sequenceAt[seqKey] ?? 0, steps.length - 1)];
        page.sequenceAt[seqKey] = (page.sequenceAt[seqKey] ?? 0) + 1;
        return rows[0]?.text ?? '';
      }
      const first = rowsFor(selector)[0];
      // Every document has a body. A page that declares no body row is a page with an empty one, not a
      // page missing an element — raising there would make a reader look broken for asking.
      if (!first) {
        if (selector === 'body') return '';
        throw new Error(`rpc dom.get_text failed: no_element: ${selector}`);
      }
      return first.text ?? '';
    },
    // The runtime HAS this op — measured live 2026-08-26, `dom.get_attr("#listing-page-quantity-select",
    // "value")` answered "1" — and this stub did not, so every caller of `attr_of` read nil offline. The
    // required-option guard therefore could not tell a CHOSEN option from an unchosen one: it refused
    // either way, and the one test covering it passed for the wrong reason. A missing op is as dishonest
    // as a permissive one.
    'dom.get_attr': (selector, name) => {
      page.tick();
      const first = rowsFor(selector)[0];
      if (!first) throw new Error(`rpc dom.get_attr failed: no_element: ${selector}`);
      const value = first[name];
      return value === undefined || value === null ? '' : String(value);
    },
    'dom.query_all': (selector, fields, limit) => {
      // The channel can refuse an op while it is re-attaching — measured live as `rpc_timeout` on the
      // first read after a navigation, which killed a whole tool because the error propagated.
      if (page.failQueryTimes > 0) { page.failQueryTimes -= 1; throw new Error('rpc dom.query_all failed: rpc_timeout'); }
      // A hydrating list answers a different count on each poll. A reader that settles has to be able to
      // fail here — reading the first answer would report a half-rendered page as the final one.
      const seqKey = page.sequence && (page.sequence[selector] ? selector : String(selector||"").split(",").map(s=>s.trim()).find(s=>page.sequence[s]));
      if (seqKey) {
        const steps = page.sequence[seqKey];
        const rows = steps[Math.min(page.sequenceAt[seqKey] ?? 0, steps.length - 1)];
        page.sequenceAt[seqKey] = (page.sequenceAt[seqKey] ?? 0) + 1;
        page.tick();
        page.record('dom.query_all', { selector, fields, limit });
        return rows.slice(0, limit ?? rows.length);
      }
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
    // Both report whether they FOUND their target. A script that treats "clicked nothing" as success
    // reports a form it never advanced; the durable code checked `dom.exists` first for that reason.
    'dom.click': (selector) => {
      page.tick();
      if (rowsFor(selector).length === 0) return false;
      if (page.onClick) page.onClick(selector, page);
      return true;
    },
    'dom.set_value': (selector, value) => {
      page.tick();
      if (rowsFor(selector).length === 0) return false;
      // An element can EXIST and still refuse the value: a `<select>` whose options do not include the
      // requested quantity is the live shape, and `dom.set_value` answers false for it. Without this the
      // stub could only express "no such element", so a script that ignored the return value passed.
      if (page.rejectSetValue.includes(selector)) return false;
      page.filled.push({ selector, value });
      return true;
    },
    'dom.submit_form': (form) => {
      page.tick();
      // A real submit fires the form's own handler, which the page reacts to. `requestSubmit()` is why
      // the SDK has this op at all: many SPAs ignore a synthetic click on a submit button.
      if (page.onClick) page.onClick(`submit:${form}`, page);
      return true;
    },
    // Narrows by selector, picks by NORMALIZED visible label, clicks. The point is that the label the
    // script cannot express in CSS is chosen by the client, so no selector is returned or needed.
    'dom.click_text': (selector, wanted, opts) => {
      page.tick();
      const want = String(wanted ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      const exact = opts?.exact === true;
      for (const row of rowsFor(selector)) {
        const label = String(row.text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (exact ? label === want : label.includes(want)) {
          if (page.onClick) page.onClick(`${selector}::text(${wanted})`, page, row);
          return true;
        }
      }
      throw new Error('rpc dom.click_text failed: no_element');
    },
    // Several READS, one round trip, results in request order. The constraints are the contract: writes
    // are refused, `allow` still applies per inner op, and an unknown op fails only ITS OWN entry.
    'dom.read_many': (requests) => {
      page.tick();
      const list = Array.isArray(requests) ? requests : [];
      return list.map((request) => {
        const op = request?.op;
        if (!BATCHABLE.has(op)) return { error: 'op_not_permitted' };
        if (allow && !allow.includes(op)) return { error: 'op_not_permitted' };
        const params = request.params ?? {};
        try {
          if (op === 'dom.exists') return { value: api['dom.exists'](params.selector) };
          if (op === 'dom.get_text') return { value: api['dom.get_text'](params.selector) };
          if (op === 'dom.get_location_href') return { value: api['dom.get_location_href']() };
          if (op === 'dom.get_attr') return { value: api['dom.get_attr'](params.selector, params.name ?? params.attr) };
          if (op === 'dom.query_all') {
            return { value: api['dom.query_all'](params.selector, params.fields, params.limit) };
          }
          return { error: 'op_not_permitted' };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      });
    },
    'page.eval': (script) => {
      page.tick();
      return page.onEval ? page.onEval(script, page) : null;
    },
  };

  const call = (op, ...args) => {
    guard(op);
    page.record(op, describe(op, args));
    page.opCount += 1;
    // A round trip costs TIME, which is what a time budget spends. Only on the virtual clock: against the
    // wall clock the suite would be measuring node's speed instead of the script's decisions.
    if (page.clockMs !== null) page.clockMs += page.opCostMs;
    if (page.refuseOps.includes(op)) throw new Error(`rpc ${op} failed: op_not_permitted: ${op}`);
    if (page.unresolvedOps.includes(op)) throw new Error(`rpc ${op} failed: command_unresolved: ${op}`);
    if (page.flakyEvery > 0 && page.opCount % page.flakyEvery === 0) {
      throw new Error(`rpc ${op} failed: rpc_timeout`);
    }
    return api[op](...args);
  };

  lua.expose({
    dom: {
      get_location_href: () => call('dom.get_location_href'),
      exists: (selector) => call('dom.exists', selector),
      get_text: (selector) => call('dom.get_text', selector),
      get_attr: (selector, name) => call('dom.get_attr', selector, name),
      query_all: (selector, fields, limit) => call('dom.query_all', selector, fields, limit),
      click: (selector) => call('dom.click', selector),
      set_value: (selector, value) => call('dom.set_value', selector, value),
      submit_form: (form) => call('dom.submit_form', form),
      click_text: (selector, text, opts) => call('dom.click_text', selector, text, opts),
      read_many: (requests) => call('dom.read_many', requests),
      // Prelude helper: polls dom.exists. NOT a wire op.
      wait_for_selector: (selector, opts) => poll(() => call('dom.exists', selector), opts),
    },
    nav: {
      navigate: (url) => call('nav.navigate', url),
      reload: () => call('nav.reload'),
      // Prelude helper: polls dom.get_location_href. NOT a wire op.
      //
      // ONE spec table, as both runtimes have — the CDP dom port reads `url`/`timeout`/`interval` off a
      // single argument and the durable path takes `luaArg(args, 0)`. This stub used to accept
      // `(from, opts)` and honour `opts`, which is why every caller passing two arguments looked correct
      // here while the real port dropped the second and ran on its 30000 ms / 100 ms defaults. A stub
      // that is more permissive than the capability hides exactly the bug it exists to catch.
      wait_for_navigation: (spec, extra) => {
        if (extra !== undefined) {
          throw new Error('nav.wait_for_navigation takes one spec table; the runtime drops the second argument');
        }
        const options = spec && typeof spec === 'object' ? spec : undefined;
        const wanted = options?.url;
        // The baseline is read through a ROUND TRIP, exactly as the real port does
        // (`axsdk-core/src/lua/dom-port.ts`: `const before = await locationHref(on)` before the poll). This
        // stub used to take it from `page.href` without ticking, on the reasoning that mid-navigation the
        // port still sees the old document — and live measurement killed that reasoning: an Amazon search
        // commits in ~460ms while an op round trip costs about the same, so the baseline read often returns
        // the NEW url and `now !== before` can then never become true. The wait polls its whole ceiling and
        // answers false about a navigation that worked. A caller that passes `url` is immune, because
        // `now.includes(wanted)` is true whenever the page is there, before or after the baseline.
        const before = call('dom.get_location_href');
        return poll(() => {
          const now = call('dom.get_location_href');
          if (now === null || now === undefined) return false;
          return typeof wanted === 'string' && wanted !== '' ? String(now).includes(wanted) : now !== before;
        }, options);
      },
    },
    page: { eval: (script) => call('page.eval', script) },
    // Host primitives. Deliberately NOT routed through `call()`: they cost no round trip and consume no
    // `maxCalls`, so recording them as ops would hide the very saving they exist for.
    rpc: {
      now: () => (page.clockMs === null ? Date.now() : page.clockMs),
      sleep: (ms) => {
        const slept = Number(ms) || 0;
        page.sleeps.push(slept);
        if (page.clockMs !== null) page.clockMs += slept;
        return true;
      },
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
  // The requested fields are part of what the op asked for, and "did the reader ask for what it later
  // reads" is a real contract: 11st produced zero candidates from 24 cards because a field was read
  // from the row and never requested.
  if (op === 'dom.query_all') return { selector: args[0], fields: args[1], limit: args[2] };
  return { selector: args[0] };
}
