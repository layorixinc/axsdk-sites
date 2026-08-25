import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, Script } from 'node:vm';

const TOP_LEVEL = ['schemaVersion', 'artifactPath', 'script', 'execution', 'commands', 'disclosures', 'release', 'review'];
const TOP_LEVEL_OPTIONAL = ['network'];
const NETWORK_HOST = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const SCRIPT = ['id', 'name', 'summary', 'version', 'publisherId', 'sourceUrl', 'license'];
const EXECUTION = ['matches', 'runAt', 'world', 'autorun', 'minimumChromeVersion', 'minimumRuntimeVersion'];
const COMMAND_REQUIRED = ['name', 'description', 'inputSchema', 'effect', 'requiresUserConfirmation'];
const COMMAND_OPTIONAL = ['outputSchema'];
const DISCLOSURES = ['pageData', 'localStorage', 'backendData', 'modelData'];
const RELEASE_REQUIRED = ['publishedAt', 'changelog'];
const REVIEW = ['status', 'reviewerId', 'reviewedAt'];
const PUBLISHED_MANIFEST = ['schemaVersion', 'script', 'execution', 'commands', 'disclosures', 'release', 'review', 'artifact', 'signatures'];
const PUBLISHED_OPTIONAL = ['network'];
const ARTIFACT = ['ref', 'bytes', 'mediaType'];
const SIGNATURE = ['keyId', 'algorithm', 'value'];
const INDEX = ['schemaVersion', 'releases', 'signatures'];
const INDEX_RELEASE = ['scriptId', 'name', 'summary', 'version', 'manifestPath', 'artifactRef', 'matches', 'commands'];
const INDEX_COMMAND = ['name', 'description', 'effect'];
const REVOCATIONS = ['schemaVersion', 'sequence', 'issuedAt', 'revocations', 'signatures'];
const REVOCATION = ['scriptId', 'version', 'artifactRef', 'reason', 'revokedAt'];
const MAX_ARTIFACT_BYTES = 256 * 1024;
const EFFECTS = new Set(['read', 'page_write', 'external_send', 'cart_mutation']);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const COMMUNITY_VECTOR_PATH = fileURLToPath(new URL(
  '../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/community/testdata/registry-vector.json',
  import.meta.url,
));
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SOURCE = [
  /\beval\s*\(/,
  /\b(?:new\s+)?Function\s*\(/,
  /\bimport\s*\(/,
  /\bWebAssembly\s*\.\s*(?:compile|instantiate)\s*\(/,
  /\bcreateElement\s*\(\s*['"]script['"]\s*\)/,
  /<script\b/i,
];

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function closed(value, required, optional, path) {
  const object = record(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${path} has unknown key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new Error(`${path} is missing key: ${key}`);
  }
  return object;
}

function text(value, path, pattern) {
  if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) {
    throw new Error(`${path} is invalid`);
  }
  return value;
}

function exact(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${String(expected)}`);
}

function stringList(value, path, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new Error(`${path} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${path} must not contain duplicates`);
  return value;
}

function approvedMatch(pattern) {
  if (typeof pattern !== 'string' || pattern === '<all_urls>'
    || pattern === 'http://*/*' || pattern === 'https://*/*') {
    throw new Error(`execution.matches must contain only approved HTTP(S) match patterns: ${String(pattern)}`);
  }
  const hostPattern = /^(https?):\/\/([^/]+)\/(.*)$/.exec(pattern)?.[2];
  if (!hostPattern || hostPattern === '*' || hostPattern.includes('@') || hostPattern.includes(':')) {
    throw new Error(`execution.matches must contain only approved HTTP(S) match patterns: ${pattern}`);
  }
  const host = hostPattern.replace(/^\*\./, '');
  if (host === '' || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error(`execution.matches must contain only approved HTTP(S) match patterns: ${pattern}`);
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot encode a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = record(value, 'canonical JSON value');
    return `{${Object.keys(object).sort().map((key) => {
      const entry = object[key];
      if (entry === undefined) throw new Error(`canonical JSON cannot encode undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    }).join(',')}}`;
  }
  throw new Error(`canonical JSON cannot encode ${typeof value}`);
}

function registeredCommands(artifactCode) {
  let definition;
  const runtime = Object.freeze({
    register(value) {
      if (definition !== undefined) throw new Error('artifact registers commands more than once');
      definition = value;
    },
  });
  const context = createContext({ AXSDK: runtime }, {
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    new Script(artifactCode, { filename: 'community-artifact.js' }).runInContext(context, { timeout: 100 });
  } catch (error) {
    throw new Error(`community artifact cannot register safely: ${error instanceof Error ? error.message : String(error)}`);
  }
  const commands = record(record(definition, 'artifact registration').commands, 'artifact registration.commands');
  const names = Object.keys(commands).sort();
  if (names.length === 0 || names.some((name) => !IDENTIFIER.test(name) || typeof commands[name] !== 'function')) {
    throw new Error('artifact registration must contain named command functions');
  }
  return names;
}

function validateSchema(value, path) {
  const schema = record(value, path);
  const encoded = canonicalJson(schema);
  if (encoded.includes('"$ref"')) throw new Error(`${path} must not contain $ref`);
  if (schema.type === undefined) throw new Error(`${path}.type is required`);
}

export function validateCommunitySource(input, artifactCode) {
  const source = closed(input, TOP_LEVEL, TOP_LEVEL_OPTIONAL, 'community source');
  exact(source.schemaVersion, 1, 'schemaVersion');
  text(source.artifactPath, 'artifactPath');
  if (source.artifactPath !== basename(source.artifactPath) || !source.artifactPath.endsWith('.js')) {
    throw new Error('artifactPath must name one local JavaScript file');
  }

  const script = closed(source.script, SCRIPT, [], 'script');
  text(script.id, 'script.id', IDENTIFIER);
  text(script.name, 'script.name');
  text(script.summary, 'script.summary');
  text(script.version, 'script.version', VERSION);
  text(script.publisherId, 'script.publisherId', IDENTIFIER);
  text(script.sourceUrl, 'script.sourceUrl');
  let sourceUrl;
  try { sourceUrl = new URL(script.sourceUrl); } catch { throw new Error('script.sourceUrl must be a valid HTTPS URL'); }
  if (sourceUrl.protocol !== 'https:') throw new Error('script.sourceUrl must be a valid HTTPS URL');
  text(script.license, 'script.license');

  const execution = closed(source.execution, EXECUTION, [], 'execution');
  for (const match of stringList(execution.matches, 'execution.matches', { allowEmpty: false })) approvedMatch(match);
  exact(execution.runAt, 'document_idle', 'execution.runAt');
  exact(execution.world, 'USER_SCRIPT', 'execution.world');
  exact(execution.autorun, false, 'execution.autorun');
  exact(execution.minimumChromeVersion, 138, 'execution.minimumChromeVersion');
  exact(execution.minimumRuntimeVersion, 1, 'execution.minimumRuntimeVersion');

  if (!Array.isArray(source.commands) || source.commands.length === 0) throw new Error('commands must be a non-empty array');
  const manifestCommands = [];
  for (const [index, entry] of source.commands.entries()) {
    const command = closed(entry, COMMAND_REQUIRED, COMMAND_OPTIONAL, `commands.${index}`);
    manifestCommands.push(text(command.name, `commands.${index}.name`, IDENTIFIER));
    text(command.description, `commands.${index}.description`);
    validateSchema(command.inputSchema, `commands.${index}.inputSchema`);
    if (command.outputSchema !== undefined) validateSchema(command.outputSchema, `commands.${index}.outputSchema`);
    if (!EFFECTS.has(command.effect)) throw new Error(`commands.${index}.effect is invalid`);
    if (typeof command.requiresUserConfirmation !== 'boolean') {
      throw new Error(`commands.${index}.requiresUserConfirmation must be boolean`);
    }
    if ((command.effect === 'external_send' || command.effect === 'cart_mutation')
      && command.requiresUserConfirmation !== true) {
      throw new Error(`${command.effect} requires user confirmation`);
    }
  }
  if (new Set(manifestCommands).size !== manifestCommands.length) throw new Error('command names must be unique');

  // Optional, and absence means no egress: a release that declares no host reaches none. The hosts
  // are the `@connect` analogue — reviewed here, and separately approved by the user at install.
  if (source.network !== undefined) {
    const network = closed(source.network, ['hosts'], [], 'network');
    for (const host of stringList(network.hosts, 'network.hosts', { allowEmpty: false })) {
      if (!NETWORK_HOST.test(host)) throw new Error(`network.hosts must name concrete hosts: ${host}`);
    }
  }

  const disclosures = closed(source.disclosures, DISCLOSURES, [], 'disclosures');
  for (const field of DISCLOSURES) stringList(disclosures[field], `disclosures.${field}`);

  const release = closed(source.release, RELEASE_REQUIRED, ['previousVersion'], 'release');
  text(release.publishedAt, 'release.publishedAt');
  if (Number.isNaN(Date.parse(release.publishedAt))) throw new Error('release.publishedAt must be an ISO timestamp');
  text(release.changelog, 'release.changelog');
  if (release.previousVersion !== undefined) text(release.previousVersion, 'release.previousVersion', VERSION);

  const review = closed(source.review, REVIEW, [], 'review');
  exact(review.status, 'approved', 'review.status');
  text(review.reviewerId, 'review.reviewerId', IDENTIFIER);
  text(review.reviewedAt, 'review.reviewedAt');
  if (Number.isNaN(Date.parse(review.reviewedAt))) throw new Error('review.reviewedAt must be an ISO timestamp');

  text(artifactCode, 'artifactCode');
  if (Buffer.byteLength(artifactCode) > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifactCode exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  for (const pattern of FORBIDDEN_SOURCE) {
    if (pattern.test(artifactCode)) throw new Error(`artifact contains forbidden executable loading construct: ${pattern.source}`);
  }
  const observed = registeredCommands(artifactCode);
  const declared = [...manifestCommands].sort();
  if (canonicalJson(observed) !== canonicalJson(declared)) {
    throw new Error(`registered commands do not match the manifest: declared ${declared.join(', ')}, observed ${observed.join(', ')}`);
  }
  return observed;
}

export async function loadCommunitySource(directory) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`community manifest is unreadable in ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const artifactPath = text(manifest?.artifactPath, 'artifactPath');
  if (artifactPath !== basename(artifactPath)) throw new Error('artifactPath must stay inside its release directory');
  let artifactCode;
  try {
    artifactCode = await readFile(join(directory, artifactPath), 'utf8');
  } catch (error) {
    throw new Error(`community artifact is unreadable in ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const commands = validateCommunitySource(manifest, artifactCode);
  return { manifest, artifactCode, registeredCommands: commands };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function signedObject(body, signer) {
  text(signer?.keyId, 'signer.keyId', IDENTIFIER);
  if (!signer.privateKey) throw new Error('signer.privateKey is required');
  const signature = signBytes(null, Buffer.from(canonicalJson(body)), signer.privateKey).toString('base64url');
  return {
    ...body,
    signatures: [{ keyId: signer.keyId, algorithm: 'Ed25519', value: signature }],
  };
}

export function compileCommunityRelease(source, signer) {
  const commands = validateCommunitySource(source.manifest, source.artifactCode);
  const { artifactPath: _artifactPath, ...manifestSource } = source.manifest;
  const body = {
    ...manifestSource,
    artifact: {
      ref: sha256(source.artifactCode),
      bytes: Buffer.byteLength(source.artifactCode),
      mediaType: 'application/javascript',
    },
  };
  return {
    manifest: signedObject(body, signer),
    artifactCode: source.artifactCode,
    registeredCommands: commands,
  };
}

function verifySignedObject(document, trustedKeys, label) {
  if (!Array.isArray(document.signatures) || document.signatures.length === 0) {
    throw new Error(`${label} signature is missing`);
  }
  const { signatures, ...body } = document;
  const bytes = Buffer.from(canonicalJson(body));
  const valid = signatures.some((entry, index) => {
    const signature = closed(entry, SIGNATURE, [], `${label}.signatures.${index}`);
    if (signature.algorithm !== 'Ed25519' || typeof signature.value !== 'string') return false;
    const key = trustedKeys.get(signature.keyId);
    return key ? verifyBytes(null, bytes, key, Buffer.from(signature.value, 'base64url')) : false;
  });
  if (!valid) throw new Error(`${label} signature is invalid`);
}

export function verifyCommunityRelease(manifest, artifactCode, trustedKeys) {
  const published = closed(manifest, PUBLISHED_MANIFEST, PUBLISHED_OPTIONAL, 'published manifest');
  const artifact = closed(published.artifact, ARTIFACT, [], 'artifact');
  if (!DIGEST.test(artifact.ref) || artifact.ref !== sha256(artifactCode)) throw new Error('artifact digest mismatch');
  if (artifact.bytes !== Buffer.byteLength(artifactCode)) throw new Error('artifact byte count mismatch');
  if (artifact.mediaType !== 'application/javascript') throw new Error('artifact media type mismatch');
  verifySignedObject(published, trustedKeys, 'manifest');
  const { artifact: _artifact, signatures: _signatures, ...sourceFields } = published;
  validateCommunitySource({ ...sourceFields, artifactPath: 'artifact.js' }, artifactCode);
  return true;
}

export function verifyCommunityRegistryIndex(index, trustedKeys) {
  const document = closed(index, INDEX, [], 'registry index');
  exact(document.schemaVersion, 1, 'registry index.schemaVersion');
  if (!Array.isArray(document.releases)) throw new Error('registry index.releases must be an array');
  const identities = [];
  for (const [releaseIndex, entry] of document.releases.entries()) {
    const release = closed(entry, INDEX_RELEASE, [], `registry index.releases.${releaseIndex}`);
    const scriptId = text(release.scriptId, `registry index.releases.${releaseIndex}.scriptId`, IDENTIFIER);
    const version = text(release.version, `registry index.releases.${releaseIndex}.version`, VERSION);
    identities.push(`${scriptId}@${version}`);
    text(release.name, `registry index.releases.${releaseIndex}.name`);
    text(release.summary, `registry index.releases.${releaseIndex}.summary`);
    text(release.manifestPath, `registry index.releases.${releaseIndex}.manifestPath`);
    if (release.manifestPath !== `scripts/${scriptId}/${version}/manifest.json`) {
      throw new Error(`registry index.releases.${releaseIndex}.manifestPath is not derived from its identity`);
    }
    text(release.artifactRef, `registry index.releases.${releaseIndex}.artifactRef`, DIGEST);
    for (const match of stringList(release.matches, `registry index.releases.${releaseIndex}.matches`, { allowEmpty: false })) approvedMatch(match);
    if (!Array.isArray(release.commands) || release.commands.length === 0) {
      throw new Error(`registry index.releases.${releaseIndex}.commands must be a non-empty array`);
    }
    for (const [commandIndex, entryCommand] of release.commands.entries()) {
      const command = closed(entryCommand, INDEX_COMMAND, [], `registry index.releases.${releaseIndex}.commands.${commandIndex}`);
      text(command.name, `registry index.releases.${releaseIndex}.commands.${commandIndex}.name`, IDENTIFIER);
      text(command.description, `registry index.releases.${releaseIndex}.commands.${commandIndex}.description`);
      if (!EFFECTS.has(command.effect)) throw new Error(`registry index.releases.${releaseIndex}.commands.${commandIndex}.effect is invalid`);
    }
  }
  if (new Set(identities).size !== identities.length) throw new Error('registry index release identities must be unique');
  verifySignedObject(document, trustedKeys, 'registry index');
  return true;
}

export function verifyCommunityRevocations(input, trustedKeys) {
  const document = closed(input, REVOCATIONS, [], 'revocations');
  exact(document.schemaVersion, 1, 'revocations.schemaVersion');
  // A signed feed with no ordering can be replayed by any host: an old document that revokes nothing
  // verifies perfectly. The sequence is what lets a client refuse to move backwards.
  if (typeof document.sequence !== 'number' || !Number.isInteger(document.sequence) || document.sequence < 1) {
    throw new Error('revocations.sequence must be a positive integer');
  }
  text(document.issuedAt, 'revocations.issuedAt');
  if (Number.isNaN(Date.parse(document.issuedAt))) throw new Error('revocations.issuedAt must be an ISO timestamp');
  if (!Array.isArray(document.revocations)) throw new Error('revocations.revocations must be an array');
  for (const [index, entry] of document.revocations.entries()) {
    const revocation = closed(entry, REVOCATION, [], `revocations.revocations.${index}`);
    text(revocation.scriptId, `revocations.revocations.${index}.scriptId`, IDENTIFIER);
    text(revocation.version, `revocations.revocations.${index}.version`, VERSION);
    text(revocation.artifactRef, `revocations.revocations.${index}.artifactRef`, DIGEST);
    text(revocation.reason, `revocations.revocations.${index}.reason`);
    text(revocation.revokedAt, `revocations.revocations.${index}.revokedAt`);
    if (Number.isNaN(Date.parse(revocation.revokedAt))) {
      throw new Error(`revocations.revocations.${index}.revokedAt must be an ISO timestamp`);
    }
  }
  verifySignedObject(document, trustedKeys, 'revocations');
  return true;
}

export function buildCommunityRegistry(sources, signer, options = {}) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('registry requires at least one reviewed source');
  const compiled = sources.map((source) => compileCommunityRelease(source, signer))
    .sort((left, right) => `${left.manifest.script.id}@${left.manifest.script.version}`
      .localeCompare(`${right.manifest.script.id}@${right.manifest.script.version}`));
  const identities = compiled.map(({ manifest }) => `${manifest.script.id}@${manifest.script.version}`);
  if (new Set(identities).size !== identities.length) throw new Error('registry release identities must be unique');

  const files = {};
  const releases = [];
  for (const entry of compiled) {
    const { manifest, artifactCode } = entry;
    const artifactHex = manifest.artifact.ref.slice('sha256:'.length);
    const assetPath = `assets/${artifactHex}.js`;
    const manifestPath = `scripts/${manifest.script.id}/${manifest.script.version}/manifest.json`;
    if (files[assetPath] !== undefined && files[assetPath] !== artifactCode) {
      throw new Error(`content address collision at ${assetPath}`);
    }
    files[assetPath] = artifactCode;
    files[manifestPath] = `${canonicalJson(manifest)}\n`;
    releases.push({
      scriptId: manifest.script.id,
      name: manifest.script.name,
      summary: manifest.script.summary,
      version: manifest.script.version,
      manifestPath,
      artifactRef: manifest.artifact.ref,
      matches: manifest.execution.matches,
      commands: manifest.commands.map(({ name, description, effect }) => ({ name, description, effect })),
    });
  }
  const index = signedObject({ schemaVersion: 1, releases }, signer);
  const feed = options.revocations ?? {};
  const revocations = signedObject({
    schemaVersion: 1,
    sequence: feed.sequence ?? 1,
    issuedAt: feed.issuedAt ?? '1970-01-01T00:00:00.000Z',
    revocations: feed.entries ?? [],
  }, signer);
  return { index, revocations, files };
}

/**
 * The fixture signing key is DERIVED and PUBLIC on purpose: the extension package carries a
 * committed test vector built with it, so both repositories must be able to reproduce the exact
 * bytes. A production key is never derived and never lives in this repository.
 */
function fixturePrivateKey() {
  const seed = createHash('sha256').update('AXSDK public community-registry fixture key v1').digest();
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
}

/** Raw 32-byte Ed25519 public key, the form WebCrypto imports in the extension. */
function rawPublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64url');
}

export const COMMUNITY_FIXTURE_KEY_ID = 'fixture-registry-v1';

/** The committed cross-repository test vector: exact signed bytes plus its public trust root. */
export async function buildCommunityRegistryVector() {
  const fixtureDir = fileURLToPath(new URL('../fixtures/community/read-page/', import.meta.url));
  const source = await loadCommunitySource(fixtureDir);
  const privateKey = fixturePrivateKey();
  const signer = { keyId: COMMUNITY_FIXTURE_KEY_ID, privateKey };
  const registry = buildCommunityRegistry([source], signer);
  const trustedKeys = new Map([[signer.keyId, createPublicKey(privateKey)]]);
  const manifestPath = `scripts/${source.manifest.script.id}/${source.manifest.script.version}/manifest.json`;
  verifyCommunityRelease(JSON.parse(registry.files[manifestPath]), source.artifactCode, trustedKeys);
  verifyCommunityRegistryIndex(registry.index, trustedKeys);
  verifyCommunityRevocations(registry.revocations, trustedKeys);
  return {
    trustedKeys: {
      schemaVersion: 1,
      keys: [{
        keyId: signer.keyId,
        algorithm: 'Ed25519',
        publicKey: rawPublicKey(privateKey),
      }],
    },
    index: `${canonicalJson(registry.index)}\n`,
    revocations: `${canonicalJson(registry.revocations)}\n`,
    files: registry.files,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const mode = process.argv[2];
  const vectorArg = process.argv[3];
  if (process.argv.length < 3 || (mode !== '--check' && mode !== '--emit-vector')) {
    throw new Error('usage: node tools/community-registry.mjs --check | --emit-vector [path]');
  }
  const fixtureDir = fileURLToPath(new URL('../fixtures/community/read-page/', import.meta.url));
  const source = await loadCommunitySource(fixtureDir);
  const first = await buildCommunityRegistryVector();
  const second = await buildCommunityRegistryVector();
  if (canonicalJson(first) !== canonicalJson(second)) throw new Error('community registry build is nondeterministic');
  const manifestPath = `scripts/${source.manifest.script.id}/${source.manifest.script.version}/manifest.json`;
  const manifest = JSON.parse(first.files[manifestPath]);
  if (mode === '--emit-vector') {
    const target = vectorArg ?? COMMUNITY_VECTOR_PATH;
    await writeFile(target, `${JSON.stringify(first, null, 2)}\n`, 'utf8');
    console.log(`COMMUNITY REGISTRY VECTOR → ${target}`);
  }
  console.log(`COMMUNITY REGISTRY PASS ${manifest.script.id}@${manifest.script.version} ${manifest.artifact.ref}`);
}
