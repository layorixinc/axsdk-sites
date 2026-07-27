-- Deterministic result-page planning shared by every storefront adapter.
--
-- A site's own paging mechanics (a query parameter, a row offset, a "next" control) are declared in the
-- site config; this module turns "I want page N" into either concrete request parameters or an explicit
-- refusal, accumulates candidates across pages, and owns the rules that stop the loop. It touches no
-- browser capability so it can be unit tested offline (tools/lua/pagination.test.mjs).

AX_PAGINATION = AX_PAGINATION or {}
local P = AX_PAGINATION

-- First cut: at most two result pages per store. Raising this multiplies both wall-clock time and the
-- worker's remote-call budget, so it is a per-site opt-in, not a default.
P.DEFAULT_MAX_PAGES = 2
P.DEFAULT_TARGET_CANDIDATES = 9

local function to_int(value, fallback)
  local numeric = tonumber(value)
  if not numeric then return fallback end
  return math.floor(numeric)
end

--- Page cap for a site: its own `max_pages`, clamped to at least one, else the conservative default.
function P.max_pages(config)
  if type(config) ~= "table" then return 1 end
  return math.max(1, to_int(config.max_pages, P.DEFAULT_MAX_PAGES))
end

--- How to reach page `page`. Never invents a URL shape: a site without config stays single-page.
function P.plan_page(config, page)
  local requested = math.max(1, to_int(page, 1))
  if requested == 1 then
    return { supported = true, needs_navigation = false, page = 1, params = {}, mode = config and config.mode or "none" }
  end
  if type(config) ~= "table" or type(config.mode) ~= "string" then
    return { supported = false, needs_navigation = false, page = requested, error = "pagination_unsupported" }
  end
  if requested > P.max_pages(config) then
    return { supported = false, needs_navigation = false, page = requested, error = "page_out_of_range" }
  end

  if config.mode == "click" then
    local selector = config.next_selector
    if type(selector) ~= "string" or selector == "" then
      return { supported = false, needs_navigation = false, page = requested, error = "pagination_unsupported" }
    end
    return { supported = true, needs_navigation = true, page = requested, mode = "click", selector = selector, params = {} }
  end

  local param = config.param
  if type(param) ~= "string" or param == "" then
    return { supported = false, needs_navigation = false, page = requested, error = "pagination_unsupported" }
  end

  local params = {}
  if config.mode == "offset" then
    local step = to_int(config.step, 24)
    params[param] = to_int(config.start, 0) + ((requested - 1) * step)
  else
    local start = to_int(config.start, 1)
    local step = to_int(config.step, 1)
    params[param] = start + ((requested - 1) * step)
  end
  return { supported = true, needs_navigation = true, page = requested, mode = config.mode, params = params }
end

--- Appends a page's rows to the accumulator, dropping ids already seen and stamping provenance.
function P.merge_pages(accumulated, incoming, page)
  local items = {}
  local seen = {}
  for index = 1, #(accumulated or {}) do
    local item = accumulated[index]
    local id = item and item.product_id
    items[#items + 1] = item
    if id ~= nil and id ~= "" then seen[tostring(id)] = true end
  end

  local added = 0
  local source_page = math.max(1, to_int(page, 1))
  for index = 1, #(incoming or {}) do
    local item = incoming[index]
    local id = item and item.product_id
    if id ~= nil and id ~= "" and not seen[tostring(id)] then
      seen[tostring(id)] = true
      item.source_page = item.source_page or source_page
      items[#items + 1] = item
      added = added + 1
    end
  end

  return { items = items, added = added }
end

--- Whether to read one more page. Every stop names itself so a thin comparison can explain why.
function P.should_continue(state)
  state = state or {}
  local collected = to_int(state.collected, 0)
  local target = to_int(state.target, P.DEFAULT_TARGET_CANDIDATES)
  local page = math.max(1, to_int(state.page, 1))
  local max_pages = math.max(1, to_int(state.max_pages, P.DEFAULT_MAX_PAGES))
  local added = to_int(state.added, 0)
  local remote_used = to_int(state.remote_used, 0)
  local remote_budget = to_int(state.remote_budget, 0)

  if collected >= target then return { continue = false, reason = "target_reached" } end
  -- Only an explicit "there is more" continues: an adapter that could not tell (nil) must not cost a
  -- navigation on a guess.
  if state.has_more ~= true then return { continue = false, reason = "no_more_pages" } end
  if page >= max_pages then return { continue = false, reason = "page_cap" } end
  if remote_budget > 0 and remote_used >= remote_budget then
    return { continue = false, reason = "budget_exhausted" }
  end
  -- A page that added nothing while earlier pages did means the site is repeating itself. With nothing
  -- collected yet it means page one was all noise, and the next page is exactly what the user needs.
  if added <= 0 and collected > 0 then return { continue = false, reason = "no_new_results" } end
  return { continue = true, reason = "continue" }
end
