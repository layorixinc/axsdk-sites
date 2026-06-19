# AGENTS.md

## Project Purpose

This repository stores site-specific `llms.txt` sitemap data used by the AXSDK Chrome extension. The repository is intended to be public on GitHub, so every file added here must be safe to publish.

## Core Rules

- Treat all repository contents as public data.
- Never commit secrets, private tokens, cookies, internal URLs, customer data, unpublished credentials, or personally identifiable information.
- Keep entries factual and source-based. Do not invent URLs, metadata, or site capabilities.
- Prefer small, reviewable changes. Avoid unrelated formatting churn.
- Preserve existing file naming and directory conventions once they are established.

## Data Guidelines

- Store only data needed by the AXSDK extension to discover or use site-specific `llms.txt` resources.
- Prefer canonical, stable URLs over redirected, tracking, localized, or session-specific URLs.
- Remove query parameters unless they are required for the resource to work.
- Do not add generated timestamps unless the project later defines them as part of a schema.
- If a site has no reliable `llms.txt` source, do not create a placeholder that implies support.

## Project Structure

Use the existing root-level site directory convention. Do not introduce a `sites/` wrapper unless the repository schema is explicitly changed.

```text
index.md
<site>/
  sitemap.md              # route aliases and site navigation, when available
  knowledge/
    index.yaml
    <group>/
      info.json
      knowledge.md
  scripts/
    *.lua                 # AXSDK helpers, when needed
```

Use lowercase hostnames or established site slugs for directory names. Avoid protocol prefixes such as `https://` in paths. Empty directories with only `.gitkeep` are not supported site data; do not list them as supported unless real source-backed data is added.

Keep `index.md` synchronized with populated site entries.

## Lua Script Selectors

AXSDK Lua scripts drive pages through the injected `dom` capability, which resolves only standard CSS selectors (`querySelector` / `querySelectorAll`). Author selectors for stability across deploys and A/B variants, never for the current build's generated markup:

- Never target obfuscated or build-generated class names — CSS-module / styled-component hashes such as `._2Wt7kayvRID5rLVjUZGxyx`, `.css-1a2b3c`, or `[class*="_3iW9"]`. They change on every deploy and differ across A/B variants.
- Prefer stable, meaningful identifiers: `data-test` / `data-testid` attributes, `id` / `name` made of real words, `aria-label`, `role`, semantic elements (`main`, `aside`, `section`, `nav`, `form`), and design-system utility classes whose names are real words.
- When no stable identifier exists, locate the element by document structure and position relative to a semantic anchor: parent/child/sibling combinators, `:has()`, `:not()`, `:nth-*`, `:first-child`, `:last-child`.
- The `dom` capability cannot match by visible text. When an element is distinguishable only by its label, read candidates with `dom.query_all(selector, { text = true })`, confirm the meaningful label in Lua, then click the verified selector.
- Keep shared selectors as named `M.*` constants in `<site>/scripts/00_common.lua` so they are reviewed and updated in one place.

## Validation Before Finishing

Before reporting work as complete:

- Re-read every file you changed.
- Confirm public-safety: no secrets, private endpoints, or personal data.
- Confirm URL accuracy against the source when adding or updating site data.
- Run any validation, formatting, or tests that exist in the repository. If none exist, say so in the final response.

## Style

- Use plain UTF-8 text and Markdown where applicable.
- Keep documentation concise and operational.
- Prefer English for repository-wide technical guidance unless a narrower file already uses another language.
