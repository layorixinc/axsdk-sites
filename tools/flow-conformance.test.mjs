import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDocument } from 'yaml';

const root = new URL('../', import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function parseFlow(path) {
  const document = parseDocument(read(path), { prettyErrors: true, strict: true });
  assert.deepEqual(document.errors, [], `${path} must be valid YAML`);
  return document.toJS();
}

function assertMutation(tool, name) {
  assert.ok(tool, `${name} must exist`);
  assert.equal(tool.effect, 'mutation', `${name}.effect`);
  assert.equal(tool.consent, 'required', `${name}.consent`);
  assert.equal(tool.idempotent, true, `${name}.idempotent`);
  assert.ok(tool.require && Object.keys(tool.require).length > 0, `${name}.require must be non-empty`);
}

function mutationIssue(adapter) {
  if (adapter.effect !== 'mutation') return 'mutation.effect.required';
  if (adapter.consent !== 'required') return 'mutation.consent.required';
  if (adapter.idempotent !== true) return 'mutation.idempotent.required';
  if (!adapter.require || Object.keys(adapter.require).length === 0) return 'mutation.require.nonempty';
  return null;
}

test('all production flow layers parse under flow document contract v1', () => {
  const common = parseFlow('_common/flows.yaml');
  const bluemoonsoft = parseFlow('bluemoonsoft/flows.yaml');
  const thumbtack = parseFlow('thumbtack/flows.yaml');

  assert.equal(common.extends, 'app');
  assert.equal(common.defaults?.mapping, 'legacy');
  assert.equal(bluemoonsoft.extends, 'app');
  assert.equal(thumbtack.extends, 'app');
});

test('production mutations use the current mutation contract', () => {
  const common = parseFlow('_common/flows.yaml');
  assertMutation(common.flowTools?.set_memory, 'set_memory');
  assertMutation(common.flowTools?.delete_memory, 'delete_memory');
  assertMutation(common.flowTools?.shopping_add_to_cart, 'shopping_add_to_cart');
  assertMutation(common.flowTools?.shopping_add_selected_store_offer, 'shopping_add_selected_store_offer');
  assert.deepEqual(common.flowTools.shopping_add_selected_store_offer.require, { cart_approval: 'user_selected_compared_offer' });
  assertMutation(common.flowTools?.submit_quote, 'submit_quote');
});

test('task research names the current canonical and SDK reference flows', () => {
  const research = read('AXSDK_CHROME_EXTENSION_AGENTIC_TASKS.md');
  assert.doesNotMatch(research, /\.\.\/axsdk-agents\/apps\/browser-extension/);
  assert.match(research, /_common\/flows\.yaml/);
  assert.match(research, /axsdk-sdk-js\/packages\/axsdk-react\/apps\/browser-extension\/flows\.yaml/);
  assert.match(research, /legacy/i);
});

test('shared v1 fixtures encode compiler mutation acceptance and rejection', () => {
  const fixture = JSON.parse(read('tools/fixtures/flow-conformance-v1.json'));
  assert.equal(fixture.fixtureId, 'axsdk-flow-conformance-v1');
  assert.equal(fixture.flowContractVersion, 1);
  for (const scenario of fixture.mutationCases) {
    const issue = mutationIssue(scenario.adapter);
    assert.equal(issue === null, scenario.valid, scenario.name);
    if (!scenario.valid) assert.equal(issue, scenario.issue, scenario.name);
  }
});

test('compatibility record is present', () => {
  assert.equal(existsSync(new URL('FLOW_CONFORMANCE.md', root)), true);
});
