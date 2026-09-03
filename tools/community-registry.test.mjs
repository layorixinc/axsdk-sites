import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  COMMUNITY_VECTOR_PATH,
  buildCommunityRegistry,
  buildCommunityRegistryVector,
  canonicalJson,
  compileCommunityRelease,
  loadCommunitySource,
  validateCommunitySource,
  verifyCommunityRelease,
  verifyCommunityRegistryIndex,
  verifyCommunityRevocations,
} from './community-registry.mjs';

const fixtureDir = fileURLToPath(new URL('../fixtures/community/read-page/', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = { keyId: 'fixture-registry-v1', privateKey };
const trustedKeys = new Map([[signer.keyId, publicKey]]);
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const resign = (manifest) => {
  const { signatures: _signatures, ...body } = manifest;
  return {
    ...body,
    signatures: [{
      keyId: signer.keyId,
      algorithm: 'Ed25519',
      value: signBytes(null, Buffer.from(canonicalJson(body)), privateKey).toString('base64url'),
    }],
  };
};

const changed = (value, apply) => {
  const copy = structuredClone(value);
  apply(copy);
  return copy;
};

test('canonical JSON is stable across object insertion order', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, b: 'text' }, list: [3, 2, 1] }),
    '{"a":{"b":"text","y":true},"list":[3,2,1],"z":1}',
  );
});

test('compiles the reviewed fixture into one signed immutable JavaScript release', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const compiled = compileCommunityRelease(source, signer);

  assert.equal(compiled.manifest.schemaVersion, 1);
  assert.equal(compiled.manifest.script.id, 'fixture.read-page');
  assert.deepEqual(compiled.manifest.artifact, {
    ref: hash(source.artifactCode),
    bytes: Buffer.byteLength(source.artifactCode),
    mediaType: 'application/javascript',
  });
  assert.equal(compiled.manifest.artifactPath, undefined);
  assert.deepEqual(compiled.manifest.signatures.map(({ keyId, algorithm }) => ({ keyId, algorithm })), [{
    keyId: signer.keyId,
    algorithm: 'Ed25519',
  }]);
  assert.match(compiled.manifest.signatures[0].value, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(compiled.registeredCommands, ['ping_api', 'probe_forbidden', 'read_heading', 'recall', 'remember']);
  verifyCommunityRelease(compiled.manifest, source.artifactCode, trustedKeys);
});

test('the same source and signer produce byte-identical registry output', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const first = buildCommunityRegistry([source], signer);
  const second = buildCommunityRegistry([source], signer);

  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(first.files), [
    `assets/${hash(source.artifactCode).slice('sha256:'.length)}.js`,
    'scripts/fixture.read-page/1.0.0/manifest.json',
  ]);
  assert.equal(first.index.releases[0].manifestPath, 'scripts/fixture.read-page/1.0.0/manifest.json');
  assert.equal(first.index.releases[0].artifactRef, hash(source.artifactCode));
});

test('one changed artifact byte or manifest field invalidates the release', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const { manifest } = compileCommunityRelease(source, signer);

  assert.throws(
    () => verifyCommunityRelease(manifest, `${source.artifactCode} `, trustedKeys),
    /artifact digest mismatch/,
  );
  assert.throws(
    () => verifyCommunityRelease(changed(manifest, (copy) => {
      copy.script.summary = 'tampered';
    }), source.artifactCode, trustedKeys),
    /manifest signature is invalid/,
  );
});

test('an invalid signature is refused before untrusted artifact code is inspected', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const { manifest } = compileCommunityRelease(source, signer);
  const untrustedCode = 'while (true) {}';
  const tampered = changed(manifest, (copy) => {
    copy.artifact.ref = hash(untrustedCode);
    copy.artifact.bytes = Buffer.byteLength(untrustedCode);
  });

  assert.throws(
    () => verifyCommunityRelease(tampered, untrustedCode, trustedKeys),
    /manifest signature is invalid/,
  );
});

test('source validation rejects unknown decisions, broad hosts, and hidden commands', async () => {
  const source = await loadCommunitySource(fixtureDir);
  assert.throws(
    () => validateCommunitySource({ ...source.manifest, undecided: true }, source.artifactCode),
    /unknown key: undecided/,
  );
  assert.throws(
    () => validateCommunitySource(changed(source.manifest, (copy) => {
      copy.execution.matches = ['<all_urls>'];
    }), source.artifactCode),
    /approved HTTP\(S\) match pattern/,
  );
  assert.throws(
    () => validateCommunitySource(changed(source.manifest, (copy) => {
      copy.commands[0].name = 'not_registered';
    }), source.artifactCode),
    /registered commands do not match the manifest/,
  );
});

test('a release may omit an output schema without weakening its input contract', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const withoutOutput = changed(source.manifest, (copy) => {
    delete copy.commands[0].outputSchema;
  });
  assert.doesNotThrow(() => validateCommunitySource(withoutOutput, source.artifactCode));
});


test('published manifests reject unknown signed fields and schema versions', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const { manifest } = compileCommunityRelease(source, signer);

  assert.throws(
    () => verifyCommunityRelease(resign({ ...manifest, futureDecision: true }), source.artifactCode, trustedKeys),
    /published manifest has unknown key: futureDecision/,
  );
  assert.throws(
    () => verifyCommunityRelease(resign({ ...manifest, schemaVersion: 2 }), source.artifactCode, trustedKeys),
    /schemaVersion must be 1/,
  );
});
test('source validation rejects secondary executable loading and mutation disguised as read', async () => {
  const source = await loadCommunitySource(fixtureDir);
  for (const forbidden of [
    'eval("code")',
    'new Function("return 1")',
    'import("https://example.com/code.js")',
    'WebAssembly.compile(bytes)',
    'document.createElement("script")',
  ]) {
    assert.throws(
      () => validateCommunitySource(source.manifest, `${source.artifactCode}\n${forbidden}`),
      /forbidden executable loading construct/,
    );
  }
  assert.throws(
    () => validateCommunitySource(changed(source.manifest, (copy) => {
      copy.commands[0].effect = 'cart_mutation';
      copy.commands[0].requiresUserConfirmation = false;
    }), source.artifactCode),
    /cart_mutation requires user confirmation/,
  );
});

test('source validation enforces the JavaScript artifact size ceiling', async () => {
  const source = await loadCommunitySource(fixtureDir);
  assert.throws(
    () => validateCommunitySource(source.manifest, `${source.artifactCode}\n/*${'x'.repeat(256 * 1024)}*/`),
    /artifactCode exceeds 262144 bytes/,
  );
});

test('a Lua wrapper artifact is refused BY NAME: it belongs to the Agent Pack registry', async () => {
  // The refusal must carry its raw reason (AGENTS.md §13): without this, a Lua wrapper dies with the
  // incidental "cannot register safely" and the author is sent to debug their registration call.
  const source = await loadCommunitySource(fixtureDir);
  const { wrapLuaSource } = await import('./packs/wrap-lua.mjs');
  const wrapped = wrapLuaSource('register({ noop = function() return {} end })', { name: 'community-lua' });
  assert.throws(
    () => validateCommunitySource(source.manifest, wrapped),
    /lua_wrapper_not_supported_here/,
  );
});

test('the signed index and revocation document fail on tampering', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const registry = buildCommunityRegistry([source], signer);

  verifyCommunityRegistryIndex(registry.index, trustedKeys);
  verifyCommunityRevocations(registry.revocations, trustedKeys);
  assert.throws(
    () => verifyCommunityRegistryIndex(changed(registry.index, (copy) => {
      copy.releases[0].summary = 'tampered';
    }), trustedKeys),
    /registry index signature is invalid/,
  );
  assert.throws(
    () => verifyCommunityRevocations(changed(registry.revocations, (copy) => {
      copy.revocations.push({
        scriptId: 'fixture.read-page',
        version: '1.0.0',
        artifactRef: hash(source.artifactCode),
        reason: 'tampered',
        revokedAt: '2026-08-18T00:00:00.000Z',
      });
    }), trustedKeys),
    /revocations signature is invalid/,
  );
});

test('the checked registry command validates fixtures before every CWS build', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(
    packageJson.scripts['check:community-registry'],
    'node tools/community-registry.mjs --check',
  );
  assert.match(
    packageJson.scripts['build:cws'],
    /^npm run check:community-policy && npm run check:community-registry && /,
  );
});

test('the committed extension test vector is what the generator produces now', async () => {
  const committed = JSON.parse(await readFile(COMMUNITY_VECTOR_PATH, 'utf8'));
  const generated = JSON.parse(JSON.stringify(await buildCommunityRegistryVector()));

  assert.deepEqual(
    committed,
    generated,
    'run: node tools/community-registry.mjs --emit-vector',
  );
  assert.equal(committed.trustedKeys.keys[0].algorithm, 'Ed25519');
  assert.equal(Buffer.from(committed.trustedKeys.keys[0].publicKey, 'base64url').length, 32);
});

test('declared network hosts are optional, concrete, and carried into the release', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const { manifest } = compileCommunityRelease(source, signer);

  assert.deepEqual(manifest.network, { hosts: ['api.axsdk.ai'] });

  // A release that declares no hosts reaches none; absence is the safe default, not a wildcard.
  const withoutNetwork = changed(source.manifest, (copy) => { delete copy.network; });
  assert.doesNotThrow(() => validateCommunitySource(withoutNetwork, source.artifactCode));

  for (const hosts of [['*'], ['*.'], ['*.com'], ['api.axsdk.ai:8443'], ['https://api.axsdk.ai'], ['localhost'], ['']]) {
    assert.throws(
      () => validateCommunitySource(
        changed(source.manifest, (copy) => { copy.network = { hosts }; }),
        source.artifactCode,
      ),
      /network\.hosts/,
      `expected ${JSON.stringify(hosts)} to be refused`,
    );
  }
  assert.throws(
    () => validateCommunitySource(
      changed(source.manifest, (copy) => { copy.network = { hosts: ['a.test'], extra: 1 }; }),
      source.artifactCode,
    ),
    /network has unknown key: extra/,
  );
});

test('a revocation feed carries a monotonic sequence and its issue time', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const registry = buildCommunityRegistry([source], signer);

  assert.equal(registry.revocations.sequence, 1);
  assert.match(registry.revocations.issuedAt, /^\d{4}-\d{2}-\d{2}T/);

  const later = buildCommunityRegistry([source], signer, {
    revocations: {
      sequence: 7,
      issuedAt: '2026-08-22T00:00:00.000Z',
      entries: [{
        scriptId: 'fixture.read-page',
        version: '1.0.0',
        artifactRef: hash(source.artifactCode),
        reason: 'publisher request',
        revokedAt: '2026-08-22T00:00:00.000Z',
      }],
    },
  });
  assert.equal(later.revocations.sequence, 7);
  assert.equal(later.revocations.revocations.length, 1);
  verifyCommunityRevocations(later.revocations, trustedKeys);
});

test('a revocation feed without a usable sequence or issue time is refused', async () => {
  const source = await loadCommunitySource(fixtureDir);
  const registry = buildCommunityRegistry([source], signer);

  for (const [field, wrong] of [['sequence', 0], ['sequence', 1.5], ['issuedAt', 'yesterday']]) {
    assert.throws(
      () => verifyCommunityRevocations(resign(changed(registry.revocations, (copy) => {
        copy[field] = wrong;
      })), trustedKeys),
      new RegExp(`revocations\\.${field}`),
    );
  }
  assert.throws(
    () => verifyCommunityRevocations(resign(changed(registry.revocations, (copy) => {
      delete copy.sequence;
    })), trustedKeys),
    /revocations is missing key: sequence/,
  );
});
