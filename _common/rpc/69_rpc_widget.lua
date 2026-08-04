--- The `ax-widget` envelope, rendered in the runtime.
---
--- We first argued this had to stay a remote call, because rendering it here would mean "a second encoder
--- with no validation next to a validated one". That was wrong, and the platform corrected it:
--- `parseWidgetEnvelope` runs the template's own zod schema over the data on receipt, re-applies the
--- template defaults, and treats `version` as optional. The shape is gated whoever produces it.
---
--- What WAS genuinely missing is escaping — a live card once carried an `<img>` tag in its text, and store
--- names carry quotes and non-Latin script. That is why this uses the runtime's `json.encode` rather than
--- building JSON by hand, and refuses outright when the encoder is absent.
---
--- Two nodes used to spend a round trip each wrapping a table our own Lua had already built.

AX_RPC_WIDGET = AX_RPC_WIDGET or {}
local W = AX_RPC_WIDGET

W.FENCE = "ax-widget"
--- Only the templates the SDK publishes. An id it does not know is refused by `parseWidgetEnvelope`, and a
--- refusal there is silent — the block simply does not render — so it is caught here instead.
W.TEMPLATES = { table = true, link_button = true, product_card = true }

--- A list the encoder must emit as a JSON ARRAY.
---
--- A Lua table with no positional entries encodes as `{}` — an object — and there is no marker this code
--- can rely on to say otherwise (`ax.array` belongs to the browser capability set, not the runtime). So an
--- EMPTY list is not rendered at all: the template would refuse the object, the refusal is silent, and the
--- user would be shown nothing with no explanation. A table with no rows is a "no results" sentence, not a
--- widget.
local function as_array(value)
  if type(value) ~= "table" then return nil, "not_a_list" end
  if #value == 0 then return nil, "empty_list" end
  local out = {}
  for index = 1, #value do out[index] = value[index] end
  return out, nil
end

--- Renders `data` as a fenced `ax-widget` block for `template_id`.
---
--- Returns `{ value }` on success, or `{ error }` — never a half-built block, because the consumer's
--- refusal is silent and a malformed envelope reaches the user as an empty answer.
function W.render(args)
  args = type(args) == "table" and args or {}
  local template = args.template_id or args.template
  if type(template) ~= "string" or not W.TEMPLATES[template] then
    return { next = "error", error = "unknown_widget_template", template_id = template }
  end
  if type(json) ~= "table" or type(json.encode) ~= "function" then
    return { next = "error", error = "json_encode_unavailable" }
  end

  local data = type(args.data) == "table" and args.data or {}
  -- Rebuild the two list fields so they cannot decay into objects on the way out.
  local payload = {}
  for key, value in pairs(data) do payload[key] = value end
  for _, field in ipairs({ "columns", "rows" }) do
    if data[field] ~= nil then
      local list, problem = as_array(data[field])
      if problem then
        return { next = "error", error = "widget_" .. problem, field = field }
      end
      payload[field] = list
    end
  end

  local ok, encoded = pcall(json.encode, { template = template, data = payload })
  if not ok or type(encoded) ~= "string" then
    return { next = "error", error = "widget_encode_failed" }
  end
  return { next = "present", value = "```" .. W.FENCE .. "\n" .. encoded .. "\n```" }
end
