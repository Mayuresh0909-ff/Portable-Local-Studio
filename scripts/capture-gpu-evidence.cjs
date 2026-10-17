#!/usr/bin/env node
// capture-gpu-evidence.cjs — records what the GPU and the bundled CUDA/Vulkan backends report here.
//
// What it does:
//   1. Runs nvidia-smi with the same query the server uses, and records the devices it reports.
//   2. For each bundled backend binary that exists, runs the same deliberate probe the server runs.
//      The model path is missing on purpose. The backend creates its device context and exits.
//      No model is loaded and no image is generated.
//   3. Writes one JSON report (it never overwrites an earlier report) and prints a short summary.
//
// What it does NOT do: change drivers or Windows settings, download anything, or write to
// app/models. The only file it creates is the report, in the output folder.
//
// What the report can and cannot show:
//   - "initialized" means the backend's own output reported that it reached model loading on that
//     device. It does not prove that an image was generated on that device.
//   - hardwareVerified is always false. Only a real run on the target machine can change that, and
//     this script does not claim it.
//
// Usage (from the repository root):
//   node scripts/capture-gpu-evidence.cjs [--out <dir>] [--cuda <binary>] [--vulkan <binary>]
// Defaults: --out is gpu-evidence/ under the repository root. Binaries come from app/backend/.
// Exit codes: 0 = report written, 1 = report could not be written, 2 = bad arguments.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MODELS_DIR = path.join(ROOT, "app", "models");
const DEFAULT_OUT_DIR = path.join(ROOT, "gpu-evidence");
const SCHEMA = "gpu-evidence/1";
const MISSING_MODEL_NAME = "__backend_probe_missing__.safetensors";
const MAX_VULKAN_INDEX_PROBES = 8;
const OUTPUT_TAIL_CHARS = 2000;

const gpu = require("./server/gpu-selection.cjs");
const { queryNvidiaSmi, runBackendProbeProcess } = require("./server/gpu-probe-runner.cjs");
const { createBackendPaths } = require("./server/backend-paths.cjs");

const USAGE = `Usage: node scripts/capture-gpu-evidence.cjs [--out <dir>] [--cuda <binary>] [--vulkan <binary>]

Writes gpu-evidence-<time>.json to <dir> (default: ${path.relative(process.cwd(), DEFAULT_OUT_DIR) || "gpu-evidence"}).
Runs nvidia-smi and one missing-model probe per device. Does not load a model or generate an image.
`;

// ── Arguments ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { outDir: null, cuda: null, vulkan: null, help: false, errors: [] };
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

// Runs one device probe through the same sequence the server uses. Returns a plain record.
function probeDevice({ kind, binaryPath, cliName, missingModelPath, platform, run }) {
  let lastResult = { exitCode: null, errorCode: null };
  const recordingRun = (file, args, options) => {
    lastResult = run(file, args, options);
    return lastResult;
  };
  const env = gpu.buildBackendProbeEnv({
    baseEnv: process.env,
    backendName: kind,
    platform,
    libraryDir: path.dirname(binaryPath),
  });
  const { verdict, supportsFlags } = gpu.runBackendProbeSequence({
    run: recordingRun,
    binaryPath,
    cliName,
    missingModelPath,
    platform,
    spawnOptions: gpu.buildBackendProbeSpawnOptions(env),
  });
  const output = String(verdict.output || "");
  const probe = {
    cliName,
    accepted: verdict.accepted === true,
    initConfirmed: verdict.initConfirmed === true,
    notFound: verdict.notFound === true,
    probeError: verdict.probeError || null,
    deviceFailure: verdict.deviceFailure === true,
    reason: verdict.reason || null,
    note: verdict.note || null,
    stage: supportsFlags ? "primary" : "fallback",
    supportsFlags,
    exitCode: lastResult.exitCode === undefined ? null : lastResult.exitCode,
    errorCode: lastResult.errorCode || null,
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
  };
  probe.summary = describeProbe(probe);
  return probe;
}

// Probes one backend kind. CUDA uses the indices nvidia-smi reported, or cuda0 if there are none.
// Vulkan has no list to read from here, so it counts up until a device is reported missing.
function probeBackend({ kind, binaryPath, cudaIndices, platform, run, missingModelPath }) {
  if (!binaryPath) {
    return { kind, path: null, present: false, note: `No ${kind} backend is bundled for ${platform}.`, probes: [] };
  }
  if (!fs.existsSync(binaryPath)) {
    return { kind, path: binaryPath, present: false, note: "The backend binary is not present.", probes: [] };
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
    });
    probe.index = index;
    probes.push(probe);
    if (kind === "vulkan" && probe.notFound) break;
  }
  return { kind, path: binaryPath, present: true, note: null, probes };
}

// ── Report ───────────────────────────────────────────────────────────────────────

function buildEvidenceReport({ capturedAt, platform, nvidiaSmi, backends, notes = [] }) {
  const smi = nvidiaSmi || { ok: false, devices: [], error: "nvidia-smi was not queried." };
  return {
    schema: SCHEMA,
    capturedAt,
    platform,
    hardwareVerified: false,
    statement: "Evidence from a missing-model probe and nvidia-smi. An initialized device is not proof that an image was generated on it. Real generation on the target machine is required.",
    nvidiaSmi: {
      ok: smi.ok === true,
      command: smi.command || null,
      error: smi.error || null,
      devices: Array.isArray(smi.devices) ? smi.devices : [],
    },
    backends,
    summary: [
      ...(smi.ok ? [`nvidia-smi: ${smi.devices.length} device(s).`] : [`nvidia-smi: not available (${smi.error || "no reason reported"}).`]),
      ...backends.flatMap((backend) => {
        if (!backend.present) return [`${backend.kind}: ${backend.note}`];
        return backend.probes.map((probe) => `${backend.kind}: ${probe.summary}`);
      }),
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
  const backends = [
    probeBackend({ kind: "cuda", binaryPath: cuda || defaults.cuda, cudaIndices, platform, run, missingModelPath }),
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

function main(argv) {
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
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  parseArgs,
  defaultBackendBinaries,
  probeDevice,
  probeBackend,
  buildEvidenceReport,
  captureGpuEvidence,
  writeEvidenceReport,
  main,
  SCHEMA,
};
