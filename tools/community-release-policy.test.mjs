import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  COMMUNITY_PRODUCT_CHARTER,
  loadCommunityReleasePolicy,
  validateCommunityReleasePolicy,
} from './community-release-policy.mjs';

const policyPath = fileURLToPath(new URL('../community/release-policy.json', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const architecturePath = fileURLToPath(new URL('../COMMUNITY_SCRIPT_ARCHITECTURE.md', import.meta.url));
const implementationPlanPath = fileURLToPath(new URL('../COMMUNITY_SCRIPT_IMPLEMENTATION_PLAN.md', import.meta.url));
const liveLoopPath = fileURLToPath(new URL('../COMMUNITY_SCRIPT_LIVE_LOOP.md', import.meta.url));

function changed(policy, apply) {
  const copy = structuredClone(policy);
  apply(copy);
  return copy;
}

test('the checked-in community release policy locks the launch contract', async () => {
  const policy = await loadCommunityReleasePolicy(policyPath);

  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.productCharter, COMMUNITY_PRODUCT_CHARTER);
  assert.deepEqual(policy.browser, {
    minimumChromeVersion: 138,
    executionApi: 'chrome.userScripts',
    world: 'USER_SCRIPT',
  });
  assert.deepEqual(policy.artifacts, {
    executionLanguage: 'javascript',
    acceptedAuthoringLanguages: ['javascript', 'lua'],
    luaPublication: 'deterministic_javascript_before_review',
    remoteInterpreter: false,
  });
  assert.deepEqual(policy.approvals, {
    install: 'always',
    enable: 'always',
    update: 'always',
    hostExpansion: 'always',
    capabilityExpansion: 'always',
  });
  assert.deepEqual(policy.updates, {
    automatic: false,
    atomicRollback: true,
  });
  assert.deepEqual(policy.trust, {
    registryReviewed: true,
    registrySigned: true,
    arbitraryUrlImport: false,
    unsignedScripts: false,
  });
  assert.deepEqual(policy.effects.allowed, [
    'read',
    'page_write',
    'external_send',
    'cart_mutation',
  ]);
  assert.deepEqual(policy.effects.forbidden, [
    'purchase',
    'order_placement',
    'payment',
  ]);
  assert.equal(policy.modelMayManageScripts, false);
});

test('the policy rejects another dynamic execution channel', async () => {
  const policy = await loadCommunityReleasePolicy(policyPath);
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      copy.browser.executionApi = 'extension-worker';
    })),
    /browser\.executionApi must be chrome\.userScripts/,
  );
});

test('the policy rejects unreviewed Lua or a remote interpreter', async () => {
  const policy = await loadCommunityReleasePolicy(policyPath);
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      copy.artifacts.luaPublication = 'download_lua_source';
    })),
    /artifacts\.luaPublication must be deterministic_javascript_before_review/,
  );
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      copy.artifacts.remoteInterpreter = true;
    })),
    /artifacts\.remoteInterpreter must be false/,
  );
});

test('the policy requires user approval for every lifecycle decision', async () => {
  const policy = await loadCommunityReleasePolicy(policyPath);
  for (const decision of Object.keys(policy.approvals)) {
    assert.throws(
      () => validateCommunityReleasePolicy(changed(policy, (copy) => {
        copy.approvals[decision] = 'automatic';
      })),
      new RegExp(`approvals\\.${decision} must be always`),
    );
  }
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      copy.updates.automatic = true;
    })),
    /updates\.automatic must be false/,
  );
});

test('the policy rejects weaker trust or a model management path', async () => {
  const policy = await loadCommunityReleasePolicy(policyPath);
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      copy.trust.registrySigned = false;
    })),
    /trust\.registrySigned must be true/,
  );
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      copy.modelMayManageScripts = true;
    })),
    /modelMayManageScripts must be false/,
  );
});

test('the policy rejects undeclared or purchase effects', async () => {
  const policy = await loadCommunityReleasePolicy(policyPath);
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      copy.effects.allowed.push('purchase');
    })),
    /effects\.allowed must exactly equal/,
  );
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      copy.effects.forbidden = ['order_placement', 'payment'];
    })),
    /effects\.forbidden must exactly equal/,
  );
});

test('the policy schema is closed against silent new decisions', async () => {
  const policy = await loadCommunityReleasePolicy(policyPath);
  assert.throws(
    () => validateCommunityReleasePolicy({ ...policy, undecided: true }),
    /community release policy has unknown key: undecided/,
  );
  assert.throws(
    () => validateCommunityReleasePolicy(changed(policy, (copy) => {
      delete copy.approvals.update;
    })),
    /approvals is missing key: update/,
  );
});

test('every CWS build verifies the locked community release policy first', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(
    packageJson.scripts['check:community-policy'],
    'node tools/community-release-policy.mjs --check',
  );
  assert.match(packageJson.scripts['build:cws'], /^npm run check:community-policy && /);
});

test('the design documents state the locked Lua conversion and approval decisions', async () => {
  const architecture = await readFile(architecturePath, 'utf8');
  const plan = await readFile(implementationPlanPath, 'utf8');
  const documents = `${architecture}\n${plan}`;

  assert.doesNotMatch(
    documents,
    /written CWS confirmation|Send the two narrowly scoped CWS policy inquiries|CWS Lua AOT answer|CWS update answer/,
  );
  assert.match(architecture, /Every code update requires explicit user approval/);
  assert.match(architecture, /community\/release-policy\.json/);
  assert.match(plan, /community\/release-policy\.json/);
  assert.match(plan, /npm run check:community-policy/);
});


test('the live-loop design keeps the constraints that make it reviewable', async () => {
  const liveLoop = await readFile(liveLoopPath, 'utf8');

  // Revised 2026-08-22: the boundary is capability, not provenance. A release MAY ship a flow
  // fragment; only a packaged flow may grant ops, network egress, or saved-memory access, because
  // those execute against the session tab and the extension realm — authority the USER_SCRIPT world
  // never had. The prohibition on remote code in our own realm is what has no Tampermonkey analogue.
  assert.match(liveLoop, /\*\*A flow from a non-packaged source grants nothing\.\*\*/);
  assert.match(liveLoop, /\*\*No remote code in the extension's own realm\.\*\*/);
  assert.match(liveLoop, /The boundary is capability, not provenance/);
  assert.match(liveLoop, /no script-supplied AX handler or worker module/);
  // `true` would open every AX_widget_* name a widget could invent.
  assert.match(liveLoop, /exact allowlist/);
  assert.match(liveLoop, /`\['AX_widget_community_invoke'\]`/);
  // A new wire op is a platform dependency; the flow may not grant one before it exists.
  assert.match(liveLoop, /no flow tool in\nthe document grants a `community\.\*` op/);
  assert.match(liveLoop, /reported once and never replayed|reported, never replayed/);
  assert.match(liveLoop, /No purchase, order, or payment path\./);
  assert.match(liveLoop, /may not install, enable, grant a host, or approve a consent/);

  assert.equal(
    /\bkind:\s*remote\b/.test(liveLoop),
    false,
    'the live loop must not reintroduce a durable remote command as its invocation channel',
  );
});