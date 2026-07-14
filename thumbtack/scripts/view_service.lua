local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before view_service.lua")
end

function AX_view_service(args)
  args = args or {}
  local service_id = M.non_empty(args.service_id or args.id)
  local url = M.non_empty(args.url)

  if not service_id and url then
    service_id = M.service_id_from_url(url)
  end

  if not service_id and not url then
    return {
      error = "missing_service_id_or_url"
    }
  end

  -- Single detect_page coordinator (thumbtack/CONTRACT.md §5): gate on the detector's page
  -- classification, not an ad-hoc current_service_matches check, so URL-pattern drift stays
  -- localized to detect_page.lua. Navigate (idempotent) only when not already on the target pro.
  local page = (type(AX_detect_page) == "function") and AX_detect_page() or {}
  local on_target = (page.page == "pro_profile" or page.page == "quote_dialog")
    and (not service_id or page.service_id == service_id)

  if not on_target then
    M.navigate_service_if_needed({ service_id = service_id, url = url })
    page = (type(AX_detect_page) == "function") and AX_detect_page() or {}
    on_target = (page.page == "pro_profile" or page.page == "quote_dialog")
      and (not service_id or page.service_id == service_id)
  end

  if not on_target and service_id and not url then
    return {
      service_id = service_id,
      error = "missing_service_url"
    }
  end

  dom.wait_for_selector(M.SERVICE_READY_SELECTOR, { timeout = 8000 })
  M.dismiss_modals()
  return M.read_service_view(service_id)
end
