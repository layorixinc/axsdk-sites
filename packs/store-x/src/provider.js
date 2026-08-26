(() => {
  'use strict';

  const register = globalThis.__AXSDK_PACK_REGISTER__;
  if (typeof register !== 'function') throw new Error('pack_register_unavailable');

  const clean = (value, maximum = 500) => typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maximum)
    : '';

  function canonicalProductUrl(value, productId) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://www.store-x.example' || url.username !== '' || url.password !== '') return undefined;
      if (url.pathname !== `/product/${encodeURIComponent(productId)}` || url.search !== '' || url.hash !== '') return undefined;
      return url.href;
    } catch {
      return undefined;
    }
  }

  function searchTarget(input) {
    const url = new URL('https://www.store-x.example/search');
    url.searchParams.set('q', input.query);
    if (input.page > 1) url.searchParams.set('page', String(input.page));
    return url.href;
  }

  function showsSearch(input) {
    try {
      const current = new URL(globalThis.location?.href ?? document.location?.href ?? '');
      const page = Number(current.searchParams.get('page') ?? '1');
      return current.origin === 'https://www.store-x.example'
        && current.pathname === '/search'
        && current.searchParams.get('q') === input.query
        && page === input.page;
    } catch {
      return false;
    }
  }

  function searchProducts(input) {
    if (!showsSearch(input)) return { step: 'navigate', url: searchTarget(input) };
    const limit = Math.max(1, Math.min(6, input.limit));
    const rows = [...document.querySelectorAll('[data-store-x-product]')];
    const candidates = [];
    const seen = Object.create(null);
    let documentChanged = false;
    for (const row of rows) {
      const productId = clean(row.getAttribute('data-product-id') ?? '', 128);
      const name = clean(row.getAttribute('data-name') ?? '');
      const url = canonicalProductUrl(clean(row.getAttribute('data-url') ?? '', 2048), productId);
      const price = Number(row.getAttribute('data-price'));
      const currency = clean(row.getAttribute('data-currency') ?? '', 3).toUpperCase();
      if (productId !== '' && name !== '' && url === undefined
        && Number.isFinite(price) && price > 0 && /^[A-Z]{3}$/.test(currency)) {
        documentChanged = true;
      }
      if (productId === '' || name === '' || url === undefined || !Number.isFinite(price) || price <= 0
        || !/^[A-Z]{3}$/.test(currency) || seen[productId] === true) continue;
      seen[productId] = true;
      candidates.push({ product_id: productId, name, url, price, currency });
      if (candidates.length >= limit) break;
    }
    if (candidates.length === 0 && documentChanged) {
      return { step: 'blocked', classification: 'document_changed' };
    }
    const status = candidates.length > 0
      ? 'candidates'
      : rows.length > 0 ? 'price_unavailable' : 'no_results';
    return {
      step: 'done',
      result: {
        schema_version: 1,
        status,
        query: input.query,
        page: input.page,
        cards_seen: rows.length,
        has_more: document.querySelector('[data-store-x-next]') !== null,
        ...(candidates.length === 0 ? {} : { candidates }),
      },
    };
  }

  register({ search_products: searchProducts });
})();
