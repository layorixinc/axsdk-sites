import { resolve } from 'node:path';

import { DEFAULTS, resolveOptions } from '../harness/cdp.mjs';

export const PLAYGROUND_PORT = 9235;
export const PLAYGROUND_HOME = 'https://axsdk.ai/';
export const PLAYGROUND_PROFILE = `${process.env.LOCALAPPDATA || ''}/AXSDKPlaygroundChromeProfile`;

const TOP_LEVEL_COMMANDS = new Set(['repl', 'sync', 'status', 'reset', 'init', 'setup', 'help']);

function expandWindowsEnvironment(path) {
  return String(path).replace(/%([^%]+)%/g, (whole, key) => process.env[key] ?? whole);
}

function normalizedPath(path) {
  return resolve(expandWindowsEnvironment(path)).replace(/\\/g, '/').toLowerCase();
}

function parseFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function parseJson(value) {
  if (value === undefined || value === '') return {};
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON arguments: ${error.message}`);
  }
}

function parseAxInvocation(body, kind) {
  const separator = body.indexOf(' ');
  const command = (separator === -1 ? body : body.slice(0, separator)).trim();
  const rawArgs = separator === -1 ? '' : body.slice(separator + 1).trim();
  if (!/^AX_[A-Za-z0-9_]+$/.test(command)) {
    throw new Error(`${kind === 'call' ? '.call' : '.run'} requires an AX_* command`);
  }
  return { kind, command, args: parseJson(rawArgs) };
}

export function parseCliArguments(argv) {
  const flags = {};
  const positionals = [];
  for (const arg of argv) {
    if (arg === '--no-launch') flags.launch = false;
    else if (arg === '--no-sync') flags.sync = false;
    else if (arg === '--adopt') flags.adopt = true;
    else if (arg === '--allow-shared-profile') flags.allowSharedProfile = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--root=')) flags.root = arg.slice('--root='.length);
    else if (arg.startsWith('--port=')) flags.port = parseFiniteNumber(arg.slice('--port='.length), '--port');
    else if (arg.startsWith('--cdp=')) flags.cdp = arg.slice('--cdp='.length);
    else if (arg.startsWith('--profile=')) flags.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--chrome=')) flags.chrome = arg.slice('--chrome='.length);
    else if (arg.startsWith('--extension=')) flags.extensionPath = arg.slice('--extension='.length);
    else if (arg.startsWith('--extension-id=')) flags.extensionId = arg.slice('--extension-id='.length);
    else if (arg.startsWith('--home=')) flags.home = arg.slice('--home='.length);
    else if (arg.startsWith('--match=')) flags.match = arg.slice('--match='.length);
    else if (arg.startsWith('--timeout=')) flags.timeout = parseFiniteNumber(arg.slice('--timeout='.length), '--timeout');
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    else positionals.push(arg);
  }

  const command = flags.help ? 'help' : (positionals.shift() ?? 'repl');
  if (!TOP_LEVEL_COMMANDS.has(command)) throw new Error(`Unknown command: ${command}`);
  return { command, positionals, flags };
}

export function resolvePlaygroundOptions(flags = {}) {
  const port = flags.port ?? PLAYGROUND_PORT;
  const profile = flags.profile ?? PLAYGROUND_PROFILE;
  const home = flags.home ?? PLAYGROUND_HOME;
  if (!/^https:\/\//.test(home)) throw new Error('Playground home must be an HTTPS URL');
  const liveProfile = normalizedPath(DEFAULTS.profile);
  const selectedProfile = normalizedPath(profile);
  const cdpPortIsLive = flags.cdp ? /:\/\/[^/]+:9224(?:\/|$)/.test(flags.cdp) : false;
  if (!flags.allowSharedProfile && (port === DEFAULTS.port || cdpPortIsLive)) {
    throw new Error(`Refusing live-harness port ${DEFAULTS.port}; pass --allow-shared-profile to override`);
  }
  if (!flags.allowSharedProfile && selectedProfile === liveProfile) {
    throw new Error('Refusing live-harness profile; pass --allow-shared-profile to override');
  }

  const root = resolve(flags.root ?? process.cwd());
  const overrides = { port, profile };
  for (const [key, value] of Object.entries({
    chrome: flags.chrome,
    extensionPath: flags.extensionPath,
    extensionId: flags.extensionId,
    cdp: flags.cdp,
    match: flags.match,
  })) {
    if (value !== undefined) overrides[key] = value;
  }
  const options = resolveOptions(overrides);
  return {
    ...options,
    root,
    home,
    timeout: flags.timeout ?? 60000,
    launch: flags.launch !== false,
    sync: flags.sync !== false,
    adopt: flags.adopt === true,
    allowSharedProfile: flags.allowSharedProfile === true,
    yes: flags.yes === true,
  };
}

export function parseReplInput(line) {
  const text = String(line).trim();
  if (!text) return { kind: 'empty' };
  if (text === '.reload' || text === '.sync') return { kind: 'sync' };
  if (text === '.ext-reload') return { kind: 'extension-reload' };
  if (text === '.page-reload') return { kind: 'page-reload' };
  if (text === '.home') return { kind: 'home' };
  if (text === '.page') return { kind: 'page' };
  if (text === '.ls') return { kind: 'list' };
  if (text === '.status') return { kind: 'status' };
  if (text === '.sources') return { kind: 'sources' };
  if (text === '.clear') return { kind: 'reset' };
  if (text === '.stop') return { kind: 'stop' };
  if (text === '.quit' || text === '.exit') return { kind: 'quit' };
  if (text === '.help') return { kind: 'help' };

  if (text.startsWith('.open ')) {
    const url = text.slice('.open '.length).trim();
    if (!/^https?:\/\//.test(url)) throw new Error('.open requires an HTTP(S) URL');
    return { kind: 'open', url };
  }
  if (text.startsWith('.send ')) {
    const value = text.slice('.send '.length).trim();
    if (!value) throw new Error('.send requires message text');
    return { kind: 'send', text: value };
  }
  if (text === '.run' || text.startsWith('.run ')) return parseAxInvocation(text.slice('.run'.length).trim(), 'run');
  if (text === '.call' || text.startsWith('.call ')) return parseAxInvocation(text.slice('.call'.length).trim(), 'call');
  if (text.startsWith('.')) throw new Error(`Unknown REPL command: ${text}`);
  return parseAxInvocation(text, 'run');
}

export const PLAYGROUND_USAGE = `playground — isolated AXSDK local-index runtime

Usage: node tools/playground.mjs [repl|sync|status|reset|init|setup] [flags]

Defaults to repl. It loads index.md, _common, and direct site layers into an isolated Chrome profile.

Commands:
  setup                       Create the isolated profile, open headed Chrome at extensions, and wait for manual extension setup

Flags:
  --root=PATH                 Workspace root (default current directory)
  --port=9235                 Dedicated CDP port
  --profile=PATH              Dedicated Chrome profile
  --chrome=PATH               Chrome executable
  --extension=PATH            Unpacked extension build
  --extension-id=ID           Expected AXSDK extension id
  --home=URL                  HTTPS common-layer home (default https://axsdk.ai/)
  --timeout=MS                Durable command/flow deadline
  --no-launch                 Refuse if dedicated Chrome is not running
  --no-sync                   repl attaches and verifies without writing stores
  --adopt                     Allow a nonempty unstamped dedicated profile once
  --allow-shared-profile      Explicitly bypass live port/profile guard
  --yes                       Confirm top-level reset`;
