# `axde/workspace` — axde's own workspace

This is what `axde /up <profile>` delivers by default: a working copy laid out exactly like the
product's site workspace, but small enough to iterate in. It is **not** the product's data — the
real one is the repository root, one flag away (`axde --workspace .`).

```text
index.md                    maps https://example.com/ → the site directory `dev`
_common/flows.yaml          the common flow layer (a scaffold — see its own header)
_common/scripts/00_dev.lua  loaded on every host; AX_dev_echo proves the layer arrived
_common/rpc/10_dev.lua      a runtime module, delivered byte-for-byte as `_common.10_dev`
dev/scripts/00_site.lua     loaded only on example.com; proves a site layer arrives as `:dev`
dev/sitemap.md              seeds the site record, which is what `currentSitemap` is read from
```

Why `example.com`: no bot wall, no login, nothing to break, and it is where `axde/packs/src/dev-probe`
already reads a page.

Edit anything here and run `/up <profile>` again — the receipt names every layer it wrote, the byte
counts it read back, and what it did **not** check. Nothing here is published or shipped: it exists
to make a debugging session's failure attributable to the code under test rather than to the
environment.

One boundary worth knowing before the first surprise: the scaffold flow document has never been
compiled. A client flow document is compiled when a session opens, and delivery opens none — so a
green `/up` proves the bytes are in the profile's stores, not that a turn will work.
