// Deterministic consistency check of an assistant answer against the research evidence it was given.
//
// This is a text check, not a judgement of truth. It cannot tell whether a sentence is correct. It catches:
//  - bracket citations that point at no source;
//  - identifiers stated without a hedge when their finding is not verified;
//  - "actively exploited" claims that the exploitation status does not support, including generic claims that
//    cover several findings when only some of them are confirmed;
//  - an EUVD identifier presented as the CVE with the same number.
//
// How it reads the answer:
//  - Each sentence is split into clauses at ';', at a comma before a contrast or conjunction ("but", "and"), and
//    at contrast words ("but", "while", "however"). Every clause is checked, so a hedge in one clause does not
//    cancel an assertion in another.
//  - A hedge only applies to the words between the last boundary and the claim (for exploitation claims), or to
//    the clause (for unverified identifiers).
//  - A claim with no identifier in its clause takes the identifiers of its sentence. A claim with no identifier
//    anywhere is a generic claim and needs every finding to be confirmed.

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

function auditAnswer(text, evidence = {}) {
  const answer = String(text || "");
  const sources = asArray(evidence.sources);
  const findings = asArray(evidence.findings);
  const indexes = new Set(sources.map((source) => Number(source.index)).filter(Number.isFinite));
  const issues = [];
  const reported = new Set();
  const add = (type, severity, detail, value = null) => {
    const key = `${type}|${value === null ? detail : value}`;
    if (reported.has(key)) return;
    reported.add(key);
    issues.push({ type, severity, detail, value });
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

  for (const sentence of sentences) {
    const sentenceIds = uniqueIds(extractIdentifiers(sentence));
    for (const id of sentenceIds) identifiersSeen.add(id);

    for (const clause of splitClauses(sentence)) {
      clauseCount += 1;
      const clauseIds = uniqueIds(extractIdentifiers(clause));

      // 2. Identifier mentions: every mention in every clause is checked.
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
      for (const match of clause.matchAll(EXPLOITED_CLAIM)) {
        if (SCOPED_HEDGE.test(segmentBefore(clause, match.index))) continue;

        // Identifiers this claim is about: the clause's own, or the sentence's when the clause names none.
        const named = clauseIds.length ? clauseIds : sentenceIds;
        if (named.length) {
          const unsupported = named.filter((id) => !isConfirmed(findingFor(id)));
          if (unsupported.length) {
            add("exploitation-claim-not-confirmed", "error",
              `The answer says ${unsupported.join(", ")} is actively exploited, but no confirmed exploitation status (CISA KEV or CISA SSVC active) supports that. A public proof of concept or a search result is not exploitation.`,
              clause.slice(0, 160));
          }
        } else {
          // A generic claim covers every finding, so one confirmed finding is not enough.
          const allConfirmed = findings.length > 0 && findings.every((finding) => isConfirmed(finding));
          if (!allConfirmed) {
            add("generic-exploitation-claim", "error",
              "The answer makes a general claim that some vulnerabilities are actively exploited, but not every finding is confirmed. Name the identifiers and their statuses instead.",
              clause.slice(0, 160));
          }
        }
      }
    }
  }

  // 4. EUVD identifiers presented as CVE identifiers with the same number. EUVD identifiers come from the findings
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
    checked: { citations: citations.length, identifiers: identifiersSeen.size, sentences: sentences.length, clauses: clauseCount },
  };
}

module.exports = { auditAnswer, CHECK_NAME, CHECK_NOTE };
