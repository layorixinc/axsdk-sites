# dev (example.com)

A sitemap exists here to prove one delivery path: the seeded site record. Core prefers a cached
record and reads `currentSitemap` off it, so a workspace that ships no record has its sitemap
answered from the app's own site index instead — which is a different document with different
content, and the difference used to be invisible.

## Pages

- [home](https://example.com/): the whole site. It states what it is and links to IANA's
  documentation of the reserved example domains.
