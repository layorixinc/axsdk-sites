import { describe, expect, test } from 'bun:test';

import {
  LUA_WRAPPER_VERSION,
  unwrapLuaArtifact,
  validateLuaPackSource,
  verifyLuaArtifact,
  wrapLuaSource,
} from './wrap-lua.mjs';

const SOURCE = 'local function greet(name)\n  return "안녕, " .. name\nend\nregister({ greet = greet })\n';

describe('Lua wrapper emitter', () => {
  test('wrapping is deterministic: same source, same bytes', () => {
    const first = wrapLuaSource(SOURCE, { name: 'greeter' });
    const second = wrapLuaSource(SOURCE, { name: 'greeter' });
    expect(first).toBe(second);
    expect(first).toContain('__AXSDK_LUA_RUN__');
  });

  test('the wrapper carries zero logic beyond the fixed template', () => {
    const artifact = wrapLuaSource(SOURCE, { name: 'greeter' });
    const unwrapped = unwrapLuaArtifact(artifact);
    expect(unwrapped).toEqual({
      wrapper: LUA_WRAPPER_VERSION,
      name: 'greeter',
      source: SOURCE,
    });
  });

  test('verify recomputes the template and accepts only byte-exact wrappers', () => {
    const artifact = wrapLuaSource(SOURCE, { name: 'greeter' });
    expect(verifyLuaArtifact(artifact)).toEqual({ name: 'greeter', source: SOURCE });
  });

  test('a one-byte tamper is refused', () => {
    const artifact = wrapLuaSource(SOURCE, { name: 'greeter' });
    const tampered = `${artifact.slice(0, 40)}${artifact[40] === ' ' ? '\t' : ' '}${artifact.slice(41)}`;
    expect(() => verifyLuaArtifact(tampered)).toThrow('lua_wrapper_drift');
  });

  test('a hand-edited wrapper with an extra statement is refused', () => {
    const artifact = wrapLuaSource(SOURCE, { name: 'greeter' });
    const edited = artifact.replace("'use strict';", "'use strict';\n  fetch('https://evil.example/');");
    expect(edited).not.toBe(artifact);
    expect(() => verifyLuaArtifact(edited)).toThrow('lua_wrapper_drift');
  });

  test('the embedded source survives multibyte text byte-for-byte', () => {
    const korean = 'return { note = "무료배송 · 배송비 미확인" }\n';
    const artifact = wrapLuaSource(korean, { name: 'ko' });
    expect(unwrapLuaArtifact(artifact)?.source).toBe(korean);
  });

  test('load-family and host-escape tokens are refused before review', () => {
    for (const bad of [
      'local f = load("return 1")',
      'loadstring("x")',
      'dofile("x.lua")',
      'loadfile("x.lua")',
      'require "socket"',
      'os.time()',
      'io.read()',
      'debug.getinfo(1)',
      'coroutine.create(function() end)',
      'package.loaded.x = nil',
      'collectgarbage("count")',
      'local e = _ENV',
    ]) {
      expect(() => validateLuaPackSource(bad), bad).toThrow('forbidden_lua_source');
      expect(() => wrapLuaSource(bad, { name: 'bad' }), bad).toThrow('forbidden_lua_source');
    }
  });

  test('innocent identifiers containing forbidden words still pass', () => {
    const fine = 'local payload = { download = true, cost = 1 }\nreturn payload\n';
    expect(validateLuaPackSource(fine)).toBe(fine);
  });

  test('a non-artifact or foreign JS file unwraps to null and fails verification', () => {
    expect(unwrapLuaArtifact('console.log(1);')).toBe(null);
    expect(() => verifyLuaArtifact('console.log(1);')).toThrow('lua_wrapper_missing');
  });

  test('this module mirrors the SDK canonical wrapper byte-for-byte', async () => {
    // Node consumers here cannot import the SDK's .ts, so two implementations exist on purpose.
    // Mirroring is the contract (the build-rpc-sites pattern): same artifact bytes, same refusals.
    const sdk = await import('../../../axsdk-sdk-js/packages/axsdk-packs/src/lua-wrapper.ts');
    expect(sdk.LUA_WRAPPER_VERSION).toBe(LUA_WRAPPER_VERSION);
    for (const [source, name] of [
      [SOURCE, 'greeter'],
      ['return { note = "무료배송 · 배송비 미확인" }\n', 'ko'],
    ] as const) {
      expect(sdk.wrapLuaSource(source, { name })).toBe(wrapLuaSource(source, { name }));
    }
    expect(() => sdk.validateLuaPackSource('os.time()')).toThrow('forbidden_lua_source');
    expect(() => validateLuaPackSource('os.time()')).toThrow('forbidden_lua_source');
    // A drifted artifact is refused identically by both.
    const artifact = wrapLuaSource(SOURCE, { name: 'greeter' });
    const edited = artifact.replace('run(', 'run( ');
    expect(() => sdk.verifyLuaArtifact(edited)).toThrow('lua_wrapper_drift');
    expect(() => verifyLuaArtifact(edited)).toThrow('lua_wrapper_drift');
  });
});
