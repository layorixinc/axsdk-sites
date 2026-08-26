(() => {
  'use strict';

  const register = globalThis.__AXSDK_PACK_REGISTER__;
  if (typeof register !== 'function') throw new Error('pack_register_unavailable');

  const text = (value, maximum = 500) => {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, maximum);
  };

  function prepareSearch(input) {
    const query = text(input?.query, 240);
    if (query === '') throw new TypeError('query_required');
    return { query, page: 1, limit: 6, quantity: 1, query_variants: [query] };
  }

  function comparableOffer(candidate) {
    const offer = {
      product_id: candidate.product_id,
      name: candidate.name,
      url: candidate.url,
      price: candidate.price,
      currency: candidate.currency,
      ...(candidate.brand === undefined ? {} : { brand: candidate.brand }),
      ...(candidate.manufacturer_model === undefined ? {} : {
        manufacturer_model: candidate.manufacturer_model,
      }),
      ...(candidate.rating === undefined ? {} : { rating: candidate.rating }),
      ...(candidate.review_count === undefined ? {} : { review_count: candidate.review_count }),
      ...(candidate.condition === undefined ? {} : { condition: candidate.condition }),
    };
    const shippingKnown = Number.isFinite(candidate.shipping_cost)
      && candidate.shipping_cost >= 0
      && candidate.shipping_currency === candidate.currency;
    if (!shippingKnown) return offer;
    return {
      ...offer,
      shipping_cost: candidate.shipping_cost,
      shipping_currency: candidate.shipping_currency,
      total: candidate.price + candidate.shipping_cost,
    };
  }

  const CANDIDATE_KEYS = {
    product_id: true,
    name: true,
    url: true,
    price: true,
    currency: true,
    shipping_cost: true,
    shipping_currency: true,
    brand: true,
    manufacturer_model: true,
    rating: true,
    review_count: true,
    condition: true,
  };

  function validCandidate(candidate) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).some((key) => CANDIDATE_KEYS[key] !== true)
      || text(candidate.product_id, 128) === '' || text(candidate.name) === ''
      || !Number.isFinite(candidate.price) || candidate.price <= 0
      || !/^[A-Z]{3}$/.test(candidate.currency)) return false;
    try {
      const url = new URL(candidate.url);
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
        || url.search !== '' || url.hash !== '') return false;
    } catch {
      return false;
    }
    const hasShipping = candidate.shipping_cost !== undefined || candidate.shipping_currency !== undefined;
    if (hasShipping && (!Number.isFinite(candidate.shipping_cost) || candidate.shipping_cost < 0
      || candidate.shipping_currency !== candidate.currency)) return false;
    if (candidate.rating !== undefined
      && (!Number.isFinite(candidate.rating) || candidate.rating < 0 || candidate.rating > 5)) return false;
    if (candidate.review_count !== undefined
      && (!Number.isInteger(candidate.review_count) || candidate.review_count < 0)) return false;
    return true;
  }

  function relevant(candidate, query) {
    const terms = text(query, 240).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const haystack = text([
      candidate.name,
      candidate.brand,
      candidate.manufacturer_model,
    ].filter(Boolean).join(' '), 1000).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
    return terms.length > 0 && terms.every((term) => haystack.includes(term));
  }

  function rankProviderResult(input) {
    const providerResult = input?.providerResult;
    if (providerResult === null || typeof providerResult !== 'object' || Array.isArray(providerResult)
      || providerResult.schema_version !== 1
      || text(providerResult.query, 240) === ''
      || !Number.isInteger(providerResult.page) || providerResult.page < 1 || providerResult.page > 2
      || !Number.isInteger(providerResult.cards_seen) || providerResult.cards_seen < 0
      || typeof providerResult.has_more !== 'boolean') {
      throw new TypeError('provider_result_required');
    }
    const status = providerResult.status;
    const candidates = providerResult.candidates;
    if ((status === 'candidates' && (!Array.isArray(candidates) || candidates.length < 1
      || candidates.length > 6 || candidates.some((candidate) => !validCandidate(candidate))))
      || (status !== 'candidates' && candidates !== undefined)
      || !['candidates', 'no_results', 'price_unavailable'].includes(status)) {
      throw new TypeError('provider_result_invalid');
    }
    if (status !== 'candidates') {
      const message = status === 'price_unavailable'
        ? 'Storefront cards were present, but their prices could not be read safely.'
        : 'No matching storefront results were found.';
      return { status, offers: [], comparisonText: message };
    }

    const offers = candidates.filter((candidate) =>
      relevant(candidate, providerResult.query)).map(comparableOffer).sort((left, right) => {
      const leftKnown = Number.isFinite(left.total);
      const rightKnown = Number.isFinite(right.total);
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      if (leftKnown && rightKnown && left.total !== right.total) return left.total - right.total;
      if (left.price !== right.price) return left.price - right.price;
      return left.product_id.localeCompare(right.product_id);
    });
    const lines = offers.map((offer, index) => {
      const total = Number.isFinite(offer.total)
        ? `${offer.currency} ${offer.total.toFixed(2)} total`
        : `${offer.currency} ${offer.price.toFixed(2)} + shipping unknown`;
      return `${index + 1}. ${text(offer.name)} — ${total}`;
    });
    return {
      status: offers.length > 0 ? 'candidates' : 'no_results',
      offers,
      comparisonText: lines.length > 0 ? lines.join('\\n') : 'No relevant storefront results were found.',
    };
  }

  register({
    prepare_search: prepareSearch,
    rank_provider_result: rankProviderResult,
  });
})();
