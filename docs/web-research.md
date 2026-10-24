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
2. Within the same status, the newest date comes first. A verified finding uses its primary publication date. Other findings use the date of the read article that mentions them. Findings with no established date, a future date, or a date after the range come last.

**Both ends of the range are enforced.** The range runs from its start to its end, inclusive. The end is today for every automatic and "past" choice. A primary date is inside the range only when `start <= date <= end`. A date before the start is *before*. A date after the end is *after*. A date after today is *in the future*. A date that is not a real calendar date (for example `2026-02-30`) is *malformed*, is not used, and is labelled as such.

Each finding gets one date relation, stored as the label in the first column below. The label name itself is internal. The model's context states the relation on a line `date relation to the date range: ...`. The Sources panel shows the matching sentence as a "Note:" under the finding, and only for the labels that have one (`no-date-range` and `published-in-range` have no note). The panel also shows the published and last-updated dates with their sources:

| Label | Meaning | Use in an answer |
| --- | --- | --- |
| `no-date-range` | No range applied ("Any time", or no latest wording). | Give the date only if it is known. |
| `published-in-range` | Verified primary publication date inside the range. | May be described as a recent publication. |
| `older-mentioned-in-range` | Published before the range, but a read article dated inside the range mentions it. | Describe as an older vulnerability mentioned in recent coverage, not as a new discovery. |
| `published-before-range` | Published before the range. | Do not describe it as a recent discovery. |
| `published-after-range` | Verified primary publication date after the end of the range. | Do not describe it as inside the range. |
| `date-in-future` | Verified primary publication date after today. | Not a valid recent date. Do not describe it as recent. |
| `reported-in-range` | No primary date, but a read article dated inside the range mentions it. | Describe as reported in that article. The article date is not the CVE publication date. |
| `reported-after-range` | No primary date, and the read article is dated after the range or in the future. | Do not describe it as recent coverage. |
| `date-malformed` | A date in a source is not a valid calendar date. | Not used. Do not describe it as recent. |
| `date-unknown` | No date can be established. | Do not describe it as recent. |

A read article dated after the range, or in the future, never dates an identifier, and never makes an older identifier look recent.

## What a research run does

1. Searches the question as asked, with the date filter chosen above.
2. For security questions where the results contain no CVE and the question names no identifier:
   - with a named subject, searches `<subject> CVE vulnerability`;
   - with no subject (a broad question), searches the question's own words with `CVE` added. This is the broad identifier search.
   - If the question already names an identifier, this step is skipped.
2a. If a candidate CVE is still not verified after the lookups, one more search may run for it, within the same search cap.
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

It works per sentence and per clause:

- A claim's identifiers are the clause's own, or the sentence's when the clause names none. A claim's citations are the clause's own, or the sentence's when the clause has none.
- **Provenance.** A claim about an identifier must cite a source that supports that field of its finding. The check uses the finding's own source fields:
  - *identity* (the identifier exists and is linked): the primary record, the read sources that link it, or the KEV catalogue;
  - *product* (the identifier affects the subject): the verified primary record, or a read source that links the identifier to the subject. A search result that was never read does not count;
  - *affected versions*: the primary record's version data only;
  - *publication date*: the primary record's date; *article date*: the read article's date;
  - *severity*: the primary record's CVSS, or a read source's stated severity (shown as not verified);
  - *KEV listing*: the KEV catalogue entry only;
  - *exploitation* (a confirmed status, CISA KEV or SSVC active): the source that establishes that status. **The identifier's own record is not a valid citation for an exploitation claim** unless that record is the source that states it.
  A valid citation number that is unrelated to the claim is reported. If none of a claim's citations supports it, the result is an error. If some do and some do not, the unrelated citation is a warning. Neither is a clean result.
- A primary record that supports the identifier does not support its exploitation status, severity or affected versions unless it is that field's source.
- **Limitations, not passes.** The check cannot tell whether a sentence with no identifier is supported by its citation. Those citations are checked for existence only, and the result lists how many there were. A finding with no source fields (an older evidence shape) is also listed under "Not checked", not passed. Statements about identifiers with no citation are listed too.
- A hedge such as "may", "reportedly" or "not verified" only applies to the segment it sits in, between the last clause boundary (`,` `;` `:` `(` or a contrast word such as "but") and the claim. An earlier hedged mention does not suppress a later unqualified claim.
- A hedge in one clause does not neutralise a positive claim in another clause of the same sentence.
- A generic claim with no identifiers ("the vulnerabilities are actively exploited") is supported only when **every** finding is confirmed. One KEV-listed finding is not enough.
- A public proof-of-concept is not confirmed exploitation.
- Citation numbers must match a listed source. An identifier with an EUVD number presented as a CVE number is flagged.

It flags: an unverified identifier stated as fact, an unconfirmed exploitation claim, a generic exploitation claim that is not supported, an invalid citation, a citation that does not support its claim, and possible EUVD-as-CVE confusion. It does not judge whether a sentence is true, whether a source is right, or whether the answer covers the question.

The server does not store the answer text. The result is shown in the Sources panel. The panel states the check's name and that it is not a guarantee of truth, and it lists anything the check could not check.

## Safety of fetches

The code path is in `scripts/search/content.js`:

1. **Early check, `assertPublicUrl`.** Only `http:` and `https:` URLs. Localhost names and literal private addresses are refused. For a host name, the name is resolved and every record must be public. This check gives a clear early error. It is **not** the protection against DNS rebinding, because the connection does not use its answer.
2. **Connection, `connectionOptions` and `safeLookup`.** Each request is made with `lookup: safeLookup`. Node calls this option whenever it opens a socket. `safeLookup` resolves the name again and refuses it if any record is private. Node then connects to the address `safeLookup` returned, so the address that is checked is the address that is dialled.
3. **No reused sockets.** Each request is made with `agent: false`. The default keep-alive agent can reuse a socket without calling `lookup`, which would skip the connect-time check.
4. **TLS.** For a host name, `servername` is the host name. SNI and the certificate check use the name, never the IP address.
5. **Redirects.** Each redirect target goes through the same function again: step 1, then step 2 and step 3 for its own connection. Redirects are capped at 3.

Other limits:

- `localhost`, private, loopback, link-local, CGNAT, benchmarking, multicast, reserved and documentation addresses are blocked. The documentation ranges are `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`. IPv4-mapped IPv6 forms are classified by their IPv4 address.
- Each request has a timeout. Each response is capped in size. An oversized response is rejected, not truncated.
- Page content is capped in size. The browser receives the source list, the findings, and a 280-character excerpt per source. It does not receive the full page text.

What the tests show. `scripts/tests/web-research-fetch.test.cjs` runs the real `fetchRawDocument` code with the DNS lookup and the request function replaced. It shows that: a name that is public during the early check and private at connect time is refused; a redirect to a private address is refused before any request is made; a redirect target that becomes private at connect time is refused; and each request is made with the connect-time lookup and no reused socket. It does not show a real TLS handshake or a real redirect chain on the internet. Those need a live test.

## Known limitations

- **Live source behaviour is not tested in CI.** DuckDuckGo markup, the CVE Services and NVD responses, and the KEV feed can change. The automated tests use synthetic fixtures and fakes only.
- The date filter is provider-side and approximate. Dates come only from primary records and read pages.
- The fetch tests replace DNS and the request function. They show the connect-time check on the code path. They do not show how a real resolver or a real TLS handshake behaves.
- The citation check cannot tell whether a sentence without an identifier is supported by its citation. It reports that, and does not pass it.
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
| `scripts/tests/web-research-provenance.test.cjs` | Citation provenance: a relevant citation, an unrelated one, a wrong product, an exploitation claim cited to the identifier record, and a statement the check cannot check. | Fixtures and fakes |
| `scripts/tests/web-research-dates.test.cjs` | Both ends of the range, future and malformed dates, unknown dates, explicit "Any time". | Fixtures and fakes |
| `scripts/tests/web-research-fetch.test.cjs` | The connect-time check, DNS rebinding, redirects, and address classes. The DNS lookup and request function are replaced. No socket is opened. | Fakes (no network) |
| `scripts/tests/web-research-content.test.cjs` | Address checks, redirects, DuckDuckGo parsing, source tiers. | Fixtures and fakes |
| `scripts/tests/web-research-route.test.cjs` | The HTTP routes, with the server started on a test port. | Local server |

Run them with:

```
node --test scripts/tests/web-research.test.cjs scripts/tests/web-research-content.test.cjs scripts/tests/web-research-route.test.cjs scripts/tests/web-research-correction.test.cjs scripts/tests/web-research-provenance.test.cjs scripts/tests/web-research-dates.test.cjs scripts/tests/web-research-fetch.test.cjs
```

None of these tests calls DuckDuckGo, NVD, CVE Services or CISA. A passing run shows that the rules work on the fixtures. It does not show that the live pipeline works today.

## Manual test (needs internet access; not automated)

Live results change over time. Record the question, the date, the date-range choice and what each step showed. The fixture expectations below are for comparison only and are not the live answer.

### A. Broad question: `What are the latest discovered exploits in cybersecurity?`

1. Start the app and load a text model. Turn on **Web**. Leave the date selector on **Auto dates**. The question contains "latest", so the range should be the past month.
2. Send the question. In the Sources panel, check:
   - **Subject term:** no "Subject term" line is shown, because no subject was identified. Under "Limits of this check" the panel says "No product or entity was named in the question, so no product check was made."
   - **Date range:** the past month, shown as a date range.
   - **Searches:** a count of searches used out of the maximum. The panel shows counts, not the query text.
   - **Findings:** each has a status, a date label, and an exploitation field. The list is newest first within each status.
   - **Dates and notes:** an item published before the range shows the note "Published before the selected date range. Do not describe it as a recent discovery." An item with no established date shows "No publication date could be established, so this cannot be placed in the date range." Each published date shows its source number.
3. Open two Verified findings. Confirm that the identifier and the product appear in the record or page.
4. Read the answer. Confirm that:
   - it does not describe an item with the note "Published before the selected date range" or "No publication date could be established" as a latest discovery;
   - it does not call anything "actively exploited" unless the finding says *Listed in CISA KEV* or *CISA SSVC decision: exploitation active*;
   - it does not name a product for an item that has no product check.
5. Check the citation result. It must be labelled "Deterministic consistency check", with the note that it is "not a guarantee of truth". It must show either "Citation check: no problems found" with counts, or the listed issues. It must flag any claim that a finding does not support.
6. Set the date selector to **Any time**. The Sources panel must say "Date range: any time (your choice)". No finding may carry a "before" or "after" note, and the answer must not give a range.

### B. Specific product: `Is PHP2Shell actively exploited? What are the CVEs?`

1. Turn on **Web**. The question names no time window, so no range is applied. The Sources panel should say so.
2. Send the question. In the Sources panel, check:
   - **Subject term:** PHP2Shell.
   - **Findings:** a CVE finding has a status. Each Verified finding names PHP2Shell in its record.
   - **Exploitation:** "Listed in CISA KEV (known exploited)" only where the KEV feed lists the CVE. A public proof of concept is shown as "CISA SSVC decision: public proof of concept exists (not exploitation)", not as exploitation.
   - **EUVD:** an EUVD identifier is shown as an EUVD identifier, never as a CVE number. Where an EUVD record names a different product, it is a Conflict.
3. Open the source link for each Verified CVE. Confirm the identifier and PHP2Shell appear on the page.
4. Check the answer. Every "actively exploited" statement must be backed by "Listed in CISA KEV (known exploited)" or "CISA SSVC decision: exploitation active". Every CVE number in the answer must match a finding.
5. Check the citation result. It must report no invalid citation, and no unconfirmed exploitation claim.
6. Block `cveawg.mitre.org` (or disconnect the network) and ask again. Each affected CVE must show the status "Primary record could not be retrieved; not verified", and the Limits list must say that no primary record was retrieved for it. The answer must not present that CVE as verified, or give its publication date as fact.

Each step above is a manual check. None of them has been run by the automated tests.
