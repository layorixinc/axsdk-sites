import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { composePackSet } from '../../../axsdk-sdk-js/packages/axsdk-packs/src/composer.ts';
import { parsePackManifest } from '../../../axsdk-sdk-js/packages/axsdk-packs/src/schemas.ts';
import { buildServiceQuotesPackInputs } from './service-quotes.ts';
import { verifyLuaArtifact } from './wrap-lua.mjs';
import { element, loadCommands, PACKS_ROOT } from './test-harness.ts';

const ROOT = PACKS_ROOT;

/**
 * X4 (EXTERNAL_PACK_TASK_PLAN §9): comparative service quotes. Every fixture sentence below is one
 * X0-4 MEASURED on 2026-08-27 — the pro's own prose, the site band, and the review-quoted dollar
 * amount are real text shapes, not inventions.
 */
const MEASURED = {
  proStated: 'Our starting rate is $180 per visit',
  siteBand: 'On average, the cost of a cleaning service ranges from around $155 to $290 per visit.',
  reviewTrap: 'she tried to say it was going to be $200 more',
  kmongListing: '99,000원~',
};

describe('service-quotes Pack manifest and composition', () => {
  test('builds a strict Lua-authored agent pack with three embedded marketplace providers', async () => {
    const built = await buildServiceQuotesPackInputs(ROOT);
    expect(parsePackManifest(built.pack.manifest)).toEqual(built.pack.manifest);
    expect(built.pack.manifest.pack.id).toBe('layorix.service-quotes');
    expect(built.pack.manifest.routeContributions[0]?.intent).toBe('service_quote_compare');
    expect(built.pack.manifest.extensionPoints[0]?.id).toBe('service_marketplaces');
    expect(built.pack.manifest.embeddedProviders.map((provider: any) => provider.providerId))
      .toEqual(['thumbtack', 'soomgo', 'kmong']);

    const composed = await composePackSet([built.pack], [], {
      productShellVersion: '0.1.0',
      fixedServices: [],
      generatedAt: '2026-09-03T00:00:00.000Z',
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    // The composed provider registry is sorted; declaration order lives in the manifest assertion above.
    expect(Object.values(composed.composition.providerRegistries).flat()
      .map((provider) => provider.providerId)).toEqual(['kmong', 'soomgo', 'thumbtack']);
  });

  test('every script artifact is the fixed wrapper around its authored Lua, with authoring metadata', async () => {
    const built = await buildServiceQuotesPackInputs(ROOT);
    const decode = (ref: string) => new TextDecoder().decode(built.assets[ref] ?? new Uint8Array());
    const scriptAssets = Object.entries(built.pack.manifest.assets)
      .filter(([, asset]: [string, any]) => asset.mediaType === 'application/javascript');
    expect(scriptAssets.length).toBe(4); // task + three providers
    for (const [key, asset] of scriptAssets as [string, any][]) {
      expect(asset.authoring?.language, key).toBe('lua');
      expect(() => verifyLuaArtifact(decode(asset.ref)), key).not.toThrow();
    }
  });
});

describe('no submit path, asserted on the source bytes (§9.5)', () => {
  test('no provider source names a click, submit, or estimate-request control', async () => {
    for (const path of [
      'packs/service-quotes/providers/thumbtack.lua',
      'packs/service-quotes/providers/soomgo.lua',
      'packs/service-quotes/providers/kmong.lua',
      'packs/service-quotes/src/task.lua',
    ]) {
      const source = await readFile(resolve(ROOT, path), 'utf8');
      expect(source, path).not.toMatch(/click|submit|mousedown|dispatch|request_estimate|견적\s*요청/i);
    }
  });
});

describe('service task commands', () => {
  test('prepares a bounded query and refuses an empty one', async () => {
    const commands = await loadCommands('packs/service-quotes/src/task.lua');
    expect(commands.prepare_service_query({ query: '  house   cleaning ', region: ' 94101 ' }))
      .toEqual({ query: 'house cleaning', region: '94101', limit: 6 });
    expect(() => commands.prepare_service_query({ query: '   ' })).toThrow('query_required');
  });

  test('normalises each measured claim shape with its unit and provenance', async () => {
    const commands = await loadCommands('packs/service-quotes/src/task.lua');
    const out = commands.normalise_service_price({
      claims: [
        { kind: 'pro_stated', text: MEASURED.proStated },
        { kind: 'site_average', text: MEASURED.siteBand },
        { kind: 'listing_price', text: MEASURED.kmongListing },
        { kind: 'pro_stated', text: '시간당 15,000원' },
        { kind: 'pro_stated', text: '월 3회 패키지 5만' },
      ],
    }) as { rows: any[] };
    const [stated, band, listing, hourly, unknown] = out.rows;

    expect(stated).toMatchObject({
      kind: 'pro_stated', amount: 180, currency: 'USD', unit: 'per_visit', comparable: true,
    });
    expect(band).toMatchObject({
      kind: 'site_average', currency: 'USD', unit: 'per_visit',
      band: { low: 155, high: 290 }, comparable: false,
    });
    expect(band.amount).toBeUndefined();
    expect(listing).toMatchObject({
      kind: 'listing_price', amount: 99000, currency: 'KRW', unit: 'starting_at', comparable: true,
    });
    expect(hourly).toMatchObject({ amount: 15000, currency: 'KRW', unit: 'per_hour', comparable: true });
    // §8 risk: a unit the normaliser cannot compare keeps the STATED TEXT and produces NO guess.
    expect(unknown).toMatchObject({ kind: 'pro_stated', text: '월 3회 패키지 5만', comparable: false });
    expect(unknown.amount).toBeUndefined();
    expect(unknown.unit).toBeUndefined();
  });

  test('a site average is never a candidate price, and absent stays absent (§9.5)', async () => {
    const commands = await loadCommands('packs/service-quotes/src/task.lua');
    const ranked = commands.rank_service_estimates({
      candidates: [
        { site: 'thumbtack', name: 'Sparkling Homes', url: 'https://www.thumbtack.com/pro/1', rating: 5, review_count: 13, hires: 14 },
        { site: 'kmong', name: '청소의신', url: 'https://kmong.com/gig/2', rating: 4.9, review_count: 80,
          claims: [{ kind: 'listing_price', text: MEASURED.kmongListing }] },
      ],
      site_claims: [{ site: 'thumbtack', kind: 'site_average', text: MEASURED.siteBand }],
    }) as { rows: any[]; site_rows: any[]; comparisonText: string };

    const sparkling = ranked.rows.find((row) => row.name === 'Sparkling Homes');
    expect(sparkling.amount).toBeUndefined();
    expect(sparkling.provenance).toBe('amount_not_published');
    const priced = ranked.rows.find((row) => row.name === '청소의신');
    expect(priced).toMatchObject({ amount: 99000, currency: 'KRW', provenance: 'listing_price' });
    // Priced rows come first; reputation-only rows are still rows, never dropped.
    expect(ranked.rows[0].name).toBe('청소의신');
    expect(ranked.site_rows).toHaveLength(1);
    expect(ranked.site_rows[0]).toMatchObject({ site: 'thumbtack', provenance: 'site_average' });
    expect(ranked.comparisonText).toContain('Sparkling Homes');
    expect(ranked.comparisonText).not.toMatch(/Sparkling Homes[^\n]*(155|290|180)/);
  });
});

function thumbtackDocument(cards: readonly Record<string, unknown>[], bandText?: string) {
  return {
    querySelector: (selector: string) =>
      selector.includes('-prices') && bandText !== undefined ? element(bandText) : null,
    querySelectorAll: (selector: string) =>
      selector === 'div:has(> [data-test="pro-list-result"])' ? cards : [],
  };
}

function thumbtackCard(input: {
  name: string;
  summary: string;
  intro?: string;
  review?: string;
  href?: string;
}) {
  const values: Record<string, unknown> = {
    '[data-test="pro-intro"]': input.intro === undefined ? null : element(input.intro),
    '[data-test="review-snippet"]': input.review === undefined ? null : element(input.review),
    'a[href*="/service/"]': element('', { href: input.href ?? 'https://www.thumbtack.com/service/123' }),
  };
  return {
    textContent: `${input.name} ${input.summary} ${input.review ?? ''}`,
    getAttribute: () => null,
    querySelector: (selector: string) => values[selector] ?? null,
  };
}

describe('thumbtack marketplace provider', () => {
  const url = 'https://www.thumbtack.com/k/house-cleaning/near-me?zip_code=94101';
  const input = { query: 'house cleaning', region: '94101', limit: 6 };

  test('reads reputation from the card and a pro-stated claim ONLY from the intro', async () => {
    const commands = await loadCommands('packs/service-quotes/providers/thumbtack.lua', thumbtackDocument([
      thumbtackCard({
        name: 'Sparkling Homes',
        summary: 'Exceptional 5.0 (13) · 14 hires on Thumbtack',
        intro: MEASURED.proStated,
        review: MEASURED.reviewTrap,
      }),
      thumbtackCard({ name: 'Tidy Crew', summary: 'Very good 4.6 (41) · 7 hires on Thumbtack' }),
    ], MEASURED.siteBand), url);
    const step = await commands.read_service_candidates(input) as any;
    expect(step.step).toBe('done');
    expect(step.result.status).toBe('candidates');
    expect(step.result.candidates).toHaveLength(2);
    const [sparkling, tidy] = step.result.candidates;
    expect(sparkling).toMatchObject({ name: 'Sparkling Homes', rating: 5, review_count: 13, hires: 14 });
    expect(sparkling.claim_kind).toBe('pro_stated');
    expect(sparkling.claim_text).toBe(MEASURED.proStated);
    // §9.5: the review's $200 is a fixture and must produce NO claim from any candidate.
    for (const candidate of step.result.candidates) {
      expect(candidate.claim_text ?? '').not.toContain('$200');
    }
    expect(tidy.claim_kind).toBeUndefined();
    expect(tidy.claim_text).toBeUndefined();
    expect(step.result.site_claims).toEqual([{ kind: 'site_average', text: MEASURED.siteBand }]);
  });

  test('navigates to the canonical slug URL when standing elsewhere', async () => {
    const commands = await loadCommands('packs/service-quotes/providers/thumbtack.lua',
      thumbtackDocument([]), 'https://www.thumbtack.com/');
    expect(await commands.read_service_candidates(input)).toEqual({
      step: 'navigate',
      url: 'https://www.thumbtack.com/k/house-cleaning/near-me?zip_code=94101',
    });
  });
});

describe('soomgo and kmong marketplace providers', () => {
  test('soomgo answers reputation only — zero claims, amounts absent by construction', async () => {
    const row = {
      textContent: '홈클리닝 전문가 · 경력 20년 · 고용 14회 · 리뷰 5.0 (13)',
      getAttribute: (name: string) => name === 'href' ? '/profile/users/1' : null,
      querySelector: () => null,
    };
    const commands = await loadCommands('packs/service-quotes/providers/soomgo.lua', {
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === '[data-testid="pro-card"]' ? [row] : [],
    }, 'https://soomgo.com/search/pro?query=%ED%99%88%ED%81%B4%EB%A6%AC%EB%8B%9D');
    const step = await commands.read_service_candidates({ query: '홈클리닝', limit: 6 }) as any;
    expect(step.step).toBe('done');
    expect(step.result.candidates).toHaveLength(1);
    expect(step.result.candidates[0]).toMatchObject({
      name: '홈클리닝 전문가', experience_years: 20, hires: 14, rating: 5, review_count: 13,
    });
    expect(step.result.candidates[0].claim_kind).toBeUndefined();
    expect(step.result.candidates[0].claim_text).toBeUndefined();
  });

  test('kmong reads the fixed listing price as a listing_price claim', async () => {
    const card = {
      textContent: '입주청소 전문 4.9 (80)',
      getAttribute: () => null,
      querySelector: (selector: string) => selector === '[data-testid="gig-price"]'
        ? element(MEASURED.kmongListing)
        : selector === 'a[href*="/gig/"]' ? element('입주청소 전문', { href: 'https://kmong.com/gig/2' }) : null,
    };
    const commands = await loadCommands('packs/service-quotes/providers/kmong.lua', {
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === '[data-testid="gig-card"]' ? [card] : [],
    }, 'https://kmong.com/search?type=gigs&keyword=%EC%9E%85%EC%A3%BC%EC%B2%AD%EC%86%8C');
    const step = await commands.read_service_candidates({ query: '입주청소', limit: 6 }) as any;
    expect(step.step).toBe('done');
    expect(step.result.candidates[0]).toMatchObject({
      name: '입주청소 전문', rating: 4.9, review_count: 80,
      claim_kind: 'listing_price',
      claim_text: MEASURED.kmongListing,
    });
  });
});
