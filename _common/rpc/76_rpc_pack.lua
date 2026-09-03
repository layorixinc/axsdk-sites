--- The generic Pack task bridge (EXTERNAL_PACK_TASK_PLAN X5).
---
--- The catalog is the SINGLE WRITER of Pack identity, version, and effect — structurally, because
--- `pack.invoke` takes only the catalog-issued `binding_id` plus the model's `arguments_json`. The
--- model's whole job is reading argument values out of the user's sentence; everything else is a
--- fact of the INSTALLED command, and a model restating an installed fact is a second writer that is
--- right by luck (`75_rpc_community.lua` paid for that live as `effect_invalid`).
---
--- Everything that crosses a turn travels as ONE JSON scalar (`pack_catalog_json`), because flow
--- state carries scalars reliably and an empty Lua table encodes as an object.

AX_RPC_PACK = AX_RPC_PACK or {}
local P = AX_RPC_PACK

local CANCEL_WORDS = { "취소", "cancel", "그만", "중단" }

local function trim(value)
  if type(value) ~= "string" then return "" end
  return (value:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function current_text(args)
  local messages = args.userMessages
  if type(messages) == "table" and #messages > 0 then
    local last = messages[#messages]
    if type(last) == "string" and trim(last) ~= "" then return trim(last) end
  end
  return trim(args.requestText)
end

local function is_cancel(text)
  local lowered = string.lower(text)
  for _, word in ipairs(CANCEL_WORDS) do
    if string.find(lowered, word, 1, true) ~= nil then return true end
  end
  return false
end

local function decode_json(encoded)
  if type(encoded) ~= "string" or encoded == "" then return nil end
  local ok, decoded = pcall(json.decode, encoded)
  if not ok or type(decoded) ~= "table" then return nil end
  return decoded
end

--- The op vocabulary is installed lazily by the runtime; capturing `pack` at load time captures nil,
--- and the static grant audit reads LITERAL `pack.<op>(` calls — so the sugar path calls each op
--- literally inside a deferred pcall. When the sugar table has not landed (parity pending), the
--- generic `rpc(op, params)` path builds the SAME op frame — the runtime's own guidance on request
--- 22. `rpc` is a CALLABLE TABLE: callability is not a `type()` question, so it is pcall'd, never
--- type-checked. A missing channel is a channel outcome, never a pack claim.
local function pack_op(op, sugar, params)
  if type(pack) == "table" then
    local ok, value = pcall(sugar)
    if not ok then
      return nil, "pack_channel_unavailable: " .. tostring(value)
    end
    if type(value) ~= "table" then
      return nil, "pack_channel_unavailable: empty op answer"
    end
    return value, nil
  end
  if rpc == nil then
    return nil, "pack_channel_unavailable: no pack sugar and no generic rpc channel"
  end
  local ok, value = pcall(function() return rpc(op, params or {}) end)
  if not ok then
    return nil, "pack_channel_unavailable: " .. tostring(value)
  end
  if type(value) ~= "table" then
    return nil, "pack_channel_unavailable: empty op answer"
  end
  return value, nil
end

--- One catalog line per command: name, effect, owning pack. The EFFECT is printed so a reply can
--- state it, and never restated by a model.
local function render_catalog(catalog)
  local lines = {}
  for index = 1, #catalog.commands do
    local entry = catalog.commands[index]
    lines[#lines + 1] = string.format("- %s [%s] (%s@%s)",
      tostring(entry.command), tostring(entry.effect), tostring(entry.pack_id), tostring(entry.version))
  end
  for index = 1, #(catalog.routes or {}) do
    local route = catalog.routes[index]
    lines[#lines + 1] = string.format("- route %s — %s", tostring(route.intent), tostring(route.description))
  end
  return table.concat(lines, "\n")
end

function P.read_catalog(args)
  args = type(args) == "table" and args or {}
  local catalog, refusal = pack_op("pack.catalog", function() return pack.catalog() end, nil)
  if catalog == nil then
    return { next = "error", pack_answer_reason = refusal }
  end
  local commands = type(catalog.commands) == "table" and catalog.commands or {}
  if #commands == 0 then
    return { next = "none", pack_answer_reason = "no_packs_installed" }
  end
  return {
    next = "ok",
    pack_catalog_json = json.encode(catalog),
    pack_catalog_text = render_catalog(catalog),
    pack_command_count = #commands,
  }
end

--- Deterministic on purpose (the community classifier's lesson): the DECISION of whether the request
--- reaches an installed command is never a model's. Exact command name wins; otherwise a route whose
--- example words overlap the request selects that route's pack, and its single read command is the
--- proposal. Two matches are refused rather than guessed between.
local function commands_named_in(text, commands)
  local named = {}
  local lowered = string.lower(text)
  for index = 1, #commands do
    local name = string.lower(tostring(commands[index].command))
    if string.find(lowered, name, 1, true) ~= nil then named[#named + 1] = commands[index] end
  end
  return named
end

local function route_overlap(text, route)
  local lowered = string.lower(text)
  local examples = type(route.examples) == "table" and route.examples or {}
  for index = 1, #examples do
    local overlap = 0
    for token in string.gmatch(string.lower(tostring(examples[index])), "[^%s%p]+") do
      if #token >= 2 and string.find(lowered, token, 1, true) ~= nil then overlap = overlap + 1 end
    end
    if overlap >= 2 then return true end
  end
  return false
end

function P.classify(args)
  args = type(args) == "table" and args or {}
  local text = current_text(args)
  if text == "" then return { next = "answer", pack_answer_reason = "no_match: empty request" } end
  if is_cancel(text) then return { next = "cancelled" } end
  local catalog = decode_json(args.pack_catalog_json)
  if catalog == nil or type(catalog.commands) ~= "table" then
    return { next = "answer", pack_answer_reason = "no_match: catalog unreadable" }
  end

  local named = commands_named_in(text, catalog.commands)
  if #named > 1 then
    return { next = "answer", pack_answer_reason = "ambiguous: more than one installed command is named" }
  end
  if #named == 1 then
    return {
      next = "propose",
      pack_named_command = named[1].command,
      pack_binding_id = named[1].binding_id,
    }
  end

  local routes = type(catalog.routes) == "table" and catalog.routes or {}
  for index = 1, #routes do
    if route_overlap(text, routes[index]) then
      -- The matched route names a PACK's surface; the deterministic pick is that pack's single
      -- invocable read command. Several would be a guess, so several answer instead.
      local reads = {}
      for command_index = 1, #catalog.commands do
        local entry = catalog.commands[command_index]
        if entry.effect == "read" then reads[#reads + 1] = entry end
      end
      if #reads == 1 then
        return {
          next = "propose",
          pack_named_command = reads[1].command,
          pack_binding_id = reads[1].binding_id,
        }
      end
      return { next = "answer", pack_answer_reason = "route_matched: ask for one of the listed commands" }
    end
  end
  return { next = "answer", pack_answer_reason = "no_match: nothing installed answers this" }
end

--- Validates the model's proposal against the catalog and hands ONLY catalog facts to state.
function P.propose(args)
  args = type(args) == "table" and args or {}
  local catalog = decode_json(args.pack_catalog_json)
  if catalog == nil or type(catalog.commands) ~= "table" then
    return { next = "error", pack_answer_reason = "catalog_unreadable" }
  end
  local command = trim(args.command)
  local entry = nil
  for index = 1, #catalog.commands do
    if catalog.commands[index].command == command then entry = catalog.commands[index] end
  end
  if entry == nil then
    return { next = "error", pack_answer_reason = "command_not_in_catalog: " .. command }
  end
  if entry.effect ~= "read" then
    -- X5 dispatches read commands only; anything else is refused BY NAME, never silently narrowed.
    return {
      next = "error",
      pack_answer_reason = "effect_not_invocable: " .. tostring(entry.effect)
        .. " commands are not dispatched by this flow",
    }
  end
  local arguments_json = args.arguments_json
  if arguments_json == nil or trim(arguments_json) == "" then arguments_json = "{}" end
  local decoded = decode_json(arguments_json)
  if decoded == nil then
    return { next = "error", pack_answer_reason = "arguments_invalid: not a JSON object" }
  end
  return {
    next = "invoke",
    pack_binding_id = entry.binding_id,
    pack_command = entry.command,
    pack_pack_id = entry.pack_id,
    pack_version = entry.version,
    pack_effect = entry.effect,
    pack_arguments_json = arguments_json,
    -- The consent marker the mutation adapter requires: written ONLY here, after the catalog check
    -- and the read-effect check both passed. `pack.invoke` is a mutation at the wire level
    -- (runtime review of request 22) even though this flow dispatches read commands only.
    pack_dispatch_approval = "catalog_validated_read_command",
  }
end

function P.invoke(args)
  args = type(args) == "table" and args or {}
  local binding_id = trim(args.pack_binding_id)
  if binding_id == "" then
    return { next = "error", pack_answer_reason = "binding_missing" }
  end
  -- POSITIONAL, not a params table: the params table is the WIRE shape, the Lua binding takes the
  -- values (runtime review of request 22 — the `memory.set_bulk` trap, §13, in a new namespace).
  local answer, refusal = pack_op("pack.invoke", function()
    return pack.invoke(binding_id, args.pack_arguments_json)
  end, {
    binding_id = binding_id,
    arguments_json = args.pack_arguments_json,
  })
  if answer == nil then
    return { next = "error", pack_answer_reason = refusal }
  end
  if answer.ok ~= true then
    local reason = tostring(answer.code)
    if answer.uncertain == true then
      -- The Pack MAY have done the thing; reported as its own shape so nothing retries it.
      reason = "uncertain: " .. reason
    end
    if answer.message ~= nil then reason = reason .. " — " .. tostring(answer.message) end
    return { next = "error", pack_answer_reason = reason }
  end
  return {
    next = "present",
    pack_result_json = json.encode(answer.value),
  }
end

--- Deterministic rendering. A Pack that states its own text (`comparisonText`) is quoted verbatim;
--- otherwise the value renders as bounded key lines. Nothing here is a model's words.
function P.present(args)
  args = type(args) == "table" and args or {}
  local value = decode_json(args.pack_result_json)
  local body
  if type(value) == "table" and type(value.comparisonText) == "string" and value.comparisonText ~= "" then
    body = value.comparisonText
  elseif args.pack_result_json ~= nil then
    body = string.sub(tostring(args.pack_result_json), 1, 1500)
  else
    body = "(no result payload)"
  end
  local header = string.format("[%s · %s]", tostring(args.pack_pack_id), tostring(args.pack_command))
  return { next = "report", pack_reply = header .. "\n" .. body }
end

return P
