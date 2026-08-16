--- Saved memory, from the runtime.
---
--- The platform kept the STORE on the device and exposed it as ops (`memory.get/set_bulk/search/delete`),
--- for two reasons worth repeating: a second store would split from the one the client already writes to,
--- and moving addresses and ordering habits off the device is a product decision, not a plumbing one. So
--- these cost one round trip each — the price of the data living somewhere else.
---
--- Every entry answers `memory_op_unavailable` rather than raising when the client has no handler for the
--- op. The ops were published before the extension implemented them, and a memory flow that dies is worse
--- than one that says the store could not be reached.

AX_RPC_MEMORY = AX_RPC_MEMORY or {}
local Y = AX_RPC_MEMORY

local function available()
  return type(memory) == "table"
end

--- Runs `fn` against the memory op set, or reports that the client has none.
---
--- The RAW reason travels with the refusal. "unavailable" on its own cost a whole round of diagnosis: it
--- could not tell an op the client never registered from one we failed to declare properly, and we made
--- exactly that mistake once already (`rpc.allow` grants OPS and does not reach `net`).
local function call(fn)
  if not available() then
    return nil, "memory_op_unavailable", "no memory global in this runtime"
  end
  local ok, value = pcall(fn)
  if not ok then
    local raw = tostring(value or "")
    local text = raw:lower()
    -- `command_unresolved` is what an unregistered op answers; anything else is the store's own failure.
    if text:find("command_unresolved", 1, true) or text:find("op_not_permitted", 1, true) then
      return nil, "memory_op_unavailable", raw:sub(1, 160)
    end
    return nil, "memory_unavailable", raw:sub(1, 160)
  end
  return value, nil, nil
end

--- Every saved key, or one key's value when `key` is given.
function Y.get(args)
  args = type(args) == "table" and args or {}
  local key = type(args.key) == "string" and args.key ~= "" and args.key or nil
  local value, err, why = call(function()
    if key then return memory.get(key) end
    return memory.get()
  end)
  if err then return { next = "error", ok = false, error = err, reason = why } end
  return { next = "report", ok = true, memory_result = value }
end

function Y.search(args)
  args = type(args) == "table" and args or {}
  local regex = type(args.regex) == "string" and args.regex or ""
  if regex == "" then return { next = "error", ok = false, error = "missing_regex" } end
  local value, err, why = call(function() return memory.search(regex) end)
  if err then return { next = "error", ok = false, error = err, reason = why } end
  return { next = "report", ok = true, memory_result = value }
end

--- Writes. The binding is POSITIONAL — `set_bulk(entries)` per `docs/rpc_lua_authoring.md` §4 — and the
--- runtime wraps it into the params object the client reads. Passing the wrapper ourselves produced a
--- live `bad_params`. An ABSENT value deletes that key, so saving and deleting are the same op and a
--- multi-key delete is ONE round trip. An empty string is a delete too, as the flow tells the user.
local function write(entries)
  if #entries == 0 then return nil, "missing_memory", nil end
  return call(function() return memory.set_bulk(entries) end)
end

function Y.set_bulk(args)
  args = type(args) == "table" and args or {}
  if type(args.memory) ~= "table" then return { next = "error", ok = false, error = "missing_memory" } end
  local entries = {}
  for key, value in pairs(args.memory) do
    if type(key) == "string" and key ~= "" then
      -- Only a non-empty string is a save; anything else means remove, which is `value` left out.
      if type(value) == "string" and value ~= "" then
        entries[#entries + 1] = { key = key, value = value }
      else
        entries[#entries + 1] = { key = key }
      end
    end
  end
  local value, err, why = write(entries)
  if err then return { next = "error", ok = false, error = err, reason = why } end
  return { next = "report", ok = true, memory_result = value }
end

--- `memory.delete(key)` takes a SINGLE key. A list therefore goes through `set_bulk` with the values
--- left out: same effect, one round trip instead of one per key.
function Y.delete(args)
  args = type(args) == "table" and args or {}
  local keys = args.keys or args.delete_keys
  if type(keys) ~= "table" or #keys == 0 then
    return { next = "error", ok = false, error = "missing_keys" }
  end
  local entries = {}
  for index = 1, #keys do
    local key = keys[index]
    if type(key) == "string" and key ~= "" then entries[#entries + 1] = { key = key } end
  end
  local value, err, why = write(entries)
  if err then
    return { next = "error", ok = false, error = err == "missing_memory" and "missing_keys" or err, reason = why }
  end
  return { next = "report", ok = true, memory_result = value }
end


--- Deterministic capture of an EXPLICIT memory clause from the user's own message.
---
--- Why this exists rather than a planner instruction: the planner drops a TRAILING "기억해줘" clause and no
--- prompt formulation moved it. Measured (§13) — the memory entry arrived once with the VALUE STRIPPED
--- ("전화번호 기억해줘"), and after two further formulations it was not emitted at all, three runs of three,
--- while moving the same clause to the FRONT worked every time. This runs as a `beforeIntent` hook instead:
--- deterministic, once per routable turn, no routing decision, and it receives the user's OWN message —
--- measured live, `userMessages` is an array of strings carrying the full text with the number intact.
---
--- The consent boundary is the whole risk of capturing without being asked, so it is the first condition and
--- nothing else runs without it: NO explicit clause, NO capture. §13 states the rule this enforces — "route a
--- standalone declarative personal fact with no remember/save/retrieve instruction to out_of_scope; never
--- reinterpret it as consent to save." A clause with no recognisable value captures nothing rather than
--- guessing, which is the other half of not inventing consent.
local SAVE_CLAUSES = {
  "기억해", "기억 해", "저장해", "저장 해", "remember", "save my", "save this", "keep my",
}

--- Values we can recognise WITHOUT guessing. A name or an address needs a judgement about where it starts and
--- ends; an email, a phone and a US ZIP do not, and those are the fields the quote flow re-asks for.
local function values_in(text)
  local found = {}
  local seen = {}
  local function add(key, value)
    if value == nil or value == "" or seen[key] then return end
    seen[key] = true
    found[#found + 1] = { key = key, value = value }
  end

  add("email", text:match("[%w%.%_%%%+%-]+@[%w%.%-]+%.%a%a+"))

  -- A US phone with separators, so a bare run of digits is never mistaken for one. The ZIP below is matched
  -- only outside a phone for the same reason: "415-555-0199" contains three digit groups.
  local phone = text:match("%d%d%d[%-%.%s]%d%d%d[%-%.%s]%d%d%d%d")
  add("phone", phone)

  local scrubbed = phone and text:gsub(phone:gsub("([%-%.%+%*%?%[%]%^%$%(%)%%])", "%%%1"), " ") or text
  local zip = scrubbed:match("%f[%d](%d%d%d%d%d)%f[%D]")
  add("zip_code", zip)

  return found
end

--- Answers `save` with the entries to write, or `skip`. Never raises: a hook must not take the turn down.
function Y.capture(args)
  args = type(args) == "table" and args or {}
  local messages = type(args.userMessages) == "table" and args.userMessages or {}
  -- The LATEST message is the turn's; earlier ones are history the hook also receives.
  local text = nil
  for index = #messages, 1, -1 do
    if type(messages[index]) == "string" and messages[index] ~= "" then text = messages[index] break end
  end
  if type(text) ~= "string" or text == "" then return { next = "skip" } end

  -- Scoped to the SENTENCE the clause is in, not the whole message. Consent was given for that clause: a
  -- ZIP the user typed for a quote in the previous sentence is not a fact they asked to keep, and capturing it
  -- would be the same over-reach as reading a bare statement as consent — measured on
  -- "샌프란시스코 94103에서 청소 견적 줘. 내 전화번호 415-555-0199 기억해줘.", where whole-message extraction
  -- took the ZIP too.
  --
  -- A sentence ends at punctuation FOLLOWED BY SPACE, never at a bare dot: splitting on every "." cut
  -- "hong@test.com" into "hong@test" and "com", and the email stopped being recognised at all.
  local sentences = {}
  for piece in ((text .. "\n"):gsub("([%.!%?])%s", "%1\1")):gmatch("[^\1\n]+") do
    if piece:match("%S") then sentences[#sentences + 1] = piece end
  end

  local entries = {}
  local seen_key = {}
  local function take(sentence)
    local taken = false
    for _, entry in ipairs(values_in(sentence)) do
      if not seen_key[entry.key] then
        seen_key[entry.key] = true
        entries[#entries + 1] = entry
        taken = true
      end
    end
    return taken
  end

  for index = 1, #sentences do
    local lowered = sentences[index]:lower()
    local asked = false
    for clause = 1, #SAVE_CLAUSES do
      if lowered:find(SAVE_CLAUSES[clause], 1, true) then asked = true break end
    end
    if asked and not take(sentences[index]) and index > 1 then
      -- A bare "기억해줘" refers to what was just said: "…이메일은 gildong@test.com, 전화번호는 … 이야.
      -- 기억해줘." is the measured shape of a quote answer. ONE sentence back, and only when the clause's own
      -- carries nothing — so the ZIP case above stays out of reach.
      take(sentences[index - 1])
    end
  end
  if #entries == 0 then return { next = "skip" } end
  return { next = "save", memory_entries = entries }
end
