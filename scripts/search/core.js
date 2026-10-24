const path = require("path");
const { webSearch } = require("./providers");
const { fetchPageContent, fetchRawDocument } = require("./content");
const { readCache, writeCache } = require("./cache");
const { classifySource, TIER_RANK } = require("./sources");
const { extractIdentifiers } = require("./identifiers");
const { parseCveRecord, parseNvdResponse, parseKevCatalog, parsePageText, splitSentences } = require("./records");
const { buildFindings, mentionsSubject } = require("./evidence");
const { resolveTimeWindow, intentOf, extractSubject, todayIso, USER_TIME_ZONE } = require("./planner");
const { buildContext } = require("./context");

// Bump when the evidence rules change so cached results from an older pipeline are not reused.
const PIPELINE_VERSION = 3;
const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const KEV_TTL_MS = 6 * 60 * 60 * 1000;
const KEV_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_CACHE_DIR = () => path.join(process.cwd(), "app", "cache", "search");

// Defaults and hard limits. Requests are clamped to these, so no caller can make the research unbounded.
const LIMITS = {
  resultLimit: { default: 5, min: 1, max: 8 },
  fetchLimit: { default: 3, min: 0, max: 6 },        // pages read from search results
  maxSearches: { default: 3, min: 1, max: 4 },       // all search requests, including the first
  maxFetches: { default: 12, min: 1, max: 14 },      // every network read: pages, records, KEV
  maxLookups: { default: 4, min: 0, max: 6 },        // identifiers that get a primary-record lookup
  maxFindings: { default: 8, min: 1, max: 12 },
  maxContextChars: { default: 12000, min: 4000, max: 24000 },
  contentChars: { default: 2200, min: 500, max: 6000 },
  totalTimeoutMs: { default: 45000, min: 5000, max: 90000 },
};

function clampOption(name, value) {
  const rule = LIMITS[name];
  const number = Number(value);
  if (!Number.isFinite(number)) return rule.default;
  return Math.max(rule.min, Math.min(rule.max, Math.round(number)));
}

function resolveConfig(options) {
  const config = {};
  for (const name of Object.keys(LIMITS)) config[name] = clampOption(name, options[name]);
  return config;
}

function truncate(text, max) {
  const value = String(text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 20)).trim()} ...[truncated]`;
}

// Sentences that name the subject or an identifier come first, so the excerpt shows the relevant text.
function excerptFor(text, maxChars, subject) {
  const sentences = splitSentences(text);
  const relevant = sentences.filter((sentence) => (subject && mentionsSubject(sentence, subject)) || extractIdentifiers(sentence).length);
  const lead = sentences.slice(0, 6);
  const combined = [...new Set([...relevant, ...lead])].join("\n");
  return truncate(combined, maxChars);
}

function isBlockedError(message) {
  return /blocked|Private network|Localhost|Only HTTP/i.test(String(message || ""));
}

function createState({ cfg, deps, cacheDir, now }) {
  return {
    cfg,
    deps,
    cacheDir,
    now,
    deadline: Date.now() + cfg.totalTimeoutMs,
    searches: [],
    searchesUsed: 0,
    fetchesUsed: 0,
    pageReadsFromSearch: 0,
    pagesRead: 0,
    lookupCount: 0,
    timedOut: false,
    registry: [],
    byUrl: new Map(),
    lookups: new Map(),
    kev: null,
    limitations: [],
    searchError: null,
  };
}

function timeLeft(state) {
  const left = state.deadline - Date.now();
  if (left <= 0) state.timedOut = true;
  return left > 0;
}

// Synchronous budget check. It runs before any await, so parallel work cannot overspend.
function takeFetch(state, { fromSearch = false } = {}) {
  if (!timeLeft(state)) return { ok: false, reason: "time limit reached" };
  if (state.fetchesUsed >= state.cfg.maxFetches) return { ok: false, reason: "fetch limit reached" };
  if (fromSearch && state.pageReadsFromSearch >= state.cfg.fetchLimit) return { ok: false, reason: "page read limit reached" };
  state.fetchesUsed += 1;
  if (fromSearch) state.pageReadsFromSearch += 1;
  return { ok: true };
}

function registerSource(state, { url, title = "", snippet = "", origin, provider = "duckduckgo", fetchStatus = "search-only", error = "", record = null, page = null, typeOverride = null, tierOverride = null }) {
  const existing = state.byUrl.get(url);
  if (existing && origin === "search") return existing;
  const classified = classifySource(url, title);
  const source = {
    index: state.registry.length + 1,
    url,
    title,
    snippet,
    origin,
    provider,
    tier: tierOverride || classified.tier,
    sourceType: typeOverride || classified.type,
    fetchStatus,
    error,
    record,
    page,
    excerpt: "",
    published: record?.published || page?.published || null,
    updated: record?.updated || page?.updated || null,
  };
  state.registry.push(source);
  state.byUrl.set(url, source);
  return source;
}

async function searchOnce(state, query, purpose, window) {
  if (state.searchesUsed >= state.cfg.maxSearches) return null;
  if (!timeLeft(state)) return null;
  state.searchesUsed += 1;
  try {
    const results = await state.deps.webSearch(query, {
      limit: state.cfg.resultLimit,
      timeFilter: window.applied || "any",
    });
    state.searches.push({ query, purpose, window: window.label, results: results.length, error: null });
    const added = [];
    for (const result of results) {
      if (!result.url) continue;
      const source = state.byUrl.get(result.url) || registerSource(state, {
        url: result.url,
        title: result.title || "",
        snippet: result.snippet || "",
        origin: "search",
        provider: result.provider || "duckduckgo",
      });
      added.push(source);
    }
    return added;
  } catch (err) {
    const message = err?.message || String(err);
    state.searches.push({ query, purpose, window: window.label, results: 0, error: message });
    state.searchError = state.searchError || message;
    return null;
  }
}

async function readPage(state, source, subject) {
  const budget = takeFetch(state, { fromSearch: true });
  if (!budget.ok) {
    source.fetchStatus = "skipped";
    source.error = budget.reason;
    return;
  }
  try {
    const page = await state.deps.fetchPage(source.url, {
      timeoutMs: state.cfg.timeoutMs,
      maxBytes: 768 * 1024,
    });
    const parsed = parsePageText(page.text, page.title);
    source.page = parsed;
    source.title = page.title || source.title;
    source.published = parsed.published;
    source.updated = parsed.updated;
    source.excerpt = excerptFor(page.text, state.cfg.contentChars, subject);
    source.fetchStatus = "fetched";
    source.error = "";
    state.pagesRead += 1;
  } catch (err) {
    source.fetchStatus = isBlockedError(err?.message) ? "blocked" : "failed";
    source.error = err?.message || String(err);
  }
}

// Fetches a structured primary record. Returns { ok, json, notFound, error }.
async function fetchPrimaryJson(state, url) {
  const budget = takeFetch(state);
  if (!budget.ok) return { ok: false, notFound: false, error: budget.reason };
  try {
    const doc = await state.deps.fetchRaw(url, { timeoutMs: state.cfg.timeoutMs, maxBytes: 1024 * 1024 });
    return { ok: true, json: JSON.parse(doc.body), notFound: false, error: "" };
  } catch (err) {
    const message = err?.message || String(err);
    return { ok: false, notFound: /HTTP 404/.test(message), error: message };
  }
}

function lookupEntry(state, id) {
  if (!state.lookups.has(id)) state.lookups.set(id, { attempts: [], record: null, notFound: false });
  return state.lookups.get(id);
}

// First attempt for a CVE identifier: the CVE Services record.
async function lookupCveRecord(state, id) {
  const entry = lookupEntry(state, id);
  if (entry.record || entry.attempted) return;
  // The lookup cap is for the whole request, not for each round of gathering.
  if (state.lookupCount >= state.cfg.maxLookups) return;
  entry.attempted = true;
  state.lookupCount += 1;
  const url = `https://cveawg.mitre.org/api/cve/${id}`;
  const result = await fetchPrimaryJson(state, url);
  const record = result.ok ? parseCveRecord(result.json) : null;
  if (record && record.id === id) {
    const source = registerSource(state, {
      url, title: `${id} - CVE record`, origin: "lookup", fetchStatus: "fetched", record,
      typeOverride: "cve-record", tierOverride: "primary",
    });
    entry.attempts.push({ ok: true, sourceIndex: source.index });
    entry.record = record;
    return;
  }
  if (result.notFound) entry.notFound = true;
  const source = registerSource(state, {
    url, title: `${id} - CVE record`, origin: "lookup",
    fetchStatus: result.notFound ? "not-found" : "failed", error: result.error || "no matching record",
    typeOverride: "cve-record", tierOverride: "primary",
  });
  entry.attempts.push({ ok: false, notFound: Boolean(result.notFound), sourceIndex: source.index, error: result.error || "no matching record" });
}

// Fallback for a CVE identifier whose CVE Services record could not be read: NVD by identifier.
async function lookupNvdRecord(state, id) {
  const entry = lookupEntry(state, id);
  if (entry.record || entry.nvdAttempted) return;
  entry.nvdAttempted = true;
  const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(id)}`;
  const result = await fetchPrimaryJson(state, url);
  const record = result.ok ? parseNvdResponse(result.json) : null;
  if (record && record.id === id) {
    const source = registerSource(state, {
      url, title: `${id} - NVD record`, origin: "lookup", fetchStatus: "fetched", record,
      typeOverride: "nvd", tierOverride: "primary",
    });
    entry.attempts.push({ ok: true, sourceIndex: source.index });
    entry.record = record;
    entry.notFound = false;
    return;
  }
  // NVD answered without a matching record: that is a "not found", not a failure.
  if (result.ok) entry.notFound = true;
  if (result.notFound) entry.notFound = true;
  const source = registerSource(state, {
    url, title: `${id} - NVD record`, origin: "lookup",
    fetchStatus: result.ok ? "not-found" : (result.notFound ? "not-found" : "failed"),
    error: result.error || "", typeOverride: "nvd", tierOverride: "primary",
  });
  entry.attempts.push({ ok: false, notFound: Boolean(result.ok || result.notFound), sourceIndex: source.index, error: result.error || "no matching record" });
}

async function loadKev(state) {
  if (state.kev) return state.kev;
  const cached = readCache(state.cacheDir, "cisa-kev-catalogue-v1", KEV_TTL_MS);
  if (cached && Array.isArray(cached.entries)) {
    const source = registerSource(state, {
      url: KEV_URL, title: "CISA Known Exploited Vulnerabilities catalogue (cached)", origin: "lookup",
      fetchStatus: "fetched", typeOverride: "cisa-kev", tierOverride: "primary",
    });
    state.kev = { status: "ok", map: new Map(cached.entries.map((entry) => [entry.id, entry])), sourceIndex: source.index };
    return state.kev;
  }
  const budget = takeFetch(state);
  if (!budget.ok) {
    state.kev = { status: "skipped", error: budget.reason };
    return state.kev;
  }
  try {
    const doc = await state.deps.fetchRaw(KEV_URL, { timeoutMs: 15000, maxBytes: KEV_MAX_BYTES, hardMaxBytes: KEV_MAX_BYTES });
    const map = parseKevCatalog(JSON.parse(doc.body));
    const source = registerSource(state, {
      url: KEV_URL, title: "CISA Known Exploited Vulnerabilities catalogue", origin: "lookup",
      fetchStatus: "fetched", typeOverride: "cisa-kev", tierOverride: "primary",
    });
    writeCache(state.cacheDir, "cisa-kev-catalogue-v1", { entries: [...map.values()], fetchedAt: new Date().toISOString() });
    state.kev = { status: "ok", map, sourceIndex: source.index };
  } catch (err) {
    const source = registerSource(state, {
      url: KEV_URL, title: "CISA Known Exploited Vulnerabilities catalogue", origin: "lookup",
      fetchStatus: "failed", error: err?.message || String(err), typeOverride: "cisa-kev", tierOverride: "primary",
    });
    state.kev = { status: "unavailable", error: err?.message || String(err), sourceIndex: source.index };
  }
  return state.kev;
}

// Identifiers worth a primary lookup: CVE identifiers in search titles or snippets that mention the subject,
// or in read sentences that name it. Without a subject, every search identifier is a candidate.
function lookupCandidates(state, subject) {
  const counts = new Map();
  for (const source of state.registry) {
    if (source.origin !== "search") continue;
    const text = [source.title, source.snippet].filter(Boolean).join(" \n ");
    if (subject && !mentionsSubject(text, subject)) continue;
    for (const item of extractIdentifiers(text)) {
      if (item.type === "cve") counts.set(item.id, (counts.get(item.id) || 0) + 1);
    }
  }
  for (const source of state.registry) {
    if (source.fetchStatus !== "fetched" || !source.page) continue;
    for (const sentence of source.page.sentences) {
      if (!subject || !mentionsSubject(sentence, subject)) continue;
      for (const item of extractIdentifiers(sentence)) {
        if (item.type === "cve") counts.set(item.id, (counts.get(item.id) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id)
    .filter((id) => !state.lookups.has(id));
}

// One round of work for the sources and identifiers collected so far. Order matters for the budget:
// CVE records first, then CISA KEV, then page reads, then NVD fallbacks for records that could not be read.
async function gather(state, subject) {
  // 1. Primary CVE records for identifiers seen in search results.
  for (const id of lookupCandidates(state, subject).slice(0, state.cfg.maxLookups)) {
    if (!timeLeft(state)) break;
    await lookupCveRecord(state, id);
  }

  // 2. CISA KEV, when a CVE identifier is in play.
  const hasCve = state.lookups.size > 0 || anyCve(state.registry.filter((source) => source.origin === "search"));
  if (hasCve && timeLeft(state)) await loadKev(state);

  // 3. Search results that have not been read, in source-tier order.
  const pending = state.registry
    .filter((source) => source.origin === "search" && source.fetchStatus === "search-only")
    .sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (a.index - b.index));
  const pageReads = [];
  for (const source of pending) {
    if (state.pageReadsFromSearch >= state.cfg.fetchLimit) break;
    if (!timeLeft(state)) break;
    pageReads.push(readPage(state, source, subject));
  }
  await Promise.allSettled(pageReads);

  // 4. Identifiers that only appear in the pages just read still need a primary record.
  for (const id of lookupCandidates(state, subject).slice(0, state.cfg.maxLookups)) {
    if (!timeLeft(state)) break;
    await lookupCveRecord(state, id);
  }

  // 5. NVD fallback, last, for records that could not be read from CVE Services.
  for (const id of [...state.lookups.keys()]) {
    if (!timeLeft(state)) break;
    const entry = state.lookups.get(id);
    if (entry.record || entry.notFound) continue;
    await lookupNvdRecord(state, id);
  }
}

function anyCve(sources) {
  return sources.some((source) => extractIdentifiers(`${source.title || ""} ${source.snippet || ""}`).some((item) => item.type === "cve"));
}

function publicSource(source) {
  return {
    index: source.index,
    title: source.title || source.url,
    url: source.url,
    snippet: source.snippet || "",
    provider: source.provider,
    origin: source.origin,
    tier: source.tier,
    sourceType: source.sourceType,
    fetched: source.fetchStatus === "fetched",
    fetchStatus: source.fetchStatus,
    error: source.error || "",
    published: source.published,
    updated: source.updated,
    excerpt: source.excerpt ? truncate(source.excerpt, 280) : "",
  };
}

// Public entry point. Never throws for a search or fetch failure: the failure is reported in research.error or
// in the source's fetchStatus, so the chat can continue and say what was not checked.
async function comprehensiveWebSearch(query, options = {}) {
  const trimmed = String(query || "").trim();
  const now = typeof options.now === "function" ? options.now() : new Date();
  const cfg = resolveConfig(options);
  const window = resolveTimeWindow({ requested: options.timeFilter, query: trimmed, now });
  if (!trimmed) {
    return { query: trimmed, context: "", sources: [], findings: [], research: null, cached: false };
  }

  const subjectInfo = extractSubject(trimmed);
  const intent = intentOf(trimmed);
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR();
  const cacheKey = JSON.stringify({
    v: PIPELINE_VERSION,
    query: trimmed,
    cfg,
    date: todayIso(now),
    window: window.applied,
    windowSource: window.source,
    subject: subjectInfo.subject,
  });
  if (!options.noCache) {
    const cached = readCache(cacheDir, cacheKey, options.ttlMs);
    if (cached) return { ...cached, cached: true };
  }

  const deps = {
    webSearch: options.deps?.webSearch || webSearch,
    fetchPage: options.deps?.fetchPage || fetchPageContent,
    fetchRaw: options.deps?.fetchRaw || fetchRawDocument,
  };
  const state = createState({ cfg, deps, cacheDir, now });
  const subject = subjectInfo.subject;

  // Search 1: the question as asked.
  await searchOnce(state, trimmed, "question", window);

  // Search 2: for security questions with no identifier in the results, look for the identifiers of the subject.
  if (intent.security && subject && !anyCve(state.registry.filter((s) => s.origin === "search"))) {
    const discovery = `${subject} CVE vulnerability`;
    if (discovery.toLowerCase() !== trimmed.toLowerCase()) await searchOnce(state, discovery, "identifier discovery", window);
  }

  await gather(state, subject);

  let findings = buildFindings({ subject, sources: state.registry, lookups: state.lookups, kev: state.kev, maxFindings: cfg.maxFindings });

  // Search 3: one more search for a candidate identifier that is still not verified.
  if (intent.security && subject && state.searchesUsed < cfg.maxSearches && timeLeft(state)) {
    const unresolved = findings.find((finding) => finding.identifierType === "cve" && finding.status !== "verified" && finding.searchSources.length && !state.searches.some((s) => s.query.includes(finding.identifier)));
    if (unresolved) {
      await searchOnce(state, `"${unresolved.identifier}"`, "identifier check", window);
      await gather(state, subject);
      findings = buildFindings({ subject, sources: state.registry, lookups: state.lookups, kev: state.kev, maxFindings: cfg.maxFindings });
    }
  }

  const limitations = [
    "Search-result titles and snippets are not evidence. Only pages that were read and primary records count as sources for facts.",
    "The DuckDuckGo date filter is approximate and is not checked per result. Publication dates come from read pages and records only.",
    "Only the sources listed were checked. Other sources were not examined.",
  ];
  if (!subject) limitations.push("No subject term was identified, so product association was not checked.");
  if (state.kev && state.kev.status !== "ok") limitations.push("The CISA KEV catalogue could not be checked, so KEV status is unknown.");
  const failedLookups = [...state.lookups.entries()].filter(([, entry]) => !entry.record).map(([id]) => id);
  if (failedLookups.length) limitations.push(`No primary record was retrieved for: ${failedLookups.join(", ")}.`);
  const unchecked = state.lookupCount >= cfg.maxLookups ? lookupCandidates(state, subject) : [];
  if (unchecked.length) limitations.push(`The primary record lookup limit was reached, so these identifiers were not checked: ${unchecked.join(", ")}.`);
  if (state.timedOut) limitations.push("The time limit was reached, so some sources were not read.");
  if (state.searchError) limitations.push(`The search failed: ${state.searchError}`);

  const publicSources = state.registry.filter((source) => source.origin === "search" || source.origin === "lookup").map(publicSource);
  const research = {
    currentDate: todayIso(now),
    timezone: USER_TIME_ZONE,
    query: trimmed,
    subject: { value: subject, method: subjectInfo.method },
    intent,
    timeWindow: window,
    searches: state.searches,
    budget: {
      maxSearches: cfg.maxSearches,
      searchesUsed: state.searchesUsed,
      maxFetches: cfg.maxFetches,
      fetchesUsed: state.fetchesUsed,
      fetchLimit: cfg.fetchLimit,
      pagesRead: state.pagesRead,
      lookups: state.lookupCount,
      maxFindings: cfg.maxFindings,
      timedOut: state.timedOut,
    },
    limitations,
    error: state.searchError,
  };

  const context = buildContext({
    query: trimmed,
    research,
    findings,
    sources: state.registry.filter((source) => source.origin === "search" || source.origin === "lookup"),
    maxChars: cfg.maxContextChars,
  });

  const payload = {
    query: trimmed,
    context,
    sources: publicSources,
    findings,
    research,
    cached: false,
  };

  // Failures and time-outs are not cached, so the next request tries again.
  const degraded = Boolean(state.searchError) || state.timedOut || failedLookups.length > 0;
  if (!options.noCache && !degraded) writeCache(cacheDir, cacheKey, payload);
  return payload;
}

module.exports = {
  comprehensiveWebSearch,
  resolveConfig,
  LIMITS,
  PIPELINE_VERSION,
};
