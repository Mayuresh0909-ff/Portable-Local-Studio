// Tests for citation provenance in the answer audit: a citation must be one of the sources that support the claim
// it is attached to, field by field, using the finding's own source fields.
//
// EXECUTED: every test here is offline. The findings come from the real research pipeline run on the SYNTHETIC
// fixtures (scripts/tests/fixtures/web-research/) through the fake fetchers. Nothing is fetched from the network.
//
// This is a deterministic consistency check. These tests show that the check flags the cases it is meant to flag.
// They do not show that any answer is true.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const { comprehensiveWebSearch } = require(path.join(root, "scripts", "search", "core.js"));
const { auditAnswer, CHECK_NAME } = require(path.join(root, "scripts", "search", "citation-audit.js"));
const f = require(path.join(__dirname, "support", "web-research-fakes.cjs"));

const NOW = new Date("2026-10-24T06:00:00Z");

// One research run on the PHP2Shell fixtures. The results are shared by the tests below.
let cached = null;
async function research() {
  if (cached) return cached;
  const result = await comprehensiveWebSearch("Is PHP2Shell actively exploited? What are the CVEs?", {
    noCache: true,
    cacheDir: require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "prov-")),
    now: () => NOW,
    deps: {
      webSearch: f.fakeWebSearch([[/.*/, f.searchResultsFromFixture()]]),
      fetchRaw: f.fakeFetchRaw(f.standardRaw()),
      fetchPage: f.fakeFetchPage(new Map([[f.URLS.news, f.htmlPage("incident-article.html")]])),
    },
  });
  cached = { sources: result.sources, findings: result.findings };
  return cached;
}

const finding = (evidence, id) => evidence.findings.find((item) => item.identifier === id);
const types = (result) => result.issues.map((issue) => issue.type);

// The fixture facts used below, read from the real findings rather than typed in.
async function facts() {
  const evidence = await research();
  const kevFinding = finding(evidence, "CVE-2026-109618");
  const pocFinding = finding(evidence, "CVE-2026-109619");
  assert.equal(kevFinding.status, "verified", "fixture precondition");
  assert.equal(kevFinding.exploitation.status, "kev-listed", "fixture precondition");
  assert.equal(pocFinding.exploitation.status, "public-poc-per-cisa-ssvc", "fixture precondition");
  const articleIndex = evidence.sources.find((source) => /bleepingcomputer/.test(source.url)).index;
  return {
    evidence,
    primary: kevFinding.primarySource,                  // the CVE record that names the product
    kev: kevFinding.exploitation.source,                // the KEV catalogue, which establishes exploitation
    pocPrimary: pocFinding.primarySource,
    article: articleIndex,                              // an article that is not a primary source for these findings
  };
}

test("provenance 1: a valid identifier with a relevant citation passes", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  assert.ok(result.checked.claims >= 2, "identity and product were checked against sources");
  assert.equal(result.kind, CHECK_NAME);
});

test("provenance 2: a valid citation number that points at an unrelated source is an error", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${f1.article}].`, f1.evidence);
  assert.equal(result.ok, false, "a clean citation must not be given to an unrelated source");
  assert.ok(types(result).includes("citation-not-supporting-claim"));
  const detail = result.issues.find((issue) => issue.type === "citation-not-supporting-claim").detail;
  assert.match(detail, new RegExp(`supporting|support it`));
});

test("provenance 2b: a relevant citation with an unrelated one added is not a clean result", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${f1.primary}][${f1.article}].`, f1.evidence);
  assert.equal(result.ok, true, "one supporting citation is enough to avoid an error");
  assert.ok(types(result).includes("citation-unrelated-to-claim"), "the unrelated citation is still reported");
  assert.equal(result.issues.find((issue) => issue.type === "citation-unrelated-to-claim").severity, "warning");
});

test("provenance 3: a verified identifier cited to a source that does not support the claimed product is flagged", async () => {
  const f1 = await facts();
  // The article names PHP2Shell and the issue, but it is not a read source linked to this identifier.
  const result = auditAnswer(`CVE-2026-109618 is a flaw in PHP2Shell [${f1.article}].`, f1.evidence);
  assert.equal(result.ok, false);
  const productIssue = result.issues.find((issue) => issue.type === "citation-not-supporting-claim" && /product/.test(issue.detail));
  assert.ok(productIssue, `expected a product issue, got ${JSON.stringify(result.issues)}`);
  assert.match(productIssue.detail, new RegExp(`\\[${f1.primary}\\]`), "the detail names the source that does support the product");
});

test("provenance 3b: the primary record of a verified finding is not a valid citation for an exploitation claim", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 is actively exploited [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, false);
  assert.ok(types(result).includes("citation-does-not-support-exploitation-claim"), JSON.stringify(result.issues));
  const detail = result.issues.find((issue) => issue.type === "citation-does-not-support-exploitation-claim").detail;
  assert.match(detail, new RegExp(`\\[${f1.kev}\\]`), "the detail names the KEV source");
  assert.match(detail, /not the identifier record/);
});

test("provenance 4: an exploitation claim cited to the source that establishes it (KEV) passes", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 is actively exploited [${f1.kev}].`, f1.evidence);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
});

test("provenance 4b: a public proof of concept is not established by the KEV citation", async () => {
  const f1 = await facts();
  // CVE-2026-109619 is a public proof of concept, not exploitation. The claim is flagged even with a citation.
  const result = auditAnswer(`CVE-2026-109619 is actively exploited [${f1.pocPrimary}].`, f1.evidence);
  assert.equal(result.ok, false);
  assert.ok(types(result).includes("exploitation-claim-not-confirmed"));
});

test("provenance 5: a statement with no identifier is reported as a limitation, not as a checked claim", async () => {
  const f1 = await facts();
  const result = auditAnswer(`Reports describe the campaign as widespread [${f1.article}].`, f1.evidence);
  assert.equal(result.ok, true, "no error is invented for a statement the evidence cannot check");
  assert.deepEqual(result.issues, []);
  assert.ok(result.limitations.some((line) => /name no identifier/.test(line)), JSON.stringify(result.limitations));
});

test("provenance 5b: an identifier statement with no citation is reported as a limitation", async () => {
  const f1 = await facts();
  const result = auditAnswer("CVE-2026-109618 is a critical flaw in PHP2Shell.", f1.evidence);
  assert.ok(result.limitations.some((line) => /no citation/.test(line)), JSON.stringify(result.limitations));
});

test("provenance: a primary record does not support a severity or affected-version claim unless it is that field's source", async () => {
  const f1 = await facts();
  // The KEV catalogue names the identifier, but the CVSS score and the affected versions come from the CVE record.
  const severity = auditAnswer(`CVE-2026-109618 has a CVSS score of 9.8 [${f1.kev}].`, f1.evidence);
  assert.ok(types(severity).includes("citation-not-supporting-claim"), JSON.stringify(severity.issues));
  const versions = auditAnswer(`CVE-2026-109618 affects PHP2Shell versions before 8.3.12 [${f1.kev}].`, f1.evidence);
  assert.ok(types(versions).includes("citation-not-supporting-claim"), JSON.stringify(versions.issues));
  // The same claims cite the record that states them.
  const ok = auditAnswer(`CVE-2026-109618 has a CVSS score of 9.8 [${f1.primary}] and affects PHP2Shell versions before 8.3.12 [${f1.primary}].`, f1.evidence);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
});

test("provenance: each clause is checked on its own citations, so a second clause cannot borrow the first one's citation", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 is listed in CISA KEV [${f1.kev}], and CVE-2026-109619 affects PHP2Shell [${f1.kev}].`, f1.evidence);
  assert.equal(result.ok, false);
  const bad = result.issues.find((issue) => issue.type === "citation-not-supporting-claim");
  assert.ok(bad && /CVE-2026-109619/.test(bad.detail), JSON.stringify(result.issues));
});

test("provenance: a finding without source fields is reported as a limitation, never as a pass or an error", () => {
  const legacy = {
    sources: [{ index: 1, url: "https://cveawg.mitre.org/api/cve/CVE-2026-109618", title: "record", tier: "primary", fetchStatus: "fetched" }],
    findings: [{ identifier: "CVE-2026-109618", status: "verified", exploitation: { status: "kev-listed" } }],
  };
  const result = auditAnswer("CVE-2026-109618 affects PHP2Shell [1].", legacy);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.ok(result.limitations.some((line) => /no source provenance/.test(line)), JSON.stringify(result.limitations));
});

test("provenance: an unverified identifier is reported once, by the status rule, not again by provenance", async () => {
  const f1 = await facts();
  const reported = { ...f1.evidence, findings: f1.evidence.findings.map((item) => (item.identifier === "CVE-2026-109619" ? { ...item, status: "reported" } : item)) };
  const result = auditAnswer(`CVE-2026-109619 affects PHP2Shell [${f1.article}].`, reported);
  const types1 = types(result);
  assert.ok(types1.includes("unverified-identifier-stated"));
  // The identity is not checked a second time. The product claim is a separate claim with no product support, so it
  // is still reported.
  const identityIssues = result.issues.filter((issue) => issue.type === "citation-not-supporting-claim" && /identity claim/.test(issue.detail));
  assert.deepEqual(identityIssues, [], "no duplicate identity error");
  assert.ok(types1.includes("citation-not-supporting-claim"), "the product claim has no supporting source and is reported");
});

test("provenance: a search result that was never read is not evidence for a product claim", async () => {
  const f1 = await facts();
  // A search hit names the identifier and the product, but its page was never read. It is a lead, not a source.
  const searchHit = { index: 9, url: "https://example.test/search-hit", title: "PHP2Shell CVE-2026-109618", snippet: "PHP2Shell is tracked as CVE-2026-109618.", origin: "search", tier: "web", sourceType: "web", fetchStatus: "search-only" };
  const evidence = {
    sources: [...f1.evidence.sources, searchHit],
    findings: f1.evidence.findings.map((item) => (item.identifier === "CVE-2026-109618" ? { ...item, searchSources: [...item.searchSources, 9] } : item)),
  };
  const result = auditAnswer("CVE-2026-109618 is a flaw in PHP2Shell [9].", evidence);
  assert.equal(result.ok, false);
  const productIssue = result.issues.find((issue) => issue.type === "citation-not-supporting-claim" && /product/.test(issue.detail));
  assert.ok(productIssue, `expected a product issue, got ${JSON.stringify(result.issues)}`);
  // The supporting sources are the verified record, and not the unread search hit.
  assert.match(productIssue.detail, new RegExp(`cited to \\[9\\].*support it are \\[${f1.primary}\\]`));
  assert.doesNotMatch(productIssue.detail, /support it are [^.]*\[9\]/);
});
