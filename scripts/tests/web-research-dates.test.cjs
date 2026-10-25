// Tests for date labels and date-aware ordering: both ends of the selected range are enforced, future-dated and
// malformed dates are labelled rather than accepted, and an explicit "Any time" choice is kept.
//
// EXECUTED: every test here is offline. Dates come from synthetic records and fixtures. The "today" used is fixed
// at 2026-10-24, the same date the rest of the test suite uses. Nothing reads the clock or the network.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const { buildFindings, dateRelation, recencyFor } = require(path.join(root, "scripts", "search", "evidence.js"));
const { parseDate, parsePageText, parseCveRecord } = require(path.join(root, "scripts", "search", "records.js"));
const { comprehensiveWebSearch } = require(path.join(root, "scripts", "search", "core.js"));
const f = require(path.join(__dirname, "support", "web-research-fakes.cjs"));

const TODAY = "2026-10-24";
const MONTH = { applied: "month", from: "2026-09-23", to: "2026-10-24", label: "past month", source: "inferred", code: "m" };
// A window that ends before today, so the end-of-range rule is tested with a date that is not in the future.
const EARLY = { applied: "month", from: "2026-09-01", to: "2026-09-30", label: "September 2026", source: "explicit", code: "m" };

const pub = (value) => ({ value, source: 1 });
const art = (value) => ({ value, source: 2 });

function recordSource(index, id, published, extra = {}) {
  return {
    index,
    url: `https://cveawg.mitre.org/api/cve/${id}`,
    title: `${id} - CVE record`,
    snippet: "",
    origin: "lookup",
    tier: "primary",
    sourceType: "cve-record",
    fetchStatus: "fetched",
    record: {
      kind: "cve-record",
      id,
      state: "PUBLISHED",
      title: "PHP2Shell issue",
      description: `Synthetic record for PHP2Shell (${id}).`,
      products: [{ vendor: "Synthetic Vendor", product: "PHP2Shell", versions: ["1.0 before 1.1"] }],
      productNames: ["Synthetic Vendor", "PHP2Shell"],
      published,
      publishedMalformed: Boolean(extra.publishedMalformed),
      updated: null,
      cvss: null,
      ssvcExploitation: null,
      references: [],
    },
  };
}

function articleSource(index, sentences, published, extra = {}) {
  return {
    index,
    url: `https://www.bleepingcomputer.com/news/article-${index}/`,
    title: "Synthetic article",
    snippet: "",
    origin: "search",
    tier: "secondary",
    sourceType: "security-news",
    fetchStatus: "fetched",
    published,
    publishedMalformed: Boolean(extra.publishedMalformed),
    page: { title: "Synthetic article", sentences, published, updated: null, publishedMalformed: Boolean(extra.publishedMalformed) },
  };
}

const lookupFor = (index, id) => [id, { attempts: [{ ok: true, sourceIndex: index }], record: true }];

// ---------------------------------------------------------------------------------------------------------------
// The date relation at each edge of the range
// ---------------------------------------------------------------------------------------------------------------

test("dates: the relation to a range has a 'before', 'in' and 'after' side, and both edges are inside", () => {
  assert.equal(dateRelation("2026-09-22", MONTH, TODAY), "before", "one day before the start");
  assert.equal(dateRelation("2026-09-23", MONTH, TODAY), "in", "the start is inside");
  assert.equal(dateRelation("2026-10-24", MONTH, TODAY), "in", "today, the end of the range, is inside");
  assert.equal(dateRelation("2026-10-25", MONTH, TODAY), "future", "tomorrow is in the future");
});

test("dates: a date after the end of a range that ends before today is 'after', not 'in'", () => {
  assert.equal(dateRelation("2026-09-30", EARLY, TODAY), "in", "last day of the range");
  assert.equal(dateRelation("2026-10-01", EARLY, TODAY), "after", "one day after the end");
  assert.equal(dateRelation("2026-10-10", EARLY, TODAY), "after");
});

test("dates: with no range, a past date is 'none' and a future date is still 'future'", () => {
  assert.equal(dateRelation("2026-01-05", null, TODAY), "none");
  assert.equal(dateRelation("2026-12-01", null, TODAY), "future");
  assert.equal(dateRelation(null, MONTH, TODAY), null, "no date is unknown");
});

// ---------------------------------------------------------------------------------------------------------------
// Labels for a primary date
// ---------------------------------------------------------------------------------------------------------------

test("labels: a primary date inside the range is published-in-range, including on both boundaries", () => {
  assert.equal(recencyFor({ window: MONTH, today: TODAY, published: pub("2026-09-23") }).label, "published-in-range", "start boundary");
  assert.equal(recencyFor({ window: MONTH, today: TODAY, published: pub("2026-10-24") }).label, "published-in-range", "end boundary (today)");
  assert.equal(recencyFor({ window: MONTH, today: TODAY, published: pub("2026-10-01") }).label, "published-in-range");
});

test("labels: a primary date one day before the range is published-before-range, and a day after the end is published-after-range", () => {
  assert.equal(recencyFor({ window: MONTH, today: TODAY, published: pub("2026-09-22") }).label, "published-before-range");
  assert.equal(recencyFor({ window: EARLY, today: TODAY, published: pub("2026-10-01") }).label, "published-after-range",
    "after the end of a range that ends before today is not inside the range");
  assert.equal(recencyFor({ window: EARLY, today: TODAY, published: pub("2026-09-30") }).label, "published-in-range", "the last day of the range is inside");
});

test("labels: a primary date after today is date-in-future, whatever the range, and never recent", () => {
  const withRange = recencyFor({ window: MONTH, today: TODAY, published: pub("2026-12-01") });
  assert.equal(withRange.label, "date-in-future");
  assert.match(withRange.detail, /after today/);
  assert.equal(recencyFor({ window: null, today: TODAY, published: pub("2026-12-01") }).label, "date-in-future", "also with Any time");
});

test("labels: an impossible calendar date is malformed, not accepted, and is not a date", () => {
  assert.equal(parseDate("2026-02-30"), null, "February 30 is not a date");
  assert.equal(parseDate("September 31, 2026"), null, "September 31 is not a date");
  assert.equal(parseDate("2026-09-02T10:05:00.000Z"), "2026-09-02", "a valid timestamp still gives its date");
  const malformed = recencyFor({ window: MONTH, today: TODAY, published: null, publishedMalformed: true });
  assert.equal(malformed.label, "date-malformed");
  assert.match(malformed.detail, /not a valid calendar date/);
});

test("labels: a primary date that is not a date at all is reported as unknown", () => {
  const record = parseCveRecord({
    cveMetadata: { cveId: "CVE-2026-109618", state: "PUBLISHED", datePublished: "not a date" },
    containers: { cna: { title: "t", descriptions: [{ lang: "en", value: "PHP2Shell" }], affected: [] } },
  });
  assert.equal(record.published, null);
  assert.equal(record.publishedMalformed, false, "no date-shaped text, so nothing is labelled malformed");
  assert.equal(recencyFor({ window: MONTH, today: TODAY, published: null, publishedMalformed: false }).label, "date-unknown");
});

test("labels: a page with a malformed published date is flagged by the page parser", () => {
  const parsed = parsePageText("Published 2026-02-30. Body text here.", "Synthetic");
  assert.equal(parsed.published, null);
  assert.equal(parsed.publishedMalformed, true);
  const valid = parsePageText("Published 2026-09-02. Body text here.", "Synthetic");
  assert.equal(valid.published, "2026-09-02");
  assert.equal(valid.publishedMalformed, false);
});

// ---------------------------------------------------------------------------------------------------------------
// Labels for an article date (the date of a read page that mentions the identifier)
// ---------------------------------------------------------------------------------------------------------------

test("labels: an identifier published before the range but mentioned by an article inside it is older-mentioned-in-range", () => {
  const got = recencyFor({ window: MONTH, today: TODAY, published: pub("2026-01-05"), articleDate: art("2026-10-20") });
  assert.equal(got.label, "older-mentioned-in-range");
});

test("labels: an article dated after the range does not make an older identifier recent", () => {
  const got = recencyFor({ window: EARLY, today: TODAY, published: pub("2026-01-05"), articleDate: art("2026-10-10") });
  assert.equal(got.label, "published-before-range");
  assert.match(got.detail, /outside the range, so it does not date this identifier/);
});

test("labels: with no primary date, an article inside the range gives reported-in-range", () => {
  assert.equal(recencyFor({ window: MONTH, today: TODAY, published: null, articleDate: art("2026-10-20") }).label, "reported-in-range");
});

test("labels: with no primary date, an article after the range or in the future gives reported-after-range, not in range", () => {
  assert.equal(recencyFor({ window: EARLY, today: TODAY, published: null, articleDate: art("2026-10-10") }).label, "reported-after-range");
  assert.equal(recencyFor({ window: MONTH, today: TODAY, published: null, articleDate: art("2026-11-02") }).label, "reported-after-range", "a future article is not recent coverage");
});

test("labels: a malformed article date is labelled, and is not used", () => {
  const got = recencyFor({ window: MONTH, today: TODAY, published: null, articleDate: null, articleMalformed: true });
  assert.equal(got.label, "date-malformed");
});

test("labels: with no range, the 'no date range' label is kept and no date is claimed", () => {
  assert.equal(recencyFor({ window: null, today: TODAY, published: null, articleDate: art("2026-10-20") }).label, "no-date-range");
  assert.equal(recencyFor({ window: null, today: TODAY, published: pub("2026-01-05") }).label, "no-date-range");
});

// ---------------------------------------------------------------------------------------------------------------
// Findings built from sources: future-dated records and articles, ordering and status priority
// ---------------------------------------------------------------------------------------------------------------

test("findings: a future-dated primary record is labelled and is not sorted as the newest finding", () => {
  const sources = [recordSource(1, "CVE-2026-600001", "2026-10-20"), recordSource(2, "CVE-2026-600002", "2026-12-01")];
  const lookups = new Map([lookupFor(1, "CVE-2026-600001"), lookupFor(2, "CVE-2026-600002")]);
  const findings = buildFindings({ subject: "PHP2Shell", sources, lookups, window: MONTH, recencyFocus: true, today: TODAY });
  assert.deepEqual(findings.map((item) => item.identifier), ["CVE-2026-600001", "CVE-2026-600002"], "the future date is last");
  assert.equal(findings[1].recency.label, "date-in-future");
  assert.ok(findings[1].notes.some((note) => /not a valid recent date/.test(note)));
});

test("findings: a future-dated article does not change a primary date that is inside the range", () => {
  const sources = [
    recordSource(1, "CVE-2026-600003", "2026-09-30"),
    articleSource(2, ["PHP2Shell is tracked as CVE-2026-600003 in this week's report."], "2026-11-02"),
  ];
  const lookups = new Map([lookupFor(1, "CVE-2026-600003")]);
  const [finding] = buildFindings({ subject: "PHP2Shell", sources, lookups, window: MONTH, recencyFocus: true, today: TODAY });
  assert.equal(finding.recency.label, "published-in-range", "the primary date decides, and the future article is not used");
});

test("findings: a newer verified finding is not displaced by an older one that sorts earlier", () => {
  const sources = [recordSource(1, "CVE-2026-700001", "2026-01-05"), recordSource(2, "CVE-2026-700002", "2026-10-10")];
  const lookups = new Map([lookupFor(1, "CVE-2026-700001"), lookupFor(2, "CVE-2026-700002")]);
  const findings = buildFindings({ subject: "PHP2Shell", sources, lookups, window: MONTH, recencyFocus: true, today: TODAY });
  assert.deepEqual(findings.map((item) => item.identifier), ["CVE-2026-700002", "CVE-2026-700001"]);
});

test("findings: status comes before date. A recent unverified mention stays below a verified identifier", () => {
  const sources = [
    recordSource(1, "CVE-2026-700003", "2026-01-05"),
    articleSource(2, ["PHP2Shell remains a risk, tracked as CVE-2026-700004."], "2026-10-20"),
  ];
  const lookups = new Map([lookupFor(1, "CVE-2026-700003")]);
  const findings = buildFindings({ subject: "PHP2Shell", sources, lookups, window: MONTH, recencyFocus: true, today: TODAY });
  assert.deepEqual(findings.map((item) => `${item.identifier}:${item.status}`), ["CVE-2026-700003:verified", "CVE-2026-700004:reported"]);
});

test("findings: unknown dates sort after dated findings within the same status", () => {
  const sources = [recordSource(1, "CVE-2026-700005", null), recordSource(2, "CVE-2026-700006", "2026-10-01")];
  const lookups = new Map([lookupFor(1, "CVE-2026-700005"), lookupFor(2, "CVE-2026-700006")]);
  const findings = buildFindings({ subject: "PHP2Shell", sources, lookups, window: MONTH, recencyFocus: true, today: TODAY });
  assert.deepEqual(findings.map((item) => item.identifier), ["CVE-2026-700006", "CVE-2026-700005"]);
  assert.equal(findings[1].recency.label, "date-unknown");
});

test("findings: an explicit 'Any time' applies no range, keeps the choice, and does not claim a date range", () => {
  const sources = [recordSource(1, "CVE-2026-700007", "2026-01-05"), recordSource(2, "CVE-2026-700008", "2026-12-01")];
  const lookups = new Map([lookupFor(1, "CVE-2026-700007"), lookupFor(2, "CVE-2026-700008")]);
  const findings = buildFindings({ subject: "PHP2Shell", sources, lookups, window: null, recencyFocus: true, today: TODAY });
  const byId = Object.fromEntries(findings.map((item) => [item.identifier, item.recency.label]));
  assert.equal(byId["CVE-2026-700007"], "no-date-range");
  assert.equal(byId["CVE-2026-700008"], "date-in-future", "a future date is still labelled, even with Any time");
  assert.ok(!findings.some((item) => item.recency.label.includes("before") || item.recency.label.includes("in-range")));
});

// ---------------------------------------------------------------------------------------------------------------
// Through the pipeline, with fixtures: the user's explicit choice and the labels in the context
// ---------------------------------------------------------------------------------------------------------------

function rawWithCve(id, edit) {
  const routes = f.standardRaw();
  const url = f.URLS.cveApi(id);
  const record = JSON.parse(JSON.stringify(f.readJsonFixture(`cve-${id.slice(-6)}.json`)));
  edit(record);
  routes.set(url, record);
  return routes;
}

async function latestRun(raw, options = {}) {
  return comprehensiveWebSearch("latest PHP2Shell news", {
    noCache: true,
    cacheDir: require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "dates-")),
    now: () => new Date("2026-10-24T06:00:00Z"),
    timeFilter: options.timeFilter || "auto",
    deps: {
      webSearch: f.fakeWebSearch([[/.*/, f.searchResultsFromFixture()]]),
      fetchRaw: f.fakeFetchRaw(raw),
      fetchPage: f.fakeFetchPage(new Map([[f.URLS.news, f.htmlPage("incident-article.html")]])),
    },
  });
}

test("pipeline: a future-dated CVE record is labelled date-in-future and the context does not call it recent", async () => {
  const raw = rawWithCve("CVE-2026-109619", (record) => { record.cveMetadata.datePublished = "2026-12-01T10:00:00.000Z"; });
  const result = await latestRun(raw);
  const finding = result.findings.find((item) => item.identifier === "CVE-2026-109619");
  assert.ok(finding, "the finding is still produced");
  assert.equal(finding.recency.label, "date-in-future");
  assert.match(result.context, /after today/);
  assert.doesNotMatch(result.context, /CVE-2026-109619[\s\S]{0,200}published-in-range/);
});

test("pipeline: an impossible publication date (2026-02-30) is labelled date-malformed, not accepted", async () => {
  const raw = rawWithCve("CVE-2026-109619", (record) => { record.cveMetadata.datePublished = "2026-02-30T10:00:00.000Z"; });
  const result = await latestRun(raw);
  const finding = result.findings.find((item) => item.identifier === "CVE-2026-109619");
  assert.equal(finding.published, null, "the impossible date is not used");
  assert.equal(finding.recency.label, "date-malformed");
});

test("pipeline: an explicit 'Any time' choice is kept, sends 'any' to the search, and shows no range", async () => {
  const result = await latestRun(f.standardRaw(), { timeFilter: "any" });
  assert.equal(result.research.timeWindow.source, "explicit-any");
  assert.equal(result.research.timeWindow.applied, null);
  assert.ok(result.findings.every((item) => item.recency.label === "no-date-range" || item.recency.label === "date-in-future"));
});

test("pipeline: an explicit choice of a window is kept even when the question says 'latest'", async () => {
  const result = await latestRun(f.standardRaw(), { timeFilter: "year" });
  assert.equal(result.research.timeWindow.source, "explicit");
  assert.equal(result.research.timeWindow.applied, "year");
});
