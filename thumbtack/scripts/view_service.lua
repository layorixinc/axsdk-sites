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

  local navigated = M.navigate_service_if_needed({ service_id = service_id, url = url })
  if navigated then
    return {
      service_id = service_id,
      pending = true,
      error = "navigation_pending"
    }
  end

  if service_id and not M.current_service_matches(service_id) and not url then
    return {
      service_id = service_id,
      error = "missing_service_url"
    }
  end

  dom.wait_for_selector(M.SERVICE_READY_SELECTOR, { timeout = 30000 })
  M.dismiss_modals()
  return M.read_service_view(service_id)
end
