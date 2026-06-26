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

local function same_normalized(left, right)
  return M.normalize_text(left or "") == M.normalize_text(right or "")
end

local function retry_value_for_request_error(args, request_error)
  if not request_error or not request_error.retry_field then
    return nil
  end
  if request_error.retry_field == "email" then
    return M.request_flow_arg_value(args, { "email" })
  end
  return nil
end

local function should_retry_request_error(args, request_error)
  local retry_value = retry_value_for_request_error(args, request_error)
  if not retry_value then
    return false
  end
  if request_error.bad_value and same_normalized(retry_value, request_error.bad_value) then
    return false
  end
  return true
end

local function request_error_result(before, steps, after, request_error)
  local retryable = request_error and request_error.retry_field ~= nil
  local error_value = nil
  if not retryable then
    error_value = request_error and request_error.error or "request_flow_error"
  end
  return {
    status = retryable and "contact_update_required" or "request_flow_error",
    -- NOT a top-level `error`: a captured request-flow popover is the DESIRED outcome for the test
    -- submit. The flow engine treats a remote result with `error` as a tool failure and skips the
    -- output map (losing `message`), so expose the code as `flow_error` and keep `message` capturable.
    flow_error = error_value,
    request_error = request_error,
    retry_field = request_error and request_error.retry_field or nil,
    bad_value = request_error and request_error.bad_value or nil,
    message = request_error and request_error.message or nil,
    question = request_error and request_error.question or nil,
    before = before,
    steps = steps or ax.array(),
    after = after
  }
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

  local request_error = M.read_request_flow_error()
  if request_error then
    if not should_retry_request_error(args, request_error) then
      return request_error_result(before, ax.array(), before, request_error)
    end
    M.dismiss_request_flow_error()
    dom.wait(250)
  end

  local steps = ax.array()
  local max_steps = tonumber(args.max_steps or args.maxSteps or 8) or 8
  for index = 1, max_steps do
    local snapshot = M.read_quote_submission_snapshot()
    if snapshot.ready then
      -- Fill any provided contact (reserved test phone/zip/email) into the contact step before the
      -- submit click, so the submit carries data and Thumbtack returns a real validation popover
      -- (e.g. invalid phone) we can capture — rather than an empty-field prompt.
      M.apply_request_flow_contact_values(args, ax.array())
      dom.wait(900)
      local clicked = dom.click(M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' button[type="submit"]') == true
      dom.wait(1500)
      local after_submit = M.read_quote_submit_result(snapshot.url)
      steps[#steps + 1] = {
        kind = "submit_click",
        clicked = clicked,
        before = snapshot,
        after = after_submit
      }
      if after_submit.request_error then
        return request_error_result(before, steps, after_submit, after_submit.request_error)
      end
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
      dom.wait(500)
      local after_step = M.read_quote_submit_result(snapshot.url)
      steps[#steps + 1] = {
        kind = "answer_step",
        before = snapshot,
        applied = applied,
        flow = flow,
        after = after_step
      }
      local step_request_error = after_step.request_error or (flow and flow.request_error)
      if step_request_error then
        return request_error_result(before, steps, after_step, step_request_error)
      end
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
