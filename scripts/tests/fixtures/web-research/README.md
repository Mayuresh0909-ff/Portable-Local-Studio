# Web research fixtures (synthetic)

These files exist only to test matching, contradiction handling, citation integrity and uncertainty behaviour.

- Identifiers and product names (PHP2Shell, CVE-2026-109618, CVE-2026-109619, News Kit Addons for Elementor,
  CVE-2026-97353, EUVD-2026-108013) are taken from the user's screenshot and used as test inputs.
- Descriptions, affected versions, dates, CVSS values, KEV entries and every other detail are invented for the test.
  They are NOT real advisory data and must not be used as facts about any real vulnerability.
- URLs are never fetched by the tests. They are passed through injected fake fetchers.
- The application never hardcodes these results. Live answers come from the live sources at run time.
