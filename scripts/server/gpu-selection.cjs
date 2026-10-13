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
//   nvidia-smi --query-gpu=index,name,memory.total,memory.free,display_active,pci.bus_id --format=csv,noheader,nounits
// Missing or "[N/A]" fields become null. display_active is informational only.
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
    });
    if (!probeResult.accepted) continue;

    const name = findDeviceNameInLog(probeResult.output, "cuda", candidate.index) || candidate.name || `NVIDIA GPU (CUDA ${candidate.index})`;
    result.available = true;
    result.reason = null;
    result.device = {
      index: probeResult.supportsFlags === false ? null : candidate.index,
      name,
      vramGb: candidate.vramGb ?? null,
      displayActive: candidate.displayActive ?? null,
      pinned: probeResult.supportsFlags !== false,
      source: candidate.source,
    };
    if (!result.device.pinned) {
      result.notes.push("This CUDA binary does not accept --backend, so the backend chooses the device.");
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
  if (listed.length) {
    indices = listed.map((device) => device.index).slice(0, MAX_PROBED_VULKAN_DEVICES);
  } else if (first.notFound) {
    indices = [];
  } else if (first.supportsFlags === false) {
    // The binary cannot be told which device to use, so probing more indices would only
    // repeat the same result.
    indices = [0];
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
      pinned: probeResult.supportsFlags !== false,
    };
  });

  result.devices = devices;
  result.probes = devices.map((device) => ({
    index: device.index,
    accepted: device.accepted,
    notFound: device.notFound,
    reason: device.reason,
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
    if (chosen && !explicit) {
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
  result.device = {
    index: chosen.pinned ? chosen.index : null,
    name: chosen.name || `Vulkan device ${chosen.index}`,
    vendor: chosen.vendor,
    integrated: chosen.integrated,
    vramGb: chosen.vramGb,
    pinned: chosen.pinned,
    source: explicit ? "user-preference" : "auto",
  };
  if (!chosen.pinned) {
    result.notes.push("This Vulkan binary does not accept --backend, so the backend chooses the device.");
  }
  return result;
}

module.exports = {
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
};
