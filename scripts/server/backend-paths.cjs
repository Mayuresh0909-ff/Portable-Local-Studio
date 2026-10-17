// backend-paths.cjs — where the bundled backend binaries live, relative to the repository root.
// Shared by serve.cjs and scripts/capture-gpu-evidence.cjs so both look in the same places.
const path = require("node:path");

function createBackendPaths(root) {
  return {
    cuda: path.join(root, "app", "backend", "win", "cuda", "sd-cuda.exe"),
    vulkan: path.join(root, "app", "backend", "win", "vulkan", "sd-vulkan.exe"),
    cpu: path.join(root, "app", "backend", "win", "cpu", "sd-cpu.exe"),
    mac: path.join(root, "app", "backend", "mac", "sd"),
    linuxCpu: path.join(root, "app", "backend", "linux", "cpu", "sd-server-cpu"),
    linuxVulkan: path.join(root, "app", "backend", "linux", "vulkan", "sd-server-vulkan"),
    linuxRocm: path.join(root, "app", "backend", "linux", "rocm", "sd-server-rocm"),
    linuxCuda: path.join(root, "app", "backend", "linux", "cuda", "sd-server-cuda"),
  };
}

module.exports = { createBackendPaths };
