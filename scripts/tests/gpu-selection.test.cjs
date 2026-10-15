// Regression tests for GPU detection and image-backend device selection.
// Hardware is mocked: probe results and discovery data below are fixtures, not evidence that a
// GPU was actually used. Real GPU inference must be verified on the target machine.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const selection = require(path.join(root, "scripts", "server", "gpu-selection.cjs"));
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const {
  backendDeviceArgs,
  classifyGpuName,
  describeGpuFallback,
  findDeviceNameInLog,
  parseCudaDeviceLog,
  parseDevicePreference,
  parseNvidiaSmiCsv,
  parseVulkaninfoSummary,
  parseVulkanDeviceLog,
  parseWindowsVideoControllers,
  pickPrimaryGpu,
  rankGpuDevices,
  resolveRequestedBackend,
  selectCudaBackend,
  selectVulkanBackend,
} = selection;

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Hybrid laptop: Radeon 610M drives the panel, RTX 5060 is idle for display (Optimus).
const HYBRID_INVENTORY = [
  { name: "AMD Radeon(TM) 610M", vendor: "amd", integrated: true, virtual: false, vramGb: 4, displayAttached: true, source: "win32-video-controller" },
  { name: "NVIDIA GeForce RTX 5060 Laptop GPU", vendor: "nvidia", integrated: false, virtual: false, vramGb: 4, displayAttached: false, source: "win32-video-controller" },
];

const HYBRID_NVIDIA_SMI = {
  ok: true,
  error: null,
  devices: [
    { index: 0, name: "NVIDIA GeForce RTX 5060 Laptop GPU", vendor: "nvidia", integrated: false, virtual: false, vramGb: 8, freeVramGb: 7, displayActive: false, busId: "00000000:01:00.0" },
  ],
};

// ggml init log from a Vulkan build that sees both adapters. The AMD iGPU is index 0 here, which
// is the situation where the old hard-coded "vulkan0" picked the display adapter.
const HYBRID_VULKAN_LOG = [
  "ggml_vulkan: Found 2 Vulkan devices:",
  "ggml_vulkan: 0 = AMD Radeon(TM) 610M (AMD proprietary driver) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 64 | shared memory: 32768 | int dot: 1 | matrix cores: none",
  "ggml_vulkan: 1 = NVIDIA GeForce RTX 5060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 1 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2",
  "stable-diffusion.cpp version master-685-19bdfe2",
  "loading model from 'missing.safetensors'",
].join("\n");

const HYBRID_VULKAN_LOG_REVERSED = [
  "ggml_vulkan: Found 2 Vulkan devices:",
  "ggml_vulkan: 0 = NVIDIA GeForce RTX 5060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 1 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2",
  "ggml_vulkan: 1 = AMD Radeon(TM) 610M (AMD proprietary driver) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 64 | shared memory: 32768 | int dot: 1 | matrix cores: none",
  "stable-diffusion.cpp version master-685-19bdfe2",
  "loading model from 'missing.safetensors'",
].join("\n");

const CUDA_INIT_LOG = [
  "ggml_cuda_init: found 1 CUDA devices:",
  "  Device 0: NVIDIA GeForce RTX 5060 Laptop GPU, compute capability 12.0, VMM: yes",
  "stable-diffusion.cpp version master-782-b290693",
  "loading model from 'missing.safetensors'",
].join("\n");

const ACCEPTED = (output) => ({ accepted: true, supportsFlags: true, output: output || "loading model from 'missing.safetensors'" });
const NOT_FOUND = (index) => ({ accepted: false, notFound: true, reason: `Device vulkan${index} is not present.`, output: `backend 'vulkan${index}' was not found` });
const FAILED = (reason, output = "") => ({ accepted: false, supportsFlags: true, reason, output });

// Returns a probe function that answers from a table and records the indices it was asked for.
function tableProbe(table, { defaultNotFound = true } = {}) {
  const calls = [];
  const probe = (index) => {
    calls.push(index);
    if (Object.prototype.hasOwnProperty.call(table, index)) return table[index];
    return defaultNotFound ? NOT_FOUND(index) : FAILED(`no entry for ${index}`);
  };
  probe.calls = calls;
  return probe;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

test("Vulkan init log is parsed with integrated (uma) flags and names containing parentheses", () => {
  const devices = parseVulkanDeviceLog(HYBRID_VULKAN_LOG);
  assert.deepEqual(devices.map((d) => [d.index, d.name, d.integrated]), [
    [0, "AMD Radeon(TM) 610M", true],
    [1, "NVIDIA GeForce RTX 5060 Laptop GPU", false],
  ]);
  assert.equal(findDeviceNameInLog(HYBRID_VULKAN_LOG, "vulkan", 1), "NVIDIA GeForce RTX 5060 Laptop GPU");
});

test("Vulkan list output (llama-style) is parsed with VRAM", () => {
  const output = [
    "Available devices:",
    "  Vulkan0: AMD Radeon(TM) 610M (16384 MiB, 15000 MiB free)",
    "  Vulkan1: NVIDIA GeForce RTX 5060 Laptop GPU (8188 MiB, 7000 MiB free)",
  ].join("\n");
  const devices = parseVulkanDeviceLog(output);
  assert.equal(devices.length, 2);
  assert.equal(devices[1].vramGb, 8);
  assert.equal(devices[1].integrated, false);
  assert.equal(devices[0].integrated, true);
});

test("vulkaninfo summary is parsed by device type", () => {
  const output = [
    "GPU0:",
    "  deviceName = AMD Radeon(TM) 610M",
    "  deviceType = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU",
    "GPU1:",
    "  deviceName = NVIDIA GeForce RTX 5060 Laptop GPU",
    "  deviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU",
    "GPU2:",
    "  deviceName = llvmpipe (LLVM 15.0.7, 256 bits)",
    "  deviceType = PHYSICAL_DEVICE_TYPE_CPU",
  ].join("\n");
  const devices = parseVulkaninfoSummary(output);
  assert.equal(devices[0].integrated, true);
  assert.equal(devices[1].integrated, false);
  assert.equal(devices[2].virtual, true);
});

test("CUDA device lines from ggml init and list formats are parsed", () => {
  assert.deepEqual(parseCudaDeviceLog(CUDA_INIT_LOG).map((d) => [d.index, d.name]), [
    [0, "NVIDIA GeForce RTX 5060 Laptop GPU"],
  ]);
  const listed = parseCudaDeviceLog("CUDA0: NVIDIA GeForce RTX 5060 Laptop GPU (8188 MiB, 7000 MiB free)");
  assert.equal(listed[0].vramGb, 8);
});

test("nvidia-smi CSV keeps display_active as information and tolerates [N/A] fields", () => {
  const devices = parseNvidiaSmiCsv([
    "0, NVIDIA GeForce RTX 5060 Laptop GPU, 8188, 7000, Disabled, 00000000:01:00.0",
    "1, NVIDIA RTX A2000, [N/A], [N/A], Enabled, 00000000:02:00.0",
    "garbage line without an index",
  ].join("\n"));
  assert.equal(devices.length, 2);
  assert.equal(devices[0].displayActive, false);
  assert.equal(devices[0].vramGb, 8);
  assert.equal(devices[1].displayActive, true);
  assert.equal(devices[1].vramGb, null);
});

test("nvidia-smi output without display_active (older drivers) still parses", () => {
  const devices = parseNvidiaSmiCsv("0, NVIDIA GeForce RTX 3060, 12288, 11000");
  assert.equal(devices[0].name, "NVIDIA GeForce RTX 3060");
  assert.equal(devices[0].displayActive, null);
});

test("Windows video controllers are classified; RTX 5060 is discrete, Radeon 610M is integrated", () => {
  const inventory = parseWindowsVideoControllers([
    { Name: "AMD Radeon(TM) 610M", VRAM: 2, DisplayAttached: true },
    { Name: "NVIDIA GeForce RTX 5060 Laptop GPU", VRAM: 4, DisplayAttached: false },
    { Name: "Microsoft Basic Display Adapter", VRAM: 0, DisplayAttached: true },
  ]);
  assert.equal(inventory[0].integrated, true);
  assert.equal(inventory[0].vendor, "amd");
  assert.equal(inventory[1].integrated, false);
  assert.equal(inventory[1].vendor, "nvidia");
  assert.equal(inventory[1].displayAttached, false);
  assert.equal(inventory[2].virtual, true);
  assert.deepEqual(classifyGpuName("Intel(R) Arc(TM) Graphics").integrated, true);
  assert.deepEqual(classifyGpuName("Intel(R) Arc(TM) A770 Graphics").integrated, false);
  assert.deepEqual(classifyGpuName("AMD Radeon RX 6600M").integrated, false);
});

test("device preferences parse vulkanN/N/cudaN and reject other text", () => {
  assert.deepEqual(parseDevicePreference("vulkan1", "vulkan"), { index: 1, raw: "vulkan1", valid: true });
  assert.deepEqual(parseDevicePreference("1", "vulkan"), { index: 1, raw: "1", valid: true });
  assert.deepEqual(parseDevicePreference("cuda0", "cuda"), { index: 0, raw: "cuda0", valid: true });
  assert.equal(parseDevicePreference("amd", "vulkan").valid, false);
  assert.equal(parseDevicePreference("", "vulkan"), null);
});

test("CUDA device launch pins PCI bus order so nvidia-smi and CUDA indices agree", () => {
  assert.deepEqual(backendDeviceArgs("cuda", 1), { cliName: "cuda1", env: { CUDA_DEVICE_ORDER: "PCI_BUS_ID" } });
  assert.deepEqual(backendDeviceArgs("vulkan", 0), { cliName: "vulkan0", env: {} });
  assert.equal(backendDeviceArgs("vulkan", null), null);
});

// ── Regression: NVIDIA compute GPU is usable even when another GPU drives the display ──

test("NVIDIA compute GPU is selected for CUDA even though the iGPU drives the display", () => {
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: HYBRID_NVIDIA_SMI,
    inventory: HYBRID_INVENTORY,
    probe: tableProbe({ 0: ACCEPTED(CUDA_INIT_LOG) }),
  });
  assert.equal(cuda.available, true);
  assert.equal(cuda.reason, null);
  assert.equal(cuda.device.index, 0);
  assert.equal(cuda.device.name, "NVIDIA GeForce RTX 5060 Laptop GPU");
  assert.equal(cuda.device.displayActive, false);
});

test("display attachment is never a reason to reject a GPU", () => {
  // Same NVIDIA card, but now it drives the display. It must still be usable.
  const displayOnNvidia = {
    ok: true,
    error: null,
    devices: [{ ...HYBRID_NVIDIA_SMI.devices[0], displayActive: true }],
  };
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: displayOnNvidia,
    inventory: [{ ...HYBRID_INVENTORY[1], displayAttached: true }],
    probe: tableProbe({ 0: ACCEPTED() }),
  });
  assert.equal(cuda.available, true);
  assert.equal(cuda.device.displayActive, true);
});

test("Vulkan prefers the discrete RTX 5060 over the display iGPU, even when the iGPU is index 0", () => {
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    probe: tableProbe({ 0: ACCEPTED(HYBRID_VULKAN_LOG), 1: ACCEPTED(HYBRID_VULKAN_LOG) }),
  });
  assert.equal(vulkan.available, true);
  assert.equal(vulkan.device.index, 1);
  assert.equal(vulkan.device.name, "NVIDIA GeForce RTX 5060 Laptop GPU");
  assert.ok(vulkan.notes.some((note) => /Selected discrete Vulkan GPU/.test(note)));
});

// ── Regression: multiple GPUs, deterministic selection ────────────────────────

test("Vulkan selection is the same regardless of the order the backend lists devices", () => {
  const forward = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    probe: tableProbe({ 0: ACCEPTED(HYBRID_VULKAN_LOG), 1: ACCEPTED(HYBRID_VULKAN_LOG) }),
  });
  const reversed = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    probe: tableProbe({ 0: ACCEPTED(HYBRID_VULKAN_LOG_REVERSED), 1: ACCEPTED(HYBRID_VULKAN_LOG_REVERSED) }),
  });
  assert.equal(forward.device.name, "NVIDIA GeForce RTX 5060 Laptop GPU");
  assert.equal(reversed.device.name, "NVIDIA GeForce RTX 5060 Laptop GPU");
  assert.equal(forward.device.index, 1);
  assert.equal(reversed.device.index, 0);
});

test("two discrete GPUs: the larger VRAM wins, and equal VRAM falls back to the lower index", () => {
  const log = [
    "ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 (NVIDIA) | uma: 0 | fp16: 1",
    "ggml_vulkan: 1 = NVIDIA GeForce RTX 4090 (NVIDIA) | uma: 0 | fp16: 1",
  ].join("\n");
  const byVram = selectVulkanBackend({
    installed: true,
    inventory: null,
    probe: tableProbe({ 0: ACCEPTED(log), 1: ACCEPTED(log) }),
  });
  assert.equal(byVram.device.index, 0, "names alone carry no VRAM; ties fall back to index");

  const listed = [
    "Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11000 MiB free)",
    "Vulkan1: NVIDIA GeForce RTX 4090 (24576 MiB, 23000 MiB free)",
  ].join("\n");
  const largest = selectVulkanBackend({
    installed: true,
    inventory: null,
    probe: tableProbe({ 0: ACCEPTED(listed), 1: ACCEPTED(listed) }),
  });
  assert.equal(largest.device.index, 1);

  const tied = [
    "Vulkan0: NVIDIA RTX A2000 (6144 MiB, 5000 MiB free)",
    "Vulkan1: NVIDIA RTX A2000 (6144 MiB, 5000 MiB free)",
  ].join("\n");
  const tiedResult = selectVulkanBackend({
    installed: true,
    inventory: null,
    probe: tableProbe({ 0: ACCEPTED(tied), 1: ACCEPTED(tied) }),
  });
  assert.equal(tiedResult.device.index, 0);
});

test("two NVIDIA GPUs for CUDA: the GPU with more VRAM is chosen deterministically", () => {
  const smi = {
    ok: true,
    error: null,
    devices: parseNvidiaSmiCsv([
      "0, NVIDIA GeForce RTX 3060, 12288, 11000, Enabled, 00000000:01:00.0",
      "1, NVIDIA GeForce RTX 4090, 24576, 23000, Disabled, 00000000:02:00.0",
    ].join("\n")),
  };
  const probe = tableProbe({ 1: ACCEPTED(), 0: ACCEPTED() });
  const cuda = selectCudaBackend({ installed: true, nvidiaSmi: smi, inventory: null, probe });
  assert.equal(cuda.device.index, 1);
  assert.deepEqual(probe.calls, [1], "the first candidate that initializes is used; no extra probes");
});

test("unknown-name Vulkan devices are probed in index order and the first usable one is chosen", () => {
  const probe = tableProbe({ 0: FAILED("device lost during init"), 1: ACCEPTED("loading model"), 2: ACCEPTED() });
  const vulkan = selectVulkanBackend({ installed: true, inventory: null, probe });
  assert.equal(vulkan.available, true);
  assert.equal(vulkan.device.index, 1);
  assert.deepEqual(probe.calls, [0, 1, 2, 3], "index 3 is probed once to learn that the list ends");
});

test("probing stops at the first missing Vulkan index when the backend does not list devices", () => {
  const probe = tableProbe({ 0: ACCEPTED() });
  const vulkan = selectVulkanBackend({ installed: true, inventory: null, probe });
  assert.equal(vulkan.device.index, 0);
  assert.deepEqual(probe.calls, [0, 1], "index 1 was probed once to learn that the list ends");
});

test("a listed device list is probed only for the listed indices", () => {
  const probe = tableProbe({ 0: ACCEPTED(HYBRID_VULKAN_LOG), 1: ACCEPTED(HYBRID_VULKAN_LOG) });
  selectVulkanBackend({ installed: true, inventory: null, probe });
  assert.deepEqual(probe.calls, [0, 1]);
});

// ── Regression: NVIDIA tooling unavailable while a usable Vulkan backend exists ──

test("nvidia-smi missing but Windows still reports the NVIDIA GPU: CUDA is probed and can be used", () => {
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: { ok: false, devices: [], error: "nvidia-smi was not found" },
    inventory: HYBRID_INVENTORY,
    probe: tableProbe({ 0: ACCEPTED(CUDA_INIT_LOG) }),
  });
  assert.equal(cuda.available, true);
  assert.equal(cuda.device.index, 0);
  assert.equal(cuda.device.name, "NVIDIA GeForce RTX 5060 Laptop GPU", "the backend log supplies the name");
});

test("nvidia-smi missing and no NVIDIA adapter: CUDA is reported unavailable without probing, Vulkan still works", () => {
  const amdOnly = [HYBRID_INVENTORY[0]];
  const probeCuda = tableProbe({ 0: ACCEPTED() });
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: { ok: false, devices: [], error: "nvidia-smi was not found" },
    inventory: amdOnly,
    probe: probeCuda,
  });
  assert.equal(cuda.available, false);
  assert.match(cuda.reason, /No NVIDIA GPU was detected \(nvidia-smi: nvidia-smi was not found\)/);
  assert.deepEqual(probeCuda.calls, [], "no CUDA probe without NVIDIA evidence");

  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: amdOnly,
    probe: tableProbe({ 0: ACCEPTED("ggml_vulkan: 0 = AMD Radeon(TM) 610M (AMD proprietary driver) | uma: 1 |\nloading model") }),
  });
  assert.equal(vulkan.available, true);
  assert.equal(vulkan.device.name, "AMD Radeon(TM) 610M");
  assert.ok(vulkan.notes.some((note) => /Only an integrated Vulkan GPU/.test(note)));
});

test("discovery failure (unknown, not absent) lets the CUDA probe decide", () => {
  const probe = tableProbe({ 0: ACCEPTED(CUDA_INIT_LOG) });
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: { ok: false, devices: [], error: "nvidia-smi failed (ETIMEDOUT)" },
    inventory: null,
    probe,
  });
  assert.equal(cuda.available, true);
  assert.deepEqual(probe.calls, [0]);
});

// ── Regression: a GPU is detected but the installed backend cannot use it ─────

test("NVIDIA GPU detected but CUDA backend cannot initialize it: reported with reason, Vulkan used instead", () => {
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: HYBRID_NVIDIA_SMI,
    inventory: HYBRID_INVENTORY,
    probe: tableProbe({ 0: FAILED("CUDA error: no kernel image is available for execution on the device") }),
  });
  assert.equal(cuda.available, false);
  assert.match(cuda.reason, /CUDA backend could not initialize device 0: CUDA error: no kernel image/);

  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    probe: tableProbe({ 0: ACCEPTED(HYBRID_VULKAN_LOG), 1: ACCEPTED(HYBRID_VULKAN_LOG) }),
  });
  assert.equal(vulkan.available, true);
  assert.equal(vulkan.device.name, "NVIDIA GeForce RTX 5060 Laptop GPU");
});

test("NVIDIA present but rejected by Vulkan: the backend's reason is surfaced in notes", () => {
  const log = [
    "ggml_vulkan: Found 2 Vulkan devices:",
    "ggml_vulkan: 0 = AMD Radeon(TM) 610M (AMD proprietary driver) | uma: 1 | fp16: 1",
    "ggml_vulkan: 1 = NVIDIA GeForce RTX 5060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1",
  ].join("\n");
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    probe: tableProbe({ 0: ACCEPTED(log), 1: FAILED("vkCreateDevice failed with VK_ERROR_INITIALIZATION_FAILED") }),
  });
  assert.equal(vulkan.device.index, 0);
  assert.ok(vulkan.notes.some((note) => /could not initialize it: vkCreateDevice failed/.test(note)));
});

test("NVIDIA present but absent from the Vulkan device list is called out", () => {
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    probe: tableProbe({ 0: ACCEPTED("ggml_vulkan: 0 = AMD Radeon(TM) 610M (AMD proprietary driver) | uma: 1 | fp16: 1") }),
  });
  assert.equal(vulkan.device.index, 0);
  assert.ok(vulkan.notes.some((note) => /not exposed through the Vulkan backend/.test(note)));
});

// ── Regression: discovery utilities or backend probes fail ────────────────────

test("a Vulkan probe that throws is treated as a failed device, not a crash", () => {
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: null,
    probe: (index) => {
      if (index === 0) throw new Error("spawnSync EACCES");
      return NOT_FOUND(index);
    },
  });
  assert.equal(vulkan.available, false);
  assert.match(vulkan.reason, /could not initialize device 0: The probe failed: spawnSync EACCES/);
});

test("a CUDA probe that times out is reported as a failed probe", () => {
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: HYBRID_NVIDIA_SMI,
    inventory: HYBRID_INVENTORY,
    probe: () => FAILED("The probe timed out after 5 seconds."),
  });
  assert.equal(cuda.available, false);
  assert.match(cuda.reason, /timed out/);
});

test("a Vulkan runtime problem blocks Vulkan with the runtime's explanation", () => {
  const probe = tableProbe({ 0: ACCEPTED() });
  const vulkan = selectVulkanBackend({
    installed: true,
    runtimeReason: "The Vulkan runtime (vulkan-1.dll) is missing.",
    inventory: HYBRID_INVENTORY,
    probe,
  });
  assert.equal(vulkan.available, false);
  assert.equal(vulkan.reason, "The Vulkan runtime (vulkan-1.dll) is missing.");
  assert.deepEqual(probe.calls, [], "no probe is run when the runtime is missing");
});

// ── Regression: no usable GPU, safe CPU fallback ──────────────────────────────

test("no usable GPU: both backends unavailable and the CPU fallback explains why", () => {
  const inventory = parseWindowsVideoControllers([{ Name: "Microsoft Basic Display Adapter", VRAM: 0, DisplayAttached: true }]);
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: { ok: false, devices: [], error: "nvidia-smi was not found" },
    inventory,
    probe: tableProbe({}),
  });
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory,
    probe: tableProbe({}),
  });
  assert.equal(cuda.available, false);
  assert.equal(vulkan.available, false);
  assert.equal(vulkan.reason, "Vulkan backend reported no Vulkan devices.");

  const fallback = describeGpuFallback({ cuda, vulkan });
  assert.match(fallback, /^No compatible GPU image backend is available/);
  assert.match(fallback, /Using CPU\.$/);
  assert.match(fallback, /CUDA: No NVIDIA GPU was detected/);
});

test("software Vulkan devices (llvmpipe, Basic Render) are never selected for inference", () => {
  const log = [
    "ggml_vulkan: 0 = llvmpipe (LLVM 15.0.7, 256 bits) (llvmpipe) | uma: 1 | fp16: 0",
    "ggml_vulkan: 1 = Microsoft Basic Render Driver (Microsoft) | uma: 1 | fp16: 0",
  ].join("\n");
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: null,
    probe: tableProbe({ 0: ACCEPTED(log), 1: ACCEPTED(log) }),
  });
  assert.equal(vulkan.available, false);
  assert.equal(vulkan.device, null);
  assert.match(vulkan.reason, /Only software Vulkan devices/);
});

test("no GPU backend installed produces a clear CPU-only reason", () => {
  const cuda = selectCudaBackend({ installed: false, probe: tableProbe({}) });
  const vulkan = selectVulkanBackend({ installed: false, probe: tableProbe({}) });
  assert.equal(describeGpuFallback({ cuda, vulkan }), "No GPU image backend is installed; using CPU.");
});

// ── Regression: explicit user preferences ─────────────────────────────────────

test("SD_VULKAN_DEVICE preference is respected when the device is usable", () => {
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    preference: parseDevicePreference("vulkan0", "vulkan"),
    probe: tableProbe({ 0: ACCEPTED(HYBRID_VULKAN_LOG), 1: ACCEPTED(HYBRID_VULKAN_LOG) }),
  });
  assert.equal(vulkan.device.index, 0);
  assert.equal(vulkan.device.source, "user-preference");
  assert.ok(vulkan.notes.some((note) => /from SD_VULKAN_DEVICE/.test(note)));
});

test("an unsupported SD_VULKAN_DEVICE is explained and automatic selection is used", () => {
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    preference: parseDevicePreference("vulkan5", "vulkan"),
    probe: tableProbe({ 0: ACCEPTED(HYBRID_VULKAN_LOG), 1: ACCEPTED(HYBRID_VULKAN_LOG) }),
  });
  assert.equal(vulkan.device.index, 1);
  assert.equal(vulkan.device.source, "auto");
  assert.ok(vulkan.notes.some((note) => /SD_VULKAN_DEVICE=vulkan5 is not a usable Vulkan device/.test(note)));
});

test("a preferred Vulkan device that fails its probe is not used silently", () => {
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: HYBRID_INVENTORY,
    nvidiaPresent: true,
    preference: parseDevicePreference("vulkan1", "vulkan"),
    probe: tableProbe({ 0: ACCEPTED(HYBRID_VULKAN_LOG), 1: FAILED("out of device memory") }),
  });
  assert.equal(vulkan.device.index, 0);
  assert.ok(vulkan.notes.some((note) => /SD_VULKAN_DEVICE=vulkan1 is not a usable Vulkan device/.test(note)));
});

test("SD_CUDA_DEVICE selects a specific NVIDIA device when it initializes", () => {
  const smi = {
    ok: true,
    error: null,
    devices: parseNvidiaSmiCsv([
      "0, NVIDIA GeForce RTX 4090, 24576, 23000, Enabled, 00000000:01:00.0",
      "1, NVIDIA GeForce RTX 3060, 12288, 11000, Disabled, 00000000:02:00.0",
    ].join("\n")),
  };
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: smi,
    inventory: null,
    preference: parseDevicePreference("cuda1", "cuda"),
    probe: tableProbe({ 0: ACCEPTED(), 1: ACCEPTED() }),
  });
  assert.equal(cuda.device.index, 1);
  assert.equal(cuda.device.source, "nvidia-smi");
});

test("requested backend is honored when available and explained when not", () => {
  const available = new Set(["cpu", "vulkan"]);
  assert.deepEqual(
    resolveRequestedBackend({ requested: "vulkan", available, defaultType: "cpu" }),
    { resolved: "vulkan", reason: null },
  );
  assert.deepEqual(
    resolveRequestedBackend({ requested: "auto", available, defaultType: "vulkan" }),
    { resolved: "vulkan", reason: null },
  );
  const unavailable = resolveRequestedBackend({
    requested: "cuda",
    available,
    defaultType: "vulkan",
    unavailableReasons: { cuda: "No NVIDIA GPU was detected (nvidia-smi: nvidia-smi was not found)." },
  });
  assert.equal(unavailable.resolved, "vulkan");
  assert.match(unavailable.reason, /Requested backend "cuda" is not available: No NVIDIA GPU was detected/);
  assert.match(unavailable.reason, /Using vulkan instead\.$/);
});

// ── Helpers used by serve.cjs ─────────────────────────────────────────────────

test("primary GPU for display and VRAM budgeting prefers discrete over the display iGPU", () => {
  const primary = pickPrimaryGpu(HYBRID_INVENTORY);
  assert.equal(primary.name, "NVIDIA GeForce RTX 5060 Laptop GPU");

  const amdFirstFromPowerShell = parseWindowsVideoControllers([
    { Name: "AMD Radeon(TM) 610M", VRAM: 2, DisplayAttached: true },
    { Name: "NVIDIA GeForce RTX 5060 Laptop GPU", VRAM: 4, DisplayAttached: false },
  ]);
  assert.equal(pickPrimaryGpu(amdFirstFromPowerShell).name, "NVIDIA GeForce RTX 5060 Laptop GPU");

  // The iGPU reports a huge shared-memory heap, but a discrete GPU still wins.
  const ranked = rankGpuDevices([
    { name: "AMD Radeon(TM) 610M", integrated: true, vramGb: 16 },
    { name: "NVIDIA GeForce RTX 5060 Laptop GPU", integrated: false, vramGb: 8 },
  ]);
  assert.equal(ranked[0].name, "NVIDIA GeForce RTX 5060 Laptop GPU");
});

// ── Wiring: serve.cjs uses the selection layers and the old heuristics are gone ──

test("serve.cjs uses the selection module and no longer hard-codes vulkan0/cuda0 for launches", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /require\("\.\/gpu-selection\.cjs"\)/);
  assert.doesNotMatch(server, /if \(osPlatform !== "linux"\) return cachedPreferredVulkanBackend;/);
  assert.doesNotMatch(server, /args\.push\("--backend", "cuda0"/);
  assert.match(server, /args\.push\("--backend", selectedCudaBackend/);
  assert.match(server, /args\.push\("--backend", selectedVulkanBackend/);
  assert.doesNotMatch(server, /function hasNvidiaGpu\(/);
});

test("serve.cjs probes a specific device and reports the selected device rather than the first log line", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /probeBackendDevice\(vulkanPath, "vulkan", `vulkan\$\{index\}`\)/);
  assert.match(server, /probeBackendDevice\(cudaPath, "cuda", `cuda\$\{index\}`\)/);
  assert.match(server, /findDeviceNameInLog\(cleanOutput, requestedBackend, selectedBackendDevice\.index\)/);
  assert.doesNotMatch(server, /const deviceMatch = cleanOutput\.match\(\/Device/);
});

test("serve.cjs exposes selection details, a refresh path, and a re-check for CPU-only results", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /\/\[\?&\]refresh=1/);
  assert.match(server, /GPU_NEGATIVE_CACHE_TTL_MS/);
  assert.match(server, /selection: \{\s*cuda: summarizeBackendSelection/);
  assert.match(server, /backendNote: backendRequestNote/);
});

test("the GPU selection module has no process, filesystem, or network access", () => {
  const source = read("scripts/server/gpu-selection.cjs");
  assert.doesNotMatch(source, /require\("(child_process|fs|net|http|https)"\)/);
});


test("host hardware refresh has its own cache path and refuses to run while model runtimes are active", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /function refreshHardwareDiscoveryState\(\)/);
  assert.match(server, /if \(backendProc !== null \|\| llmProc !== null\)/);
  assert.match(server, /req\.url\.split\("\?"\)\[0\] === "\/api\/hardware-specs"/);
  assert.match(server, /if \(refresh\) refreshHardwareDiscoveryState\(\)/);

  const api = read("app/frontend/src/services/api.js");
  assert.match(api, /getHardwareSpecs\(\{ refresh = false \} = \{\}\)/);
  assert.match(api, /api\/hardware-specs\\\$\{refresh \? "\?refresh=1" : ""\}/);

  const sidebar = read("app/frontend/src/components/Sidebar.jsx");
  assert.match(sidebar, /Primary detected GPU:/);
  assert.match(sidebar, /disabled=\{!canRefreshSpecs \|\| isRefreshingSpecs\}/);

  const topBar = read("app/frontend/src/components/TopStatusBar.jsx");
  assert.match(topBar, /Last image device:/);
  assert.match(topBar, /not necessarily the active inference device/);
});
