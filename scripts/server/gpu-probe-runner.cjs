// gpu-probe-runner.cjs — the process-facing GPU helpers shared by serve.cjs and
// scripts/capture-gpu-evidence.cjs: the nvidia-smi query and the spawn of one backend probe.
//
// Parsing and decisions stay in gpu-selection.cjs. This file only runs commands and returns their
// raw results. Callers may pass `run` / `spawn` to replace spawnSync in tests.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseNvidiaSmiCsv, findFirstErrorLine } = require("./gpu-selection.cjs");

// Queries are tried in order. A driver that rejects a field name falls through to the next query.
const NVIDIA_SMI_QUERIES = [
  "index,name,memory.total,memory.free,display_active,pci.bus_id",
  "index,name,memory.total,memory.free", // older drivers do not know display_active
];

function nvidiaSmiCommands(platform) {
  return platform === "win32"
    ? ["nvidia-smi", "C:\\Windows\\System32\\nvidia-smi.exe", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"]
    : ["nvidia-smi", "/usr/bin/nvidia-smi"];
}

// Returns { ok, devices, error, command? }. Never throws.
function queryNvidiaSmi({
  platform = process.platform,
  spawn = spawnSync,
  exists = fs.existsSync,
  queries = NVIDIA_SMI_QUERIES,
} = {}) {
  if (platform === "darwin") {
    return { ok: false, devices: [], error: "NVIDIA tools are not used on macOS." };
  }
  let lastError = "nvidia-smi was not found";
  for (const command of nvidiaSmiCommands(platform)) {
    if (path.isAbsolute(command) && !exists(command)) continue;
    for (const fields of queries) {
      const result = spawn(command, [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      if (result.error) {
        lastError = result.error.code === "ENOENT"
          ? "nvidia-smi was not found"
          : `nvidia-smi failed (${result.error.code || result.error.message})`;
        break;
      }
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      if (result.status !== 0) {
        lastError = findFirstErrorLine(output) || `nvidia-smi exited with code ${result.status}`;
        if (/not a valid field|invalid field/i.test(output)) continue;
        break;
      }
      const devices = parseNvidiaSmiCsv(result.stdout);
      if (devices.length) return { ok: true, devices, error: null, command };
      lastError = "nvidia-smi reported no NVIDIA GPUs";
      break;
    }
  }
  return { ok: false, devices: [], error: lastError };
}

// Spawns one backend probe and returns { output, exitCode, errorCode }.
function runBackendProbeProcess(binaryPath, args, options) {
  const result = spawnSync(binaryPath, args, options);
  return {
    output: `${result.stdout || ""}\n${result.stderr || ""}`,
    exitCode: result.status,
    errorCode: result.error ? (result.error.code || "ERROR") : null,
  };
}

module.exports = {
  NVIDIA_SMI_QUERIES,
  nvidiaSmiCommands,
  queryNvidiaSmi,
  runBackendProbeProcess,
};
