# axde's own workspace

The sites this workspace declares. Core's grammar decides the two halves of every line: the first
`http(s)` link is the HOST a page is matched against, and the site directory is the first non-http
link's target — or, when there is none, the first link's own text. So the line below maps
`example.com` to the directory `dev/`.

## Sites

- [dev](https://example.com/): a page with no bot wall, no login and nothing to break. It is where
  `axde/packs/src/dev-probe` reads a document, and it is enough to prove a site layer arrives.
