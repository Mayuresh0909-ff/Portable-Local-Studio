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

test("product 4c: a vendor name used as the affected product is a mismatch, even in a broad question", async () => {
  // Earlier this passed: the vendor name was part of the product text. The record gives the vendor separately, so a
  // vendor name in a product claim is not the affected product.
  const evidence = await broadEvidence();
  const primary = finding(evidence, "CVE-2026-109618");
  const vendor = auditAnswer(`CVE-2026-109618 affects Synthetic PHP Project [${primary.primarySource}].`, evidence);
  assert.equal(vendor.ok, false, JSON.stringify(vendor.issues));
  const mismatch = issuesOf(vendor, "product-claim-mismatch");
  assert.equal(mismatch.length, 1, JSON.stringify(vendor.issues));
  assert.match(mismatch[0].detail, /as the vendor/);
});

test("product 4d: a vendor named with explicit vendor wording is checked against the vendor field and passes", async () => {
  const evidence = await broadEvidence();
  const primary = finding(evidence, "CVE-2026-109618");
  const right = auditAnswer(`CVE-2026-109618 affects PHP2Shell from the vendor Synthetic PHP Project [${primary.primarySource}].`, evidence);
  assert.equal(right.ok, true, JSON.stringify(right.issues));
  assert.deepEqual(issuesOf(right, "vendor-claim-mismatch"), []);
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

// --- 6. Vendor and product evidence kept apart ---------------------------------------------------------------------

test("evidence: the product and the vendor are kept in separate fields, with their source", async () => {
  const f1 = await facts();
  const primary = finding(f1.evidence, "CVE-2026-109618");
  assert.deepEqual(primary.product.names, ["PHP2Shell"], "the product field holds the product only");
  assert.equal(primary.product.value, "PHP2Shell");
  assert.deepEqual(primary.vendor.names, ["Synthetic PHP Project"], "the vendor field holds the vendor only");
  assert.equal(primary.vendor.value, "Synthetic PHP Project");
  assert.equal(primary.vendor.source, primary.product.source, "both come from the same primary record");
});

test("6a: a correct product claim and a correct vendor claim, each checked against its own field, pass", async () => {
  const f1 = await facts();
  const product = auditAnswer(`CVE-2026-109618 affects PHP2Shell [${f1.primary}].`, f1.evidence);
  assert.equal(product.ok, true, JSON.stringify(product.issues));
  const vendor = auditAnswer(`CVE-2026-109618 was made by Synthetic PHP Project [${f1.primary}].`, f1.evidence);
  assert.equal(vendor.ok, true, JSON.stringify(vendor.issues));
});

test("6b: a vendor name used in place of the affected product is a product mismatch, even with the right record cited", async () => {
  const f1 = await facts();
  const whole = auditAnswer(`CVE-2026-109618 affects Synthetic PHP Project [${f1.primary}].`, f1.evidence);
  assert.equal(whole.ok, false);
  assert.equal(issuesOf(whole, "product-claim-mismatch").length, 1, JSON.stringify(whole.issues));
  // Part of the vendor's name is the same kind of error, not a partial product name.
  const part = auditAnswer(`CVE-2026-109618 affects Synthetic [${f1.primary}].`, f1.evidence);
  assert.equal(part.ok, false, JSON.stringify(part.issues));
  assert.equal(issuesOf(part, "product-claim-mismatch").length, 1);
});

test("6c: a product name used as the vendor is a vendor mismatch", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 was made by PHP2Shell [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, false, JSON.stringify(result.issues));
  assert.equal(issuesOf(result, "vendor-claim-mismatch").length, 1, JSON.stringify(result.issues));
});

test("6d: a product sharing words with the real product is a mismatch, and a partial name is a limitation", async () => {
  const result = await research("News Kit Addons for Elementor CVE-2026-97353 status?");
  const evidence = { sources: result.sources, findings: result.findings };
  const news = finding(evidence, "CVE-2026-97353");
  assert.equal(news.status, "verified", "fixture precondition");
  assert.equal(news.product.value, "News Kit Addons for Elementor", "fixture precondition");
  // Elementor Pro Widget Pack is CVE-2026-97354's product. It shares "Elementor" with the real product.
  const wrong = auditAnswer(`CVE-2026-97353 affects Elementor Pro Widget Pack [${news.primarySource}].`, evidence);
  assert.equal(wrong.ok, false, JSON.stringify(wrong.issues));
  assert.equal(issuesOf(wrong, "product-claim-mismatch").length, 1);
  // "Elementor" alone is only part of the real product's name: it is not verified, and it is reported.
  const partial = auditAnswer(`CVE-2026-97353 affects Elementor [${news.primarySource}].`, evidence);
  assert.equal(issuesOf(partial, "product-claim-mismatch").length, 0, JSON.stringify(partial.issues));
  assert.ok(partial.limitations.some((line) => /"Elementor" for CVE-2026-97353 partly matches/.test(line)), JSON.stringify(partial.limitations));
});

test("6e: the vendor of a second product is not the vendor of the first (vendor claims are checked per finding)", async () => {
  const result = await research("News Kit Addons for Elementor CVE-2026-97353 status?");
  const evidence = { sources: result.sources, findings: result.findings };
  const news = finding(evidence, "CVE-2026-97353");
  const right = auditAnswer(`CVE-2026-97353 was made by Synthetic Vendor [${news.primarySource}].`, evidence);
  assert.equal(right.ok, true, JSON.stringify(right.issues));
  const wrong = auditAnswer(`CVE-2026-97353 was made by Synthetic PHP Project [${news.primarySource}].`, evidence);
  assert.equal(wrong.ok, false, JSON.stringify(wrong.issues));
  assert.equal(issuesOf(wrong, "vendor-claim-mismatch").length, 1);
});

test("6f: a broad question with no subject still checks vendor and product claims", async () => {
  const evidence = await broadEvidence();
  const primary = finding(evidence, "CVE-2026-109618");
  assert.equal(primary.subject, null, "fixture precondition");
  const vendorRight = auditAnswer(`CVE-2026-109618 was made by Synthetic PHP Project [${primary.primarySource}].`, evidence);
  assert.equal(vendorRight.ok, true, JSON.stringify(vendorRight.issues));
  const vendorWrong = auditAnswer(`CVE-2026-109618 was made by PHP2Shell [${primary.primarySource}].`, evidence);
  assert.equal(vendorWrong.ok, false);
  assert.equal(issuesOf(vendorWrong, "vendor-claim-mismatch").length, 1);
});

test("6g: vendor wording the audit cannot read is reported as not checked, not passed", async () => {
  const f1 = await facts();
  const possessive = auditAnswer(`CVE-2026-109618 affects the vendor's software [${f1.primary}].`, f1.evidence);
  assert.equal(possessive.ok, true);
  assert.ok(possessive.limitations.some((line) => /"the vendor's software" was not checked/.test(line)), JSON.stringify(possessive.limitations));
  const lower = auditAnswer(`CVE-2026-109618 was made by synthetic php project [${f1.primary}].`, f1.evidence);
  assert.ok(lower.limitations.some((line) => /"synthetic php project" was not checked/.test(line)), JSON.stringify(lower.limitations));
});

test("6h: a negated vendor association is not a claim", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 is not made by Synthetic PHP Project [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(issuesOf(result, "vendor-claim-mismatch"), []);
});

test("6j: a source named by 'published by' is not read as the vendor", async () => {
  const f1 = await facts();
  // The named body is the source of the statement, not the vendor. Reading it as a vendor would be a false mismatch.
  // (CISA is not used here: its name is a neutral word, so it is never read as a name at all.)
  const result = auditAnswer(`CVE-2026-109618 affects PHP2Shell, and the advisory was published by Tenable Research [${f1.primary}].`, f1.evidence);
  assert.deepEqual(issuesOf(result, "vendor-claim-mismatch"), [], JSON.stringify(result.issues));
  assert.deepEqual(issuesOf(result, "product-claim-mismatch"), [], JSON.stringify(result.issues));
});

test("6i: a vendor document type such as 'vendor advisory' is not read as a vendor name", async () => {
  const f1 = await facts();
  const result = auditAnswer(`CVE-2026-109618 is covered in the vendor advisory [${f1.primary}].`, f1.evidence);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.limitations.filter((line) => /Vendor/.test(line)), []);
});

test("records: an NVD CPE gives the vendor and the product as separate names", () => {
  const { parseNvdResponse } = require(path.join(root, "scripts", "search", "records.js"));
  const record = parseNvdResponse({
    vulnerabilities: [{ cve: {
      id: "CVE-2026-1234567",
      vulnStatus: "Analyzed",
      published: "2026-01-01T00:00:00.000",
      descriptions: [{ lang: "en", value: "Synthetic NVD record." }],
      configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: "cpe:2.3:a:apache:struts:*:*:*:*:*:*:*:*", versionEndExcluding: "2.5.33" }] }] }],
    } }],
  });
  assert.deepEqual(record.products.map((item) => [item.vendor, item.product]), [["apache", "struts"]]);
  assert.deepEqual(record.productNames.sort(), ["apache", "struts"]);
});

