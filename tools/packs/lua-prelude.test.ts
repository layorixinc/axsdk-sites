import { afterEach, describe, expect, test } from 'bun:test';

import { installLuaPrelude } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/packs/lua-prelude.ts';
import { LUA_WRAPPER_VERSION, wrapLuaSource } from './wrap-lua.mjs';

type CommandTable = Record<string, (input?: unknown) => unknown>;

const globals = globalThis as Record<string, unknown>;
let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  delete globals.__AXSDK_PACK_REGISTER__;
  delete globals.document;
});

function runSource(source: string, { name = 'test' } = {}): CommandTable {
  let commands: CommandTable | undefined;
  globals.__AXSDK_PACK_REGISTER__ = (value: CommandTable) => { commands = value; };
  dispose ??= installLuaPrelude(globalThis);
  (globals.__AXSDK_LUA_RUN__ as (payload: unknown) => void)({
    wrapper: LUA_WRAPPER_VERSION,
    name,
    source,
  });
  if (commands === undefined) throw new Error('source did not register commands');
  return commands;
}

/** Runs through the REAL wrapped artifact, not a hand-built payload. */
function runWrapped(source: string): CommandTable {
  let commands: CommandTable | undefined;
  globals.__AXSDK_PACK_REGISTER__ = (value: CommandTable) => { commands = value; };
  dispose ??= installLuaPrelude(globalThis);
  // eslint-disable-next-line no-new-func
  new Function(wrapLuaSource(source, { name: 'wrapped' }))();
  if (commands === undefined) throw new Error('wrapped artifact did not register commands');
  return commands;
}

describe('Lua prelude execution', () => {
  test('a wrapped artifact registers commands and round-trips values', () => {
    const commands = runWrapped([
      'local function echo(input)',
      '  return { doubled = input.value * 2, tag = input.tag .. "!" }',
      'end',
      'register({ echo = echo })',
      '',
    ].join('\n'));
    expect(Object.keys(commands)).toEqual(['echo']);
    expect(commands.echo({ value: 21, tag: '안녕' })).toEqual({ doubled: 42, tag: '안녕!' });
  });

  test('a wrapper version the prelude does not speak is refused', () => {
    dispose ??= installLuaPrelude(globalThis);
    expect(() => (globals.__AXSDK_LUA_RUN__ as (payload: unknown) => void)({
      wrapper: 'axsdk-lua-wrapper@99',
      name: 'future',
      source: 'register({})',
    })).toThrow('lua_wrapper_unsupported');
  });

  test('the sandbox has no load-family, host, or interop globals', () => {
    const commands = runSource([
      'register({ probe = function()',
      '  return {',
      '    load_type = tostring(load),',
      '    loadfile_type = tostring(loadfile),',
      '    dofile_type = tostring(dofile),',
      '    require_type = tostring(require),',
      '    collectgarbage_type = tostring(collectgarbage),',
      '    io_type = tostring(io),',
      '    os_type = tostring(os),',
      '    debug_type = tostring(debug),',
      '    coroutine_type = tostring(coroutine),',
      '    package_type = tostring(package),',
      '    print_type = tostring(print),',
      '    js_type = tostring(js),',
      '    dump_type = tostring(string.dump),',
      '  }',
      'end })',
    ].join('\n'));
    const probe = commands.probe() as Record<string, string>;
    expect(probe).toEqual({
      load_type: 'nil',
      loadfile_type: 'nil',
      dofile_type: 'nil',
      require_type: 'nil',
      collectgarbage_type: 'nil',
      io_type: 'nil',
      os_type: 'nil',
      debug_type: 'nil',
      coroutine_type: 'nil',
      package_type: 'nil',
      print_type: 'nil',
      js_type: 'nil',
      dump_type: 'nil',
    });
  });

  test('an empty table crosses as an object and json.array marks a real empty list', () => {
    const commands = runSource([
      'register({ shapes = function()',
      '  return { record = {}, list = json.array({}), filled = json.array({ "a" }) }',
      'end })',
    ].join('\n'));
    expect(commands.shapes()).toEqual({ record: {}, list: [], filled: ['a'] });
    expect(Array.isArray((commands.shapes() as any).list)).toBe(true);
    expect(Array.isArray((commands.shapes() as any).record)).toBe(false);
  });

  test('absent Lua fields are absent JS properties, never null padding', () => {
    const commands = runSource([
      'register({ partial = function(input)',
      '  local out = { kept = input.kept }',
      '  if input.include then out.extra = 1 end',
      '  return out',
      'end })',
    ].join('\n'));
    expect(commands.partial({ kept: 'x', include: false })).not.toHaveProperty('extra');
    expect(commands.partial({ kept: 'x', include: true })).toEqual({ kept: 'x', extra: 1 });
  });

  test('a Lua error surfaces as a JS throw carrying the reason', () => {
    const commands = runSource('register({ boom = function() error("provider_result_invalid") end })');
    expect(() => commands.boom()).toThrow('provider_result_invalid');
  });

  test('text, url, and clock helpers behave like the platform', () => {
    const commands = runSource([
      'register({ helpers = function(input)',
      '  local parsed = url.parse(input.href)',
      '  return {',
      '    cleaned = text.clean("  a   b  ", 3),',
      '    terms = json.array(text.terms("Logitech M185!")),',
      '    folded = text.fold("A-B c"),',
      '    target = url.with_params("https://www.amazon.com/s", { { "k", "Logitech M185" } }),',
      '    origin = parsed.origin,',
      '    k = parsed.params.k,',
      '    encoded = url.encode_component("a/b"),',
      '    bad = url.parse("not a url") == nil,',
      '    now_is_number = type(clock.now()) == "number",',
      '  }',
      'end })',
    ].join('\n'));
    expect(commands.helpers({ href: 'https://www.amazon.com/s?k=Logitech+M185&page=2' })).toEqual({
      cleaned: 'a b',
      terms: ['logitech', 'm185'],
      folded: 'a b c',
      target: 'https://www.amazon.com/s?k=Logitech+M185',
      origin: 'https://www.amazon.com',
      k: 'Logitech M185',
      encoded: 'a%2Fb',
      bad: true,
      now_is_number: true,
    });
  });

  test('the dom bridge reads the CURRENT document lazily, scoped to handles', () => {
    const doc = (cards: string[][], next = false) => ({
      querySelector: (selector: string) => selector === 'a.next' && next ? { textContent: 'next' } : null,
      querySelectorAll: (selector: string) => selector === '.card'
        ? cards.map(([id, title]) => ({
          textContent: title,
          getAttribute: (name: string) => name === 'data-id' ? id : null,
          querySelector: (inner: string) => inner === '.title' ? { textContent: title } : null,
        }))
        : [],
    });
    const commands = runSource([
      'register({ read = function()',
      '  local cards = dom.query_all(".card")',
      '  local rows = json.array({})',
      '  for index = 1, #cards do',
      '    rows[index] = {',
      '      id = dom.attr(cards[index], "data-id"),',
      '      title = dom.text(cards[index], ".title"),',
      '    }',
      '  end',
      '  return { rows = rows, has_next = dom.exists("a.next") }',
      'end })',
    ].join('\n'));

    globals.document = doc([['1', 'First']], false);
    expect(commands.read()).toEqual({ rows: [{ id: '1', title: 'First' }], has_next: false });

    globals.document = doc([['2', 'Second'], ['3', 'Third']], true);
    expect(commands.read()).toEqual({
      rows: [{ id: '2', title: 'Second' }, { id: '3', title: 'Third' }],
      has_next: true,
    });
  });

  test('page.href reads the installed document location', () => {
    const commands = runSource('register({ where = function() return { href = page.href() } end })');
    globals.document = { location: { href: 'https://www.amazon.com/s?k=mouse' } };
    expect(commands.where()).toEqual({ href: 'https://www.amazon.com/s?k=mouse' });
    delete globals.document;
    expect(commands.where()).toEqual({ href: '' });
  });

  test('dom.query returns a single handle and dom.attr reads a CHILD attribute with a selector', () => {
    const child = {
      textContent: 'child',
      getAttribute: (name: string) => name === 'href' ? 'https://kmong.com/gig/2' : null,
    };
    globals.document = {
      querySelector: (selector: string) => selector === '.only' ? { textContent: 'found', getAttribute: () => null } : null,
      querySelectorAll: (selector: string) => selector === '.card'
        ? [{
          textContent: 'card',
          getAttribute: (name: string) => name === 'data-id' ? 'card-1' : null,
          querySelector: (inner: string) => inner === 'a' ? child : null,
        }]
        : [],
    };
    const commands = runSource([
      'register({ read = function()',
      '  local only = dom.query(".only")',
      '  local missing = dom.query(".absent")',
      '  local cards = dom.query_all(".card")',
      '  return {',
      '    only_text = only ~= nil and dom.text(only) or "none",',
      '    missing_is_nil = missing == nil,',
      '    own_attr = dom.attr(cards[1], "data-id"),',
      '    child_attr = dom.attr(cards[1], "a", "href"),',
      '    absent_child_attr = dom.attr(cards[1], ".nope", "href") == nil,',
      '  }',
      'end })',
    ].join('\n'));
    expect(commands.read()).toEqual({
      only_text: 'found',
      missing_is_nil: true,
      own_attr: 'card-1',
      child_attr: 'https://kmong.com/gig/2',
      absent_child_attr: true,
    });
  });
});
