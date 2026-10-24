// Tests for product claims in the answer audit: an identifier must not be associated with a product its own primary
// record does not name, whatever citation the answer gives, and with or without a query subject.
//
// EXECUTED: every test is offline. The findings come from the real research pipeline run on the SYNTHETIC fixtures
// (scripts/tests/fixtures/web-research/) through the fake fetchers. Nothing is fetched from the network. A few tests
// change one field of a real finding (for example, its status) to test the audit's rule for that case. Those tests
// say so where they do it.
//
// This is a deterministic consistency check. It compares product words, not meaning. These tests show that the check
// flags the cases it is meant to flag, and reports the wording it cannot check. They do not show that any answer is true.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const { comprehensiveWebSearch } = require(path.join(root, "scripts", "search", "core.js"));
const { auditAnswer } = require(path.join(root, "scripts", "search", "citation-audit.js"));
const f = require(path.join(__dirname, "support", "web-research-fakes.cjs"));

const NOW = new Date("2026-10-24T06:00:00Z");

async function research(question) {
  return comprehensiveWebSearch(question, {
    noCache: true,
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "product-")),
    now: () => NOW,
    deps: {
      webSearch: f.fakeWebSearch([[/.*/, f.searchResultsFromFixture()]]),
      fetchRaw: f.fakeFetchRaw(f.standardRaw()),
      fetchPage: f.fakeFetchPage(new Map([[f.URLS.news, f.htmlPage("incident-article.html")]])),
    },
  });
}

let named = null;
let broad = null;
async function namedEvidence() {
  if (!named) {
    const result = await research("Is PHP2Shell actively exploited? What are the CVEs?");
    named = { sources: result.sources, findings: result.findings };
  }
  return named;
}
async function broadEvidence() {
  if (!broad) {
    const result = await research("What are the latest discovered exploits in cybersecurity?");
    broad = { sources: result.sources, findings: result.findings };
  }
  return broad;
}

const finding = (evidence, id) => evidence.findings.find((item) => item.identifier === id);
const types = (result) => result.issues.map((issue) => issue.type);
const issuesOf = (result, type) => result.issues.filter((issue) => issue.type === type);

// The facts used below, read from the real findings.
async function facts() {
  const evidence = await namedEvidence();
  const primary = finding(evidence, "CVE-2026-109618");
  assert.equal(primary.status, "verified", "fixture precondition");
  assert.equal(primary.subject, "PHP2Shell", "fixture precondition");
  assert.match(primary.product.value, /PHP2Shell/, "fixture precondition: the record names PHP2Shell");
  const article = evidence.sources.find((source) => /bleepingcomputer/.test(source.url)).index;
  return { evidence, primary: primary.primarySource, article };
}

// A search result that was never read. It names a product in its snippet, which is not evidence for a product claim.
function searchHit(index, snippet) {
  return { index, url: "https://example.test/search-hit", title: "Search result", snippet, origin: "search", tier: "web", sourceType: "web", fetchStatus: "search-only" };
}

// Replaces one finding in the evidence. Used only where a test needs a particular status or product value.
function withFinding(evidence, id, changes) {
  return {
    ...evidence,
    findings: evidence.findings.map((item) => (item.identifier === id ? { ...item, ...changes } : item)),
  };
}

// --- 1. A correct product claim, with its supporting primary record -------------------------------------------------

test("product 1: a correct product claim with its supporting primary record passes", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(issuesOf(result, "product-claim-mismatch"), []);
  assert.deepEqual(issuesOf(result, "product-claim-unverified"), []);
});

test("product 1b: the same product named in another construction passes", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 is a flaw in PHP2Shell [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

// --- 2. A different product substituted into the claim, citing the correct record --------------------------------

test("product 2: a different product substituted into the claim is a mismatch, even when the correct record is cited", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects Apache Struts [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, false, "a correct citation must not allow a claim that names a different product");
  const mismatch = issuesOf(result, "product-claim-mismatch");
  assert.equal(mismatch.length, 1, JSON.stringify(result.issues));
  assert.equal(mismatch[0].severity, "error");
  assert.match(mismatch[0].detail, /Apache Struts/);
  assert.match(mismatch[0].detail, /PHP2Shell/, "the detail names the product the record does give");
  // The citation is to the right record, so no citation problem is reported for the product itself.
  assert.deepEqual(issuesOf(result, "citation-not-supporting-claim").filter((issue) => /product/.test(issue.detail)), []);
});

test("product 2b: a read-but-unlinked mention of the other product does not make the claim correct", async () => {
  const f1 = await facts();
  // The search result's snippet names Apache Struts. A snippet is never evidence for a product claim.
  const evidence = { ...f1.evidence, sources: [...f1.evidence.sources, searchHit(9, "Apache Struts is affected by CVE-2026-109618.")] };
  const result = auditAnswer("CVE-2026-109618 affects Apache Struts [9].", evidence);
  assert.equal(result.ok, false);
  assert.equal(issuesOf(result, "product-claim-mismatch").length, 1, JSON.stringify(result.issues));
});

test("product 2c: a product that shares one word with the record's name is still a different product", async () => {
  const f1 = await facts();
  // "Synthetic" is the vendor. "Apache" is not in the record, so the claim names a different product.
  const result = auditAnswer(`CVE-2026-109618 affects Apache Synthetic [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, false, "every word of the claimed name must be in the record");
  assert.equal(issuesOf(result, "product-claim-mismatch").length, 1);
});

test("product 2d: a claim with two products is checked for each, so the wrong one is flagged", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects PHP2Shell and Apache Struts [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, false);
  const mismatch = issuesOf(result, "product-claim-mismatch");
  assert.equal(mismatch.length, 1, JSON.stringify(result.issues));
  assert.match(mismatch[0].detail, /Apache Struts/);
});

// --- 3. A wrong product with an unrelated valid source -------------------------------------------------------------

test("product 3: a wrong product with an unrelated valid source is flagged as a mismatch and as a citation problem", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects Apache Struts [${f1.article}].`, f1.evidence);
  assert.equal(result.ok, false);
  assert.equal(issuesOf(result, "product-claim-mismatch").length, 1, JSON.stringify(result.issues));
  assert.ok(types(result).includes("citation-not-supporting-claim"), "the article does not support the claim either");
});

// --- 4. A product claim in a broad question with no query subject --------------------------------------------------

test("product 4: a broad question with no subject still checks product claims", async () => {
  const evidence = await broadEvidence();
  const primary = finding(evidence, "CVE-2026-109618");
  assert.equal(primary.subject, null, "fixture precondition: a broad question has no subject");
  assert.equal(primary.status, "verified", "fixture precondition");
  const wrong = auditAnswer(`CVE-2026-109618 affects Apache Struts [${primary.primarySource}].`, evidence);
  assert.equal(wrong.ok, false, JSON.stringify(wrong.issues));
  assert.equal(issuesOf(wrong, "product-claim-mismatch").length, 1);
});

test("product 4b: with no subject, the product the record names passes", async () => {
  const evidence = await broadEvidence();
  const primary = finding(evidence, "CVE-2026-109618");
  const right = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${primary.primarySource}].`, evidence);
  assert.equal(right.ok, true, JSON.stringify(right.issues));
  assert.deepEqual(issuesOf(right, "product-claim-mismatch"), []);
});

test("product 4c: a vendor name from the record's own metadata is accepted, as the record names it", async () => {
  // The vendor is part of the record's product metadata ("Synthetic PHP Project PHP2Shell"). A claim that names only the
  // vendor is consistent with the record. This is a deliberate word-level rule, and it is tested so that it stays visible.
  const evidence = await broadEvidence();
  const primary = finding(evidence, "CVE-2026-109618");
  const vendor = auditAnswer(`CVE-2026-109618 affects Synthetic PHP Project [${primary.primarySource}].`, evidence);
  assert.equal(vendor.ok, true, JSON.stringify(vendor.issues));
});

// --- 5. Ambiguous product wording: reported as not checked, never silently passed ----------------------------------

test("product 5: ambiguous product wording is reported as not checked, not passed silently", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects the forum software [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true, "ambiguous wording is not an error by itself");
  assert.ok(result.limitations.some((line) => /"the forum software" was not checked/.test(line)), JSON.stringify(result.limitations));
});

test("product 5b: lowercase product wording is reported as not checked", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects wordpress plugins [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true);
  assert.ok(result.limitations.some((line) => /"wordpress plugins" was not checked/.test(line)), JSON.stringify(result.limitations));
});

test("product 5c: a product named in a statement with no identifier is reported, because it cannot be attributed", async () => {
  const f1 = await facts();
  const result = auditAnswer(`Attackers used it in Windows environments [${f1.primary}].`, f1.evidence);
  assert.ok(result.limitations.some((line) => /"Windows environments" is named without an identifier/.test(line)), JSON.stringify(result.limitations));
});

test("product 5d: a phrase that is only a date is not a product claim", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 was found in July 2026 [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.limitations.filter((line) => /Product/.test(line)), [], "a date is not reported as a product");
});

// --- Statuses, negation and hedges ----------------------------------------------------------------------------------

test("product 6: a product claim on an identifier with no verified product evidence is reported as unverified", async () => {
  // Changes one field of a real finding, to test the rule for an identifier whose record could not be retrieved.
  const f1 = await facts();
  const evidence = withFinding(f1.evidence, "CVE-2026-109618", { status: "primary-unavailable", product: null, primarySource: null });
  const result = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${f1.article}].`, evidence);
  assert.equal(result.ok, false);
  const unverified = issuesOf(result, "product-claim-unverified");
  assert.equal(unverified.length, 1, JSON.stringify(result.issues));
  assert.equal(unverified[0].severity, "error");
  assert.match(unverified[0].detail, /no verified product evidence/);
});

test("product 6b: the same claim, hedged, is not reported as an unverified product", async () => {
  const f1 = await facts();
  const evidence = withFinding(f1.evidence, "CVE-2026-109618", { status: "primary-unavailable", product: null, primarySource: null });
  const result = auditAnswer(`CVE-2026-109618 may affect PHP2Shell [${f1.article}].`, evidence);
  assert.deepEqual(issuesOf(result, "product-claim-unverified"), [], JSON.stringify(result.issues));
});

test("product 6c: a verified record with no structured product names gives an inconclusive warning, not an error", async () => {
  // Changes the product metadata of a real finding. Advisory pages have no structured product names.
  const f1 = await facts();
  const evidence = withFinding(f1.evidence, "CVE-2026-109618", { product: null });
  const other = auditAnswer(`CVE-2026-109618 affects Apache Struts [${f1.primary}].`, evidence);
  const issue = issuesOf(other, "product-claim-unverified");
  assert.equal(issue.length, 1, JSON.stringify(other.issues));
  assert.equal(issue[0].severity, "warning", "a comparison that cannot be made is inconclusive, not a proven error");
  assert.equal(other.ok, true);
  // The subject, which the record was verified against, still passes.
  const same = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${f1.primary}].`, evidence);
  assert.equal(same.ok, true, JSON.stringify(same.issues));
});

test("product 7: a conflicting record still names its product, and a claim of the subject for it is a mismatch", async () => {
  // Changes one real finding to a conflict whose record names a different product.
  const f1 = await facts();
  const evidence = withFinding(f1.evidence, "CVE-2026-109619", { status: "conflict", product: { value: "Example Forum Plugin", source: f1.primary, mismatch: true } });
  const result = auditAnswer(`CVE-2026-109619 affects PHP2Shell [${f1.primary}].`, evidence);
  const mismatch = issuesOf(result, "product-claim-mismatch");
  assert.equal(mismatch.length, 1, JSON.stringify(result.issues));
  assert.match(mismatch[0].detail, /Example Forum Plugin/);
});

test("product 8: a negated claim is not an association, so it is not reported", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 does not affect Apache Struts [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(issuesOf(result, "product-claim-mismatch"), []);
});

test("product 8b: a hedged mismatch is a warning, not an error, and the hedge is said", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 may affect Apache Struts [${f1.primary}].`, f1.evidence);
  const mismatch = issuesOf(result, "product-claim-mismatch");
  assert.equal(mismatch.length, 1, JSON.stringify(result.issues));
  assert.equal(mismatch[0].severity, "warning");
  assert.equal(result.ok, true, "a hedged claim is reported, but it is not an error");
});

test("product 9: a claim about the right product in an earlier clause does not excuse a wrong one in a later clause", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${f1.primary}], and it also affects Apache Struts [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, false);
  assert.equal(issuesOf(result, "product-claim-mismatch").length, 1, JSON.stringify(result.issues));
});
