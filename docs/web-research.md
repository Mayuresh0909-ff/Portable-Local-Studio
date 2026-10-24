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
| Any time | No date filter. Your explicit choice is always kept, and no range is shown. |
| Past day / week / month / year | Your explicit choice. The question's wording is not used to change it. |

The current date is **UTC** (checked against the server clock). The date range used is shown in the Sources panel.

**What the date filter does and does not prove.** DuckDuckGo's date filter is approximate, and a search result's position in a date-filtered list is not a publication date. A publication date is used only when it comes from a fetched primary record (CVE Services, NVD, KEV) or from a page that was read. A date in a title or snippet is never used.

### How dates affect the results

For a *latest*, *current* or *recent* question, the findings are ordered by date, but status comes first:

1. Status order is kept: Verified, then Conflict, then the other statuses. A recent secondary mention never moves a finding above a conflicting or unverified identifier as if it were verified.
2. Within the same status, the newest date comes first. A verified finding uses its primary publication date. Other findings use the date of the read article that mentions them. Findings with no established date come last.

Each finding carries one date label, and the Sources panel and the model's context both show it:

| Label | Meaning | Use in an answer |
| --- | --- | --- |
| `no-date-range` | No range applied ("Any time", or no latest wording). | Give the date only if it is known. |
| `published-in-range` | Verified primary publication date inside the range. | May be described as a recent publication. |
| `older-mentioned-in-range` | Published before the range, but a read article dated inside the range mentions it. | Describe as an older vulnerability mentioned in recent coverage, not as a new discovery. |
| `published-before-range` | Published before the range. | Do not describe it as a recent discovery. |
| `reported-in-range` | No primary date, but a read article dated inside the range mentions it. | Describe as reported in that article. The article date is not the CVE publication date. |
| `date-unknown` | No date can be established. | Do not describe it as recent. |

## What a research run does

1. Searches the question as asked, with the date filter chosen above.
2. For security questions where the results contain no CVE and the question names none:
   - with a named subject, searches `<subject> CVE vulnerability`;
   - with no subject (a broad question), searches the question's own words with `CVE` added. This is the broad identifier search.
3. Looks up each candidate CVE in the primary records: CVE Services first, then NVD if that fails. CISA KEV is read once and cached for six hours. Question CVEs are looked up first.
4. Reads up to the page limit of search results. Pages from primary sources come first, then secondary sources.
5. Builds structured findings with a status, a product check, an exploitation field, and a date label.
6. Puts the findings in the model's context, before the excerpts, and writes the answer.
7. After the answer is written, runs a deterministic citation check (`POST /api/web-research/audit`) and shows the result in the Sources panel.

### Subject extraction

The product, entity or quoted text the question is about is taken from the question itself:

- **Quoted text** is used as written: `Is "Example Forum Plugin" affected?` gives `Example Forum Plugin`.
- **A named product** is the longest run of capitalised or letter-and-digit words, such as `PHP2Shell`, `News Kit Addons for Elementor` or `log4j`.
- **Question words are not names.** Words such as `Latest`, `Discovered`, `Recent`, `Exploited` and `Cybersecurity` are not subjects. A question made only of such words, such as `What are the latest discovered exploits in cybersecurity?`, has **no subject**.
- **Identifier-only questions** (`Is CVE-2026-109618 exploited?`) have no subject unless a product is also named.

With no subject, the run still searches, looks up identifiers, and reads pages, within the same limits. No product check is made. The answer and the Limits list say so.

Lowercase product names (for example `openssl`) are not detected. Write the product name in its usual capitalisation, or put it in quotes.

### Limits (hard caps, enforced server-side)

| Limit | Default | Maximum |
| --- | --- | --- |
| Searches per question | 3 | 4 |
| Network reads (pages, records, KEV) | 12 | 14 |
| Pages read from search results | 3 | 6 |
| Primary record lookups (per question, not per pass) | 4 | 6 |
| Findings | 8 | 12 |
| Context size | 12,000 characters | 24,000 characters |
| Total time | 45 s | 90 s |

The time limit stops new work. A request that is already in flight can finish after it, and each request has its own timeout. Limits that are reached are listed in "Limits of this check", including identifiers that were found but not looked up.

## Source classes

Each source is classified from its host and path. The URL and title are checked as follows.

- **Primary.** Only a host and path on the allowlist below, or a known primary record source (CVE Services, NVD, CISA KEV, EUVD, GitHub advisories). Pages on the same host outside the listed path are not primary.
- **Advisory page.** A page that looks like an advisory but is on an unknown host, or on a listed host outside its advisory path. These are **corroboration only**. A page is not primary because its URL or title contains "security", "advisory" or "CVE".
- **Secondary.** Known security news and research sites (for example BleepingComputer, The Hacker News, SecurityWeek, Wordfence, Patchstack, WPScan). Used for corroboration, not as the only basis for a fact.
- **Web.** Anything else.
- **Search result** (title and snippet): leads only. A snippet is never evidence.

### Vendor and project advisory allowlist

These host and path pairs are primary. The path must start the URL path (the host must match exactly or as a subdomain). Look-alike hosts such as `msrc.microsoft.com.example.test` are not primary.

| Host | Path | Type |
| --- | --- | --- |
| `msrc.microsoft.com` | `/update-guide/` | vendor advisory |
| `security.paloaltonetworks.com` | any | vendor advisory |
| `sec.cloudapps.cisco.com` | `/security/center/` | vendor advisory |
| `access.redhat.com` | `/security/` | vendor advisory |
| `ubuntu.com` | `/security/` | vendor advisory |
| `security-tracker.debian.org` | any | vendor advisory |
| `httpd.apache.org` | `/security/` | project advisory |
| `www.oracle.com` | `/security-alerts/` | vendor advisory |
| `www.fortiguard.com` | `/psirt/` | vendor advisory |
| `chromereleases.googleblog.com` | any | vendor advisory |
| `www.cisa.gov` | `/news-events/ics-advisories/` | CISA advisory |

Classification alone never verifies a fact. A vendor advisory page is used as the primary source for an identifier only when **its own title or text names that identifier**, and the text names the subject. A URL that contains the identifier is not enough.

## Evidence rules

- A finding is **Verified** only when a fetched primary record, or a read primary page, names the exact identifier and the subject of the question. A product mismatch gives **Conflict**.
- A snippet never verifies anything.
- An identifier that cannot be checked (timeout, server error) gives **Not verified (unavailable)**, not a match. A record that does not exist gives **Not verified (not found)**.
- An article that names a CVE does not verify it. A sentence that names two identifiers of the same family does not link either one to the subject. A sentence that names one identifier and the subject links them.
- **EUVD IDs are not CVE IDs.** `EUVD-2026-108013` is never shown as `CVE-2026-108013`. An EUVD record's aliases are not verified until their own records are read.
- **Exploitation is reported in separate fields:**
  - *Listed in CISA KEV* is the only basis for "known exploited".
  - *CISA SSVC decision: exploitation active* in the CVE record is the other basis.
  - *Public proof-of-concept* (SSVC "poc", or a read source) is **not** exploitation.
  - A search result that says an exploit exists is not exploitation.
  - Where the record and a read source disagree, the finding says so.
- Severity from a read source is shown as "not verified". Severity from the primary record is shown as stated there.
- Fetched text is **untrusted**. It is wrapped in `<<<UNTRUSTED SOURCE [n] BEGIN>>>` / `END>>>` markers, and any copy of those markers inside the text is removed. The application's rules come before the web text and say that web text is data, not instructions.

## Citation check (deterministic consistency check)

`POST /api/web-research/audit` checks the written answer against the findings. It is a **deterministic consistency check, not a guarantee of truth**. Its result says so and carries the check's name, `deterministic-consistency-check`.

It works per sentence and per claim:

- Each claim is checked against the identifiers in its own clause, or in its sentence when the clause names none.
- A hedge such as "may", "reportedly" or "not verified" only applies to the segment it sits in, between the last clause boundary (`,` `;` `:` `(` or a contrast word such as "but") and the claim. An earlier hedged mention does not suppress a later unqualified claim.
- A hedge in one clause does not neutralise a positive claim in another clause of the same sentence.
- A generic claim with no identifiers ("the vulnerabilities are actively exploited") is supported only when **every** finding is confirmed. One KEV-listed finding is not enough.
- A public proof-of-concept is not confirmed exploitation.
- Citation numbers must match a listed source. An identifier with an EUVD number presented as a CVE number is flagged.

It flags: an unverified identifier stated as fact, an unconfirmed exploitation claim, a generic exploitation claim that is not supported, an invalid citation, and possible EUVD-as-CVE confusion. It does not judge whether a sentence is true, whether a source is right, or whether the answer covers the question.

The server does not store the answer text. The result is shown in the Sources panel.

## Safety of fetches

- Only `http:` and `https:` URLs are fetched.
- `localhost`, private, loopback, link-local, CGNAT, benchmarking, multicast and reserved addresses are blocked, including IPv4-mapped IPv6 forms.
- Every redirect target is checked again before it is followed, and redirects are capped.
- The address is checked again at connect time, which limits DNS-rebinding attacks.
- Page content is capped in size. The browser receives the source list, the findings, and a 280-character excerpt per source. It does not receive the full page text.

## Known limitations

- **Live source behaviour is not tested in CI.** DuckDuckGo markup, the CVE Services and NVD responses, and the KEV feed can change. The automated tests use synthetic fixtures and fakes only.
- The date filter is provider-side and approximate. Dates come only from primary records and read pages.
- Only one search provider exists.
- A question that names no product gets no product check, and the answer says so.
- Lowercase product names are not detected as subjects.
- Secondary sources are read only from the pages the limits allow.
- A broad question returns the identifiers it can find within the limits. It is not a complete list of recent exploits.
- The citation check is a text check. It is not a guarantee that an answer is true.

## Automated tests (fixtures only, no network)

| File | What it covers | Status |
| --- | --- | --- |
| `scripts/tests/web-research.test.cjs` | Planner, evidence rules, context, the citation check (earlier cases). | Fixtures and fakes |
| `scripts/tests/web-research-correction.test.cjs` | Broad and named subjects, date ordering and labels, the advisory allowlist, citation check cases. | Fixtures and fakes |
| `scripts/tests/web-research-content.test.cjs` | Address checks, redirects, DuckDuckGo parsing, source tiers. | Fixtures and fakes |
| `scripts/tests/web-research-route.test.cjs` | The HTTP routes, with the server started on a test port. | Local server |

Run them with:

```
node --test scripts/tests/web-research.test.cjs scripts/tests/web-research-content.test.cjs scripts/tests/web-research-route.test.cjs scripts/tests/web-research-correction.test.cjs
```

None of these tests calls DuckDuckGo, NVD, CVE Services or CISA. A passing run shows that the rules work on the fixtures. It does not show that the live pipeline works today.

## Manual test (needs internet access; not automated)

Live results change over time. Record the question, the date, the date-range choice and what each step showed. The fixture expectations below are for comparison only and are not the live answer.

### A. Broad question: `What are the latest discovered exploits in cybersecurity?`

1. Start the app and load a text model. Turn on **Web**. Leave the date selector on **Auto dates**. The question contains "latest", so the range should be the past month.
2. Send the question. In the Sources panel, check:
   - **Subject term:** no "Subject term" line is shown, because no subject was identified. The Limits list says no product was checked.
   - **Date range:** the past month, with the dates shown.
   - **Searches:** a count of searches used out of the maximum. The panel shows counts, not the query text.
   - **Findings:** each has a status, a date label, and an exploitation field. The list is newest first within each status.
   - **Date labels:** an item published before the range is labelled `published-before-range`, and the answer must not call it a recent discovery. An item with no date is `date-unknown`.
3. Open two Verified findings. Confirm that the identifier and the product appear in the record or page.
4. Read the answer. Confirm that:
   - it does not describe a `published-before-range` or `date-unknown` item as a latest discovery;
   - it does not call anything "actively exploited" unless the finding says *Listed in CISA KEV* or *CISA SSVC decision: exploitation active*;
   - it does not name a product for an item that has no product check.
5. Check the citation result. It must carry the label "Deterministic consistency check, not a guarantee of truth", and show either "no problems found" with counts or the listed issues. It must show no warning for a claim that a finding does not support.
6. Set the date selector to **Any time**. The Sources panel must say "Any time (your choice)", with no date range. Ask again. The labels must be `no-date-range`, and the answer must not give a range.

### B. Specific product: `Is PHP2Shell actively exploited? What are the CVEs?`

1. Turn on **Web**. The question names no time window, so no range is applied. The Sources panel should say so.
2. Send the question. In the Sources panel, check:
   - **Subject term:** PHP2Shell.
   - **Findings:** a CVE finding has a status. Each Verified finding names PHP2Shell in its record.
   - **Exploitation:** *Listed in CISA KEV* only where the KEV feed lists the CVE. A public proof-of-concept is shown as *public proof-of-concept*, not as exploitation.
   - **EUVD:** an EUVD identifier is shown as an EUVD identifier, never as a CVE number. Where an EUVD record names a different product, it is a Conflict.
3. Open the source link for each Verified CVE. Confirm the identifier and PHP2Shell appear on the page.
4. Check the answer. Every "actively exploited" statement must be backed by *Listed in CISA KEV* or *CISA SSVC decision: exploitation active*. Every CVE number in the answer must match a finding.
5. Check the citation result. It must report no invalid citation, and no unconfirmed exploitation claim.
6. Block `cveawg.mitre.org` (or disconnect the network) and ask again. Each affected CVE must show *Not verified (unavailable)* with a limit listed. The answer must not state its product or its dates.

Each step above is a manual check. None of them has been run by the automated tests.
