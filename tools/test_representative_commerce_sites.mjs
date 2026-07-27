#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const sdkDir = process.env.AXSDK_SDK_DIR || resolve(repoRoot, '..', 'axsdk-sdk-js');
const runtimePath = join(sdkDir, 'packages', 'axsdk-lua', 'src', 'runtime.ts');
if (!existsSync(runtimePath)) {
  console.log(`SKIP: AXSDK Lua runtime not found at ${runtimePath}`);
  process.exit(0);
}

const { AXLuaRuntime } = await import(`file://${runtimePath}`);
const commonFiles = [
  '_common/scripts/00_base.lua',
  '_common/scripts/50_commerce.lua',
  '_common/scripts/60_storefront.lua',
];
const siteCases = [
  { site: 'walmart', home: 'https://www.walmart.com/', url: 'https://www.walmart.com/ip/Logitech-M185/16207314', id: '16207314', price: '$12.99', shipping: 'Free shipping', total: 12.99, currency: 'USD' },
  { site: 'aliexpress', home: 'https://www.aliexpress.com/', url: 'https://www.aliexpress.com/item/1005012516905651.html', id: '1005012516905651', title: '로지텍 M185 무선 마우스', price: '₩8,730', shipping: '무료 배송', total: 8.73, currency: 'KRW' },
  { site: 'etsy', home: 'https://www.etsy.com/', url: 'https://www.etsy.com/listing/1234567890/sample', id: '1234567890', price: '$14.50', shipping: 'Shipping $3.00', total: 17.5, currency: 'USD' },
  { site: 'coupang', home: 'https://www.coupang.com/', url: 'https://www.coupang.com/vp/products/7777777777', id: '7777777777', price: '12,900원', shipping: '무료배송', total: 12.9, currency: 'KRW' },
  { site: 'naver-shopping', home: 'https://shopping.naver.com/', url: 'https://search.shopping.naver.com/catalog/8888888888', id: '8888888888', rootId: '8888888888', price: '최저 13,500원', shipping: '배송비 2,500원', total: 16, currency: 'KRW', cartUnsupported: true },
  { site: 'gmarket', home: 'https://www.gmarket.co.kr/', url: 'https://item.gmarket.co.kr/Item?goodscode=9999999999', id: '9999999999', price: '14,000', shipping: '배송비 3,000원', total: 17, currency: 'KRW' },
  { site: '11st', home: 'https://www.11st.co.kr/', url: 'https://www.11st.co.kr/products/2035182061', id: '2035182061', price: '16,900', shipping: '배송비 2,500원', total: 19.4, currency: 'KRW' },
  { site: 'ssg', home: 'https://www.ssg.com/', url: 'https://www.ssg.com/item/itemView.ssg?itemId=1000612345678', id: '1000612345678', price: '18,000원', shipping: '무료배송', total: 18, currency: 'KRW' },
];

let assertions = 0;
function assert(condition, message, context) {
  if (!condition) throw new Error(`${message}${context === undefined ? '' : ` :: ${JSON.stringify(context)}`}`);
  assertions += 1;
}

function globalsFor(testCase, overrides = {}) {
  const state = {
    href: testCase.home,
    body: overrides.body || '',
    rows: overrides.rows || [{
      root_id: testCase.rootId,
      url: testCase.url,
      title: testCase.title || 'Logitech M185 Wireless Mouse',
      image_alt: testCase.title || 'Logitech M185 Wireless Mouse',
      brand: 'Logitech',
      manufacturer_model: 'M185',
      price_text: testCase.price,
      shipping_text: testCase.shipping,
      rating_text: '4.8 out of 5',
      reviews_text: '(123)',
      text: `Logitech M185 Wireless Mouse ${testCase.price} ${testCase.shipping}`,
    }],
    tokens: [...(overrides.tokens || [])],
    text: { ...(overrides.text || {}) },
    attrs: { ...(overrides.attrs || {}) },
    clicked: [],
    navigations: [],
    queryAllCalls: 0,
    waitCalls: 0,
  };
  const exists = selector => state.tokens.some(token => selector.includes(token));
  return {
    state,
    globals: {
      nav: {
        navigate(url, params = {}) {
          const query = new URLSearchParams(params).toString();
          state.href = query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url;
          state.navigations.push(state.href);
          return { fired: true, arrived: true, url: state.href };
        },
        clear_beforeunload() { return true; },
      },
      dom: {
        get_location_href() { return state.href; },
        exists,
        wait_for_selector(selector) { state.waitCalls += 1; return exists(selector); },
        query_all() { state.queryAllCalls += 1; return state.rows; },
        get_text(selector) { return selector === 'body' ? state.body : (state.text[selector] ?? null); },
        get_attr(selector, name) { return state.attrs[`${selector}|${name}`] ?? null; },
        set_value(selector, value) { state.attrs[`${selector}|value`] = value; return true; },
        click(selector) {
          state.clicked.push(selector);
          if (!exists(selector)) return false;
          for (const token of overrides.clickAdds || []) if (!state.tokens.includes(token)) state.tokens.push(token);
          return true;
        },
      },
      net: {
        fetch() {
          return { ok: true, json: { base: 'USD', date: '2026-07-14', rates: { KRW: 1000, EUR: 0.8, GBP: 0.75, JPY: 150 } } };
        },
      },
    },
  };
}

async function loadSite(testCase, overrides = {}) {
  const { globals, state } = globalsFor(testCase, overrides);
  const runtime = new AXLuaRuntime({ globals, logger: { log() {}, warn() {}, error() {} } });
  for (const file of commonFiles) {
    const loaded = await runtime.loadSource(readFileSync(join(repoRoot, file), 'utf8'), { id: file });
    if (!loaded.ok) throw new Error(`failed to load ${file}: ${loaded.error}`);
  }
  const siteFile = `${testCase.site}/scripts/00_common.lua`;
  const loaded = await runtime.loadSource(readFileSync(join(repoRoot, siteFile), 'utf8'), { id: siteFile });
  if (!loaded.ok) throw new Error(`failed to load ${siteFile}: ${loaded.error}`);
  return { runtime, state };
}

async function call(runtime, command, args) {
  const result = await runtime.call(command, args);
  if (!result.ok) throw new Error(`${command} failed: ${result.error}`);
  return result.value;
}

async function searchReentrant(runtime, args) {
  let value = await call(runtime, 'AX_search_store_product', args);
  if (value.status === 'navigating') value = await call(runtime, 'AX_search_store_product', args);
  return value;
}

let failed = 0;
const lockedApproval = {
  identity_id: 'identity-m185',
  comparison_id: 'cmp-current',
  identity_approval: 'locked_product_identity',
  comparison_approval: 'current_comparison',
};
for (const testCase of siteCases) {
  try {
    const { runtime, state } = await loadSite(testCase);
    const value = await searchReentrant(runtime, { site: testCase.site, query: 'Logitech M185', quantity: 1 });
    assert(value.site === testCase.site, `${testCase.site}: site preserved`, value);
    assert(value.candidates?.length === 1, `${testCase.site}: one candidate normalized`, value);
    const candidate = value.candidates[0];
    assert(candidate.product_id === testCase.id, `${testCase.site}: product id parsed`, candidate);
    assert(candidate.currency === testCase.currency, `${testCase.site}: currency parsed`, candidate);
    assert(candidate.cost_complete === true, `${testCase.site}: item plus shipping is complete`, candidate);
    assert(Math.abs(candidate.total_base - testCase.total) < 0.0001, `${testCase.site}: landed cost normalized`, candidate);
    assert(candidate.brand === 'Logitech' && candidate.manufacturer_model === 'M185', `${testCase.site}: storefront identity metadata retained`, candidate);
    assert(candidate.model_hint === 'M185' && candidate.identity_confidence === 'high', `${testCase.site}: model identity hint retained`, candidate);

    const denied = await call(runtime, 'AX_add_store_product_to_cart', { site: testCase.site, product_id: testCase.id });
    assert(denied.error === 'approval_required', `${testCase.site}: scoped approval required`, denied);
    assert(state.clicked.length === 0, `${testCase.site}: missing approval cannot click`, state.clicked);

    if (testCase.cartUnsupported) {
      const unsupported = await call(runtime, 'AX_add_store_product_to_cart', {
        site: testCase.site,
        product_id: testCase.id,
        ...lockedApproval,
        cart_approval: 'user_selected_compared_offer',
      });
      assert(unsupported.error === 'add_to_cart_unsupported', `${testCase.site}: comparison-only cart boundary explicit`, unsupported);
    }
    console.log(`ok   - ${testCase.site} search/normalize/approval contract`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${testCase.site}\n       ${error.message}`);
  }
}

try {
  const walmart = siteCases[0];
  const { runtime, state } = await loadSite(walmart, {
    tokens: ['h1[itemprop="name"]', 'button[data-automation-id="atc"]'],
    text: {
      'h1[itemprop="name"]': 'Logitech M650 Silent Wireless Mouse',
      '[itemprop="price"][data-seo-id="hero-price"]': '$12.99',
    },
  });
  state.href = walmart.url;
  const changed = await call(runtime, 'AX_add_store_product_to_cart', {
    site: 'walmart',
    product_id: walmart.id,
    expected_identity_model: 'M185',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(changed.error === 'identity_changed' && changed.added === false, 'generic storefront model mismatch blocks mutation', changed);
  assert(state.clicked.length === 0, 'identity mismatch cannot click', state.clicked);
  console.log('ok   - generic storefront identity guard');
} catch (error) {
  failed += 1;
  console.error(`FAIL - generic storefront identity guard\n       ${error.message}`);
}

try {
  const walmart = siteCases[0];
  const { runtime, state } = await loadSite(walmart, {
    tokens: ['h1[itemprop="name"]', 'button[data-automation-id="atc"]'],
    text: { '[itemprop="price"][data-seo-id="hero-price"]': '$13.99' },
  });
  state.href = walmart.url;
  const stale = await call(runtime, 'AX_add_store_product_to_cart', {
    site: 'walmart',
    product_id: walmart.id,
    expected_unit_price: 12.99,
    expected_currency: 'USD',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(stale.error === 'price_changed' && stale.added === false, 'generic storefront stale price blocks mutation', stale);
  assert(state.clicked.length === 0, 'stale price cannot click', state.clicked);
  console.log('ok   - generic storefront stale-price guard');
} catch (error) {
  failed += 1;
  console.error(`FAIL - generic stale-price guard\n       ${error.message}`);
}

try {
  const gmarket = siteCases.find(item => item.site === 'gmarket');
  const { runtime } = await loadSite(gmarket, { body: '원활한 쇼핑을 위해 현재 간단한 봇 확인 절차가 진행되고 있습니다.' });
  const blocked = await searchReentrant(runtime, { site: 'gmarket', query: 'Logitech M185' });
  assert(blocked.error === 'security_verification_required' && blocked.blocked === true, 'challenge is explicit, not no-results', blocked);
  console.log('ok   - live-access challenge classification');
} catch (error) {
  failed += 1;
  console.error(`FAIL - access challenge classification\n       ${error.message}`);
}

try {
  const walmart = siteCases[0];
  const { runtime } = await loadSite(walmart, {
    rows: [{
      url: walmart.url,
      title: 'Unrelated USB Keyboard',
      image_alt: 'Unrelated USB Keyboard',
      price_text: '$9.99',
      shipping_text: 'Free shipping',
      text: 'Unrelated USB Keyboard $9.99 Free shipping',
    }],
  });
  const filtered = await searchReentrant(runtime, { site: 'walmart', query: 'Logitech M185' });
  assert(filtered.error === 'no_results', 'irrelevant storefront rows become an explicit no-results outcome', filtered);
  assert(filtered.candidates?.length === 0, 'irrelevant storefront rows cannot leak into ranked offers', filtered);
  console.log('ok   - irrelevant rows classify as no results');
} catch (error) {
  failed += 1;
  console.error(`FAIL - relevance-filtered no results\n       ${error.message}`);
}

try {
  const walmart = siteCases[0];
  const { runtime, state } = await loadSite(walmart);
  const first = await call(runtime, 'AX_search_store_product', { site: 'walmart', query: 'Logitech M185' });
  assert(first.status === 'navigating', 'first off-target search call must only fire navigation', first);
  assert(state.queryAllCalls === 0 && state.waitCalls === 0, 'search cannot touch the old DOM after navigation fires', state);
  const second = await call(runtime, 'AX_search_store_product', { site: 'walmart', query: 'Logitech M185' });
  assert(second.candidates?.length === 1, 'second on-target search call reads candidates', second);
  console.log('ok   - generic storefront search is re-entrant');
} catch (error) {
  failed += 1;
  console.error(`FAIL - generic storefront search re-entry\n       ${error.message}`);
}

try {
  const walmart = siteCases[0];
  const { runtime, state } = await loadSite(walmart, {
    tokens: ['h1[itemprop="name"]', '[itemprop="price"][data-seo-id="hero-price"]', 'button[data-automation-id="atc"]'],
    text: {
      'h1[itemprop="name"]': 'Logitech M185 Wireless Mouse',
      '[itemprop="price"][data-seo-id="hero-price"]': '$12.99',
    },
    clickAdds: ['[data-testid="add-to-cart-success"]'],
  });
  const args = {
    site: 'walmart',
    product_id: walmart.id,
    expected_identity_model: 'M185',
    expected_unit_price: 12.99,
    expected_currency: 'USD',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  };
  const first = await call(runtime, 'AX_add_store_product_to_cart', args);
  assert(first.status === 'navigating' && first.added === false, 'first off-target cart call must only navigate to the product', first);
  assert(state.clicked.length === 0, 'cart adapter cannot click on the old page after navigation fires', state);
  const second = await call(runtime, 'AX_add_store_product_to_cart', args);
  assert(second.added === true && state.clicked.length === 1, 'second on-product call revalidates and clicks exactly once', { second, state });
  console.log('ok   - generic storefront cart mutation is re-entrant');
} catch (error) {
  failed += 1;
  console.error(`FAIL - generic storefront cart re-entry\n       ${error.message}`);
}


try {
  const coupang = siteCases.find(item => item.site === 'coupang');
  const { runtime } = await loadSite(coupang, {
    rows: [{
      url: coupang.url,
      title: '로지텍 무선마우스, M185, Gray',
      image_alt: '로지텍 무선마우스, M185, Gray',
      text: '로지텍 무선마우스, M185, Gray 16,510원 35% 10,690원 배송비 2,500원 조건부 무료배송',
    }],
  });
  const value = await searchReentrant(runtime, { site: 'coupang', query: '로지텍 M185' });
  assert(value.candidates?.[0]?.price === 10690, 'Coupang should use the current sale price before shipping text', value);
  assert(value.candidates[0].shipping_cost === 2500, 'Coupang should parse the separate paid shipping amount', value.candidates[0]);
  console.log('ok   - Coupang current-price text fallback');
} catch (error) {
  failed += 1;
  console.error(`FAIL - Coupang current-price fallback\n       ${error.message}`);
}

try {
  const naver = siteCases.find(item => item.site === 'naver-shopping');
  const { runtime } = await loadSite(naver, {
    body: '쇼핑 서비스 접속이 일시적으로 제한되었습니다. 비정상적인 접근이 감지되었습니다.',
  });
  const value = await searchReentrant(runtime, { site: naver.site, query: '로지텍 M185' });
  assert(value.error === 'access_denied' && value.blocked === true, 'Naver temporary access restriction must be classified, not reported as no results', value);
  console.log('ok   - Naver access restriction classification');
} catch (error) {
  failed += 1;
  console.error(`FAIL - Naver access restriction classification\n       ${error.message}`);
}

try {
  const ssg = siteCases.find(item => item.site === 'ssg');
  const embedded = '{"itemId":"1000623630874","itemName":"로지텍 무선마우스(M185 레드 Logitech)","brandName":"Logitech","itemUrl":"https:\\/\\/www.ssg.com\\/item\\/itemView.ssg?itemId=1000623630874","itemImgUrl":"https:\\/\\/example.com\\/m185.jpg","finalPrice":"19,900","reviewCount":"42","shippingCostInfo":[{"type":"배송비","text":"무료배송"}]}';
  const { runtime } = await loadSite(ssg, {
    rows: [],
    text: { 'script#__NEXT_DATA__': embedded },
  });
  const value = await searchReentrant(runtime, { site: ssg.site, query: '로지텍 M185' });
  assert(value.candidates?.length === 1 && value.candidates[0].product_id === '1000623630874', 'SSG should read its server-rendered Next data when the client grid is blank', value);
  assert(value.candidates[0].price === 19900 && value.candidates[0].shipping_cost === 0, 'SSG embedded candidate cost should be normalized', value.candidates[0]);
  console.log('ok   - SSG embedded search-data fallback');
} catch (error) {
  failed += 1;
  console.error(`FAIL - SSG embedded search-data fallback\n       ${error.message}`);
}

console.log(`\n${siteCases.length + 9 - failed}/${siteCases.length + 9} tests passed (${assertions} assertions)`);
process.exit(failed ? 1 : 0);
