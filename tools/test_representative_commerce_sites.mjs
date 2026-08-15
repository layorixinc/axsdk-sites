#!/usr/bin/env bun
// Offline gate for the representative commerce storefronts, on the RPC path.
//
// The durable stack this file used to load (`_common/scripts/*` plus each site's own scripts/ layer,
// driving the durable stored-search command with a retry on `status: "navigating"`) is gone: the
// shipping extension is `@axsdk/extension-cdp` and it
// runs the RPC modules. What this gate proves is unchanged — per-adapter reader contracts, relevance
// anchoring, landed-cost normalization, identity metadata, and the cart approval gates — asserted
// against `_common/rpc/61_rpc_storefront.lua` + the generated `62_rpc_sites.lua`, through the honest
// browser stub in `tools/lua/rpc-stub.mjs` (a row field the reader never REQUESTED is invisible, the
// way `queryLuaElements` behaves — the permissive in-process runtime this file used before showed the
// reader fields no site selector could produce).
//
// Load order, derived from the module guards:
//   50_commerce_core raises "00_base.lua must be loaded before 50_commerce_core.lua";
//   51/52/56 each raise "50_commerce_core.lua must be loaded before <file>"; and 56_store_io's header
//   captures C.matches_query (assigned by 51_relevance) and C.infer_model (assigned by 52_identity),
//   so both must precede it. The rpc modules guard nothing at load time: 61/67 resolve dom/nav and
//   RPC_SITES at CALL time, 62 is pure data, and 63_pure_entries calls the globals 56 defines.
import { loadLuaModules } from './lua/harness.mjs';
import { installRpcStub, makePage } from './lua/rpc-stub.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/50_commerce_core.lua',
  '_common/scripts/51_relevance.lua',
  '_common/scripts/52_identity.lua',
  '_common/scripts/56_store_io.lua',
  '_common/rpc/62_rpc_sites.lua',
  '_common/rpc/61_rpc_storefront.lua',
  '_common/rpc/63_pure_entries.lua',
  '_common/rpc/67_rpc_cart.lua',
]);

// The FX table the durable gate served through its fake `net.fetch`, unchanged: KRW 1000/USD is what
// makes every Korean landed cost land on the same numbers as before.
lua.expose({
  net: {
    fetch: () => ({ ok: true, status: 200, json: { base: 'USD', date: '2026-07-14', rates: { KRW: 1000, EUR: 0.8, GBP: 0.75, JPY: 150 } } }),
  },
});

const QUERY = 'Logitech M185';
// The flow context the normalizer really receives: the model that read the request supplies the brand
// and its spellings (the durable fixtures instead put `brand` on every row — a field no site selector
// produces, visible only because the old stub ignored the requested field set).
const CONTEXT = { query: QUERY, quantity: 1, requested_brand: 'Logitech', brand_aliases: 'Logitech|로지텍' };

let assertions = 0;
function assert(condition, message, context) {
  if (!condition) throw new Error(`${message}${context === undefined ? '' : ` :: ${JSON.stringify(context)}`}`);
  assertions += 1;
}

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}\n       ${error.message}`);
  }
}

// Search one store the way production does: the RPC reader touches the page, then the pure normalizer
// (relevance, FX, landed cost, identity) runs over its `store_result`.
function searchStore(page, site, context = CONTEXT) {
  installRpcStub(lua, page);
  const searched = lua.call('AX_RPC_STOREFRONT.run_store_search', { item: { site }, context });
  const normalized = lua.call('AX_RPC_PURE.normalize_store_result', { item: { site }, context, store_result: searched.store_result });
  return { searched, value: normalized.store_result, ops: page.ops };
}

function addToCart(page, args) {
  installRpcStub(lua, page);
  return { value: lua.call('AX_RPC_CART.add_to_cart', args), ops: page.ops };
}

const WRITE_OP = /^(dom\.(click|set_value|set_form_field_value|submit_form)|page\.eval|nav\.navigate)$/;

const lockedApproval = {
  identity_id: 'identity-m185',
  comparison_id: 'cmp-current',
  identity_approval: 'locked_product_identity',
  comparison_approval: 'current_comparison',
};

// One row per store, shaped by what that site's SHIPPED config actually requests (a field without a
// declared selector is never asked for, so putting it on the row would assert nothing). Card text keeps
// the measured shapes: struck price + sale price runs, `배송비` cells, sr-only labels glued to values.
const naverRow = {
  url: 'https://search.shopping.naver.com/catalog/8888888888',
  title: 'Logitech M185 Wireless Mouse',
  image_alt: 'Logitech M185 Wireless Mouse',
  text: 'Logitech M185 Wireless Mouse 최저 13,500원 배송비 2,500원',
};

const siteCases = [
  {
    site: 'walmart', home: 'https://www.walmart.com/', id: '16207314', total: 12.99, currency: 'USD',
    dom: {
      '[data-item-id][data-dca-id]': [{
        url: 'https://www.walmart.com/ip/Logitech-M185/16207314',
        title: 'Logitech M185 Wireless Mouse',
        image_alt: 'Logitech M185 Wireless Mouse',
        price_text: '$12.99',
        shipping_text: 'Free shipping',
        rating_text: '4.8 out of 5',
        reviews_text: '(123)',
        text: 'Logitech M185 Wireless Mouse $12.99 Free shipping',
      }],
    },
  },
  {
    // The card root IS the anchor (`result_url_from_root`): the url is read off the root's own href,
    // there is no descendant link and no id attribute. This exact shape shipped broken once — every
    // aliexpress row dropped for lack of an id — so this case is the guard against its return.
    site: 'aliexpress', home: 'https://www.aliexpress.com/', id: '1005012516905651', total: 8.73, currency: 'KRW',
    dom: {
      'a.search-card-item[href*="/item/"]': [{
        url: 'https://www.aliexpress.com/item/1005012516905651.html',
        title: '로지텍 M185 무선 마우스',
        image_alt: '로지텍 M185 무선 마우스',
        text: '로지텍 M185 무선 마우스 ₩8,730 무료 배송',
      }],
    },
  },
  {
    site: 'etsy', home: 'https://www.etsy.com/', id: '1234567890', total: 17.5, currency: 'USD',
    dom: {
      '[data-listing-id]': [{
        root_id: '1234567890',
        url: 'https://www.etsy.com/listing/1234567890/sample',
        title: 'Logitech M185 Wireless Mouse',
        image_alt: 'Logitech M185 Wireless Mouse',
        price_text: '$14.50',
        shipping_text: 'Shipping $3.00',
        rating_text: '4.8 out of 5 stars',
        text: 'Logitech M185 Wireless Mouse $14.50 Shipping $3.00',
      }],
    },
  },
  {
    site: 'coupang', home: 'https://www.coupang.com/', id: '7777777777', total: 12.9, currency: 'KRW',
    dom: {
      'li[data-id]:has(a[href*="/vp/products/"])': [{
        url: 'https://www.coupang.com/vp/products/7777777777',
        title: 'Logitech M185 Wireless Mouse',
        image_alt: 'Logitech M185 Wireless Mouse',
        shipping_text: '무료배송',
        text: 'Logitech M185 Wireless Mouse 12,900원 무료배송',
      }],
    },
  },
  {
    site: 'naver-shopping', home: 'https://shopping.naver.com/', id: '8888888888', total: 16, currency: 'KRW',
    cartUnsupported: true,
    dom: {
      // The readiness probe checks the bare `[data-shp-contents-id]` list part; the grid read uses the
      // full :not() selector. Both name the same cards on the live page.
      '[data-shp-contents-id]:not([data-shp-contents-id] [data-shp-contents-id])': [naverRow],
      '[data-shp-contents-id]': [naverRow],
    },
  },
  {
    site: 'gmarket', home: 'https://www.gmarket.co.kr/', id: '9999999999', total: 17, currency: 'KRW',
    dom: {
      '.box__item-container': [{
        root_id: '9999999999',
        url: 'https://item.gmarket.co.kr/Item?goodscode=9999999999',
        title: 'Logitech M185 Wireless Mouse',
        image_alt: 'Logitech M185 Wireless Mouse',
        price_text: '14,000',
        shipping_text: '배송비 3,000원',
        text: 'Logitech M185 Wireless Mouse 14,000 배송비 3,000원',
      }],
    },
  },
  {
    site: '11st', home: 'https://www.11st.co.kr/', id: '2035182061', total: 19.4, currency: 'KRW',
    dom: {
      'li.c-search-list__item': [{
        url: 'https://www.11st.co.kr/products/2035182061',
        title: 'Logitech M185 Wireless Mouse',
        image_alt: 'Logitech M185 Wireless Mouse',
        price_text: '16,900',
        // Measured on the live card: the sr-only label is glued to the value with no separator.
        shipping_text: '배송비2,500원',
        rating_text: '4.8',
        text: 'Logitech M185 Wireless Mouse 16,900 배송비2,500원',
      }],
    },
  },
  {
    site: 'ssg', home: 'https://www.ssg.com/', id: '1000612345678', total: 18, currency: 'KRW',
    dom: {
      'div:has(> a[href*="itemId="])': [{
        url: 'https://www.ssg.com/item/itemView.ssg?itemId=1000612345678',
        title: 'Logitech M185 Wireless Mouse',
        image_alt: 'Logitech M185 Wireless Mouse',
        text: 'Logitech M185 Wireless Mouse 18,000원 무료배송',
      }],
    },
  },
];

for (const store of siteCases) {
  run(`${store.site} search/normalize/approval contract`, () => {
    const page = makePage({ href: store.home, afterNavigate: store.dom });
    const { value } = searchStore(page, store.site);
    assert(value.site === store.site, `${store.site}: site preserved`, value);
    assert(value.status === 'candidates', `${store.site}: durable-shaped status for the normalizer`, value);
    assert(value.candidates?.length === 1, `${store.site}: one candidate normalized`, value);
    const candidate = value.candidates[0];
    assert(candidate.product_id === store.id, `${store.site}: product id parsed`, candidate);
    assert(candidate.currency === store.currency, `${store.site}: currency parsed`, candidate);
    assert(candidate.cost_complete === true, `${store.site}: item plus shipping is complete`, candidate);
    assert(Math.abs(candidate.total_base - store.total) < 0.0001, `${store.site}: landed cost normalized`, candidate);
    assert(candidate.brand === 'Logitech', `${store.site}: brand identity retained through normalization`, candidate);
    // No shipped config declares a model selector, so the model rides as a TITLE INFERENCE — which must
    // never claim the confidence explicit metadata earns (that contract has its own test below).
    assert(candidate.model_hint === 'M185' && candidate.identity_confidence === 'medium',
      `${store.site}: model identity hint retained, at inferred confidence`, candidate);

    const denied = addToCart(makePage({ href: store.home }), { site: store.site, product_id: store.id });
    assert(denied.value.error === 'approval_required' && denied.value.added === false,
      `${store.site}: scoped approval required`, denied.value);
    assert(denied.ops.length === 0, `${store.site}: missing approval cannot touch the page`, denied.ops);

    if (store.cartUnsupported) {
      const unsupported = addToCart(makePage({ href: store.home }), {
        site: store.site,
        product_id: store.id,
        ...lockedApproval,
        cart_approval: 'user_selected_compared_offer',
      });
      assert(unsupported.value.error === 'add_to_cart_unsupported',
        `${store.site}: comparison-only cart boundary explicit`, unsupported.value);
    }
  });
}

run('generic storefront identity guard', () => {
  const page = makePage({
    href: 'https://www.walmart.com/ip/Logitech-M185/16207314',
    dom: {
      'h1[itemprop="name"]': [{ text: 'Logitech M650 Silent Wireless Mouse' }],
      '[itemprop="price"][data-seo-id="hero-price"]': [{ text: '$12.99' }],
      'main button[data-automation-id="atc"]': [{ text: 'Add to cart' }],
    },
  });
  const { value, ops } = addToCart(page, {
    site: 'walmart',
    product_id: '16207314',
    expected_identity_model: 'M185',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(value.error === 'identity_changed' && value.added === false, 'generic storefront model mismatch blocks mutation', value);
  assert(!ops.some((entry) => WRITE_OP.test(entry.op)), 'identity mismatch cannot click', ops);
});

run('generic storefront stale-price guard', () => {
  const page = makePage({
    href: 'https://www.walmart.com/ip/Logitech-M185/16207314',
    dom: {
      'h1[itemprop="name"]': [{ text: 'Logitech M185 Wireless Mouse' }],
      '[itemprop="price"][data-seo-id="hero-price"]': [{ text: '$13.99' }],
      'main button[data-automation-id="atc"]': [{ text: 'Add to cart' }],
    },
  });
  const { value, ops } = addToCart(page, {
    site: 'walmart',
    product_id: '16207314',
    expected_unit_price: 12.99,
    expected_currency: 'USD',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(value.error === 'price_changed' && value.added === false, 'generic storefront stale price blocks mutation', value);
  assert(!ops.some((entry) => WRITE_OP.test(entry.op)), 'stale price cannot click', ops);
});

run('live-access challenge classification', () => {
  const page = makePage({
    href: 'https://www.gmarket.co.kr/',
    afterNavigate: { body: [{ text: '원활한 쇼핑을 위해 현재 간단한 봇 확인 절차가 진행되고 있습니다.' }] },
  });
  const { value } = searchStore(page, 'gmarket');
  // The durable result carried `blocked: true`; the RPC store_result carries the classification itself
  // as its status, which is the field the flow and the user-facing renderer actually read.
  assert(value.status === 'security_verification_required' && value.error === 'security_verification_required',
    'challenge is explicit, not no-results', value);
  assert((value.candidates ?? []).length === 0, 'a wall yields no candidates to rank', value);
});

run('irrelevant rows classify as no results', () => {
  const page = makePage({
    href: 'https://www.walmart.com/',
    afterNavigate: {
      '[data-item-id][data-dca-id]': [{
        url: 'https://www.walmart.com/ip/Logitech-M185/16207314',
        title: 'Unrelated USB Keyboard',
        image_alt: 'Unrelated USB Keyboard',
        price_text: '$9.99',
        shipping_text: 'Free shipping',
        text: 'Unrelated USB Keyboard $9.99 Free shipping',
      }],
    },
  });
  const { value } = searchStore(page, 'walmart');
  assert(value.error === 'no_results', 'irrelevant storefront rows become an explicit no-results outcome', value);
  assert((value.candidates ?? []).length === 0, 'irrelevant storefront rows cannot leak into ranked offers', value);
});

run('storefront search survives its own navigation in one call', () => {
  // The durable adapter answered `status: "navigating"` and made the flow call it again; the RPC script
  // keeps its stack across the reload, so ONE call navigates, waits and reads. The rows exist only on
  // the post-navigation document, so a read of the old page could never find them.
  const walmart = siteCases.find((store) => store.site === 'walmart');
  const page = makePage({ href: walmart.home, afterNavigate: walmart.dom });
  const { searched, value, ops } = searchStore(page, 'walmart');
  const names = ops.map((entry) => entry.op);
  assert(searched.next === 'done' && searched.store_result.status === 'candidates' && !searched.store_result.pending,
    'one call crosses its own navigation — no navigating handshake survives', searched);
  const navigateAt = names.indexOf('nav.navigate');
  const readAt = names.indexOf('dom.query_all');
  const hrefAfterNavigate = names.indexOf('dom.get_location_href', navigateAt);
  assert(navigateAt !== -1 && hrefAfterNavigate !== -1 && navigateAt < hrefAfterNavigate && hrefAfterNavigate < readAt,
    'search cannot touch the old DOM: href is observed after the navigation and before the grid read', names);
  assert(names.filter((name) => name === 'dom.query_all').length === 1 && value.candidates?.length === 1,
    'the new document is read, in one round trip', { names, candidates: value.candidates });
  assert(!ops.some((entry) => /^(dom\.(click|set_value|submit_form)|page\.eval)$/.test(entry.op)),
    'a read-only search never touches a write op', ops);
});

run('storefront cart mutation survives its own navigation in one call', () => {
  const page = makePage({
    href: 'https://www.walmart.com/',
    afterNavigate: {
      'h1[itemprop="name"]': [{ text: 'Logitech M185 Wireless Mouse' }],
      '[itemprop="price"][data-seo-id="hero-price"]': [{ text: '$12.99' }],
      'main button[data-automation-id="atc"]': [{ text: 'Add to cart' }],
    },
    onClick: (selector, current) => {
      current.dom['[data-testid="add-to-cart-success"]'] = [{ text: 'Added to cart' }];
    },
  });
  const { value, ops } = addToCart(page, {
    site: 'walmart',
    product_id: '16207314',
    expected_identity_model: 'M185',
    expected_unit_price: 12.99,
    expected_currency: 'USD',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  const names = ops.map((entry) => entry.op);
  assert(value.added === true && value.next === 'done', 'one approved call navigates, revalidates and adds', value);
  assert(value.status !== 'navigating' && value.pending === undefined, 'no mid-navigation handshake survives', value);
  const navigateAt = names.indexOf('nav.navigate');
  const clickAt = names.indexOf('dom.click');
  assert(names.filter((name) => name === 'dom.click').length === 1,
    'revalidation clicks exactly once', names);
  // The button exists only on the post-navigation product page, so this order plus the successful add
  // proves the click landed on the new document, never the old one.
  assert(navigateAt !== -1 && clickAt !== -1 && navigateAt < clickAt,
    'cart adapter cannot click on the old page: the click follows the navigation', names);
});

run('Coupang current-price text fallback', () => {
  // Measured card text: struck price, discount percent, sale price, then the shipping cell. The paid
  // fee lives in the dedicated `[data-badge-type="feePrice"]` badge the config declares — in the ROW
  // text the trailing `조건부 무료배송` copy would read as free, which is exactly why the badge exists.
  const page = makePage({
    href: 'https://www.coupang.com/',
    afterNavigate: {
      'li[data-id]:has(a[href*="/vp/products/"])': [{
        url: 'https://www.coupang.com/vp/products/7777777777',
        title: '로지텍 무선마우스, M185, Gray',
        image_alt: '로지텍 무선마우스, M185, Gray',
        shipping_text: '배송비 2,500원',
        text: '로지텍 무선마우스, M185, Gray 16,510원 35% 10,690원 배송비 2,500원 조건부 무료배송',
      }],
    },
  });
  const { value } = searchStore(page, 'coupang', { query: '로지텍 M185', quantity: 1 });
  assert(value.candidates?.[0]?.price === 10690, 'Coupang should use the current sale price before shipping text', value);
  assert(value.candidates[0].shipping_cost === 2500, 'Coupang should parse the separate paid shipping amount', value.candidates[0]);
});

run('Naver access restriction classification', () => {
  const page = makePage({
    href: 'https://shopping.naver.com/',
    afterNavigate: { body: [{ text: '쇼핑 서비스 접속이 일시적으로 제한되었습니다. 비정상적인 접근이 감지되었습니다.' }] },
  });
  const { value } = searchStore(page, 'naver-shopping', { query: '로지텍 M185', quantity: 1 });
  assert(value.status === 'access_denied' && value.error === 'access_denied',
    'Naver temporary access restriction must be classified, not reported as no results', value);
});

run('SSG embedded search-data fallback', () => {
  const embedded = '{"itemId":"1000623630874","itemName":"로지텍 무선마우스(M185 레드 Logitech)","brandName":"Logitech","itemUrl":"https:\\/\\/www.ssg.com\\/item\\/itemView.ssg?itemId=1000623630874","itemImgUrl":"https:\\/\\/example.com\\/m185.jpg","rawPrimaryPrice":"19,900","reviewCount":"42","shippingCostInfo":[{"type":"배송비","text":"무료배송"}]}';
  const page = makePage({
    href: 'https://www.ssg.com/',
    afterNavigate: { 'script#__NEXT_DATA__': [{ text: embedded }] },
  });
  const { value } = searchStore(page, 'ssg', { query: '로지텍 M185', quantity: 1 });
  assert(value.candidates?.length === 1 && value.candidates[0].product_id === '1000623630874',
    'SSG should read its server-rendered Next data when the client grid is blank', value);
  assert(value.candidates[0].price === 19900 && value.candidates[0].shipping_cost === 0,
    'SSG embedded candidate cost should be normalized', value.candidates[0]);
});

run('explicit storefront metadata is retained and grounds high confidence', () => {
  // The durable gate asserted `brand`/`manufacturer_model`/`identity_confidence: high` on every site,
  // but its stub ignored the requested field set — no shipped config declares brand/model selectors, so
  // no real page read ever produced those fields. The contract that was actually being defended lives
  // here: a config that DOES declare where metadata sits gets it carried through candidate_from and the
  // normalizer untouched, and explicit metadata — not title inference — is what earns "high".
  const metadataSite = {
    site: 'walmart',
    search_url: 'https://www.walmart.com/search',
    search_param: 'q',
    search_path_marker: '/search',
    result_selector: '[data-item-id][data-dca-id]',
    result_url_selector: 'a[link-identifier][href*="/ip/"]',
    result_title_selector: '[data-automation-id="product-title"]',
    result_price_selector: '[data-automation-id="product-price"]',
    result_shipping_selector: '[data-automation-id="fulfillment-badge"]',
    result_brand_selector: '[data-testid="product-brand"]',
    result_model_selector: '[data-testid="product-model"]',
    default_currency: 'USD',
    product_id_patterns: ['/ip/[^/?]+/(%d+)', '/ip/(%d+)'],
  };
  const page = makePage({
    href: 'https://www.walmart.com/search?q=Logitech+M185',
    dom: {
      '[data-item-id][data-dca-id]': [{
        url: 'https://www.walmart.com/ip/Logitech-M185/16207314',
        title: 'Logitech M185 Wireless Mouse',
        brand: 'Logitech',
        manufacturer_model: 'M185',
        price_text: '$12.99',
        shipping_text: 'Free shipping',
        text: 'Logitech M185 Wireless Mouse $12.99 Free shipping',
      }],
    },
  });
  installRpcStub(lua, page);
  const raw = lua.call('AX_RPC_STOREFRONT.search', metadataSite, { query: QUERY });
  const normalized = lua.call('AX_RPC_PURE.normalize_store_result', {
    item: { site: 'walmart' },
    context: CONTEXT,
    store_result: { site: 'walmart', status: 'candidates', candidates: raw.candidates },
  });
  const candidate = normalized.store_result.candidates[0];
  assert(candidate.brand === 'Logitech' && candidate.manufacturer_model === 'M185',
    'storefront identity metadata retained', candidate);
  assert(candidate.model_hint === 'M185' && candidate.identity_confidence === 'high',
    'model identity hint retained', candidate);
});

run('a transient op refusal is never read as a page fact', () => {
  // Recorded regression: one refused op while the channel re-attached raised out of the search and the
  // store was reported lost — or worse, empty. Every third op refused is what a re-attaching channel
  // looks like; the reader retries once per read, so the page it already parsed must still come back.
  const walmart = siteCases.find((store) => store.site === 'walmart');
  const page = makePage({
    href: 'https://www.walmart.com/search?q=Logitech+M185',
    dom: walmart.dom,
    flakyEvery: 3,
  });
  const { value } = searchStore(page, 'walmart');
  assert(value.status === 'candidates' && value.candidates?.length === 1,
    'a refused op is retried, not reported as a store outcome', value);
  assert(value.error === undefined, 'a transient refusal never becomes no_results or a wall', value);
});

console.log(`\n${passed}/${passed + failed} tests passed (${assertions} assertions)`);
lua.close();
process.exit(failed ? 1 : 0);
