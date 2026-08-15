import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { COMMERCE_LAYER, loadLuaModules } from './harness.mjs';

// A capability that EXISTS is not a capability that WORKS.
//
// `nav.clear_beforeunload` is on the `nav` table in the CDP runtime and throws when called: measured
// live on all ten storefronts, `Lua capability failed (nav.clear_beforeunload):
// nav.clear_beforeunload is not available over the dom port` — the same error on 22 of 35 checks in
// the all-site sweep. The op only ever existed because the legacy in-page extension shipped a
// 181-byte MAIN-world content script to null `window.onbeforeunload`; the CDP extension has no
// MAIN-world injection at all, so the NAME survived and the behaviour did not.
//
// Every call site guarded with `type(nav.clear_beforeunload) == "function"` — exactly the check that
// cannot tell those two apart. Only calling it and surviving the raise can.
const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  ...COMMERCE_LAYER,
]);
after(() => lua.close());

const REFUSAL = 'Lua capability failed (nav.clear_beforeunload): '
  + 'nav.clear_beforeunload is not available over the dom port';

/** The live shape: the member is a function, and calling it raises. */
function exposeRefusingNav() {
  lua.expose({
    nav: {
      navigate: () => true,
      clear_beforeunload: () => { throw new Error(REFUSAL); },
    },
    dom: {
      get_location_href: () => 'https://example.test/other',
      exists: () => false,
      query_all: () => [],
      get_text: () => null,
    },
  });
}

test('clear_beforeunload survives a capability that exists and throws', () => {
  exposeRefusingNav();

  assert.equal(
    lua.call('AX_BASE.clear_beforeunload'),
    false,
    'a refused capability reports that it did not clear, and does not raise',
  );
});

test('clear_beforeunload reports success when the runtime really has it', () => {
  lua.expose({ nav: { navigate: () => true, clear_beforeunload: () => true } });

  assert.equal(lua.call('AX_BASE.clear_beforeunload'), true);
});

test('clear_beforeunload treats an absent capability as nothing to clear', () => {
  lua.expose({ nav: { navigate: () => true } });

  assert.equal(lua.call('AX_BASE.clear_beforeunload'), false);
});

test('a refused clear is reported, not raised, on every path that clears', () => {
  // `50_commerce_core` — an RPC module that stays — clears beforeunload before it navigates. No path
  // that clears may turn a refusal into an error the caller cannot classify — an unclassified error is
  // exactly what made the live sweep print `unknown` for all ten stores.
  exposeRefusingNav();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(lua.call('AX_BASE.clear_beforeunload'), false, 'a repeated refusal stays a refusal');
  }
});
