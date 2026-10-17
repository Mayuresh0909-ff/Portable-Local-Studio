// gpu-selection.cjs — pure GPU discovery parsing and image-backend device selection.
//
// The layers are kept separate on purpose:
//   1. Physical discovery   — what GPUs exist (Win32_VideoController, nvidia-smi, sysfs).
//                             Display attachment is recorded as information only.
//   2. Backend availability — whether the installed CUDA/Vulkan backend can initialize
//                             on a device. Decided by real init probes, never by name alone.
//   3. Device selection     — which of the usable devices is used for inference.
//                             Explicit user preferences win when valid; otherwise discrete
//                             GPUs are preferred over integrated ones, then larger VRAM, then index.
//
// This module performs no process or filesystem access. serve.cjs supplies probe results,
// which keeps the decision logic testable with mocked hardware data.

const MAX_PROBED_VULKAN_DEVICES = 8;
const MAX_PROBED_CUDA_DEVICES = 8;
// Every backend probe is capped at this time. Shared by serve.cjs and scripts/capture-gpu-evidence.cjs.
const PROBE_TIMEOUT_MS = 5000;
const PROBE_LISTEN_PORT = "18082";

// Names of GPUs that share system memory (APU/iGPU). Used only when the backend does not
// report an integrated/UMA flag itself.
const INTEGRATED_GPU_NAME_PATTERNS = [
  /\bRadeon\b(?:\(TM\))?\s+(?:Graphics|[2-8]\d{2}M)\b/i, // "Radeon Graphics", "Radeon 610M", "Radeon(TM) 780M"
  /\bVega\s+\d+\s+Graphics\b/i,                          // Ryzen 2000-5000 APUs
  /\bIntel\b.*\b(?:UHD|HD|Iris)\b/i,                     // Intel integrated families
  /\bIntel\b.*\bArc\b(?:\(TM\))?\s+Graphics\b/i,        // Meteor Lake "Intel(R) Arc(TM) Graphics"
];

const VIRTUAL_GPU_MARKERS = [
  "virtual desktop",
  "remote display",
  "microsoft basic render",
  "microsoft basic display",
  "citrix",
  "software rasterizer",
  "virtualbox",
  "vmware",
  "llvmpipe",
  "swiftshader",
  "lavapipe",
];

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\[[A-Z]/g, "");
}

function isVirtualOrSoftwareGpu(name) {
  const lower = String(name || "").toLowerCase();
  return VIRTUAL_GPU_MARKERS.some((marker) => lower.includes(marker));
}

function vendorFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (/nvidia|geforce|quadro|tesla/.test(lower)) return "nvidia";
  if (/\bamd\b|radeon|advanced micro devices/.test(lower)) return "amd";
  if (/\bintel\b/.test(lower)) return "intel";
  return "other";
}

function vendorFromPciId(vendorId) {
  switch (String(vendorId || "").trim().toLowerCase()) {
    case "0x10de": return "nvidia";
    case "0x1002": return "amd";
    case "0x8086": return "intel";
    default: return "other";
  }
}

function classifyGpuName(name) {
  const text = String(name || "");
  return {
    vendor: vendorFromName(text),
    integrated: INTEGRATED_GPU_NAME_PATTERNS.some((pattern) => pattern.test(text)),
    virtual: isVirtualOrSoftwareGpu(text),
  };
}

function numberOrNull(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function mibToGb(mib) {
  const value = numberOrNull(mib);
  return value === null ? null : Math.round((value / 1024) * 100) / 100;
}

function parseEnabledFlag(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "enabled") return true;
  if (text === "disabled") return false;
  return null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

// Parses Vulkan device lines printed by a stable-diffusion.cpp/ggml backend. Two formats are
// understood:
//   ggml init log : "ggml_vulkan: 0 = NVIDIA GeForce RTX 5060 Laptop GPU (NVIDIA) | uma: 0 | ..."
//   list output   : "Vulkan0: NVIDIA GeForce RTX 5060 Laptop GPU (8188 MiB, 7000 MiB free)"
function parseVulkanDeviceLog(output) {
  const text = String(output || "");
  const found = new Map();
  const add = (index, device) => {
    if (!found.has(index)) found.set(index, device);
  };

  const ggmlPattern = /ggml_vulkan:\s*(\d+)\s*=\s*(.+?)(?:\s*\([^)]*\))?\s*\|\s*uma:\s*(\d)/gi;
  let match;
  while ((match = ggmlPattern.exec(text)) !== null) {
    const index = Number(match[1]);
    const name = match[2].trim();
    const classified = classifyGpuName(name);
    add(index, {
      index,
      name,
      vendor: classified.vendor,
      integrated: match[3] === "1" || classified.integrated,
      virtual: classified.virtual,
      vramGb: null,
      source: "ggml-log",
    });
  }

  const listPattern = /Vulkan(\d+)\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
  while ((match = listPattern.exec(text)) !== null) {
    const index = Number(match[1]);
    const name = match[2].trim();
    const classified = classifyGpuName(name);
    add(index, {
      index,
      name,
      vendor: classified.vendor,
      integrated: classified.integrated,
      virtual: classified.virtual,
      vramGb: mibToGb(match[3]),
      freeVramGb: mibToGb(match[4]),
      source: "vulkan-list",
    });
  }

  return [...found.values()].sort((a, b) => a.index - b.index);
}

// Parses `vulkaninfo --summary` output (used as a secondary source on Linux).
function parseVulkaninfoSummary(output) {
  const devices = [];
  let current = null;
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const gpuMatch = rawLine.match(/^\s*GPU(\d+)\s*:/i);
    if (gpuMatch) {
      current = { index: Number(gpuMatch[1]), name: "", type: "" };
      devices.push(current);
      continue;
    }
    if (!current) continue;
    const nameMatch = rawLine.match(/deviceName\s*=\s*(.+)$/i);
    if (nameMatch) current.name = nameMatch[1].trim();
    const typeMatch = rawLine.match(/deviceType\s*=\s*(.+)$/i);
    if (typeMatch) current.type = typeMatch[1].trim();
  }
  return devices
    .filter((device) => Number.isInteger(device.index) && device.name)
    .map((device) => {
      const classified = classifyGpuName(device.name);
      return {
        index: device.index,
        name: device.name,
        vendor: classified.vendor,
        integrated: /INTEGRATED_GPU/i.test(device.type) || classified.integrated,
        virtual: classified.virtual || /CPU/i.test(device.type),
        vramGb: null,
        source: "vulkaninfo",
      };
    });
}

// Parses CUDA device lines printed by a stable-diffusion.cpp/ggml CUDA backend:
//   ggml_cuda_init : "  Device 0: NVIDIA GeForce RTX 5060 Laptop GPU, compute capability 12.0, VMM: yes"
//   list output    : "CUDA0: NVIDIA GeForce RTX 5060 Laptop GPU (8188 MiB, 7000 MiB free)"
function parseCudaDeviceLog(output) {
  const text = String(output || "");
  const found = new Map();
  const add = (index, device) => {
    if (!found.has(index)) found.set(index, device);
  };

  let match;
  const initPattern = /Device\s+(\d+):\s*([^,\r\n]+?)\s*,\s*compute capability/gi;
  while ((match = initPattern.exec(text)) !== null) {
    const index = Number(match[1]);
    add(index, { index, name: match[2].trim(), vendor: vendorFromName(match[2]), integrated: false, vramGb: null, source: "cuda-log" });
  }

  const listPattern = /CUDA(\d+)\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
  while ((match = listPattern.exec(text)) !== null) {
    const index = Number(match[1]);
    add(index, {
      index,
      name: match[2].trim(),
      vendor: vendorFromName(match[2]),
      integrated: false,
      vramGb: mibToGb(match[3]),
      freeVramGb: mibToGb(match[4]),
      source: "cuda-list",
    });
  }

  return [...found.values()].sort((a, b) => a.index - b.index);
}

// Parses:
//   nvidia-smi --query-gpu=index,name,memory.total,memory.free,display_active,pci.bus_id[,driver_version,compute_cap]
//              --format=csv,noheader,nounits
// Missing or "[N/A]" fields become null. display_active is informational only. driver_version and
// compute_cap are optional trailing columns (older drivers omit them). They are information only,
// and selection does not use them.
function nvidiaSmiField(value, pattern) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return pattern.test(text) ? text : null;
}

function parseNvidiaSmiCsv(stdout) {
  const devices = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 2 || !/^\d+$/.test(parts[0] || "")) continue;
    devices.push({
      index: Number(parts[0]),
      name: parts[1] || "NVIDIA GPU",
      vendor: "nvidia",
      integrated: false,
      virtual: false,
      vramGb: mibToGb(parts[2]),
      freeVramGb: mibToGb(parts[3]),
      displayActive: parseEnabledFlag(parts[4]),
      busId: parts[5] || null,
      driverVersion: nvidiaSmiField(parts[6], /^\d+(\.\d+)+$/),
      computeCap: nvidiaSmiField(parts[7], /^\d+\.\d+$/),
      source: "nvidia-smi",
    });
  }
  return devices;
}

// Converts Win32_VideoController rows ({ Name, VRAM, DisplayAttached }) into inventory entries.
// AdapterRAM is a 32-bit field, so VRAM above 4 GB is under-reported by Windows.
function parseWindowsVideoControllers(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.Name === "string" && item.Name.trim())
    .map((item) => {
      const name = item.Name.trim();
      const classified = classifyGpuName(name);
      return {
        index: null,
        name,
        vendor: classified.vendor,
        integrated: classified.integrated,
        virtual: classified.virtual,
        vramGb: typeof item.VRAM === "number" ? item.VRAM : null,
        displayAttached: typeof item.DisplayAttached === "boolean" ? item.DisplayAttached : null,
        source: "win32-video-controller",
      };
    });
}

function findFirstErrorLine(output) {
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hit = lines.find((line) => /error|failed|not found|cannot|unable|unknown argument/i.test(line));
  return hit ? hit.slice(0, 240) : null;
}

// ── Ranking and preferences ───────────────────────────────────────────────────

function integratedRank(device) {
  if (device.integrated === true) return 2;
  if (device.integrated === false) return 0;
  return 1; // unknown: after known discrete devices, before known integrated ones
}

function compareDevices(a, b) {
  const rank = integratedRank(a.device) - integratedRank(b.device);
  if (rank) return rank;
  const vram = (b.device.vramGb || 0) - (a.device.vramGb || 0);
  if (vram) return vram;
  const indexA = Number.isInteger(a.device.index) ? a.device.index : Number.MAX_SAFE_INTEGER;
  const indexB = Number.isInteger(b.device.index) ? b.device.index : Number.MAX_SAFE_INTEGER;
  if (indexA !== indexB) return indexA - indexB;
  return a.position - b.position;
}

// Deterministic order for usable devices: discrete before integrated, then larger VRAM,
// then lower index, then original position. Virtual/software devices are excluded.
function rankGpuDevices(devices) {
  return (Array.isArray(devices) ? devices : [])
    .map((device, position) => ({ device, position }))
    .filter(({ device }) => !device.virtual)
    .sort(compareDevices)
    .map(({ device }) => device);
}

// Chooses the primary GPU for display and VRAM budgeting. This is not an inference decision.
function pickPrimaryGpu(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const ranked = rankGpuDevices(list);
  if (ranked.length) return ranked[0];
  return rankGpuDevices(list.map((device) => ({ ...device, virtual: false })))[0] || null;
}

// Parses SD_VULKAN_DEVICE / SD_CUDA_DEVICE. Accepts "1", "vulkan1", "cuda1".
// Returns null when unset, or { index, raw, valid } when set.
function parseDevicePreference(raw, kind) {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!text) return null;
  const pattern = kind === "cuda" ? /^(?:cuda)?\s*(\d+)$/i : /^(?:vulkan)?\s*(\d+)$/i;
  const match = text.match(pattern);
  return match ? { index: Number(match[1]), raw: text, valid: true } : { index: null, raw: text, valid: false };
}

// Returns the CLI device name and environment for a backend device, or null when no
// specific device is selected.
function backendDeviceArgs(kind, index) {
  if (!Number.isInteger(index) || index < 0) return null;
  return {
    cliName: `${kind}${index}`,
    // NVML/nvidia-smi enumerates GPUs in PCI bus order. CUDA defaults to "fastest first",
    // which can renumber devices on multi-GPU systems. Pinning PCI order keeps the
    // nvidia-smi index and the CUDA device index identical.
    env: kind === "cuda" ? { CUDA_DEVICE_ORDER: "PCI_BUS_ID" } : {},
  };
}

// Finds the device name a backend printed for a given index (used for reporting only).
function findDeviceNameInLog(output, kind, index) {
  const devices = kind === "cuda" ? parseCudaDeviceLog(output) : parseVulkanDeviceLog(output);
  const match = devices.find((device) => device.index === index);
  return match && match.name ? match.name : null;
}

// Decides the requested backend type. Explicit requests are honored only when available;
// otherwise the default is used and the reason is returned for the UI and logs.
function resolveRequestedBackend({ requested, available, defaultType, unavailableReasons = {} }) {
  const choice = String(requested || "auto");
  if (choice === "auto") return { resolved: defaultType, reason: null };
  if (available.has(choice)) return { resolved: choice, reason: null };
  const detail = unavailableReasons[choice];
  return {
    resolved: defaultType,
    reason: `Requested backend "${choice}" is not available${detail ? `: ${detail}` : "."} Using ${defaultType} instead.`,
  };
}

function describeGpuFallback({ cuda, vulkan }) {
  const reasons = [];
  if (cuda.installed && !cuda.available) reasons.push(`CUDA: ${cuda.reason || "unavailable"}`);
  if (vulkan.installed && !vulkan.available) reasons.push(`Vulkan: ${vulkan.reason || "unavailable"}`);
  if (!reasons.length) return "No GPU image backend is installed; using CPU.";
  return `No compatible GPU image backend is available (${reasons.join("; ")}). Using CPU.`;
}

// ── Backend probe output classification ───────────────────────────────────────
// Pure functions: they take the captured output and exit status of a backend launched with a
// deliberately missing model, and decide whether the device initialized. serve.cjs does the
// spawning and passes the results here.

// Explicit device, runtime, or kernel failures. Any match rejects the device, even when the output
// also contains "loading model". Each pattern is specific to a device or runtime error. Generic
// words such as "failed" alone are not patterns, to avoid rejecting a backend over benign warnings.
const DEVICE_FAILURE_PATTERNS = [
  // Vulkan
  /vkCreateDevice failed/i,
  /VK_ERROR_(INITIALIZATION_FAILED|DEVICE_LOST|INCOMPATIBLE_DRIVER|OUT_OF_DEVICE_MEMORY|FEATURE_NOT_PRESENT)/,
  /ggml_vulkan:[^\n]*\b(failed|error)\b/i,
  /(failed to|unable to) (create|init|initialize)\b[^\n]*\b(device|backend|gpu|vulkan|cuda)\b/i,
  /\b(device|backend|gpu|vulkan|cuda)\b[^\n]*\b(failed to|unable to) (create|init|initialize)\b/i,
  /no (usable |compatible )?(vulkan|cuda|gpu) devices?\b/i,
  /(vulkan|cuda|gpu) (device|backend) (is )?(unavailable|not available|lost)\b/i,
  // CUDA
  /CUDA error/i,
  /\bcudaError\w+/,
  /no kernel image is available/i,
  /no CUDA-capable device/i,
  /CUDA driver version is insufficient/i,
  /ggml_cuda_init:[^\n]*\b(failed|error)\b/i,
  /failed to initialize CUDA/i,
  // Runtime, DLL, and kernel compatibility
  /\b[\w.-]+\.dll\b[^\n]*\b(not found|missing|cannot find|could not be loaded|is not a valid)/i,
  /could not load [\w.-]+\.dll/i,
  /incompatible (driver|runtime|kernel|binary)/i,
];

// Output from the deliberate missing-model probe. Reaching this message means the backend started
// and got past argument parsing. It does not, by itself, prove the device initialized.
const MISSING_MODEL_PATTERNS = [
  /__backend_probe_missing__/,
  /(no such file or directory|cannot open|failed to open|could not open|does not exist|not found)[^\n]{0,200}\.(safetensors|gguf|ckpt|bin)\b/i,
  /\.(safetensors|gguf|ckpt)\b[^\n]{0,120}(no such file|does not exist|not found|cannot open|failed to open)/i,
  /model (file )?(not found|does not exist|is missing)/i,
];

function firstMatchingLine(output, patterns) {
  const lines = stripAnsi(String(output || "")).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && patterns.some((pattern) => pattern.test(trimmed))) return trimmed.slice(0, 240);
  }
  return null;
}

function findDeviceFailureLine(output) {
  return firstMatchingLine(output, DEVICE_FAILURE_PATTERNS);
}

function isMissingModelOutput(output) {
  return MISSING_MODEL_PATTERNS.some((pattern) => pattern.test(stripAnsi(String(output || ""))));
}

// True when the binary rejected --backend, so the probe must be retried without device flags.
function shouldRetryWithoutDeviceFlags(output) {
  const text = String(output || "");
  return text.includes("unknown argument") && text.includes("--backend");
}

// The device a backend uses when no device flag is passed is identified only if its own output
// lists exactly one device of that kind. With several devices listed, the backend's choice is not
// identified, so the result is null.
function confirmUnpinnedDevice(output, kind) {
  const devices = kind === "cuda" ? parseCudaDeviceLog(output) : parseVulkanDeviceLog(output);
  if (devices.length !== 1 || !devices[0].name) return null;
  return devices[0];
}

// Decides whether one probe run shows a usable device.
// Input: { output, exitCode, errorCode, platform, cliName, stage, supportsFlags }
//   errorCode: spawn error code such as "ETIMEDOUT" or "ENOENT", or null.
//   stage: "primary" (with device flags) or "fallback" (retry without device flags).
// Returns: { accepted, notFound?, reason?, probeError?, initConfirmed?, note?, validationError?,
//            output, supportsFlags, deviceFailure? }
//   probeError marks a probe that never produced a verdict (timeout, spawn error, no output).
//   Those are not ordinary rejections, so callers can report them as such.
function classifyBackendProbe({
  output = "",
  exitCode = null,
  errorCode = null,
  platform = "linux",
  cliName = null,
  stage = "primary",
  supportsFlags = true,
} = {}) {
  const text = stripAnsi(String(output || ""));
  const lower = text.toLowerCase();
  const subject = stage === "fallback" ? "The fallback probe without device flags" : "The probe";
  const base = { supportsFlags, output: text };
  const exitText = exitCode === null || exitCode === undefined ? "ended without an exit code" : `exited with code ${exitCode}`;

  if (errorCode === "ETIMEDOUT") {
    return { ...base, accepted: false, probeError: "timeout", reason: `${subject} timed out after ${PROBE_TIMEOUT_MS / 1000} seconds.` };
  }
  if (errorCode) {
    return { ...base, accepted: false, probeError: "start", reason: `${subject} could not be started (${errorCode}).` };
  }

  const unsignedExitCode = exitCode === null || exitCode === undefined ? null : Number(exitCode) >>> 0;
  if (platform === "win32" && unsignedExitCode === 0xC0000135) {
    return {
      ...base,
      accepted: false,
      validationError: true,
      reason: "Windows could not start this backend because a required DLL is missing (0xC0000135). Run scripts/setup/setup.ps1 to install the Microsoft Visual C++ runtime and repair the backend.",
    };
  }
  if (platform === "win32" && unsignedExitCode === 0xC000001D) {
    return {
      ...base,
      accepted: false,
      validationError: true,
      reason: "This Windows backend used a CPU instruction that this processor does not support (0xC000001D). Run scripts/setup/setup.ps1 to replace it with the runtime-dispatched backend build.",
    };
  }

  if (/backend '[^']*' was not found/i.test(text)) {
    return { ...base, accepted: false, notFound: true, reason: `Device ${cliName || "requested"} is not present.` };
  }
  if (lower.includes("backend config failed")) {
    return { ...base, accepted: false, reason: findFirstErrorLine(text) || `Backend ${cliName || ""} could not be configured.` };
  }
  // Dynamic linker and glibc failures: the binary cannot run on this system at all.
  if (lower.includes("glibc") || lower.includes("libc.so") || lower.includes("libstdc++") || lower.includes("cannot open shared object")) {
    return { ...base, accepted: false, reason: findFirstErrorLine(text) || "A required shared library is missing or incompatible." };
  }

  // An explicit device failure wins over every success marker below.
  const deviceFailure = findDeviceFailureLine(text);
  if (deviceFailure) {
    return { ...base, accepted: false, deviceFailure: true, reason: deviceFailure };
  }

  const reachedModelLoad = /loading model/i.test(text);
  const banner = /stable-diffusion\.cpp/i.test(text);
  const missingModel = isMissingModelOutput(text);
  const notConfirmedNote = "The output shows the backend started, but not that the device initialized.";

  if (reachedModelLoad) {
    // The missing-model exit is expected. A nonzero exit is not a rejection by itself.
    return { ...base, accepted: true, initConfirmed: true, note: null };
  }
  if (missingModel) {
    return { ...base, accepted: true, initConfirmed: false, note: notConfirmedNote };
  }
  if (banner && exitCode === 0) {
    return { ...base, accepted: true, initConfirmed: false, note: notConfirmedNote };
  }

  if (stage === "fallback" && !text.trim()) {
    return { ...base, accepted: false, probeError: "no-output", reason: `The fallback probe without device flags produced no output (it ${exitText}).` };
  }
  return {
    ...base,
    accepted: false,
    reason: findFirstErrorLine(text) || `The backend ${exitText} before loading a model.`,
  };
}

// ── Backend probe launch ──────────────────────────────────────────────────────
// Shared by serve.cjs (probeBackendDevice) and scripts/capture-gpu-evidence.cjs, so both launch a
// backend the same way. The model path is missing on purpose: the backend creates its device
// context and exits. Nothing is loaded and no image is generated.
// Callers pass the missing-model path, the binary's folder, and a `run` function. This module
// does not spawn processes itself.

// Primary arguments. The device is pinned with --backend and --params-backend.
// metal has no device flag here, so it receives only the model and port.
function buildBackendProbeArgs({ cliName, missingModelPath }) {
  if (cliName === "metal") {
    return ["--model", missingModelPath, "--listen-port", PROBE_LISTEN_PORT];
  }
  return [
    "--backend", cliName,
    "--params-backend", cliName,
    "--model", missingModelPath,
    "--listen-port", PROBE_LISTEN_PORT,
  ];
}

// Fallback arguments for a binary that rejects --backend. The backend then picks its own device.
function buildBackendProbeFallbackArgs({ missingModelPath }) {
  return ["--model", missingModelPath, "--listen-port", PROBE_LISTEN_PORT];
}

// Environment for a probe. CUDA is pinned to PCI bus order so its indices match nvidia-smi.
// The binary's own folder is put first on the library search path, so bundled shared libraries
// are found on Linux and macOS.
function buildBackendProbeEnv({ baseEnv = {}, backendName, platform, libraryDir }) {
  const env = { ...baseEnv };
  if (backendName === "cuda") Object.assign(env, backendDeviceArgs("cuda", 0).env);
  if (platform === "linux" && libraryDir) {
    env.LD_LIBRARY_PATH = libraryDir + (env.LD_LIBRARY_PATH ? ":" + env.LD_LIBRARY_PATH : "");
  } else if (platform === "darwin" && libraryDir) {
    env.DYLD_LIBRARY_PATH = libraryDir + (env.DYLD_LIBRARY_PATH ? ":" + env.DYLD_LIBRARY_PATH : "");
  }
  return env;
}

function buildBackendProbeSpawnOptions(env) {
  return { env, encoding: "utf8", timeout: PROBE_TIMEOUT_MS };
}

// Runs one device probe. If the binary rejects --backend, the probe is retried without device
// flags. `run(binaryPath, args, options)` must return { output, exitCode, errorCode }.
// Returns { verdict, supportsFlags }, where verdict is the classifyBackendProbe result.
function runBackendProbeSequence({ run, binaryPath, cliName, missingModelPath, platform, spawnOptions }) {
  const first = run(binaryPath, buildBackendProbeArgs({ cliName, missingModelPath }), spawnOptions);
  if (!first.errorCode && shouldRetryWithoutDeviceFlags(first.output)) {
    const fallback = run(binaryPath, buildBackendProbeFallbackArgs({ missingModelPath }), spawnOptions);
    const verdict = classifyBackendProbe({
      ...fallback, platform, cliName, stage: "fallback", supportsFlags: false,
    });
    return { verdict, supportsFlags: false };
  }
  const verdict = classifyBackendProbe({
    ...first, platform, cliName, stage: "primary", supportsFlags: true,
  });
  return { verdict, supportsFlags: true };
}

// ── Refresh guard ─────────────────────────────────────────────────────────────
// A refresh re-runs nvidia-smi and the backend probes, and it clears the cached device records. The
// running runtime's selected-device record must not change under it, so refresh is refused while
// any model runtime is active. Returns the message to show, or null when a refresh may run.
const DISCOVERY_REFRESH_BLOCKED_MESSAGE = "Stop the active image or text model before refreshing hardware detection.";

function discoveryRefreshBlockedReason({ imageRunning = false, textRunning = false, openvinoRunning = false, generating = false } = {}) {
  return imageRunning || textRunning || openvinoRunning || generating ? DISCOVERY_REFRESH_BLOCKED_MESSAGE : null;
}

// ── Selection ─────────────────────────────────────────────────────────────────

// A probe that throws is a failed probe, not a crash of the whole selection.
function safeProbe(probe, index) {
  try {
    return probe(index) || {};
  } catch (error) {
    return { accepted: false, reason: `The probe failed: ${error && error.message ? error.message : String(error)}` };
  }
}

function summarizeProbeFailures(label, probes) {
  if (!probes.length) return `${label} backend has no candidate devices.`;
  const failed = probes.filter((probe) => !probe.accepted);
  if (!failed.length) return `${label} backend has no usable device.`;
  if (failed.length && failed.every((probe) => probe.notFound)) {
    return `${label} backend did not expose any usable device.`;
  }
  const first = failed.find((probe) => !probe.notFound) || failed[0];
  return `${label} backend could not initialize device ${first.index}${first.reason ? `: ${first.reason}` : "."}`;
}

// probe(index) must return { accepted, notFound?, reason?, output?, supportsFlags? }.
function selectCudaBackend({ installed, nvidiaSmi = null, inventory = null, preference = null, probe }) {
  const result = {
    kind: "cuda",
    installed: Boolean(installed),
    available: false,
    reason: null,
    device: null,
    candidates: [],
    probes: [],
    notes: [],
  };
  if (!installed) {
    result.reason = "CUDA backend is not installed.";
    return result;
  }

  const smiKnown = Boolean(nvidiaSmi && nvidiaSmi.ok);
  const inventoryKnown = Array.isArray(inventory);
  const nvidiaInInventory = inventoryKnown
    ? inventory.filter((device) => device.vendor === "nvidia" && !device.virtual)
    : [];
  const discoveryFailed = !smiKnown && !inventoryKnown;

  // Discovery that succeeded and found no NVIDIA adapter is a definitive "no".
  // Failed discovery is unknown, so the backend probe decides instead.
  if (!smiKnown && nvidiaInInventory.length === 0 && !discoveryFailed) {
    result.reason = nvidiaSmi && nvidiaSmi.error
      ? `No NVIDIA GPU was detected (nvidia-smi: ${nvidiaSmi.error}).`
      : "No NVIDIA GPU was detected.";
    return result;
  }

  let candidates;
  if (smiKnown && nvidiaSmi.devices.length) {
    candidates = rankGpuDevices(nvidiaSmi.devices).map((device) => ({
      index: device.index,
      name: device.name,
      vramGb: device.vramGb,
      displayActive: device.displayActive,
      source: "nvidia-smi",
    }));
  } else {
    // NVIDIA is visible in Windows/sysfs discovery (or discovery failed) but nvidia-smi
    // could not enumerate it. Probe CUDA device 0 and let the backend report its name.
    const singleName = nvidiaInInventory.length === 1 ? nvidiaInInventory[0].name : null;
    candidates = [{ index: 0, name: singleName, vramGb: null, displayActive: null, source: "cuda-probe" }];
  }

  if (preference && preference.valid) {
    const position = candidates.findIndex((candidate) => candidate.index === preference.index);
    if (position >= 0) {
      const [preferred] = candidates.splice(position, 1);
      candidates.unshift(preferred);
      result.notes.push(`Using CUDA device ${preference.index} from SD_CUDA_DEVICE.`);
    } else if (!smiKnown) {
      candidates.unshift({ index: preference.index, name: null, vramGb: null, displayActive: null, source: "user-preference" });
      result.notes.push(`Trying CUDA device ${preference.index} from SD_CUDA_DEVICE.`);
    } else {
      result.notes.push(`SD_CUDA_DEVICE=cuda${preference.index} is not an NVIDIA GPU on this system; choosing automatically.`);
    }
  }

  result.candidates = candidates.map(({ index, name, vramGb, displayActive, source }) => ({ index, name, vramGb, displayActive, source }));

  for (const candidate of candidates.slice(0, MAX_PROBED_CUDA_DEVICES)) {
    const probeResult = safeProbe(probe, candidate.index);
    result.probes.push({
      index: candidate.index,
      accepted: Boolean(probeResult.accepted),
      notFound: Boolean(probeResult.notFound),
      reason: probeResult.reason || null,
      error: probeResult.probeError || null,
      initConfirmed: typeof probeResult.initConfirmed === "boolean" ? probeResult.initConfirmed : null,
    });
    if (!probeResult.accepted) continue;

    const pinned = probeResult.supportsFlags !== false;
    // An unpinned binary's device is identified only by its own output (see confirmUnpinnedDevice).
    // The preferred candidate is never reported as the active device.
    const confirmed = pinned ? null : confirmUnpinnedDevice(probeResult.output, "cuda");
    result.available = true;
    result.reason = null;
    result.device = pinned
      ? {
        index: candidate.index,
        name: findDeviceNameInLog(probeResult.output, "cuda", candidate.index) || candidate.name || `NVIDIA GPU (CUDA ${candidate.index})`,
        candidateName: null,
        identityConfirmed: true,
        vramGb: candidate.vramGb ?? null,
        displayActive: candidate.displayActive ?? null,
        pinned: true,
        initConfirmed: probeResult.initConfirmed !== false,
        source: candidate.source,
      }
      : {
        index: null,
        name: confirmed ? confirmed.name : null,
        candidateName: candidate.name || null,
        identityConfirmed: Boolean(confirmed),
        vramGb: confirmed && typeof confirmed.vramGb === "number" ? confirmed.vramGb : null,
        displayActive: null,
        pinned: false,
        initConfirmed: probeResult.initConfirmed !== false,
        source: "backend-automatic",
      };
    if (!pinned) {
      result.notes.push("This CUDA binary does not accept --backend, so the backend chooses the device.");
      result.notes.push(confirmed
        ? `The backend lists one CUDA device: ${confirmed.name}.`
        : `The active CUDA device is not confirmed${candidate.name ? `; ${candidate.name} was the preferred candidate, not a confirmed device` : ""}.`);
    }
    return result;
  }

  result.reason = summarizeProbeFailures("CUDA", result.probes);
  return result;
}

// probe(index) must return { accepted, notFound?, reason?, output?, supportsFlags? }.
// vulkaninfoDevices is an optional secondary source (Linux) used when the backend log lacks a list.
function selectVulkanBackend({
  installed,
  runtimeReason = null,
  inventory = null,
  nvidiaPresent = false,
  preference = null,
  vulkaninfoDevices = null,
  probe,
}) {
  const result = {
    kind: "vulkan",
    installed: Boolean(installed),
    available: false,
    reason: null,
    device: null,
    devices: [],
    probes: [],
    notes: [],
  };
  if (!installed) {
    result.reason = "Vulkan backend is not installed.";
    return result;
  }
  if (runtimeReason) {
    result.reason = runtimeReason;
    return result;
  }

  const probeResults = new Map();
  const runProbe = (index) => {
    if (!probeResults.has(index)) probeResults.set(index, safeProbe(probe, index));
    return probeResults.get(index);
  };

  // Probing device 0 also makes the backend print its device list (ggml init log).
  const first = runProbe(0);
  let listed = parseVulkanDeviceLog(first.output);
  if (!listed.length && Array.isArray(vulkaninfoDevices) && vulkaninfoDevices.length) {
    listed = vulkaninfoDevices;
  }
  const listedByIndex = new Map(listed.map((device) => [device.index, device]));

  let indices;
  if (first.supportsFlags === false) {
    // The binary cannot be told which device to use. Probing other indices would only repeat
    // this run, so there is one result, and the backend's device is not identified by index.
    indices = [0];
  } else if (listed.length) {
    indices = listed.map((device) => device.index).slice(0, MAX_PROBED_VULKAN_DEVICES);
  } else if (first.notFound) {
    indices = [];
  } else {
    indices = [0];
    for (let index = 1; index < MAX_PROBED_VULKAN_DEVICES; index += 1) {
      const probeResult = runProbe(index);
      if (probeResult.notFound) break;
      indices.push(index);
    }
  }

  if (!indices.length) {
    result.reason = "Vulkan backend reported no Vulkan devices.";
    return result;
  }

  const devices = indices.map((index) => {
    const probeResult = runProbe(index);
    const info = listedByIndex.get(index) || null;
    const name = (info && info.name) || findDeviceNameInLog(probeResult.output, "vulkan", index) || null;
    const classified = name ? classifyGpuName(name) : null;
    return {
      index,
      name,
      vendor: classified ? classified.vendor : "unknown",
      integrated: info && typeof info.integrated === "boolean"
        ? info.integrated
        : (classified ? classified.integrated : null),
      virtual: classified ? classified.virtual : false,
      vramGb: info && typeof info.vramGb === "number" ? info.vramGb : null,
      accepted: Boolean(probeResult.accepted),
      notFound: Boolean(probeResult.notFound),
      reason: probeResult.reason || null,
      error: probeResult.probeError || null,
      initConfirmed: typeof probeResult.initConfirmed === "boolean" ? probeResult.initConfirmed : null,
      pinned: probeResult.supportsFlags !== false,
    };
  });

  result.devices = devices;
  result.probes = devices.map((device) => ({
    index: device.index,
    accepted: device.accepted,
    notFound: device.notFound,
    reason: device.reason,
    error: device.error,
    initConfirmed: device.initConfirmed,
  }));

  const eligible = devices.filter((device) => device.accepted && !device.virtual);

  if (nvidiaPresent && !eligible.some((device) => device.vendor === "nvidia")) {
    const rejectedNvidia = devices.find((device) => device.vendor === "nvidia" && !device.accepted);
    result.notes.push(rejectedNvidia
      ? `An NVIDIA GPU was detected, but the Vulkan backend could not initialize it${rejectedNvidia.reason ? `: ${rejectedNvidia.reason}` : "."}`
      : "An NVIDIA GPU was detected, but it is not exposed through the Vulkan backend on this system.");
  }

  let chosen = null;
  let explicit = false;
  if (preference && preference.valid) {
    const preferred = eligible.find((device) => device.index === preference.index);
    if (preferred) {
      chosen = preferred;
      explicit = true;
      result.notes.push(`Using Vulkan device ${preferred.index} from SD_VULKAN_DEVICE.`);
    } else {
      result.notes.push(`SD_VULKAN_DEVICE=vulkan${preference.index} is not a usable Vulkan device on this system; choosing automatically.`);
    }
  }

  if (!chosen) {
    chosen = rankGpuDevices(eligible)[0] || null;
    if (chosen && !explicit && chosen.pinned) {
      const hasIntegratedAlternative = eligible.some((device) => device !== chosen && device.integrated === true);
      if (chosen.integrated === true) {
        result.notes.push(`Only an integrated Vulkan GPU (${chosen.name || `device ${chosen.index}`}) is usable; using it.`);
      } else if (hasIntegratedAlternative) {
        result.notes.push(`Selected discrete Vulkan GPU ${chosen.name || `device ${chosen.index}`} over integrated GPU(s).`);
      }
    }
  }

  if (!chosen) {
    const onlySoftware = devices.some((device) => device.accepted && device.virtual) && !eligible.length;
    result.reason = onlySoftware
      ? "Only software Vulkan devices (for example llvmpipe) are available; they are not used for inference."
      : summarizeProbeFailures("Vulkan", result.probes);
    return result;
  }

  result.available = true;
  result.reason = null;
  if (chosen.pinned) {
    result.device = {
      index: chosen.index,
      name: chosen.name || `Vulkan device ${chosen.index}`,
      candidateName: null,
      identityConfirmed: true,
      vendor: chosen.vendor,
      integrated: chosen.integrated,
      vramGb: chosen.vramGb,
      pinned: true,
      initConfirmed: chosen.initConfirmed !== false,
      source: explicit ? "user-preference" : "auto",
    };
  } else {
    // Unpinned: the candidate is not the active device unless the backend's own output lists
    // exactly one device.
    const confirmed = confirmUnpinnedDevice(probeResults.get(chosen.index).output, "vulkan");
    result.device = {
      index: null,
      name: confirmed ? confirmed.name : null,
      candidateName: chosen.name || null,
      identityConfirmed: Boolean(confirmed),
      vendor: confirmed ? classifyGpuName(confirmed.name).vendor : null,
      integrated: confirmed && typeof confirmed.integrated === "boolean" ? confirmed.integrated : null,
      vramGb: confirmed && typeof confirmed.vramGb === "number" ? confirmed.vramGb : null,
      pinned: false,
      initConfirmed: chosen.initConfirmed !== false,
      source: "backend-automatic",
    };
    result.notes.push("This Vulkan binary does not accept --backend, so the backend chooses the device.");
    result.notes.push(confirmed
      ? `The backend lists one Vulkan device: ${confirmed.name}.`
      : `The active Vulkan device is not confirmed${chosen.name ? `; ${chosen.name} was the preferred candidate, not a confirmed device` : ""}.`);
  }
  return result;
}

module.exports = {
  DEVICE_FAILURE_PATTERNS,
  MISSING_MODEL_PATTERNS,
  findDeviceFailureLine,
  isMissingModelOutput,
  shouldRetryWithoutDeviceFlags,
  confirmUnpinnedDevice,
  classifyBackendProbe,
  PROBE_TIMEOUT_MS,
  PROBE_LISTEN_PORT,
  buildBackendProbeArgs,
  buildBackendProbeFallbackArgs,
  buildBackendProbeEnv,
  buildBackendProbeSpawnOptions,
  runBackendProbeSequence,
  INTEGRATED_GPU_NAME_PATTERNS,
  classifyGpuName,
  isVirtualOrSoftwareGpu,
  vendorFromPciId,
  parseVulkanDeviceLog,
  parseVulkaninfoSummary,
  parseCudaDeviceLog,
  parseNvidiaSmiCsv,
  parseWindowsVideoControllers,
  findFirstErrorLine,
  rankGpuDevices,
  pickPrimaryGpu,
  parseDevicePreference,
  backendDeviceArgs,
  findDeviceNameInLog,
  resolveRequestedBackend,
  describeGpuFallback,
  selectCudaBackend,
  selectVulkanBackend,
  DISCOVERY_REFRESH_BLOCKED_MESSAGE,
  discoveryRefreshBlockedReason,
};
