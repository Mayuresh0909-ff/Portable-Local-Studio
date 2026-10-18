// Tests for scripts/capture-gpu-evidence.cjs.
//
// EXECUTED (Linux and macOS): the orchestration, report writing, and argument parsing run against
// injected nvidia-smi and probe results. The CLI tests run the real script as a child process with
// a small fake backend (a shell script). They do not use a real GPU or a real backend binary.
//
// NOT EXECUTED here: the Windows path. The CLI tests are skipped on win32 and say so in their name.
// Nothing here shows that a Windows backend initializes the RTX 5060.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const capture = require(path.join(root, "scripts", "capture-gpu-evidence.cjs"));
const SCRIPT = path.join(root, "scripts", "capture-gpu-evidence.cjs");
const MODELS_DIR = path.join(root, "app", "models");

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gpu-evidence-${label}-`));
}

// Stands in for an existing backend binary. The probe never runs it, because run is injected.
function touchBinary(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "");
  return file;
}

const RTX_SMI = {
  ok: true,
  command: "nvidia-smi",
  error: null,
  devices: [{
    index: 0, name: "NVIDIA GeForce RTX 5060 Laptop GPU", vendor: "nvidia", integrated: false,
    virtual: false, vramGb: 8, freeVramGb: 7, displayActive: false,
    busId: "00000000:01:00.0", source: "nvidia-smi",
  }],
};

const LOADING = "ggml_cuda_init: found 1 CUDA devices\nstable-diffusion.cpp\nloading model from 'x'\nerror: model file not found";
const REJECTS_BACKEND = "error: unknown argument '--backend'";
const FALLBACK_MISSING = "stable-diffusion.cpp\nerror: could not open __backend_probe_missing__.safetensors";

// ── Arguments ─────────────────────────────────────────────────────────────────────

test("argument parsing accepts the documented flags", () => {
  const options = capture.parseArgs(["--out", "x", "--cuda", "/a", "--vulkan", "/b"]);
  assert.deepEqual(options.errors, []);
  assert.equal(options.outDir, "x");
  assert.equal(options.cuda, "/a");
  assert.equal(options.vulkan, "/b");
});

test("argument parsing reports unknown flags and missing values instead of guessing", () => {
  assert.match(capture.parseArgs(["--model", "x"]).errors[0], /Unknown argument: --model/);
  assert.match(capture.parseArgs(["--out"]).errors[0], /--out needs a value/);
  assert.match(capture.parseArgs(["--cuda", "--out", "d"]).errors[0], /--cuda needs a value/);
});

// ── Default binaries ──────────────────────────────────────────────────────────────

test("default binaries follow the platform, and macOS has none to probe", () => {
  const win = capture.defaultBackendBinaries("win32", "/r");
  assert.match(win.cuda, /win[\\/]cuda[\\/]sd-cuda\.exe$/);
  assert.match(win.vulkan, /win[\\/]vulkan[\\/]sd-vulkan\.exe$/);
  const linux = capture.defaultBackendBinaries("linux", "/r");
  assert.match(linux.cuda, /linux[\\/]cuda[\\/]sd-server-cuda$/);
  assert.match(linux.vulkan, /linux[\\/]vulkan[\\/]sd-server-vulkan$/);
  assert.deepEqual(capture.defaultBackendBinaries("darwin", "/r"), { cuda: null, vulkan: null });
});

// ── Orchestration (injected query and run) ────────────────────────────────────────

test("a pinned CUDA probe on the reported index is recorded with the device it used", () => {
  const dir = tempDir("cuda");
  const cuda = touchBinary(dir, "sd-cuda");
  const calls = [];
  const report = capture.captureGpuEvidence({
    platform: "linux",
    cuda,
    vulkan: path.join(dir, "missing-vulkan"),
    query: () => RTX_SMI,
    run: (file, args, options) => {
      calls.push({ file, args, options });
      return { output: LOADING, exitCode: 1, errorCode: null };
    },
    now: () => new Date("2026-10-17T10:00:00.000Z"),
  });
  const cudaBackend = report.backends[0];
  assert.equal(cudaBackend.present, true);
  assert.equal(cudaBackend.probes.length, 1, "one probe per reported NVIDIA index");
  assert.equal(cudaBackend.probes[0].cliName, "cuda0");
  assert.equal(cudaBackend.probes[0].accepted, true);
  assert.equal(cudaBackend.probes[0].initConfirmed, true);
  assert.equal(cudaBackend.probes[0].stage, "primary");
  assert.deepEqual(calls[0].args.slice(0, 2), ["--backend", "cuda0"]);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.env.CUDA_DEVICE_ORDER, "PCI_BUS_ID");
  assert.equal(report.hardwareVerified, false);
  assert.equal(report.nvidiaSmi.devices[0].name, "NVIDIA GeForce RTX 5060 Laptop GPU");
  assert.match(report.summary.join("\n"), /cuda: cuda0: accepted; reached model loading/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a binary that rejects --backend is probed again without device flags, and the report says so", () => {
  const dir = tempDir("fallback");
  const cuda = touchBinary(dir, "sd-cuda");
  const calls = [];
  const outputs = [REJECTS_BACKEND, FALLBACK_MISSING];
  const report = capture.captureGpuEvidence({
    platform: "linux",
    cuda,
    vulkan: null,
    query: () => RTX_SMI,
    run: (file, args) => {
      calls.push(args);
      return { output: outputs.shift(), exitCode: 1, errorCode: null };
    },
  });
  const probe = report.backends[0].probes[0];
  assert.equal(calls.length, 2);
  assert.equal(calls[1].includes("--backend"), false);
  assert.equal(probe.stage, "fallback");
  assert.equal(probe.supportsFlags, false);
  assert.equal(probe.accepted, true);
  assert.equal(probe.initConfirmed, false, "missing-model output alone does not confirm the device");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a timed-out probe is recorded as no verdict, not as a rejected device", () => {
  const dir = tempDir("timeout");
  const cuda = touchBinary(dir, "sd-cuda");
  const report = capture.captureGpuEvidence({
    platform: "linux",
    cuda,
    vulkan: null,
    query: () => RTX_SMI,
    run: () => ({ output: "", exitCode: null, errorCode: "ETIMEDOUT" }),
  });
  const probe = report.backends[0].probes[0];
  assert.equal(probe.probeError, "timeout");
  assert.equal(probe.accepted, false);
  assert.match(report.summary.join("\n"), /no verdict \(timeout\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Vulkan is probed by index until a device is reported missing", () => {
  const dir = tempDir("vulkan");
  const vulkan = touchBinary(dir, "sd-vulkan");
  const seen = [];
  const report = capture.captureGpuEvidence({
    platform: "linux",
    cuda: null,
    vulkan,
    query: () => ({ ok: false, devices: [], error: "nvidia-smi was not found" }),
    run: (file, args) => {
      const name = args[1];
      seen.push(name);
      if (name === "vulkan2") return { output: "backend 'vulkan2' was not found", exitCode: 1, errorCode: null };
      return { output: LOADING, exitCode: 1, errorCode: null };
    },
  });
  assert.deepEqual(report.backends[1].probes.map((p) => p.cliName), ["vulkan0", "vulkan1", "vulkan2"]);
  assert.equal(report.backends[1].probes[2].notFound, true);
  assert.deepEqual(seen, ["vulkan0", "vulkan1", "vulkan2"]);
  assert.equal(report.nvidiaSmi.ok, false);
  assert.match(report.notes.join("\n"), /CUDA was probed on index 0 only/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing binary is reported as not present, and nothing is probed", () => {
  let ran = false;
  const report = capture.captureGpuEvidence({
    platform: "linux",
    cuda: path.join(os.tmpdir(), "definitely-not-here", "sd-cuda"),
    vulkan: path.join(os.tmpdir(), "definitely-not-here", "sd-vulkan"),
    query: () => RTX_SMI,
    run: () => { ran = true; return { output: "", exitCode: 0, errorCode: null }; },
  });
  assert.equal(ran, false);
  assert.equal(report.backends[0].present, false);
  assert.equal(report.backends[0].probes.length, 0);
  assert.match(report.summary.join("\n"), /cuda: The backend binary is not present/);
});

test("the probe never points at the real models folder, and the capture does not create it", () => {
  const existedBefore = fs.existsSync(MODELS_DIR);
  const seenPaths = [];
  capture.captureGpuEvidence({
    platform: "linux",
    cuda: null,
    vulkan: null,
    query: () => RTX_SMI,
    run: () => ({ output: "", exitCode: 0, errorCode: null }),
  });
  capture.captureGpuEvidence({
    platform: "linux",
    cuda: touchBinary(tempDir("path"), "sd-cuda"),
    vulkan: null,
    query: () => RTX_SMI,
    run: (file, args) => { seenPaths.push(args[args.indexOf("--model") + 1]); return { output: LOADING, exitCode: 1, errorCode: null }; },
  });
  assert.equal(fs.existsSync(MODELS_DIR), existedBefore, "app/models must not be created");
  assert.ok(seenPaths.length > 0);
  for (const file of seenPaths) assert.equal(path.basename(file), "__backend_probe_missing__.safetensors");
});

// ── Report file ──────────────────────────────────────────────────────────────────

test("the report is written as JSON and an existing report is never overwritten", () => {
  const dir = path.join(tempDir("write"), "nested");
  const report = capture.buildEvidenceReport({
    capturedAt: "2026-10-17T10:00:00.000Z", platform: "linux", nvidiaSmi: RTX_SMI, backends: [], notes: [],
  });
  const file = capture.writeEvidenceReport(report, dir);
  assert.equal(path.basename(file), "gpu-evidence-2026-10-17T10-00-00-000Z.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.schema, capture.SCHEMA);
  assert.equal(parsed.hardwareVerified, false);
  assert.throws(() => capture.writeEvidenceReport(report, dir), { code: "EEXIST" });
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

// ── Evidence detail (Task 1) ───────────────────────────────────────────────────────

const http = require("node:http");
const gprunner = require(path.join(root, "scripts", "server", "gpu-probe-runner.cjs"));

test("output capture: stdout and stderr are kept apart, and a long stream is cut with the cut recorded", () => {
  const dir = tempDir("capture");
  const cuda = touchBinary(dir, "sd-cuda");
  const longStdout = "x".repeat(20000);
  const report = capture.captureGpuEvidence({
    platform: "linux",
    cuda,
    vulkan: null,
    query: () => RTX_SMI,
    run: () => ({ stdout: longStdout, stderr: "stable-diffusion.cpp\nerror: could not open model", output: longStdout, exitCode: 1, errorCode: null }),
  });
  const attempt = report.backends[0].probes[0].attempts[0];
  assert.equal(attempt.combinedOnly, false);
  assert.equal(attempt.stdout.truncated, true, "a 20000-character stream must be cut");
  assert.equal(attempt.stdout.originalChars, 20000);
  assert.match(attempt.stdout.text, /\[truncated: \d+ characters omitted\]/);
  assert.ok(attempt.stdout.text.length < 9000, "the bounded text stays small");
  assert.equal(attempt.stderr.truncated, false);
  assert.match(attempt.stderr.text, /could not open model/, "stderr is kept separately from stdout");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("output capture: a run that returns only combined output is recorded as combined, not split", () => {
  const dir = tempDir("combined");
  const cuda = touchBinary(dir, "sd-cuda");
  const report = capture.captureGpuEvidence({
    platform: "linux", cuda, vulkan: null, query: () => RTX_SMI,
    run: () => ({ output: LOADING, exitCode: 1, errorCode: null }),
  });
  const attempt = report.backends[0].probes[0].attempts[0];
  assert.equal(attempt.combinedOnly, true);
  assert.equal(attempt.stderr, null);
  assert.match(attempt.stdout.text, /found 1 CUDA devices/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("redaction: absolute user paths in streams and arguments are replaced", () => {
  const home = "/home/alice";
  const text = "loading /home/alice/models/x.safetensors and C:\\Users\\Bob\\AppData\\y and " + path.join(root, "app", "models", "m.safetensors");
  const redacted = capture.redactText(text, { root, home });
  assert.doesNotMatch(redacted, /alice|Bob/);
  assert.match(redacted, /~\/models\/x\.safetensors/, "the home folder becomes ~");
  assert.equal(capture.redactText("/home/alice/models/x", { root, home: "/srv/elsewhere" }), "/home/<user>/models/x", "other home folders are masked by pattern");
  assert.match(redacted, /C:\\Users\\<user>\\AppData/);
  assert.match(redacted, /<repo>\/app\/models\/m\.safetensors/);
});

test("primary and fallback attempts are both kept, with the primary's stderr and the rejected flag", () => {
  const dir = tempDir("retain");
  const cuda = touchBinary(dir, "sd-cuda");
  const results = [
    { stdout: "", stderr: REJECTS_BACKEND, output: `\n${REJECTS_BACKEND}`, exitCode: 1, errorCode: null },
    { stdout: "stable-diffusion.cpp", stderr: "error: could not open __backend_probe_missing__.safetensors", output: "stable-diffusion.cpp\nerror: could not open __backend_probe_missing__.safetensors", exitCode: 1, errorCode: null },
  ];
  const report = capture.captureGpuEvidence({
    platform: "linux", cuda, vulkan: null, query: () => RTX_SMI,
    run: () => results.shift(),
  });
  const probe = report.backends[0].probes[0];
  assert.equal(probe.attempts.length, 2, "both attempts are kept");
  assert.equal(probe.attempts[0].stage, "primary");
  assert.ok(probe.attempts[0].args.includes("--backend"), "the primary attempt used device flags");
  assert.match(probe.attempts[0].stderr.text, /unknown argument '--backend'/, "the rejected output is not discarded");
  assert.equal(probe.attempts[1].stage, "fallback");
  assert.equal(probe.attempts[1].args.includes("--backend"), false);
  assert.equal(probe.stage, "fallback", "the verdict still comes from the fallback");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("timeouts: a timed-out attempt records timedOut and an ETIMEDOUT code, and is not retried", () => {
  const dir = tempDir("timeout2");
  const cuda = touchBinary(dir, "sd-cuda");
  let calls = 0;
  const report = capture.captureGpuEvidence({
    platform: "linux", cuda, vulkan: null, query: () => RTX_SMI,
    run: () => { calls += 1; return { stdout: "", stderr: "", output: "", exitCode: null, errorCode: "ETIMEDOUT", timedOut: true }; },
  });
  const probe = report.backends[0].probes[0];
  assert.equal(calls, 1, "a timeout is not retried with other flags");
  assert.equal(probe.attempts[0].timedOut, true);
  assert.equal(probe.attempts[0].errorCode, "ETIMEDOUT");
  assert.equal(probe.probeError, "timeout");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("spawn errors are recorded with their error code, not turned into output text", () => {
  const dir = tempDir("spawnerr");
  const cuda = touchBinary(dir, "sd-cuda");
  const report = capture.captureGpuEvidence({
    platform: "linux", cuda, vulkan: null, query: () => RTX_SMI,
    run: () => ({ stdout: "", stderr: "", output: "", exitCode: null, errorCode: "EACCES" }),
  });
  const attempt = report.backends[0].probes[0].attempts[0];
  assert.equal(attempt.errorCode, "EACCES");
  assert.equal(attempt.timedOut, false);
  assert.equal(attempt.exitCode, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const POSIX_ONLY = process.platform === "win32" ? "Not run on Windows: this test uses a POSIX shell fake." : false;

test("a real timed-out process is killed and reported as timedOut, and its streams are kept apart", { skip: POSIX_ONLY }, () => {
  const dir = tempDir("realtimeout");
  const script = writeFakeBackend(dir, "slow", "echo from-stdout\necho from-stderr 1>&2\nsleep 5");
  const result = gprunner.runBackendProbeProcess(script, [], { encoding: "utf8", timeout: 300 });
  assert.equal(result.errorCode, "ETIMEDOUT");
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /from-stdout/);
  assert.match(result.stderr, /from-stderr/);
  assert.match(result.output, /from-stdout/, "the combined output is still available to the classifiers");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing binary is reported as not present and nothing is run", () => {
  let ran = false;
  const report = capture.captureGpuEvidence({
    platform: "linux", cuda: path.join(os.tmpdir(), "no-such-backend-xyz"), vulkan: null, query: () => RTX_SMI,
    run: () => { ran = true; return { output: "", exitCode: 0, errorCode: null }; },
  });
  assert.equal(ran, false);
  assert.equal(report.backends[0].present, false);
  assert.equal(report.backends[0].version, null);
});

test("version: a stable-diffusion.cpp version banner with a master identifier is reported, with its evidence", () => {
  const found = capture.extractBackendVersion("stable-diffusion.cpp\nstable-diffusion.cpp version: master-782-b290693\nloading");
  assert.equal(found.value, "master-782-b290693");
  assert.match(found.evidence, /version: master-782-b290693/);
  const logged = capture.extractBackendVersion("[INFO ] stable-diffusion.cpp:1234 - stable-diffusion.cpp version master-1024-a1b2c3d4e5 loaded");
  assert.equal(logged.value, "master-1024-a1b2c3d4e5");
});

test("version: lines that are not a stable-diffusion.cpp banner are never accepted", () => {
  const notBanners = [
    "CUDA Driver Version: 581.80",
    "NVIDIA-SMI 581.80   Driver Version: 581.80   CUDA Version: 13.0",
    "cudart version: 12.8",
    "cuBLAS version: 12.8.4",
    "cuDNN version: 9.10",
    "ggml version: 0.9.1",
    "llama.cpp version: master-782-b290693",
    "stable-diffusion.cpp version: unknown",
    "stable-diffusion.cpp version: 1.2.3",
    "stable-diffusion.cpp version master-12-xyz1234",
    "stable-diffusion.cpp: CUDA driver version master-782-b290693",
    "stable-diffusion.cpp ggml version master-782-b290693",
    "unknown",
    "",
  ];
  for (const line of notBanners) {
    assert.equal(capture.extractBackendVersion(line), null, `must not accept: ${line}`);
  }
});

test("version: output with only driver or runtime version lines is reported as not determined", () => {
  const dir = tempDir("ver-driver");
  const cuda = touchBinary(dir, "sd-cuda");
  const report = capture.captureGpuEvidence({
    platform: "linux", cuda, vulkan: null, query: () => RTX_SMI,
    run: () => ({ stdout: "CUDA Driver Version: 581.80\ncudart version: 12.8\n", stderr: "", output: "CUDA Driver Version: 581.80\ncudart version: 12.8\n", exitCode: 1, errorCode: null }),
  });
  assert.equal(report.backends[0].version.value, null);
  assert.equal(report.backends[0].version.determined, false);
  assert.match(report.summary.join("\n"), /cuda backend version: could not be determined/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("version: unsupported output (a rejected --version flag) is reported as not determined, not guessed", () => {
  assert.equal(capture.extractBackendVersion("error: unrecognized option '--version'"), null);
  assert.equal(capture.extractBackendVersion("Unknown argument: --version"), null);
  const dir = tempDir("ver");
  const cuda = touchBinary(dir, "sd-server-master-782-b290693");
  const report = capture.captureGpuEvidence({
    platform: "linux", cuda, vulkan: null, query: () => RTX_SMI,
    run: () => ({ stdout: "", stderr: "error: unrecognized option '--version'", output: "error: unrecognized option '--version'", exitCode: 1, errorCode: null }),
  });
  assert.equal(report.backends[0].version.value, null, "the file name must not supply a version");
  assert.equal(report.backends[0].version.determined, false);
  assert.match(report.backends[0].version.note, /not printed in the probe output/i);
  assert.match(report.summary.join("\n"), /cuda backend version: could not be determined/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nvidia-smi attempts are recorded with raw stderr, and absent fields are explicit nulls", () => {
  const dir = tempDir("smi");
  const cuda = touchBinary(dir, "sd-cuda");
  const smi = {
    ok: true, command: "nvidia-smi", error: null,
    devices: [{ index: 0, name: "NVIDIA GeForce RTX 3060", vramGb: 12, freeVramGb: 11, displayActive: true, busId: "00000000:01:00.0", driverVersion: null, computeCap: null, source: "nvidia-smi" }],
    attempts: [
      { command: "nvidia-smi", query: "a,compute_cap", exitCode: 2, errorCode: null, stdout: "", stderr: 'Field "compute_cap" is not a valid field to query.' },
      { command: "nvidia-smi", query: "b", exitCode: 0, errorCode: null, stdout: "0, NVIDIA GeForce RTX 3060, 12288, 11000\n", stderr: "" },
    ],
  };
  const report = capture.captureGpuEvidence({ platform: "linux", cuda, vulkan: null, query: () => smi, run: () => ({ output: LOADING, exitCode: 1, errorCode: null }) });
  assert.equal(report.nvidiaSmi.attempts.length, 2);
  assert.match(report.nvidiaSmi.attempts[0].stderr.text, /compute_cap/);
  assert.equal(report.nvidiaSmi.devices[0].driverVersion, null);
  assert.equal(report.nvidiaSmi.devices[0].computeCap, null);
  assert.equal(report.nvidiaSmi.devices[0].busId, "00000000:01:00.0");
  assert.equal(report.backends[0].probes[0].device.index, 0, "the CUDA probe records the device it used");
  fs.rmSync(dir, { recursive: true, force: true });
});

// A fake app API for the three read-only endpoints. Every requested path is recorded.
function startFakeApp({ status, options, progress }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const routes = { "/api/backend-status": status, "/api/backend-options": options, "/api/generation-progress": progress };
    const entry = routes[req.url.split("?")[0]];
    if (!entry) { res.writeHead(404); res.end("{}"); return; }
    if (entry.httpStatus && entry.httpStatus !== 200) { res.writeHead(entry.httpStatus); res.end("{}"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(entry.body));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

const CONFIRMED_LABEL = "NVIDIA GeForce RTX 5060 Laptop GPU [cuda0]";

test("local API: configured settings, backend-reported identity, and last-generation device are separate fields", async () => {
  const app = await startFakeApp({
    status: { body: {
      ready: true, running: true, errorCategory: null,
      settings: { backendType: "cuda", backendDevice: CONFIRMED_LABEL, useGpu: true, model: "/x/y.safetensors" },
      loading: { active: false, phase: "Ready", backendMode: "CUDA GPU", device: CONFIRMED_LABEL, model: "/x/y.safetensors" },
    } },
    options: { body: { selection: {
      cuda: { installed: true, available: true, reason: null, device: { index: 0, name: "NVIDIA GeForce RTX 5060 Laptop GPU", candidateName: null, pinned: true, identityConfirmed: true, initConfirmed: true, displayActive: false, vramGb: 8, source: "nvidia-smi", path: "/secret/sd" } },
      vulkan: { installed: false, available: false, reason: "not installed", device: null },
    } } },
    progress: { body: { active: false, backendDevice: CONFIRMED_LABEL, backendMode: "CUDA GPU" } },
  });
  try {
    const result = await capture.checkLocalApi({ port: app.port, timeoutMs: 1000 });
    assert.equal(result.reachable, true);
    assert.deepEqual(app.seen.sort(), ["/api/backend-options", "/api/backend-status", "/api/generation-progress"]);
    assert.equal(result.configuredSettings.backendType, "cuda");
    assert.equal(result.configuredSettings.useGpu, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result.configuredSettings, "model"), false, "the model path is not copied");
    assert.equal(result.backendReportedSelection.confirmed, true);
    assert.equal(result.backendReportedSelection.loggedDeviceLabel, CONFIRMED_LABEL);
    assert.equal(result.backendReportedSelection.cuda.device.name, "NVIDIA GeForce RTX 5060 Laptop GPU");
    assert.equal(result.backendReportedSelection.cuda.device.identityConfirmed, true);
    assert.equal(result.backendReportedSelection.cuda.device.initConfirmed, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result.backendReportedSelection.cuda.device, "path"), false, "no other fields are copied");
    assert.equal(result.lastGenerationDevice.recorded, false, "the app does not record a per-generation device");
    assert.equal(result.lastGenerationDevice.generationActive, false);
    assert.equal(result.lastGenerationDevice.currentBackendLabel, CONFIRMED_LABEL);
    assert.equal(JSON.stringify(result).includes("/secret/sd"), false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test("local API: a 'not confirmed' device label does not count as confirmed by the backend", async () => {
  const app = await startFakeApp({
    status: { body: { ready: false, running: false, settings: { backendType: "cuda", useGpu: true }, loading: { device: "Automatic device selection (device not confirmed)" } } },
    options: { body: { selection: {} } },
    progress: { body: { active: false, backendDevice: "" } },
  });
  try {
    const result = await capture.checkLocalApi({ port: app.port, timeoutMs: 1000 });
    assert.equal(result.backendReportedSelection.confirmed, false);
    assert.equal(result.backendReportedSelection.cuda, null);
    assert.equal(result.lastGenerationDevice.currentBackendLabel, null);
    const report = capture.buildEvidenceReport({ capturedAt: "2026-10-18T10:00:00.000Z", platform: "linux", nvidiaSmi: RTX_SMI, backends: [], localApi: result });
    assert.match(report.summary.join("\n"), /not confirmed by the backend's log/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test("local API: a failed backend-options read does not fail the status read or the capture", async () => {
  const app = await startFakeApp({
    status: { body: { ready: true, running: true, settings: { backendType: "cuda", useGpu: true }, loading: { device: CONFIRMED_LABEL } } },
    options: { httpStatus: 500, body: {} },
    progress: { httpStatus: 500, body: {} },
  });
  try {
    const result = await capture.checkLocalApi({ port: app.port, timeoutMs: 1000 });
    assert.equal(result.reachable, true);
    assert.equal(result.configuredSettings.backendType, "cuda");
    assert.equal(result.backendReportedSelection.confirmed, true, "the log-confirmed label is still reported");
    assert.equal(result.backendReportedSelection.optionsReachable, false);
    assert.equal(result.backendReportedSelection.optionsError, "HTTP 500");
    assert.equal(result.lastGenerationDevice.progressReachable, false);
    assert.equal(result.lastGenerationDevice.recorded, false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test("local API: no read uses refresh or a query string, and an unreachable status skips the rest", async () => {
  const paths = [];
  const failing = async ({ path: requestPath }) => { paths.push(requestPath); throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
  const result = await capture.checkLocalApi({ port: 1, timeoutMs: 500, request: failing });
  assert.equal(result.reachable, false);
  assert.deepEqual(paths, ["/api/backend-status"], "the other reads are skipped when the status read fails");
  assert.equal(result.configuredSettings, null);
  assert.equal(result.backendReportedSelection, null);
  assert.equal(result.lastGenerationDevice, null);

  const paths2 = [];
  const ok = async ({ path: requestPath }) => {
    paths2.push(requestPath);
    return { status: 200, body: JSON.stringify({ ready: false, running: false, settings: {}, loading: {}, selection: {} }), bodyTruncated: false };
  };
  await capture.checkLocalApi({ port: 1, timeoutMs: 500, request: ok });
  assert.deepEqual(paths2, ["/api/backend-status", "/api/backend-options", "/api/generation-progress"]);
  for (const requestPath of paths2) {
    assert.doesNotMatch(requestPath, /refresh/i);
    assert.equal(requestPath.includes("?"), false, "no query string is sent");
  }
});

test("local API: a closed port is recorded as not reachable, and the check does not throw", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const result = await capture.checkLocalApi({ port, timeoutMs: 1000 });
  assert.equal(result.reachable, false);
  assert.equal(result.configuredSettings, null);
  assert.ok(result.error);
  const report = capture.buildEvidenceReport({
    capturedAt: "2026-10-17T10:00:00.000Z", platform: "linux", nvidiaSmi: RTX_SMI, backends: [], localApi: result,
  });
  assert.match(report.summary.join("\n"), /Local API: not reachable/);
  assert.match(report.summary.join("\n"), /did not depend on it/);
});

test("local API: a server that never answers is cut off by the short timeout", async () => {
  const server = http.createServer(() => { /* never responds */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const started = Date.now();
  try {
    const result = await capture.checkLocalApi({ port, timeoutMs: 200 });
    assert.equal(result.reachable, false);
    assert.match(result.error, /no response within 200 ms/);
    assert.ok(Date.now() - started < 5000, "the check must not wait for the server");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local API: a non-JSON body is recorded as reachable but unreadable", async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end("<html>not json</html>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await capture.checkLocalApi({ port, timeoutMs: 1000 });
    assert.equal(result.reachable, true);
    assert.equal(result.configuredSettings, null);
    assert.match(result.error, /not JSON/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local API: the port must be a valid number, and the default comes from the app's own settings", () => {
  assert.match(capture.parseArgs(["--api-port", "0"]).errors[0], /--api-port must be a port number/);
  assert.match(capture.parseArgs(["--api-port", "abc"]).errors[0], /--api-port must be a port number/);
  assert.deepEqual(capture.parseArgs(["--api-port", "1420"]).errors, []);
  assert.equal(capture.parseArgs(["--api-port", "1420"]).apiPort, 1420);
});

// ── CLI (real child process; Linux and macOS only) ────────────────────────────────

function writeFakeBackend(dir, name, script) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

const SKIP_WINDOWS = process.platform === "win32" ? "Not run on Windows: this test uses a POSIX shell fake." : false;

test("CLI: a backend that rejects --backend is probed without it, and the report file is written", { skip: SKIP_WINDOWS }, () => {
  const dir = tempDir("cli");
  const outDir = path.join(dir, "out");
  const fake = writeFakeBackend(dir, "sd-cuda", [
    'case "$*" in',
    '  *--backend*) echo "error: unknown argument \'--backend\'"; exit 1 ;;',
    "esac",
    'echo "stable-diffusion.cpp"',
    'echo "error: could not open __backend_probe_missing__.safetensors"',
    "exit 1",
  ].join("\n"));
  const result = spawnSync(process.execPath, [SCRIPT, "--out", outDir, "--cuda", fake], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Report written to/);
  assert.match(result.stdout, /does not show that an image was generated/);
  const files = fs.readdirSync(outDir);
  assert.equal(files.length, 1, "exactly one report file, and nothing else, is created");
  const report = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), "utf8"));
  const probe = report.backends[0].probes[0];
  assert.equal(probe.stage, "fallback");
  assert.equal(probe.supportsFlags, false);
  assert.equal(report.hardwareVerified, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI: a backend that accepts --backend is probed with it and reports the device as initialized", { skip: SKIP_WINDOWS }, () => {
  const dir = tempDir("cli-pinned");
  const fake = writeFakeBackend(dir, "sd-cuda", [
    'echo "ggml_cuda_init: found 1 CUDA devices"',
    'echo "stable-diffusion.cpp"',
    'echo "loading model from x"',
    'echo "error: model file not found"',
    "exit 1",
  ].join("\n"));
  const result = spawnSync(process.execPath, [SCRIPT, "--out", path.join(dir, "out"), "--cuda", fake], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const files = fs.readdirSync(path.join(dir, "out"));
  const report = JSON.parse(fs.readFileSync(path.join(dir, "out", files[0]), "utf8"));
  assert.equal(report.backends[0].probes[0].stage, "primary");
  assert.equal(report.backends[0].probes[0].initConfirmed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI: bad arguments exit with code 2 and write nothing", () => {
  const dir = tempDir("cli-bad");
  const result = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown argument: --bogus/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI: a missing backend is reported in the output, and the run still succeeds", { skip: SKIP_WINDOWS }, () => {
  const dir = tempDir("cli-missing");
  const result = spawnSync(process.execPath, [
    SCRIPT, "--out", path.join(dir, "out"), "--cuda", path.join(dir, "absent-sd-cuda"), "--vulkan", path.join(dir, "absent-sd-vulkan"),
  ], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cuda: The backend binary is not present/);
  fs.rmSync(dir, { recursive: true, force: true });
});
