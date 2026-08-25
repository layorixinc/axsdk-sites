--- The confirm surface for a community command the model proposed.
---
--- The user's approval IS the button, so this file's whole job is to make sure the button names one
--- invocation and carries nothing else. The extension refuses extras when the click arrives; refusing
--- them here means a malformed block never reaches a user in the first place, and a widget the SDK
--- would reject renders as *nothing at all* — the refusal on receipt is silent.
---
--- The `link_button` template takes exactly `label` and `action`. That is why the explanation is a
--- separate sentence the flow renders beside the button rather than something stuffed into the label:
--- a user approving a mutation has to see the script, the publisher, the effect and the values, and a
--- button label is not where any of that belongs.

if type(AX_RPC_WIDGET) ~= "table" then
  error("_common.69_rpc_widget must be loaded before _common.75_rpc_community")
end

AX_RPC_COMMUNITY = AX_RPC_COMMUNITY or {}
local C = AX_RPC_COMMUNITY
local W = AX_RPC_WIDGET

--- The one command the extension's AX allowlist answers. Anything else is refused there; naming it
--- here keeps the two statements of the same fact next to their tests.
C.INVOKE_COMMAND = "AX_widget_community_invoke"

--- Every effect the policy allows. The button is the user ASKING for one specific invocation, not an
--- approval of a mutation — an argument-taking `read` needs it just as much, and the first live run
--- found that such a command had no path to execution at all: prerun skips it because arguments
--- cannot be invented, and refusing it here left the model able only to describe it.
---
--- Whether a mutation additionally prompts on the click is the broker's, and stays there.
C.EFFECTS = {
  read = true,
  page_write = true,
  external_send = true,
  cart_mutation = true,
}

--- The catalog the extension rendered, as records.
---
--- Two line shapes, and the INDENT is what tells them apart: a script sits at the margin as
--- `- <name> <version> `<id>` (<publisher>, reviewed by <reviewer>)`, and each command it offers is
--- indented under it as `  - <name> — <description> [<effect>] …`. So a command's script, version and
--- effect are all readable here, which is the point: they are facts of the INSTALLED command, and a
--- model restating them is a second writer of one fact that can only ever be right by luck.
local function catalog_commands(catalog)
  local found = {}
  if type(catalog) ~= "string" then return found end

  local script_id, script_name, publisher_id, version
  for line in catalog:gmatch("[^\n]+") do
    local name, ver, id, publisher = line:match("^%-%s+(.-)%s+(%d[%w%.%-%+]*)%s+`([^`]+)`%s+%(([^,%)]+)")
    if id ~= nil then
      script_id, script_name, publisher_id, version = id, name, publisher, ver
    else
      local command, rest = line:match("^%s+%-%s+([%w_][%w_%-%.]*)%s+—%s*(.*)$")
      -- Recorded even when no script line has been seen: a command whose script is unknown is still a
      -- command the page named, so classification keeps working and `propose` refuses it precisely.
      -- Dropping it would turn a catalog-format change into a silently dead branch.
      if command ~= nil then
        local effect = rest:match("%[([%w_]+)%]")
        local description = rest:match("^(.-)%s*%[") or rest
        -- A command name offered by two installed scripts is not a command anyone can dispatch, so
        -- the duplicate is recorded rather than overwritten and the caller refuses it.
        if found[command] == nil then
          found[command] = {
            script_id = script_id,
            script_name = script_name,
            publisher_id = publisher_id,
            version = version,
            command = command,
            description = description,
            effect = effect,
          }
        else
          found[command].ambiguous = true
        end
      end
    end
  end
  return found
end

--- The catalog text, wherever this invocation carries it.
---
--- It is a key of the `contexts` TABLE, not a bare global: the node's `inputSelector` decides which
--- contexts the view is built from and the tool's `contextAccess` decides which of those it may read
--- — either declaration alone delivers nothing. Arguments never carry it, so one fact never gets two
--- names. `args.catalog_text` is the offline tests' door.
local function catalog_text(args)
  local catalog = args.catalog_text
  if type(catalog) ~= "string" then
    local view = rawget(_G, "contexts")
    if type(view) == "table" then catalog = view.community end
  end
  if type(catalog) == "table" then catalog = catalog.text or catalog.catalog or "" end
  if type(catalog) ~= "string" then return "" end
  return catalog
end

--- Does the user's sentence name a command this page actually offers?
---
--- Deterministic on purpose. Four prompt formulations failed to make a model choose to propose rather
--- than answer, and the diagnosis was that `answer` is always available to it. So the DECISION moves
--- here and the model keeps only the job it is good at — reading argument values out of the sentence.
--- The Thumbtack shortlist loop settled the same way, with no model node at all.
---
--- Two rules the tests pin. A name the catalog does not list is never a proposal, or an invented name
--- would branch into a button the broker was always going to refuse. And two names are refused rather
--- than guessed between, because picking one is a decision nobody made.
function C.classify(args)
  args = type(args) == "table" and args or {}
  -- The flow hands these over under the names it selects them by; the tests use the plain ones.
  local catalog = catalog_text(args)
  local text = args.user_text
  if type(text) ~= "string" then text = args.requestText end
  if type(text) ~= "string" then text = "" end
  if catalog == "" or text == "" then return { next = "answer" } end

  local order = {}
  for name, _ in pairs(catalog_commands(catalog)) do order[#order + 1] = name end
  -- Sorted so two names in one sentence are reported in a stable order, whatever the table's.
  table.sort(order)

  local named = {}
  for _, name in ipairs(order) do
    -- Whole word only: `remembering` is prose about the command, not a request to run it. Lua has no
    -- word boundary, so the neighbours are checked directly.
    local from = 1
    while true do
      local start, stop = text:find(name, from, true)
      if start == nil then break end
      local before = start > 1 and text:sub(start - 1, start - 1) or ""
      local after = text:sub(stop + 1, stop + 1)
      local joined = before:match("[%w_]") ~= nil or after:match("[%w_]") ~= nil
      if not joined then
        named[#named + 1] = name
        break
      end
      from = stop + 1
    end
  end

  if #named == 0 then return { next = "answer" } end
  if #named > 1 then
    return { next = "ambiguous", candidates = table.concat(named, ", ") }
  end
  return { next = "propose", command = named[1] }
end

--- Lua patterns have no alternation and cannot repeat a GROUP, so `^[a-z0-9]+([._-][a-z0-9]+)*$` —
--- which reads correctly and is what the JavaScript side uses — silently matches nothing here. The
--- rule is spelled out instead: lowercase alphanumerics and single separators, never leading,
--- trailing or doubled.
local function identifier(value)
  if type(value) ~= "string" or value == "" then return false end
  if value:match("^[a-z0-9._-]+$") == nil then return false end
  if value:match("^[a-z0-9]") == nil or value:match("[a-z0-9]$") == nil then return false end
  if value:match("[._-][._-]") ~= nil then return false end
  return true
end

local function version(value)
  return type(value) == "string" and value:match("^%d+%.%d+%.%d+") ~= nil
end

--- Decodes the model's arguments. A string is used rather than a table because flow state carries
--- scalars reliably and an empty Lua table encodes as an object — the same trap the widget list fields
--- already work around one level up.
local function decode_arguments(encoded)
  if encoded == nil or encoded == "" then return {}, nil end
  if type(encoded) ~= "string" then return nil, "arguments_invalid" end
  if type(json) ~= "table" or type(json.decode) ~= "function" then return nil, "json_decode_unavailable" end
  local ok, decoded = pcall(json.decode, encoded)
  if not ok or type(decoded) ~= "table" then return nil, "arguments_invalid" end
  -- A JSON array decodes to a Lua table too; arguments are an object, and a list here would cross the
  -- extension's parser as an array and be refused there with nothing to show the user.
  if #decoded > 0 then return nil, "arguments_invalid" end
  return decoded, nil
end

--- Validates a proposal and hands the fields to flow state. Renders nothing.
---
--- The split is the point. Offered the renderer as a tool, the model answered in prose instead of
--- proposing — twice, measured. The model's job is to DECIDE; the deterministic node renders, which
--- is the same rule the offer window and the service shortlist already follow.
---
--- And it decides ONE thing: which command, with which values. The script, the version and the
--- effect are facts of the installed command, looked up in the catalog — live, a model asked to
--- restate the effect answered outside the vocabulary and the proposal died as `effect_invalid`,
--- which is the only way that can end. A second writer of one fact is right by luck or not at all.
---
--- Validation is deliberately the same as the renderer's, so a proposal that passes here cannot fail
--- there: two gates disagreeing about what a valid proposal is would surface as a dead branch.
function C.propose(args)
  args = type(args) == "table" and args or {}

  if not identifier(args.command) then
    return { next = "error", error = "command_invalid" }
  end

  local offered = catalog_commands(catalog_text(args))[args.command]
  if offered == nil then
    -- Either the page offers nothing or the model named something it does not offer. Both are a
    -- button the broker was always going to refuse, so neither becomes one.
    return { next = "error", error = "command_not_offered" }
  end
  if offered.ambiguous then
    return { next = "error", error = "command_ambiguous" }
  end
  if not identifier(offered.script_id) then
    return { next = "error", error = "script_id_invalid" }
  end
  if not version(offered.version) then
    return { next = "error", error = "version_invalid" }
  end
  if type(offered.effect) ~= "string" or C.EFFECTS[offered.effect] == nil then
    return { next = "error", error = "effect_invalid" }
  end

  local arguments_json = args.arguments_json
  if arguments_json == nil or arguments_json == "" then arguments_json = "{}" end
  local _, problem = decode_arguments(arguments_json)
  if problem then return { next = "error", error = problem } end

  return {
    next = "confirm",
    script_id = offered.script_id,
    script_name = offered.script_name,
    publisher_id = offered.publisher_id,
    version = offered.version,
    command = offered.command,
    description = offered.description,
    effect = offered.effect,
    arguments_json = arguments_json,
  }
end

--- Renders the confirm button plus the sentence that belongs beside it.
---
--- Returns `{ next = "confirm", widget, summary }`, or `{ next = "error", error }` — never a
--- half-built block.
function C.confirm(args)
  args = type(args) == "table" and args or {}

  if not identifier(args.script_id) then
    return { next = "error", error = "script_id_invalid" }
  end
  if not version(args.version) then
    return { next = "error", error = "version_invalid" }
  end
  if not identifier(args.command) then
    return { next = "error", error = "command_invalid" }
  end
  if type(args.effect) ~= "string" or C.EFFECTS[args.effect] == nil then
    -- An effect outside the vocabulary is a proposal about something the broker cannot classify, and
    -- a button for it would promise a check nobody wrote.
    return { next = "error", error = "effect_invalid" }
  end

  local arguments, problem = decode_arguments(args.arguments_json)
  if problem then return { next = "error", error = problem } end

  -- Exactly the four fields the extension's parser accepts. Built field by field rather than copied
  -- from `args`, so nothing the caller added can ride along.
  local action = {
    type = "ax",
    command = C.INVOKE_COMMAND,
    args = {
      script_id = args.script_id,
      version = args.version,
      command = args.command,
      arguments = arguments,
    },
  }

  local label = string.format("%s 실행", args.command)
  local rendered = W.render({
    template_id = "link_button",
    data = { label = label, action = action },
  })
  if rendered.error then return { next = "error", error = rendered.error } end

  local name = type(args.script_name) == "string" and args.script_name or args.script_id
  local publisher = type(args.publisher_id) == "string" and args.publisher_id or "unknown"
  local description = type(args.description) == "string" and args.description or ""
  local values = args.arguments_json
  if type(values) ~= "string" or values == "" then values = "{}" end

  local summary = string.format(
    "%s (%s) 의 %s 을(를) 실행할까요? %s [%s] 전달할 값: %s",
    name, publisher, args.command, description, args.effect, values
  )

  return { next = "confirm", widget = rendered.value, summary = summary }
end
