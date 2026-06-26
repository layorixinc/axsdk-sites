local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before open_quote.lua")
end

function AX_open_quote(args)
  args = args or {}
  local url = M.non_empty(args.url)
  local service_id = M.non_empty(args.service_id or args.id)
  if not service_id and url then
    service_id = M.service_id_from_url(url)
  end

  -- Detect the current page once (instant URL + light DOM read; no navigation, no durable resume,
  -- thumbtack/CONTRACT.md §1). Used to skip the cross-nav when already on the target pro and for
  -- idempotent re-entry when the dialog is already open.
  local page = (AX_detect_page and AX_detect_page()) or { page = "other", ready = false }
  local on_target = (page.page == "pro_profile" or page.page == "quote_dialog")
    and (not service_id or page.service_id == service_id)

  -- Navigate to the target pro only when not already on it. Same-origin navigation is a durable step
  -- that suspends and replays once the pro has loaded (this mirrors AX_view_service, the proven nav
  -- path) -- it is NOT fire-and-forget, so the call cannot "return early" across it. Skipping it when
  -- already on the pro keeps the common case (flow-after-view / harness) free of an unnecessary
  -- cross-nav resume.
  if not on_target and (url or service_id) then
    local nav_result = M.navigate_service_if_needed({ service_id = service_id, url = url })
    if not nav_result.ok then
      return {
        service_id = service_id or M.service_id_from_url(M.current_url()),
        status = "quote_unavailable",
        error = "quote_unavailable",
        reason = nav_result.reason
      }
    end
  end

  -- On the pro. Open the request-flow dialog if a step is not already showing. No blind selector
  -- waits: navigate_verified already gated on the pro rendering, and open_quote_modal locates the CTA
  -- by verified label and confirms the active step actually mounts. Detection keys on the active
  -- step, never M.MODAL_SELECTOR (the page pre-renders empty modal placeholders that look "open").
  if not dom.exists(M.REQUEST_FLOW_ACTIVE_SELECTOR) then
    if not M.open_quote_modal() then
      return {
        service_id = service_id or M.service_id_from_url(M.current_url()),
        status = "quote_unavailable",
        error = "quote_unavailable"
      }
    end
  end

  local update = nil
  if args.answers or args.form_values or args.values or args.fields or args.contact
    or args.value or args.selection or args.selections or args.text or args.details or args.message
    or args.email or args.first_name or args.firstName or args.last_name or args.lastName
    or args.phone or args.phone_number or args.phoneNumber or args.zip_code or args.zip
    or args.auto == true or args.auto_answer == true or args.user_requirements or args.requirements
    or args.requestText or args.description then
    update = AX_answer_quote({
      answers = args.answers,
      form_values = args.form_values or args.values or args.fields,
      value = args.value,
      selection = args.selection,
      selections = args.selections,
      text = args.text,
      details = args.details,
      message = args.message,
      auto = args.auto,
      auto_answer = args.auto_answer,
      user_requirements = args.user_requirements,
      requirements = args.requirements,
      requestText = args.requestText,
      description = args.description,
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
  local update_retry_field = update and update.retry_field
  local result = {
    service_id = service_id or M.service_id_from_url(M.current_url()),
    status = "open",
    form = form,
    questions = form.questions,
    all_questions_available = form.all_questions_available,
    question_collection_status = form.question_collection_status,
    update = update,
    contact = update and update.contact or nil
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
  elseif update_retry_field then
    result.status = update.status or "needs_answer"
    result.retry_field = update_retry_field
    result.message = update.message
    result.question = update.question
  end
  return result
end
