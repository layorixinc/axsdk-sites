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

## Suggested Structure

Until a stricter schema is introduced, keep additions simple and predictable:

```text
sites/
  example.com/
    llms.txt
```

Use lowercase hostnames for directory names. Avoid protocol prefixes such as `https://` in paths.

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
