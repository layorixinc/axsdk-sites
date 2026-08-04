import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// The quote dialog is where the durable design cost the most NODES. It is a same-context SPA overlay —
// pushState, no reload — yet every step was its own durable call, so the flow drove the wizard by
// re-entering `answer_quote` up to sixteen times. A runtime script keeps its stack, so the whole wizard
// is one call and the self-loop is the artifact.
//
// What must NOT collapse with it is the stop. The final Submit stays a separate node behind an explicit
// confirmation, because that click contacts a real person. Filling a form and sending it are different
// acts, and only one of them is reversible.
//
// The fixtures below are keyed on the selectors the script really builds. That is deliberate: the `dom`
// capability is CSS-only, so a step's options and buttons can only be reached by the selector the code
// composes, and a fixture keyed on anything else would prove nothing about the live page.

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/10_form_wizard.lua',
  '_common/rpc/64_rpc_thumbtack.lua',
  '_common/rpc/65_rpc_quote.lua',
]);
after(() => lua.close());

// NOTHING is stubbed for `ax` here on purpose. The wizard core accumulates its picks in `ax.array()`,
// which the DURABLE capability set provides and the runtime does NOT. Defining it in this harness made
// every test pass while the live run raised "attempt to index a nil value (global 'ax')" the moment the
// dialog opened — the permissive-fixture trap, again. The module supplies the list itself now, and this
// suite proves it by not helping.

const ACTIVE = '[data-test="request-flow-step--active"]';
// Mirrors the module. A test that moves this must put it back, or every later test runs on a budget it
// never chose — and the flow's own `deadlineMs` is what it has to stay under, which conformance pins.
const TIME_BUDGET_MS = 90000;
const PRO_URL = 'https://www.thumbtack.com/ca/san-francisco/house-cleaning/maxima/service/583813840609927168';

/** One request-flow step, expressed the way the page renders it. */
function step(text, { choices = [], buttons = ['Next'], textarea = false, contact = false, error = null } = {}) {
  const dom = { [ACTIVE]: [{ text }] };
  if (error) dom['#request-flow-error'] = [{ text: `${error} Close alert` }];
  if (choices.length > 0) {
    // The rows are shared objects: clicking one flips its `checked`, because the module now confirms the
    // site accepted the click instead of trusting that it fired.
    const rows = choices.map((choice, index) => ({ text: choice, control: 'radio', group: 'g', id: `opt${index}`, checked: false }));
    dom[`${ACTIVE} label:has(input[type="radio"]), ${ACTIVE} label:has(input[type="checkbox"])`] = rows;
    dom['label:has(input[type="radio"]), label:has(input[type="checkbox"])'] = rows;
    rows.forEach((row) => {
      dom[`${ACTIVE} label:has(input[id="${row.id}"])`] = [row];
      dom[`${ACTIVE} input[id="${row.id}"]`] = [row];
    });
  }
  if (textarea) dom[`${ACTIVE} textarea`] = [{ text: '', value: '' }];
  if (contact) {
    // The module reads the step's inputs ONCE through the combined selector and addresses each row by the
    // attribute it matched on — so the fixture has to answer that combined read, not just the per-field
    // selectors. Keying only the per-field ones let a reader that never looked appear to work.
    const inputs = [
      { tag: 'INPUT', type: 'email' },
      { tag: 'INPUT', type: 'tel' },
      { tag: 'INPUT', autocomplete: 'given-name' },
      { tag: 'INPUT', autocomplete: 'family-name' },
      { tag: 'INPUT', autocomplete: 'postal-code' },
    ];
    dom[`${ACTIVE} input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="file"])`] = inputs;
    dom[`${ACTIVE} input[type="email"]`] = [{ text: '', type: 'email' }];
    dom[`${ACTIVE} input[type="tel"]`] = [{ text: '', type: 'tel' }];
    dom[`${ACTIVE} input[autocomplete="given-name"]`] = [{ text: '' }];
    dom[`${ACTIVE} input[autocomplete="family-name"]`] = [{ text: '' }];
    dom[`${ACTIVE} input[autocomplete="postal-code"]`] = [{ text: '' }];
  }
  const rows = buttons.map((label) => (typeof label === 'string' ? { text: label } : label));
  dom[`${ACTIVE} button`] = rows;
  dom[`${ACTIVE} button:not([aria-label])`] = rows;
  dom[`${ACTIVE} button:not([aria-label]):not([title])`] = rows;
  return { text, dom };
}

/** A required step with a control the wizard has nothing to answer from. */
const unanswerable = () => {
  const built = step('When do you need this done?');
  built.dom[`${ACTIVE} input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="file"])`] =
    [{ tag: 'INPUT', type: 'date', placeholder: 'Pick a date' }];
  return built;
};

/** The last step: the only action left sends the request. */
const finalStep = () => step('Review and send your request', { buttons: ['Submit request'], contact: true });

/** A pro page whose sidebar CTA opens the dialog, and a dialog whose Next walks `steps`. */
function quotePage({ href = PRO_URL, steps = [], cta = 'Request estimate', ctaAfter = 0, advanceOn = 'click' } = {}) {
  let at = -1;
  // ONE dom object, mutated in place: `makePage` reads `afterNavigate` at navigation time, so a fixture
  // that hands over a fresh object leaves the pro page blank after the hop — which reads exactly like a
  // pro with no quote CTA.
  const dom = {};
  const page = makePage({
    href,
    dom,
    afterNavigate: dom,
    // The CTA answers a different thing on each poll, which is the only way a late-hydrating sidebar can
    // be modelled: a static fixture proves the reader looked, never that it waited.
    sequence: ctaAfter > 0
      ? { 'aside button:not(:last-child)': [...Array(ctaAfter).fill([]), [{ text: cta }]] }
      : null,
    onClick: (selector) => {
      const chosen = selector.match(/input\[id="([^"]+)"\]/)?.[1];
      if (chosen) {
        // The site checks the radio the click landed on.
        for (const row of steps[at]?.dom[`${ACTIVE} input[id="${chosen}"]`] ?? []) row.checked = true;
        return;
      }
      if (selector.includes('aside') || selector.includes('main')) at = 0;
      // What actually advances a step is the page's business: some ignore a synthetic click on a submit
      // button and move only on a real form submit, and some refuse both.
      else if (selector.startsWith('submit:')) {
        if (page.advanceOn !== 'form') return;
        at += 1;
      } else if (selector.includes(ACTIVE) && selector.includes('button')) {
        if (page.advanceOn !== 'click') return;
        at += 1;
      }
      apply();
    },
  });
  page.advanceOn = advanceOn;

  const apply = () => {
    for (const key of Object.keys(dom)) delete dom[key];
    Object.assign(dom, {
      h1: [{ text: 'MAXIMA - Spotless Homes.' }],
      body: [{ text: 'Request a quote' }],
      'aside button, main button': [{ text: cta }],
      'aside button:not(:last-child)': [{ text: cta }],
    }, steps[at]?.dom ?? {});
    page.dom = dom;
    if (page.pendingHref !== undefined) page.pendingDom = dom;
  };
  apply();
  return page;
}

// Hoisted so a test can install the stub, change the RUNTIME (e.g. remove the host timer), and still
// issue the identical call. Comparing two runs with different arguments compares two different paths.
const QUOTE_ARGS = {
  quote_url: PRO_URL,
  user_requirements: 'one-time house cleaning',
  submit_first_name: 'AX',
  submit_last_name: 'Tester',
  submit_email: 'thumbtack-test@example.com',
  submit_phone: '415-555-0123',
  zip_code: '94101',
};

const drive = (page, args = {}) => {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_THUMBTACK.request_quote', { ...QUOTE_ARGS, ...args });
};

const clicks = (page) => page.ops.filter((entry) => entry.op === 'dom.click').map((entry) => entry.params.selector);

test('the whole wizard runs in one call', () => {
  // The durable flow re-entered `answer_quote` once per step (maxSelfSteps: 16). Nothing suspends now, so
  // a three-step form must be finished by a single invocation.
  const page = quotePage({
    steps: [
      step('What kind of cleaning?', { choices: ['One-time cleaning', 'Recurring cleaning'] }),
      step('How many bedrooms?', { choices: ['1 bedroom', '2 bedrooms'] }),
      finalStep(),
    ],
  });
  const result = drive(page);

  assert.equal(result.next, 'submit');
  assert.equal(result.quote_reached_submit, true);
  assert.ok(result.quote_steps >= 3, `every step must be driven, drove ${result.quote_steps}`);
});

test('the final submit is never clicked while driving', () => {
  const page = quotePage({ steps: [step('What kind of cleaning?', { choices: ['One-time cleaning'] }), finalStep()] });
  drive(page);

  const clicked = clicks(page);
  assert.ok(clicked.length > 0, 'the CTA and the Next buttons are clicked');
  assert.equal(page.dom[ACTIVE][0].text, 'Review and send your request', 'the wizard is parked on the final step');
});

test('the CTA is polled, not decided on one scan', () => {
  // The aside sidebar hydrates AFTER nav readiness. A single scan raced it, so a quotable pro came back
  // `quote_unavailable` and was silently skipped.
  const page = quotePage({ ctaAfter: 3, steps: [finalStep()] });
  assert.equal(drive(page).next, 'submit');
});

test('a pro with no quote CTA is reported, not retried forever', () => {
  const page = quotePage({ cta: 'View details', steps: [] });
  const result = drive(page);

  assert.equal(result.next, 'error');
  assert.equal(result.quote_error, 'quote_unavailable');
});

test('the pro page is opened only when we are not already on it', () => {
  const here = quotePage({ steps: [finalStep()] });
  drive(here);
  assert.equal(here.ops.filter((entry) => entry.op === 'nav.navigate').length, 0, 'already on the pro');

  const elsewhere = quotePage({ href: 'https://www.thumbtack.com/k/house-cleaning/near-me/', steps: [finalStep()] });
  drive(elsewhere);
  assert.equal(elsewhere.ops.filter((entry) => entry.op === 'nav.navigate').length, 1);
});

test('a step the wizard cannot answer stops instead of burning the cap', () => {
  // A required step it cannot score keeps answering `missing_answer`. Re-driving it sixteen times costs
  // sixteen passes over the same DOM and says nothing new; the flow moves to the next pro either way.
  const stuck = unanswerable();
  const page = quotePage({ steps: [stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck] });
  const result = drive(page);

  assert.equal(result.quote_advance_reason, 'missing_answer');
  assert.ok(result.quote_steps <= 3, `the loop must stop early, drove ${result.quote_steps}`);
});

test("Thumbtack's own rejection is the answer, not a generic failure", () => {
  const page = quotePage({
    steps: [step('Your contact info', { contact: true, error: 'We could not use the email address "ax@x".' })],
  });
  const result = drive(page);

  assert.equal(result.next, 'error');
  assert.match(result.quote_message, /ax@x/, "the site's own wording must reach the user");
});

test('submitting refuses without an explicit confirmation and clicks nothing', () => {
  // `confirm` is what separates filling a form from contacting a person, and the node stays separate for
  // the same reason: the flow must be able to stop right here.
  const page = quotePage({ steps: [finalStep()] });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_THUMBTACK.submit_quote', { submit_email: 'thumbtack-test@example.com' });

  assert.equal(result.quote_submit_status, 'confirmation_required');
  assert.equal(clicks(page).length, 0);
});

test('a confirmed submit fills the contact details and reports what Thumbtack answered', () => {
  const page = quotePage({ steps: [finalStep()] });
  page.dom = { ...page.dom, ...finalStep().dom };
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_THUMBTACK.submit_quote', {
    confirm: true,
    submit_email: 'thumbtack-test@example.com',
    submit_first_name: 'AX',
    submit_last_name: 'Tester',
    submit_phone: '415-555-0123',
    zip_code: '94101',
  });

  assert.equal(result.next, 'done');
  const filled = page.filled.map((entry) => entry.value);
  assert.ok(filled.includes('thumbtack-test@example.com'), `the email must be filled, saw ${filled.join(' | ')}`);
  assert.ok(clicks(page).length > 0, 'the submit is clicked once confirmed');
});

test('a submit that Thumbtack rejected is not reported as sent', () => {
  // A validation popover means the request did NOT go out. Reporting "submitted" there tells the user a
  // pro was contacted when none was.
  const rejected = finalStep();
  rejected.dom['#request-flow-error'] = [{ text: 'Enter a valid phone number. Close alert' }];
  const page = quotePage({ steps: [rejected] });
  page.dom = { ...page.dom, ...rejected.dom };
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_THUMBTACK.submit_quote', { confirm: true, submit_phone: '1' });

  assert.equal(result.quote_submit_status, 'rejected');
  assert.match(result.quote_submit_message, /valid phone number/);
});

test('an op refused while the channel re-attaches does not cost the pro', () => {
  // Measured live: the navigation landed on the pro, the first `dom.query_all` came back `rpc_timeout`
  // while the channel was still attaching, the error propagated, and the whole quote attempt was
  // reported as "stopped before submit". One refused read must not decide anything.
  const page = quotePage({ href: 'https://www.thumbtack.com/k/house-cleaning/near-me/', steps: [finalStep()] });
  page.failQueryTimes = 2;
  const result = drive(page);

  assert.equal(result.next, 'submit', `a transient refusal must be retried, got ${result.quote_error}`);
});

test("a pro who cannot do the job is not reported as our failure", () => {
  // Measured live on a real pro: Thumbtack rendered no CTA and said so — "Sorry this pro can't do your
  // job, but we know other pros who can." Both this reader and the durable one answered
  // `quote_unavailable`, which the report then printed as "FAILED to open/answer". The site had given a
  // reason; folding it into our failure hides it and invites a pointless retry.
  const page = quotePage({ cta: 'View details', steps: [] });
  page.dom.body = [{ text: "Contact for price Sorry this pro can't do your job, but we know other pros who can. Check them out" }];
  const result = drive(page);

  assert.equal(result.next, 'error');
  assert.equal(result.quote_error, 'pro_unavailable');
  // The window around the phrase dragged in whatever the page had next — live it read
  // "construction cleaningVacation rental cleaningSorry this pro can't … Check them outAboutServices".
  // What the user is shown must be the site's sentence and nothing else.
  assert.equal(result.quote_message, "Sorry this pro can't do your job, but we know other pros who can.");
});

test('a refusal names the controls the page offered instead', () => {
  // Live, the sidebar turned out to be an inline mini-form ("Select a service / Zip code / Frequency"),
  // not the "Request estimate" button the phrase list expects. `quote_unavailable` alone could not tell
  // a changed page from an absent CTA, so the next question always needed a manual survey.
  const page = quotePage({ cta: 'Select a service', steps: [] });
  const result = drive(page);

  assert.equal(result.quote_error, 'quote_unavailable');
  assert.match(result.quote_message, /Select a service/, 'the labels it saw must ride in the refusal');
});

test('giving up costs a bounded number of round trips', () => {
  // Every op is a wire round trip against a 120s deadline. Retrying inside a poll that already retries
  // multiplied the scan by four and the live run died with `deadline exceeded before dom.query_all` —
  // a timeout where the page had simply changed. The poll IS the retry.
  const page = quotePage({ cta: 'Select a service', steps: [] });
  drive(page);

  assert.ok(page.ops.length < 60, `the no-CTA path must stay bounded, spent ${page.ops.length} ops`);
});

test('the CTA is found even when it is not the first button in the sidebar', () => {
  // Measured live on a real handyman pro. The sidebar's buttons were, in document order:
  //   5.0(1) | Share | View details | Select date | Select answer(s) | Request estimate | Read more | Message
  // Reading the FIRST match of each candidate selector therefore read "5.0(1)" and reported
  // `quote_unavailable` while the CTA sat in the same list. A label is found by reading the set and
  // clicking the matching row's own handle.
  const page = quotePage({ steps: [finalStep()] });
  delete page.dom['aside button:not(:last-child)'];
  page.dom['aside button, main button'] = [
    { text: '5.0(1)5.0(1)' },
    { text: 'Share' },
    { text: 'View details' },
    { text: 'Request estimate', aria: 'Request estimate' },
    { text: 'Message' },
  ];
  page.dom['[aria-label="Request estimate"]'] = [{ text: 'Request estimate' }];
  const result = drive(page);

  assert.equal(result.next, 'submit', `the CTA must be reachable, got ${result.quote_error} ${result.quote_message ?? ''}`);
});

test('a CTA that is present but unreachable is its own answer', () => {
  // "No CTA" and "the CTA is there and nothing I can click reaches it" call for different work: the first
  // means this pro takes no requests, the second means the page changed and the selectors must follow.
  // Live they were the same string, so every run needed a manual survey to tell them apart.
  const page = quotePage({ steps: [finalStep()] });
  // On a client that implements `dom.click_text` this state cannot arise at all — the label op reaches it.
  // The floor is a client without it, which is what the extension shipped when this was written.
  page.refuseOps = ['dom.click_text'];
  delete page.dom['aside button:not(:last-child)'];
  page.dom['aside button, main button'] = [
    { text: 'Share' },
    { text: 'Request estimate' },   // no id, no aria-label, no data-test
  ];
  const result = drive(page);

  assert.equal(result.quote_error, 'quote_cta_unreachable');
  assert.match(result.quote_message, /Request estimate/);
});

test('a CTA that opens nothing says so instead of blaming the CTA', () => {
  const page = quotePage({ steps: [] });   // the CTA exists, but no step ever mounts
  const result = drive(page);

  assert.equal(result.quote_error, 'quote_dialog_did_not_open');
});

test('a structural candidate is only clicked once its own label is confirmed', () => {
  // `page.eval` came back `op_not_permitted` live, so the page world is closed to us. What is left is
  // structure — and the survey gave it: the CTA is the LAST of four buttons in the aside, under a
  // `<div class="">`. Widening the candidate list is safe only because each candidate's own text is read
  // before it is clicked, so a candidate that resolves to the wrong button is skipped, never pressed.
  const page = quotePage({ steps: [finalStep()] });
  delete page.dom['aside button:not(:last-child)'];
  page.dom['aside button, main button'] = [{ text: 'Share' }, { text: 'Request estimate' }];
  page.dom['aside button'] = [{ text: 'Share' }];                          // wrong button, must be skipped
  page.dom['aside div[class=""] > button'] = [{ text: 'Request estimate' }];
  const result = drive(page);

  assert.equal(result.next, 'submit', `the structural candidate must reach it, got ${result.quote_error}`);
  const clicked = clicks(page);
  assert.ok(!clicked.includes('aside button'), `a candidate whose label did not match must not be clicked, saw ${clicked.join(' | ')}`);
});

test('a flaky channel never decides anything', () => {
  // Two live runs died this way, on two different ops: `dom.query_all` right after the navigation, then
  // `dom.exists` inside the contact fill. Wrapping the op that happened to fail is whack-a-mole — ANY op
  // can be refused while the channel re-attaches, so every read this module makes has to tolerate one.
  const page = quotePage({
    href: 'https://www.thumbtack.com/k/handyman/near-me/',
    steps: [step('What do you need?', { choices: ['Shelf installation', 'Painting'] }), finalStep()],
  });
  page.flakyEvery = 5;
  const result = drive(page);

  assert.equal(result.next, 'submit', `got ${result.quote_error} / ${result.quote_message ?? ''}`);
});

test("the step's own controls are waited for, not just the dialog frame", () => {
  // Surveyed live: the dialog opened with the step "How much help do you need?" and a single `Next`
  // button (type=submit). The wizard nevertheless reported `advance_button_not_found`, because the frame
  // mounts before its form does and the opener only waited for the frame.
  const late = step('How much help do you need?', { choices: ['Less than 2 hours', 'A full day'] });
  const buttonKeys = Object.keys(late.dom).filter((key) => key.includes('button'));
  const held = {};
  for (const key of buttonKeys) { held[key] = late.dom[key]; delete late.dom[key]; }

  const page = quotePage({ steps: [late, finalStep()] });
  let polls = 0;
  const origin = page.tick;
  page.tick = () => {
    origin();
    // The form arrives a few polls after the frame — and stays, even though opening the dialog rebuilds
    // the fixture's DOM.
    if (++polls >= 6) Object.assign(page.dom, held);
  };
  const result = drive(page);

  // The invariant is that the form was waited for. Where the run ends afterwards depends on what the
  // fixture's re-merge does to later steps, which is fixture noise, not product behaviour.
  assert.notEqual(result.quote_advance_reason, 'advance_button_not_found');
  assert.ok(result.quote_steps >= 1, 'the wizard must have driven the step it waited for');
});

test('a step with no button yet is retried before it is handed off', () => {
  // `advance_button_not_found` is structural or early — never a decision. Treating it as "we have arrived
  // at the submit step" reported a form that had not been touched as ready to send.
  const bare = step('How much help do you need?', { choices: ['A full day'] });
  for (const key of Object.keys(bare.dom)) { if (key.includes('button')) delete bare.dom[key]; }
  const page = quotePage({ steps: [bare, bare, bare, bare] });
  const result = drive(page);

  assert.equal(result.quote_reached_submit, undefined, 'nothing may claim the submit step was reached');
  assert.equal(result.quote_error, 'quote_stalled');
  assert.ok(result.quote_steps >= 2, `it must be retried, drove ${result.quote_steps}`);
});

test('each extra step costs a bounded number of round trips', () => {
  // Live, an op is roughly a second and the tool's deadline is finite. The first version probed five
  // contact selectors with an `exists` + a `set_value` each — ten round trips on a step that asks for no
  // contact details at all — and a three-step form died with `deadline exceeded before dom.query_all`.
  //
  // What matters is the MARGINAL cost: opening the dialog is paid once, but every step of a form the site
  // may lengthen at any time is paid again. So this measures the difference between two runs.
  const choices = (label) => step(label, { choices: ['Shelf installation', 'Painting'] });
  const run = (count) => {
    const steps = [];
    for (let index = 0; index < count; index += 1) steps.push(choices(`Question ${index}`));
    steps.push(finalStep());
    const page = quotePage({ steps });
    const result = drive(page);
    assert.equal(result.next, 'submit', `the ${count}-step form must reach the submit, got ${result.quote_error}`);
    return page.ops.length;
  };

  // Measured at 15 after the contact fill was collapsed into one read and the repeated option/control
  // reads were memoized per step; it was 32 before. The bound guards that, not a target of its own.
  const perStep = (run(6) - run(2)) / 4;
  assert.ok(perStep <= 16, `a step must stay cheap, each costs ${perStep.toFixed(1)} ops`);
});

test('an option is not called selected until it is checked', () => {
  // Surveyed live: the step's radios do carry ids, so the label selector resolves — yet the form refused
  // to advance and re-rendered the same question twice (`advance_not_confirmed`). A bare click can fire
  // without checking anything, which is why the durable code used `click_verified`; the port dropped it
  // and reported a step as answered that the site had not accepted.
  const radios = [
    { text: 'Less than 2 hours', control: 'radio', group: 'g', id: '358106291091881998', checked: false },
    { text: 'A full day', control: 'radio', group: 'g', id: '358106304931029009', checked: false },
  ];
  const OPTIONS = `${ACTIVE} label:has(input[type="radio"]), ${ACTIVE} label:has(input[type="checkbox"])`;
  const dom = {
    h1: [{ text: 'x' }],
    body: [{ text: 'Request a quote' }],
    'aside button, main button': [{ text: 'Request estimate' }],
    'aside button:not(:last-child)': [{ text: 'Request estimate' }],
  };
  const page = makePage({
    href: PRO_URL,
    dom,
    afterNavigate: dom,
    onClick: (selector) => {
      if (selector.includes('aside')) {
        Object.assign(dom, { [ACTIVE]: [{ text: 'How much help do you need?' }], [OPTIONS]: radios });
        for (const row of radios) dom[`${ACTIVE} input[id="${row.id}"]`] = [{ text: row.text }];
        // A label wrapping the input is present, and clicking it does NOTHING — the site wants the input.
        for (const row of radios) dom[`${ACTIVE} label:has(input[id="${row.id}"])`] = [{ text: row.text }];
        dom[`${ACTIVE} button`] = [{ text: 'Next' }];
        dom[`${ACTIVE} button:not([aria-label])`] = [{ text: 'Next' }];
      } else if (selector.includes('label:has(')) {
        // The label is clickable and does nothing. Only the input itself checks the radio.
      } else if (selector.includes('input[id=')) {
        const id = selector.match(/input\[id="(\d+)"\]/)?.[1];
        for (const row of radios) if (row.id === id) row.checked = true;
      }
      page.dom = dom;
    },
  });
  page.dom = dom;
  installRpcStub(lua, page);
  lua.call('AX_RPC_QUOTE.request_quote', { quote_url: PRO_URL, user_requirements: 'a full day of work' });

  assert.ok(radios.some((row) => row.checked), 'the module must fall through to the input itself');
});

test('the CTA is clicked by its label when the client supports it', () => {
  // `dom.click_text` narrows by selector and picks by visible label, which is exactly the thing CSS could
  // not express: the button carries no id, no aria-label, no data-test and only hashed classes. When it
  // works there is no candidate ladder and no label re-check.
  const page = quotePage({ steps: [finalStep()] });
  delete page.dom['aside button:not(:last-child)'];
  page.dom['aside button, main button'] = [{ text: 'Share' }, { text: 'Request estimate' }];
  const result = drive(page);

  assert.equal(result.next, 'submit', `got ${result.quote_error} ${result.quote_message ?? ''}`);
  assert.ok(
    page.ops.some((entry) => entry.op === 'dom.click_text'),
    'the label op must be tried first',
  );
});

test('an op the client has not implemented falls back instead of failing', () => {
  // The platform shipped `click_text` and `read_many`; the SDK had not implemented either when this was
  // written, and a runtime op the client does not know simply fails. Adopting a new op must therefore
  // never be a bet: the structural ladder and the one-by-one reads stay as the floor.
  const page = quotePage({ steps: [finalStep()] });
  page.refuseOps = ['dom.click_text', 'dom.read_many'];
  const result = drive(page);

  assert.equal(result.next, 'submit', `got ${result.quote_error} ${result.quote_message ?? ''}`);
});

test('a step reads its options, controls and buttons in one round trip', () => {
  // Measured live at ~1s per op with a 120s ceiling, so op count is the feature budget. These reads all
  // describe the SAME instant, which is exactly what a batch is for.
  const page = quotePage({
    steps: [step('What do you need?', { choices: ['Shelf installation', 'Painting'] }), finalStep()],
  });
  drive(page);

  assert.ok(page.ops.some((entry) => entry.op === 'dom.read_many'), 'the step reads must be batched');
});

test('a stall reports what the form saw at one instant', () => {
  // The platform's suggestion, and the right one: read the radio's `checked` and the Next button's
  // `disabled` TOGETHER, so "selected but the form does not know" is one round trip away from
  // "selected and the form is refusing". A stall that only says `advance_not_confirmed` needs a survey.
  const bare = step('How much help?', { choices: ['A full day'] });
  bare.dom[`${ACTIVE} button`] = [{ text: 'Next', disabled: 'true' }];
  bare.dom[`${ACTIVE} button:not([aria-label])`] = [{ text: 'Next', disabled: 'true' }];
  // Nothing advances: the click is ignored and the real form submit is refused too, which is the shape
  // that needs explaining.
  const page = quotePage({ steps: [bare, bare, bare, bare], advanceOn: 'nothing' });
  const result = drive(page);

  assert.equal(result.quote_error, 'quote_stalled');
  assert.match(result.quote_message, /checked/, 'the option state must be in the answer');
  assert.match(result.quote_message, /disabled/, 'and so must the button state');
});

test('a step whose button click is ignored is submitted as a form', () => {
  // The SDK's own note on `dom.submit_form`: it calls `requestSubmit()`, "which fires the form's real
  // submit handler -- unlike a synthetic button click, which many SPAs ignore". Thumbtack's Next is a
  // `type=submit` inside `<form data-test="request-flow-step-form">`, so that is the second attempt.
  const stubborn = step('How much help?', { choices: ['A full day'] });
  // The button exists and reports a click, but only a real form submit advances this page.
  const page = quotePage({ steps: [stubborn, finalStep()], advanceOn: 'form' });
  const result = drive(page);

  assert.ok(
    page.ops.some((entry) => entry.op === 'dom.submit_form'),
    'the form must be submitted when the click did not confirm',
  );
  assert.equal(result.next, 'submit', `got ${result.quote_error}`);
});

test('an unimplemented op is tried once, not on every step', () => {
  // A refused op does not fail fast on the wire: it burns the full `opTimeoutMs`. Retrying it per step
  // spent the tool's whole deadline on ops the client will never answer — the live run died with
  // `deadline exceeded before dom.exists` after the batch and label ops were adopted.
  const page = quotePage({
    steps: [
      step('What do you need?', { choices: ['Shelf installation', 'Painting'] }),
      step('How much help?', { choices: ['A full day'] }),
      finalStep(),
    ],
  });
  page.refuseOps = ['dom.read_many', 'dom.click_text'];
  const result = drive(page);

  assert.equal(result.next, 'submit');
  for (const op of ['dom.read_many', 'dom.click_text']) {
    const tries = page.ops.filter((entry) => entry.op === op).length;
    assert.ok(tries <= 1, `${op} must be attempted at most once, saw ${tries}`);
  }
});

test('a dialog that disappears mid-form is its own answer', () => {
  // Live, the loop ended with `quote_steps_exhausted` and no advance reason at all — the wizard had
  // returned nil because the active step was gone. "Sixteen steps were not enough" and "the dialog closed
  // under us" are different facts and the second one names the page state.
  const page = quotePage({ steps: [step('What do you need?', { choices: ['Shelf installation'] })] });
  const result = drive(page);

  assert.equal(result.quote_error, 'quote_dialog_closed');
  assert.ok(result.quote_steps >= 1, 'the steps it did drive must be reported');
});

test('a form longer than the budget is reported, not killed', () => {
  // The platform's ceiling is 120s, so a long enough form cannot finish. Being killed mid-run surfaces
  // `lua rpc execution deadline exceeded before dom.exists`, which tells the user nothing and the
  // operator almost nothing. Stopping first does both. The budget is TIME now, so the fixture spends it:
  // `opCostMs` is the measured worst case (910ms), not a count.
  const many = [];
  for (let index = 0; index < 14; index += 1) many.push(step(`Question ${index}`, { choices: ['A full day', 'Painting'] }));
  many.push(finalStep());
  const page = quotePage({ steps: many });
  page.clockMs = 0;
  page.opCostMs = 910;
  const result = drive(page);

  assert.equal(result.quote_error, 'quote_budget_spent');
  assert.ok(result.quote_steps >= 4, `it must report the steps it drove, said ${result.quote_steps}`);
  assert.ok(page.ops.length <= 120, `and stop before the ceiling, spent ${page.ops.length}`);
});

test('an op the client never registered is recognised as permanent', () => {
  // The client answers an unregistered op with `command_unresolved` (axsdk-core `executeRpcOp`), NOT
  // `op_not_permitted` — that one is reserved for `page.eval` without its opt-in. Our detection keyed on
  // the wrong strings, so an op the extension will never answer was retried on every step, which is what
  // actually spent the deadline. The stub answers what the client answers.
  const page = quotePage({
    steps: [
      step('What do you need?', { choices: ['Shelf installation', 'Painting'] }),
      step('How much help?', { choices: ['A full day'] }),
      finalStep(),
    ],
  });
  page.unresolvedOps = ['dom.read_many', 'dom.click_text'];
  const result = drive(page);

  assert.equal(result.next, 'submit');
  for (const op of ['dom.read_many', 'dom.click_text']) {
    const tries = page.ops.filter((entry) => entry.op === op).length;
    assert.ok(tries <= 1, `${op} must be attempted at most once, saw ${tries}`);
  }
});

test('the other way Thumbtack says a pro is unavailable is also read', () => {
  // Measured live on a pro that had been quotable an hour earlier: the page now reads "This pro is
  // currently not available for Handyman". That is a second wording for the same fact, and the phrase list
  // only knew the first one ("Sorry this pro can't do your job"), so the flow reported a generic
  // `quote_unavailable` and the user learned nothing about why.
  const page = quotePage({ cta: 'View details', steps: [] });
  page.dom.body = [{
    text: 'RLC Handyman This pro is currently not available for Handyman. We know others who are. '
      + 'Tell us about your job and we will help you find the right pro.',
  }];
  const result = drive(page);

  assert.equal(result.quote_error, 'pro_unavailable');
  assert.match(result.quote_message, /currently not available for Handyman/);
});

test('a step that has not rendered yet is waited for, not called a closed dialog', () => {
  // Measured live: the run stopped with `dialog=true step_form=true` — the dialog and its form were both
  // still there and only the ACTIVE step marker was missing, between renders. Calling that "the dialog
  // closed" ended the form five steps in and named the wrong cause.
  const first = step('What do you need?', { choices: ['Shelf installation'] });
  const second = finalStep();
  const page = quotePage({ steps: [first, second] });

  // After the first advance the active step is missing for a few polls, while the dialog stays.
  let gapped = false;
  const origin = page.onClick;
  page.onClick = (selector) => {
    origin(selector);
    if (!gapped && selector.includes(ACTIVE) && selector.includes('button')) {
      gapped = true;
      const held = page.dom[ACTIVE];
      delete page.dom[ACTIVE];
      page.dom['[aria-label="Request Flow Dialog"]'] = [{ text: 'Request a quote' }];
      page.dom['[data-test="request-flow-step-form"]'] = [{ text: 'step form' }];
      // Long enough that a couple of retries cannot straddle it: the module has to WAIT.
      let polls = 0;
      const tick = page.tick;
      page.tick = () => { tick(); if (++polls === 12) page.dom[ACTIVE] = held; };
    }
  };
  const result = drive(page);

  assert.notEqual(result.quote_error, 'quote_dialog_closed');
  assert.ok(result.quote_steps >= 2, `the wizard must carry on, drove ${result.quote_steps}`);
});

test('a dialog that really is gone is still reported as gone', () => {
  const page = quotePage({ steps: [step('What do you need?', { choices: ['Shelf installation'] })] });
  const result = drive(page);

  assert.equal(result.quote_error, 'quote_dialog_closed');
  assert.match(result.quote_message, /dialog=false/);
});

test('the snapshot reports text, not markup', () => {
  // A live card put an `<img>` tag in the surface text and the whole report became a wall of HTML in the
  // user's reply. The snapshot is read by a person.
  const page = quotePage({ steps: [] , cta: 'View details' });
  page.dom.main = [{ text: 'Thumbtack handyman <img src="https://x/y.jpeg" alt=""/> AlorOriz' }];
  const result = drive(page);

  if (result.quote_message) {
    assert.ok(!result.quote_message.includes('<img'), `markup must be stripped: ${result.quote_message}`);
  }
});

test('running out of budget AT the submit step is arrival, not failure', () => {
  // Measured live: the wizard drove six steps and stopped with
  //   `buttons[Submit disabled=false; Back disabled=false] step_form=true`
  // — the LAST screen, which is exactly where this script is required to stop, since sending contacts a
  // real person. It reported `quote_budget_spent`, and the user was told the pro had FAILED. The budget
  // check sits at the top of the loop and answers before the arrival check below it can run, so the one
  // fact the snapshot already carried was thrown away. Arriving and then running out is arrival.
  const page = quotePage({ steps: [finalStep()] });
  // Spend the budget before the first step, the way a long form does before its last one.
  lua.define('AX_RPC_QUOTE.OP_BUDGET = 0');
  let result;
  try {
    result = drive(page);
  } finally {
    lua.define('AX_RPC_QUOTE.OP_BUDGET = 95');
  }

  assert.equal(result.quote_status, 'at_submit_step');
  assert.equal(result.next, 'submit');
  assert.notEqual(result.quote_error, 'quote_budget_spent');
});

test('an open dialog with no active step is not reported as closed', () => {
  // Measured live on a handyman pro: the run stopped with
  //   `dialog=true step_form=true surface="... Select a service Handyman Cabinetry Furniture Assembly ..."`
  // and called it `quote_dialog_closed`. The dialog was open — its own snapshot says so — showing a
  // service picker that is not a request-flow step. A status that contradicts the evidence printed beside
  // it sends the operator looking for a dismissal that never happened.
  const picker = {
    dom: {
      '[aria-label="Request Flow Dialog"]': [{ text: 'Select a service Handyman Cabinetry' }],
      '[data-test="request-flow-step-form"]': [{ text: 'Select a service' }],
    },
  };
  // The live run drove steps and THEN lost the marker, so the fixture must arrive the same way: a real
  // step first, and the picker only after it advances.
  const result = drive(quotePage({ steps: [step('How much help?', { choices: ['A full day'] }), picker] }));

  assert.notEqual(result.quote_status, 'dialog_closed');
  assert.match(result.quote_message ?? '', /dialog=true/);
});

test('a wait sleeps instead of buying latency with round trips', () => {
  // `pace()` was written on a false premise, stated in its own comment: "there is no wait op: the
  // runtime's vocabulary is reads and writes". The host has `rpc.sleep(ms)` — no round trip, no
  // `maxCalls` — and `rpc.now()` beside it. Every pace was two reads spent for their latency alone, at a
  // measured ~460ms each, on a budget that then stopped the form before it finished.
  const page = quotePage({ steps: [step('How much help?', { choices: ['A full day'] }), finalStep()] });
  drive(page);

  assert.ok(page.sleeps.length > 0, 'a wait must go through rpc.sleep');

  // `dom.exists` has legitimate uses, so the proof is comparative: the SAME drive on a runtime with no
  // host timer must spend more round trips, and the difference is what pacing used to cost. It has to be
  // the same `drive()` — comparing two runs with different arguments compares two different paths.
  const fallback = quotePage({ steps: [step('How much help?', { choices: ['A full day'] }), finalStep()] });
  // The stub is installed first: `installRpcStub` re-exposes `rpc`, so removing the timer before it
  // would simply be undone.
  installRpcStub(lua, fallback);
  lua.define('rpc.sleep = nil');
  try {
    lua.call('AX_RPC_THUMBTACK.request_quote', QUOTE_ARGS);
  } finally {
    lua.define('rpc.sleep = function() return true end');
  }
  assert.equal(fallback.sleeps.length, 0, 'the fallback must not have slept');
  assert.ok(
    page.ops.length < fallback.ops.length,
    `sleeping must cost fewer round trips than pacing: ${page.ops.length} vs ${fallback.ops.length}`,
  );
});

test('the budget is time, not a count of round trips', () => {
  // The count was a proxy for the deadline, calibrated when we believed an op cost ~1s. Measured, the
  // median is ~0.46s, so 95 round trips is under half of the 120s ceiling and the form stopped with the
  // deadline half unused. A clock makes the proxy unnecessary: stop when there is no time for another
  // step, whatever an op happens to cost today.
  const page = quotePage({ steps: [step('How much help?', { choices: ['A full day'] }), finalStep()] });
  // Ops and sleeps both advance this clock, so the budget runs out the way it does live.
  page.clockMs = 0;
  lua.define(`AX_RPC_QUOTE.TIME_BUDGET_MS = 1`);
  let result;
  try {
    result = drive(page);
  } finally {
    lua.define(`AX_RPC_QUOTE.TIME_BUDGET_MS = ${TIME_BUDGET_MS}`);
  }

  assert.equal(result.quote_error, 'quote_budget_spent');
  // And it stopped on TIME: nowhere near the old ninety-five.
  assert.ok(page.ops.length < 40, `must stop on the clock, spent ${page.ops.length} round trips`);
});

test('a long form is no longer stopped by an op count the deadline never needed', () => {
  // The same form that ran out at six steps. With time as the budget and a clock that has barely moved,
  // the wizard must keep going past the old cap rather than stop with the deadline unused.
  const many = [];
  for (let index = 0; index < 12; index += 1) many.push(step(`Question ${index}`, { choices: ['A full day'] }));
  many.push(finalStep());
  const page = quotePage({ steps: many });
  page.clockMs = 0;
  const result = drive(page);

  assert.equal(result.next, 'submit', `stopped early: ${result.quote_error ?? result.quote_status}`);
  assert.ok(page.ops.length > 95, `the old cap must no longer bind, spent ${page.ops.length}`);
});

test('a wizard that stops reports the question it stopped on', () => {
  // Live, twice: the wizard drove four steps once and eight the next, then the dialog went away and the
  // report was the pro's PROFILE text — "Elmer Deleon Painting ... Select a service Handyman Interior
  // Painting ...". That says where the browser ended up and nothing about where the WIZARD was, so the
  // failure cannot be diagnosed without re-running it and watching. The answers are already tracked; they
  // just never reached the report.
  const page = quotePage({
    steps: [
      step('What kind of help?', { choices: ['Painting'] }),
      step('How large is the job?', { choices: ['A full day'] }),
    ],
  });
  // After the second step the site drops the dialog instead of showing another step.
  const result = drive(page);

  assert.equal(result.quote_status, 'dialog_closed');
  // What it answered, so the next question is "why did THAT end the flow" and not "what happened".
  assert.match(result.quote_answered ?? '', /Painting/);
  assert.match(result.quote_answered ?? '', /A full day/);
  // And the last question it saw, which the surface text cannot supply once the step is gone.
  assert.match(result.quote_last_step ?? '', /How large is the job/);
});

test('a blank surface is a page in transition, not a closed dialog', () => {
  // The diagnosis the trail bought us. Live, after answering five steps:
  //   dialog=false step_form=false surface=""
  //   last question: "How often do you want the house cleaned? ..."
  // An empty surface is not a dismissed dialog — a dismissed dialog leaves the pro's PROFILE behind, and
  // an earlier run reported exactly that text. Nothing at all means the document is between renders, and
  // calling that "closed" abandons a form that was still going.
  assert.equal(lua.call('AX_RPC_QUOTE.classify_absence', true, false, 'anything'), 'standing');
  assert.equal(lua.call('AX_RPC_QUOTE.classify_absence', false, true, ''), 'standing');
  assert.equal(lua.call('AX_RPC_QUOTE.classify_absence', false, false, ''), 'transitional');
  assert.equal(lua.call('AX_RPC_QUOTE.classify_absence', false, false, '   '), 'transitional');
  // A real surface with no dialog is the dismissal we already reported correctly.
  assert.equal(
    lua.call('AX_RPC_QUOTE.classify_absence', false, false, 'Elmer Deleon Painting Select a service'),
    'closed',
  );
});

test('a transition is waited out before the form is abandoned', () => {
  // Waiting costs a `rpc.sleep`, not round trips, so re-checking is nearly free — which is exactly why
  // giving up on the first blank read is indefensible now.
  const page = quotePage({ steps: [step('How often?', { choices: ['Just once'] })] });
  const result = drive(page);

  assert.equal(result.quote_status, 'dialog_closed');
  assert.ok(
    page.sleeps.length >= 2,
    `a transition must be waited out before giving up, slept ${page.sleeps.length} times`,
  );
});

test('waiting for a step to come back is bounded by the budget, not by three', () => {
  // Live: the wizard answered bedrooms and bathrooms, the next step did not render, and it gave up after
  // three attempts — about twenty-four seconds against a hundred-second budget. Checked straight after,
  // the dialog was open on "What kind of cleaning do you need?" with Next and Back. An arbitrary attempt
  // count is the same proxy we just removed from the budget itself: the deadline already says when to
  // stop, and waiting now costs a host sleep rather than round trips.
  const page = quotePage({ steps: [step('How many bathrooms?', { choices: ['1 bathroom'] })] });
  const result = drive(page);

  // Reported, not just done: a stop that says how long it waited is the difference between "gave up at
  // once" and "waited and the page never came back", and the live report could not tell those apart.
  assert.ok(
    (result.quote_absence_waits ?? 0) > 3,
    `an ample budget must outlast three attempts, waited ${result.quote_absence_waits}`,
  );

  // And an exhausted budget still stops promptly — the budget is what bounds it now.
  const short = quotePage({ steps: [step('How many bathrooms?', { choices: ['1 bathroom'] })] });
  short.clockMs = 0;
  lua.define('AX_RPC_QUOTE.TIME_BUDGET_MS = 1');
  let brief;
  try {
    brief = drive(short);
  } finally {
    lua.define(`AX_RPC_QUOTE.TIME_BUDGET_MS = ${TIME_BUDGET_MS}`);
  }
  assert.ok((brief.quote_absence_waits ?? 0) <= 1, `spent budget must stop at once, waited ${brief.quote_absence_waits}`);
});

test('a wait is never started that the remaining budget cannot finish', () => {
  // The first attempt derived the cap from the WHOLE budget — twelve eight-second waits — and ignored the
  // thirty seconds already spent driving. Live, the tool was killed by the platform:
  //   "lua rpc execution deadline exceeded while waiting"
  // which is exactly the sentence the budget exists to replace. What bounds a wait is the time LEFT, so
  // the rule is a function of the remainder and is pinned here rather than inferred from a stub whose
  // waits cost nothing.
  // Waiting may take at most a SHARE of what is left. Live, with the whole remainder available, twelve
  // eight-second waits consumed the budget that driving needed and the platform killed the call twice —
  // `deadline exceeded while waiting`, then `before dom.read_many`. A step that has not come back after a
  // third of the remaining time is not coming back inside this invocation.
  assert.equal(lua.call('AX_RPC_QUOTE.wait_allowance', 100000), 5);
  assert.equal(lua.call('AX_RPC_QUOTE.wait_allowance', 60000), 3);
  assert.equal(lua.call('AX_RPC_QUOTE.wait_allowance', 20000), 1);
  // No room for even one wait: starting it would be the kill we are avoiding.
  assert.equal(lua.call('AX_RPC_QUOTE.wait_allowance', 5000), 0);
  assert.equal(lua.call('AX_RPC_QUOTE.wait_allowance', -1), 0);
  // No host clock: fall back to the count we have already run in production rather than guess bigger.
  assert.equal(lua.call('AX_RPC_QUOTE.wait_allowance'), 3);
});

test('a stop says whether it had a clock to budget with', () => {
  // Two live runs were killed by the platform after the budget became time-based, and the report cannot
  // say why: with no `rpc.now` every time decision silently falls back to counting round trips, waits
  // fall back to three, and `pace` goes back to buying latency with reads. Those are the same symptoms as
  // a budget that is simply too large, and guessing between them costs a three-minute live run each time.
  const page = quotePage({ steps: [step('How much help?', { choices: ['A full day'] }), finalStep()] });
  const result = drive(page);
  assert.equal(result.quote_clock, true);

  const blind = quotePage({ steps: [step('How much help?', { choices: ['A full day'] }), finalStep()] });
  installRpcStub(lua, blind);
  lua.define('rpc.now = nil');
  let without;
  try {
    without = lua.call('AX_RPC_THUMBTACK.request_quote', QUOTE_ARGS);
  } finally {
    lua.define('rpc.now = function() return 0 end');
  }
  assert.equal(without.quote_clock, false);
});
