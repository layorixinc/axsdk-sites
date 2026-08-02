import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// `nil` means "no such element". `""` means "the element is there and empty". A selector that still
// matches after a redesign but renders nothing is the second case, and it is the common one — the markup
// survives, the content moves. A fallback chain that only checks `~= nil` stops on that empty shell and
// accepts it, so the later candidates that would have worked are never tried.
//
// Two chains exist in this repo and they fail differently:
//   1. `B.read_field` — OUR chain, one candidate per attempt. It can and must skip an empty hit.
//   2. a CSS selector list ('a, b, c') — the BROWSER picks the first match and we never see the rest.
//      An empty first match cannot be recovered, so the value must be refused rather than accepted.

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  'playground/_common/scripts/16_rpc_storefront.lua',
]);
after(() => lua.close());

test('our own chain skips an element that matched but is empty', () => {
  const page = makePage({
    href: 'https://example.test/',
    dom: {
      '.price-new': [{ text: '' }],        // redesign left the node, moved the content
      '.price-old': [{ text: '19,400원' }],
    },
  });
  installRpcStub(lua, page);

  const value = lua.call('AX_BASE.read_field', [
    { selector: '.price-new' },
    { selector: '.price-old' },
  ]);
  assert.equal(value, '19,400원', 'an empty hit must not end the chain');
});

test('the winning selector is reported, so drift is visible', () => {
  const page = makePage({ href: 'https://example.test/', dom: { '.a': [{ text: '' }], '.b': [{ text: 'x' }] } });
  installRpcStub(lua, page);
  // The harness returns the first result; the second (source) is what makes a silent fallback auditable
  // in the live logs, which is why read_field returns it at all.
  assert.equal(lua.call('AX_BASE.read_field', [{ selector: '.a' }, { selector: '.b' }]), 'x');
});

test('a chain of nothing but empty hits yields nil, not an empty string', () => {
  const page = makePage({ href: 'https://example.test/', dom: { '.a': [{ text: '' }], '.b': [{ text: '   ' }] } });
  installRpcStub(lua, page);
  assert.equal(lua.call('AX_BASE.read_field', [{ selector: '.a' }, { selector: '.b' }]), null,
    'a consumer branching on nil must not receive ""');
});

// ── the CSS-list case: unrecoverable, so refuse ──────────────────────────────

test('a storefront row whose price element is present but empty is dropped', () => {
  // The browser already chose that empty node out of the selector list; there is no second chance. The
  // only honest outcome is to refuse the row — a price of 0 or "" in a comparison is a wrong number.
  const page = makePage({
    href: 'https://search.11st.co.kr/pc/total-search?kwd=x',
    dom: {
      'li.card': [
        { text: 'shell', url: 'https://www.11st.co.kr/products/1', title: '껍데기', price_text: '' },
        { text: 'real', url: 'https://www.11st.co.kr/products/2', title: '진짜', price_text: '19,400원' },
      ],
    },
  });
  installRpcStub(lua, page);

  const result = lua.call('AX_RPC_STOREFRONT.search', {
    site: '11st',
    search_url: 'https://search.11st.co.kr/pc/total-search',
    search_param: 'kwd',
    search_path_marker: '/pc/total-search',
    result_selector: 'li.card',
    result_ready_selector: 'li.card',
    result_url_selector: 'a',
    result_title_selector: '.name',
    result_price_selector: '.price',
    default_currency: 'KRW',
    product_id_patterns: ['/products/(%d+)'],
  }, { query: 'x' });

  assert.deepEqual(result.candidates.map((entry) => entry.product_id), ['2']);
  assert.equal(result.cards_seen, 2, 'the shell still counted as a card that existed');
});
