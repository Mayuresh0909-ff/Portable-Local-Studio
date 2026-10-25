// Deterministic consistency check of an assistant answer against the research evidence it was given.
//
// This is a text check, not a judgement of truth. It cannot tell whether a sentence is correct, and a clean result
// does not guarantee that the answer is true. It catches:
//  - bracket citations that point at no source;
//  - identifiers stated without a hedge when their finding is not verified;
//  - "actively exploited" claims that the exploitation status does not support, including generic claims that
//    cover several findings when only some of them are confirmed;
//  - a confirmed exploitation claim cited to a source other than the one that establishes the exploitation status
//    (for example the identifier's own record, which does not state KEV or SSVC exploitation);
//  - a claim about an identifier's identity, product, affected versions, publication date, article date, severity
//    or KEV listing whose citation is not among the sources that support that field;
//  - a product named as associated with an identifier that its primary record does not name as a product. A citation
//    to the correct record does not make a different product correct. A product claim on an identifier with no verified
//    product evidence is reported too;
//  - a vendor named as the vendor of an identifier that its primary record does not name as the vendor. A vendor name
//    used as the product is a product mismatch, and a product name used as the vendor is a vendor mismatch. Vendor
//    wording must be explicit ("vendor X", "made by X"); a name after a product cue is a product;
//  - an EUVD identifier presented as the CVE with the same number.
//
// How it reads the answer:
//  - Each sentence is split into clauses at ';', at a comma before a contrast or conjunction ("but", "and"), and
//    at contrast words ("but", "while", "however"). Every clause is checked.
//  - A claim's identifiers are the clause's own, or the sentence's when the clause names none.
//  - A claim's citations are the clause's own, or the sentence's when the clause has none.
//  - A hedge only applies to the words between the last boundary and the claim (for exploitation claims), or to
//    the clause (for unverified identifiers).
//  - A claim with no identifier anywhere is a generic claim and needs every finding to be confirmed.
//
// What it cannot establish, and reports as a limitation instead of a pass:
//  - the meaning of product and vendor wording. Names are compared word by word with the record's own product and
//    vendor names, kept in separate fields. A name that is only part of a record name ("Elementor" for "News Kit Addons
//    for Elementor") or that adds words to it is reported as not verified, not passed. Lowercase or ambiguous wording
//    ("affects the forum software", "the vendor's software") is reported as not checked. A product or vendor named in a
//    statement with no identifier is reported, because it cannot be attributed to a finding;
//  - whether a sentence without an identifier is supported by its citation (it is checked for existence only);
//  - whether a finding has source provenance at all (an older evidence shape has none);
//  - whether a general exploitation claim is supported finding by finding.

const { extractIdentifiers } = require("./identifiers");
const { splitSentences } = require("./records");

const CHECK_NAME = "deterministic-consistency-check";
const CHECK_NOTE = "A deterministic text check against the evidence listed. It is not a judgement of whether the answer is true, and a clean result does not guarantee that it is.";

const EXPLOITED_CLAIM = /\b(actively exploited|exploited in the wild|known exploited|being exploited|under active (?:attack|exploitation)|(?:is|are|was|were|has been|have been) exploited|exploited by (?:attackers|threat actors|hackers)|attackers (?:are|have been|were) exploiting|exploitation (?:is |has been |was )?(?:observed|detected|confirmed)|confirms? (?:active )?exploitation|in active use|actively abused)\b/gi;
// Words that make a claim tentative or negated when they come directly before it in the same segment.
const SCOPED_HEDGE = /\b(not|no|never|without|unverified|unconfirmed|unclear|unknown|reportedly|reported|allegedly|claimed|may|might|could|possibly|whether|if|cannot|could not|not confirmed|not established|no evidence)\b/i;
// Words that negate a product association, in the segment before the claim.
const NEGATION = /\b(?:not|no|never|without|cannot|could not|nor)\b|n't\b/i;
// Words that make a whole clause tentative (used for identifier mentions).
const HEDGE = /\b(not|no|never|unverified|unconfirmed|reported|reportedly|claimed|allegedly|may|might|could|possibly|unclear|unknown|not verified|could not|cannot|couldn'?t|no evidence|not confirmed|not established|search result|mentioned|conflict|unavailable|not found|not checked)\b/i;
const CONFIRMED_EXPLOITATION = new Set(["kev-listed", "cisa-ssvc-active"]);

// Field detection. These are word patterns on the clause, so they only say what kind of claim a clause makes.
const KEV_WORD = /\bKEV\b|\bknown exploited\b/gi;
const PUBLISHED_WORD = /\b(published|released|disclosed|announced|publication)\b|\b\d{4}-\d{2}-\d{2}\b/i;
const ARTICLE_WORD = /\b(article|coverage|blog|news|mentions?|mentioned|according to|reported by|reports?)\b/i;
const SEVERITY_WORD = /\b(cvss|severity|score)\b/i;
const VERSION_WORD = /\bversions?\b|\b\d+\.\d+(?:\.\d+)*\b/i;

const FIELD_LABELS = {
  identity: "identity",
  product: "product",
  vendor: "vendor",
  versions: "affected-versions",
  published: "publication date",
  "article-date": "article date",
  severity: "severity",
  kev: "CISA KEV listing",
};

const CLAUSE_SPLIT = /;|,\s+(?:but|while|whereas|however|although|though|yet|and|so)\b|\b(?:but|while|whereas|however|although|though|yet)\b/i;
const SEGMENT_BOUNDARY = /[,;:(]|\b(?:and|but|while|whereas|however|although|though|yet|so|because)\b/i;

// Product wording. A product claim names a product after a cue that ties it to the identifier: a verb such as
// "affects", or a preposition ("in", "for", "against") after a noun such as "flaw", "found" or "bundled". A preposition
// is a cue only before a capitalised or digit-bearing name, so "in the wild" and "for example" are not product claims.
const PRODUCT_CUE = /\b(?:affects?|affecting|impacts?|impacting|targets?|targeting|(?:flaws?|vulnerabilit(?:y|ies)|bugs?|issues?|weakness(?:es)?|exploits?|plugins?|modules?|components?|extensions?)\s+(?:in|for|against|of)|(?:found|present|used|bundled|shipped|running|installed)\s+(?:in|with|on)|in|for|against)\s+/gi;
// The end of a product name: punctuation, a citation, another identifier, or a word that starts a new clause.
const PRODUCT_PHRASE_END = /[,;:()\[\]"\u201c\u201d!?]|\.(?=\s|$)|\s+(?:which|that|who|because|since|when|where|via|through|with|is|are|was|were|be|been|being|has|have|had|can|could|may|might|will|would|should|allows?|allowing|lets?|enables?|leads?|in|on|to|from|by|as|at|than|before|prior|between|up|if|whether|although|though|so|also|too|after|during|including|such)\b|\b(?:CVE|EUVD|GHSA)-\d/i;
// Words that are not part of a product name: identifier schemes, catalogues, scores, version markers and grammar.
const NEUTRAL_WORDS = new Set(["vulnerability", "vulnerabilities", "flaw", "flaws", "bug", "bugs", "issue", "issues",
  "weakness", "weaknesses", "exploit", "exploits", "attack", "attacks", "cve", "cves", "euvd", "ghsa", "cvss", "ssvc",
  "epss", "osv", "cwe", "cisa", "kev", "nvd", "mitre", "nist", "version", "versions", "release", "releases", "product",
  "products", "before", "after", "prior", "through", "and", "or", "of", "for", "in", "on", "with", "to", "the", "a", "an",
  "is", "are", "was", "were"]);
const MONTHS = new Set(["january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december"]);
// A capitalised-or-not determiner or quantifier at the start of a phrase: the phrase names no product.
const DETERMINERS = new Set(["the", "a", "an", "this", "that", "these", "those", "its", "their", "his", "her", "our", "your",
  "some", "many", "several", "most", "all", "any", "both", "each", "other", "others", "multiple", "various", "such"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function splitClauses(sentence) {
  return sentence.split(CLAUSE_SPLIT).map((part) => part.trim()).filter(Boolean);
}

// The words between the last boundary and the claim, e.g. "CVE-X is not " for "CVE-X is not actively exploited".
function segmentBefore(clause, index) {
  const before = clause.slice(0, index);
  const pieces = before.split(new RegExp(SEGMENT_BOUNDARY.source, "gi"));
  return pieces[pieces.length - 1] || "";
}

function uniqueIds(items) {
  const seen = [];
  for (const item of items) if (!seen.includes(item.id)) seen.push(item.id);
  return seen;
}

// Citation numbers in a piece of text, in order, without duplicates.
function citationsIn(text) {
  const numbers = [...String(text || "").matchAll(/\[(\d{1,3})\](?!\()/g)].map((match) => Number(match[1]));
  return [...new Set(numbers)];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whether a finding carries the source fields this check needs. Older evidence shapes do not.
function hasProvenance(finding) {
  return Boolean(finding) && ("primarySource" in finding) && ("readSources" in finding) && ("exploitation" in finding);
}

// The source numbers that support one kind of claim about a finding. Only a source that actually provides the field
// counts. A primary record supports the identifier and, when verified, its product and versions. It does not
// support an exploitation claim, which needs the source that establishes the exploitation status.
// A source index as the research run numbers sources: a positive whole number, counting from 1. Missing, empty, boolean,
// fractional, zero and negative values are not indexes. Number(null) and Number("") are both 0, so they are rejected
// before any conversion. The result is null when the value is not an index.
function sourceIndexOf(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const number = Number(value.trim());
    return number > 0 ? number : null;
  }
  return null;
}

// The source indexes a finding supports a field with. An index counts only if it is one of the sources the audit was
// given (known), so a stale or invented index cannot support a claim. The known set is required.
function supportFor(finding, field, known) {
  const usable = (values) => [...new Set(values.map(sourceIndexOf).filter((index) => index !== null && known.has(index)))];
  const exploitation = finding.exploitation || {};
  const readSources = asArray(finding.readSources);
  switch (field) {
    case "identity":
      return usable([finding.primarySource, ...readSources, exploitation.source]);
    case "product":
      // A product is supported by the record that states it, and by read sources whose sentences link the identifier to the subject.
      return usable([finding.product?.source, finding.status === "verified" ? finding.primarySource : null, ...readSources]);
    case "vendor":
      // A vendor is supported by the record that states it, and by read sources whose sentences link the identifier to the subject.
      return usable([finding.vendor?.source, finding.status === "verified" ? finding.primarySource : null, ...readSources]);
    case "versions":
      return usable([finding.affectedVersions?.source]);
    case "published":
      return usable([finding.published?.source]);
    case "article-date":
      return usable([finding.articleDate?.source]);
    case "severity":
      return usable([finding.cvss?.source, finding.reportedSeverity?.source]);
    case "kev":
      return usable(exploitation.status === "kev-listed" ? [exploitation.source] : []);
    default:
      return [];
  }
}

function isNeutral(token) {
  return NEUTRAL_WORDS.has(token) || MONTHS.has(token) || /^\d+$/.test(token) || /^v\d+$/.test(token) || /^q[1-4]$/.test(token);
}

// The words of a product name, lowercase, without the neutral words, numbers and version markers.
function nameTokens(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token && !isNeutral(token));
}

// The position of a whole word in a clause, or -1.
function wordPosition(text, word) {
  if (!word) return -1;
  const match = new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`, "i").exec(String(text || ""));
  return match ? match.index + match[1].length : -1;
}

// One piece of product wording: a claim with name words, ambiguous wording that cannot be checked, or nothing.
function productItem(piece) {
  const words = piece.split(/\s+/).filter(Boolean);
  const tokens = nameTokens(piece);
  if (!tokens.length) return { kind: "ignore" };
  if (DETERMINERS.has(words[0].toLowerCase())) return { kind: "ambiguous" };
  // A name has a capitalised word or a word that mixes letters and digits (PHP2Shell). Lowercase nouns are not names.
  const named = words.some((word) => /^[A-Z]/.test(word) || /[a-z][0-9]|[0-9][a-z]/i.test(word));
  if (!named) return { kind: "ambiguous" };
  return { kind: "claim", tokens: [...new Set(tokens)] };
}

// Vendor wording. A vendor is named only by explicit wording: "vendor X", "maker X", "made by X" and similar. A name
// after a product cue is always a product, even when it is a vendor's name. So a vendor name used as the product is
// caught as a product claim.
// "published by" and "according to" are left out on purpose: they often name a source (CISA, NVD), not the vendor.
const VENDOR_CUE = /\b(?:vendors?|makers?|developers?|manufacturers?)\s+(?:of\s+|is\s+|was\s+)?(?:the\s+)?|\b(?:made|developed)\s+by\s+(?:the\s+)?/gi;
// Product wording that is really vendor wording ("products from the vendor X"). It is read by the vendor scan instead.
const VENDOR_WORD_AHEAD = /^(?:[a-z]+\s+){0,3}?(?:vendors?|makers?|developers?|manufacturers?)\b/i;
// Words that describe a vendor's document rather than naming the vendor ("the vendor security advisory").
const VENDOR_GENERIC = new Set(["advisory", "advisories", "notice", "notices", "bulletin", "update", "updates", "patch",
  "patches", "release", "releases", "statement", "security", "response", "psirt", "team", "blog", "article", "report", "fix", "fixes"]);

// The name pieces after a cue: up to the end of the name, split at "and", "or" and "/".
function namePieces(rest) {
  const cut = rest.search(PRODUCT_PHRASE_END);
  const phrase = (cut === -1 ? rest : rest.slice(0, cut)).trim();
  return phrase.split(/\s+(?:and|or)\s+|\s*\/\s*/i).map((item) => item.trim()).filter(Boolean);
}

// The product and vendor claims in a clause, and the ambiguous wording in it. A subject named in the clause is a product claim.
function productClaimsFor(clause, subject) {
  const claims = [];
  const ambiguous = [];
  if (subject) {
    const at = wordPosition(clause, subject);
    if (at !== -1) claims.push({ kind: "product", text: subject, tokens: nameTokens(subject), index: at });
  }
  // Vendor claims first: a vendor-worded product phrase is decided by whether a vendor claim was found.
  for (const match of clause.matchAll(VENDOR_CUE)) {
    const start = match.index + match[0].length;
    if (!/^[A-Z0-9]/.test(clause.charAt(start))) {
      // Vendor wording with a name the audit cannot read as a name (lowercase) is reported, not passed. A vendor's
      // document type ("vendor advisory") is not a name.
      const first = namePieces(clause.slice(start))[0];
      const words = first ? nameTokens(first) : [];
      if (words.length && !words.every((token) => VENDOR_GENERIC.has(token))) ambiguous.push(first);
      continue;
    }
    for (const piece of namePieces(clause.slice(start))) {
      const item = productItem(piece);
      if (item.kind === "claim" && !item.tokens.every((token) => VENDOR_GENERIC.has(token))) {
        claims.push({ kind: "vendor", text: piece, tokens: item.tokens, index: match.index });
      }
    }
  }
  const vendorClaimFound = claims.some((claim) => claim.kind === "vendor");
  for (const match of clause.matchAll(PRODUCT_CUE)) {
    const verb = /^(?:affects?|affecting|impacts?|impacting|targets?|targeting)$/i.test(match[0].trim());
    const start = match.index + match[0].length;
    // After a preposition, only a capitalised or digit-bearing word starts a name.
    if (!verb && !/^[A-Z0-9]/.test(clause.charAt(start))) continue;
    const rest = clause.slice(start);
    if (VENDOR_WORD_AHEAD.test(rest)) {
      // Vendor wording that the vendor scan did not turn into a claim (for example "the vendor's software") is reported.
      if (!vendorClaimFound) {
        const first = namePieces(rest)[0];
        if (first) ambiguous.push(first);
      }
      continue;
    }
    for (const piece of namePieces(rest)) {
      const item = productItem(piece);
      if (item.kind === "ambiguous") ambiguous.push(piece);
      else if (item.kind === "claim") claims.push({ kind: "product", text: piece, tokens: item.tokens, index: match.index });
    }
  }
  return { claims, ambiguous };
}

// Name words for a list of names. A name with no words is dropped.
function wordSets(names) {
  return asArray(names).map((name) => new Set(nameTokens(name))).filter((set) => set.size > 0);
}

// The names in a finding's product or vendor field. An older shape with only a text value is read as "; "-separated names.
function namesOf(field) {
  if (!field) return [];
  if (Array.isArray(field.names)) return field.names;
  return String(field.value || "").split("; ").filter(Boolean);
}

// The product names a finding supports: the names in its primary record (whatever its status, because a conflicting
// record still names its product), and the subject only when the record was verified against it.
function productWordSets(finding) {
  const sets = wordSets(namesOf(finding.product));
  if (finding.status === "verified") sets.push(...wordSets([finding.subject]));
  return sets;
}

function vendorWordSets(finding) {
  return wordSets(namesOf(finding.vendor));
}

function sameWords(a, b) {
  return a.size === b.size && [...a].every((word) => b.has(word));
}

function wordsWithin(a, b) {
  return [...a].every((word) => b.has(word));
}

// How a claimed name relates to the record's names of one kind.
//  exact: the same words as a record name.
//  partial: only some of a record name's words (for example "Struts" for "Apache Struts").
//  extended: a record name's words plus more (for example "PHP2Shell Lite" for "PHP2Shell").
//  none: no relation.
function relationOf(claimWords, sets) {
  if (sets.some((set) => sameWords(claimWords, set))) return "exact";
  if (sets.some((set) => wordsWithin(claimWords, set))) return "partial";
  if (sets.some((set) => wordsWithin(set, claimWords))) return "extended";
  return "none";
}

// The outcome of one claim against its finding's names:
//  matched: the claim gives the record's product (or vendor) name exactly.
//  limited: a partial or extended name. It is not verified, so it is reported as a limitation.
//  vendor-as-product: a product claim whose words are only the record's vendor.
//  product-as-vendor: a vendor claim whose words are only the record's product.
//  different: a name of this kind that the record does not give.
//  no-evidence: the record gives no name of this kind to compare with.
function judgeClaim(claim, finding) {
  const words = new Set(claim.tokens);
  const products = productWordSets(finding);
  const vendors = vendorWordSets(finding);
  if (claim.kind === "vendor") {
    const relation = relationOf(words, vendors);
    if (relation === "exact") return "matched";
    if (relation !== "none") return "limited";
    if (products.some((set) => wordsWithin(words, set))) return "product-as-vendor";
    return namesOf(finding.vendor).length ? "different" : "no-evidence";
  }
  const relation = relationOf(words, products);
  if (relation === "exact") return "matched";
  if (relation !== "none") return "limited";
  if (vendors.some((set) => wordsWithin(words, set))) return "vendor-as-product";
  return namesOf(finding.product).length ? "different" : "no-evidence";
}

// The kinds of claim a clause makes about an identifier, besides its identity and product. Negated KEV mentions make no claim.
function fieldsIn(clause) {
  const fields = new Set();
  if (PUBLISHED_WORD.test(clause)) fields.add(ARTICLE_WORD.test(clause) ? "article-date" : "published");
  if (SEVERITY_WORD.test(clause)) fields.add("severity");
  if (VERSION_WORD.test(clause)) fields.add("versions");
  for (const match of clause.matchAll(KEV_WORD)) {
    if (!SCOPED_HEDGE.test(segmentBefore(clause, match.index))) fields.add("kev");
  }
  return [...fields];
}

function auditAnswer(text, evidence = {}) {
  const answer = String(text || "");
  const sources = asArray(evidence.sources);
  const findings = asArray(evidence.findings);
  const indexes = new Set(sources.map((source) => Number(source.index)).filter(Number.isFinite));
  const issues = [];
  const limitations = [];
  const reported = new Set();
  const add = (type, severity, detail, value = null) => {
    const key = `${type}|${value === null ? detail : value}`;
    if (reported.has(key)) return;
    reported.add(key);
    issues.push({ type, severity, detail, value });
  };
  const limit = (text) => {
    if (!limitations.includes(text)) limitations.push(text);
  };

  // 1. Citation numbers must exist in the source list.
  const citations = [...answer.matchAll(/\[(\d{1,3})\](?!\()/g)].map((match) => Number(match[1]));
  for (const number of [...new Set(citations)]) {
    if (!indexes.has(number)) add("invalid-citation", "error", `[${number}] does not match any source in this answer's evidence.`, number);
  }

  const findingFor = (id) => findings.find((finding) => finding.identifier === id) || null;
  const isConfirmed = (finding) => CONFIRMED_EXPLOITATION.has(finding?.exploitation?.status);
  const sentences = splitSentences(answer);
  const identifiersSeen = new Set();
  let clauseCount = 0;
  let claimChecks = 0;
  let citedWithoutIdentifier = 0;
  let identifierClausesWithoutCitation = 0;
  let genericExploitationClaims = 0;
  const provenanceMissing = new Set();

  for (const sentence of sentences) {
    const sentenceIds = uniqueIds(extractIdentifiers(sentence));
    const sentenceCites = citationsIn(sentence);
    for (const id of sentenceIds) identifiersSeen.add(id);

    for (const clause of splitClauses(sentence)) {
      clauseCount += 1;
      const clauseIds = uniqueIds(extractIdentifiers(clause));
      const clauseCites = citationsIn(clause);
      // A claim's own citations, or the sentence's when the clause has none.
      const cites = clauseCites.length ? clauseCites : sentenceCites;
      // A claim's identifiers: the clause's own, or the sentence's when the clause names none.
      const ids = clauseIds.length ? clauseIds : sentenceIds;

      // 2. Identifier mentions: every mention in every clause is checked for status.
      for (const id of clauseIds) {
        const finding = findingFor(id);
        if (!finding) {
          add("identifier-not-in-findings", "warning", `${id} is not among the structured findings. Check its source before relying on it.`, id);
          continue;
        }
        if (finding.status !== "verified" && !HEDGE.test(clause)) {
          add("unverified-identifier-stated", "error", `${id} is stated without a hedge in this clause, but its status is "${finding.status}".`, id);
        }
      }

      // 2b. Product and vendor claims. A product named as associated with an identifier must be a product its own primary
      // record names. A name given as the vendor must be the record's vendor. A citation does not make a different name
      // correct, and a claim with no verified evidence is reported.
      const wording = productClaimsFor(clause, null);
      for (const piece of wording.ambiguous) {
        limit(`Product wording "${piece}" was not checked: it is not specific enough for a deterministic check.`);
      }
      if (!ids.length) {
        for (const claim of wording.claims) {
          limit(`${claim.kind === "vendor" ? "Vendor" : "Product"} "${claim.text}" is named without an identifier, so it was not checked against any finding.`);
        }
      }
      for (const id of ids) {
        const finding = findingFor(id);
        // Without provenance the names cannot be checked. That is reported under the limitations below.
        if (!finding || !hasProvenance(finding)) continue;
        for (const claim of productClaimsFor(clause, finding.subject).claims) {
          // A negated claim ("does not affect X") says there is no association, so it is not checked.
          const segment = segmentBefore(clause, claim.index);
          if (NEGATION.test(segment)) continue;
          const isVendor = claim.kind === "vendor";
          const label = isVendor ? "vendor" : "product";
          const prefix = isVendor ? "vendor-claim" : "product-claim";
          const recordedProduct = finding.product?.value || "not stated";
          const recordedVendor = finding.vendor?.value || "not stated";
          const verified = finding.status === "verified";
          const outcome = judgeClaim(claim, finding);
          if (outcome === "limited") {
            limit(`${isVendor ? "Vendor" : "Product"} "${claim.text}" for ${id} partly matches, or adds to, the name its primary record gives (${isVendor ? recordedVendor : recordedProduct}). It is not treated as verified.`);
            continue;
          }
          const hedged = SCOPED_HEDGE.test(segment);
          let kind = null;
          let detail = "";
          let inconclusive = false;
          if (outcome === "matched") {
            if (!verified) {
              kind = `${prefix}-unverified`;
              detail = `${id}: the answer associates it with "${claim.text}", but the identifier is ${finding.status}, so no ${label} is verified for it.`;
            }
          } else if (outcome === "vendor-as-product") {
            kind = "product-claim-mismatch";
            detail = `${id}: the answer names "${claim.text}" as the affected product, but its primary record gives that as the vendor. The product it names is ${recordedProduct}. Citing that record does not make a vendor name a product.`;
          } else if (outcome === "product-as-vendor") {
            kind = "vendor-claim-mismatch";
            detail = `${id}: the answer names "${claim.text}" as the vendor, but its primary record gives that as the product. The vendor it names is ${recordedVendor}. Citing that record does not make a product name a vendor.`;
          } else if (outcome === "different") {
            kind = `${prefix}-mismatch`;
            detail = isVendor
              ? `${id}: the answer names "${claim.text}" as the vendor, but its primary record names ${recordedVendor}. Citing that record does not make a different vendor correct.`
              : `${id}: the answer associates it with "${claim.text}", but its primary record names ${recordedProduct}. Citing that record does not make a different product correct.`;
          } else if (outcome === "no-evidence") {
            kind = `${prefix}-unverified`;
            inconclusive = verified;
            detail = verified
              ? `${id}: the answer associates it with "${claim.text}", but its primary record gives no ${label} name to check against.`
              : `${id}: the answer associates it with "${claim.text}", but no verified ${label} evidence exists for it (status: ${finding.status}).`;
          }
          if (!kind) continue;
          // A hedge in the claim's own segment: an unverified claim is skipped, and a mismatch is reported as a warning.
          if (kind.endsWith("-unverified") && hedged) continue;
          add(kind, hedged || inconclusive ? "warning" : "error", detail, `${id}|${kind}|${claim.text}`);
        }
      }

      // 3. Exploitation claims: each occurrence is checked on its own, with a hedge only from its own segment.
      let positiveExploitation = false;
      for (const match of clause.matchAll(EXPLOITED_CLAIM)) {
        if (SCOPED_HEDGE.test(segmentBefore(clause, match.index))) continue;
        positiveExploitation = true;

        // Identifiers this claim is about: the clause's own, or the sentence's when the clause names none.
        const named = ids;
        if (named.length) {
          const unsupported = named.filter((id) => !isConfirmed(findingFor(id)));
          if (unsupported.length) {
            add("exploitation-claim-not-confirmed", "error",
              `The answer says ${unsupported.join(", ")} is actively exploited, but no confirmed exploitation status (CISA KEV or CISA SSVC active) supports that. A public proof of concept or a search result is not exploitation.`,
              clause.slice(0, 160));
          }
        } else {
          // A generic claim covers every finding, so one confirmed finding is not enough.
          genericExploitationClaims += 1;
          const allConfirmed = findings.length > 0 && findings.every((finding) => isConfirmed(finding));
          if (!allConfirmed) {
            add("generic-exploitation-claim", "error",
              "The answer makes a general claim that some vulnerabilities are actively exploited, but not every finding is confirmed. Name the identifiers and their statuses instead.",
              clause.slice(0, 160));
          }
        }
      }

      // 4. Provenance: a claim about an identifier must cite a source that supports that field of its finding.
      if (!ids.length) {
        if (cites.length) citedWithoutIdentifier += 1;
        continue;
      }
      if (!cites.length) {
        identifierClausesWithoutCitation += 1;
        continue;
      }
      for (const id of ids) {
        const finding = findingFor(id);
        if (!finding) continue;
        if (!hasProvenance(finding)) {
          provenanceMissing.add(id);
          continue;
        }
        const fields = ["identity", ...fieldsIn(clause)];
        const nameClaims = productClaimsFor(clause, finding.subject).claims.map((claim) => claim.kind);
        if (nameClaims.includes("product")) fields.push("product");
        if (nameClaims.includes("vendor")) fields.push("vendor");
        // A confirmed exploitation claim needs the source that establishes the exploitation status.
        if (positiveExploitation && isConfirmed(finding)) fields.push("exploitation");
        for (const field of fields) {
          // An unverified identifier is already reported by the status rule above. Only verified identities are checked here.
          if (field === "identity" && finding.status !== "verified") continue;
          if (field === "exploitation") {
            // Exploitation is supported only by the source that states it, which is not the identifier record.
            const exploitationIndex = sourceIndexOf(finding.exploitation?.source);
            if (exploitationIndex === null || !indexes.has(exploitationIndex)) {
              // The claim cannot be checked against a source. This is reported, and no citation is accepted in its place.
              const reason = exploitationIndex === null
                ? "the exploitation status has no source index"
                : `the exploitation status names source [${exploitationIndex}], which is not one of the sources in the evidence`;
              add("exploitation-source-unavailable", "error",
                `${id} is described as actively exploited, but ${reason}. The claim cannot be checked against a source.`,
                `${id}|exploitation-source`);
              continue;
            }
            const exploitationSource = [exploitationIndex];
            claimChecks += 1;
            const good = cites.filter((n) => exploitationSource.includes(n));
            const bad = cites.filter((n) => !exploitationSource.includes(n));
            if (!good.length) {
              add("citation-does-not-support-exploitation-claim", "error",
                `${id} is described as actively exploited. Its exploitation status (${finding.exploitation.status}) is established by [${exploitationSource.join("], [")}], but the citation is [${cites.join("], [")}]. Cite the source that establishes exploitation, not the identifier record.`,
                `${id}|exploitation|${cites.join(",")}`);
            } else if (bad.length) {
              add("citation-unrelated-to-claim", "warning",
                `${id}: [${bad.join("], [")}] is cited for an exploitation claim but does not establish it. The supporting source is [${good.join("], [")}].`,
                `${id}|exploitation|${bad.join(",")}`);
            }
            continue;
          }
          const supported = supportFor(finding, field, indexes);
          claimChecks += 1;
          const label = FIELD_LABELS[field] || field;
          const good = cites.filter((n) => supported.includes(n));
          const bad = cites.filter((n) => !supported.includes(n));
          if (!good.length) {
            const detail = supported.length
              ? `${id}: the ${label} claim is cited to [${cites.join("], [")}], but the sources that support it are [${supported.join("], [")}].`
              : `${id}: the evidence has no source for the ${label} of this identifier, so [${cites.join("], [")}] cannot support the ${label} claim.`;
            add("citation-not-supporting-claim", "error", detail, `${id}|${field}|${cites.join(",")}`);
          } else if (bad.length) {
            add("citation-unrelated-to-claim", "warning",
              `${id}: [${bad.join("], [")}] is cited for the ${label} claim but does not support it. The supporting source is [${good.join("], [")}].`,
              `${id}|${field}|${bad.join(",")}`);
          }
        }
      }
    }
  }

  // Limitations: what the evidence structure cannot check. These are reported, never counted as passes.
  for (const id of provenanceMissing) {
    limit(`${id} has no source provenance in the evidence, so the citations to it were not checked against a source.`);
  }
  if (citedWithoutIdentifier) {
    limit(`${citedWithoutIdentifier} cited statement(s) name no identifier. Their citations were checked for existence only, not for support.`);
  }
  if (identifierClausesWithoutCitation) {
    limit(`${identifierClausesWithoutCitation} statement(s) about an identifier have no citation, so they were not checked against a source.`);
  }
  if (genericExploitationClaims && findings.length && findings.every((finding) => isConfirmed(finding))) {
    limit("A general exploitation claim was checked only against the confirmed status of every finding, not against each finding's source.");
  }

  // 5. EUVD identifiers presented as CVE identifiers with the same number. EUVD identifiers come from the findings
  // and from the source list, so the check does not depend on a record having been read.
  const euvdIds = new Set([
    ...findings.filter((finding) => finding.identifierType === "euvd").map((finding) => finding.identifier),
    ...sources.flatMap((source) => extractIdentifiers(`${source.title || ""} ${source.url || ""} ${source.snippet || ""}`))
      .filter((item) => item.type === "euvd").map((item) => item.id),
  ]);
  for (const item of extractIdentifiers(answer).filter((x) => x.type === "cve")) {
    const number = item.id.split("-")[2];
    const euvd = [...euvdIds].find((id) => id.endsWith(`-${number}`));
    if (euvd && !findingFor(item.id)) {
      add("possible-euvd-cve-confusion", "error", `${item.id} is cited, but the evidence has ${euvd}, which is an EUVD identifier. Do not treat them as the same identifier.`, item.id);
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  return {
    ok: errors === 0,
    kind: CHECK_NAME,
    note: CHECK_NOTE,
    issues,
    limitations,
    checked: {
      citations: citations.length,
      identifiers: identifiersSeen.size,
      sentences: sentences.length,
      clauses: clauseCount,
      claims: claimChecks,
    },
  };
}

module.exports = { auditAnswer, CHECK_NAME, CHECK_NOTE };
