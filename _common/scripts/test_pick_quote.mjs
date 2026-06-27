#!/usr/bin/env node
// Offline unit test for the request_service_quote `pick_quote` flowTool Lua (in _common/flows.yaml).
// pick_quote is deterministic (no DOM / no network): given the candidate list, the loop index, and the
// per-pro signals open_quote/answer_quote/submit_quote wrote for the pro just finished, it records ONE
// summary line for that pro into the newline-joined `quote_results` string and advances the index,
// capping the loop at MAX_OPEN. This test extracts the live snippet from flows.yaml, drives the loop
// with N simulated pros via fengari (the same Lua VM the extension uses), and asserts EVERY attempted
// pro appears in quote_results — the exact behavior the terminal renders.
//
// Usage: node _common/scripts/test_pick_quote.mjs
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOWS_FILE = resolve(__dirname, '..', 'flows.yaml');
// fengari + yaml live in the sibling SDK's node_modules.
const SDK = resolve(__dirname, '..', '..', '..', 'axsdk-sdk-js');
const req = createRequire(import.meta.url);
const RESOLVE_PATHS = [resolve(SDK, 'node_modules'), resolve(SDK, 'packages', 'axsdk-lua', 'node_modules'), resolve(SDK, 'packages', 'axsdk-core', 'node_modules')];
const fengari = req(req.resolve('fengari', { paths: RESOLVE_PATHS }));
const YAML = req(req.resolve('yaml', { paths: RESOLVE_PATHS }));
const { lua, lauxlib, lualib, to_luastring } = fengari;

// --- extract the pick_quote snippet from flows.yaml -------------------------------------------------
function findPickQuoteLua(doc) {
  let found = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object' || found) return;
    const ex = o.execute;
    if (ex && ex.implementation === 'lua' && typeof ex.lua === 'string' && ex.lua.includes('MAX_OPEN')) { found = ex.lua; return; }
    for (const v of Object.values(o)) walk(v);
  };
  walk(doc);
  return found;
}

// --- run one pick_quote call in a fresh Lua VM with the given args ----------------------------------
// Returns { next, quote_index, quote_results, quote_count } read back from the Lua result table.
function runPickQuote(snippet, args) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  // Build the args table in Lua from `args` (scalars + a candidates array of {name, service_id}).
  const candsLua = (args.candidates || [])
    .map((c, i) => `  cands[${i + 1}] = { name = ${q(c.name)}, service_id = ${q(c.service_id)}, url = ${q(c.url || ('https://x/' + c.service_id))} }`)
    .join('\n');
  const idx = args.quote_index === null || args.quote_index === undefined ? 'nil' : String(args.quote_index);

  const program = `
local cands = {}
${candsLua}
local args = {
  candidates = cands,
  quote_index = ${idx},
  quote_results = ${q(args.quote_results ?? '')},
  quote_error = ${q(args.quote_error ?? '')},
  quote_reached_submit = ${args.quote_reached_submit ? 'true' : 'false'},
  quote_answer_status = ${q(args.quote_answer_status ?? '')},
  quote_advance_reason = ${q(args.quote_advance_reason ?? '')},
  quote_submit_status = ${q(args.quote_submit_status ?? '')},
  quote_submit_message = ${q(args.quote_submit_message ?? '')},
  quote_submit_error = ${q(args.quote_submit_error ?? '')},
}
local function pick_quote(args)
${snippet}
end
local r = pick_quote(args)
-- flatten the result into a single string the JS side can parse unambiguously
return string.format("%s\\t%s\\t%s\\t%s",
  tostring(r.next or ""),
  tostring(r.quote_index == nil and "nil" or r.quote_index),
  tostring(r.quote_count == nil and "nil" or r.quote_count),
  tostring(r.quote_results or ""))
`;
  const st = lauxlib.luaL_dostring(L, to_luastring(program));
  if (st !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    throw new Error('Lua error: ' + err);
  }
  const out = lua.lua_tojsstring(L, -1);
  const [next, qi, qc, ...rest] = out.split('\t');
  const quote_results = rest.join('\t');
  return {
    next,
    quote_index: qi === 'nil' ? null : Number(qi),
    quote_count: qc === 'nil' ? null : Number(qc),
    quote_results,
  };
}
function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'; }

// --- drive the full loop the flow runs (pick -> open -> answer -> submit -> pick ...) ---------------
// Each completed pro is simulated as "submitted, popover returned" (the real reserved-phone outcome).
function driveLoop(snippet, candidates, perPro) {
  let state = { quote_index: null, quote_results: '', quote_count: null };
  const calls = [];
  for (let guard = 0; guard < 50; guard++) {
    const signals = perPro(state.quote_index); // signals for the pro just finished (idx)
    const r = runPickQuote(snippet, { candidates, ...state, ...signals });
    calls.push(r);
    state.quote_index = r.quote_index;
    state.quote_results = r.quote_results;
    if (r.next === 'done') { state.quote_count = r.quote_count; return { state, calls }; }
  }
  throw new Error('loop did not terminate (guard hit)');
}

function lines(s) { return String(s || '').split('\n').filter(x => x.trim().length); }
let failures = 0;
function check(name, cond, detail) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!cond) failures++; }

async function main() {
  const doc = YAML.parse(await readFile(FLOWS_FILE, 'utf8'));
  const snippet = findPickQuoteLua(doc);
  if (!snippet) throw new Error('could not find pick_quote lua (execute.implementation=lua, contains MAX_OPEN) in flows.yaml');
  const maxOpen = Number((snippet.match(/MAX_OPEN\s*=\s*(\d+)/) || [])[1]);
  console.log(`pick_quote MAX_OPEN = ${maxOpen}\n`);

  const mkCands = (n) => Array.from({ length: n }, (_, i) => ({ name: `Pro ${i + 1}`, service_id: String(100 + i) }));
  // every finished pro reports the invalid-phone Submit popover (the reserved-test-data outcome)
  const popover = (idx) => idx && idx > 0 ? { quote_submit_message: 'The number entered was invalid. Enter a valid phone number.' } : {};

  // 1) candidates >= MAX_OPEN: attempts exactly MAX_OPEN, and EVERY one is in quote_results.
  {
    const { state } = driveLoop(snippet, mkCands(maxOpen + 4), popover);
    const ls = lines(state.quote_results);
    check(`attempts capped at MAX_OPEN (${maxOpen}) with surplus candidates`, state.quote_count === maxOpen, `quote_count=${state.quote_count}`);
    check(`all ${maxOpen} attempted pros appear in quote_results`, ls.length === maxOpen, `lines=${ls.length}`);
    check(`each line carries name + service_id + Submit popover`, ls.every((l, i) => l.includes(`Pro ${i + 1}`) && l.includes(`[service_id ${100 + i}]`) && l.includes('error popover')), `\n    ${ls.join('\n    ')}`);
  }

  // 2) candidates == MAX_OPEN exactly: all attempted, none dropped.
  {
    const { state } = driveLoop(snippet, mkCands(maxOpen), popover);
    check(`exactly MAX_OPEN candidates -> all ${maxOpen} shown`, lines(state.quote_results).length === maxOpen && state.quote_count === maxOpen, `lines=${lines(state.quote_results).length} count=${state.quote_count}`);
  }

  // 3) fewer candidates than MAX_OPEN: attempts all available (this is the "only 1 of 2" guard).
  {
    const { state } = driveLoop(snippet, mkCands(2), popover);
    const ls = lines(state.quote_results);
    check(`2 candidates -> BOTH attempts shown (not 1)`, ls.length === 2 && state.quote_count === 2, `lines=${ls.length} count=${state.quote_count}\n    ${ls.join('\n    ')}`);
  }

  // 4) mixed outcomes: pro 1 opens but is cut off before submit, pro 2 submits with popover — both recorded.
  {
    const mixed = (idx) => {
      if (!idx || idx <= 0) return {};
      if (idx === 1) return { quote_advance_reason: 'advance_button_not_found' }; // stopped before submit
      return { quote_submit_message: 'The number entered was invalid. Enter a valid phone number.' };
    };
    const { state } = driveLoop(snippet, mkCands(2), mixed);
    const ls = lines(state.quote_results);
    check(`mixed outcomes (stopped + submitted) -> both pros recorded distinctly`,
      ls.length === 2 && /Pro 1.*Stopped before submit/.test(ls[0]) && /Pro 2.*error popover/.test(ls[1]),
      `\n    ${ls.join('\n    ')}`);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
main().catch(e => { console.error('FATAL', e?.stack || e?.message || e); process.exitCode = 1; });
