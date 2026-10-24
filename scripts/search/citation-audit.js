// Checks an assistant answer against the research evidence it was given. These are deterministic checks on the
// text, not a judgement of whether a sentence is true. They catch:
//  - bracket citations that point at no source;
//  - identifiers that have no finding, or that are stated as fact without a verified finding;
//  - an EUVD identifier presented as the CVE with the same number;
//  - "actively exploited" claims that the exploitation status does not support.

const { extractIdentifiers } = require("./identifiers");
const { splitSentences } = require("./records");

const EXPLOITED_CLAIM = /\b(actively exploited|exploited in the wild|known exploited|being exploited|under active (?:attack|exploitation)|exploitation (?:is |has been )?(?:observed|detected|confirmed))\b/i;
const HEDGE = /\b(not|no|never|unverified|unconfirmed|reported|reportedly|claimed|allegedly|may|might|could|possibly|unclear|unknown|not verified|could not|cannot|couldn'?t|no evidence|not confirmed|not established|search result|mentioned|conflict|unavailable|not found|not checked)\b/i;
const CONFIRMED_EXPLOITATION = new Set(["kev-listed", "cisa-ssvc-active"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function auditAnswer(text, evidence = {}) {
  const answer = String(text || "");
  const sources = asArray(evidence.sources);
  const findings = asArray(evidence.findings);
  const indexes = new Set(sources.map((source) => Number(source.index)).filter(Number.isFinite));
  const issues = [];
  const add = (type, severity, detail, value = null) => issues.push({ type, severity, detail, value });

  // 1. Citation numbers must exist in the source list.
  const citations = [...answer.matchAll(/\[(\d{1,3})\](?!\()/g)].map((match) => Number(match[1]));
  for (const number of [...new Set(citations)]) {
    if (!indexes.has(number)) add("invalid-citation", "error", `[${number}] does not match any source in this answer's evidence.`, number);
  }

  // 2. Identifiers, by sentence.
  const findingFor = (id) => findings.find((finding) => finding.identifier === id) || null;
  const sentences = splitSentences(answer);
  const seenIds = new Set();
  for (const sentence of sentences) {
    const ids = extractIdentifiers(sentence);
    for (const item of ids) {
      if (seenIds.has(`${item.id}`)) continue;
      seenIds.add(item.id);
      const finding = findingFor(item.id);
      if (!finding) {
        add("identifier-not-in-findings", "warning", `${item.id} is not among the structured findings. Check its source before relying on it.`, item.id);
        continue;
      }
      if (finding.status !== "verified" && !HEDGE.test(sentence)) {
        add("unverified-identifier-stated", "error", `${item.id} is stated without a hedge, but its status is "${finding.status}".`, item.id);
      }
    }

    // 3. Exploitation claims.
    if (EXPLOITED_CLAIM.test(sentence) && !HEDGE.test(sentence)) {
      const named = ids.map((item) => findingFor(item.id)).filter(Boolean);
      const supported = named.length
        ? named.every((finding) => CONFIRMED_EXPLOITATION.has(finding.exploitation?.status))
        : findings.some((finding) => CONFIRMED_EXPLOITATION.has(finding.exploitation?.status));
      if (!supported) {
        add("exploitation-claim-not-confirmed", "error", "The answer says a vulnerability is actively exploited, but no finding has a confirmed exploitation status (CISA KEV or CISA SSVC active) for it.", sentence.slice(0, 160));
      }
    }
  }

  // 4. EUVD identifiers presented as CVE identifiers with the same number. EUVD identifiers come from the
  // findings and from the source list, so the check does not depend on a record having been read.
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
    issues,
    checked: { citations: citations.length, identifiers: seenIds.size, sentences: sentences.length },
  };
}

module.exports = { auditAnswer };
