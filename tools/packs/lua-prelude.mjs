/**
 * Reference implementation of the packaged Lua prelude (`LUA_PACK_DESIGN.md`): the ONE sanctioned
 * interpreter for pack Lua. It installs `__AXSDK_LUA_RUN__`, which executes the Lua embedded in a
 * signed wrapper artifact inside a CLOSED environment — no `load` family, no host libraries, no
 * Fengari `js` interop — so the only Lua that can ever run is the signed artifact's own bytes.
 *
 * The extension bundles its own copy of this contract for the `USER_SCRIPT` world; this module is the
 * repository's executable specification of it, and the offline pack suites run against it with the
 * same interpreter (fengari) the extension ships.
 *
 * Marshaling follows the SDK converter rules the offline Lua harness mirrors: a table with sequence
 * entries is an array, an EMPTY table is an object unless marked by `json.array`, an absent field
 * stays absent, and strings cross as UTF-8.
 */

import { lauxlib, lua, lualib, to_jsstring, to_luastring } from 'fengari';

export const LUA_RUN_GLOBAL = '__AXSDK_LUA_RUN__';
const SUPPORTED_WRAPPER = 'axsdk-lua-wrapper@1';
const ARRAY_MARKER = 'axsdk.pack.array';

/**
 * Globals removed AFTER `luaL_openlibs`: removing is equivalent to never opening for a closed
 * environment, and keeps the remaining base library byte-compatible with the production runtime.
 */
const REMOVED_GLOBALS = [
  'load', 'loadfile', 'dofile', 'require', 'collectgarbage', 'print',
  'io', 'os', 'debug', 'coroutine', 'package', 'arg',
];

export function installLuaPrelude(target = globalThis) {
  const globals = target;
  const run = (payload) => {
    if (payload === null || typeof payload !== 'object'
      || payload.wrapper !== SUPPORTED_WRAPPER) {
      throw new Error(`lua_wrapper_unsupported: expected ${SUPPORTED_WRAPPER}`);
    }
    if (typeof payload.source !== 'string' || typeof payload.name !== 'string') {
      throw new Error('lua_wrapper_payload_invalid');
    }
    executeArtifact(globals, payload);
  };
  globals[LUA_RUN_GLOBAL] = run;
  return () => {
    if (globals[LUA_RUN_GLOBAL] === run) delete globals[LUA_RUN_GLOBAL];
  };
}

function executeArtifact(globals, { name, source }) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  for (const global of REMOVED_GLOBALS) {
    lua.lua_pushnil(L);
    lua.lua_setglobal(L, to_luastring(global));
  }
  // string.dump emits bytecode; harmless without load, removed anyway.
  lua.lua_getglobal(L, to_luastring('string'));
  lua.lua_pushnil(L);
  lua.lua_setfield(L, -2, to_luastring('dump'));
  lua.lua_pop(L, 1);

  // The array marker metatable, shared per state.
  lua.lua_createtable(L, 0, 0);
  lua.lua_setfield(L, lua.LUA_REGISTRYINDEX, to_luastring(ARRAY_MARKER));

  /** Handles are per-invocation element ids; reset before every command call. */
  const elements = [];
  const currentDocument = () => globals.document ?? null;
  const elementOf = (handle) => {
    const element = typeof handle === 'number' ? elements[handle - 1] : undefined;
    if (element === undefined) throw new Error('dom_handle_invalid');
    return element;
  };

  const api = {
    json: {
      encode: (value) => JSON.stringify(value ?? null),
      decode: (textValue) => JSON.parse(String(textValue)),
    },
    clock: {
      now: () => Date.now(),
    },
    text: {
      clean: (value, maximum) => typeof value === 'string'
        ? value.trim().replace(/\s+/g, ' ').slice(0, typeof maximum === 'number' ? maximum : 500)
        : '',
      terms: (value) => typeof value === 'string'
        ? (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        : [],
      fold: (value) => typeof value === 'string'
        ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
        : '',
    },
    url: {
      parse: (href) => {
        let parsed;
        try {
          parsed = new URL(String(href));
        } catch {
          return null;
        }
        const params = {};
        for (const [key, value] of parsed.searchParams) {
          if (!(key in params)) params[key] = value;
        }
        return {
          href: parsed.href,
          origin: parsed.origin,
          protocol: parsed.protocol,
          pathname: parsed.pathname,
          username: parsed.username,
          password: parsed.password,
          search: parsed.search,
          hash: parsed.hash,
          params,
        };
      },
      with_params: (base, entries) => {
        const parsed = new URL(String(base));
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (Array.isArray(entry) && entry.length === 2) {
            parsed.searchParams.set(String(entry[0]), String(entry[1]));
          }
        }
        return parsed.href;
      },
      encode_component: (value) => encodeURIComponent(String(value)),
    },
    page: {
      href: () => String(currentDocument()?.location?.href ?? globals.location?.href ?? ''),
    },
    dom: {
      exists: (selector) => currentDocument()?.querySelector(String(selector)) !== null
        && currentDocument()?.querySelector(String(selector)) !== undefined,
      query_all: (selector) => {
        const found = currentDocument()?.querySelectorAll(String(selector)) ?? [];
        const handles = [];
        for (const element of found) {
          elements.push(element);
          handles.push(elements.length);
        }
        return handles;
      },
      text: (handle, selector) => {
        const element = elementOf(handle);
        if (selector === null || selector === undefined) return String(element.textContent ?? '');
        const child = element.querySelector?.(String(selector));
        return String(child?.textContent ?? '');
      },
      attr: (handle, nameValue) => {
        const value = elementOf(handle).getAttribute?.(String(nameValue));
        return value === null || value === undefined ? null : String(value);
      },
    },
  };

  for (const [namespace, members] of Object.entries(api)) {
    lua.lua_createtable(L, 0, Object.keys(members).length);
    for (const [memberName, fn] of Object.entries(members)) {
      lua.lua_pushcfunction(L, (state) => {
        const argc = lua.lua_gettop(state);
        const args = [];
        for (let index = 1; index <= argc; index += 1) args.push(readValue(state, index));
        let result;
        try {
          result = fn(...args);
        } catch (error) {
          return lauxlib.luaL_error(state, to_luastring(String(error?.message ?? error)));
        }
        pushValue(state, result === undefined ? null : result);
        return 1;
      });
      lua.lua_setfield(L, -2, to_luastring(memberName));
    }
    lua.lua_setglobal(L, to_luastring(namespace));
  }

  // json.array marks a table as an array for the return marshaller — pure Lua-side metatable set.
  lua.lua_getglobal(L, to_luastring('json'));
  lua.lua_pushcfunction(L, (state) => {
    lauxlib.luaL_checktype(state, 1, lua.LUA_TTABLE);
    lua.lua_settop(state, 1);
    lua.lua_getfield(state, lua.LUA_REGISTRYINDEX, to_luastring(ARRAY_MARKER));
    lua.lua_setmetatable(state, 1);
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring('array'));
  lua.lua_pop(L, 1);

  // register(commands): every Lua function becomes a JS command; handles reset per call.
  lua.lua_pushcfunction(L, (state) => {
    lauxlib.luaL_checktype(state, 1, lua.LUA_TTABLE);
    const commands = {};
    lua.lua_pushnil(state);
    while (lua.lua_next(state, 1) !== 0) {
      if (lua.lua_type(state, -2) === lua.LUA_TSTRING && lua.lua_type(state, -1) === lua.LUA_TFUNCTION) {
        const commandName = to_jsstring(lua.lua_tostring(state, -2));
        const ref = lauxlib.luaL_ref(state, lua.LUA_REGISTRYINDEX);
        commands[commandName] = (input) => {
          elements.length = 0;
          lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
          pushValue(L, input === undefined ? null : input);
          if (lua.lua_pcall(L, 1, 1, 0) !== lua.LUA_OK) {
            const message = lua.lua_tojsstring(L, -1);
            lua.lua_pop(L, 1);
            throw new Error(message);
          }
          const result = readValue(L, -1);
          lua.lua_pop(L, 1);
          return result;
        };
        continue;
      }
      lua.lua_pop(state, 1);
    }
    const registerTarget = globals.__AXSDK_PACK_REGISTER__;
    if (typeof registerTarget !== 'function') {
      return lauxlib.luaL_error(state, to_luastring('pack_register_unavailable'));
    }
    registerTarget(commands);
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('register'));

  const chunk = `local __chunk = function(...)\n${source}\nend\n__chunk()`;
  if (lauxlib.luaL_dostring(L, to_luastring(chunk)) !== lua.LUA_OK) {
    const message = lua.lua_tojsstring(L, -1);
    throw new Error(`lua_artifact_failed(${name}): ${message}`);
  }
}

function pushValue(L, value) {
  if (value === null || value === undefined) {
    lua.lua_pushnil(L);
    return;
  }
  if (typeof value === 'boolean') {
    lua.lua_pushboolean(L, value);
    return;
  }
  if (typeof value === 'number') {
    lua.lua_pushnumber(L, value);
    return;
  }
  if (typeof value === 'string') {
    lua.lua_pushstring(L, to_luastring(value));
    return;
  }
  if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((entry, index) => {
      pushValue(L, entry);
      lua.lua_seti(L, -2, index + 1);
    });
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    lua.lua_createtable(L, 0, entries.length);
    for (const [key, entry] of entries) {
      pushValue(L, entry);
      lua.lua_setfield(L, -2, to_luastring(key));
    }
    return;
  }
  throw new Error(`Unsupported argument type: ${typeof value}`);
}

function isMarkedArray(L, absolute) {
  if (!lua.lua_getmetatable(L, absolute)) return false;
  lua.lua_getfield(L, lua.LUA_REGISTRYINDEX, to_luastring(ARRAY_MARKER));
  const marked = lua.lua_rawequal(L, -1, -2) === 1 || lua.lua_rawequal(L, -1, -2) === true;
  lua.lua_pop(L, 2);
  return marked;
}

function readValue(L, index) {
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNIL || type === lua.LUA_TNONE) return null;
  if (type === lua.LUA_TBOOLEAN) return Boolean(lua.lua_toboolean(L, index));
  if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
  if (type !== lua.LUA_TTABLE) return null;

  const absolute = lua.lua_absindex(L, index);
  const length = lua.lua_rawlen(L, absolute);
  if (length > 0 || isMarkedArray(L, absolute)) {
    const list = [];
    for (let position = 1; position <= length; position += 1) {
      lua.lua_geti(L, absolute, position);
      list.push(readValue(L, -1));
      lua.lua_pop(L, 1);
    }
    return list;
  }

  const record = {};
  lua.lua_pushnil(L);
  while (lua.lua_next(L, absolute) !== 0) {
    const key = lua.lua_type(L, -2) === lua.LUA_TSTRING
      ? to_jsstring(lua.lua_tostring(L, -2))
      : String(lua.lua_tonumber(L, -2));
    record[key] = readValue(L, -1);
    lua.lua_pop(L, 1);
  }
  return record;
}
