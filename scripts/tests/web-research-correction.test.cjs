// Behaviour tests for the web research correction pass: subject extraction for broad questions, date-aware
// ordering, the source-class allowlist, and the consistency check of answers.
//
// EXECUTED: every test runs in this process. Search results, record fetches and page fetches are fakes built from
// the SYNTHETIC fixtures in scripts/tests/fixtures/web-research/ or from small inline objects. Nothing is sent to
// the network, and no live result is asserted. The fixture identifiers and product names come from the user's
// example and are used only as test inputs. Their details are invented.
//
// NOT TESTED HERE: live DuckDuckGo results, live NVD/CVE Services responses, and today's KEV feed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const { comprehensiveWebSearch } = require(path.join(root, "scripts", "search", "core.js"));
const { extractSubject, resolveTimeWindow } = require(path.join(root, "scripts", "search", "planner.js"));
const { buildFindings } = require(path.join(root, "scripts", "search", "evidence.js"));
const { classifySource, VENDOR_ADVISORY_SOURCES } = require(path.join(root, "scripts", "search", "sources.js"));
const { auditAnswer, CHECK_NAME } = require(path.join(root, "scripts", "search", "citation-audit.js"));
const f = require(path.join(__dirname, "support", "web-research-fakes.cjs"));

const NOW = new Date("2026-10-24T06:00:00Z");
const tmpCache = () => fs.mkdtempSync(path.join(os.tmpdir(), "web-research-correction-"));
const WINDOW_MONTH = { applied: "month", from: "2026-09-23", to: "2026-10-24", source: "inferred", label: "past month", code: "m" };

async function run(query, o = {}) {
  const searchLog = [];
  const rawLog = [];
  const result = await comprehensiveWebSearch(query, {
    noCache: true,
    cacheDir: tmpCache(),
    now: () => NOW,
    timeFilter: o.timeFilter,
    maxLookups: o.maxLookups,
    maxSearches: o.maxSearches,
    deps: {
      webSearch: o.webSearch || f.fakeWebSearch([[/.*/, f.searchResultsFromFixture()]], searchLog),
      fetchRaw: f.fakeFetchRaw(o.raw || f.standardRaw(), rawLog),
      fetchPage: f.fakeFetchPage(o.pages || new Map()),
    },
  });
  return { result, searchLog, rawLog };
}

const findingFor = (result, id) => result.findings.find((finding) => finding.identifier === id) || null;

// A primary CVE record as the pipeline stores it after a fetch. Only the fields the evidence rules read are set.
function recordSource(index, id, { product = "PHP2Shell", published = "2026-09-02", state = "PUBLISHED", description = null } = {}) {
  return {
    index,
    url: `https://cveawg.mitre.org/api/cve/${id}`,
    title: `${id} - CVE record`,
    snippet: "",
    origin: "lookup",
    provider: "lookup",
    tier: "primary",
    sourceType: "cve-record",
    fetchStatus: "fetched",
    record: {
      kind: "cve-record",
      id,
      state,
      title: `${product} issue`,
      description: description || `Synthetic record for ${product} (${id}).`,
      products: [{ vendor: "Synthetic Vendor", product, versions: ["1.0 before 1.1"] }],
      productNames: ["Synthetic Vendor", product],
      published,
      updated: null,
      cvss: null,
      ssvcExploitation: null,
      references: [],
    },
  };
}

// A read article from a secondary source. `sentences` are the page sentences; `published` is its date.
function articleSource(index, sentences, published, title = "Synthetic article") {
  return {
    index,
    url: `https://www.bleepingcomputer.com/news/article-${index}/`,
    title,
    snippet: "",
    origin: "search",
    tier: "secondary",
    sourceType: "security-news",
    fetchStatus: "fetched",
    published,
    page: { title, sentences, published, updated: null },
  };
}

const lookupFor = (index, id) => [id, { attempts: [{ ok: true, sourceIndex: index }], record: true }];

// ---------------------------------------------------------------------------------------------------------------
// Task 1: subject extraction and broad questions
// ---------------------------------------------------------------------------------------------------------------

test("task 1: broad category questions have no subject (regression: 'discovered cybersecurity')", () => {
  assert.equal(extractSubject("What are the latest discovered exploits in cybersecurity?").subject, null);
  assert.equal(extractSubject("Which are the latest discovered exploits?").subject, null);
});

test("task 1: broad questions with only descriptive words have no subject", () => {
  for (const query of ["Cybersecurity news today", "Discovered exploits this week", "Latest CVEs in 2026", "What is new in malware?", "Recent zero-day attacks"]) {
    assert.equal(extractSubject(query).subject, null, query);
  }
});

test("task 1: named products are still recognised, including multi-word names and letter-digit names", () => {
  assert.equal(extractSubject("Is PHP2Shell actively exploited? What are the CVEs?").subject, "PHP2Shell");
  assert.equal(extractSubject("Any update on News Kit Addons for Elementor CVE-2026-97353?").subject, "News Kit Addons for Elementor");
  assert.equal(extractSubject("Are log4j attacks ongoing?").subject, "log4j");
  assert.equal(extractSubject("Latest Apache vulnerabilities").subject, "Apache");
});

test("task 1: quoted subjects win, even when the words would be descriptive", () => {
  const quoted = extractSubject('Is "Latest Discovered Exploits" a product?');
  assert.equal(quoted.subject, "Latest Discovered Exploits");
  assert.equal(quoted.method, "quoted");
  assert.equal(extractSubject('Is "Example Forum Plugin" affected?').subject, "Example Forum Plugin");
});

test("task 1: identifier-specific questions use the identifier, and a named product when there is one", () => {
  assert.equal(extractSubject("Is CVE-2026-109618 exploited?").subject, null);
  assert.equal(extractSubject("Is CVE-2026-109618 in PHP2Shell exploited?").subject, "PHP2Shell");
  assert.equal(extractSubject("EUVD-2026-108013 Example Forum Plugin").subject, "Example Forum Plugin");
});

test("task 1: a lone descriptive capital word at the start is not a subject", () => {
  assert.equal(extractSubject("Discovered PHP2Shell exploits").subject, "PHP2Shell");
  assert.equal(extractSubject("Latest News").subject, null);
});

test("task 1: a broad question still runs bounded research, looks up identifiers, and says no product was checked", async () => {
  const { result, rawLog } = await run("What are the latest discovered exploits in cybersecurity?", {
    pages: new Map([[f.URLS.news, f.htmlPage("incident-article.html")]]),
  });
  assert.equal(result.research.subject.value, null);
  assert.ok(result.research.budget.lookups > 0, "identifiers are still looked up");
  assert.ok(rawLog.some((item) => item.url === f.URLS.cveApi("CVE-2026-109618")), "a CVE record was requested");
  const verified = result.findings.filter((finding) => finding.status === "verified");
  assert.ok(verified.length >= 1, "a record-backed identifier is verified");
  assert.ok(verified.every((finding) => finding.productCheck === "not-checked"), "no product check without a subject");
  assert.ok(verified.every((finding) => finding.notes.some((note) => /No product was named/.test(note))));
  assert.ok(result.research.limitations.some((line) => /No product or entity was named/.test(line)));
  assert.match(result.context, /Subject term: none identified/);
});

test("task 1: a broad question with no CVE in the results runs one broad identifier search", async () => {
  const seen = [];
  const webSearch = async (query, options = {}) => {
    seen.push({ query, options });
    // The first search finds nothing. The broad identifier search finds the fixture results.
    return seen.length === 1 ? [] : f.searchResultsFromFixture();
  };
  const { result } = await run("What are the latest discovered exploits in cybersecurity?", { webSearch });
  assert.equal(seen.length, 2, "one question search and one broad identifier search");
  assert.equal(seen[1].query, "What are the latest discovered exploits in cybersecurity? CVE");
  assert.ok(findingFor(result, "CVE-2026-109618"), "the identifier from the broad search is considered");
});

test("task 1: a broad question stays within the lookup cap even when many identifiers appear", async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    title: `Security roundup ${i}`,
    url: `https://example.test/roundup-${i}`,
    snippet: `CVE-2026-7100${i} and CVE-2026-7200${i} were discussed this week.`,
    provider: "duckduckgo",
  }));
  const { result } = await run("What are the latest discovered exploits in cybersecurity?", {
    webSearch: f.fakeWebSearch([[/.*/, many]]),
    raw: new Map(),
    maxLookups: 3,
  });
  assert.ok(result.research.budget.lookups <= 3, `lookups ${result.research.budget.lookups}`);
  assert.ok(result.research.limitations.some((line) => /lookup limit was reached/.test(line)), "unchecked identifiers are listed");
});

test("task 1: an identifier named in the question is looked up even when the search results do not mention it", async () => {
  const { result, rawLog } = await run("Is CVE-2026-109618 exploited?", { webSearch: f.fakeWebSearch([[/.*/, []]]) });
  assert.ok(rawLog.some((item) => item.url === f.URLS.cveApi("CVE-2026-109618")));
  const finding = findingFor(result, "CVE-2026-109618");
  assert.ok(finding, "the question's identifier has a finding");
  assert.equal(finding.status, "verified");
  assert.equal(finding.exploitation.status, "kev-listed");
});

// ---------------------------------------------------------------------------------------------------------------
// Task 2: date-aware ordering and labels
// ---------------------------------------------------------------------------------------------------------------

test("task 2: for a latest question, a newer verified finding is not displaced by an identifier that sorts earlier", () => {
  const sources = [recordSource(1, "CVE-2026-100001", { published: "2026-01-05" }), recordSource(2, "CVE-2026-200000", { published: "2026-10-10" })];
  const lookups = new Map([lookupFor(1, "CVE-2026-100001"), lookupFor(2, "CVE-2026-200000")]);
  const latest = buildFindings({ subject: "PHP2Shell", sources, lookups, window: WINDOW_MONTH, recencyFocus: true });
  assert.deepEqual(latest.map((item) => item.identifier), ["CVE-2026-200000", "CVE-2026-100001"]);
  assert.equal(latest[0].recency.label, "published-in-range");
  assert.equal(latest[1].recency.label, "published-before-range");

  // Without a recency question, the order is by identifier, as before.
  const plain = buildFindings({ subject: "PHP2Shell", sources, lookups, window: WINDOW_MONTH, recencyFocus: false });
  assert.deepEqual(plain.map((item) => item.identifier), ["CVE-2026-100001", "CVE-2026-200000"]);
});

test("task 2: status is kept first. A recent unverified mention does not outrank a verified or conflicting identifier", () => {
  const sources = [
    recordSource(1, "CVE-2026-300001", { published: "2026-01-05" }),
    recordSource(2, "CVE-2026-300002", { product: "Other Product", published: "2026-10-20" }),
    articleSource(3, ["PHP2Shell remains a risk, tracked as CVE-2026-300003."], "2026-10-20"),
  ];
  const lookups = new Map([lookupFor(1, "CVE-2026-300001"), lookupFor(2, "CVE-2026-300002")]);
  const findings = buildFindings({ subject: "PHP2Shell", sources, lookups, window: WINDOW_MONTH, recencyFocus: true });
  const order = findings.map((item) => `${item.identifier}:${item.status}`);
  assert.deepEqual(order, ["CVE-2026-300001:verified", "CVE-2026-300002:conflict", "CVE-2026-300003:reported"]);
  const reported = findings.find((item) => item.identifier === "CVE-2026-300003");
  assert.equal(reported.published, null, "a reported identifier gets no date from the article");
  assert.equal(reported.recency.label, "reported-in-range", "the article date is shown as the article date");
  assert.equal(reported.exploitation.status, "not-established");
});

test("task 2: unknown dates are labelled and sort after dated findings in the same status", () => {
  const sources = [recordSource(1, "CVE-2026-400001", { published: null }), recordSource(2, "CVE-2026-400002", { published: "2026-10-01" })];
  const lookups = new Map([lookupFor(1, "CVE-2026-400001"), lookupFor(2, "CVE-2026-400002")]);
  const findings = buildFindings({ subject: "PHP2Shell", sources, lookups, window: WINDOW_MONTH, recencyFocus: true });
  assert.deepEqual(findings.map((item) => item.identifier), ["CVE-2026-400002", "CVE-2026-400001"]);
  const unknown = findings[1];
  assert.equal(unknown.published, null);
  assert.equal(unknown.recency.label, "date-unknown");
  assert.ok(unknown.notes.some((note) => /cannot be placed in the date range/.test(note)));
});

test("task 2: an older identifier mentioned by a recent article is labelled as an older vulnerability in recent coverage", () => {
  const sources = [
    recordSource(1, "CVE-2026-500001", { published: "2026-01-05" }),
    articleSource(2, ["PHP2Shell is a flaw tracked as CVE-2026-500001 and was discussed again this week."], "2026-10-20"),
  ];
  const lookups = new Map([lookupFor(1, "CVE-2026-500001")]);
  const [finding] = buildFindings({ subject: "PHP2Shell", sources, lookups, window: WINDOW_MONTH, recencyFocus: true });
  assert.equal(finding.identifier, "CVE-2026-500001");
  assert.equal(finding.status, "verified");
  assert.equal(finding.recency.label, "older-mentioned-in-range");
  assert.match(finding.recency.detail, /published 2026-01-05, before the date range/);
  assert.ok(finding.notes.some((note) => /older vulnerability mentioned in recent coverage/.test(note)));
  assert.notEqual(finding.recency.label, "published-in-range");
});

test("task 2: a finding published before the selected range is not described as a recent discovery", () => {
  const sources = [recordSource(1, "CVE-2026-600001", { published: "2026-01-05" })];
  const lookups = new Map([lookupFor(1, "CVE-2026-600001")]);
  const [finding] = buildFindings({ subject: "PHP2Shell", sources, lookups, window: WINDOW_MONTH, recencyFocus: true });
  assert.equal(finding.recency.label, "published-before-range");
  assert.ok(finding.notes.some((note) => /Do not describe it as a recent discovery/.test(note)));
});

test("task 2: explicit 'Any time' applies no range, labels dates as no-range, and never claims a range", () => {
  const sources = [recordSource(1, "CVE-2026-700001", { published: "2026-01-05" }), recordSource(2, "CVE-2026-700002", { published: null })];
  const lookups = new Map([lookupFor(1, "CVE-2026-700001"), lookupFor(2, "CVE-2026-700002")]);
  const findings = buildFindings({ subject: "PHP2Shell", sources, lookups, window: null, recencyFocus: true });
  assert.ok(findings.every((item) => item.recency.label === "no-date-range"));
  assert.ok(!findings.some((item) => item.notes.some((note) => /Published before the selected date range/.test(note))));
  const undated = findings.find((item) => item.identifier === "CVE-2026-700002");
  assert.ok(undated.notes.some((note) => /No date range was applied, and no primary publication date is known/.test(note)));
});

test("task 2: explicit 'Any time' through the pipeline sends 'any' to the search and keeps the choice", async () => {
  const { result, searchLog } = await run("latest PHP2Shell news", { timeFilter: "any", pages: new Map([[f.URLS.news, f.htmlPage("incident-article.html")]]) });
  assert.equal(searchLog[0].options.timeFilter, "any");
  assert.equal(result.research.timeWindow.source, "explicit-any");
  assert.equal(result.research.timeWindow.applied, null);
  assert.equal(result.research.recencyFocus, true);
  assert.ok(result.findings.every((item) => item.recency.label === "no-date-range"));
});

test("task 2: a latest question with an automatic window labels the fixture CVEs as published before the range", async () => {
  const { result } = await run("latest PHP2Shell news", { timeFilter: "auto", pages: new Map([[f.URLS.news, f.htmlPage("incident-article.html")]]) });
  assert.equal(result.research.timeWindow.applied, "month");
  const finding = findingFor(result, "CVE-2026-109618");
  assert.equal(finding.recency.label, "published-before-range");
  assert.match(result.context, /date relation to the date range: published 2026-09-02, before the date range/);
  assert.match(result.context, /Do not describe it as a recent discovery/);
  assert.match(result.context, /Ordering: findings are newest first/);
});

test("task 2: a date in a search snippet is not used as a publication date", () => {
  const sources = [{
    index: 1,
    url: "https://example.test/snippet-with-date",
    title: "PHP2Shell CVE-2026-700001",
    snippet: "Published October 22, 2026: PHP2Shell is tracked as CVE-2026-700001.",
    origin: "search",
    tier: "web",
    sourceType: "web",
    fetchStatus: "search-only",
  }];
  const [finding] = buildFindings({ subject: "PHP2Shell", sources, lookups: new Map(), window: WINDOW_MONTH, recencyFocus: true });
  assert.equal(finding.identifier, "CVE-2026-700001");
  assert.equal(finding.status, "search-only");
  assert.equal(finding.published, null, "no date from a snippet");
  assert.equal(finding.recency.label, "date-unknown");
});

test("task 2: a window from 'auto' is inferred from the wording and reports the date range", () => {
  const inferred = resolveTimeWindow({ requested: "auto", query: "latest PHP2Shell CVEs", now: NOW });
  assert.equal(inferred.applied, "month");
  assert.equal(inferred.from, "2026-09-23");
  assert.equal(inferred.to, "2026-10-24");
});

// ---------------------------------------------------------------------------------------------------------------
// Task 3: source classes
// ---------------------------------------------------------------------------------------------------------------

test("task 3: listed vendor and project advisory areas are primary", () => {
  const cases = [
    ["https://msrc.microsoft.com/update-guide/vulnerability/CVE-2026-1", "vendor-advisory"],
    ["https://security.paloaltonetworks.com/CVE-2024-3400", "vendor-advisory"],
    ["https://sec.cloudapps.cisco.com/security/center/content/CiscoSecurityAdvisory/cisco-sa-x", "vendor-advisory"],
    ["https://access.redhat.com/security/cve/CVE-2024-1", "vendor-advisory"],
    ["https://ubuntu.com/security/CVE-2024-1", "vendor-advisory"],
    ["https://security-tracker.debian.org/tracker/CVE-2024-1", "vendor-advisory"],
    ["https://httpd.apache.org/security/vulnerabilities_24.html", "project-advisory"],
    ["https://www.oracle.com/security-alerts/cpujul2026.html", "vendor-advisory"],
    ["https://www.fortiguard.com/psirt/FG-IR-24-001", "vendor-advisory"],
    ["https://www.cisa.gov/news-events/ics-advisories/icsa-26-001-01", "cisa-advisory"],
  ];
  for (const [url, type] of cases) {
    const result = classifySource(url, "");
    assert.equal(result.tier, "primary", url);
    assert.equal(result.type, type, url);
  }
  assert.ok(VENDOR_ADVISORY_SOURCES.length >= 10);
});

test("task 3: pages on the same hosts outside the advisory area are not primary", () => {
  assert.notEqual(classifySource("https://www.oracle.com/java/", "").tier, "primary");
  assert.notEqual(classifySource("https://ubuntu.com/blog/security-news", "").tier, "primary");
  assert.notEqual(classifySource("https://www.cisa.gov/news-events/alerts/x", "").tier, "primary");
});

test("task 3: look-alike hosts and copied paths are never primary", () => {
  assert.notEqual(classifySource("https://msrc.microsoft.com.evil.test/update-guide/x", "").tier, "primary");
  assert.notEqual(classifySource("https://evil.example.test/msrc.microsoft.com/update-guide/x", "").tier, "primary");
  assert.notEqual(classifySource("https://notsecurity.paloaltonetworks.example.test/", "").tier, "primary");
});

test("task 3: unknown advisory-looking pages stay corroboration, whatever their title or path", () => {
  for (const [url, title] of [
    ["https://example.test/security/cve-2026-1", ""],
    ["https://example.test/advisories/2026-1", ""],
    ["https://example.test/news/post", "Critical security advisory for PHP2Shell"],
  ]) {
    const result = classifySource(url, title);
    assert.notEqual(result.tier, "primary", url);
    assert.equal(result.tier, "advisory-page", url);
  }
});

test("task 3: a vendor advisory page verifies only when its text names the identifier and the subject", () => {
  const advisory = (text, title = "PHP2Shell advisory") => ({
    index: 1,
    url: "https://security.paloaltonetworks.com/CVE-2026-109619",
    title,
    snippet: "",
    origin: "search",
    tier: "primary",
    sourceType: "vendor-advisory",
    fetchStatus: "fetched",
    page: { title, sentences: text, published: "2026-09-02", updated: null },
  });

  // The URL names the identifier, but the page text never does. Classification alone is not verification.
  const urlOnly = buildFindings({ subject: "PHP2Shell", sources: [advisory(["PHP2Shell is a remote code execution flaw in affected versions."])], lookups: new Map() });
  const notVerified = urlOnly.find((item) => item.identifier === "CVE-2026-109619");
  assert.ok(notVerified, "the identifier is still shown as a lead");
  assert.notEqual(notVerified.status, "verified");
  assert.equal(notVerified.product, null);

  // The page names the identifier and the subject: verified, with the vendor advisory as the primary source.
  const named = buildFindings({ subject: "PHP2Shell", sources: [advisory(["CVE-2026-109619 affects PHP2Shell versions before 8.3.12."])], lookups: new Map() });
  assert.equal(named.find((item) => item.identifier === "CVE-2026-109619").status, "verified");
  assert.equal(named.find((item) => item.identifier === "CVE-2026-109619").primaryType, "vendor-advisory");

  // The page names the identifier for a different product: conflict, not verified.
  const other = buildFindings({ subject: "PHP2Shell", sources: [advisory(["CVE-2026-109619 affects Example Forum Plugin."], "Example Forum Plugin advisory")], lookups: new Map() });
  assert.equal(other.find((item) => item.identifier === "CVE-2026-109619").status, "conflict");
});

// ---------------------------------------------------------------------------------------------------------------
// Task 4: consistency check of an answer
// ---------------------------------------------------------------------------------------------------------------

const SOURCES = [{ index: 1 }, { index: 2 }, { index: 3 }];
const FINDINGS = [
  { identifier: "CVE-2026-109618", identifierType: "cve", status: "verified", exploitation: { status: "kev-listed", confirmedActive: true } },
  { identifier: "CVE-2026-109619", identifierType: "cve", status: "verified", exploitation: { status: "public-poc-per-cisa-ssvc", confirmedActive: false } },
  { identifier: "CVE-2026-99001", identifierType: "cve", status: "reported", exploitation: { status: "not-established", confirmedActive: false } },
  { identifier: "EUVD-2026-108013", identifierType: "euvd", status: "verified", exploitation: { status: "not-established", confirmedActive: false } },
];
const audit = (text, findings = FINDINGS) => auditAnswer(text, { sources: SOURCES, findings });
const types = (result) => result.issues.map((issue) => issue.type);

test("task 4: the result says it is a deterministic consistency check, not a guarantee of truth", () => {
  const result = audit("CVE-2026-109618 is listed in CISA KEV [1].");
  assert.equal(result.kind, CHECK_NAME);
  assert.match(result.note, /not a judgement of whether the answer is true/);
});

test("task 4: a cautious first mention does not suppress a later unsupported factual claim about the same identifier", () => {
  const result = audit("CVE-2026-99001 may relate to this question [1]. CVE-2026-99001 affects PHP 8.0 before 8.3 [1].");
  assert.equal(result.ok, false);
  assert.ok(types(result).includes("unverified-identifier-stated"));
});

test("task 4: a cautious mention alone is accepted", () => {
  const result = audit("CVE-2026-99001 may relate to this question, but it is not verified [1].");
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("task 4: a cautious first exploitation mention does not suppress a later unsupported exploitation claim", () => {
  const result = audit("CVE-2026-109619 may be exploited [1]. CVE-2026-109619 is actively exploited [1].");
  assert.ok(types(result).includes("exploitation-claim-not-confirmed"));
});

test("task 4: a hedge in one clause does not neutralise a positive claim in another clause of the same sentence", () => {
  const result = audit("CVE-2026-109619 is not actively exploited, but it is actively exploited in the wild [1].");
  assert.ok(types(result).includes("exploitation-claim-not-confirmed"), JSON.stringify(result.issues));
});

test("task 4: a hedge in one clause does not neutralise an unverified identifier stated without a hedge in another clause", () => {
  const result = audit("CVE-2026-99001 is not verified, but CVE-2026-99001 affects PHP 8.0 [1].");
  assert.ok(types(result).includes("unverified-identifier-stated"));
});

test("task 4: several findings where only one has confirmed exploitation: the named claim is flagged", () => {
  const result = audit("CVE-2026-109618 and CVE-2026-109619 are actively exploited [1].");
  assert.ok(types(result).includes("exploitation-claim-not-confirmed"));
  const detail = result.issues.find((issue) => issue.type === "exploitation-claim-not-confirmed").detail;
  assert.match(detail, /CVE-2026-109619/);
  assert.doesNotMatch(detail, /CVE-2026-109618 is actively/);
});

test("task 4: a generic claim is not supported merely because one finding is listed in CISA KEV", () => {
  const result = audit("The vulnerabilities are actively exploited [1].");
  assert.ok(types(result).includes("generic-exploitation-claim"));
});

test("task 4: a generic claim is supported only when every finding is confirmed", () => {
  const onlyKev = [FINDINGS[0]];
  assert.equal(audit("The vulnerability is actively exploited [1].", onlyKev).ok, true);
  assert.ok(types(audit("The vulnerabilities are actively exploited [1].")).includes("generic-exploitation-claim"));
});

test("task 4: a public proof of concept is not treated as confirmed exploitation", () => {
  const flagged = audit("CVE-2026-109619 is actively exploited because a public proof-of-concept exists [1].");
  assert.ok(types(flagged).includes("exploitation-claim-not-confirmed"));
  const correct = audit("CVE-2026-109619 has a public proof-of-concept [1].");
  assert.equal(correct.ok, true, JSON.stringify(correct.issues));
});

test("task 4: an invalid citation number is flagged", () => {
  const result = audit("CVE-2026-109618 is listed in CISA KEV [7].");
  assert.ok(types(result).includes("invalid-citation"));
});

test("task 4: an EUVD identifier presented as the CVE with the same number is flagged", () => {
  const result = audit("CVE-2026-108013 is the Example Forum Plugin flaw [1].");
  assert.ok(types(result).includes("possible-euvd-cve-confusion"));
});

test("task 4: a correct answer with supported claims and valid citations passes", () => {
  const text = [
    "CVE-2026-109618 is listed in CISA KEV [1].",
    "CVE-2026-109619 has a public proof-of-concept, and exploitation is not confirmed [1].",
    "EUVD-2026-108013 is a separate EUVD record for the Example Forum Plugin [2].",
  ].join(" ");
  const result = audit(text);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  assert.equal(result.checked.citations, 3);
});
