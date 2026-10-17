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
