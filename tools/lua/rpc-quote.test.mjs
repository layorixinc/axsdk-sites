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

const drive = (page, args = {}) => {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_THUMBTACK.request_quote', {
    quote_url: PRO_URL,
    user_requirements: 'one-time house cleaning',
    submit_first_name: 'AX',
    submit_last_name: 'Tester',
    submit_email: 'thumbtack-test@example.com',
    submit_phone: '415-555-0123',
    zip_code: '94101',
    ...args,
  });
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
  // The platform's ceiling is 120s and an op costs ~1s on the current client, so a long enough form cannot
  // finish. Being killed mid-run surfaces `lua rpc execution deadline exceeded before dom.exists`, which
  // tells the user nothing and the operator almost nothing. Stopping first does both.
  const many = [];
  for (let index = 0; index < 14; index += 1) many.push(step(`Question ${index}`, { choices: ['A full day', 'Painting'] }));
  many.push(finalStep());
  const page = quotePage({ steps: many });
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
