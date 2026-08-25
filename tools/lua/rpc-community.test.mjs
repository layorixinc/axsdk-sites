import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { parseWidgetEnvelope, WIDGET_FENCE_LANG } from '../../../axsdk-sdk-js/packages/axsdk-core/dist/lib.js';

import { loadLuaModules } from './harness.mjs';

// The confirm surface for a community command the model proposed. The user's approval IS the button,
// so what matters here is that the envelope the SDK will accept carries exactly one invocation and
// nothing a widget could smuggle — the extension refuses extras, and this refuses them a layer earlier
// so a malformed block never reaches a user at all.
//
// The validator is the SDK's own, imported from its build. A second copy of the rule would agree only
// until the first change.

const lua = loadLuaModules([
  '_common/rpc/69_rpc_widget.lua',
  '_common/rpc/75_rpc_community.lua',
]);
after(() => lua.close());

// Both halves, because the runtime has both: `71_rpc_zip` and `73_rpc_offers` already decode. A
// fixture missing one would refuse on a capability the runtime provides.
lua.expose({ json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(text) } });

const PROPOSAL = {
  script_id: 'fixture.read-page',
  script_name: 'Fixture Page Reader',
  publisher_id: 'axsdk-fixtures',
  version: '1.0.0',
  command: 'remember',
  description: 'Store a short note in this script’s own storage.',
  effect: 'cart_mutation',
  arguments_json: '{"note":"hello"}',
};

const confirm = (changes = {}) => lua.call('AX_RPC_COMMUNITY.confirm', { ...PROPOSAL, ...changes });

function body(markdown) {
  const trimmed = String(markdown ?? '').trim();
  const prefix = '```' + WIDGET_FENCE_LANG;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith('```')) return null;
  return trimmed.slice(prefix.length, trimmed.length - 3).trim();
}

test("the SDK's own validator accepts the confirm block", () => {
  const result = confirm();
  assert.equal(result.next, 'confirm', `expected a confirm branch, got ${JSON.stringify(result)}`);

  const envelope = parseWidgetEnvelope(body(result.widget));
  assert.ok(envelope, `the SDK must accept it, got: ${String(result.widget).slice(0, 300)}`);
});

test('the button names the one command the extension allows, carrying one invocation', () => {
  const envelope = parseWidgetEnvelope(body(confirm().widget));
  const encoded = JSON.stringify(envelope);

  assert.match(encoded, /AX_widget_community_invoke/);
  const action = envelope.data.action;
  assert.ok(action, `the envelope must carry an action: ${encoded.slice(0, 300)}`);
  assert.equal(action.type, 'ax');
  assert.equal(action.command, 'AX_widget_community_invoke');
  assert.deepEqual(Object.keys(action.args).sort(), ['arguments', 'command', 'script_id', 'version']);
  assert.equal(action.args.script_id, 'fixture.read-page');
  assert.deepEqual(action.args.arguments, { note: 'hello' });
});

test('the sentence beside the button says what will happen, in the words the user needs', () => {
  const result = confirm();
  const rendered = String(result.summary);

  assert.match(rendered, /Fixture Page Reader/);
  assert.match(rendered, /axsdk-fixtures/);
  assert.match(rendered, /remember/);
  assert.match(rendered, /cart_mutation/);
  // The arguments are shown: approving a mutation without seeing its values is not approval.
  assert.match(rendered, /hello/);
});

test('nothing the extension would refuse can be smuggled into the action', () => {
  const envelope = parseWidgetEnvelope(body(confirm({
    artifact_url: 'https://evil.test/x.js',
    host: 'evil.test',
    consent: true,
    capability_token: 'leaked',
  }).widget));
  const encoded = JSON.stringify(envelope);

  for (const smuggled of ['evil.test', 'capability_token', 'leaked', 'consent']) {
    assert.doesNotMatch(encoded, new RegExp(smuggled), `${smuggled} must not reach the envelope`);
  }
});

test('a proposal that is not one is refused rather than rendered', () => {
  for (const [field, wrong] of [
    ['script_id', 'Fixture.Read-Page'],
    ['version', 'latest'],
    ['command', 'toString'],
    ['effect', 'delete_everything'],
    ['arguments_json', 'not json'],
    ['arguments_json', '[1,2]'],
  ]) {
    const result = confirm({ [field]: wrong });
    assert.equal(result.next, 'error', `expected ${field}=${wrong} to be refused: ${JSON.stringify(result)}`);
  }
});

// Found by the first live run: an argument-taking  had no path to execution at all. Prerun
// skips it (arguments cannot be invented) and the renderer refused it (no confirmation needed), so
// the model could only describe it. The button is the user ASKING for one specific invocation —
// that is what an argument-taking read needs too. Whether a mutation additionally prompts is the
// broker's, on the click, and stays there.
test('any declared effect renders a button, because the button is a request, not an approval', () => {
  for (const effect of ['read', 'page_write', 'external_send', 'cart_mutation']) {
    const result = confirm({ effect });
    assert.equal(result.next, 'confirm', `${effect} must render: ${JSON.stringify(result)}`);
  }
});

test('an effect outside the vocabulary is still refused', () => {
  assert.equal(confirm({ effect: 'delete_everything' }).next, 'error');
  assert.equal(confirm({ effect: '' }).next, 'error');
});

test('an absent encoder refuses outright rather than shipping a half-built block', () => {
  // No `json` at all: the block cannot be escaped, and an unescaped one is refused on receipt in
  // silence — the user would see nothing with no explanation.
  const bare = loadLuaModules([
    '_common/rpc/69_rpc_widget.lua',
    '_common/rpc/75_rpc_community.lua',
  ]);
  try {
    const result = bare.call('AX_RPC_COMMUNITY.confirm', PROPOSAL);
    assert.equal(result.next, 'error');
  } finally {
    bare.close();
  }
});

// The model decides; the renderer is not its to call. Splitting them is the repo's own rule —
// presentation must be deterministic — and the live run showed why: offered the renderer as a tool,
// the model answered in prose instead of proposing, twice.
//
// And it decides ONE thing. The script, the version and the effect come from the catalog, so these
const CATALOG = [
  'Community scripts installed for this page',
  '- Fixture Page Reader 1.0.0 `fixture.read-page` (axsdk-fixtures, reviewed by axsdk-fixture-reviewer)',
  '  - read_heading — Read the visible H1 text. [read]',
  '  - remember — Store a short note in this script’s own storage. [cart_mutation] needs: note',
  '  - ping_api — Fetch the declared endpoint. [read]',
].join('\n');

const propose = (changes = {}) => lua.call('AX_RPC_COMMUNITY.propose', {
  catalog_text: CATALOG, command: 'remember', arguments_json: '{"note":"hello"}', ...changes,
});

test('a proposal is normalised into flow state and renders nothing', () => {
  const result = propose();

  assert.equal(result.next, 'confirm');
  assert.equal(result.widget, undefined, "propose must not render — that is the contract node's job");
  assert.equal(result.summary, undefined);
  assert.equal(result.script_id, 'fixture.read-page');
  assert.equal(result.command, 'remember');
  assert.equal(result.effect, 'cart_mutation');
  assert.equal(result.arguments_json, '{"note":"hello"}');
});

test('an absent argument object is normalised, never invented', () => {
  assert.equal(propose({ arguments_json: undefined }).arguments_json, '{}');
  assert.equal(propose({ arguments_json: '' }).arguments_json, '{}');
});

test('a proposal that is not one is refused before any state is written', () => {
  // The model's half: the command name and the values. Everything else is the catalog's, so a bad
  // script id, version or effect is a catalog this cannot read — asserted below, not here.
  for (const [field, wrong] of [
    ['command', 'toString'],
    ['command', 'Remember'],
    ['arguments_json', 'not json'],
    ['arguments_json', '[1,2]'],
  ]) {
    const result = propose({ [field]: wrong });
    assert.equal(result.next, 'error', `expected ${field}=${wrong} refused: ${JSON.stringify(result)}`);
    assert.equal(result.script_id, undefined);
  }
});

test('a catalog that cannot be read refuses rather than proposing half a fact', () => {
  // Each of these is one line of a real catalog gone wrong. None may become a button: the broker
  // dispatches on the id and the version, and the sentence beside the button names the effect.
  const cases = [
    ['- Fixture Page Reader 1.0.0 (axsdk-fixtures, reviewed by r)', 'script_id_invalid'],
    ['- Fixture Page Reader latest `fixture.read-page` (axsdk-fixtures, reviewed by r)', 'script_id_invalid'],
    ['- Fixture Page Reader 1.0.0 `Fixture.Read-Page` (axsdk-fixtures, reviewed by r)', 'script_id_invalid'],
  ];
  for (const [entryLine, expected] of cases) {
    const catalog = [
      'Community scripts installed for this page',
      entryLine,
      '  - remember — Store a short note [cart_mutation] needs: note',
    ].join('\n');
    const result = propose({ catalog_text: catalog });
    assert.equal(result.next, 'error', `expected ${entryLine} refused: ${JSON.stringify(result)}`);
    assert.equal(result.error, expected, `for ${entryLine}`);
  }

  // An effect outside the vocabulary is the catalog naming something the policy does not allow.
  const strange = [
    'Community scripts installed for this page',
    '- Fixture Page Reader 1.0.0 `fixture.read-page` (axsdk-fixtures, reviewed by r)',
    '  - remember — Store a short note [delete_everything] needs: note',
  ].join('\n');
  assert.equal(propose({ catalog_text: strange }).error, 'effect_invalid');
});

test('one command name offered by two scripts is refused, never guessed between', () => {
  const catalog = [
    'Community scripts installed for this page',
    '- Fixture Page Reader 1.0.0 `fixture.read-page` (axsdk-fixtures, reviewed by r)',
    '  - remember — Store a short note [read] needs: note',
    '- Other Reader 2.0.0 `other.reader` (someone-else, reviewed by r)',
    '  - remember — Something else entirely [cart_mutation] needs: note',
  ].join('\n');

  const result = propose({ catalog_text: catalog });
  assert.equal(result.next, 'error');
  assert.equal(result.error, 'command_ambiguous');
});

test('propose and confirm agree on what a valid proposal is', () => {
  const proposed = propose();
  const rendered = confirm({
    script_id: proposed.script_id,
    version: proposed.version,
    command: proposed.command,
    effect: proposed.effect,
    arguments_json: proposed.arguments_json,
  });

  assert.equal(rendered.next, 'confirm', 'what propose accepts, confirm must render');
});

// Four prompt formulations failed to make the model choose to propose, and the diagnosis was that
// `answer` is always available to it. So the DECISION becomes deterministic and the model keeps only
// the job it is good at — reading values out of the sentence. Same shape as the Thumbtack shortlist
// loop, which has no model node at all.
const classify = (catalog, text) => lua.call('AX_RPC_COMMUNITY.classify', { catalog_text: catalog, user_text: text });


test('a command the catalog lists and the user named is a proposal', () => {
  const result = classify(CATALOG, 'run the remember command with note "hello"');

  assert.equal(result.next, 'propose');
  assert.equal(result.command, 'remember');
});

test('no command named is an answer, which is the common case', () => {
  for (const text of [
    '이 페이지 뭐라고 쓰여 있어?',
    'which community scripts can I use here?',
    'what does this page say',
  ]) {
    assert.equal(classify(CATALOG, text).next, 'answer', text);
  }
});

test('a name the catalog does not list is never a proposal', () => {
  // Otherwise a name the model or the user invented would branch into a proposal for a command
  // the broker will refuse, and the user would see a button that cannot work.
  assert.equal(classify(CATALOG, 'run delete_everything').next, 'answer');
  assert.equal(classify('', 'run remember').next, 'answer');
});

test('two named commands are refused rather than guessed between', () => {
  const result = classify(CATALOG, 'run remember and then ping_api');

  assert.equal(result.next, 'ambiguous');
  assert.match(String(result.candidates), /remember/);
  assert.match(String(result.candidates), /ping_api/);
});

test('a name inside a longer word is not a mention', () => {
  // `remembering` is prose about the command, not a request to run it.
  assert.equal(classify(CATALOG, 'is remembering supported here?').next, 'answer');
  assert.equal(classify(CATALOG, 'tell me about read_headings').next, 'answer');
});

test('the same command named twice is still one command', () => {
  assert.equal(classify(CATALOG, 'run remember, yes remember').next, 'propose');
});

test('propose derives the script, version and effect from the catalog, never from the model', () => {
  // The effect and the script id are facts of the INSTALLED command. A model that restates them is a
  // second writer of one fact, and it can only be right by luck: live it answered an effect outside
  // the vocabulary and the proposal died as `effect_invalid`. The catalog is readable now, so these
  // are looked up by command name.
  const catalog = [
    'Community scripts installed for this page',
    '- Fixture Page Reader 1.0.0 `fixture.read-page` (axsdk-fixtures, reviewed by axsdk-fixture-reviewer)',
    '  - read_heading — Read the visible H1 text [read]',
    '  - remember — Store a short note [page_write] needs: note',
  ].join('\n');

  const result = lua.call('AX_RPC_COMMUNITY.propose', {
    catalog_text: catalog, command: 'remember', arguments_json: '{"note":"hi"}',
  });
  assert.equal(result.next, 'confirm');
  assert.equal(result.script_id, 'fixture.read-page');
  assert.equal(result.version, '1.0.0');
  assert.equal(result.effect, 'page_write');
});

test('a command the catalog does not list cannot be proposed', () => {
  const catalog = [
    'Community scripts installed for this page',
    '- Fixture Page Reader 1.0.0 `fixture.read-page` (axsdk-fixtures, reviewed by axsdk-fixture-reviewer)',
    '  - read_heading — Read the visible H1 text [read]',
  ].join('\n');

  const result = lua.call('AX_RPC_COMMUNITY.propose', {
    catalog_text: catalog, command: 'wire_money', arguments_json: '{}',
  });
  assert.equal(result.next, 'error');
  assert.equal(result.error, 'command_not_offered');
});

test('a model value for a catalog fact is ignored, not preferred', () => {
  // The mutation that made this necessary: reading `args.effect or offered.effect` passed every
  // other test in the file, because none of them supplied a conflicting one. The tool schema does
  // not declare these, so the runtime drops them — but a schema is a different file from this one,
  // and the rule this file states is that the catalog decides.
  const result = propose({
    effect: 'read', script_id: 'attacker.script', version: '9.9.9',
    script_name: 'Something Else', publisher_id: 'someone-else',
    description: 'A harmless-sounding sentence.',
  });

  assert.equal(result.next, 'confirm');
  assert.equal(result.effect, 'cart_mutation', 'the effect is the catalog’s');
  assert.equal(result.script_id, 'fixture.read-page');
  assert.equal(result.version, '1.0.0');
  assert.equal(result.script_name, 'Fixture Page Reader');
  assert.equal(result.publisher_id, 'axsdk-fixtures');
  assert.match(String(result.description), /Store a short note/);
});
