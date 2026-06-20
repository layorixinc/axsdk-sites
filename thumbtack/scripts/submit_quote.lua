local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before submit_quote.lua")
end

local function form_has_recaptcha(form)
  local fields = form and form.fields or {}
  for index = 1, #fields do
    if fields[index].id == "g-recaptcha-response" or fields[index].name == "g-recaptcha-response" then
      return true
    end
  end
  return false
end

function AX_submit_quote(args)
  args = args or {}
  local before = M.read_quote_submission_snapshot()
  if args.confirm ~= true then
    return {
      error = "submit_requires_confirm",
      before = before
    }
  end

  local steps = ax.array()
  local max_steps = tonumber(args.max_steps or args.maxSteps or 8) or 8
  for index = 1, max_steps do
    local snapshot = M.read_quote_submission_snapshot()
    if snapshot.ready then
      local clicked = dom.click(M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' button[type="submit"]') == true
      dom.wait(5000)
      local after_submit = M.read_quote_submit_result(snapshot.url)
      steps[#steps + 1] = {
        kind = "submit_click",
        clicked = clicked,
        before = snapshot,
        after = after_submit
      }
      if not clicked then
        return {
          status = "submit_click_failed",
          clicked = false,
          before = before,
          steps = steps,
          after = after_submit
        }
      end
      if after_submit.active_flow ~= true or after_submit.submit_button == nil then
        return {
          status = "submitted",
          clicked = true,
          before = before,
          steps = steps,
          after = after_submit
        }
      end
    else
      local applied = M.apply_form_values(args.form_values or args.values or args.fields)
      local flow = M.update_request_flow_step(args, applied, #applied)
      dom.wait(1500)
      local after_step = M.read_quote_submit_result(snapshot.url)
      steps[#steps + 1] = {
        kind = "answer_step",
        before = snapshot,
        applied = applied,
        flow = flow,
        after = after_step
      }
      if not flow then
        return {
          status = "submit_not_ready",
          before = before,
          steps = steps,
          after = after_step
        }
      end
      if flow.advance_reason == "advance_not_confirmed" and form_has_recaptcha(after_step.form) then
        return {
          status = "verification_required",
          before = before,
          steps = steps,
          after = after_step
        }
      end
      if flow.advance_reason == "missing_answer"
        or flow.advance_reason == "answer_not_applied"
        or flow.advance_reason == "advance_button_not_found"
        or flow.advance_reason == "advance_click_failed" then
        return {
          status = "submit_needs_more_input",
          before = before,
          steps = steps,
          after = after_step
        }
      end
    end
  end

  return {
    status = "submit_incomplete",
    before = before,
    steps = steps,
    after = M.read_quote_submit_result(before.url)
  }
end
