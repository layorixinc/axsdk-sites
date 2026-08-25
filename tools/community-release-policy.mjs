import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMMUNITY_PRODUCT_CHARTER = 'AXSDK installs, manages, and runs user-selected community web-automation scripts on websites explicitly authorized by the user.';

const EXPECTED = Object.freeze({
  topLevel: [
    'schemaVersion',
    'productCharter',
    'browser',
    'artifacts',
    'approvals',
    'updates',
    'trust',
    'effects',
    'modelMayManageScripts',
  ],
  browser: ['minimumChromeVersion', 'executionApi', 'world'],
  artifacts: [
    'executionLanguage',
    'acceptedAuthoringLanguages',
    'luaPublication',
    'remoteInterpreter',
  ],
  approvals: ['install', 'enable', 'update', 'hostExpansion', 'capabilityExpansion'],
  updates: ['automatic', 'atomicRollback'],
  trust: ['registryReviewed', 'registrySigned', 'arbitraryUrlImport', 'unsignedScripts'],
  effects: ['allowed', 'forbidden'],
  allowedEffects: ['read', 'page_write', 'external_send', 'cart_mutation'],
  forbiddenEffects: ['purchase', 'order_placement', 'payment'],
});

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function closed(value, expectedKeys, path) {
  const object = record(value, path);
  const allowed = new Set(expectedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${path} has unknown key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${path} is missing key: ${key}`);
  }
  return object;
}

function equal(actual, expected, path) {
  if (actual !== expected) throw new Error(`${path} must be ${String(expected)}`);
}

function exactArray(actual, expected, path) {
  if (!Array.isArray(actual) || actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${path} must exactly equal ${expected.join(', ')}`);
  }
}

export function validateCommunityReleasePolicy(input) {
  const policy = closed(input, EXPECTED.topLevel, 'community release policy');
  equal(policy.schemaVersion, 1, 'schemaVersion');
  equal(policy.productCharter, COMMUNITY_PRODUCT_CHARTER, 'productCharter');

  const browser = closed(policy.browser, EXPECTED.browser, 'browser');
  equal(browser.minimumChromeVersion, 138, 'browser.minimumChromeVersion');
  equal(browser.executionApi, 'chrome.userScripts', 'browser.executionApi');
  equal(browser.world, 'USER_SCRIPT', 'browser.world');

  const artifacts = closed(policy.artifacts, EXPECTED.artifacts, 'artifacts');
  equal(artifacts.executionLanguage, 'javascript', 'artifacts.executionLanguage');
  exactArray(
    artifacts.acceptedAuthoringLanguages,
    ['javascript', 'lua'],
    'artifacts.acceptedAuthoringLanguages',
  );
  equal(
    artifacts.luaPublication,
    'deterministic_javascript_before_review',
    'artifacts.luaPublication',
  );
  equal(artifacts.remoteInterpreter, false, 'artifacts.remoteInterpreter');

  const approvals = closed(policy.approvals, EXPECTED.approvals, 'approvals');
  for (const decision of EXPECTED.approvals) equal(approvals[decision], 'always', `approvals.${decision}`);

  const updates = closed(policy.updates, EXPECTED.updates, 'updates');
  equal(updates.automatic, false, 'updates.automatic');
  equal(updates.atomicRollback, true, 'updates.atomicRollback');

  const trust = closed(policy.trust, EXPECTED.trust, 'trust');
  equal(trust.registryReviewed, true, 'trust.registryReviewed');
  equal(trust.registrySigned, true, 'trust.registrySigned');
  equal(trust.arbitraryUrlImport, false, 'trust.arbitraryUrlImport');
  equal(trust.unsignedScripts, false, 'trust.unsignedScripts');

  const effects = closed(policy.effects, EXPECTED.effects, 'effects');
  exactArray(effects.allowed, EXPECTED.allowedEffects, 'effects.allowed');
  exactArray(effects.forbidden, EXPECTED.forbiddenEffects, 'effects.forbidden');
  equal(policy.modelMayManageScripts, false, 'modelMayManageScripts');

  return policy;
}

export async function loadCommunityReleasePolicy(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`community release policy is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateCommunityReleasePolicy(value);
}

const policyPath = fileURLToPath(new URL('../community/release-policy.json', import.meta.url));
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  if (process.argv.length !== 3 || process.argv[2] !== '--check') {
    throw new Error('usage: node tools/community-release-policy.mjs --check');
  }
  const policy = await loadCommunityReleasePolicy(policyPath);
  console.log(`COMMUNITY RELEASE POLICY PASS v${policy.schemaVersion}`);
}
