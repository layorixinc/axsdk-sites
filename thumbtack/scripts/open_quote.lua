local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before open_quote.lua")
end

function AX_open_quote(args)
  args = args or {}
  local service_id = M.non_empty(args.service_id or args.id)
  local url = M.non_empty(args.url)

  if not service_id and url then
    service_id = M.service_id_from_url(url)
  end

  if service_id or url then
    M.navigate_service_if_needed({ service_id = service_id, url = url })
  end

  -- Wait for the pro page's quote CTA to render, then open the request flow if a step is not already
  -- showing. Detection keys on the active flow step, never M.MODAL_SELECTOR (the page pre-renders
  -- empty modal placeholders that would otherwise look "open").
  dom.wait_for_selector('aside button', { timeout = 30000 })
  if not dom.exists(M.REQUEST_FLOW_ACTIVE_SELECTOR) then
    local opened = M.open_quote_modal()
    if not opened then
      return {
        service_id = service_id or M.service_id_from_url(M.current_url()),
        error = "quote_unavailable"
      }
    end
    dom.wait_for_selector(M.REQUEST_FLOW_ACTIVE_SELECTOR, { timeout = 30000 })
  end

  local update = nil
  if args.answers or args.form_values or args.values or args.fields or args.contact
    or args.value or args.selection or args.selections or args.text or args.details or args.message
    or args.email or args.first_name or args.firstName or args.last_name or args.lastName
    or args.phone or args.phone_number or args.phoneNumber or args.zip_code or args.zip then
    update = AX_answer_quote({
      answers = args.answers,
      form_values = args.form_values or args.values or args.fields,
      value = args.value,
      selection = args.selection,
      selections = args.selections,
      text = args.text,
      details = args.details,
      message = args.message,
      advance = args.advance,
      contact = args.contact,
      email = args.email,
      first_name = args.first_name,
      firstName = args.firstName,
      last_name = args.last_name,
      lastName = args.lastName,
      phone = args.phone,
      phone_number = args.phone_number,
      phoneNumber = args.phoneNumber,
      zip_code = args.zip_code,
      zip = args.zip,
    })
  end

  local form = M.read_project_form()
  if args.submit == true then
    return {
      service_id = service_id or M.service_id_from_url(M.current_url()),
      error = "submit_not_supported_without_explicit_site_flow",
      form = form,
      update = update
    }
  end

  local request_error = (update and update.request_error) or form.request_error
  local result = {
    service_id = service_id or M.service_id_from_url(M.current_url()),
    status = "open",
    form = form,
    update = update
  }
  if request_error then
    result.status = request_error.retry_field and "contact_update_required" or "request_flow_error"
    if not request_error.retry_field then
      result.error = request_error.error
    end
    result.request_error = request_error
    result.retry_field = request_error.retry_field
    result.bad_value = request_error.bad_value
    result.message = request_error.message
    result.question = request_error.question
  end
  return result
end
