// Source hierarchy. The tier decides which pages can establish a fact and which can only corroborate it.
//
//   primary        CVE record, NVD record, CISA KEV catalogue, EUVD record, GitHub security advisory.
//                  These can verify an identifier, its product and its affected versions.
//   advisory-page  A page whose URL looks like a security advisory on a host that is not known to be a
//                  primary record source. Publisher is not verified, so it corroborates but never verifies.
//   secondary      Known security news, research or aggregator sites. Corroboration only.
//   web            Anything else. Corroboration only, lowest priority for fetching.
//
// Search snippets are not a tier. They are never evidence.

const TIER_RANK = { primary: 0, "advisory-page": 1, secondary: 2, web: 3 };

const SECONDARY_HOSTS = [
  "wordfence.com", "patchstack.com", "wpscan.com", "bleepingcomputer.com", "thehackernews.com",
  "securityweek.com", "securityaffairs.com", "tenable.com", "rapid7.com", "cvedetails.com",
  "vulners.com", "cybersecuritynews.com", "helpnetsecurity.com",
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch (_) {
    return "";
  }
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function classifySource(url, title = "") {
  const host = hostOf(url);
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch (_) {}
  if (!host) return { tier: "web", type: "unknown" };

  if (hostMatches(host, "cve.org") || host === "cveawg.mitre.org" || hostMatches(host, "cve.mitre.org")) {
    return { tier: "primary", type: "cve-record" };
  }
  if (hostMatches(host, "nvd.nist.gov")) return { tier: "primary", type: "nvd" };
  if (hostMatches(host, "cisa.gov") && /known[-_]exploited|known_exploited/.test(path)) {
    return { tier: "primary", type: "cisa-kev" };
  }
  if (hostMatches(host, "euvd.enisa.europa.eu")) return { tier: "primary", type: "euvd" };
  if (hostMatches(host, "github.com") && /^\/(advisories\/ghsa-|[^/]+\/[^/]+\/security\/advisories\/)/.test(path)) {
    return { tier: "primary", type: "project-advisory" };
  }
  if (SECONDARY_HOSTS.some((domain) => hostMatches(host, domain))) return { tier: "secondary", type: "security-news" };
  if (/\/(security|advisor(y|ies)|vulnerabilit(y|ies)|cve)(\/|-|$|\.)/.test(path) || /advisory|security-update/i.test(String(title))) {
    return { tier: "advisory-page", type: "advisory-page" };
  }
  return { tier: "web", type: "web" };
}

function isPrimaryType(type) {
  return ["cve-record", "nvd", "cisa-kev", "euvd", "project-advisory"].includes(type);
}

module.exports = {
  TIER_RANK,
  classifySource,
  hostOf,
  isPrimaryType,
};
