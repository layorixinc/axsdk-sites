import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLuaModules } from './harness.mjs';

// R26 was refused once and the refusal was right: the runtime's own `sitemap.search` reads the APP
// PACKAGE's sitemap — measured live, that is the extension's own `/`, `/settings`, `/help`. Adopting it
// returned no hits for every bluemoonsoft request and the flow silently fell back to `/front/main`.
//
// `sitemap.search_site` is a different document: the sitemap of the SITE the browser is on, which the
// client holds. That is what "find me the quote page" needs, so this module exists to reach it — and the
// tests below pin the difference that made the first attempt wrong: WHICH document answered.

const load = (expose) => {
  const lua = loadLuaModules(['_common/rpc/72_rpc_sitemap.lua']);
  if (expose) lua.expose(expose);
  return lua;
};

test('a search returns the matching lines and how many there were', () => {
  const lua = load({
    sitemap: {
      // POSITIONAL: `search_site(regex, limit?)`. Passing the client's params object instead answered
      // `bad_params: regex` on a live run — the runtime is what wraps the arguments.
      search_site: (regex) => {
        assert.equal(regex, 'quote');
        return { chunks: ['/quote — Request a quote', '/quote/thanks'], total: 2 };
      },
    },
  });
  const result = lua.call('AX_RPC_SITEMAP.search', { regex: 'quote' });
  lua.close();

  assert.equal(result.next, 'go');
  assert.deepEqual(result.chunks, ['/quote — Request a quote', '/quote/thanks']);
  assert.equal(result.total, 2);
});

test('a limit is passed through, because the answer rides in a prompt', () => {
  let seen = null;
  const lua = load({
    sitemap: { search_site: (regex, limit) => { seen = limit; return { chunks: [], total: 0 }; } },
  });
  lua.call('AX_RPC_SITEMAP.search', { regex: 'product', limit: 5 });
  lua.close();

  assert.equal(seen, 5);
});

test('an empty regex is refused here, not at the client', () => {
  // The op throws `bad_params` on an empty regex. Catching it locally costs no round trip and gives the
  // flow a name it can branch on.
  let called = false;
  const lua = load({ sitemap: { search_site: () => { called = true; return { chunks: [], total: 0 }; } } });
  const result = lua.call('AX_RPC_SITEMAP.search', { regex: '' });
  lua.close();

  assert.equal(result.error, 'missing_regex');
  assert.equal(called, false, 'a refusal we can make ourselves must not cost a round trip');
});

test('no matches is an answer, not an error', () => {
  // An empty sitemap result means the page is not listed, which the caller handles by navigating to a
  // known entry point. Reporting it as a failure would send it down the error branch instead.
  const lua = load({ sitemap: { search_site: () => ({ chunks: [], total: 0 }) } });
  const result = lua.call('AX_RPC_SITEMAP.search', { regex: 'nothing-here' });
  lua.close();

  assert.equal(result.next, 'go');
  assert.deepEqual(result.chunks, {});
  assert.equal(result.total, 0);
});

test('a client without the op is reported with its raw reason', () => {
  // Same lesson as memory: "unavailable" alone cannot separate an op the client never registered from
  // one we called wrongly, and those have opposite fixes.
  const bare = load(null);
  const missing = bare.call('AX_RPC_SITEMAP.search', { regex: 'quote' });
  bare.close();
  assert.equal(missing.error, 'sitemap_op_unavailable');
  assert.match(missing.reason, /no sitemap global/);

  const refusing = load({
    sitemap: {
      search_site: () => { throw new Error('rpc sitemap.search_site failed: command_unresolved'); },
    },
  });
  const unresolved = refusing.call('AX_RPC_SITEMAP.search', { regex: 'quote' });
  refusing.close();
  assert.equal(unresolved.error, 'sitemap_op_unavailable');
  assert.match(unresolved.reason, /command_unresolved/);
});

test('a transient refusal is retried once before it is called an answer', () => {
  // Every dom access in these modules retries once: a refusal while the channel re-attaches is not a
  // fact about the page, and treating it as one reported empty results as real.
  let attempts = 0;
  const lua = load({
    sitemap: {
      search_site: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('rpc_timeout');
        return { chunks: ['/quote'], total: 1 };
      },
    },
  });
  const result = lua.call('AX_RPC_SITEMAP.search', { regex: 'quote' });
  lua.close();

  assert.equal(attempts, 2);
  assert.deepEqual(result.chunks, ['/quote']);
});
