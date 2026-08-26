// Shipping-CDP regression for the public Thumbtack quote journey.
// Across the suite it proves multi-turn state retention, deterministic candidate selection, wizard drive,
// and a final safe-boundary stop with no send tool.
import { FLOW_TOOLS, turnFault } from './turn-fault.mjs';
import { pathToFileURL } from 'node:url';

const nameMatches = (name, suffix) => name === suffix || name?.endsWith(`.${suffix}`);

export function decode(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function findCall(toolCalls, suffix) {
  return (toolCalls || []).findLast((call) => nameMatches(call?.name, suffix));
}

export function outputOf(toolCalls, suffix) {
  return decode(findCall(toolCalls, suffix)?.output);
}

export function searchReachedCandidates(turn) {
  const calls = turn?.toolCalls || [];
  return findCall(calls, 'search_service')?.status === 'completed'
    && outputOf(calls, 'prepare_service_results_table')?.next === 'render'
    && outputOf(calls, 'present_service_results')?.next === 'ask'
    && /ax-widget|전문가|professional/i.test(String(turn?.text || ''));
}

export function collectionRetained(first, second) {
  const firstCalls = first?.toolCalls || [];
  const secondCalls = second?.toolCalls || [];
  return outputOf(firstCalls, 'present_quote_collection')?.next === 'ask'
    && outputOf(secondCalls, 'present_quote_collection')?.next === 'resume'
    && !findCall(secondCalls, 'detect_cancellation')
    && !findCall(secondCalls, 'recall_saved_contact')
    && outputOf(secondCalls, 'verify_request')?.next === 'ok'
    && searchReachedCandidates(second);
}

export function candidateSelectionPassed(rankTurn, selectionTurn) {
  const ranked = findCall(rankTurn?.toolCalls, 'browse_service_candidates');
  const selected = outputOf(selectionTurn?.toolCalls, 'browse_service_candidates');
  const prepared = outputOf(selectionTurn?.toolCalls, 'prepare_refined_results_table');
  const presented = outputOf(selectionTurn?.toolCalls, 'present_refined_results');
  return ranked?.status === 'completed'
    && /번호로 선택|choose by number/i.test(String(rankTurn?.text || ''))
    && selected?.next === 'done'
    && prepared?.next === 'render'
    && presented?.next === 'ask'
    && /Selected Thumbtack professionals|선택한 전문가/i.test(String(selectionTurn?.text || ''));
}

export function wizardStoppedBeforeSubmit(turn) {
  const calls = turn?.toolCalls || [];
  const opened = outputOf(calls, 'open_quote');
  const safeBoundary = opened?.quote_reached_submit === true
    || opened?.quote_advance_reason === 'contact_boundary';
  return findCall(calls, 'open_quote')?.status === 'completed'
    && opened?.next === 'submit'
    && safeBoundary
    && Number(opened?.quote_steps) > 0
    && !findCall(calls, 'submit_quote')
    && /(?:보내지|전송되지|연락하지|연락되지|not sent|no professional was contacted)/i.test(String(turn?.text || ''));
}

export function cancellationContactedNobody(turn) {
  const calls = turn?.toolCalls || [];
  const cancelled = [
    outputOf(calls, 'present_quote_collection'),
    outputOf(calls, 'browse_service_candidates'),
    outputOf(calls, 'confirm_quote_decision'),
    outputOf(calls, 'detect_cancellation'),
  ].some((output) => output?.next === 'cancel');
  return cancelled
    && !findCall(calls, 'open_quote')
    && !findCall(calls, 'submit_quote');
}

function evidence(turn) {
  return (turn?.toolCalls || []).map((call) => {
    const output = decode(call.output);
    return `${call.name}(${call.status}${output?.next ? `:${output.next}` : ''})`;
  }).join(' -> ');
}

async function send(session, label, text, timeoutMs = 300_000, expects = FLOW_TOOLS.quote) {
  const turn = await session.send(text, { timeoutMs });
  console.log(`\n[${label}] ${(turn.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  tools: ${evidence(turn) || '(none)'}`);
  console.log(`  reply: ${String(turn.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  // A turn the quote flow never received is not a quote defect — and this suite's failures are the ones
  // most likely to be read as "Thumbtack broke" (`turn-fault.mjs`).
  const fault = turnFault({ toolCalls: turn.toolCalls, failure: null }, { expects });
  if (fault) console.log(`  fault: ${fault.kind} — ${fault.detail}`);
  return { ...turn, fault };
}

async function resetSession(session, label) {
  let failure;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await session.reset();
      return;
    } catch (error) {
      failure = error;
      console.log(`RESET ${label} attempt ${attempt}/2 failed: ${error?.message || error}`);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw failure;
}

async function main() {
  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const session = await openCdpSession({ url: 'https://www.thumbtack.com/' });
  const checks = [];
  const check = (label, ok, detail = '') => {
    checks.push([label, Boolean(ok), detail]);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    await resetSession(session, 'house cleaning');
    const collection = await send(
      session,
      'house cleaning 94101 — collect',
      '샌프란시스코 94101에서 집 청소 견적 받아줘. 다음 주에 아파트 전체 청소가 필요해요.',
      180_000,
    );
    const searched = await send(
      session,
      'house cleaning 94101 — contact',
      '이름은 길동, 성은 홍, 이메일은 thumbtack-test@example.com, 전화번호는 415-555-0142예요.',
    );
    check('house cleaning 94101 retains service, requirements, ZIP, and contact', collectionRetained(collection, searched));
    const houseCancelled = await send(session, 'house cleaning 94101 — cancel', '취소', 120_000);
    check('house cleaning 94101 cancellation contacts nobody', cancellationContactedNobody(houseCancelled));

    await resetSession(session, 'handyman');
    const handyman = await send(
      session,
      'handyman 94103',
      '샌프란시스코 94103에서 핸디맨 견적 받아줘. 48시간 안에 선반 설치가 필요해요. 이름은 길동, 성은 홍, 이메일은 thumbtack-test@example.com, 전화번호는 415-555-0143예요.',
    );
    check('handyman 94103 reaches classified live candidates', searchReachedCandidates(handyman));
    const ranked = await send(session, 'handyman — rank', '평점 높은 순', 120_000);
    const selected = await send(session, 'handyman — select', '1번, 2번, 3번', 120_000);
    check('candidate selection resolves live numbered pros', candidateSelectionPassed(ranked, selected));
    const wizard = await send(session, 'handyman — safe wizard', '예', 300_000);
    check('wizard stops at the final safe boundary without sending', wizardStoppedBeforeSubmit(wizard));

    await resetSession(session, 'lawn mowing');
    const lawn = await send(
      session,
      'lawn mowing 94101',
      '샌프란시스코 94101에서 잔디 깎기 견적 받아줘. 이번 주에 앞마당을 한 번 깎아야 해요. 이름은 길동, 성은 홍, 이메일은 thumbtack-test@example.com, 전화번호는 415-555-0144예요.',
    );
    check('lawn mowing 94101 reaches classified live candidates', searchReachedCandidates(lawn));
    const lawnCancelled = await send(session, 'lawn mowing 94101 — cancel', '취소', 120_000);
    check('lawn mowing 94101 cancellation contacts nobody', cancellationContactedNobody(lawnCancelled));

    const passed = checks.filter(([, ok]) => ok).length;
    console.log(`\nTHUMBTACK QUOTE ${passed}/${checks.length} PASS`);
    for (const [label, ok, detail] of checks) {
      if (!ok) console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
    process.exitCode = passed === checks.length ? 0 : 1;
  } finally {
    await session.reset().catch(() => {});
    await session.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
