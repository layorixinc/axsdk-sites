import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

// Discovery groups live listings by their manufacturer model, and the model is INFERRED from the title
// when the listing does not carry one. That inference decides what the user is offered to choose between,
// so a wrong token is not cosmetic: the choice is locked to it and the comparison then searches for a
// product that does not exist.
//
// Every title below was measured on a live search, not invented.

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/50_commerce_core.lua',
  '_common/scripts/51_relevance.lua',
  '_common/scripts/52_identity.lua',
]);
after(() => lua.close());

/** One discovery result, shaped the way the fan-out publishes it. */
function discovered(name) {
  return lua.call('AX_build_product_options', {
    requested_brand: '로지텍',
    product_category: '마우스',
    results: [{
      key: '11st',
      status: 'completed',
      value: {
        site: '11st',
        candidates: [{
          site: '11st', product_id: '1', name, price: 10000, currency: 'KRW',
          // Required by the builder: an option the user cannot open is not an option.
          url: 'https://www.11st.co.kr/products/1',
        }],
      },
    }],
  });
}

// The builder answers `options`, keyed by group.
const modelOf = (built) => Object.values(built?.options ?? {})[0]?.model;

test('a promo tag in front of the title is not the product model', () => {
  // Measured on live 11st, and offered to the user as "로지텍 11Pay3":
  //   "[11Pay3%포인트] 로지텍 코리아 정품 리프트 LIFT 버티컬 인체공학 무선 마우스"
  // `11Pay3` is a points promotion. The inference took the first token carrying both letters and digits,
  // and a Korean storefront puts a merchandising bracket in front of almost every title.
  const model = modelOf(discovered('[11Pay3%포인트] 로지텍 코리아 정품 리프트 LIFT 버티컬 인체공학 무선 마우스'));

  assert.notEqual(model, '11Pay3', 'a points promotion is not a model');
  // This listing genuinely names no model code, and saying so is the honest answer — the option is then
  // a unique listing rather than a model group.
  assert.equal(model, undefined);
});

test('a model after a leading bracket is still found', () => {
  // Also measured live. Stripping the bracket must not cost the model that follows it.
  assert.equal(
    modelOf(discovered('(국내정품) 로지텍코리아 M170 무선 마우스 좌우대칭')),
    'M170',
  );
});

test('a measurement is not a model', () => {
  // The unit blacklist was five entries (`ghz mah gb tb dpi`), so any other letter+digit token of length ≥2
  // won: a bottled-water listing resolved to model `500ml`, a monitor to `60Hz` (only `ghz` was listed, not
  // `hz`), and a two-pack to `2P`. The inferred model feeds the discovery GROUPING key, `identity_confidence`
  // and 53_verify's `model_mismatch` — so two listings of the same water verify as different products, and a
  // locked identity can be a capacity. §13's bracket fix covered merchandising prefixes; this is the sibling.
  for (const [title, unit] of [
    ['삼다수 무라벨 500ml 20병', '500ml'],
    ['LG 27형 게이밍 모니터 60Hz IPS', '60Hz'],
    ['프릴 세탁세제 1.5L 리필', '1.5L'],
    ['건전지 AA 8개입 1200mah 충전지', '1200mah'],
  ]) {
    const model = modelOf(discovered(title));
    assert.notEqual(String(model ?? '').toLowerCase(), unit.toLowerCase(), `${unit} is a measurement: ${title}`);
  }

  // And a real model containing digits and a unit-looking tail is still a model.
  assert.equal(modelOf(discovered('Logitech M185 Compact Wireless Mouse')), 'M185');
  assert.equal(modelOf(discovered('삼성 모니터 S27C390 27형')), 'S27C390');
});

test('an unbracketed title is unaffected', () => {
  assert.equal(
    modelOf(discovered('Logitech M185 Compact Ambidextrous Wireless Mouse')),
    'M185',
  );
});

test('a listing that carries its own model is trusted over the title', () => {
  // The adapter may read a model from the page. That beats any inference.
  const options = lua.call('AX_build_product_options', {
    requested_brand: '로지텍',
    results: [{
      key: '11st',
      status: 'completed',
      value: {
        site: '11st',
        candidates: [{
          site: '11st', product_id: '1', name: '[10%쿠폰] 로지텍 마우스', manufacturer_model: 'M240',
          price: 1, currency: 'KRW', url: 'https://www.11st.co.kr/products/1',
        }],
      },
    }],
  });

  assert.equal(modelOf(options), 'M240');
});

test('an option nobody can compare does not lead the list', () => {
  // Once the promo tag stopped being read as a model, the listing that carries no model at all became
  // option 1 — and picking it is answered, correctly, with "this lacks a clear manufacturer model, so it
  // can't be reliably compared across stores". A list whose first entry is a dead end wastes the choice
  // it asked for. Model-bearing options come first; the rest keep their order behind them.
  const built = lua.call('AX_build_product_options', {
    requested_brand: '로지텍',
    product_category: '마우스',
    results: [{
      key: '11st',
      status: 'completed',
      value: {
        site: '11st',
        candidates: [
          // Measured live, in this order — the unmodelled listing came back first.
          { site: '11st', product_id: '1', name: '[11Pay3%포인트] 로지텍 코리아 정품 리프트 LIFT 버티컬 무선 마우스', price: 87440, currency: 'KRW', url: 'https://www.11st.co.kr/products/1' },
          { site: '11st', product_id: '2', name: '로지텍 G304 무선 게이밍 마우스', price: 48420, currency: 'KRW', url: 'https://www.11st.co.kr/products/2' },
          { site: '11st', product_id: '3', name: '로지텍 M170 무선 마우스', price: 12780, currency: 'KRW', url: 'https://www.11st.co.kr/products/3' },
          { site: '11st', product_id: '4', name: '로지텍 M240 무선 마우스', price: 27760, currency: 'KRW', url: 'https://www.11st.co.kr/products/4' },
          { site: '11st', product_id: '5', name: '로지텍 M750 무선 마우스', price: 54360, currency: 'KRW', url: 'https://www.11st.co.kr/products/5' },
          { site: '11st', product_id: '6', name: '[무료배송] 로지텍 정품 무선 마우스 세트', price: 19900, currency: 'KRW', url: 'https://www.11st.co.kr/products/6' },
        ],
      },
    }],
  });

  const ordered = Object.values(built?.options ?? {});
  assert.ok(ordered.length >= 2, `expected several options, got ${ordered.length}`);
  assert.ok(ordered[0].model, `the first option must be comparable, got ${JSON.stringify(ordered[0]).slice(0, 120)}`);
  // The unmodelled listing is still offered — it is a real product — just not first.
  assert.ok(ordered.some((option) => !option.model), 'a listing without a model is still worth showing');
});
