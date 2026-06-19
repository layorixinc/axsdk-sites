local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before request_quote.lua")
end

function AX_request_quote(args)
  args = args or {}
  local service_id = M.non_empty(args.service_id or args.id)
  local url = M.non_empty(args.url)

  if not service_id and url then
    service_id = M.service_id_from_url(url)
  end

  if service_id or url then
    local navigated = M.navigate_service_if_needed({ service_id = service_id, url = url })
    if navigated then
      return {
        service_id = service_id,
        pending = true,
        error = "navigation_pending"
      }
    end
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
  if args.answers or args.form_values or args.values or args.fields then
    update = AX_update_project({
      answers = args.answers,
      form_values = args.form_values or args.values or args.fields
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

  return {
    service_id = service_id or M.service_id_from_url(M.current_url()),
    status = "open",
    form = form,
    update = update
  }
end
