import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { loadLuaModules } from './harness.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/46_candidate_browser.lua',
]);
after(() => lua.close());

const PROS = [
  { service_id: 's1', name: '성실 하우스클리닝', url: 'https://www.thumbtack.com/a/s1', rating: 4.9, review_count: 210, price_text: '$150', response_time: 'Responds within a few hours', summary: '정기 청소 전문' },
  { service_id: 's2', name: 'Bright Home Care', url: 'https://www.thumbtack.com/a/s2', rating: 4.5, review_count: 640, price_text: '$95', response_time: 'Responds within a day', summary: 'Move-out cleaning' },
  { service_id: 's3', name: 'Fast Clean Co', url: 'https://www.thumbtack.com/a/s3', rating: 4.7, review_count: 40, price_text: '$210', response_time: 'Responds within minutes', summary: 'Deep cleaning crew' },
  { service_id: 's4', name: 'Budget Cleaners', url: 'https://www.thumbtack.com/a/s4', rating: 4.2, review_count: 88, price_text: 'Starting at $70', response_time: 'Responds within a week', summary: '저렴한 정기 청소' },
  { service_id: 's5', name: 'Prime Maids', url: 'https://www.thumbtack.com/a/s5', rating: 5.0, review_count: 12, price_text: '$300', response_time: 'Responds within an hour', summary: 'Premium service' },
  { service_id: 's6', name: '성실 클리너스', url: 'https://www.thumbtack.com/a/s6', rating: 4.4, review_count: 150, price_text: '$120', response_time: 'Responds within a day', summary: '성실하게 청소합니다' },
];

function browse(args) {
  return lua.call('AX_browse_service_candidates', { candidates: PROS, page_size: 3, ...args });
}

// ── criterion parsing for service pros ────────────────────────────────────────
// The model relays the user's sentence; ranking is deterministic here so the pro list never has to be
// re-emitted through the model.

test('parses the offered ranking criteria', () => {
  assert.equal(lua.call('AX_OFFER_VIEW.parse_candidate_refine', '평점 높은 순').sort, 'rating_desc');
  assert.equal(lua.call('AX_OFFER_VIEW.parse_candidate_refine', '리뷰 많은 순으로').sort, 'reviews_desc');
  assert.equal(lua.call('AX_OFFER_VIEW.parse_candidate_refine', '저렴한 순').sort, 'price_asc');
  assert.equal(lua.call('AX_OFFER_VIEW.parse_candidate_refine', '응답 빠른 순').sort, 'response_asc');
});

test('an unmatched sentence becomes a keyword filter, not a guess at a sort', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_candidate_refine', '성실');
  assert.equal(parsed.sort ?? null, null);
  assert.equal(parsed.filters.keyword, '성실');
});

test('a rating floor is understood alongside a keyword', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_candidate_refine', '평점 4.5 이상');
  assert.equal(parsed.filters.min_rating, 4.5);
});

// ── ranking + window ──────────────────────────────────────────────────────────

test('ranking is deterministic and the first window is one page', () => {
  const view = browse({ refine_request: '평점 높은 순' });

  assert.equal(view.next, 'ask');
  assert.equal(view.view_total, 6);
  assert.equal(view.view_pages, 2);
  assert.deepEqual(view.shortlist.slice(0, 3).map((entry) => entry.service_id), ['s5', 's1', 's3']);
  assert.match(view.shortlist_text, /(^|\n)1\./);
  assert.match(view.shortlist_text, /(^|\n)3\./);
  assert.doesNotMatch(view.shortlist_text, /(^|\n)4\./);
});

test('review and price ordering read the real fields', () => {
  assert.deepEqual(
    browse({ refine_request: '리뷰 많은 순' }).shortlist.slice(0, 2).map((entry) => entry.service_id),
    ['s2', 's1'],
  );
  // "Starting at $70" must sort as 70, not be dropped for not being a bare number.
  assert.deepEqual(
    browse({ refine_request: '저렴한 순' }).shortlist.slice(0, 2).map((entry) => entry.service_id),
    ['s4', 's2'],
  );
});

test('response speed orders by how soon the pro replies', () => {
  assert.deepEqual(
    browse({ refine_request: '응답 빠른 순' }).shortlist.slice(0, 3).map((entry) => entry.service_id),
    ['s3', 's5', 's1'],
  );
});

test('a keyword narrows the list to matching pros', () => {
  const view = browse({ refine_request: '성실' });
  assert.equal(view.view_total, 2);
  assert.deepEqual(view.shortlist.map((entry) => entry.service_id), ['s1', 's6']);
});

test('a keyword that matches nothing keeps the list and says so', () => {
  const view = browse({ refine_request: '수영장' });
  assert.equal(view.refine_error, 'no_matches');
  assert.equal(view.view_total, 6);
});

test('the rendered window carries the fields a choice needs', () => {
  const line = browse({ refine_request: '평점 높은 순' }).shortlist_text.split('\n').find((entry) => entry.startsWith('1.'));
  assert.match(line, /Prime Maids/);
  assert.match(line, /5\.0/);
  assert.match(line, /12/);
});

// ── paging + selection ────────────────────────────────────────────────────────

test('paging keeps global numbering across windows', () => {
  const second = browse({ refine_request: '평점 높은 순', page: 1, page_command: 'next' });
  assert.equal(second.view_page, 2);
  assert.match(second.shortlist_text, /(^|\n)4\./);
  assert.match(second.shortlist_text, /(^|\n)6\./);
  assert.doesNotMatch(second.shortlist_text, /(^|\n)1\./);
});

test('numbers select the pros behind them, in the order shown', () => {
  const chosen = browse({ refine_request: '평점 높은 순', choice_numbers: '2, 4' });

  assert.equal(chosen.next, 'done');
  assert.deepEqual(chosen.refine_selected.map((entry) => entry.service_id), ['s1', 's2']);
  for (const entry of chosen.refine_selected) {
    assert.ok(entry.url, 'a selected pro must keep its url');
    assert.ok(entry.service_id, 'a selected pro must keep its service_id');
  }
});

test('a number outside the list is refused instead of silently dropped', () => {
  const chosen = browse({ refine_request: '평점 높은 순', choice_numbers: '9' });
  assert.equal(chosen.next, 'ask');
  assert.equal(chosen.refine_error, 'invalid_choice');
});

test('selection without any criterion still works on the default ranking', () => {
  const chosen = browse({ choice_numbers: '1' });
  assert.equal(chosen.next, 'done');
  assert.equal(chosen.refine_selected.length, 1);
});

test('an empty candidate list is reported, not rendered as a page of nothing', () => {
  const view = lua.call('AX_browse_service_candidates', { candidates: [], page_size: 3 });
  assert.equal(view.next, 'error');
  assert.equal(view.refine_error, 'no_candidates');
});

// ── the browser drives the dialogue itself ───────────────────────────────────
// With an LLM node in the loop the same criterion was re-sent forever: the browser rendered, routed back
// to the model, and the model — seeing the user's unchanged message — asked for the same refinement
// again (4 rounds in one live turn). The browser therefore reads the user's reply itself and pauses.

test('the rendered window is the question, so the flow waits for the user', () => {
  const view = browse({ request_text: '리뷰 많은 순' });
  assert.equal(view.next, 'ask');
  assert.equal(view.question, view.shortlist_text, 'the pause must show the window');
});

test('a reply that is only numbers is a selection', () => {
  const chosen = browse({ request_text: '2번이랑 4번' });
  assert.equal(chosen.next, 'done');
  assert.deepEqual(chosen.refine_selected.map((entry) => entry.service_id).length, 2);
});

test('a reply that names a page moves the window', () => {
  const first = browse({ request_text: '평점 높은 순' });
  const next = browse({ request_text: '다음', page: first.view_page, refine_request: '평점 높은 순' });
  assert.equal(next.next, 'ask');
  assert.equal(next.view_page, 2);
});

test('a criterion in the reply re-ranks the list', () => {
  const view = browse({ request_text: '저렴한 순' });
  assert.deepEqual(view.shortlist.slice(0, 2).map((entry) => entry.service_id), ['s4', 's2']);
});

test('a number mixed into a sentence still selects', () => {
  const chosen = browse({ request_text: '3번으로 해줘', refine_request: '평점 높은 순' });
  assert.equal(chosen.next, 'done');
  assert.equal(chosen.refine_selected.length, 1);
});

test('a cancellation is not mistaken for a criterion', () => {
  const cancelled = browse({ request_text: '취소' });
  assert.equal(cancelled.next, 'cancel');
});

test('an empty reply just re-renders the current window', () => {
  const view = browse({ request_text: '   ' });
  assert.equal(view.next, 'ask');
  assert.equal(view.view_total, 6);
});

// A live Thumbtack card carried an <img> tag inside its response-time text and it went straight into the
// window the user reads. The window is a text surface: markup never belongs in it.
test('markup from a card never reaches the rendered window', () => {
  const dirty = [{
    service_id: 'x1',
    name: '<b>Sparkle</b> Cleaning',
    url: 'https://www.thumbtack.com/a/x1',
    rating: 4.8,
    review_count: 12,
    price_text: '$120  <img src="https://cdn.example.com/a.png">',
    response_time: 'Responds within a day <img src="https://cdn.example.com/b.png" />',
    summary: '<div class="x">깨끗하게</div>',
  }];
  const view = lua.call('AX_browse_service_candidates', { candidates: dirty, page_size: 3 });

  assert.doesNotMatch(view.shortlist_text, /<[^>]+>/, view.shortlist_text);
  assert.doesNotMatch(view.shortlist_text, /img src/);
  assert.match(view.shortlist_text, /Sparkle Cleaning/);
  assert.match(view.shortlist_text, /\$120/);
  assert.match(view.shortlist_text, /Responds within a day/);
});

test('a field that is only markup is dropped, not rendered empty', () => {
  const dirty = [{
    service_id: 'x2', name: 'Clean Co', url: 'https://www.thumbtack.com/a/x2', rating: 5,
    review_count: 3, price_text: '<img src="x">', response_time: '   ', summary: '',
  }];
  const line = lua.call('AX_browse_service_candidates', { candidates: dirty, page_size: 3 })
    .shortlist_text.split('\n').find((entry) => entry.startsWith('1.'));

  assert.match(line, /Clean Co/);
  assert.doesNotMatch(line, /· *·/, 'an emptied field must not leave a dangling separator');
  assert.doesNotMatch(line, /· *$/);
});

// Thumbtack's card summary is the whole card text, which starts with the pro's name repeated and the
// rating it already shows: rendering it produced "House Cleaning ProfessionalHouse Clea…" as the most
// prominent field on the line. A summary earns its place only when it says something new.
test('a summary that only repeats the name and rating is not rendered', () => {
  const noisy = [{
    service_id: 'n1', name: 'House Cleaning Professional', url: 'https://www.thumbtack.com/a/n1',
    rating: 4.9, review_count: 129, price_text: 'Contact for price',
    summary: 'House Cleaning ProfessionalHouse Cleaning Professional4.9(129)Top Pro',
  }];
  const line = lua.call('AX_browse_service_candidates', { candidates: noisy, page_size: 3 })
    .shortlist_text.split('\n').find((entry) => entry.startsWith('1.'));

  assert.match(line, /House Cleaning Professional/);
  assert.doesNotMatch(line, /ProfessionalHouse/, line);
  assert.doesNotMatch(line, /4\.9\(129\)/);
});

test('a real summary is still shown', () => {
  const useful = [{
    service_id: 'n2', name: 'Sparkle Cleaning', url: 'https://www.thumbtack.com/a/n2', rating: 4.6,
    review_count: 20, summary: 'Sparkle Cleaning 이사 청소와 정기 청소를 전문으로 합니다',
  }];
  const line = lua.call('AX_browse_service_candidates', { candidates: useful, page_size: 3 })
    .shortlist_text.split('\n').find((entry) => entry.startsWith('1.'));

  assert.match(line, /이사 청소/);
});

// The exact strings a live Thumbtack search produced. The name repeats a third time truncated, and the
// rating parenthetical can sit behind it — both leaked into the window.
test('real card summaries reduce to their informative part', () => {
  const cases = [
    ['House Cleaning Professional',
     'House Cleaning ProfessionalHouse Cleaning ProfessionalHouse Clea',
     null],
    ['Fer Housecleaner',
     'Fer HousecleanerFer Housecleaner5.0(1)Pedro C. says, "Great job"',
     /Pedro C\. says/],
    ['De Leon cleaning services',
     'De Leon cleaning servicesDe Leon cleaning',
     null],
    ['Sparkle Cleaning',
     'Sparkle Cleaning4.6(20)이사 청소 전문입니다',
     /이사 청소 전문입니다/],
  ];

  for (const [name, summary, expected] of cases) {
    const value = lua.call('AX_OFFER_VIEW.candidate_summary', { name, summary });
    if (expected === null) {
      assert.equal(value ?? null, null, `"${summary}" should render nothing, got "${value}"`);
    } else {
      assert.match(value, expected);
      assert.doesNotMatch(value, new RegExp(name.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(value, /\d\.\d\(\d+\)/);
    }
  }
});

test('a selection resolves against the ordering the window showed', () => {
  const shown = browse({ request_text: '리뷰 많은 순' });
  const first = shown.shortlist[0].service_id;
  const second = shown.shortlist[1].service_id;

  // The next turn carries the criterion forward exactly as the flow state does.
  const chosen = browse({ request_text: '1번이랑 2번', refine_request: shown.refine_request });
  assert.deepEqual(chosen.refine_selected.map((entry) => entry.service_id), [first, second]);
});

test('the window answer states the criterion it applied', () => {
  assert.equal(browse({ request_text: '리뷰 많은 순' }).refine_request, '리뷰 많은 순');
});

// A refusal must end the request cleanly even when the planner restarts the route instead of resuming
// it: live, "아니요, 견적 요청은 취소할게요" re-entered the flow at its first node and asked the user which
// service they wanted — as if they had just arrived.
//
// The guard is the quote flow's ENTRY, so it cannot be a remote command: an entry's remote call is
// executed by the extension and never consumed by the engine. It therefore runs as in-engine Lua inside
// the flow definition, and the source under test is read from there — which also proves that embedded
// Lua parses, something no live run reports until the node is reached.
const entryGuardSource = parseYaml(readFileSync('_common/flows.yaml', 'utf8'))
  .flowTools.detect_cancellation.execute.lua;
const guardLua = loadLuaModules([]);
guardLua.define(`function AX_TEST_detect_cancellation(args) ${entryGuardSource} end`);
after(() => guardLua.close());

const guard = (args) => guardLua.call('AX_TEST_detect_cancellation', args);

test('a standalone cancellation is detected at the flow entry', () => {
  for (const requestText of ['아니요, 견적 요청은 취소할게요', '취소', '그만할게요', '됐어요', 'cancel', 'never mind']) {
    assert.equal(guard({ requestText }).next, 'cancel', requestText);
  }
});

test('a real request that merely mentions cancelling is not a cancellation', () => {
  for (const requestText of [
    '취소 정책이 어떻게 되는지 물어봐줘',
    '샌프란시스코 하우스클리닝 견적 받아줘',
    '예약 취소 가능한 청소 업체 찾아줘',
  ]) {
    assert.equal(guard({ requestText }).next, 'continue', requestText);
  }
});

test('an empty message is not a cancellation', () => {
  assert.equal(guard({}).next, 'continue');
  assert.equal(guard({ requestText: '   ' }).next, 'continue');
});
