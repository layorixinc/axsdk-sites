import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { composePackSet } from '../../../axsdk-sdk-js/packages/axsdk-packs/src/composer.ts';
import { validatePackInlineValue } from '../../../axsdk-sdk-js/packages/axsdk-packs/src/protocol.ts';
import { parsePackManifest } from '../../../axsdk-sdk-js/packages/axsdk-packs/src/schemas.ts';
import {
  buildFirstPartyPackInputs,
  providerSearchOutputSchema,
  rankProviderOutputSchema,
} from './first-party.ts';
import {
  canonicalJson,
  canonicalSignedBytes,
  sha256Digest,
  type CanonicalJsonValue,
} from '../../../axsdk-sdk-js/packages/axsdk-packs/src/canonical.ts';
import {
  fetchVerifiedPackRelease,
} from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/packs/registry.ts';
import { emptyPackLifecycleState } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/packs/store.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SCRIPT_GLOBAL = '__AXSDK_PACK_REGISTER__';

type CommandTable = Record<string, (input: any) => unknown | Promise<unknown>>;

async function loadCommands(
  relativePath: string,
  documentValue?: unknown,
  currentUrl?: string,
): Promise<CommandTable> {
  let commands: CommandTable | undefined;
  const globals = globalThis as Record<string, unknown>;
  const original = {
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    XMLHttpRequest: Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest'),
    WebSocket: Object.getOwnPropertyDescriptor(globalThis, 'WebSocket'),
  };
  let effects = 0;
  const restore = () => {
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    }
    delete globals.document;
  };
  const install = () => {
    if (documentValue === undefined) return;
    const refused = () => {
      effects += 1;
      throw new Error('forbidden_provider_effect');
    };
    const location = {
      get href() { return currentUrl ?? ''; },
      set href(_value: string) { refused(); },
      assign: refused,
      replace: refused,
    };
    globals.document = { ...(documentValue as object), location };
    Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { sendBeacon: refused },
    });
    globals.fetch = refused;
    globals.XMLHttpRequest = function XMLHttpRequest() { refused(); };
    globals.WebSocket = function WebSocket() { refused(); };
  };
  globals[SCRIPT_GLOBAL] = (value: CommandTable) => { commands = value; };
  install();
  try {
    await import(`${resolve(ROOT, relativePath)}?test=${crypto.randomUUID()}`);
  } finally {
    delete globals[SCRIPT_GLOBAL];
    restore();
  }
  if (commands === undefined) throw new Error(`${relativePath} did not register Pack commands`);
  if (documentValue === undefined) return commands;
  return Object.fromEntries(Object.entries(commands).map(([name, command]) => [
    name,
    async (input: unknown) => {
      effects = 0;
      install();
      try {
        const result = await command(input);
        if (effects !== 0) throw new Error('provider artifact attempted a forbidden effect');
        return result;
      } finally {
        restore();
      }
    },
  ]));
}

function element(text: string, attributes: Record<string, string> = {}) {
  return {
    textContent: text,
    getAttribute: (name: string) => attributes[name] ?? null,
  };
}

function amazonDocument(cards: readonly Record<string, unknown>[], blocked = false) {
  return {
    querySelector: (selector: string) => blocked && selector.includes('validateCaptcha') ? element('captcha') : null,
    querySelectorAll: (selector: string) => selector === '[data-component-type="s-search-result"][data-asin]'
      ? cards
      : [],
  };
}

function amazonCard(input: {
  asin: string;
  title: string;
  price: string;
  href?: string;
  shipping?: string;
}) {
  const values: Record<string, unknown> = {
    'a h2 span, a h2': element(input.title),
    '.a-price .a-offscreen': element(input.price),
    '[data-cy="delivery-block"], [data-cy="delivery-recipe"]': input.shipping ? element(input.shipping) : null,
    'h2 a, a.a-link-normal.s-no-outline, a[href*="/dp/"], a[href*="/gp/product/"]': element('', {
      href: input.href ?? `https://www.amazon.com/dp/${input.asin}`,
    }),
    'img.s-image': element('', { src: `https://images.example/${input.asin}.jpg`, alt: input.title }),
  };
  return {
    textContent: `${input.title} ${input.price} ${input.shipping ?? ''}`,
    getAttribute: (name: string) => name === 'data-asin' ? input.asin : null,
    querySelector: (selector: string) => values[selector] ?? null,
  };
}

function providerResult(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    status: 'candidates',
    query: 'Logitech M185',
    page: 1,
    cards_seen: 2,
    has_more: false,
    ...overrides,
  };
}

afterEach(() => {
  const globals = globalThis as Record<string, unknown>;
  delete globals[SCRIPT_GLOBAL];
  delete globals.document;
});

describe('first-party Pack manifests and composition', () => {
  test('builds strict Shopping and Store X manifests and composes Store X additively', async () => {
    const built = await buildFirstPartyPackInputs(ROOT);
    expect(parsePackManifest(built.shopping.manifest)).toEqual(built.shopping.manifest);
    expect(parsePackManifest(built.storeX.manifest)).toEqual(built.storeX.manifest);

    const baseline = await composePackSet(
      [built.shopping],
      [],
      {
        productShellVersion: '0.1.0',
        fixedServices: [],
        generatedAt: '2026-08-24T00:00:00.000Z',
      },
    );
    const extended = await composePackSet(
      [built.shopping],
      [built.storeX],
      {
        productShellVersion: '0.1.0',
        fixedServices: [],
        generatedAt: '2026-08-24T00:00:00.000Z',
      },
    );
    expect(baseline.ok).toBe(true);
    expect(extended.ok).toBe(true);
    if (!baseline.ok || !extended.ok) throw new Error('expected valid first-party Pack composition');

    const baselineProviders = Object.values(baseline.composition.providerRegistries)
      .flat().map((provider) => provider.providerId);
    const extendedProviders = Object.values(extended.composition.providerRegistries)
      .flat().map((provider) => provider.providerId);
    expect(baselineProviders).toEqual(['amazon']);
    expect(extendedProviders).toEqual(['amazon', 'store-x']);
    expect(extended.composition.providerRegistryDigest).not.toBe(baseline.composition.providerRegistryDigest);
    expect(extended.composition.releases.find((release) => release.packId === 'layorix.shopping'))
      .toEqual(baseline.composition.releases.find((release) => release.packId === 'layorix.shopping'));
  });

  // The composer PARSES release envelopes; it never verifies them. So a manifest that no signed
  // registry would ever serve composes cleanly, which is exactly the gap this test closes: the
  // composition inputs come back out of the real verifier here, not out of the builder.
  test('the real registry verifier accepts the signed first-party releases and their asset closure', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const keyId = 'layorix-first-party-test';
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const base64Url = (value: Uint8Array) => {
      let binary = '';
      for (const byte of value) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    };
    const sign = async (kind: 'index' | 'release' | 'revocation', signed: CanonicalJsonValue) => ({
      algorithm: 'Ed25519' as const,
      keyId,
      value: base64Url(new Uint8Array(await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        canonicalSignedBytes(kind, signed) as BufferSource,
      ))),
    });

    const built = await buildFirstPartyPackInputs(ROOT, (signed) => sign('release', signed));
    const index = {
      schemaVersion: 2 as const,
      kind: 'index' as const,
      signed: {
        sequence: 1,
        releases: [
          {
            packId: built.shopping.manifest.pack.id,
            version: built.shopping.manifest.pack.version,
            releaseDigest: built.shopping.releaseDigest,
          },
          {
            packId: built.storeX.manifest.pack.id,
            version: built.storeX.manifest.pack.version,
            releaseDigest: built.storeX.releaseDigest,
          },
        ],
      },
    };
    const revocations = {
      schemaVersion: 2 as const,
      kind: 'revocation' as const,
      signed: { sequence: 1, revocations: [] },
    };
    const documents = new Map<string, Uint8Array>([
      ['/index.json', new TextEncoder().encode(canonicalJson({
        ...index,
        signature: await sign('index', index.signed as unknown as CanonicalJsonValue),
      } as unknown as CanonicalJsonValue))],
      ['/revocations.json', new TextEncoder().encode(canonicalJson({
        ...revocations,
        signature: await sign('revocation', revocations.signed as unknown as CanonicalJsonValue),
      } as unknown as CanonicalJsonValue))],
    ]);
    for (const pack of [built.shopping, built.storeX]) {
      documents.set(
        `/releases/${pack.releaseDigest.slice('sha256:'.length)}.json`,
        new TextEncoder().encode(canonicalJson(pack.release as unknown as CanonicalJsonValue)),
      );
    }
    for (const [ref, bytes] of Object.entries(built.assets)) {
      documents.set(`/assets/${ref.slice('sha256:'.length)}`, bytes);
    }
    const requested: string[] = [];
    const deps = {
      registry: {
        id: 'layorix-first-party',
        baseUrl: 'https://packs.layorix.test/',
        trustRoots: [{
          keyId,
          publicKey,
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: '2027-01-01T00:00:00Z',
        }],
      },
      now: () => '2026-08-24T12:00:00Z',
      fetch: (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        requested.push(path);
        const bytes = documents.get(path);
        return bytes === undefined
          ? new Response('missing', { status: 404 })
          : new Response(bytes, { status: 200 });
      }) as typeof fetch,
    };

    const state = emptyPackLifecycleState();
    const shopping = await fetchVerifiedPackRelease(deps, {
      packId: built.shopping.manifest.pack.id,
      version: built.shopping.manifest.pack.version,
    }, state);
    const storeX = await fetchVerifiedPackRelease(deps, {
      packId: built.storeX.manifest.pack.id,
      version: built.storeX.manifest.pack.version,
    }, state);
    if (!shopping.ok) throw new Error(`${shopping.reason}: ${shopping.detail}`);
    if (!storeX.ok) throw new Error(`${storeX.reason}: ${storeX.detail}`);

    expect(shopping.graph.manifest).toEqual(built.shopping.manifest);
    expect(storeX.graph.manifest).toEqual(built.storeX.manifest);
    expect(shopping.graph.keyId).toBe(keyId);
    // Every declared asset was fetched and hash-checked, not merely referenced.
    for (const asset of Object.values(built.shopping.manifest.assets)) {
      expect(requested).toContain(`/assets/${asset.ref.slice('sha256:'.length)}`);
      expect(shopping.graph.assets[asset.ref]?.byteLength).toBe(asset.bytes);
    }

    const flowSource = new TextDecoder().decode(
      shopping.graph.assets[shopping.graph.manifest.assets.flow.ref] ?? new Uint8Array(),
    );
    const composed = await composePackSet(
      [{
        release: shopping.graph.release,
        releaseDigest: shopping.graph.releaseDigest,
        manifest: shopping.graph.manifest as typeof built.shopping.manifest,
        status: 'enabled',
        flowSource,
      }],
      [{
        release: storeX.graph.release,
        releaseDigest: storeX.graph.releaseDigest,
        manifest: storeX.graph.manifest as typeof built.storeX.manifest,
        status: 'enabled',
      }],
      { productShellVersion: '0.1.0', fixedServices: [], generatedAt: '2026-08-24T00:00:00.000Z' },
    );
    if (!composed.ok) throw new Error('expected a composition from verified releases');
    expect(Object.values(composed.composition.providerRegistries).flat()
      .map((provider) => provider.providerId)).toEqual(['amazon', 'store-x']);

    // A tampered artifact must not reach composition. The tamper keeps the DECLARED LENGTH, so the
    // refusal comes from the hash rather than from the cheaper byte-count check.
    const taskRef = built.shopping.manifest.assets.taskScript.ref;
    const original = built.assets[taskRef];
    if (original === undefined) throw new Error('expected the built task artifact bytes');
    const tamperedBytes = Uint8Array.from(original);
    tamperedBytes[0] = tamperedBytes[0] === 32 ? 9 : 32;
    documents.set(`/assets/${taskRef.slice('sha256:'.length)}`, tamperedBytes);
    const tampered = await fetchVerifiedPackRelease(deps, {
      packId: built.shopping.manifest.pack.id,
      version: built.shopping.manifest.pack.version,
    }, emptyPackLifecycleState());
    expect(tampered.ok).toBe(false);
    expect(tampered.ok ? '' : tampered.reason).toBe('asset_hash_mismatch');
  });
});

describe('Shopping task artifact', () => {
  test('ranks known totals first without fabricating missing shipping as zero', async () => {
    const commands = await loadCommands('packs/shopping/src/task.js');
    expect(Object.keys(commands).sort()).toEqual(['prepare_search', 'rank_provider_result']);

    const ranked = await commands.rank_provider_result({
      providerResult: providerResult({
        candidates: [
          { product_id: 'unknown', name: 'Logitech M185 unknown shipping', url: 'https://www.amazon.com/dp/UNKNOWN001', price: 10, currency: 'USD' },
          { product_id: 'known', name: 'Logitech M185 known total', url: 'https://www.amazon.com/dp/KNOWN00001', price: 12, currency: 'USD', shipping_cost: 1, shipping_currency: 'USD' },
        ],
      }),
    }) as any;

    expect(validatePackInlineValue(rankProviderOutputSchema, ranked).ok).toBe(true);
    expect(ranked.offers.map((offer: any) => offer.product_id)).toEqual(['known', 'unknown']);
    expect(ranked.offers[0].total).toBe(13);
    expect(ranked.offers[1]).not.toHaveProperty('shipping_cost');
    expect(ranked.offers[1]).not.toHaveProperty('total');
    expect(ranked.comparisonText).toContain('shipping unknown');
  });

  test('rejects contradictory and credential-bearing provider results before ranking', async () => {
    const commands = await loadCommands('packs/shopping/src/task.js');
    expect(() => commands.rank_provider_result({
      providerResult: providerResult({ candidates: [] }),
    })).toThrow('provider_result_invalid');
    expect(() => commands.rank_provider_result({
      providerResult: providerResult({
        candidates: [{
          product_id: 'credentialled',
          name: 'Logitech M185 credential URL',
          url: 'https://user:pass@www.amazon.com/dp/CREDENTIAL',
          price: 10,
          currency: 'USD',
        }],
      }),
    })).toThrow('provider_result_invalid');
  });

  test('the closed provider schema rejects oversized, negative, unknown, and unsupported output', () => {
    const candidate = {
      product_id: 'bounded',
      name: 'Bounded offer',
      url: 'https://www.amazon.com/dp/BOUNDED001',
      price: 10,
      currency: 'USD',
    };
    expect(validatePackInlineValue(providerSearchOutputSchema, providerResult({
      candidates: Array.from({ length: 7 }, (_, index) => ({ ...candidate, product_id: `item-${index}` })),
    })).ok).toBe(false);
    expect(validatePackInlineValue(providerSearchOutputSchema, providerResult({
      candidates: [{ ...candidate, price: -1 }],
    })).ok).toBe(false);
    expect(validatePackInlineValue(providerSearchOutputSchema, providerResult({
      candidates: [{ ...candidate, source: 'untrusted' }],
    })).ok).toBe(false);
    expect(validatePackInlineValue(providerSearchOutputSchema, providerResult({
      status: 'technical_failure',
    })).ok).toBe(false);
  });
});

describe('Amazon embedded Provider artifact', () => {
  test('reads stable live-measured card fields and keeps absent shipping absent', async () => {
    const commands = await loadCommands('packs/shopping/providers/amazon.js', amazonDocument([
      amazonCard({ asin: 'B0TEST0001', title: 'Logitech M185 Wireless Mouse', price: '$19.99' }),
      amazonCard({ asin: 'B0TEST0002', title: 'Logitech M185 Mouse', price: '$17.50', shipping: '$3.99 delivery' }),
    ]), 'https://www.amazon.com/s?k=Logitech+M185');
    expect(Object.keys(commands)).toEqual(['search_products']);

    const step = await commands.search_products({ query: 'Logitech M185', page: 1, limit: 6, quantity: 1, query_variants: ['Logitech M185'] }) as any;
    expect(step.step).toBe('done');
    expect(validatePackInlineValue(providerSearchOutputSchema, step.result).ok).toBe(true);
    expect(step.result).toMatchObject({
      schema_version: 1, status: 'candidates', query: 'Logitech M185', page: 1, cards_seen: 2,
    });
    expect(step.result.candidates).toHaveLength(2);
    expect(step.result.candidates[0]).not.toHaveProperty('shipping_cost');
    expect(step.result.candidates[1]).toMatchObject({
      product_id: 'B0TEST0002', shipping_cost: 3.99, shipping_currency: 'USD',
    });
  });

  test('requests only a signed search navigation and classifies CAPTCHA before navigation', async () => {
    const input = { query: 'mouse', page: 1, limit: 6, quantity: 1, query_variants: ['mouse'] };
    const home = await loadCommands(
      'packs/shopping/providers/amazon.js',
      amazonDocument([]),
      'https://www.amazon.com/',
    );
    expect(await home.search_products(input)).toEqual({
      step: 'navigate',
      url: 'https://www.amazon.com/s?k=mouse',
    });
    const blocked = await loadCommands(
      'packs/shopping/providers/amazon.js',
      amazonDocument([], true),
      'https://www.amazon.com/',
    );
    expect(await blocked.search_products(input)).toEqual({
      step: 'blocked',
      classification: 'captcha_required',
    });
  });

  test('never converts conditional free-delivery thresholds into shipping charges or zero', async () => {
    const commands = await loadCommands('packs/shopping/providers/amazon.js', amazonDocument([
      amazonCard({ asin: 'B0TEST0003', title: 'Logitech M185 One', price: '$19.99', shipping: 'FREE delivery on $35 of items shipped by Amazon' }),
      amazonCard({ asin: 'B0TEST0004', title: 'Logitech M185 Two', price: '$18.99', shipping: 'Shipping is free on orders over $35' }),
    ]), 'https://www.amazon.com/s?k=Logitech+M185');
    const step = await commands.search_products({
      query: 'Logitech M185', page: 1, limit: 6, quantity: 1, query_variants: ['Logitech M185'],
    }) as any;
    expect(step.result.candidates.every((candidate: any) => candidate.shipping_cost === undefined)).toBe(true);
  });
});

describe('Store X fixture Provider artifact', () => {
  test('returns one canonical bounded candidate without page mutation', async () => {
    const row = {
      getAttribute: (name: string) => ({
        'data-product-id': 'store-x-1',
        'data-name': 'Store X Mouse',
        'data-url': 'https://www.store-x.example/product/store-x-1',
        'data-price': '14.99',
        'data-currency': 'USD',
      } as Record<string, string>)[name] ?? null,
    };
    const commands = await loadCommands('packs/store-x/src/provider.js', {
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === '[data-store-x-product]' ? [row] : [],
    }, 'https://www.store-x.example/search?q=mouse');
    const step = await commands.search_products({ query: 'mouse', page: 1, limit: 6, quantity: 1, query_variants: ['mouse'] }) as any;
    expect(step.step).toBe('done');
    expect(validatePackInlineValue(providerSearchOutputSchema, step.result).ok).toBe(true);
    expect(step.result).toEqual({
      schema_version: 1,
      status: 'candidates',
      query: 'mouse',
      page: 1,
      cards_seen: 1,
      has_more: false,
      candidates: [{
        product_id: 'store-x-1',
        name: 'Store X Mouse',
        url: 'https://www.store-x.example/product/store-x-1',
        price: 14.99,
        currency: 'USD',
      }],
    });
  });

  test('drops an off-host origin-confusable product URL', async () => {
    const row = {
      getAttribute: (name: string) => ({
        'data-product-id': 'store-x-1',
        'data-name': 'Store X Mouse',
        'data-url': 'https://www.store-x.example.evil/product/store-x-1',
        'data-price': '14.99',
        'data-currency': 'USD',
      } as Record<string, string>)[name] ?? null,
    };
    const commands = await loadCommands('packs/store-x/src/provider.js', {
      querySelector: () => null,
      querySelectorAll: () => [row],
    }, 'https://www.store-x.example/search?q=mouse');
    const result = await commands.search_products({
      query: 'mouse', page: 1, limit: 6, quantity: 1, query_variants: ['mouse'],
    });
    expect(result).toEqual({ step: 'blocked', classification: 'document_changed' });
  });
});
