/**
 * Which live-turn failures belong to the harness or the planner rather than to the product.
 *
 * Measured across this stretch: a turn fails because the backend never opened a session, because the
 * engine answered with NO node at all, or because the planner routed the message into another flow (10 of
 * 24 pick turns before the example-collision fix, 1 of 16 after). Reported as one label they read like a
 * defect in whatever the runner was testing, and one of those investigations went to the wrong repo.
 *
 * `expects` names the tools that mean "the flow under test ran". A runner that names none never reports a
 * misroute — the memory hook runs on every turn and would otherwise look like the flow under test on one
 * runner and like a misroute on another.
 */
export function turnFault({ toolCalls = [], failure = null } = {}, { expects = [] } = {}) {
  const names = (toolCalls ?? []).map((call) => call?.name ?? '');
  const reached = names.join(' -> ');
  if (failure && /open a (fresh )?session|backend to open/i.test(failure)) {
    return { kind: 'session', retry: true, detail: failure };
  }
  // A turn that produced tool calls and then ran out of time produced EVIDENCE. Re-running throws it away.
  if (failure) return { kind: 'stalled', retry: false, detail: `${failure}${reached ? ` after ${reached}` : ''}` };
  if (names.length === 0) return { kind: 'no-node', retry: true, detail: 'the engine answered with no node at all' };
  if (expects.length > 0 && !names.some((name) => expects.some((prefix) => name.startsWith(prefix)))) {
    return { kind: 'misroute', retry: true, detail: reached || 'no flow tool ran' };
  }
  return null;
}

/** The tools that mean each flow ran, so a runner states its expectation instead of guessing. */
export const FLOW_TOOLS = {
  singleSite: ['shopping_single_site', 'shopping_search_product', 'shopping_add_to_cart', 'enter_shopping_site'],
  multiStore: ['shopping_multi_store_total_cost', 'shopping_prefill_total_cost_request', 'shopping_collect_store_page',
    'shopping_search_one_store', 'shopping_rank_store_offers', 'shopping_present_store_offers'],
  checkout: ['checkout', 'enter_checkout_site', 'shopping_checkout'],
  quote: ['request_service_quote', 'search_service', 'browse_service_candidates', 'open_quote', 'quote'],
  memory: ['memory', 'capture_memory_clause', 'write_captured_memory', 'recall_saved_contact'],
};
