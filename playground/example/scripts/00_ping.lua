function AX_playground_site_ping(args)
  return {
    layer = "site",
    domain = "example",
    value = args and args.value or nil
  }
end
