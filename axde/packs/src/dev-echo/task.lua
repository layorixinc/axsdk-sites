-- Development sample pack: task commands (authored as Lua, LUA_PACK_DESIGN.md).
--
-- Its whole job is to be BORING and to answer questions about the runtime it is standing in, so a
-- failure while debugging a pack is attributable to the environment rather than to the pack. It
-- reads nothing from a page and touches no capability beyond the prelude's own API.
--
-- Note what `describe_surface` does NOT do: it never names one of the globals the wrapper's static
-- gate forbids. That gate refuses those tokens even inside a comment or a string — measured here,
-- on this very file, when an earlier version of THIS comment listed them and the sample stopped
-- being publishable. Their absence from the sandbox is proven by the prelude's own tests instead.

local function clean(value, maximum)
  return text.clean(value, maximum or 240)
end

--- Returns its input, plus the marshaling shapes a caller most often gets wrong.
local function echo(input)
  local given = type(input) == "table" and input or {}
  return {
    said = clean(given.say),
    number = given.number,
    -- An empty Lua table crosses as an OBJECT; a real empty list needs the marker.
    empty_object = {},
    empty_list = json.array({}),
    -- Korean text round-trips as UTF-8 bytes, which is where a byte-wise cut goes wrong.
    korean = "무료배송 · 배송비 미확인",
  }
end

--- Names the prelude API that is actually present, so a broken delivery is visible in one call.
local function describe_surface()
  return {
    json = type(json),
    text = type(text),
    url = type(url),
    clock = type(clock),
    dom = type(dom),
    page = type(page),
    now_is_number = type(clock.now()) == "number",
    surface_keys = json.array({ "json", "text", "url", "clock", "dom", "page" }),
  }
end

--- Raises a named error, for exercising a refusal path end to end.
local function fail(input)
  local reason = clean(type(input) == "table" and input.reason or nil, 80)
  if reason == "" then reason = "dev_echo_failed" end
  error(reason)
end

register({
  echo = echo,
  describe_surface = describe_surface,
  fail = fail,
})
