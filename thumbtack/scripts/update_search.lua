local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before update_search.lua")
end

-- Change a search filter (service option) on the search-results screen, then re-read the results.
-- args.value (or args.choice): the option choice text to select, e.g. "Every week".
-- args.option (or args.group): optional group title for the caller's reference.
function AX_update_search(args)
  args = args or {}
  local value = M.non_empty(args.value or args.choice or args.option_value)
  if not value then
    return {
      error = "missing_value"
    }
  end
  local group = M.non_empty(args.option or args.group or args.title)

  if not M.is_results_page() then
    return {
      error = "not_on_results",
      message = "Run AX_search_service first to reach the results screen."
    }
  end

  M.dismiss_modals()

  local selected = M.select_service_option(value)
  if not selected.ok then
    return {
      error = selected.error or "option_not_found",
      value = value,
      group = group,
      service_options = M.read_service_options()
    }
  end

  dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = 30000 })
  M.dismiss_modals()
  local candidates = M.read_search_candidates()

  return {
    ok = true,
    updated = value,
    group = group,
    service_options = M.read_service_options(),
    candidates = candidates,
    total_count = #candidates,
    cursor = false
  }
end
