import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLuaModules } from './harness.mjs';

// The affiliate link is made at the ONE moment the policy allows: after the user has picked a numbered
// offer. That pick already exists — `present_offers` pauses on its window and reads the reply — so this
// module never decides WHEN, only whether the store can be monetised and what the pick was worth.
//
// It is granted no `nav.*`. It cannot navigate anywhere, which is the structural version of "never force
// a redirect" rather than a promise not to.

const MODULES = [
  '_common/scripts/00_base.lua',
  '_common/rpc/62_rpc_sites.lua',
  '_common/rpc/69_rpc_widget.lua',
  '_common/rpc/74_rpc_affiliate.lua',
];

/** A runtime with `json` and a stub of our own deeplink server. */
function runtime({ reply, fail = false } = {}) {
  const lua = loadLuaModules(MODULES);
  const calls = [];
  lua.expose({
    json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(text) },
    net: {
      fetch: (url, options) => {
        calls.push({ url, options });
        if (fail) return { ok: false, status: 502, headers: {}, body: 'upstream' };
        // The runtime's net.fetch answers {body, headers, ok, status} and NEVER a `json` field.
        return { ok: true, status: 200, headers: {}, body: JSON.stringify(reply ?? {
          links: [{ url: 'https://www.coupang.com/vp/products/1', affiliate_url: 'https://link.coupang.com/a/AAA' }],
        }) };
      },
    },
  });
  return { lua, calls };
}

const OFFER = {
  site: 'coupang', product_id: '1', id: '1', name: '로지텍 M170 무선마우스',
  url: 'https://www.coupang.com/vp/products/1',
  price: 12900, currency: 'KRW', total_base: 10.79, cost_complete: true,
};

const SNAPSHOT = JSON.stringify({
  comparison_id: 'cmp-1',
  display_currency: 'KRW',
  offers: [
    { ...OFFER, price_total: 15400 },
    { site: 'ssg', product_id: 'S', name: '같은 마우스', price: 19010, currency: 'KRW', total_base: 13.32, cost_complete: true, price_total: 19010 },
  ],
});

const link = (args, options) => {
  const { lua, calls } = runtime(options);
  const out = lua.call('AX_RPC_AFFILIATE.link', args);
  lua.close();
  return { out, calls };
};

test('a store with no program falls through to the existing path, without calling out', () => {
  // Nine of the ten stores have no program. They must reach the cart exactly as before, and a store with
  // nothing to monetise must not cost a network call to discover that.
  const { out, calls } = link({ site: 'ssg', selected_offer: { ...OFFER, site: 'ssg' }, comparison_state: SNAPSHOT });

  assert.equal(out.next, 'no_program');
  assert.equal(out.affiliate_url, undefined);
  assert.deepEqual(calls, [], 'a store without a program is decided locally');
});

test('a monetisable pick returns a link, its disclosure, and the saving it represents', () => {
  const { out, calls } = link({ site: 'coupang', selected_offer: OFFER, comparison_state: SNAPSHOT, comparison_id: 'cmp-1' });

  assert.equal(out.next, 'ready');
  assert.equal(out.affiliate_url, 'https://link.coupang.com/a/AAA');
  assert.equal(out.program, 'coupang');
  // The disclosure is not optional and not the caller's job to remember: a link without it is the
  // violation, so the two are produced together or not at all.
  assert.match(out.disclosure ?? '', /파트너스/);
  // 19,010 − 15,400. The comparison already holds every candidate's total; the saving is the window's
  // own arithmetic, not a claim invented for the link.
  assert.match(out.saving_text ?? '', /3,610/);
  assert.equal(calls.length, 1, 'one conversion call');
  assert.doesNotMatch(calls[0].url, /coupang\.com/, 'the extension talks to our server, never to the affiliate API');
});

test('the widget carries the link as a click the user makes', () => {
  const { out } = link({ site: 'coupang', selected_offer: OFFER, comparison_state: SNAPSHOT });

  assert.match(out.widget ?? '', /^```ax-widget/);
  const payload = JSON.parse(String(out.widget).split('\n').slice(1, -1).join('\n'));
  assert.equal(payload.template, 'link_button');
  assert.equal(payload.data.action.type, 'link');
  assert.equal(payload.data.action.url, 'https://link.coupang.com/a/AAA');
  assert.equal(payload.data.action.target, '_blank');
});

test('the affiliate button names the configured site, even when the product has no name', () => {
  const { out } = link({
    site: 'coupang',
    selected_offer: { ...OFFER, name: undefined },
    comparison_state: SNAPSHOT,
  });

  const payload = JSON.parse(String(out.widget).split('\n').slice(1, -1).join('\n'));
  assert.equal(payload.data.label, '쿠팡에서 보기');
});

test('a conversion that fails keeps the comparison and says why', () => {
  // The comparison is the user's, and it was earned by real navigations. A dead conversion service must
  // cost the link, not the result — and the reason travels raw, because "server down" and "this store is
  // not monetisable" have opposite fixes.
  const { out } = link({ site: 'coupang', selected_offer: OFFER, comparison_state: SNAPSHOT }, { fail: true });

  assert.equal(out.next, 'unavailable');
  assert.equal(out.affiliate_url, undefined);
  assert.ok(out.error, 'a refusal must name itself');
  // No link means no economic interest to disclose, and a disclosure beside no link is noise.
  assert.equal(out.disclosure, undefined);
});

test('a reply with no usable link is not a link', () => {
  // An empty list, a missing field, a non-https string: each arrives as a 200 and none is a deep link.
  for (const reply of [{ links: [] }, { links: [{ url: OFFER.url }] }, { links: [{ affiliate_url: 'javascript:alert(1)' }] }]) {
    const { out } = link({ site: 'coupang', selected_offer: OFFER, comparison_state: SNAPSHOT }, { reply });
    assert.equal(out.next, 'unavailable', `accepted a bad reply: ${JSON.stringify(reply)}`);
    assert.equal(out.affiliate_url, undefined);
  }
});

test('no saving is stated when the comparison does not show one', () => {
  // A single-offer comparison saves nothing, and the picked offer may be the dearest. Inventing a saving
  // to satisfy the "direct user benefit" requirement is the deception the requirement exists to prevent.
  const alone = JSON.stringify({ comparison_id: 'cmp-2', display_currency: 'KRW', offers: [{ ...OFFER, price_total: 15400 }] });
  const { out } = link({ site: 'coupang', selected_offer: OFFER, comparison_state: alone });

  assert.equal(out.next, 'ready');
  assert.equal(out.saving_text, undefined);
});
