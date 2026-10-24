// Source hierarchy. The tier decides which pages can establish a fact and which can only corroborate it.
//
//   primary        CVE record, NVD record, CISA KEV catalogue, EUVD record, GitHub security advisory,
//                  or a page on the explicit VENDOR_ADVISORY_SOURCES list below.
//                  These can verify an identifier, its product and its affected versions, but only when the
//                  page text itself names the identifier and the subject. Being in this tier is not verification.
//   advisory-page  A page whose URL looks like a security advisory on a host that is not known to be a
//                  primary record source. Publisher is not verified, so it corroborates but never verifies.
//   secondary      Known security news, research or aggregator sites. Corroboration only.
//   web            Anything else. Corroboration only, lowest priority for fetching.
//
// Search snippets are not a tier. They are never evidence.

const TIER_RANK = { primary: 0, "advisory-page": 1, secondary: 2, web: 3 };

// Vendor and project security-advisory areas. Each entry is a host and an optional path prefix, and each is the
// publisher's own advisory area. Anything not listed here stays a corroborating source, even if its URL contains
// "security", "advisory" or "CVE". Add an entry only after checking that the path is the publisher's advisory area.
const VENDOR_ADVISORY_SOURCES = [
  { host: "msrc.microsoft.com", path: "/update-guide/", type: "vendor-advisory", name: "Microsoft Security Response Center" },
  { host: "security.paloaltonetworks.com", path: "/", type: "vendor-advisory", name: "Palo Alto Networks PSIRT" },
  { host: "sec.cloudapps.cisco.com", path: "/security/center/", type: "vendor-advisory", name: "Cisco PSIRT" },
  { host: "access.redhat.com", path: "/security/", type: "vendor-advisory", name: "Red Hat security" },
  { host: "ubuntu.com", path: "/security/", type: "vendor-advisory", name: "Ubuntu security notices" },
  { host: "security-tracker.debian.org", path: "/", type: "vendor-advisory", name: "Debian security tracker" },
  { host: "httpd.apache.org", path: "/security/", type: "project-advisory", name: "Apache HTTP Server security" },
  { host: "www.oracle.com", path: "/security-alerts/", type: "vendor-advisory", name: "Oracle security alerts" },
  { host: "www.fortiguard.com", path: "/psirt/", type: "vendor-advisory", name: "Fortinet PSIRT" },
  { host: "chromereleases.googleblog.com", path: "/", type: "vendor-advisory", name: "Chrome releases" },
  { host: "www.cisa.gov", path: "/news-events/ics-advisories/", type: "cisa-advisory", name: "CISA ICS advisories" },
];

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
  for (const entry of VENDOR_ADVISORY_SOURCES) {
    if (hostMatches(host, entry.host) && path.startsWith(entry.path)) return { tier: "primary", type: entry.type };
  }
  if (SECONDARY_HOSTS.some((domain) => hostMatches(host, domain))) return { tier: "secondary", type: "security-news" };
  if (/\/(security|advisor(y|ies)|vulnerabilit(y|ies)|cve)(\/|-|$|\.)/.test(path) || /advisory|security-update/i.test(String(title))) {
    return { tier: "advisory-page", type: "advisory-page" };
  }
  return { tier: "web", type: "web" };
}

function isPrimaryType(type) {
  return ["cve-record", "nvd", "cisa-kev", "euvd", "project-advisory", "vendor-advisory", "cisa-advisory"].includes(type);
}

module.exports = {
  TIER_RANK,
  VENDOR_ADVISORY_SOURCES,
  classifySource,
  hostOf,
  isPrimaryType,
};
