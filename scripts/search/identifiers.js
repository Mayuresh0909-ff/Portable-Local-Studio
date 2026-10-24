// Vulnerability identifier extraction. Each identifier family has its own pattern and its own type.
// An EUVD identifier is never rewritten as a CVE identifier, and a CVE pattern cannot match inside an EUVD
// token because the lookbehind rejects a preceding letter, digit, underscore or hyphen.

const CVE_PATTERN = /(?<![A-Za-z0-9_-])CVE-(\d{4})-(\d{4,7})(?![0-9])/gi;
const EUVD_PATTERN = /(?<![A-Za-z0-9_-])EUVD-(\d{4})-(\d{3,7})(?![0-9])/gi;
const GHSA_PATTERN = /(?<![A-Za-z0-9_-])GHSA-([a-z0-9]{4})-([a-z0-9]{4})-([a-z0-9]{4})(?![A-Za-z0-9])/gi;

function canonicalIdentifier(raw) {
  const value = String(raw || "").trim();
  if (/^CVE-\d{4}-\d{4,7}$/i.test(value)) return value.toUpperCase();
  if (/^EUVD-\d{4}-\d{3,7}$/i.test(value)) return value.toUpperCase();
  if (/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(value)) return `GHSA-${value.slice(5).toLowerCase()}`;
  return "";
}

function identifierType(id) {
  const value = String(id || "").toUpperCase();
  if (value.startsWith("CVE-")) return "cve";
  if (value.startsWith("EUVD-")) return "euvd";
  if (value.startsWith("GHSA-")) return "ghsa";
  return "";
}

// Returns identifiers in order of first appearance: [{ type, id, index }].
function extractIdentifiers(text) {
  const value = String(text || "");
  const found = [];
  for (const [pattern, type] of [[CVE_PATTERN, "cve"], [EUVD_PATTERN, "euvd"], [GHSA_PATTERN, "ghsa"]]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value))) {
      const id = type === "cve" ? `CVE-${match[1]}-${match[2]}`
        : type === "euvd" ? `EUVD-${match[1]}-${match[2]}`
        : `GHSA-${match[1]}-${match[2]}-${match[3]}`.toLowerCase().replace(/^ghsa/, "GHSA");
      found.push({ type, id, index: match.index });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set();
  return found.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function uniqueIds(text, type) {
  return extractIdentifiers(text).filter((item) => !type || item.type === type).map((item) => item.id);
}

module.exports = {
  canonicalIdentifier,
  identifierType,
  extractIdentifiers,
  uniqueIds,
};
