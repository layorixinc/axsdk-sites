/**
 * Producer for the EXTERNAL comparative-service-quotes Agent Pack (EXTERNAL_PACK_TASK_PLAN §9, X4).
 *
 * Authored and distributed as Lua (LUA_PACK_DESIGN.md): every script asset is the fixed zero-logic
 * wrapper around its `.lua` source, with an `authoring` block naming the source digest review reads.
 * A separate producer on purpose: the embedded first-party set stays frozen (`first-party.ts`
 * untouched beyond shared helper exports), and this pack demonstrably ADDS sites (숨고, 크몽) that
 * appear nowhere in `index.md` or the store profile.
 *
 * Read-only by construction: every command declares `effect: 'read'`, and the provider sources are
 * gated against click/submit tokens by `service-quotes.test.ts` (§9.5).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sha256Digest, type CanonicalJsonValue } from '../../../axsdk-sdk-js/packages/axsdk-packs/src/canonical.ts';
import type { VerifiedAgentPackInput } from '../../../axsdk-sdk-js/packages/axsdk-packs/src/composer.ts';
import {
  parsePackManifest,
  type AgentPackManifestV2,
  type CommandContractV1,
} from '../../../axsdk-sdk-js/packages/axsdk-packs/src/schemas.ts';
import {
  descriptor,
  FLOW_MEDIA_TYPE,
  releaseFor,
  SCRIPT_MEDIA_TYPE,
  type FirstPartyReleaseSigner,
} from './first-party.ts';
import { wrapLuaSource } from './wrap-lua.mjs';

const PUBLISHED_AT = '2026-09-03T00:00:00Z';

function leaf(classification: 'user_content' | 'public_product', destinations: readonly string[]) {
  return { class: classification, destinations: [...destinations] };
}

const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    site: { type: 'string', minLength: 1, maxLength: 40 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    rating: { type: 'number', minimum: 0, maximum: 5 },
    review_count: { type: 'integer', minimum: 0 },
    hires: { type: 'integer', minimum: 0 },
    experience_years: { type: 'integer', minimum: 0 },
    // pattern, not enum: an enum's ELEMENTS are one depth level deeper, and this leaf sits at the
    // flow fragment's depth-8 boundary.
    claim_kind: { type: 'string', pattern: '^(?:pro_stated|listing_price)$' },
    claim_text: { type: 'string', minLength: 1, maxLength: 240 },
  },
  required: ['name'],
} as const;

const siteClaimSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    site: { type: 'string', minLength: 1, maxLength: 40 },
    kind: { type: 'string', pattern: '^site_average$' },
    text: { type: 'string', minLength: 1, maxLength: 400 },
  },
  required: ['kind', 'text'],
} as const;

export const marketplaceReadInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 240 },
    region: { type: 'string', maxLength: 40 },
    limit: { type: 'integer', minimum: 1, maximum: 6 },
  },
  required: ['query', 'limit'],
} as const;

/** The provider command's OUTPUT SCHEMA is the RESULT shape (first-party convention): the
 *  step/navigate envelope is transport, not reviewed data. */
export const marketplaceReadOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', enum: [1] },
    status: { type: 'string', enum: ['candidates', 'no_results'] },
    query: { type: 'string', minLength: 1, maxLength: 240 },
    cards_seen: { type: 'integer', minimum: 0, maximum: 1000 },
    candidates: { type: 'array', maxItems: 8, items: candidateSchema },
    site_claims: { type: 'array', maxItems: 2, items: siteClaimSchema },
  },
  required: ['schema_version', 'status', 'query', 'cards_seen'],
} as const;

function candidateLeaves(prefix: string) {
  return {
    [`${prefix}/site`]: leaf('public_product', ['task_script']),
    [`${prefix}/name`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/url`]: leaf('public_product', ['task_script']),
    [`${prefix}/rating`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/review_count`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/hires`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/experience_years`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/claim_kind`]: leaf('public_product', ['task_script']),
    [`${prefix}/claim_text`]: leaf('public_product', ['task_script']),
  };
}

function siteClaimLeaves(prefix: string) {
  return {
    [`${prefix}/site`]: leaf('public_product', ['task_script']),
    [`${prefix}/kind`]: leaf('public_product', ['task_script']),
    [`${prefix}/text`]: leaf('public_product', ['task_script']),
  };
}

function normalisedRowLeaves(prefix: string, destinations: readonly string[]) {
  return {
    [`${prefix}/kind`]: leaf('public_product', destinations),
    [`${prefix}/text`]: leaf('public_product', destinations),
    [`${prefix}/amount`]: leaf('public_product', destinations),
    [`${prefix}/currency`]: leaf('public_product', destinations),
    [`${prefix}/unit`]: leaf('public_product', destinations),
    [`${prefix}/band/low`]: leaf('public_product', destinations),
    [`${prefix}/band/high`]: leaf('public_product', destinations),
    [`${prefix}/comparable`]: leaf('public_product', destinations),
  };
}

const readCommand: CommandContractV1 = {
  name: 'read_service_candidates',
  export: 'readServiceCandidates',
  contract: 'service.marketplace.read.v1',
  effect: 'read',
  requiresUserConfirmation: false,
  inputSchema: marketplaceReadInputSchema,
  outputSchema: marketplaceReadOutputSchema,
  dataFlow: {
    input: {
      '/query': leaf('user_content', ['provider_page']),
      '/region': leaf('user_content', ['provider_page']),
      '/limit': leaf('user_content', ['provider_page']),
    },
    output: {
      '/schema_version': leaf('public_product', ['task_script']),
      '/status': leaf('public_product', ['task_script', 'backend_model']),
      '/query': leaf('user_content', ['task_script']),
      '/cards_seen': leaf('public_product', ['task_script', 'backend_model']),
      ...candidateLeaves('/candidates/*'),
      ...siteClaimLeaves('/site_claims/*'),
    },
  },
};

const prepareCommand: CommandContractV1 = {
  name: 'prepare_service_query',
  export: 'prepareServiceQuery',
  contract: 'service.task.prepare-query.v1',
  effect: 'read',
  requiresUserConfirmation: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 240 },
      region: { type: 'string', maxLength: 40 },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 240 },
      region: { type: 'string', minLength: 1, maxLength: 40 },
      limit: { type: 'integer', minimum: 1, maximum: 6 },
    },
    required: ['query', 'limit'],
  },
  dataFlow: {
    input: {
      '/query': leaf('user_content', ['task_script']),
      '/region': leaf('user_content', ['task_script']),
    },
    output: {
      '/query': leaf('user_content', ['task_script']),
      '/region': leaf('user_content', ['task_script']),
      '/limit': leaf('user_content', ['task_script']),
    },
  },
};

const normaliseCommand: CommandContractV1 = {
  name: 'normalise_service_price',
  export: 'normaliseServicePrice',
  contract: 'service.task.normalise-price.v1',
  effect: 'read',
  requiresUserConfirmation: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      claims: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['pro_stated', 'listing_price', 'site_average'] },
            text: { type: 'string', minLength: 1, maxLength: 400 },
          },
          required: ['kind', 'text'],
        },
      },
    },
    required: ['claims'],
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      rows: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['pro_stated', 'listing_price', 'site_average'] },
            text: { type: 'string', minLength: 1, maxLength: 400 },
            amount: { type: 'number', exclusiveMinimum: 0 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            unit: { type: 'string', enum: ['per_visit', 'per_hour', 'per_job', 'starting_at'] },
            band: {
              type: 'object',
              additionalProperties: false,
              properties: {
                low: { type: 'number', exclusiveMinimum: 0 },
                high: { type: 'number', exclusiveMinimum: 0 },
              },
              required: ['low', 'high'],
            },
            comparable: { type: 'boolean' },
          },
          required: ['kind', 'text', 'comparable'],
        },
      },
    },
    required: ['rows'],
  },
  dataFlow: {
    input: {
      '/claims/*/kind': leaf('public_product', ['task_script']),
      '/claims/*/text': leaf('public_product', ['task_script']),
    },
    output: normalisedRowLeaves('/rows/*', ['task_script', 'backend_model']),
  },
};

const rankCommand: CommandContractV1 = {
  name: 'rank_service_estimates',
  export: 'rankServiceEstimates',
  contract: 'service.task.rank-estimates.v1',
  effect: 'read',
  requiresUserConfirmation: false,
  // Exactly the flow-tool boundary (`command_schema_mismatch` is the gate): the provider result as
  // one envelope, because a flow fragment is depth-bounded at 8 and claims live flattened per
  // candidate. Strict shape enforcement is `marketplaceReadOutputSchema` itself.
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { marketplaceResult: marketplaceReadOutputSchema },
    required: ['marketplaceResult'],
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      rows: {
        type: 'array',
        maxItems: 18,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            site: { type: 'string', minLength: 1, maxLength: 40 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            url: { type: 'string', format: 'uri', maxLength: 2048 },
            rating: { type: 'number', minimum: 0, maximum: 5 },
            review_count: { type: 'integer', minimum: 0 },
            hires: { type: 'integer', minimum: 0 },
            experience_years: { type: 'integer', minimum: 0 },
            amount: { type: 'number', exclusiveMinimum: 0 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            unit: { type: 'string', enum: ['per_visit', 'per_hour', 'per_job', 'starting_at'] },
            provenance: {
              type: 'string',
              enum: ['pro_stated', 'listing_price', 'amount_not_published'],
            },
          },
          required: ['name', 'provenance'],
        },
      },
      site_rows: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            site: { type: 'string', minLength: 1, maxLength: 40 },
            kind: { type: 'string', enum: ['site_average'] },
            text: { type: 'string', minLength: 1, maxLength: 400 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            unit: { type: 'string', enum: ['per_visit', 'per_hour', 'per_job', 'starting_at'] },
            band: {
              type: 'object',
              additionalProperties: false,
              properties: {
                low: { type: 'number', exclusiveMinimum: 0 },
                high: { type: 'number', exclusiveMinimum: 0 },
              },
              required: ['low', 'high'],
            },
            comparable: { type: 'boolean' },
            provenance: { type: 'string', enum: ['site_average'] },
          },
          required: ['kind', 'text', 'comparable', 'provenance'],
        },
      },
      comparisonText: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    required: ['rows', 'site_rows', 'comparisonText'],
  },
  dataFlow: {
    input: {
      '/marketplaceResult/schema_version': leaf('public_product', ['task_script']),
      '/marketplaceResult/status': leaf('public_product', ['task_script']),
      '/marketplaceResult/query': leaf('user_content', ['task_script']),
      '/marketplaceResult/cards_seen': leaf('public_product', ['task_script']),
      ...candidateLeaves('/marketplaceResult/candidates/*'),
      ...siteClaimLeaves('/marketplaceResult/site_claims/*'),
    },
    output: {
      '/rows/*/site': leaf('public_product', ['backend_model']),
      '/rows/*/name': leaf('public_product', ['backend_model']),
      '/rows/*/url': leaf('public_product', ['backend_model']),
      '/rows/*/rating': leaf('public_product', ['backend_model']),
      '/rows/*/review_count': leaf('public_product', ['backend_model']),
      '/rows/*/hires': leaf('public_product', ['backend_model']),
      '/rows/*/experience_years': leaf('public_product', ['backend_model']),
      '/rows/*/amount': leaf('public_product', ['backend_model']),
      '/rows/*/currency': leaf('public_product', ['backend_model']),
      '/rows/*/unit': leaf('public_product', ['backend_model']),
      '/rows/*/provenance': leaf('public_product', ['backend_model']),
      '/site_rows/*/site': leaf('public_product', ['backend_model']),
      '/site_rows/*/kind': leaf('public_product', ['backend_model']),
      '/site_rows/*/text': leaf('public_product', ['backend_model']),
      '/site_rows/*/currency': leaf('public_product', ['backend_model']),
      '/site_rows/*/unit': leaf('public_product', ['backend_model']),
      '/site_rows/*/band/low': leaf('public_product', ['backend_model']),
      '/site_rows/*/band/high': leaf('public_product', ['backend_model']),
      '/site_rows/*/comparable': leaf('public_product', ['backend_model']),
      '/site_rows/*/provenance': leaf('public_product', ['backend_model']),
      '/comparisonText': leaf('public_product', ['backend_model']),
    },
  },
};

const PROVIDERS = [
  {
    providerId: 'thumbtack',
    label: 'Thumbtack',
    assetKey: 'thumbtackProviderScript',
    sourcePath: 'packs/service-quotes/providers/thumbtack.lua',
    artifactName: 'layorix.service-quotes/providers/thumbtack',
    origin: 'https://www.thumbtack.com',
  },
  {
    providerId: 'soomgo',
    label: '숨고',
    assetKey: 'soomgoProviderScript',
    sourcePath: 'packs/service-quotes/providers/soomgo.lua',
    artifactName: 'layorix.service-quotes/providers/soomgo',
    origin: 'https://soomgo.com',
  },
  {
    providerId: 'kmong',
    label: '크몽',
    assetKey: 'kmongProviderScript',
    sourcePath: 'packs/service-quotes/providers/kmong.lua',
    artifactName: 'layorix.service-quotes/providers/kmong',
    origin: 'https://kmong.com',
  },
] as const;

export interface ServiceQuotesPackBuild {
  readonly pack: VerifiedAgentPackInput;
  readonly assets: Readonly<Record<string, Uint8Array>>;
}

export async function buildServiceQuotesPackInputs(
  root: string,
  sign?: FirstPartyReleaseSigner,
): Promise<ServiceQuotesPackBuild> {
  const flowSource = await readFile(resolve(root, 'packs/service-quotes/flow.yaml'), 'utf8');
  const taskLua = await readFile(resolve(root, 'packs/service-quotes/src/task.lua'), 'utf8');
  const providerSources = await Promise.all(PROVIDERS.map(async (provider) => ({
    ...provider,
    lua: await readFile(resolve(root, provider.sourcePath), 'utf8'),
  })));

  const bytes = (source: string) => new TextEncoder().encode(source);
  const luaDescriptor = async (wrapped: string, luaSource: string) => ({
    ...(await descriptor(wrapped, SCRIPT_MEDIA_TYPE)),
    authoring: {
      language: 'lua' as const,
      wrapper: 'axsdk-lua-wrapper@1' as const,
      sourceRef: await sha256Digest(bytes(luaSource)),
    },
  });

  const taskSource = wrapLuaSource(taskLua, { name: 'layorix.service-quotes/task' });
  const flow = await descriptor(flowSource, FLOW_MEDIA_TYPE);
  const taskScript = await luaDescriptor(taskSource, taskLua);
  const providerAssets = await Promise.all(providerSources.map(async (provider) => ({
    ...provider,
    wrapped: wrapLuaSource(provider.lua, { name: provider.artifactName }),
  })));
  const providerDescriptors = await Promise.all(providerAssets.map(async (provider) => ({
    ...provider,
    asset: await luaDescriptor(provider.wrapped, provider.lua),
  })));

  const manifest = parsePackManifest({
    schemaVersion: 2,
    pack: {
      id: 'layorix.service-quotes',
      type: 'agent',
      version: '1.0.0',
      publisherId: 'layorix',
      minimumRuntimeVersion: 2,
    },
    dependencies: [],
    assets: {
      flow,
      taskScript,
      ...Object.fromEntries(providerDescriptors.map((provider) => [provider.assetKey, provider.asset])),
    },
    execution: { role: 'task', target: 'axsdk_task_executor' },
    routeContributions: [{
      intent: 'service_quote_compare',
      entry: 'service_quote_compare.entry',
      description: 'Compare what each service marketplace publicly publishes about providers — '
        + 'amounts with provenance, or reputation only — without requesting any quote.',
      examples: ['청소 업체 공개 가격 비교해줘', 'Compare published house cleaning rates'],
    }],
    resumeRules: [],
    extensionPoints: [{
      id: 'service_marketplaces',
      contract: 'service.marketplace.v1',
      cardinality: 'many',
      maxContributions: 32,
      maxProvidersPerInvocation: 3,
    }],
    embeddedProviders: providerDescriptors.map((provider) => ({
      providerId: provider.providerId,
      label: provider.label,
      artifact: provider.assetKey,
      execution: {
        role: 'provider',
        matches: [`${provider.origin}/*`],
        approvedOrigins: [provider.origin],
        entryUrl: `${provider.origin}/`,
      },
      contribution: {
        extensionPoint: 'service_marketplaces',
        contract: 'service.marketplace.v1',
        command: 'read_service_candidates',
        defaultEnabled: true,
        productMatches: [`${provider.origin}/*`],
      },
      commands: [readCommand],
    })),
    serviceDependencies: [],
    disclosures: [{
      id: 'service-marketplace-pages',
      text: 'Reads publicly listed service providers and published prices on enabled marketplace pages. Never requests a quote.',
    }],
    review: {
      reviewerId: 'layorix-security-review',
      reviewedAt: PUBLISHED_AT,
      artifactRefs: [flow.ref, taskScript.ref, ...providerDescriptors.map((provider) => provider.asset.ref)],
    },
    commands: [prepareCommand, normaliseCommand, rankCommand],
  }) as AgentPackManifestV2;

  const sealed = await releaseFor(manifest, sign);
  return {
    pack: {
      release: sealed.release,
      releaseDigest: sealed.releaseDigest,
      manifest,
      status: 'enabled',
      flowSource,
    },
    assets: {
      [sealed.manifestDigest]: sealed.manifestBytes,
      [flow.ref]: bytes(flowSource),
      [taskScript.ref]: bytes(taskSource),
      ...Object.fromEntries(providerDescriptors.map((provider) => [provider.asset.ref, bytes(provider.wrapped)])),
    },
  };
}
