import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

// The ZIP ladder is layered on purpose, and only its LAST rungs need the network. An explicit ZIP and a ZIP
// embedded in an address are pure string work — which matters here, because outbound HTTP from the runtime
// (R1) is still waiting on infrastructure approval.
//
// So the module answers the two cheap rungs whatever the runtime provides, and says exactly what is missing
// when the geocode is the only thing that could help. Reporting "resolve failed" for "San Francisco, CA"
// when the truth is "this runtime cannot reach a geocoder" sends the user hunting for a better address.

const lua = loadLuaModules(['_common/rpc/71_rpc_zip.lua']);
after(() => lua.close());

const resolve = (args) => lua.call('AX_RPC_ZIP.resolve', args);

test('an explicit ZIP is the answer, with no network at all', () => {
  const result = resolve({ zip_code: '94101' });

  assert.equal(result.zip_code, '94101');
  assert.equal(result.source, 'zip_code');
});

test('a ZIP+4 keeps only the five digits', () => {
  assert.equal(resolve({ zip_code: '94101-1234' }).zip_code, '94101');
});

test('a ZIP written inside the address is found there', () => {
  const result = resolve({ address: '1 Market St, San Francisco, CA 94101' });

  assert.equal(result.zip_code, '94101');
  assert.equal(result.source, 'address_text');
});

test('neither a ZIP nor an address is asked about, not guessed', () => {
  assert.equal(resolve({}).error, 'missing_zip_or_address');
});

test('a city with no geocoder says THAT, not that it failed to resolve', () => {
  // The distinction the user acts on: "give me a better address" versus "this cannot be done here".
  const result = resolve({ address: 'San Francisco, CA' });

  assert.equal(result.error, 'zip_geocode_unavailable');
  assert.ok(!result.zip_code);
});

test('with a geocoder, a city resolves through the point and the ZCTA', () => {
  const withNet = loadLuaModules(['_common/rpc/71_rpc_zip.lua']);
  const seen = [];
  withNet.expose({
    net: {
      fetch: (url) => {
        seen.push(url);
        if (url.includes('photon')) {
          return { ok: true, status: 200, json: { features: [{ geometry: { coordinates: [-122.42, 37.77] }, properties: {} }] } };
        }
        return { ok: true, status: 200, json: { result: { geographies: { 'Zip Code Tabulation Areas': [{ ZCTA5: '94102' }] } } } };
      },
    },
  });
  const result = withNet.call('AX_RPC_ZIP.resolve', { address: 'San Francisco, CA' });
  withNet.close();

  assert.equal(result.zip_code, '94102');
  assert.equal(result.source, 'geocode');
  assert.match(seen[0], /photon/);
});

test('a geocoder that answers nothing is a failed resolve, not a missing capability', () => {
  const withNet = loadLuaModules(['_common/rpc/71_rpc_zip.lua']);
  withNet.expose({ net: { fetch: () => ({ ok: true, status: 200, json: { features: [] } }) } });
  const result = withNet.call('AX_RPC_ZIP.resolve', { address: 'Nowhere, ZZ' });
  withNet.close();

  assert.equal(result.error, 'resolve_failed');
});

test('a geocoder that errors is reported as unreachable, not as no such place', () => {
  const withNet = loadLuaModules(['_common/rpc/71_rpc_zip.lua']);
  withNet.expose({ net: { fetch: () => { throw new Error('rpc net.fetch failed: egress_denied'); } } });
  const result = withNet.call('AX_RPC_ZIP.resolve', { address: 'San Francisco, CA' });
  withNet.close();

  assert.equal(result.error, 'zip_geocode_unavailable');
});

test('the ZCTA layer key is matched by substring, because it carries a vintage', () => {
  // Measured live: Photon resolved the point and the ZIP still came back empty. The Census response keys
  // its layer as "2020 Census ZIP Code Tabulation Areas" — the vintage shifts between releases, so an
  // exact key matches for one census and silently stops matching after the next.
  const withNet = loadLuaModules(['_common/rpc/71_rpc_zip.lua']);
  withNet.expose({
    net: {
      fetch: (url) => (url.includes('photon')
        ? { ok: true, status: 200, json: { features: [{ geometry: { coordinates: [-122.42, 37.77] } }] } }
        : { ok: true, status: 200, json: { result: { geographies: { '2020 Census ZIP Code Tabulation Areas': [{ BASENAME: '94102' }] } } } }),
    },
  });
  const result = withNet.call('AX_RPC_ZIP.resolve', { address: 'San Francisco, CA' });
  withNet.close();

  assert.equal(result.zip_code, '94102');
  assert.equal(result.source, 'geocode');
});
