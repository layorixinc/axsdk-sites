import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// The Thumbtack quote flow is where the durable design cost the most: every page-level tool had to be
// re-entrant and page-detecting because a navigation destroyed the Lua context, and resuming across it
// was measured at 12–21 seconds. A runtime script keeps its stack, so the same read becomes a straight
// line — and the load determination that needed a durable primitive becomes a plain loop.
//
// What must NOT be lost is why that loop exists. The results list hydrates: reading the first answer
// reports a half-rendered page as the final one, and a service that has fifteen pros comes back with
// three. So the reader settles on a stable count before it believes the page.

const lua = loadLuaModules([
  '_common/rpc/61_rpc_storefront.lua',
  '_common/rpc/64_rpc_thumbtack.lua',
]);
after(() => lua.close());

// The real card is the div that DIRECTLY contains the marker, and it is what carries the service link,
// the avatar and the doubled `.pro-title`. Fixtures that invented a flatter card ("title", a `/p/` URL)
// passed while the live page returned nothing at all — the shapes here are the ones measured on
// thumbtack.com, so a reader that stops matching the site now fails here first.
const CARD = 'div:has(> [data-test="pro-list-result"])';
let nextId = 1000;
const ids = new Map();
const pro = (name, rating) => {
  if (!ids.has(name)) ids.set(name, String((nextId += 7)));
  const id = ids.get(name);
  return {
    text: `${name}${name} Top Pro ${rating} (128) Great value`,
    name: `${name}${name}`,
    image_alt: `Avatar for ${name}`,
    url: `https://www.thumbtack.com/ca/san-francisco/house-cleaning/x/service/${id}/`,
  };
};

const search = (page, args = {}) => {
  installRpcStub(lua, page);
  return { value: lua.call('AX_RPC_THUMBTACK.search_service', { query: 'house cleaning', zip_code: '94101', ...args }), ops: page.ops };
};

test('the reader waits for the list to stop growing', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: { [CARD]: [[pro('A', 4.5)], [pro('A', 4.5), pro('B', 4.8)], [pro('A', 4.5), pro('B', 4.8), pro('C', 5)], [pro('A', 4.5), pro('B', 4.8), pro('C', 5)]] },
  });
  const { value } = search(page);

  assert.equal(value.next, 'done');
  assert.equal(Object.values(value.candidates).length, 3, 'a list still growing must not be read as final');
});

test('a settled empty list is no_results, not a slow page', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {}, sequence: { [CARD]: [[], [], []] } });
  assert.equal(search(page).value.next, 'no_results');
});

test('a rejected ZIP is its own answer, never an empty service', () => {
  // Thumbtack answers a bad ZIP with a banner and an empty list. Reporting `no_results` would send the
  // user looking for another service when the postcode is what it disliked.
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { '[data-test="invalid-zip"]': [{ text: 'Enter a valid ZIP' }] },
    sequence: { [CARD]: [[], []] },
  });
  const { value } = search(page);
  assert.equal(value.next, 'invalid_zip');
  assert.equal(value.zip_code, '94101');
});

test('the search is fired once, not on every poll', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: { [CARD]: [[pro('A', 4.5)], [pro('A', 4.5)]] },
  });
  const { ops } = search(page);
  assert.equal(ops.filter((entry) => entry.op === 'nav.navigate').length, 1);
});

test('a candidate carries what the shortlist ranks on', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: { [CARD]: [[pro('Clean Co', 4.9)], [pro('Clean Co', 4.9)]] },
  });
  const candidate = Object.values(search(page).value.candidates)[0];
  assert.equal(candidate.name, 'Clean Co');
  assert.equal(candidate.rating, 4.9);
});

test('the entry reads the shape the quote node hands it', () => {
  // The node selects `service_query` and `zip_code`; the tool's `input:` renamed the first to `query`
  // and a runtime lua tool never sees that block. Live, the search answered `query_required` and the
  // user was told the ZIP was probably invalid — a wrong explanation for a mapping mistake.
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: { [CARD]: [[pro('Clean Co', 4.9)], [pro('Clean Co', 4.9)]] },
  });
  installRpcStub(lua, page);
  const value = lua.call('AX_RPC_THUMBTACK.search_service', { service_query: 'house cleaning', zip_code: '94101' });

  assert.equal(value.next, 'done');
  assert.equal(value.query, 'house cleaning');
});

test('the search opens the category page the site actually serves', () => {
  // Live, `/instant-results/?query=...` answered zero pros: results live at `/k/<slug>/near-me/`, and
  // the slug is the query with every run of non-alphanumerics collapsed to one hyphen.
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: { [CARD]: [[pro('Clean Co', 4.9)], [pro('Clean Co', 4.9)]] },
  });
  const { ops } = search(page, { query: 'House  Cleaning!' });
  const navigated = ops.find((entry) => entry.op === 'nav.navigate');

  assert.equal(navigated.params.url, 'https://www.thumbtack.com/k/house-cleaning/near-me/?zip_code=94101');
});

test('a card with no service link is dropped, not shown as a pro nobody can pick', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: {
      [CARD]: [
        [pro('Clean Co', 4.9), { text: 'Sponsored', name: 'AdAd' }],
        [pro('Clean Co', 4.9), { text: 'Sponsored', name: 'AdAd' }],
      ],
    },
  });
  const candidates = Object.values(search(page).value.candidates);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].service_id, String(candidates[0].id));
});

test('a candidate carries every column the results table prints', () => {
  // Live, the widget rendered reviews / price / hires as "-" for all ten pros: the reader returned only
  // a name, a rating and a URL, so the table had nothing to print. This is the card text measured on
  // thumbtack.com — doubled by the responsive layout, badges and all.
  const card = {
    text: 'MAXIMA - Spotless Homes.MAXIMA - Spotless Homes.Excellent 4.9(98)Excellent 4.9(98)Great value'
      + '202 hires on Thumbtack202 hires on ThumbtackOnline now - responds in about 2 hours'
      + 'Jennifer P. says, "The team did a great job."See more$110Starting price$110Starting priceView profile'
      + 'Serves San Francisco, CA',
    name: 'MAXIMA - Spotless Homes.MAXIMA - Spotless Homes.',
    image_alt: 'Avatar for MAXIMA - Spotless Homes.',
    url: 'https://www.thumbtack.com/ca/san-francisco/house-cleaning/maxima/service/583813840609927168',
  };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {}, sequence: { [CARD]: [[card], [card]] } });
  const candidate = Object.values(search(page).value.candidates)[0];

  assert.equal(candidate.name, 'MAXIMA - Spotless Homes.');
  assert.equal(candidate.rating, 4.9);
  assert.equal(candidate.review_count, 98);
  assert.equal(candidate.hire_count, 202);
  // The card concatenates the amount and its label; the window is read by a person, so "$110Starting
  // price" gets its space back. The amount itself is never rewritten.
  assert.equal(candidate.price_text, '$110 Starting price');
  assert.match(candidate.response_time, /responds in about 2 hours/);
  assert.equal(candidate.location, 'Serves San Francisco, CA');
});

test('a figure past the summary cut is still read', () => {
  // The stored summary is bounded at 360 characters. Parsing the bounded copy would drop the hire count
  // of any card whose review quote runs long — the fields come off the full text, the cut is storage only.
  const filler = 'Jennifer P. says, "'.padEnd(400, 'a') + '"See more';
  const card = {
    text: `Clean CoClean Co 4.7(31)${filler}812 hires on Thumbtack`,
    name: 'Clean CoClean Co',
    url: 'https://www.thumbtack.com/ca/sf/house-cleaning/clean-co/service/700000000000000001/',
  };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {}, sequence: { [CARD]: [[card], [card]] } });
  const candidate = Object.values(search(page).value.candidates)[0];

  assert.equal(candidate.hire_count, 812);
  assert.ok(candidate.summary.length <= 360, 'the stored summary stays bounded');
});
