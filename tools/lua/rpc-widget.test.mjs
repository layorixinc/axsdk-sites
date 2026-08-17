import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { parseWidgetEnvelope, WIDGET_FENCE_LANG } from '../../../axsdk-sdk-js/packages/axsdk-core/dist/lib.js';

import { loadLuaModules } from './harness.mjs';

// Rendering the widget envelope in Lua is safe for a reason we got wrong the first time: the consumer
// re-validates. `parseWidgetEnvelope` runs the template's own zod schema over the data, applies the
// template defaults, and treats `version` as optional — so a producer cannot weaken the shape, whoever it
// is. What was genuinely missing was escaping, and the runtime now provides `json.encode`.
//
// This suite therefore checks the two things that are actually ours: the SHAPE handed to the encoder, and
// that the strings a real store puts in a table survive it. The validator is the SDK's own, imported from
// its build rather than reimplemented — a second copy of the rule would agree only until the first change.

const lua = loadLuaModules(['_common/rpc/69_rpc_widget.lua']);
after(() => lua.close());

// A REAL JSON encoder standing in for the runtime's. Nothing about escaping is ours to get right, so the
// stand-in must not be a hand-rolled one that quietly differs.
lua.expose({ json: { encode: (value) => JSON.stringify(value) } });

const TABLE = {
  caption: 'Thumbtack results for house cleaning (10)',
  columns: [
    { key: 'pro', label: 'Professional' },
    { key: 'rating', label: 'Rating', align: 'center' },
  ],
  rows: [
    { pro: { text: 'MAXIMA - Spotless Homes.', action: { type: 'link', url: 'https://www.thumbtack.com/x/service/1/', target: '_blank' } }, rating: 4.9 },
  ],
};

const render = (data, template = 'table') => lua.call('AX_RPC_WIDGET.render', { template_id: template, data });

/** The envelope body inside the fence, or null when the block is malformed. */
function body(markdown) {
  const trimmed = String(markdown ?? '').trim();
  const prefix = '```' + WIDGET_FENCE_LANG;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith('```')) return null;
  return trimmed.slice(prefix.length, trimmed.length - 3).trim();
}

test("the SDK's own validator accepts what Lua rendered", () => {
  const result = render(TABLE);
  const envelope = parseWidgetEnvelope(body(result.value));

  assert.ok(envelope, `the SDK must accept it, got: ${String(result.value).slice(0, 200)}`);
  assert.equal(envelope.template, 'table');
  assert.equal(envelope.data.rows.length, 1);
});

test('quotes, markup, tabs, backslashes and Korean all survive', () => {
  // A live card once put an `<img>` tag in its text, and store names carry quotes and non-Latin script.
  // One escaping mistake makes the UI reject the block and the whole answer disappears.
  const nasty = '그는 "M185"를 팔았다\t<img src=x>\\ 50% off';
  const result = render({ ...TABLE, caption: nasty, rows: [{ pro: nasty, rating: 5 }] });
  const envelope = parseWidgetEnvelope(body(result.value));

  assert.ok(envelope, 'the block must still parse');
  assert.equal(envelope.data.caption, nasty);
  assert.equal(envelope.data.rows[0].pro, nasty);
});

test('a shape the template refuses is refused by the SDK too, so nothing was weakened', () => {
  // The point of letting Lua render: the consumer still gates the shape. If this ever passes, the guard is
  // gone.
  const envelope = parseWidgetEnvelope(body(render({ caption: 'no columns, no rows' }).value));
  assert.equal(envelope, null);
});

test('rows and columns encode as ARRAYS', () => {
  const raw = JSON.parse(body(render(TABLE).value));

  assert.ok(Array.isArray(raw.data.rows), `rows must encode as an array, got ${JSON.stringify(raw.data.rows)}`);
  assert.ok(Array.isArray(raw.data.columns), 'columns must encode as an array');
});

test('an empty list is refused, not encoded as an object', () => {
  // A Lua table with no positional entries encodes as `{}`, and nothing in the runtime marks it otherwise
  // (`ax.array` belongs to the browser capability set). The template would refuse the object, the refusal
  // is silent, and the user would be shown nothing with no explanation. A table with no rows is a
  // "no results" sentence, not a widget.
  const result = render({ ...TABLE, rows: [] });

  assert.equal(result.error, 'widget_empty_list');
  assert.equal(result.field, 'rows');
  assert.ok(!result.value);
});

test('absent data is refused, not shipped as an empty envelope', () => {
  // `local data = type(args.data) == "table" and args.data or {}` — so a nil `data` became `{}` and the
  // envelope went out carrying `data: {}`. The template's own schema then refuses it on RECEIPT, silently,
  // and the user is shown nothing with no explanation: the same failure `widget_empty_list` above exists to
  // prevent, one level up. A widget with no data is not a widget.
  for (const absent of [undefined, null, 'not a table', 42]) {
    const result = lua.call('AX_RPC_WIDGET.render', { template_id: 'table', data: absent });
    assert.equal(result.error, 'widget_missing_data', `data=${JSON.stringify(absent)} -> ${result.error}`);
    assert.ok(!result.value, 'and nothing is rendered');
  }
});

test('an unknown template is refused before anything is rendered', () => {
  const result = render(TABLE, 'nope');

  assert.equal(result.error, 'unknown_widget_template');
  assert.ok(!result.value, 'nothing may be handed on');
});

test('a runtime without an encoder refuses instead of inventing one', () => {
  // Hand-rolling JSON here is exactly the escaping risk the runtime's encoder removes. If it is missing,
  // the honest answer is to say so.
  const bare = loadLuaModules(['_common/rpc/69_rpc_widget.lua']);
  const result = bare.call('AX_RPC_WIDGET.render', { template_id: 'table', data: TABLE });
  bare.close();

  assert.equal(result.error, 'json_encode_unavailable');
  assert.ok(!result.value);
});
