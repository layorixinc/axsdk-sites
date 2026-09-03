-- Development sample pack: a provider that READS the page it is standing on and nothing else
-- (authored as Lua, LUA_PACK_DESIGN.md).
--
-- Used while debugging provider execution: it answers what the dom bridge can see, so "the provider
-- did not run" and "the provider ran and the selectors matched nothing" stop looking alike — the
-- distinction the storefront readers paid for repeatedly (AGENTS.md §13).
--
-- Read-only by construction: it names no click, no submit, and no navigation of its own.

local function clean(value, maximum)
  return text.clean(value, maximum or 240)
end

local function read_page(input)
  local given = type(input) == "table" and input or {}
  local selector = clean(given.selector, 120)
  if selector == "" then selector = "h1" end

  local parsed = url.parse(page.href())
  local nodes = dom.query_all(selector)
  local samples = {}
  for index = 1, math.min(#nodes, 3) do
    samples[index] = {
      text = clean(dom.text(nodes[index]), 120),
      -- An attribute a node does not carry stays ABSENT, never an empty string.
      id = dom.attr(nodes[index], "id"),
    }
  end

  -- A nil handle would raise `dom_handle_invalid`; an absent title stays ABSENT instead.
  local title_node = dom.query("title")
  local title = nil
  if title_node ~= nil then title = clean(dom.text(title_node), 200) end

  return {
    href = page.href(),
    origin = parsed ~= nil and parsed.origin or nil,
    pathname = parsed ~= nil and parsed.pathname or nil,
    selector = selector,
    matched = #nodes,
    samples = json.array(samples),
    title = title,
  }
end

register({ read_page = read_page })
