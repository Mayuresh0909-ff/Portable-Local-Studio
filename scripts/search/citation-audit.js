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
  versions: "affected-versions",
  published: "publication date",
  "article-date": "article date",
  severity: "severity",
  kev: "CISA KEV listing",
};

const CLAUSE_SPLIT = /;|,\s+(?:but|while|whereas|however|although|though|yet|and|so)\b|\b(?:but|while|whereas|however|although|though|yet)\b/i;
const SEGMENT_BOUNDARY = /[,;:(]|\b(?:and|but|while|whereas|however|although|though|yet|so|because)\b/i;

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

function mentionsWord(text, word) {
  if (!word) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`, "i").test(String(text || ""));
}

// Whether a finding carries the source fields this check needs. Older evidence shapes do not.
function hasProvenance(finding) {
  return Boolean(finding) && ("primarySource" in finding) && ("readSources" in finding) && ("exploitation" in finding);
}

// The source numbers that support one kind of claim about a finding. Only a source that actually provides the field
// counts. A primary record supports the identifier and, when verified, its product and versions. It does not
// support an exploitation claim, which needs the source that establishes the exploitation status.
function supportFor(finding, field) {
  const usable = (values) => values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
  const exploitation = finding.exploitation || {};
  const readSources = asArray(finding.readSources);
  switch (field) {
    case "identity":
      return usable([finding.primarySource, ...readSources, exploitation.source]);
    case "product":
      // A product is supported by a verified primary record, or by read sources whose sentences link the identifier to the subject.
      return usable(finding.status === "verified" ? [finding.primarySource, ...readSources] : readSources);
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

// The kinds of claim a clause makes about an identifier, besides its identity. Negated KEV mentions make no claim.
function fieldsIn(clause, subject) {
  const fields = new Set();
  if (mentionsWord(clause, subject)) fields.add("product");
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
        const fields = ["identity", ...fieldsIn(clause, finding.subject)];
        // A confirmed exploitation claim needs the source that establishes the exploitation status.
        if (positiveExploitation && isConfirmed(finding)) fields.push("exploitation");
        for (const field of fields) {
          // An unverified identifier is already reported by the status rule above. Only verified identities are checked here.
          if (field === "identity" && finding.status !== "verified") continue;
          if (field === "exploitation") {
            // Exploitation is supported only by the source that states it, which is not the identifier record.
            const exploitationSource = Number.isFinite(Number(finding.exploitation?.source)) ? [Number(finding.exploitation.source)] : [];
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
          const supported = supportFor(finding, field);
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
