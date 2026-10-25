// Parsers for primary records (structured JSON) and sentence-level facts from text pages.
// A parser returns only what the document states. Missing values stay null. Nothing is inferred.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// True when the year, month and day form a real calendar date (2026-02-30 does not).
function isCalendarDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Returns YYYY-MM-DD for a date the text states, or null. An impossible calendar date gives null.
function parseDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const iso = text.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isCalendarDate(candidate) ? candidate : null;
  }
  const named = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (named) {
    const month = MONTHS.indexOf(named[1].toLowerCase()) + 1;
    const candidate = `${named[3]}-${String(month).padStart(2, "0")}-${String(Number(named[2])).padStart(2, "0")}`;
    return isCalendarDate(candidate) ? candidate : null;
  }
  return null;
}

// A date that the document states but that is not a valid date (for example 2026-02-30). It is reported as
// malformed rather than dropped, so the evidence can say so.
function isMalformedDate(value) {
  const text = String(value || "").trim();
  return Boolean(text) && parseDate(text) === null && /\d{4}-\d{2}-\d{2}/.test(text);
}

function formatVersionEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const parts = [];
  if (entry.version && entry.version !== "unspecified") parts.push(String(entry.version));
  if (entry.lessThan) parts.push(`before ${entry.lessThan}`);
  if (entry.lessThanOrEqual) parts.push(`through ${entry.lessThanOrEqual}`);
  if (!parts.length) return null;
  return parts.join(" ");
}

const CVE_CVSS_KEYS = [["cvssV4_0", "CVSS v4.0"], ["cvssV3_1", "CVSS v3.1"], ["cvssV3_0", "CVSS v3.0"]];
const NVD_CVSS_KEYS = [["cvssMetricV40", "CVSS v4.0"], ["cvssMetricV31", "CVSS v3.1"], ["cvssMetricV30", "CVSS v3.0"]];

// CVSS as stated by the record. Score and severity are copied, never calculated.
function cvssFromCveMetrics(metrics) {
  for (const metric of Array.isArray(metrics) ? metrics : []) {
    for (const [key, label] of CVE_CVSS_KEYS) {
      const data = metric?.[key];
      if (data && data.baseScore !== undefined) {
        return { version: label, score: Number(data.baseScore), severity: data.baseSeverity || null };
      }
    }
  }
  return null;
}

function cvssFromNvdMetrics(metrics) {
  for (const [key, label] of NVD_CVSS_KEYS) {
    const data = metrics?.[key]?.[0]?.cvssData;
    if (data && data.baseScore !== undefined) {
      return { version: label, score: Number(data.baseScore), severity: data.baseSeverity || null };
    }
  }
  return null;
}

// A vendor or product name as the record gives it. Placeholders such as "n/a" mean no name, so they are dropped.
function cleanName(value) {
  const text = String(value || "").trim();
  if (!text || /^(?:n\/?a|none|unknown|null|-|\*)$/i.test(text)) return null;
  return text;
}

// CVE Services (CVE JSON 5.x) record. Accepts the record object as returned by the API.
function parseCveRecord(json) {
  if (!json || typeof json !== "object") return null;
  const meta = json.cveMetadata || {};
  const id = String(meta.cveId || "").toUpperCase();
  if (!id) return null;
  const cna = json.containers?.cna || {};
  const adps = Array.isArray(json.containers?.adp) ? json.containers.adp : [];
  const affected = (Array.isArray(cna.affected) ? cna.affected : []).map((item) => ({
    vendor: cleanName(item.vendor),
    product: cleanName(item.product),
    versions: (Array.isArray(item.versions) ? item.versions : []).map(formatVersionEntry).filter(Boolean),
  }));
  const description = (cna.descriptions || []).find((d) => /^en/i.test(d.lang || "en"))?.value || null;
  const allMetrics = [...(cna.metrics || []), ...adps.flatMap((adp) => adp.metrics || [])];
  // CISA's SSVC decision point (in an ADP container) states exploitation as none, poc or active.
  let ssvcExploitation = null;
  for (const metric of allMetrics) {
    if (metric?.other?.type !== "ssvc") continue;
    for (const option of metric.other.content?.options || []) {
      if (option && typeof option.Exploitation === "string") ssvcExploitation = option.Exploitation.toLowerCase();
    }
  }
  return {
    kind: "cve-record",
    id,
    state: meta.state || null,
    title: cna.title || null,
    description,
    products: affected,
    productNames: affected.flatMap((item) => [item.vendor, item.product]).filter(Boolean),
    published: parseDate(meta.datePublished),
    publishedMalformed: isMalformedDate(meta.datePublished),
    updated: parseDate(meta.dateUpdated),
    cvss: cvssFromCveMetrics(allMetrics),
    ssvcExploitation,
    references: (cna.references || []).map((ref) => ref.url).filter(Boolean),
  };
}

// NVD REST 2.0 response for cveId=... Returns the first matching vulnerability, or null.
function parseNvdResponse(json) {
  const item = Array.isArray(json?.vulnerabilities) ? json.vulnerabilities[0]?.cve : null;
  if (!item || !item.id) return null;
  const description = (item.descriptions || []).find((d) => /^en/i.test(d.lang || "en"))?.value || null;
  const cpeRanges = [];
  const productNames = [];
  for (const config of item.configurations || []) {
    for (const node of config.nodes || []) {
      for (const match of node.cpeMatch || []) {
        if (!match.vulnerable) continue;
        const parts = String(match.criteria || "").split(":");
        const vendor = cleanName(parts[3] && parts[3] !== "*" ? parts[3] : null);
        const product = cleanName(parts[4] && parts[4] !== "*" ? parts[4] : null);
        if (vendor) productNames.push(vendor);
        if (product) productNames.push(product);
        const range = [];
        if (match.versionStartIncluding) range.push(`from ${match.versionStartIncluding}`);
        if (match.versionStartExcluding) range.push(`after ${match.versionStartExcluding}`);
        if (match.versionEndIncluding) range.push(`through ${match.versionEndIncluding}`);
        if (match.versionEndExcluding) range.push(`before ${match.versionEndExcluding}`);
        const version = parts[5] && parts[5] !== "*" ? parts[5] : null;
        if (version) range.push(version);
        cpeRanges.push({ vendor, product, version: range.join(", ") || null });
      }
    }
  }
  const uniqueProducts = [...new Set(productNames)];
  return {
    kind: "nvd",
    id: String(item.id).toUpperCase(),
    state: item.vulnStatus || null,
    title: null,
    description,
    products: cpeRanges.map((range) => ({ vendor: range.vendor, product: range.product, versions: range.version ? [range.version] : [] })),
    productNames: uniqueProducts,
    published: parseDate(item.published),
    publishedMalformed: isMalformedDate(item.published),
    updated: parseDate(item.lastModified),
    cvss: cvssFromNvdMetrics(item.metrics || {}),
    ssvcExploitation: null,
    references: (item.references || []).map((ref) => ref.url).filter(Boolean),
  };
}

// CISA Known Exploited Vulnerabilities catalogue. Returns Map(cveId -> entry).
function parseKevCatalog(json) {
  const map = new Map();
  for (const item of Array.isArray(json?.vulnerabilities) ? json.vulnerabilities : []) {
    const id = String(item.cveID || "").toUpperCase();
    if (!/^CVE-\d{4}-\d{4,7}$/.test(id)) continue;
    map.set(id, {
      id,
      vendorProject: item.vendorProject || null,
      product: item.product || null,
      name: item.vulnerabilityName || null,
      dateAdded: parseDate(item.dateAdded),
      dueDate: parseDate(item.dueDate),
      ransomware: item.knownRansomwareCampaignUse || null,
    });
  }
  return map;
}

// Splits text into sentences. Line breaks also end a sentence.
function splitSentences(text) {
  return String(text || "")
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

const NEGATED_EXPLOITATION = /\b(no|not|without|none|never)\b[^.]{0,60}\b(exploit\w*|evidence)\b|\bno (known|public|reported) (exploit|attack)/i;
const ACTIVE_EXPLOITATION = /\b(actively exploited|exploited in the wild|known to be exploited|exploitation (?:is |has been )?(?:observed|detected|confirmed)|under active exploitation|being exploited)\b/i;
const PUBLIC_POC = /\b(proof[- ]of[- ]concept|PoC|public exploit|exploit code (?:is |has been )?(?:published|available|released)|exploit (?:is |has been )?(?:published|available|released))\b/i;

// Sentence-level exploitation statement. Negated statements win over positive ones.
function exploitationStatement(sentence) {
  if (NEGATED_EXPLOITATION.test(sentence)) return "no-exploitation-stated";
  if (ACTIVE_EXPLOITATION.test(sentence)) return "reported-exploited";
  if (PUBLIC_POC.test(sentence)) return "public-poc-reported";
  return null;
}

// Severity wording a text states explicitly. Never computed.
function severityStatement(sentence) {
  const cvss = sentence.match(/\bCVSS(?:\s*v?(\d(?:\.\d)?))?[^0-9.]{0,25}(\d{1,2}\.\d)/i);
  if (cvss) return { value: `CVSS ${cvss[1] ? `v${cvss[1]} ` : ""}${cvss[2]}`, basis: "stated" };
  const word = sentence.match(/\b(critical|high|medium|low)\s+(?:severity|risk)\b/i) || sentence.match(/\bseverity[^.]{0,20}\b(critical|high|medium|low)\b/i);
  if (word) return { value: `${word[1][0].toUpperCase()}${word[1].slice(1).toLowerCase()} severity`, basis: "stated" };
  return null;
}

// Facts from a text page (EUVD, GHSA, advisory, news). Returns sentence-level data only.
function parsePageText(text, title = "") {
  const sentences = splitSentences(text);
  const dateMatch = String(text || "").match(/\b(?:published|date published|posted|first published)\b[^.\n]{0,25}?(\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i);
  const updatedMatch = String(text || "").match(/\b(?:updated|last modified|modified|last updated)\b[^.\n]{0,25}?(\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i);
  return {
    title: String(title || "").trim() || null,
    sentences,
    published: dateMatch ? parseDate(dateMatch[1]) : null,
    publishedMalformed: dateMatch ? isMalformedDate(dateMatch[1]) : false,
    updated: updatedMatch ? parseDate(updatedMatch[1]) : null,
  };
}

module.exports = {
  parseDate,
  parseCveRecord,
  parseNvdResponse,
  parseKevCatalog,
  parsePageText,
  splitSentences,
  exploitationStatement,
  severityStatement,
};
