-- The cart LISTING surface: read the store's cart, render it as a numbered window, and read the user's
-- reply. Nothing here touches the page beyond the read, and nothing here removes anything — the removal is
-- `AX_RPC_CART.remove_from_cart`, one node further on, behind the marker this module writes.
--
-- Why the loop has no model node: §13 records a live turn where the user typed 취소 and an offer was ADDED
-- TO CART, because a model gate downstream re-sent the previous turn's "3번". So the presenter renders,
-- pauses on its own question, and classifies the reply itself — through the SAME reader the Thumbtack
-- shortlist and the offers window use, so all three loops answer 취소 the same way.

AX_RPC_CART_VIEW = AX_RPC_CART_VIEW or {}
local V = AX_RPC_CART_VIEW

local R = AX_RPC_CART
if not R then
  error("_common/rpc/67_rpc_cart.lua must be loaded before 74_rpc_cart_view.lua")
end

local N = AX_CANDIDATE_BROWSER
if not N then
  error("_common/scripts/46_candidate_browser.lua must be loaded before 74_rpc_cart_view.lua")
end

local MAX_LINES = 12
local LABEL_WIDTH = 76

local function trim(value)
  if type(value) ~= "string" then return nil end
  local text = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text ~= "" and text or nil
end

local function codec()
  if type(json) ~= "table" then return nil end
  if type(json.encode) ~= "function" or type(json.decode) ~= "function" then return nil end
  return json
end

--- The listing as one string, or nil when there is nothing to carry.
---
--- It travels as JSON text and not as a table because an empty Lua table encodes as `{}` and a schema
--- expecting an array rejects it (§13, four boundaries deep). One scalar has no such shape to disagree
--- about, and flow state is the only channel that survives a turn: module globals do not.
local function encode(state)
  local codecs = codec()
  if not codecs or type(state) ~= "table" then return nil end
  local ok, text = pcall(codecs.encode, {
    site = state.site,
    lines = state.lines,
    cart_count = state.cart_count,
  })
  if not ok then return nil end
  return text
end

local function decode(text)
  local codecs = codec()
  if not codecs or type(text) ~= "string" or text == "" then return nil end
  local ok, value = pcall(codecs.decode, text)
  if not ok or type(value) ~= "table" or type(value.lines) ~= "table" then return nil end
  if #value.lines == 0 then return nil end
  return value
end

local STORE_NAMES = {
  amazon = "Amazon", ebay = "eBay", walmart = "월마트", aliexpress = "AliExpress",
  etsy = "Etsy", coupang = "쿠팡", ["naver-shopping"] = "네이버쇼핑", gmarket = "지마켓",
  ["11st"] = "11번가", ssg = "SSG",
}

--- The window the user reads. A text surface: no markup, and the ids are never shown — a number is what
--- the user answers with, and a number is what resolves.
function V.render(state, note)
  local label = STORE_NAMES[state.site] or state.site or "장바구니"
  local out = {}
  if note then out[#out + 1] = note end
  out[#out + 1] = label .. " 장바구니 " .. tostring(#state.lines) .. "건"
  for index = 1, #state.lines do
    local line = state.lines[index]
    local text = trim(line.title) or ("상품 " .. tostring(line.product_id or index))
    if #text > LABEL_WIDTH then text = text:sub(1, LABEL_WIDTH) end
    out[#out + 1] = tostring(index) .. ". " .. text
  end
  out[#out + 1] = "지울 항목의 번호를 알려주세요. 취소라고 하시면 아무것도 지우지 않습니다."
  return table.concat(out, "\n")
end

--- Reads the store's cart and packs the lines for the turn that will show them.
---
--- The keys are its own, never the reader's envelope: a pass-through would publish a dozen fields the flow
--- does not declare, and an undeclared field is a dropped field.
function V.open(args)
  args = type(args) == "table" and args or {}
  local read = R.read_cart(args)
  if read.next ~= "ok" then
    return {
      next = read.next,
      site = read.site,
      error = read.error,
      status = read.status,
      cart_count = read.cart_count,
    }
  end

  local lines = read.lines
  if #lines > MAX_LINES then
    local trimmed = {}
    for index = 1, MAX_LINES do trimmed[index] = lines[index] end
    lines = trimmed
  end

  local state = { site = read.site, lines = lines, cart_count = read.cart_count }
  local carried = encode(state)
  if not carried then
    -- Without an encoder the listing cannot survive its own question, and a window whose numbers resolve
    -- to nothing is worse than saying so.
    return { next = "error", site = read.site, error = "cart_state_unavailable" }
  end
  return {
    next = "show",
    site = read.site,
    cart_count = read.cart_count,
    cart_state = carried,
  }
end

--- One turn of the listing: render and pause, or read the reply and resolve it.
function V.present(args)
  args = type(args) == "table" and args or {}
  local state = decode(args.cart_state)
  if not state then
    return { next = "error", error = "cart_lost" }
  end

  -- The first pass has not asked anything yet, so there is no reply to read: rendering and pausing is the
  -- whole of it. `choice_stage` is what tells the two passes apart — the same mechanism the offers window
  -- uses, and the reason a reply is never attributed to a question that was never asked.
  if trim(args.choice_stage) ~= "await_choice" then
    return {
      next = "ask",
      question = V.render(state),
      choice_stage = "await_choice",
      cart_state = args.cart_state,
      cart_count = state.cart_count,
      site = state.site,
    }
  end

  local reply = N.current_user_text(args)
  local verdict = N.classify_reply(reply)

  if verdict.kind == "cancel" then
    return { next = "cancel", site = state.site, cart_state = args.cart_state }
  end

  if verdict.kind == "choice" then
    local numbers = N.parse_choice_numbers(verdict.choice_numbers)
    -- ONE line per confirmation. Removing several on one number is a mutation the user approved once and
    -- the flow performed many times; each line gets its own turn, and the listing is re-read in between.
    local index = numbers[1]
    local line = index and state.lines[index] or nil
    if not line then
      return {
        next = "ask",
        question = V.render(state, tostring(index or reply) .. "번은 목록에 없습니다."),
        choice_stage = "await_choice",
        cart_state = args.cart_state,
        site = state.site,
      }
    end
    return {
      next = "remove",
      site = state.site,
      product_id = line.product_id,
      product_title = trim(line.title),
      -- The approval is written by the turn the user CHOSE in, and the mutation requires exactly this
      -- string. Two writers of one approval is how an approval stops meaning anything (§13).
      cart_approval = "user_confirmed_removal",
      cart_state = args.cart_state,
    }
  end

  -- Anything else is not an answer to "which number": say so and show the same listing again.
  return {
    next = "ask",
    question = V.render(state, "번호로 알려주세요."),
    choice_stage = "await_choice",
    cart_state = args.cart_state,
    site = state.site,
  }
end
