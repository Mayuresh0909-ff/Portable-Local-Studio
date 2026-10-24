# Web research (local model Web Search)

This document describes how the **Web** toggle in the chat works, what it can and cannot verify, and how to test it.

## Provider

- **DuckDuckGo is the default and the only provider.** It needs no account and no API key.
- The search request is sent to `html.duckduckgo.com`. Nothing else is required to use web search.
- **No alternative provider is implemented.** `GET /api/web-search/config` reports `providers` with `requiresApiKey: false`.
- If an alternative provider is added later, it must be optional. Its credential must come from an environment variable on the server, must never be sent to the browser or written to the cache or logs, and must be documented here with its setup steps.

## Date filter

The chat has a date-range selector next to the Web toggle.

| Choice | Behaviour |
| --- | --- |
| Auto dates (default) | Inferred from the question: "today" gives the past day, "this week" the past week, "this year" the past year, and "latest", "current", "recent", "news" give the past month. No wording gives no filter. |
| Any time | No date filter. Your explicit choice is always kept. |
| Past day / week / month / year | Your explicit choice. The question's wording is not used to change it. |

The current date is **UTC** (checked against the server clock). The date range used is shown in the Sources panel. DuckDuckGo's date filter is approximate, so publication dates are taken only from pages that were read.

## What a research run does

1. Searches the question as asked.
2. For security questions with no CVE in the results, searches for the subject with "CVE vulnerability".
3. Looks up each candidate CVE in the primary records: CVE Services first, then NVD if that fails. CISA KEV is read once and cached for six hours.
4. Reads up to the page limit of search results. Pages from primary sources come first, then secondary sources.
5. Builds structured findings and an evidence block for the model.
6. After the answer is written, runs a deterministic citation check (`POST /api/web-research/audit`) and shows the result in the Sources panel.

### Limits (hard caps, enforced server-side)

| Limit | Default | Maximum |
| --- | --- | --- |
| Searches per question | 3 | 4 |
| Network reads (pages, records, KEV) | 12 | 14 |
| Pages read from search results | 3 | 6 |
| Primary record lookups | 4 | 6 |
| Findings | 8 | 12 |
| Context size | 12,000 characters | 24,000 characters |
| Total time | 45 s | 90 s |

The time limit stops new work. A request that is already in flight can finish after it, and each request has its own timeout. Limits that are reached are listed in "Limits of this check".

## Source hierarchy

- **Primary:** CVE records (cve.org / CVE Services), NVD, CISA KEV, vendor or project advisories, EUVD and GitHub advisories.
- **Secondary:** known security news and research sites. Used for corroboration, not as the only basis for a fact.
- **Advisory pages** on unknown hosts: corroboration only. The publisher is not verified.
- **Search results** (title and snippet): leads only. A snippet is never evidence.

## Evidence rules

- A finding is **Verified** only when a fetched primary record names the exact identifier and the subject of the question. A product mismatch gives **Conflict**.
- An identifier that cannot be checked (timeout, server error) gives **Not verified (unavailable)**, not a match. A record that does not exist gives **Not verified (not found)**.
- An article that names a CVE does not verify it. A sentence that names two identifiers does not link either one to the subject.
- **EUVD IDs are not CVE IDs.** `EUVD-2026-108013` is never shown as `CVE-2026-108013`. An EUVD record's aliases are not verified until their own records are read.
- **Exploitation is reported in separate fields:**
  - *Listed in CISA KEV* is the only basis for "known exploited".
  - *CISA SSVC decision: exploitation active* in the CVE record is the other basis.
  - *Public proof-of-concept* (SSVC "poc", or a read source) is not exploitation.
  - A search result that says an exploit exists is not exploitation.
  - Where the record and a read source disagree, the finding says so.
- Severity from a read source is shown as "not verified". Severity from the primary record is shown as stated there.
- Fetched text is **untrusted**. It is wrapped in `<<<UNTRUSTED SOURCE [n] BEGIN>>>` / `END>>>` markers, and any copy of those markers inside the text is removed. The application's rules come before the web text and say that web text is data, not instructions.

## Safety of fetches

- Only `http:` and `https:` URLs are fetched.
- `localhost`, private, loopback, link-local, CGNAT, benchmarking, multicast and reserved addresses are blocked, including IPv4-mapped IPv6 forms.
- Every redirect target is checked again before it is followed, and redirects are capped.
- The address is checked again at connect time, which limits DNS-rebinding attacks.
- Page content is capped in size. The browser receives the source list, the findings, and a 280-character excerpt per source. It does not receive the full page text.

## Known limitations

- Live source behaviour is not tested in CI. DuckDuckGo markup, the CVE Services and NVD responses, and the KEV feed can change.
- The date filter is provider-side and approximate.
- Only one search provider exists.
- A question that names no product gets no product check, and the answer says so.
- Secondary sources are read only from the pages the limits allow.
- The citation check is a text check. It catches invalid citations, unconfirmed exploitation claims, and EUVD-as-CVE confusion. It does not judge whether a sentence is true.

## Manual test (needs internet access)

Use a current security question. Example: `What are the latest CVEs for <product name>, and are any actively exploited?`

1. Start the app and load a text model. Turn on **Web**. Leave the date selector on **Auto dates**.
2. Send the question. Check the Sources panel:
   - the date range is shown, and it is the past month for "latest";
   - each CVE has a status: Verified, Conflict, Not verified, or Reported;
   - a Verified CVE has a primary source, a product, and a publication date;
   - exploitation says *Listed in CISA KEV*, *CISA SSVC*, *public proof-of-concept*, or *no exploitation stated*.
3. Open the source links for two findings and confirm the identifier and product appear there.
4. Repeat with the date selector set to **Any time**. The Sources panel must say "any time (your choice)".
5. Turn off the network, or block `cveawg.mitre.org`. Ask again. Each affected CVE must show *Not verified*, with a limit listed, and the answer must not state its product or dates.
6. Check that the answer does not call anything "actively exploited" unless the finding says *Listed in CISA KEV* or *CISA SSVC decision: exploitation active*. The citation check must show no warning for such a claim.

Record the question, the date, and what each step showed. Live results change over time, so they are not part of the automated tests.
