// Test helpers for the web research pipeline. Nothing here touches the network: search, record and page
// fetches are answered from the synthetic fixtures in scripts/tests/fixtures/web-research/.
// This file is not a test: the runner only picks up scripts/tests/*.test.cjs.

const fs = require("node:fs");
const path = require("node:path");
const { stripHtml } = require("../../search/content");
const { parseDuckDuckGoHtml } = require("../../search/providers");

const FIXTURES = path.resolve(__dirname, "..", "fixtures", "web-research");

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function readJsonFixture(name) {
  return JSON.parse(readFixture(name));
}

// Result list the way the DuckDuckGo provider returns it. Built from the real HTML fixture through the real parser.
function searchResultsFromFixture(name = "ddg-php2shell.html") {
  return parseDuckDuckGoHtml(readFixture(name), 10);
}

function htmlPage(name) {
  const { title, text } = stripHtml(readFixture(name));
  return { title, text };
}

// A fake webSearch. `answers` maps a query (exact string or RegExp) to results. Unknown queries get no results.
function fakeWebSearch(answers, log = []) {
  return async (query, options = {}) => {
    log.push({ query, options });
    for (const [key, value] of answers) {
      const matches = key instanceof RegExp ? key.test(query) : key === query;
      if (matches) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return [];
  };
}

// A fake fetchRaw for JSON records. `routes` maps an exact URL to a JSON object, an Error, or a status error.
function fakeFetchRaw(routes, log = []) {
  return async (url, options = {}) => {
    log.push({ url, kind: "raw", options });
    const route = routes.get(url);
    if (route === undefined) throw new Error("Page returned HTTP 404 or unsupported content type.");
    if (route instanceof Error) throw route;
    return { url, status: 200, contentType: "application/json", body: typeof route === "string" ? route : JSON.stringify(route) };
  };
}

// A fake fetchPage for HTML or text pages. `pages` maps a URL to { title, text } or an Error.
function fakeFetchPage(pages, log = []) {
  return async (url, options = {}) => {
    log.push({ url, kind: "page", options });
    const page = pages.get(url);
    if (page === undefined) throw new Error("Page returned HTTP 404 or unsupported content type.");
    if (page instanceof Error) throw page;
    return { title: page.title || "", text: page.text, url, contentType: "text/html" };
  };
}

// Standard fixture world for the PHP2Shell and News Kit scenarios.
const URLS = {
  nvd109618: "https://nvd.nist.gov/vuln/detail/CVE-2026-109618",
  news: "https://www.bleepingcomputer.com/news/security/php2shell-incident/",
  euvd: "https://euvd.enisa.europa.eu/vulnerability/EUVD-2026-108013",
  cveApi: (id) => `https://cveawg.mitre.org/api/cve/${id}`,
  nvdApi: (id) => `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(id)}`,
  kev: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
};

function standardRaw({ omit = [] } = {}) {
  const routes = new Map([
    [URLS.cveApi("CVE-2026-109618"), readJsonFixture("cve-109618.json")],
    [URLS.cveApi("CVE-2026-109619"), readJsonFixture("cve-109619.json")],
    [URLS.cveApi("CVE-2026-97353"), readJsonFixture("cve-97353.json")],
    [URLS.cveApi("CVE-2026-97354"), readJsonFixture("cve-97354.json")],
    [URLS.kev, readJsonFixture("kev.json")],
  ]);
  for (const url of omit) routes.delete(url);
  return routes;
}

module.exports = {
  FIXTURES,
  readFixture,
  readJsonFixture,
  searchResultsFromFixture,
  htmlPage,
  fakeWebSearch,
  fakeFetchRaw,
  fakeFetchPage,
  standardRaw,
  URLS,
};
