// Shared helpers for route tests that start the real scripts/server/serve.cjs as a child process.
// This file is not a test: the test runner only picks up scripts/tests/*.test.cjs.

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..", "..");
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

function request(port, { method = "GET", urlPath = "/", body = null, headers = {}, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString("utf8") });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout on ${urlPath}`)));
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

// Waits until the server answers the status route. Gives up after 30 seconds.
async function waitUntilUp(port) {
  const deadline = Date.now() + 30000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, { urlPath: "/api/backend-status", timeoutMs: 2000 });
      if (res.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not start: ${lastError ? lastError.message : "no response"}`);
}

// Starts serve.cjs with the given extra environment. Returns { port, stop }.
async function startServe({ env: extraEnv = {}, label = "serve" } = {}) {
  const port = await freePort();
  const env = { ...process.env, ...extraEnv, PORT: String(port) };
  const child = spawn(process.execPath, [SERVE], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await waitUntilUp(port);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${label}: ${error.message}\n${output.slice(-2000)}`);
  }
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
  return { port, stop };
}

// A fake image backend on loopback. `handler(req, res)` answers each request. Returns { port, close }.
async function startFakeBackend(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

module.exports = { root, freePort, request, waitUntilUp, startServe, startFakeBackend, makeTempDir };
