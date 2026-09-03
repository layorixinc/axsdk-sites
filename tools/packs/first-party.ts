import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  canonicalJson,
  sha256Digest,
  type CanonicalJsonValue,
} from '../../../axsdk-sdk-js/packages/axsdk-packs/src/canonical.ts';
import type {
  VerifiedAgentPackInput,
  VerifiedProviderPackInput,
} from '../../../axsdk-sdk-js/packages/axsdk-packs/src/composer.ts';
import {
  parsePackManifest,
  type AgentPackManifestV2,
  type CommandContractV1,
  type PackReleaseEnvelope,
  type ProviderPackManifestV2,
} from '../../../axsdk-sdk-js/packages/axsdk-packs/src/schemas.ts';
import { wrapLuaSource } from './wrap-lua.mjs';

const PUBLISHED_AT = '2026-08-24T00:00:00Z';
const FLOW_MEDIA_TYPE = 'application/vnd.axsdk.flow-fragment+yaml';
const SCRIPT_MEDIA_TYPE = 'application/javascript';

export const providerSearchInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 240 },
    page: { type: 'integer', minimum: 1, maximum: 2 },
    limit: { type: 'integer', minimum: 1, maximum: 6 },
    quantity: { type: 'integer', minimum: 1, maximum: 99 },
    query_variants: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 240 },
      minItems: 1,
      maxItems: 3,
    },
  },
  required: ['query', 'page', 'limit', 'quantity', 'query_variants'],
} as const;

const providerCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    product_id: { type: 'string', minLength: 1, maxLength: 128 },
    name: { type: 'string', minLength: 1, maxLength: 500 },
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    price: { type: 'number', exclusiveMinimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    shipping_cost: { type: 'number', minimum: 0 },
    shipping_currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    brand: { type: 'string', minLength: 1, maxLength: 128 },
    manufacturer_model: { type: 'string', minLength: 1, maxLength: 128 },
    rating: { type: 'number', minimum: 0, maximum: 5 },
    review_count: { type: 'integer', minimum: 0 },
    condition: { type: 'string', minLength: 1, maxLength: 64 },
  },
  required: ['product_id', 'name', 'url', 'price', 'currency'],
} as const;

export const providerSearchOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', enum: [1] },
    status: { type: 'string', enum: ['candidates', 'no_results', 'price_unavailable'] },
    query: { type: 'string', minLength: 1, maxLength: 240 },
    page: { type: 'integer', minimum: 1, maximum: 2 },
    cards_seen: { type: 'integer', minimum: 0, maximum: 1000 },
    has_more: { type: 'boolean' },
    candidates: {
      type: 'array',
      items: providerCandidateSchema,
      maxItems: 6,
    },
  },
  required: ['schema_version', 'status', 'query', 'page', 'cards_seen', 'has_more'],
} as const;

const rankedOfferSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    product_id: providerCandidateSchema.properties.product_id,
    name: providerCandidateSchema.properties.name,
    url: providerCandidateSchema.properties.url,
    price: providerCandidateSchema.properties.price,
    currency: providerCandidateSchema.properties.currency,
    shipping_cost: providerCandidateSchema.properties.shipping_cost,
    shipping_currency: providerCandidateSchema.properties.shipping_currency,
    brand: providerCandidateSchema.properties.brand,
    manufacturer_model: providerCandidateSchema.properties.manufacturer_model,
    rating: providerCandidateSchema.properties.rating,
    review_count: providerCandidateSchema.properties.review_count,
    condition: providerCandidateSchema.properties.condition,
    total: { type: 'number', exclusiveMinimum: 0 },
  },
  required: ['product_id', 'name', 'url', 'price', 'currency'],
} as const;

export const rankProviderOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['candidates', 'no_results', 'price_unavailable'] },
    offers: { type: 'array', items: rankedOfferSchema, maxItems: 6 },
    comparisonText: { type: 'string', minLength: 1, maxLength: 8192 },
  },
  required: ['status', 'offers', 'comparisonText'],
} as const;

const prepareSearchInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { query: { type: 'string', minLength: 1, maxLength: 240 } },
  required: ['query'],
} as const;

const rankProviderInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { providerResult: providerSearchOutputSchema },
  required: ['providerResult'],
} as const;

function leaf(classification: 'user_content' | 'public_product', destinations: readonly string[]) {
  return { class: classification, destinations: [...destinations] };
}

function searchInputDataFlow() {
  return {
    '/query': leaf('user_content', ['provider_page']),
    '/page': leaf('user_content', ['provider_page']),
    '/limit': leaf('user_content', ['provider_page']),
    '/quantity': leaf('user_content', ['provider_page']),
    '/query_variants/*': leaf('user_content', ['provider_page']),
  };
}

function candidateOutputDataFlow(prefix = '') {
  return {
    [`${prefix}/product_id`]: leaf('public_product', ['task_script']),
    [`${prefix}/name`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/url`]: leaf('public_product', ['task_script']),
    [`${prefix}/price`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/currency`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/shipping_cost`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/shipping_currency`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/brand`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/manufacturer_model`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/rating`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/review_count`]: leaf('public_product', ['task_script', 'backend_model']),
    [`${prefix}/condition`]: leaf('public_product', ['task_script', 'backend_model']),
  };
}

function providerOutputDataFlow() {
  return {
    '/schema_version': leaf('public_product', ['task_script']),
    '/status': leaf('public_product', ['task_script', 'backend_model']),
    '/query': leaf('user_content', ['task_script']),
    '/page': leaf('user_content', ['task_script']),
    '/cards_seen': leaf('public_product', ['task_script', 'backend_model']),
    '/has_more': leaf('public_product', ['task_script']),
    ...candidateOutputDataFlow('/candidates/*'),
  };
}

const searchCommand: CommandContractV1 = {
  name: 'search_products',
  export: 'searchProducts',
  contract: 'commerce.storefront.search.v1',
  effect: 'read',
  requiresUserConfirmation: false,
  inputSchema: providerSearchInputSchema,
  outputSchema: providerSearchOutputSchema,
  dataFlow: {
    input: searchInputDataFlow(),
    output: providerOutputDataFlow(),
  },
};

const prepareCommand: CommandContractV1 = {
  name: 'prepare_search',
  export: 'prepareSearch',
  contract: 'commerce.task.prepare-search.v1',
  effect: 'read',
  requiresUserConfirmation: false,
  inputSchema: prepareSearchInputSchema,
  outputSchema: providerSearchInputSchema,
  dataFlow: {
    input: { '/query': leaf('user_content', ['task_script']) },
    output: {
      '/query': leaf('user_content', ['task_script']),
      '/page': leaf('user_content', ['task_script']),
      '/limit': leaf('user_content', ['task_script']),
      '/quantity': leaf('user_content', ['task_script']),
      '/query_variants/*': leaf('user_content', ['task_script']),
    },
  },
};

const rankInputFlow = {
  '/providerResult/schema_version': leaf('public_product', ['task_script']),
  '/providerResult/status': leaf('public_product', ['task_script']),
  '/providerResult/query': leaf('user_content', ['task_script']),
  '/providerResult/page': leaf('user_content', ['task_script']),
  '/providerResult/cards_seen': leaf('public_product', ['task_script']),
  '/providerResult/has_more': leaf('public_product', ['task_script']),
  ...candidateOutputDataFlow('/providerResult/candidates/*'),
};
const rankOutputFlow = {
  '/status': leaf('public_product', ['backend_model']),
  '/comparisonText': leaf('public_product', ['backend_model']),
  ...candidateOutputDataFlow('/offers/*'),
  '/offers/*/total': leaf('public_product', ['backend_model']),
};

const rankCommand: CommandContractV1 = {
  name: 'rank_provider_result',
  export: 'rankProviderResult',
  contract: 'commerce.task.rank-provider-result.v1',
  effect: 'read',
  requiresUserConfirmation: false,
  inputSchema: rankProviderInputSchema,
  outputSchema: rankProviderOutputSchema,
  dataFlow: { input: rankInputFlow, output: rankOutputFlow },
};

async function descriptor(source: string, mediaType: string) {
  const bytes = new TextEncoder().encode(source);
  return { ref: await sha256Digest(bytes), bytes: bytes.byteLength, mediaType } as const;
}

/**
 * Seals one release envelope. The DEFAULT is UNSIGNED (2026-09-03 decision, EXTERNAL_PACK_TASK_PLAN
 * X2): trust is the user-chosen registry source plus the content-addressed digest chain, so the
 * envelope simply omits `signature`. A caller exercising the SIGNED mode passes a real Ed25519
 * signer — see `first-party.test.ts`.
 */
export type FirstPartyReleaseSigner = (signed: CanonicalJsonValue) => Promise<{
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly value: string;
}>;

async function releaseFor(
  manifest: AgentPackManifestV2 | ProviderPackManifestV2,
  sign?: FirstPartyReleaseSigner,
): Promise<{
  release: PackReleaseEnvelope;
  releaseDigest: `sha256:${string}`;
  manifestBytes: Uint8Array;
  manifestDigest: `sha256:${string}`;
}> {
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest as unknown as CanonicalJsonValue));
  const manifestDigest = await sha256Digest(manifestBytes);
  const signed = {
    packId: manifest.pack.id,
    version: manifest.pack.version,
    publishedAt: PUBLISHED_AT,
    manifest: { ref: manifestDigest, bytes: manifestBytes.byteLength },
  } as const;
  const release = {
    schemaVersion: 2,
    kind: 'release',
    signed,
    ...(sign === undefined ? {} : { signature: await sign(signed as unknown as CanonicalJsonValue) }),
  } as PackReleaseEnvelope;
  const releaseDigest = await sha256Digest(new TextEncoder().encode(
    canonicalJson(release as unknown as CanonicalJsonValue),
  ));
  return { release, releaseDigest, manifestBytes, manifestDigest };
}

export interface FirstPartyPackBuild {
  readonly shopping: VerifiedAgentPackInput;
  readonly storeX: VerifiedProviderPackInput;
  /** Every byte string the releases reference, keyed by digest: manifests and declared assets. */
  readonly assets: Readonly<Record<string, Uint8Array>>;
}

export async function buildFirstPartyPackInputs(
  root: string,
  sign?: FirstPartyReleaseSigner,
): Promise<FirstPartyPackBuild> {
  const [flowSource, taskLua, amazonLua, storeXLua] = await Promise.all([
    readFile(resolve(root, 'packs/shopping/flow.yaml'), 'utf8'),
    readFile(resolve(root, 'packs/shopping/src/task.lua'), 'utf8'),
    readFile(resolve(root, 'packs/shopping/providers/amazon.lua'), 'utf8'),
    readFile(resolve(root, 'packs/store-x/src/provider.lua'), 'utf8'),
  ]);
  // Lua is the authored AND distributed form: the signed artifact is the fixed zero-logic wrapper
  // around the exact Lua source (LUA_PACK_DESIGN.md), still `application/javascript` because
  // chrome.userScripts executes JavaScript only.
  const taskSource = wrapLuaSource(taskLua, { name: 'layorix.shopping/task' });
  const amazonSource = wrapLuaSource(amazonLua, { name: 'layorix.shopping/providers/amazon' });
  const storeXSource = wrapLuaSource(storeXLua, { name: 'example.store-x/provider' });
  const luaDescriptor = async (wrapped: string, luaSource: string) => ({
    ...(await descriptor(wrapped, SCRIPT_MEDIA_TYPE)),
    // Review metadata: the digest of the LUA bytes reviewers read; the artifact itself is the
    // fixed wrapper around exactly those bytes (pinned by the drift test beside the suite).
    authoring: {
      language: 'lua' as const,
      wrapper: 'axsdk-lua-wrapper@1' as const,
      sourceRef: await sha256Digest(new TextEncoder().encode(luaSource)),
    },
  });
  const [flow, taskScript, amazonProviderScript, storeXProviderScript] = await Promise.all([
    descriptor(flowSource, FLOW_MEDIA_TYPE),
    luaDescriptor(taskSource, taskLua),
    luaDescriptor(amazonSource, amazonLua),
    luaDescriptor(storeXSource, storeXLua),
  ]);

  const shoppingManifest = parsePackManifest({
    schemaVersion: 2,
    pack: {
      id: 'layorix.shopping',
      type: 'agent',
      version: '1.0.0',
      publisherId: 'layorix',
      minimumRuntimeVersion: 2,
    },
    dependencies: [],
    assets: { flow, taskScript, amazonProviderScript },
    execution: { role: 'task', target: 'axsdk_task_executor' },
    routeContributions: [{
      intent: 'shopping_search',
      entry: 'shopping_search.entry',
      description: 'Search enabled storefront providers and compare grounded offers.',
      examples: ['Amazon에서 Logitech M185 찾아줘', 'Search Amazon for a Logitech M185'],
    }],
    resumeRules: [],
    extensionPoints: [{
      id: 'storefronts',
      contract: 'commerce.storefront.v1',
      cardinality: 'many',
      maxContributions: 32,
      maxProvidersPerInvocation: 3,
    }],
    embeddedProviders: [{
      providerId: 'amazon',
      label: 'Amazon',
      artifact: 'amazonProviderScript',
      execution: {
        role: 'provider',
        matches: ['https://www.amazon.com/*'],
        approvedOrigins: ['https://www.amazon.com'],
        entryUrl: 'https://www.amazon.com/',
      },
      contribution: {
        extensionPoint: 'storefronts',
        contract: 'commerce.storefront.v1',
        command: 'search_products',
        defaultEnabled: true,
        productMatches: ['https://www.amazon.com/dp/*'],
      },
      commands: [searchCommand],
    }],
    serviceDependencies: [],
    disclosures: [{
      id: 'shopping-provider-pages',
      text: 'Reads product listings on enabled storefront provider pages.',
    }],
    review: {
      reviewerId: 'layorix-security-review',
      reviewedAt: PUBLISHED_AT,
      artifactRefs: [flow.ref, taskScript.ref, amazonProviderScript.ref],
    },
    commands: [prepareCommand, rankCommand],
  }) as AgentPackManifestV2;

  const storeXManifest = parsePackManifest({
    schemaVersion: 2,
    pack: {
      id: 'example.store-x',
      type: 'provider',
      version: '1.0.0',
      publisherId: 'example',
      minimumRuntimeVersion: 2,
    },
    dependencies: [],
    assets: { providerScript: storeXProviderScript },
    contributions: [{
      targetPack: 'layorix.shopping',
      targetVersion: '>=1.0.0 <2.0.0',
      extensionPoint: 'storefronts',
      contract: 'commerce.storefront.v1',
      providerId: 'store-x',
      label: 'Store X',
      aliases: ['Store X', '스토어 엑스'],
      artifact: 'providerScript',
      execution: {
        role: 'provider',
        matches: ['https://www.store-x.example/*'],
        approvedOrigins: ['https://www.store-x.example'],
        entryUrl: 'https://www.store-x.example/',
      },
      command: 'search_products',
      defaultEnabled: true,
      productMatches: ['https://www.store-x.example/product/*'],
    }],
    commands: [searchCommand],
    serviceDependencies: [],
    disclosures: [{ id: 'store-x-listings', text: 'Reads product listings on Store X pages.' }],
    review: {
      reviewerId: 'example-security-review',
      reviewedAt: PUBLISHED_AT,
      artifactRefs: [storeXProviderScript.ref],
    },
  }) as ProviderPackManifestV2;

  const [shoppingRelease, storeXRelease] = await Promise.all([
    releaseFor(shoppingManifest, sign),
    releaseFor(storeXManifest, sign),
  ]);
  const bytes = (source: string) => new TextEncoder().encode(source);
  return {
    shopping: {
      release: shoppingRelease.release,
      releaseDigest: shoppingRelease.releaseDigest,
      manifest: shoppingManifest,
      status: 'enabled',
      flowSource,
    },
    storeX: {
      release: storeXRelease.release,
      releaseDigest: storeXRelease.releaseDigest,
      manifest: storeXManifest,
      status: 'enabled',
    },
    assets: {
      [shoppingRelease.manifestDigest]: shoppingRelease.manifestBytes,
      [storeXRelease.manifestDigest]: storeXRelease.manifestBytes,
      [flow.ref]: bytes(flowSource),
      [taskScript.ref]: bytes(taskSource),
      [amazonProviderScript.ref]: bytes(amazonSource),
      [storeXProviderScript.ref]: bytes(storeXSource),
    },
  };
}
