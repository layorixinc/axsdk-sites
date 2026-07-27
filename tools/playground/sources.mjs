import { createHash } from 'node:crypto';
import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';

export const LOCAL_SITES_INDEX_MAX_BYTES = 256 * 1024;

const RESERVED_DIRECTORIES = new Set([
  '_common',
  'fixtures',
  'dist',
  'tools',
  'node_modules',
]);

const DOMAIN_PATTERN = /^[A-Za-z0-9._-]+$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith('..') && !path.includes(`..${sep}`));
}

function normalizeDomainName(value) {
  return String(value)
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function normalizeHostname(href) {
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

function markdownLinks(line) {
  return [...line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .flatMap((match) => {
      const text = match[1];
      const href = match[2];
      return text && href ? [{ text, href }] : [];
    });
}

/**
 * Parses the current core sites-index line grammar, with stricter preflight failures for data that
 * the runtime could otherwise defer until navigation. The first HTTP(S) link identifies the host;
 * the first non-HTTP(S) link identifies the domain, falling back to the HTTP(S) link text.
 */
export function parseLocalSitesIndex(indexMd) {
  if (typeof indexMd !== 'string') throw new Error('Local sites index must be UTF-8 text');
  const bytes = new TextEncoder().encode(indexMd).length;
  if (bytes > LOCAL_SITES_INDEX_MAX_BYTES) {
    throw new Error(`Local sites index exceeds ${LOCAL_SITES_INDEX_MAX_BYTES} bytes`);
  }

  const byHostname = new Map();
  for (const [lineNumber, line] of indexMd.split(/\r?\n/).entries()) {
    const links = markdownLinks(line);
    const siteLink = links.find((link) => link.href.startsWith('http://') || link.href.startsWith('https://'));
    if (!siteLink) continue;

    const hostname = normalizeHostname(siteLink.href);
    if (!hostname) throw new Error(`Invalid HTTP(S) sites URL on index line ${lineNumber + 1}: ${siteLink.href}`);
    if (hostname === 'axsdk.ai' || hostname.endsWith('.axsdk.ai')) {
      throw new Error(`Local sites index must not map axsdk.ai (line ${lineNumber + 1})`);
    }

    const domainLink = links.find((link) => !link.href.startsWith('http://') && !link.href.startsWith('https://'));
    const domain = normalizeDomainName(domainLink?.href ?? siteLink.text);
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new Error(`Invalid local sites domain on index line ${lineNumber + 1}: ${domain || '<empty>'}`);
    }

    const previous = byHostname.get(hostname);
    if (previous && previous !== domain) {
      throw new Error(`Conflicting hostname mapping for ${hostname}: ${previous} vs ${domain}`);
    }
    byHostname.set(hostname, domain);
  }

  if (byHostname.size === 0) throw new Error('Local sites index has no HTTP(S) hostname entries');
  return [...byHostname.entries()].map(([hostname, domain]) => ({ hostname, domain }));
}

async function pathStat(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function resolveContained(root, candidate, label) {
  const resolved = await realpath(candidate);
  if (!isWithin(root, resolved)) throw new Error(`${label} escapes workspace root`);
  return resolved;
}

async function requireDirectory(root, candidate, label) {
  const info = await pathStat(candidate);
  if (!info?.isDirectory()) throw new Error(`${label} must be a directory`);
  return resolveContained(root, candidate, label);
}

async function readContainedUtf8(root, candidate, label, { required = true } = {}) {
  const info = await pathStat(candidate);
  if (!info) {
    if (!required) return null;
    throw new Error(`${label} is required`);
  }
  if (!info.isFile()) throw new Error(`${label} must be a file`);
  const resolved = await resolveContained(root, candidate, label);
  try {
    return decoder.decode(await readFile(resolved));
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${label} is not valid UTF-8`);
    throw error;
  }
}

function validateYaml(source, label) {
  const document = parseDocument(source, { prettyErrors: true, strict: true });
  if (document.errors.length > 0) {
    throw new Error(`${label} is not valid YAML: ${document.errors.map((error) => error.message).join('; ')}`);
  }
}

function posixRelative(root, file) {
  return relative(root, file).split(sep).join('/');
}

async function discoverLuaFiles(root, layerDirectory, layerName) {
  const scriptsPath = join(layerDirectory, 'scripts');
  const scriptsInfo = await pathStat(scriptsPath);
  if (!scriptsInfo) return [];
  if (!scriptsInfo.isDirectory()) throw new Error(`${layerName}/scripts must be a directory`);
  const scriptsDirectory = await resolveContained(root, scriptsPath, `${layerName}/scripts`);
  const entries = await readdir(scriptsDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) throw new Error(`Nested scripts are not allowed: ${layerName}/scripts/${entry.name}`);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic-link scripts are not allowed: ${layerName}/scripts/${entry.name}`);
    if (!entry.isFile() || !entry.name.endsWith('.lua')) continue;
    const file = join(scriptsDirectory, entry.name);
    const source = await readContainedUtf8(root, file, `${layerName}/scripts/${entry.name}`);
    files.push({
      absolute: file,
      relative: posixRelative(root, file),
      source,
    });
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  return files;
}

function wrapLua(file) {
  const source = file.source.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
  return `-- ===== ${file.relative} =====\n(function(...)\n${source}end)(...);\n`;
}

function bundleLua(name, files) {
  const paths = files.map((file) => file.relative);
  const header =
    '-- AUTO-GENERATED by tools/playground/sources.mjs — DO NOT EDIT.\n'
    + `-- Bundle: ${name}\n`
    + '-- Sources (load order):\n'
    + paths.map((path) => `--   ${path}`).join('\n') + '\n'
    + '-- Each source is wrapped in an immediately-invoked vararg function; cross-file\n'
    + '-- communication is via globals (AX_BASE, AX_<SITE>, AX_*).\n\n';
  return header + files.map(wrapLua).join('\n');
}

function canonicalSitesEnvelope(indexMd, now) {
  return {
    state: {
      index: {
        source: 'local',
        indexUrl: '',
        indexMd,
        loadedAt: now().toISOString(),
        commonFlowsYaml: '',
        commonScripts: [],
        commonWidgets: [],
      },
      sites: {},
    },
    version: 0,
  };
}

function canonicalWidgetsEnvelope() {
  return { state: { widgets: {} }, version: 0 };
}

function canonicalLayerManifest(flows, lua) {
  const keys = [...new Set([...Object.keys(flows), ...Object.keys(lua)])].sort();
  return Object.fromEntries(keys.map((key) => [key, {
    flowsDigest: Object.hasOwn(flows, key) ? sha256(flows[key]) : null,
    luaDigest: Object.hasOwn(lua, key) ? sha256(lua[key]) : null,
  }]));
}

/**
 * Reads an independent layered workspace. It never creates browser state and returns the complete,
 * deterministic source-to-store payload for a later CDP writer.
 */
export async function loadWorkspace(rootPath, { now = () => new Date() } = {}) {
  const rootCandidate = resolve(rootPath);
  const rootInfo = await pathStat(rootCandidate);
  if (!rootInfo?.isDirectory()) throw new Error('Workspace root must be a directory');
  const root = await realpath(rootCandidate);
  const indexMd = await readContainedUtf8(root, join(root, 'index.md'), 'index.md');
  const entries = parseLocalSitesIndex(indexMd);
  const indexedDomains = new Set(entries.map((entry) => entry.domain));

  const commonDirectory = await requireDirectory(root, join(root, '_common'), '_common');
  const commonFlows = await readContainedUtf8(root, join(commonDirectory, 'flows.yaml'), '_common/flows.yaml');
  validateYaml(commonFlows, '_common/flows.yaml');
  const commonLuaFiles = await discoverLuaFiles(root, commonDirectory, '_common');

  const flows = { ':': commonFlows };
  const lua = {};
  if (commonLuaFiles.length > 0) lua[':'] = bundleLua('_common (base)', commonLuaFiles);

  const layerDirectories = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || RESERVED_DIRECTORIES.has(entry.name)) continue;
    if (!entry.isDirectory()) continue;
    if (!DOMAIN_PATTERN.test(entry.name)) throw new Error(`Invalid site layer directory: ${entry.name}`);
    layerDirectories.push(entry.name);
  }
  layerDirectories.sort();

  for (const domain of layerDirectories) {
    const layerDirectory = await requireDirectory(root, join(root, domain), domain);
    const flowsPath = join(layerDirectory, 'flows.yaml');
    const siteFlows = await readContainedUtf8(root, flowsPath, `${domain}/flows.yaml`, { required: false });
    if (siteFlows !== null) validateYaml(siteFlows, `${domain}/flows.yaml`);
    const siteLuaFiles = await discoverLuaFiles(root, layerDirectory, domain);
    if (siteFlows === null && siteLuaFiles.length === 0) continue;
    if (!indexedDomains.has(domain)) {
      throw new Error(`Discovered site layer "${domain}" does not appear in index.md`);
    }
    if (siteFlows !== null) flows[`:${domain}`] = siteFlows;
    if (siteLuaFiles.length > 0) lua[`:${domain}`] = bundleLua(`${domain} (site-only; load after _common)`, siteLuaFiles);
  }

  const sites = canonicalSitesEnvelope(indexMd, now);
  const widgets = canonicalWidgetsEnvelope();
  const layers = canonicalLayerManifest(flows, lua);
  const indexDigest = sha256(indexMd);
  const widgetsDigest = sha256(JSON.stringify(widgets));
  const sourceDigest = sha256(JSON.stringify({ indexDigest, widgetsDigest, layers }));

  return {
    root,
    index: {
      raw: indexMd,
      entries,
      domains: [...indexedDomains].sort(),
    },
    flows,
    lua,
    sites,
    widgets,
    layers,
    indexDigest,
    widgetsDigest,
    sourceDigest,
  };
}
