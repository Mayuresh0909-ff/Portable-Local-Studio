// Route tests for the discovery-refresh guard (Task 5). These are not source-text checks.
//
// EXECUTED (Linux and macOS): this test starts the real scripts/server/serve.cjs as child processes
// and makes real HTTP requests to GET /api/backend-options and GET /api/hardware-specs.
//
// Two things are substituted, and only these:
//   1. nvidia-smi is a fake shell script placed first on PATH. It logs each discovery query, so the
//      test can count the probes the server ran. No GPU and no driver are needed.
//   2. A model runtime is "active" through the UAIS_TEST_RUNTIME_FLAGS seam in serve.cjs. No backend
//      process is started, and no model is loaded.
//
// NOT EXECUTED here: Windows. The fake nvidia-smi is a POSIX shell script, so these tests are
// skipped on win32 and say so in their name. The real backend lifecycle still needs a Windows run.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const SERVE = path.join(root, "scripts", "server", "serve.cjs");
const POSIX_ONLY = process.platform === "win32" ? "Not run on Windows: the fake nvidia-smi is a POSIX shell script." : false;
const DISCOVERY_MARK = "pci.bus_id"; // only the discovery query asks for this field
const REFUSED_MESSAGE = "Stop the active image or text model before refreshing hardware detection.";

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

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: 8000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, json: safeJson(body) }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout on ${urlPath}`)));
    req.on("error", reject);
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Waits until the server answers. Gives up after 30 seconds.
async function waitUntilUp(port) {
  const deadline = Date.now() + 30000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await get(port, "/api/backend-status");
      if (res.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not start: ${lastError ? lastError.message : "no response"}`);
}

// Starts the real server. `flags` (optional) sets the runtime seam. Returns helpers and a stop().
async function startServer({ flags = null, label }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `refresh-route-${label}-`));
  const log = path.join(dir, "smi.log");
  const smi = path.join(dir, "nvidia-smi");
  fs.writeFileSync(smi, [
    "#!/bin/sh",
    `case "$*" in *${DISCOVERY_MARK}*) echo "$*" >> "${log}" ;; esac`,
    'echo "0, Test GPU, 8192, 7000, Disabled, 00000000:01:00.0, 580.00, 12.0"',
    "",
  ].join("\n"), { mode: 0o755 });
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), PATH: `${dir}${path.delimiter}${process.env.PATH || ""}` };
  delete env.UAIS_TEST_RUNTIME_FLAGS;
  if (flags) env.UAIS_TEST_RUNTIME_FLAGS = JSON.stringify(flags);
  const child = spawn(process.execPath, [SERVE], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await waitUntilUp(port);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\n${output.slice(-2000)}`);
  }
  const probes = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { port, probes, stop };
}

test("idle runtime: refresh=1 succeeds and runs a new discovery; a cached GET runs none", { skip: POSIX_ONLY }, async () => {
  const server = await startServer({ label: "idle" });
  try {
    const first = await get(server.port, "/api/backend-options");
    assert.equal(first.status, 200);
    const afterFirst = server.probes();

    const refreshed = await get(server.port, "/api/backend-options?refresh=1");
    assert.equal(refreshed.status, 200, "an idle runtime allows the refresh");
    assert.ok(refreshed.json, "the refresh returns the options");
    assert.ok(server.probes() > afterFirst, "the refresh ran a new discovery");
    const afterRefresh = server.probes();

    const cached = await get(server.port, "/api/backend-options");
    assert.equal(cached.status, 200);
    assert.equal(server.probes(), afterRefresh, "a cached GET without refresh=1 does not probe");
  } finally {
    await server.stop();
  }
});

test("active runtime: refresh=1 is HTTP 409, runs no new probe, and keeps the cached discovery", { skip: POSIX_ONLY }, async () => {
  const server = await startServer({ flags: { imageRunning: true }, label: "active" });
  try {
    // The first cached GET may run discovery once. The refusal must not run any more.
    const before = await get(server.port, "/api/backend-options");
    assert.equal(before.status, 200, "a cached GET is not refused while a runtime is active");
    const probesBefore = server.probes();

    const refused = await get(server.port, "/api/backend-options?refresh=1");
    assert.equal(refused.status, 409);
    assert.equal(refused.json.ok, false);
    assert.equal(refused.json.error, REFUSED_MESSAGE);
    assert.equal(server.probes(), probesBefore, "a refused refresh starts no new probe");

    const after = await get(server.port, "/api/backend-options");
    assert.equal(after.status, 200, "the cached GET still works after the refusal");
    assert.deepEqual(after.json, before.json, "the cached discovery is not cleared by the refusal");
    assert.equal(server.probes(), probesBefore, "the cached GET after the refusal probes nothing");
  } finally {
    await server.stop();
  }
});

test("active runtime: the hardware-specs refresh is refused with the same 409 and no probe", { skip: POSIX_ONLY }, async () => {
  const server = await startServer({ flags: { textRunning: true }, label: "hw" });
  try {
    const before = server.probes();
    const refused = await get(server.port, "/api/hardware-specs?refresh=1");
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, REFUSED_MESSAGE);
    assert.equal(server.probes(), before, "the refused hardware refresh starts no probe");
  } finally {
    await server.stop();
  }
});

test("an unreadable runtime seam value fails closed: refresh is refused", { skip: POSIX_ONLY }, async () => {
  // Passing a value that is not JSON through the seam must not open the guard.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-route-bad-"));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), UAIS_TEST_RUNTIME_FLAGS: "{not json" };
  const child = spawn(process.execPath, [SERVE], { cwd: root, env, stdio: ["ignore", "ignore", "ignore"] });
  try {
    await waitUntilUp(port);
    const refused = await get(port, "/api/backend-options?refresh=1");
    assert.equal(refused.status, 409);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Source-text check for the live wiring (the route tests above use the test seam, not the live
// processes). It confirms that the guard reads all four live runtime states.
test("source: the live guard reads the image, text, OpenVINO and generation state", () => {
  const serve = fs.readFileSync(SERVE, "utf8");
  assert.match(serve, /imageRunning: backendProc !== null,/);
  assert.match(serve, /textRunning: llmProc !== null,/);
  assert.match(serve, /openvinoRunning: openvinoProc !== null,/);
  assert.match(serve, /generating: generationState\.active,/);
});
