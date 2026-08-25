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
  return { next = "report", ok = true, memory_result = value, memory = args.memory }
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
  return { next = "report", ok = true, memory_result = value, delete_keys = keys }
end


--- Consumer response for one completed memory operation.
---
--- The old terminal handed the whole result envelope to a model and asked it to explain the JSON. Live,
--- successful writes were therefore rendered as `memory_result`, `next`, `ok`, and `operation` instead of
--- a confirmation. Render from the bounded result and the exact requested keys here, then use a data
--- terminal so the whole flow state never enters a response model.
local KR_LABEL = {
  full_name = "이름", first_name = "이름", last_name = "성", email = "이메일",
  phone = "전화번호", address = "주소", zip_code = "우편번호",
}
local KR_OBJECT = {
  full_name = "이름을", first_name = "이름을", last_name = "성을", email = "이메일을",
  phone = "전화번호를", address = "주소를", zip_code = "우편번호를",
}
local EN_LABEL = {
  full_name = "name", first_name = "first name", last_name = "last name", email = "email",
  phone = "phone number", address = "address", zip_code = "ZIP code",
}

local function latest_text(args)
  local messages = type(args.userMessages) == "table" and args.userMessages or {}
  for index = #messages, 1, -1 do
    if type(messages[index]) == "string" and messages[index] ~= "" then return messages[index] end
  end
  return type(args.requestText) == "string" and args.requestText or ""
end

local function has_korean(text)
  text = tostring(text or "")
  for index = 1, #text do
    local byte = text:byte(index)
    if byte and byte >= 234 and byte <= 237 then return true end
  end
  return false
end
local function is_cancel(text)
  local lowered = tostring(text or ""):lower()
  local words = {
    "취소", "그만", "됐어", "됐습니다", "안 할래", "안할래", "관두",
    "cancel", "never mind", "nevermind", "no thanks", "stop",
  }
  for index = 1, #words do
    if lowered:find(words[index], 1, true) then return true end
  end
  return false
end


local function label(key, korean)
  key = tostring(key or "")
  return (korean and KR_LABEL[key] or EN_LABEL[key]) or key
end

local function object_label(key)
  key = tostring(key or "")
  return KR_OBJECT[key] or (key .. " 항목을")
end

local function sorted_values(values)
  local out, seen = {}, {}
  for index = 1, #(values or {}) do
    local value = values[index]
    if type(value) == "string" and value ~= "" and not seen[value] then
      seen[value] = true
      out[#out + 1] = value
    end
  end
  table.sort(out)
  return out
end

local function requested_changes(memory)
  local saved, removed = {}, {}
  for key, value in pairs(type(memory) == "table" and memory or {}) do
    if type(key) == "string" and key ~= "" then
      if type(value) == "string" and value ~= "" then
        saved[#saved + 1] = key
      else
        removed[#removed + 1] = key
      end
    end
  end
  table.sort(saved)
  table.sort(removed)
  return saved, removed
end

local function labels(keys, korean, objects)
  local out = {}
  for index = 1, #keys do
    out[index] = objects and object_label(keys[index]) or label(keys[index], korean)
  end
  return table.concat(out, ", ")
end

local function failed_response(korean)
  if korean then
    return "메모리 요청을 완료하지 못했습니다. 저장되거나 삭제된 내용은 없습니다."
  end
  return "Memory request could not be completed. Nothing was saved or deleted."
end

function Y.present(args)
  args = type(args) == "table" and args or {}
  local korean = has_korean(latest_text(args))
  local envelope = args.memory_result
  local payload = envelope
  if envelope == nil then
    return { next = "done", memory_response = failed_response(korean) }
  end
  if type(envelope) == "table" then
    if envelope.ok == false or envelope.error ~= nil then
      return { next = "done", memory_response = failed_response(korean) }
    end
    if envelope.memory_result ~= nil then payload = envelope.memory_result end
  end
  local requested_memory = args.memory
  if (type(requested_memory) ~= "table" or next(requested_memory) == nil)
      and type(envelope) == "table" and type(envelope.memory) == "table" then
    requested_memory = envelope.memory
  end
  local requested_delete_keys = args.delete_keys
  if (type(requested_delete_keys) ~= "table" or #requested_delete_keys == 0)
      and type(envelope) == "table" and type(envelope.delete_keys) == "table" then
    requested_delete_keys = envelope.delete_keys
  end


  local operation = args.operation
  if operation == "delete_candidates" then
    local matches = type(payload) == "table" and payload.matches or {}
    if args.confirmed ~= true and #(matches or {}) == 0 then
      return {
        next = "done",
        memory_response = korean and "삭제할 일치하는 기억을 찾지 못했습니다. 아무것도 삭제하지 않았습니다."
          or "No matching saved memory was found to delete. Nothing was deleted.",
      }
    end
    if args.confirmed == false and is_cancel(latest_text(args)) then
      return {
        next = "cancelled",
        memory_response = korean and "메모리 삭제를 취소했습니다. 아무것도 삭제하지 않았습니다."
          or "Memory deletion was cancelled. Nothing was deleted.",
      }
    end
    if args.confirmed == true then
      operation = "delete"
    else
      return { next = "done", memory_response = failed_response(korean) }
    end
  end
  if operation == "set" then
    local saved, removed = requested_changes(requested_memory)
    if #saved == 0 and #removed == 0 then
      return { next = "done", memory_response = failed_response(korean) }
    end
    if korean then
      if #saved > 0 and #removed > 0 then
        return {
          next = "done",
          memory_response = labels(saved, true, true) .. " 기억했고 "
            .. labels(removed, true, false) .. " 기억을 삭제했습니다.",
        }
      end
      if #saved > 0 then
        return { next = "done", memory_response = labels(saved, true, true) .. " 기억했습니다." }
      end
      return { next = "done", memory_response = labels(removed, true, false) .. " 기억을 삭제했습니다." }
    end
    if #saved > 0 and #removed > 0 then
      return {
        next = "done",
        memory_response = "Remembered " .. labels(saved, false, false)
          .. " and removed saved " .. labels(removed, false, false) .. ".",
      }
    end
    if #saved > 0 then
      return { next = "done", memory_response = "Remembered " .. labels(saved, false, false) .. "." }
    end
    return { next = "done", memory_response = "Removed saved " .. labels(removed, false, false) .. "." }
  end

  if operation == "delete" then
    local removed = sorted_values(requested_delete_keys)
    if #removed == 0 then return { next = "done", memory_response = failed_response(korean) } end
    if korean then
      return { next = "done", memory_response = labels(removed, true, false) .. " 기억을 삭제했습니다." }
    end
    return { next = "done", memory_response = "Removed saved " .. labels(removed, false, false) .. "." }
  end

  if operation == "list" then
    local keys = sorted_values(type(payload) == "table" and payload.keys or {})
    if #keys == 0 then
      return {
        next = "done",
        memory_response = korean and "기억하고 있는 항목이 없습니다." or "No saved memory items were found.",
      }
    end
    return {
      next = "done",
      memory_response = korean and ("기억하고 있는 항목: " .. labels(keys, true, false) .. ".")
        or ("Saved memory items: " .. labels(keys, false, false) .. "."),
    }
  end

  if operation == "get" then
    local key = type(payload) == "table" and payload.key or args.key
    local value = type(payload) == "table" and payload.value or nil
    local shown = label(key, korean)
    if type(value) ~= "string" or value == "" then
      return {
        next = "done",
        memory_response = korean and ("저장된 " .. shown .. " 정보가 없습니다.")
          or ("No saved " .. shown .. " was found."),
      }
    end
    return {
      next = "done",
      memory_response = korean and ("기억한 " .. shown .. ": " .. value)
        or ("Remembered " .. shown .. ": " .. value),
    }
  end

  if operation == "search" then
    local matches = type(payload) == "table" and payload.matches or {}
    local blocks, truncated = {}, type(payload) == "table" and payload.truncated == true
    for index = 1, #(matches or {}) do
      local match = matches[index] or {}
      local key = type(match.key) == "string" and match.key or ""
      local excerpt = type(match.excerpt) == "string" and match.excerpt or ""
      if key ~= "" or excerpt ~= "" then
        blocks[#blocks + 1] = "- " .. key .. (excerpt ~= "" and ("\n" .. excerpt) or "")
      end
      if match.truncated == true then truncated = true end
    end
    if #blocks == 0 then
      return {
        next = "done",
        memory_response = korean and "일치하는 기억을 찾지 못했습니다." or "No matching saved memory was found.",
      }
    end
    local response = (korean and "기억에서 찾은 내용:\n" or "Remembered matches:\n")
      .. table.concat(blocks, "\n")
    if truncated then
      response = response .. (korean
        and "\n검색 결과 일부가 잘렸습니다. 정확한 항목이나 더 좁은 주제로 다시 검색해 주세요."
        or "\nSome results were truncated. Search for an exact item or a narrower topic.")
    end
    return { next = "done", memory_response = response }
  end

  return { next = "done", memory_response = failed_response(korean) }
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

  -- A phone with separators, so a bare run of digits is never mistaken for one. Two shapes: 3-3-4 (US, what
  -- the reserved test data uses) and 3-4-4 (a Korean mobile, `010-1234-5678`). Only the first was matched,
  -- so a Korean user's explicit "기억해줘" saved NOTHING and, the hook being fire-and-continue, said nothing
  -- either — in the product's own primary locale. Longer shape first: 3-3-4 would match its own prefix.
  local phone = text:match("%d%d%d[%-%.%s]%d%d%d%d[%-%.%s]%d%d%d%d")
    or text:match("%d%d%d[%-%.%s]%d%d%d[%-%.%s]%d%d%d%d")
  add("phone", phone)

  -- The ZIP is matched only outside a phone, because "415-555-0199" contains three digit groups. And it is
  -- refused when a unit follows it: a bare `30000원` was being written as the user's postal code, which
  -- `recall_saved_contact` then feeds into a quote form. A US ZIP never carries a unit.
  local scrubbed = phone and text:gsub(phone:gsub("([%-%.%+%*%?%[%]%^%$%(%)%%])", "%%%1"), " ") or text
  local zip, after = scrubbed:match("%f[%d](%d%d%d%d%d)%f[%D]()")
  local unit = after and scrubbed:sub(after):match("^%s*([%a원달러won]+)")
  if zip and not unit then add("zip_code", zip) end

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
