// Audits `execute.rpc.allow` against what a flow tool's Lua actually calls.
//
// The runtime refuses a disallowed op one op at a time, mid-run, on a live page — so both mistakes the
// platform authoring guide warns about are worth catching in CI instead. They are mechanical: a wait
// helper is not a wire op, and a grant nobody uses is privilege nobody asked for.

/** Wire ops, mirrored from a live `GET /axsdk/v2/lua/ops` (version `sha256:0bb4bf33418e`). */
export const OPS = [
  'nav.navigate',
  'nav.reload',
  'dom.get_location_href',
  'dom.exists',
  'dom.get_text',
  'dom.get_attr',
  'dom.get_innerHTML',
  'dom.get_outerHTML',
  'dom.query_all',
  'dom.click',
  'dom.set_value',
  'dom.get_form_field_names',
  'dom.get_form_field_value',
  'dom.set_form_field_value',
  'dom.submit_form',
  'page.eval',
];

/**
 * Helpers the runtime prelude synthesises by polling a real op. Calling them is fine and encouraged;
 * naming them in `allow` grants nothing, and the poll underneath is then refused.
 */
export const COMPOSED = {
  'dom.wait_for_selector': 'dom.exists',
  'nav.wait_for_navigation': 'dom.get_location_href',
};

const CALL = /\b(dom|nav|page)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/** Every op a script needs granted: what it calls, with composed helpers resolved to the op they poll. */
function requiredOps(lua) {
  const needed = new Set();
  for (const [, namespace, fn] of String(lua ?? '').matchAll(CALL)) {
    const called = `${namespace}.${fn}`;
    const polled = COMPOSED[called];
    if (polled) needed.add(polled);
    else if (OPS.includes(called)) needed.add(called);
  }
  return needed;
}

/**
 * @param {object} doc                     parsed flow document
 * @param {object} [options]
 * @param {Record<string,string>} [options.moduleSources]  module name → Lua, for tools declaring `modules:`
 * @returns {{ tool: string, code: string, op: string, polls?: string }[]}
 */
export function auditRpcAllow(doc, { moduleSources } = {}) {
  const issues = [];

  for (const [tool, definition] of Object.entries(doc?.flowTools ?? {})) {
    const execute = definition?.execute;
    const rpc = execute?.rpc;
    if (!rpc || !Array.isArray(rpc.allow)) continue;

    // A tool that declares modules keeps its ops there, not in the inline entry point. Auditing the
    // script alone would call every real grant unused — advice in exactly the wrong direction.
    const declared = Array.isArray(execute.modules) ? execute.modules : [];
    const missing = declared.filter((name) => typeof moduleSources?.[name] !== 'string');
    if (missing.length) {
      for (const name of missing) issues.push({ tool, code: 'module_source_missing', op: name });
      continue;
    }

    const sources = [execute.lua, ...declared.map((name) => moduleSources[name])];
    const granted = new Set(rpc.allow);
    const needed = new Set();
    for (const source of sources) for (const op of requiredOps(source)) needed.add(op);

    for (const op of rpc.allow) {
      const polls = COMPOSED[op];
      if (polls) issues.push({ tool, code: 'composed_helper_in_allow', op, polls });
      else if (!OPS.includes(op)) issues.push({ tool, code: 'unknown_op', op });
    }
    for (const op of needed) {
      if (!granted.has(op)) issues.push({ tool, code: 'op_not_allowed', op });
    }
    for (const op of rpc.allow) {
      if (!COMPOSED[op] && OPS.includes(op) && !needed.has(op)) issues.push({ tool, code: 'unused_grant', op });
    }
  }

  return issues;
}
