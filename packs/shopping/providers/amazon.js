(() => {
  'use strict';

  const register = globalThis.__AXSDK_PACK_REGISTER__;
  if (typeof register !== 'function') throw new Error('pack_register_unavailable');

  const RESULT_SELECTOR = '[data-component-type="s-search-result"][data-asin]';
  const CAPTCHA_SELECTORS = ['form[action*="validateCaptcha"]'];
  const LOGIN_SELECTORS = ['#authportal-main-section', '#ap_email', '#ap_password'];
  const TITLE_SELECTOR = 'a h2 span, a h2';
  const PRICE_SELECTOR = '.a-price .a-offscreen';
  const SHIPPING_SELECTOR = '[data-cy="delivery-block"], [data-cy="delivery-recipe"]';
  const NEXT_SELECTOR = 'a.s-pagination-next:not(.s-pagination-disabled)';

  const clean = (value, maximum = 500) => typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maximum)
    : '';

  function firstText(root, selector) {
    return clean(root.querySelector(selector)?.textContent ?? '');
  }

  function decimalAmount(value) {
    const match = clean(value).match(/(?:US\s*\$|USD\s*|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (!match) return undefined;
    const amount = Number(match[1].replaceAll(',', ''));
    return Number.isFinite(amount) && amount > 0 ? amount : undefined;
  }

  function shipping(value) {
    const normalized = clean(value);
    if (normalized === '') return undefined;
    const hasFree = /free\s+(?:shipping|delivery)|무료\s*배송/i.test(normalized);
    const hasThreshold = /(?:orders?\s+(?:over|above|of)|on\s+\$|이상|초과)|\$\s*\d[0-9,.]*.*free/i
      .test(normalized);
    if (hasFree) return hasThreshold ? undefined : 0;
    const match = normalized.match(
      /(?:(?:shipping|delivery)(?:\s+(?:fee|cost))?\s*:?\s*(?:US\s*\$|USD\s*|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|(?:US\s*\$|USD\s*|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s+(?:shipping|delivery))/i,
    );
    if (!match) return undefined;
    const amount = Number((match?.[1] ?? match?.[2] ?? '').replaceAll(',', ''));
    return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
  }

  function cardCandidate(card) {
    const asin = clean(card.getAttribute('data-asin') ?? '', 128).toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) return undefined;
    const name = firstText(card, TITLE_SELECTOR);
    const price = decimalAmount(firstText(card, PRICE_SELECTOR));
    if (name === '' || price === undefined) return undefined;
    const shippingCost = shipping(firstText(card, SHIPPING_SELECTOR));
    return {
      product_id: asin,
      name,
      url: `https://www.amazon.com/dp/${asin}`,
      price,
      currency: 'USD',
      ...(shippingCost === undefined ? {} : { shipping_cost: shippingCost, shipping_currency: 'USD' }),
    };
  }

  function searchTarget(input) {
    const url = new URL('https://www.amazon.com/s');
    url.searchParams.set('k', input.query);
    if (input.page > 1) url.searchParams.set('page', String(input.page));
    return url.href;
  }

  function showsSearch(input) {
    try {
      const current = new URL(globalThis.location?.href ?? document.location?.href ?? '');
      const page = Number(current.searchParams.get('page') ?? '1');
      return current.origin === 'https://www.amazon.com'
        && current.pathname === '/s'
        && current.searchParams.get('k') === input.query
        && page === input.page;
    } catch {
      return false;
    }
  }

  function searchProducts(input) {
    if (CAPTCHA_SELECTORS.some((selector) => document.querySelector(selector))) {
      return { step: 'blocked', classification: 'captcha_required' };
    }
    if (LOGIN_SELECTORS.some((selector) => document.querySelector(selector))) {
      return { step: 'blocked', classification: 'login_required' };
    }
    if (!showsSearch(input)) return { step: 'navigate', url: searchTarget(input) };

    const limit = Math.max(1, Math.min(6, input.limit));
    const cards = [...document.querySelectorAll(RESULT_SELECTOR)];
    const candidates = [];
    const seen = Object.create(null);
    for (const card of cards) {
      const candidate = cardCandidate(card);
      if (candidate === undefined || seen[candidate.product_id] === true) continue;
      seen[candidate.product_id] = true;
      candidates.push(candidate);
      if (candidates.length >= limit) break;
    }
    const status = candidates.length > 0
      ? 'candidates'
      : cards.length > 0 ? 'price_unavailable' : 'no_results';
    const result = {
      schema_version: 1,
      status,
      query: input.query,
      page: input.page,
      cards_seen: cards.length,
      has_more: document.querySelector(NEXT_SELECTOR) !== null,
      ...(candidates.length === 0 ? {} : { candidates }),
    };
    return { step: 'done', result };
  }

  register({ search_products: searchProducts });
})();
