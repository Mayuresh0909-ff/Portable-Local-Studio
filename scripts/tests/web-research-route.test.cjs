// Route tests for the web research endpoints. These are not source-text checks.
//
// EXECUTED (any OS): starts the real scripts/server/serve.cjs as a child process and makes real HTTP requests to
// GET /api/web-search/config and POST /api/web-research/audit. Neither route makes an outbound request, so
// the tests run offline. No model is loaded.
//
// NOT EXECUTED here: POST /api/web-search and the chat route with web research enabled. Those reach
// DuckDuckGo and the primary record sources, so they need a manual run with network access.

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const SERVE = path.join(root, "scripts", "server", "serve.cjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, path: urlPath, method, timeout: 8000,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout on ${urlPath}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitUntilUp(port, child) {
  const deadline = Date.now() + 30000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const res = await request(port, "GET", "/api/web-search/config");
      if (res.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not start: ${lastError ? lastError.message : "no response"}`);
}

async function withServer(fn) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  const child = spawn(process.execPath, [SERVE], { cwd: root, env, stdio: ["ignore", "ignore", "ignore"] });
  try {
    await waitUntilUp(port, child);
    return await fn(port);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

test("route: /api/web-search/config lists DuckDuckGo as the key-free default, the time filters, and the limits", async () => {
  await withServer(async (port) => {
    const res = await request(port, "GET", "/api/web-search/config");
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.provider, "duckduckgo");
    const ddg = res.json.providers.find((item) => item.key === "duckduckgo");
    assert.equal(ddg.requiresApiKey, false);
    assert.equal(res.json.defaults.timeFilter, "auto");
    assert.deepEqual(res.json.timeFilters, ["auto", "any", "day", "week", "month", "year"]);
    assert.equal(res.json.limits.maxSearches.max, 4);
    assert.equal(res.json.limits.maxLookups.max, 6);
    assert.equal(res.json.limits.totalTimeoutMs.max, 90000);
    assert.equal(JSON.stringify(res.json).includes("apiKey"), false, "no credential field is exposed");
  });
});

test("route: /api/web-research/audit flags an unconfirmed exploitation claim and an invalid citation", async () => {
  await withServer(async (port) => {
    const webResearch = {
      sources: [{ index: 1, url: "https://nvd.nist.gov/vuln/detail/CVE-2026-109619", title: "NVD", fetchStatus: "fetched", tier: "primary", type: "cve-record" }],
      findings: [{ identifier: "CVE-2026-109619", identifierType: "cve", status: "verified", exploitation: { status: "public-poc-per-cisa-ssvc", confirmedActive: false } }],
    };
    const res = await request(port, "POST", "/api/web-research/audit", {
      text: "CVE-2026-109619 is actively exploited [1]. See also [7].",
      webResearch,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const types = res.json.audit.issues.map((issue) => issue.type);
    assert.ok(types.includes("exploitation-claim-not-confirmed"), types.join(","));
    assert.ok(types.includes("invalid-citation"), types.join(","));
    assert.equal(res.json.audit.ok, false);
  });
});

test("route: /api/web-research/audit with no research evidence still answers, and rejects an oversize answer", async () => {
  await withServer(async (port) => {
    const plain = await request(port, "POST", "/api/web-research/audit", { text: "Hello.", webResearch: {} });
    assert.equal(plain.status, 200);
    assert.equal(plain.json.audit.ok, true);

    const huge = await request(port, "POST", "/api/web-research/audit", { text: "x".repeat(200001), webResearch: {} });
    assert.ok(huge.status === 413 || huge.status === 400, `status ${huge.status}`);
    assert.equal(huge.json && huge.json.ok, false);
  });
});
