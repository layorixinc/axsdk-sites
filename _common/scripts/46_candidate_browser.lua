-- Deterministic browsing over a service-candidate list (Thumbtack pros).
--
-- Before this existed the model received the whole candidate array in its prompt, ranked it itself, and
-- re-emitted the chosen pros field by field — prompt cost grew with the result set and the ranking was
-- only as reproducible as the model. Here the model relays the user's sentence and the numbers they
-- picked; filtering, ranking, windowing, and selection are decided from the data.
--
-- Pure apart from its argument list, so the whole contract is unit tested offline
-- (tools/lua/candidate-browsing.test.mjs).

local V = AX_OFFER_VIEW
if not V then
  error("_common/scripts/45_offer_view.lua must be loaded before 46_candidate_browser.lua")
end

AX_CANDIDATE_BROWSER = AX_CANDIDATE_BROWSER or {}
local N = AX_CANDIDATE_BROWSER
N.DEFAULT_PAGE_SIZE = 5

local function array()
  if ax and type(ax.array) == "function" then return ax.array() end
  return {}
end

local function trim(value)
  return (tostring(value or ""):gsub("^%s+", ""):gsub("%s+$", ""))
end

--- Parses "2, 4" / "2번 4번" / "2 and 4" into ascending, de-duplicated positions.
function N.parse_choice_numbers(value)
  local numbers = array()
  local seen = {}
  for token in tostring(value or ""):gmatch("%d+") do
    local number = tonumber(token)
    if number and not seen[number] then
      seen[number] = true
      numbers[#numbers + 1] = number
    end
  end
  table.sort(numbers)
  return numbers
end

local CANCEL_MARKERS = { "취소", "그만", "안 할래", "안할래", "cancel", "stop" }
local PAGE_COMMANDS = {
  { { "다음", "next", "more", "더 보여" }, "next" },
  { { "이전", "prev", "previous", "뒤로" }, "prev" },
  { { "처음", "first" }, "first" },
  { { "마지막", "last" }, "last" }
}

--- What the user's own reply means. The browser interprets it directly: with a model in this loop the
--- same criterion was re-sent forever, because the model only ever saw the user's unchanged message.
function N.classify_reply(text)
  local value = trim(text)
  if value == "" then return { kind = "none" } end
  local lowered = value:lower()
  for index = 1, #CANCEL_MARKERS do
    if lowered:find(CANCEL_MARKERS[index], 1, true) then return { kind = "cancel" } end
  end
  for index = 1, #PAGE_COMMANDS do
    local markers, command = PAGE_COMMANDS[index][1], PAGE_COMMANDS[index][2]
    for marker_index = 1, #markers do
      if lowered:find(markers[marker_index], 1, true) then return { kind = "page", page_command = command } end
    end
  end
  -- A page number ("3페이지") is a move; any other number is a pick.
  local page_number = tonumber(lowered:match("(%d+)%s*페이지") or lowered:match("page%s*(%d+)"))
  if page_number then return { kind = "page", page_number = page_number } end
  if #N.parse_choice_numbers(value) > 0 then return { kind = "choice", choice_numbers = value } end
  return { kind = "refine", refine_request = value }
end

--- One browsing turn over the searched pros: rank, window, and (when numbers are given) select.
--- The rendered window is returned as `question` so the flow pauses on it and waits for the user.
function AX_browse_service_candidates(args)
  args = args or {}
  local candidates = args.candidates or {}
  if #candidates == 0 then
    return { next = "error", refine_error = "no_candidates", view_total = 0 }
  end

  -- An explicit argument wins; otherwise the user's latest message is the instruction.
  local reply = N.classify_reply(args.request_text)
  if reply.kind == "cancel" then return { next = "cancel" } end

  local page_size = math.max(1, math.floor(tonumber(args.page_size) or N.DEFAULT_PAGE_SIZE))
  local request = trim(args.refine_request)
  if request == "" and reply.kind == "refine" then request = reply.refine_request end
  local choice_numbers = trim(args.choice_numbers)
  if choice_numbers == "" and reply.kind == "choice" then choice_numbers = reply.choice_numbers end
  local page_command = trim(args.page_command)
  if page_command == "" and reply.kind == "page" then page_command = trim(reply.page_command) end
  local page_number = tonumber(args.page_number) or (reply.kind == "page" and reply.page_number or nil)

  local parsed = request ~= "" and V.parse_candidate_refine(request) or { filters = {}, sort = nil }
  local filters = parsed.reset and {} or parsed.filters
  local sort = parsed.reset and "rating_desc" or parsed.sort

  local shortlist = V.apply_candidates(candidates, { filters = filters, sort = sort })
  local refine_error = nil
  if #shortlist == 0 then
    -- Never strand the user with an empty list: the previous ranking stands and the miss is reported.
    refine_error = "no_matches"
    shortlist = V.apply_candidates(candidates, { sort = sort })
  end

  local page = V.resolve_page(
    tonumber(args.page) or 1,
    page_command ~= "" and page_command or nil,
    page_number,
    math.max(1, math.ceil(#shortlist / page_size))
  )

  local function window(extras)
    local view = V.render_candidates(shortlist, { page = page, page_size = page_size })
    local answer = {
      next = "ask",
      question = view.text,
      shortlist = shortlist,
      shortlist_text = view.text,
      refine_request = request ~= "" and request or nil,
      view_page = view.page,
      view_pages = view.pages,
      view_total = view.total
    }
    for key, value in pairs(extras or {}) do answer[key] = value end
    return answer
  end

  local choices = N.parse_choice_numbers(choice_numbers)
  if #choices > 0 and refine_error == nil then
    local selected = array()
    for index = 1, #choices do
      local pick = shortlist[choices[index]]
      if not pick then
        return window({ refine_error = "invalid_choice" })
      end
      selected[#selected + 1] = {
        service_id = pick.service_id,
        name = pick.name,
        url = pick.url,
        rating = pick.rating,
        review_count = pick.review_count,
        price_text = pick.price_text,
        response_time = pick.response_time,
        why = request ~= "" and request or "사용자가 선택한 전문가"
      }
    end
    return {
      next = "done",
      refine_selected = selected,
      selected_count = #selected,
      view_total = #shortlist
    }
  end

  return window({ refine_error = refine_error })
end
