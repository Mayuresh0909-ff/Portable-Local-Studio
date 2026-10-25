// Tests for the network-facing helpers of the web research pipeline: SSRF checks, the DuckDuckGo request
// builder and parser, and the redirect rules.
//
// EXECUTED: every test here is local. IP literals and fixture HTML only. No DNS lookup and no connection is
// made, so the tests pass offline and do not depend on any live site.
//
// The connect-time check, DNS rebinding and redirect hops are tested with the DNS lookup and request function replaced,
// in web-research-fetch.test.cjs. NOT TESTED HERE, OR THERE: a live redirect chain on the internet and a real TLS
// handshake. Those need a live network test in a controlled environment.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const content = require(path.join(root, "scripts", "search", "content.js"));
const providers = require(path.join(root, "scripts", "search", "providers.js"));
const { classifySource } = require(path.join(root, "scripts", "search", "sources.js"));

const FIXTURE = path.join(__dirname, "fixtures", "web-research", "ddg-php2shell.html");

test("SSRF: private, loopback, link-local, CGNAT and mapped addresses are not public", () => {
  const blocked = [
    "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "100.127.255.254",
    "198.18.0.1", "224.0.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.5", "64:ff9b::1",
  ];
  for (const ip of blocked) assert.equal(content.isPrivateIp(ip), true, `${ip} must be blocked`);
});

test("SSRF: ordinary public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "172.32.0.1", "2606:4700:4700::1111"]) {
    assert.equal(content.isPrivateIp(ip), false, `${ip} must be allowed`);
  }
});

test("SSRF: assertPublicUrl rejects bad schemes, localhost and private literals, and allows a public literal", async () => {
  await assert.rejects(content.assertPublicUrl("file:///etc/passwd"), /Only HTTP and HTTPS/);
  await assert.rejects(content.assertPublicUrl("http://localhost:8080/x"), /Localhost/);
  await assert.rejects(content.assertPublicUrl("http://api.localhost/x"), /Localhost/);
  await assert.rejects(content.assertPublicUrl("http://127.0.0.1/"), /Private network/);
  await assert.rejects(content.assertPublicUrl("http://[::ffff:7f00:1]/"), /Private network/);
  await assert.rejects(content.assertPublicUrl("http://169.254.169.254/latest/meta-data"), /Private network/);
  await assert.doesNotReject(content.assertPublicUrl("https://8.8.8.8/"));
});

test("SSRF: a redirect target is validated the same way (the redirect check uses assertPublicUrl)", async () => {
  // Redirect targets are resolved against the current URL and then checked. These are the targets a hostile
  // redirect could name.
  for (const target of ["http://127.0.0.1/admin", "http://[::1]/", "http://10.0.0.1/", "file:///etc/hosts", "http://localhost/"]) {
    await assert.rejects(content.assertPublicUrl(new URL(target, "https://8.8.8.8/start").toString()));
  }
});

test("connect-time lookup: safeLookup refuses private literal addresses and returns public ones", async () => {
  await new Promise((resolve, reject) => {
    content.safeLookup("127.0.0.1", {}, (err) => (err ? resolve() : reject(new Error("private address was allowed"))));
  });
  await new Promise((resolve, reject) => {
    content.safeLookup("8.8.8.8", {}, (err, address) => (err ? reject(err) : (address === "8.8.8.8" ? resolve() : reject(new Error("wrong address")))));
  });
  await new Promise((resolve, reject) => {
    content.safeLookup("8.8.8.8", { all: true }, (err, records) => (err ? reject(err) : (Array.isArray(records) && records[0].address === "8.8.8.8" ? resolve() : reject(new Error("not an array")))));
  });
});

test("DuckDuckGo: the request carries the query and only the requested date filter", () => {
  const plain = new URL(providers.buildDuckDuckGoUrl("PHP2Shell CVE", "any"));
  assert.equal(plain.hostname, "html.duckduckgo.com");
  assert.equal(plain.searchParams.get("q"), "PHP2Shell CVE");
  assert.equal(plain.searchParams.has("df"), false, "any sends no date filter");
  assert.equal(new URL(providers.buildDuckDuckGoUrl("x", "month")).searchParams.get("df"), "m");
  assert.equal(new URL(providers.buildDuckDuckGoUrl("x", "day")).searchParams.get("df"), "d");
  assert.equal(new URL(providers.buildDuckDuckGoUrl("x", "auto")).searchParams.has("df"), false, "auto is resolved before the request");
});

test("DuckDuckGo: time filter values are normalised, unknown values mean no filter", () => {
  assert.equal(providers.normalizeTimeFilter("week"), "w");
  assert.equal(providers.normalizeTimeFilter("year"), "y");
  assert.equal(providers.normalizeTimeFilter("bogus"), "");
  assert.equal(providers.normalizeTimeFilter(undefined), "");
});

test("DuckDuckGo: the fixture HTML parses to results with decoded target URLs, not redirect wrappers", () => {
  const html = fs.readFileSync(FIXTURE, "utf8");
  const results = providers.parseDuckDuckGoHtml(html, 10);
  assert.equal(results.length, 3);
  assert.equal(results[0].url, "https://nvd.nist.gov/vuln/detail/CVE-2026-109618");
  assert.ok(results.every((item) => item.provider === "duckduckgo"));
  assert.ok(results.every((item) => !item.url.includes("duckduckgo.com/l/")));
  assert.equal(providers.parseDuckDuckGoHtml(html, 1).length, 1, "limit is applied");
});

test("DuckDuckGo: webSearch with an injected request function passes the built URL and returns parsed results", async () => {
  const html = fs.readFileSync(FIXTURE, "utf8");
  const seen = [];
  const results = await providers.webSearch("PHP2Shell", {
    limit: 2,
    timeFilter: "week",
    requestText: async (url) => { seen.push(url); return html; },
  });
  assert.equal(results.length, 2);
  assert.equal(new URL(seen[0]).searchParams.get("df"), "w");
});

test("source tiers: primary records, secondary news, and unknown hosts are classified separately", () => {
  assert.equal(classifySource("https://cveawg.mitre.org/api/cve/CVE-2026-109618", "x").tier, "primary");
  assert.equal(classifySource("https://nvd.nist.gov/vuln/detail/CVE-2026-109618", "x").tier, "primary");
  assert.equal(classifySource("https://www.bleepingcomputer.com/news/a/", "x").tier, "secondary");
  assert.notEqual(classifySource("https://unknown.example.test/post", "x").tier, "primary");
  assert.notEqual(classifySource("https://unknown.example.test/post", "x").tier, "secondary");
});
