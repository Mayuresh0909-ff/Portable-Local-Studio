#!/usr/bin/env node
// capture-gpu-evidence.cjs — records what the GPU and the bundled CUDA/Vulkan backends report here.
//
// What it does:
//   1. Runs nvidia-smi with the same queries the server uses. Each query attempt is recorded, with
//      its raw stdout and stderr, so a rejected field stays visible.
//   2. For each bundled backend binary that exists, runs the same deliberate probe the server runs.
//      The model path is missing on purpose. The backend creates its device context and exits.
//      No model is loaded and no image is generated. Every attempt is recorded separately: the
//      primary attempt and, if the backend rejects device flags, the fallback attempt. Each one
//      keeps its arguments, exit code, timeout or spawn error, stdout, and stderr.
//   3. Reads the backend version only from a version line in the probe output. It does not run
//      --version, and it never derives a version from a file name.
//   4. If the local app API is running on loopback, reads the selected backend and device from
//      /api/backend-status with a short timeout. If the API is not reachable, the capture still runs.
//   5. Writes one JSON report (it never overwrites an earlier report) and prints a short summary.
//
// What it does NOT do: change drivers or Windows settings, download anything, or write to
// app/models or app config. The only file it creates is the report, in the output folder.
//
// Redaction: absolute paths in the report are replaced with <repo>, ~, C:\Users\<user>, or
// /home/<user>, where practical. Long streams are cut to a head and a tail, and the report says so.
//
// What the report can and cannot show:
//   - "initialized" means the backend's own output reported that it reached model loading on that
//     device. It does not prove that an image was generated on that device.
//   - hardwareVerified is always false. Only a real run on the target machine can change that, and
//     this script does not claim it.
//
// Usage (from the repository root):
//   node scripts/capture-gpu-evidence.cjs [--out <dir>] [--cuda <binary>] [--vulkan <binary>] [--api-port <port>]
// Defaults: --out is gpu-evidence/ under the repository root. Binaries come from app/backend/.
// --api-port defaults to PORT, then FRONTEND_PORT, then 1420 (the app's own defaults).
// Exit codes: 0 = report written, 1 = report could not be written, 2 = bad arguments.

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MODELS_DIR = path.join(ROOT, "app", "models");
const DEFAULT_OUT_DIR = path.join(ROOT, "gpu-evidence");
const SCHEMA = "gpu-evidence/2";
const MISSING_MODEL_NAME = "__backend_probe_missing__.safetensors";
const MAX_VULKAN_INDEX_PROBES = 8;
const OUTPUT_TAIL_CHARS = 2000;
const STREAM_HEAD_CHARS = 6000;
const STREAM_TAIL_CHARS = 2000;
const VERSION_SCAN_LINES = 200;
const VERSION_LINE_CHARS = 300;
const LOCAL_API_HOST = "127.0.0.1"; // fixed: the API read never leaves loopback
const LOCAL_API_PATH = "/api/backend-status";
const LOCAL_API_TIMEOUT_MS = 1500;
const LOCAL_API_BODY_CHARS = 64 * 1024;
const DEFAULT_API_PORT = 1420;

const gpu = require("./server/gpu-selection.cjs");
const { queryNvidiaSmi, runBackendProbeProcess } = require("./server/gpu-probe-runner.cjs");
const { createBackendPaths } = require("./server/backend-paths.cjs");

const USAGE = `Usage: node scripts/capture-gpu-evidence.cjs [--out <dir>] [--cuda <binary>] [--vulkan <binary>] [--api-port <port>]

Writes gpu-evidence-<time>.json to <dir> (default: ${path.relative(process.cwd(), DEFAULT_OUT_DIR) || "gpu-evidence"}).
Runs nvidia-smi and one missing-model probe per device. Does not load a model or generate an image.
Reads /api/backend-status on 127.0.0.1 if the app is running (default port ${DEFAULT_API_PORT}).
`;

// ── Redaction and bounding ───────────────────────────────────────────────────────

// Replaces absolute user paths with placeholders. Pure: the root and home folder are parameters.
function redactText(text, { root = ROOT, home = os.homedir() } = {}) {
  let out = String(text === undefined || text === null ? "" : text);
  const replaceAll = (needle, replacement) => {
    if (needle && needle.length > 3) out = out.split(needle).join(replacement);
  };
  replaceAll(root, "<repo>");
  replaceAll(home, "~");
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"'<>|]+/g, "C:\\Users\\<user>");
  out = out.replace(/\/(home|Users)\/[^/\s"'<>|:]+/g, "/$1/<user>");
  return out;
}

// Redacts, then keeps a head and a tail when the text is long. The result says whether it was cut.
function boundText(text, { head = STREAM_HEAD_CHARS, tail = STREAM_TAIL_CHARS } = {}) {
  const redacted = redactText(text);
  if (redacted.length <= head + tail) {
    return { text: redacted, truncated: false, originalChars: redacted.length };
  }
  const omitted = redacted.length - head - tail;
  return {
    text: `${redacted.slice(0, head)}\n...[truncated: ${omitted} characters omitted]...\n${redacted.slice(-tail)}`,
    truncated: true,
    originalChars: redacted.length,
  };
}

// ── Backend version (from probe output only) ─────────────────────────────────────

const VERSION_PATTERN = /\bversion\s*[:=]?\s*v?([A-Za-z0-9][A-Za-z0-9._+-]{0,39})/i;

// Finds a "version: <value>" line that contains a digit. Scans a bounded number of lines and does
// not run anything. Returns { value, evidence } or null.
function extractBackendVersion(text) {
  const lines = String(text || "").split(/\r?\n/).slice(0, VERSION_SCAN_LINES);
  for (const line of lines) {
    const clipped = line.slice(0, VERSION_LINE_CHARS);
    const match = clipped.match(VERSION_PATTERN);
    if (match && /\d/.test(match[1])) {
      return { value: match[1], evidence: redactText(clipped.trim()) };
    }
  }
  return null;
}

// Version record for a backend. It never comes from a file name, and --version is never run.
function describeBackendVersion(probes) {
  for (const probe of probes) {
    if (probe.backendVersion && probe.backendVersion.value) {
      return { ...probe.backendVersion, determined: true };
    }
  }
  return {
    value: null,
    determined: false,
    method: "version line in probe output",
    evidence: null,
    note: "Not printed in the probe output. The backend was not asked for --version because its support for that flag is unknown, and a binary that ignores unknown flags could start a server.",
  };
}

// ── Arguments ────────────────────────────────────────────────────────────────────

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseArgs(argv) {
  const options = { outDir: null, cuda: null, vulkan: null, apiPort: null, help: false, errors: [] };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options.errors.push(`${flag} needs a value.`);
      return index;
    }
    return index + 1;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out") { options.outDir = argv[i + 1]; i = takeValue(arg, i); }
    else if (arg === "--cuda") { options.cuda = argv[i + 1]; i = takeValue(arg, i); }
    else if (arg === "--vulkan") { options.vulkan = argv[i + 1]; i = takeValue(arg, i); }
    else if (arg === "--api-port") {
      const value = argv[i + 1];
      i = takeValue(arg, i);
      if (value !== undefined && !value.startsWith("--")) {
        options.apiPort = parsePort(value);
        if (options.apiPort === null) options.errors.push(`--api-port must be a port number from 1 to 65535.`);
      }
    }
    else options.errors.push(`Unknown argument: ${arg}`);
  }
  return options;
}

// ── Backend binaries ─────────────────────────────────────────────────────────────

// Default binaries for a platform. Only CUDA and Vulkan are probed here.
function defaultBackendBinaries(platform, root = ROOT) {
  const paths = createBackendPaths(root);
  if (platform === "win32") return { cuda: paths.cuda, vulkan: paths.vulkan };
  if (platform === "linux") return { cuda: paths.linuxCuda, vulkan: paths.linuxVulkan };
  return { cuda: null, vulkan: null };
}

// ── Probes ───────────────────────────────────────────────────────────────────────

function describeProbe(probe) {
  if (probe.accepted && probe.initConfirmed) return `${probe.cliName}: accepted; reached model loading on this device.`;
  if (probe.accepted) return `${probe.cliName}: accepted; the output did not confirm the device initialized.`;
  if (probe.probeError) return `${probe.cliName}: no verdict (${probe.probeError}): ${probe.reason || ""}`.trim();
  if (probe.notFound) return `${probe.cliName}: device not present.`;
  return `${probe.cliName}: rejected: ${probe.reason || "no reason reported"}`;
}

// One attempt as recorded in the report. A run that returned only a combined `output` (no separate
// streams) is recorded with combinedOnly: true, so the report does not invent a stderr split.
function recordAttempt({ stage, args, result }) {
  const r = result || {};
  const combinedOnly = r.stdout === undefined && r.stderr === undefined;
  const errorCode = r.errorCode || null;
  return {
    stage,
    args: (args || []).map((arg) => redactText(arg)),
    exitCode: r.exitCode === undefined ? null : r.exitCode,
    errorCode,
    timedOut: r.timedOut === true || errorCode === "ETIMEDOUT",
    combinedOnly,
    stdout: boundText(combinedOnly ? r.output : r.stdout),
    stderr: combinedOnly ? null : boundText(r.stderr),
  };
}

// Device identity for a CUDA probe, taken from the nvidia-smi device with the same index.
function deviceForIndex(devices, index) {
  const device = (devices || []).find((item) => item.index === index);
  if (!device) return null;
  return {
    index: device.index,
    name: device.name ?? null,
    busId: device.busId ?? null,
    memoryTotalGb: device.vramGb ?? null,
    memoryFreeGb: device.freeVramGb ?? null,
    displayActive: device.displayActive ?? null,
    driverVersion: device.driverVersion ?? null,
    computeCap: device.computeCap ?? null,
  };
}

// Runs one device probe through the same sequence the server uses. Returns a plain record.
function probeDevice({ kind, binaryPath, cliName, missingModelPath, platform, run, index = null, devices = null }) {
  const env = gpu.buildBackendProbeEnv({
    baseEnv: process.env,
    backendName: kind,
    platform,
    libraryDir: path.dirname(binaryPath),
  });
  const { verdict, supportsFlags, attempts } = gpu.runBackendProbeSequence({
    run,
    binaryPath,
    cliName,
    missingModelPath,
    platform,
    spawnOptions: gpu.buildBackendProbeSpawnOptions(env),
  });
  const last = attempts[attempts.length - 1].result || {};
  const output = String(verdict.output || "");
  const recorded = attempts.map(recordAttempt);
  // The version is read from the raw output of each attempt, in order, before any bounding.
  const backendVersion = attempts
    .map((attempt) => extractBackendVersion(attempt.result && (attempt.result.output || `${attempt.result.stdout || ""}\n${attempt.result.stderr || ""}`)))
    .find(Boolean) || null;
  const probe = {
    cliName,
    index,
    device: kind === "cuda" ? deviceForIndex(devices, index) : null,
    accepted: verdict.accepted === true,
    initConfirmed: verdict.initConfirmed === true,
    notFound: verdict.notFound === true,
    probeError: verdict.probeError || null,
    deviceFailure: verdict.deviceFailure === true,
    reason: verdict.reason || null,
    note: verdict.note || null,
    stage: supportsFlags ? "primary" : "fallback",
    supportsFlags,
    exitCode: last.exitCode === undefined ? null : last.exitCode,
    errorCode: last.errorCode || null,
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
    attempts: recorded,
    backendVersion: backendVersion ? { value: backendVersion.value, method: "version line in probe output", evidence: backendVersion.evidence } : null,
  };
  probe.summary = describeProbe(probe);
  return probe;
}

// Probes one backend kind. CUDA uses the indices nvidia-smi reported, or cuda0 if there are none.
// Vulkan has no list to read from here, so it counts up until a device is reported missing.
function probeBackend({ kind, binaryPath, cudaIndices, platform, run, missingModelPath, nvidiaDevices = null }) {
  if (!binaryPath) {
    return { kind, path: null, present: false, note: `No ${kind} backend is bundled for ${platform}.`, version: null, probes: [] };
  }
  if (!fs.existsSync(binaryPath)) {
    return { kind, path: redactText(binaryPath), present: false, note: "The backend binary is not present.", version: null, probes: [] };
  }
  const probes = [];
  const indices = kind === "cuda" ? cudaIndices : Array.from({ length: MAX_VULKAN_INDEX_PROBES }, (_, i) => i);
  for (const index of indices) {
    const probe = probeDevice({
      kind,
      binaryPath,
      cliName: `${kind}${index}`,
      missingModelPath,
      platform,
      run,
      index,
      devices: nvidiaDevices,
    });
    probes.push(probe);
    if (kind === "vulkan" && probe.notFound) break;
  }
  return {
    kind,
    path: redactText(binaryPath),
    present: true,
    note: null,
    version: describeBackendVersion(probes),
    probes,
  };
}

// ── nvidia-smi record ────────────────────────────────────────────────────────────

// Explicit fields for each NVIDIA device. Unavailable values are null, never missing.
function nvidiaDeviceRecord(device) {
  return {
    index: device.index,
    name: device.name ?? null,
    busId: device.busId ?? null,
    memoryTotalGb: device.vramGb ?? null,
    memoryFreeGb: device.freeVramGb ?? null,
    displayActive: device.displayActive ?? null,
    driverVersion: device.driverVersion ?? null,
    computeCap: device.computeCap ?? null,
  };
}

function nvidiaSmiRecord(smi) {
  return {
    ok: smi.ok === true,
    command: smi.command ? redactText(smi.command) : null,
    error: smi.error ? redactText(smi.error) : null,
    devices: Array.isArray(smi.devices) ? smi.devices.map(nvidiaDeviceRecord) : [],
    attempts: (smi.attempts || []).map((attempt) => ({
      command: redactText(attempt.command),
      query: attempt.query,
      exitCode: attempt.exitCode === undefined ? null : attempt.exitCode,
      errorCode: attempt.errorCode || null,
      stdout: boundText(attempt.stdout),
      stderr: boundText(attempt.stderr),
    })),
  };
}

function describeNvidiaDevice(device) {
  const parts = [`index ${device.index}: ${device.name ?? "unnamed"}`];
  if (device.busId) parts.push(`bus ${device.busId}`);
  parts.push(`driver ${device.driverVersion ?? "not reported"}`);
  parts.push(`compute capability ${device.computeCap ?? "not reported"}`);
  return parts.join(", ");
}

// ── Local API (optional, loopback only) ──────────────────────────────────────────

// One GET on loopback with a timeout. Resolves { status, body } or rejects with an error.
// The body read is bounded. A longer body is cut and the flag says so.
function getLoopbackJson({ port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: LOCAL_API_HOST, port, path: LOCAL_API_PATH, timeout: timeoutMs }, (res) => {
      let body = "";
      let truncated = false;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < LOCAL_API_BODY_CHARS) body += chunk;
        else truncated = true;
      });
      res.on("end", () => resolve({ status: res.statusCode, body, bodyTruncated: truncated || body.length > LOCAL_API_BODY_CHARS }));
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(Object.assign(new Error(`no response within ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
    });
    req.on("error", reject);
  });
}

// Reads the selected backend and device from the running app. Never throws and never rejects. A
// failure is recorded as reachable: false, and the capture carries on.
async function checkLocalApi({ port, timeoutMs = LOCAL_API_TIMEOUT_MS, request = getLoopbackJson } = {}) {
  const url = `http://${LOCAL_API_HOST}:${port}${LOCAL_API_PATH}`;
  try {
    const response = await request({ port, timeoutMs });
    const record = { checked: true, url, reachable: true, httpStatus: response.status ?? null, bodyTruncated: response.bodyTruncated === true };
    if (response.status !== 200) return { ...record, selected: null, error: `HTTP ${response.status}` };
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { ...record, selected: null, error: "The response was not JSON." };
    }
    const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
    return {
      ...record,
      selected: {
        backendType: settings.backendType ?? null,
        backendDevice: settings.backendDevice ?? null,
        useGpu: settings.useGpu ?? null,
      },
      ready: parsed.ready ?? null,
      running: parsed.running ?? null,
      errorCategory: parsed.errorCategory ?? null,
      error: parsed.error ? boundText(parsed.error, { head: 500, tail: 200 }) : null,
    };
  } catch (error) {
    return {
      checked: true,
      url,
      reachable: false,
      httpStatus: null,
      selected: null,
      error: redactText(error && error.message ? error.message : String(error)),
    };
  }
}

// ── Report ───────────────────────────────────────────────────────────────────────

function buildEvidenceReport({ capturedAt, platform, nvidiaSmi, backends, notes = [], localApi = null }) {
  const smi = nvidiaSmi || { ok: false, devices: [], attempts: [], error: "nvidia-smi was not queried." };
  const smiRecord = nvidiaSmiRecord(smi);
  return {
    schema: SCHEMA,
    capturedAt,
    platform,
    hardwareVerified: false,
    statement: "Evidence from a missing-model probe and nvidia-smi. An initialized device is not proof that an image was generated on it. Real generation on the target machine is required.",
    nvidiaSmi: smiRecord,
    localApi: localApi || { checked: false, reason: "The local API was not read." },
    backends,
    summary: [
      ...(smi.ok
        ? [`nvidia-smi: ${smiRecord.devices.length} device(s).`, ...smiRecord.devices.map((device) => `nvidia-smi ${describeNvidiaDevice(device)}`)]
        : [`nvidia-smi: not available (${smi.error || "no reason reported"}).`]),
      ...backends.flatMap((backend) => {
        if (!backend.present) return [`${backend.kind}: ${backend.note}`];
        const version = backend.version && backend.version.value
          ? `${backend.kind} backend version: ${backend.version.value}.`
          : `${backend.kind} backend version: could not be determined from the probe output.`;
        return [version, ...backend.probes.map((probe) => `${backend.kind}: ${probe.summary}`)];
      }),
      ...(localApi && localApi.checked
        ? [localApi.reachable
          ? `Local API: selected backend ${localApi.selected ? localApi.selected.backendType : "unknown"}.`
          : `Local API: not reachable (${localApi.error || "no reason reported"}). The capture did not depend on it.`]
        : []),
    ],
    notes,
  };
}

// Pure orchestration. Every process call goes through `query` and `run`, so tests can replace them.
function captureGpuEvidence({
  platform = process.platform,
  root = ROOT,
  cuda = null,
  vulkan = null,
  query = queryNvidiaSmi,
  run = runBackendProbeProcess,
  now = () => new Date(),
} = {}) {
  const defaults = defaultBackendBinaries(platform, root);
  const missingModelPath = path.join(MODELS_DIR, MISSING_MODEL_NAME);
  const nvidiaSmi = query({ platform });
  const cudaIndices = nvidiaSmi.ok && nvidiaSmi.devices.length
    ? nvidiaSmi.devices.map((device) => device.index).filter(Number.isInteger).slice(0, 8)
    : [0];
  const nvidiaDevices = nvidiaSmi.ok ? nvidiaSmi.devices : [];
  const backends = [
    probeBackend({ kind: "cuda", binaryPath: cuda || defaults.cuda, cudaIndices, platform, run, missingModelPath, nvidiaDevices }),
    probeBackend({ kind: "vulkan", binaryPath: vulkan || defaults.vulkan, cudaIndices, platform, run, missingModelPath }),
  ];
  const notes = [];
  if (!nvidiaSmi.ok) notes.push("nvidia-smi did not report devices, so CUDA was probed on index 0 only.");
  return buildEvidenceReport({
    capturedAt: now().toISOString(),
    platform,
    nvidiaSmi,
    backends,
    notes,
  });
}

// Writes the report without overwriting an existing file. Returns the path written.
function writeEvidenceReport(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.capturedAt.replace(/[:.]/g, "-");
  const file = path.join(outDir, `gpu-evidence-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return file;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.errors.length) {
    for (const error of options.errors) process.stderr.write(`${error}\n`);
    process.stderr.write(USAGE);
    return 2;
  }
  const report = captureGpuEvidence({
    cuda: options.cuda ? path.resolve(options.cuda) : null,
    vulkan: options.vulkan ? path.resolve(options.vulkan) : null,
  });
  const apiPort = options.apiPort
    || parsePort(process.env.PORT || process.env.FRONTEND_PORT)
    || DEFAULT_API_PORT;
  report.localApi = await checkLocalApi({ port: apiPort });
  report.summary = buildEvidenceReport({
    capturedAt: report.capturedAt,
    platform: report.platform,
    nvidiaSmi: report.nvidiaSmi,
    backends: report.backends,
    notes: report.notes,
    localApi: report.localApi,
  }).summary;
  const outDir = options.outDir ? path.resolve(options.outDir) : DEFAULT_OUT_DIR;
  let file;
  try {
    file = writeEvidenceReport(report, outDir);
  } catch (error) {
    process.stderr.write(`Could not write the report to ${outDir}: ${error.message}\n`);
    return 1;
  }
  for (const line of report.summary) process.stdout.write(`${line}\n`);
  process.stdout.write(`Report written to ${file}\n`);
  process.stdout.write("This run does not show that an image was generated on the GPU. See docs/gpu-selection/WINDOWS_ACCEPTANCE.md.\n");
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  parseArgs,
  defaultBackendBinaries,
  redactText,
  boundText,
  extractBackendVersion,
  describeBackendVersion,
  probeDevice,
  probeBackend,
  checkLocalApi,
  buildEvidenceReport,
  captureGpuEvidence,
  writeEvidenceReport,
  main,
  SCHEMA,
};
