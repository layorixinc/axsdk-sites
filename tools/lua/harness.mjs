import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lauxlib, lua, lualib, to_jsstring, to_luastring } from 'fengari';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The commerce layer is seven files that only work together: one `AX_COMMERCE` assembled in filename
 * order, with each file taking what the earlier ones exported. A suite names the LAYER rather than the
 * split so that re-cutting the files — which the module size limit will keep forcing — never edits a
 * test that does not care where the cut fell.
 */
export const COMMERCE_LAYER = [
  '_common/scripts/50_commerce_core.lua',
  '_common/scripts/51_relevance.lua',
  '_common/scripts/52_identity.lua',
  '_common/scripts/53_verify.lua',
  '_common/scripts/54_comparison.lua',
  '_common/scripts/55_offers.lua',
  '_common/scripts/56_store_io.lua',
];

/**
 * Runs repository Lua in-process so deterministic logic can be unit tested without a browser. Values
 * cross the boundary through an explicit marshaller because Lua tables are ambiguous (a table is both
 * array and map) and silent coercion would hide contract bugs.
 *
 * Two kinds of module belong here. **Pure** ones need nothing but this loader. **RPC** ones drive the
 * browser through `dom`/`nav`/`rpc`, which `expose()` installs as JS-backed globals — see
 * `tools/lua/rpc-stub.mjs`, which mirrors the real channel's semantics rather than convenient ones.
 */
export function loadLuaModules(relativePaths, { globals = {} } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  for (const [name, value] of Object.entries(globals)) {
    pushValue(L, value);
    lua.lua_setglobal(L, to_luastring(name));
  }

  for (const relativePath of relativePaths) {
    const source = readFileSync(join(repoRoot, relativePath), 'utf8');
    // The runtime loads each file as its own chunk; wrapping keeps file-local `local` declarations
    // file-scoped exactly like tools/merge-lua.mjs does for the shipped bundle.
    const chunk = `local __chunk = function(...)\n${source}\nend\n__chunk()`;
    if (lauxlib.luaL_dostring(L, to_luastring(chunk)) !== lua.LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      throw new Error(`${relativePath} failed to load: ${message}`);
    }
  }

  /** Loads one extra chunk under the same file scoping. Lua embedded in a flow definition has no file of
   *  its own, and it is exactly the code no live run reports on until its node is reached. */
  function define(source, label = 'inline chunk') {
    const chunk = `local __chunk = function(...)\n${source}\nend\n__chunk()`;
    if (lauxlib.luaL_dostring(L, to_luastring(chunk)) !== lua.LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      throw new Error(`${label} failed to load: ${message}`);
    }
  }

  return {
    define,
    /**
     * Installs JS functions as Lua globals: `{ dom: { get_text(sel) {...} } }` becomes `dom.get_text`.
     * A thrown JS error surfaces as a Lua error, which is what a failing op does on the real channel.
     */
    expose(spec) {
      const pushJsFunction = (fn) => {
        lua.lua_pushcfunction(L, (state) => {
          const argc = lua.lua_gettop(state);
          const args = [];
          for (let i = 1; i <= argc; i += 1) args.push(readValue(state, i));
          let result;
          try {
            result = fn(...args);
          } catch (error) {
            return lauxlib.luaL_error(state, to_luastring(String(error?.message ?? error)));
          }
          pushValue(state, result === undefined ? null : result);
          return 1;
        });
      };
      for (const [namespace, members] of Object.entries(spec)) {
        // A FUNCTION value installs as a callable global — the real runtime's `rpc` is a callable
        // table, and callability (not table-ness) is the property modules may rely on.
        if (typeof members === 'function') {
          pushJsFunction(members);
          lua.lua_setglobal(L, to_luastring(namespace));
          continue;
        }
        lua.lua_createtable(L, 0, Object.keys(members).length);
        for (const [name, fn] of Object.entries(members)) {
          lua.lua_pushcfunction(L, (state) => {
            const argc = lua.lua_gettop(state);
            const args = [];
            for (let i = 1; i <= argc; i += 1) args.push(readValue(state, i));
            let result;
            try {
              result = fn(...args);
            } catch (error) {
              return lauxlib.luaL_error(state, to_luastring(String(error?.message ?? error)));
            }
            pushValue(state, result === undefined ? null : result);
            return 1;
          });
          lua.lua_setfield(L, -2, to_luastring(name));
        }
        lua.lua_setglobal(L, to_luastring(namespace));
      }
    },
    /** Calls `<global>.<method>(...args)` and returns the first result as a plain JS value. */
    call(path, ...args) {
      const segments = path.split('.');
      lua.lua_getglobal(L, to_luastring(segments[0]));
      for (const segment of segments.slice(1)) {
        if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
          throw new Error(`${path} is not reachable: ${segments[0]} is not a table`);
        }
        lua.lua_getfield(L, -1, to_luastring(segment));
        lua.lua_remove(L, -2);
      }
      if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) {
        throw new Error(`${path} is not a function`);
      }
      for (const arg of args) pushValue(L, arg);
      if (lua.lua_pcall(L, args.length, 1, 0) !== lua.LUA_OK) {
        const message = lua.lua_tojsstring(L, -1);
        lua.lua_pop(L, 1);
        throw new Error(`${path} raised: ${message}`);
      }
      const result = readValue(L, -1);
      lua.lua_pop(L, 1);
      return result;
    },
    close() {
      lua.lua_close(L);
    },
  };
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

function readValue(L, index) {
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNIL || type === lua.LUA_TNONE) return null;
  if (type === lua.LUA_TBOOLEAN) return Boolean(lua.lua_toboolean(L, index));
  if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
  if (type !== lua.LUA_TTABLE) return null;

  const absolute = lua.lua_absindex(L, index);
  const length = lua.lua_rawlen(L, absolute);
  if (length > 0) {
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
