// Query planning: intent, subject term, and the date window for a search.
// The user's time filter is preserved exactly. Only the "auto" setting infers a window from the question.

// Dates are computed in UTC so the current date (2026-10-24) and every window match across machines.
const USER_TIME_ZONE = "UTC";

const WINDOWS = {
  day: { code: "d", days: 1, label: "past day" },
  week: { code: "w", days: 7, label: "past week" },
  month: { code: "m", days: 31, label: "past month" },
  year: { code: "y", days: 365, label: "past year" },
};

const TODAY_RE = /\b(today|tonight|this morning|right now|just now)\b/i;
const WEEK_RE = /\b(this week|past week|last week|weekly)\b/i;
const RECENT_RE = /\b(latest|current|currently|recent|recently|newest|now|this month|news|breaking|up[- ]to[- ]date|new)\b/i;
const YEAR_RE = /\b(this year)\b/i;
const SECURITY_RE = /\b(cves?|vulnerab\w*|exploit\w*|advisor(?:y|ies)|patch(?:es|ed)?|zero[- ]day|kev|cvss|security|malware|ransomware|rce|xss|sqli)\b/i;

const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "by", "can", "could", "did", "do", "does", "for", "from",
  "has", "have", "how", "i", "if", "in", "is", "it", "its", "me", "of", "on", "or", "please", "should", "tell", "that",
  "the", "their", "there", "these", "this", "those", "to", "was", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "about", "latest", "current", "recent", "today", "now", "cve", "cves", "vulnerability",
  "vulnerabilities", "exploit", "exploits", "advisory", "advisories", "patch", "security", "status", "details", "info",
]);
const RUN_CONNECTORS = new Set(["for", "of", "and", "the", "in", "on", "&"]);

function todayIso(now = new Date(), timeZone = USER_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function shiftIso(now, days, timeZone = USER_TIME_ZONE) {
  return todayIso(new Date(now.getTime() - days * 24 * 60 * 60 * 1000), timeZone);
}

// Time window used for the search. requested: auto | any | day | week | month | year (anything else is "auto").
function resolveTimeWindow({ requested, query, now = new Date() }) {
  const value = String(requested || "auto").toLowerCase();
  const explicit = ["any", "day", "week", "month", "year"].includes(value);
  let key = null;
  let source = "none";
  if (explicit) {
    key = value === "any" ? null : value;
    source = value === "any" ? "explicit-any" : "explicit";
  } else {
    const text = String(query || "");
    if (TODAY_RE.test(text)) key = "day";
    else if (WEEK_RE.test(text)) key = "week";
    else if (YEAR_RE.test(text)) key = "year";
    else if (RECENT_RE.test(text)) key = "month";
    source = key ? "inferred" : "none";
  }
  const window = key ? WINDOWS[key] : null;
  return {
    requested: explicit ? value : "auto",
    applied: key,
    source,
    code: window ? window.code : null,
    label: window ? window.label : "no date filter",
    from: window ? shiftIso(now, window.days) : null,
    to: window ? todayIso(now) : null,
  };
}

function intentOf(query) {
  const text = String(query || "");
  return {
    current: TODAY_RE.test(text) || WEEK_RE.test(text) || RECENT_RE.test(text) || YEAR_RE.test(text),
    security: SECURITY_RE.test(text),
  };
}

// Words that describe a question rather than name a product. A single capitalised word from this list is never
// a subject ("Discovered exploits ...", "Cybersecurity news ..."). Inside a longer name they are kept
// ("News Kit Addons for Elementor"), so product names are not cut.
const DESCRIPTIVE_WORDS = new Set([
  "active", "actively", "attacks", "biggest", "big", "breaches", "common", "critical", "current", "cyber", "cybersecurity",
  "day", "days", "discovered", "disclosed", "exploitable", "exploited", "flaws", "high", "important", "incidents", "known",
  "latest", "major", "malware", "month", "new", "news", "notable", "popular", "public", "ransomware", "recent", "recently",
  "reported", "serious", "software", "systems", "threats", "today", "top", "updates", "patches", "advisories", "vulnerabilities",
  "vulnerable", "week", "worst", "year", "zero",
]);

// Question words that are never the first word of a product name. A capitalised one at the start of a run is skipped,
// so "Discovered PHP2Shell exploits" gives PHP2Shell. Words that can start a product name ("Active Directory", "News
// Kit") are deliberately not in this list.
const LEADING_QUESTION_WORDS = new Set([
  "actively", "discovered", "disclosed", "exploitable", "exploited", "latest", "newest", "newly", "popular", "recent",
  "recently", "reported", "current", "worst", "biggest",
]);

// A lowercase or mixed token that mixes letters and digits, such as "log4j" or "7zip". Plain numbers are not products.
const PRODUCT_LIKE = /^(?=.*[a-z])(?=.*\d)[a-z0-9][a-z0-9._+-]*$/i;

// The main subject of the question, or null when the question names no product or entity.
// Order: quoted text, then the longest run of capitalised or product-like words. Lowercase descriptive words are
// never used as a subject. A question such as "What are the latest discovered exploits?" has no subject, and the
// research then runs as a broad search without a product check.
function extractSubject(query) {
  const text = String(query || "").trim();
  const quoted = text.match(/[\"“]([^\"”]{2,80})[\"”]/);
  if (quoted) return { subject: quoted[1].trim(), method: "quoted" };

  const tokens = text.replace(/[?!.,;:()[\]{}\"“”']/g, " ").split(/\s+/).filter(Boolean);
  const isId = (token) => /^(CVE|EUVD|GHSA)-/i.test(token);
  const isSignal = (token) => {
    if (isId(token)) return false;
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower)) return false;
    return /^[A-Z]/.test(token) || PRODUCT_LIKE.test(token);
  };
  const runs = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isSignal(tokens[i])) continue;
    if (LEADING_QUESTION_WORDS.has(tokens[i].toLowerCase())) continue;
    const run = [tokens[i]];
    let j = i + 1;
    while (j < tokens.length) {
      if (isSignal(tokens[j])) {
        run.push(tokens[j]);
        j += 1;
      } else if (RUN_CONNECTORS.has(tokens[j].toLowerCase()) && j + 1 < tokens.length && isSignal(tokens[j + 1])) {
        run.push(tokens[j], tokens[j + 1]);
        j += 2;
      } else {
        break;
      }
    }
    // A lone descriptive word is not a name.
    if (!(run.length === 1 && DESCRIPTIVE_WORDS.has(run[0].toLowerCase()))) runs.push(run.join(" "));
    i = j - 1;
  }
  if (runs.length) {
    const longest = runs.reduce((best, run) => (run.split(" ").length > best.split(" ").length ? run : best));
    return { subject: longest, method: "named" };
  }
  return { subject: null, method: null };
}

module.exports = {
  USER_TIME_ZONE,
  WINDOWS,
  todayIso,
  resolveTimeWindow,
  intentOf,
  extractSubject,
  DESCRIPTIVE_WORDS,
};
