// Tests for classifying backend probe output, and for reporting unpinned devices honestly.
//
// These tests feed realistic backend output into classifyBackendProbe() (the real classifier), not
// into hand-written accepted/rejected results. Only the spawned process is absent: the output
// strings stand in for what a backend prints. Output strings are examples, not captured logs from
// the target GPU. Real GPU behavior still needs the Windows acceptance run.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const gpu = require(path.join(root, "scripts", "server", "gpu-selection.cjs"));
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const {
  classifyBackendProbe,
  confirmUnpinnedDevice,
  findDeviceFailureLine,
  isMissingModelOutput,
  selectCudaBackend,
  selectVulkanBackend,
  shouldRetryWithoutDeviceFlags,
  parseDevicePreference,
} = gpu;

const MISSING_MODEL_PATH = "app/models/__backend_probe_missing__.safetensors";

// Realistic deliberate missing-model output: the backend starts, announces the model load, and fails
// to open the file.
const MISSING_MODEL_AFTER_LOAD = [
  "stable-diffusion.cpp version master-685-19bdfe2",
  `loading model from '${MISSING_MODEL_PATH}'`,
  `error: failed to open file: No such file or directory: '${MISSING_MODEL_PATH}'`,
].join("\n");

const VULKAN_TWO_DEVICES_HEALTHY = [
  "ggml_vulkan: Found 2 Vulkan devices:",
  "ggml_vulkan: 0 = AMD Radeon(TM) 610M (AMD proprietary driver) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 64 | shared memory: 32768 | int dot: 1 | matrix cores: none",
  "ggml_vulkan: 1 = NVIDIA GeForce RTX 5060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 1 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2",
  "stable-diffusion.cpp version master-685-19bdfe2",
  `loading model from '${MISSING_MODEL_PATH}'`,
  `error: failed to open file: No such file or directory: '${MISSING_MODEL_PATH}'`,
].join("\n");

const CUDA_HEALTHY_ONE_DEVICE = [
  "ggml_cuda_init: found 1 CUDA devices:",
  "  Device 0: NVIDIA GeForce RTX 5060 Laptop GPU, compute capability 12.0, VMM: yes",
  "stable-diffusion.cpp version master-782-b290693",
  `loading model from '${MISSING_MODEL_PATH}'`,
  `error: failed to open file: No such file or directory: '${MISSING_MODEL_PATH}'`,
].join("\n");

// Builds a probe(index) function from real output strings. Each one goes through the real classifier.
function classifyingProbe(outputs, options = {}) {
  return (index) => {
    const output = outputs[index];
    if (output === undefined) {
      return classifyBackendProbe({ output: "backend 'vulkan" + index + "' was not found", exitCode: 1, platform: "linux", cliName: `vulkan${index}`, stage: "primary", supportsFlags: true });
    }
    return classifyBackendProbe({
      output,
      exitCode: options.exitCode === undefined ? 1 : options.exitCode,
      platform: options.platform || "linux",
      cliName: options.cliName ? options.cliName(index) : `vulkan${index}`,
      stage: "primary",
      supportsFlags: options.supportsFlags !== false,
    });
  };
}

const NVIDIA_SMI_ONE = {
  ok: true,
  error: null,
  devices: [{ index: 0, name: "NVIDIA GeForce RTX 5060 Laptop GPU", vendor: "nvidia", integrated: false, virtual: false, vramGb: 8, freeVramGb: 7, displayActive: false, busId: "00000000:01:00.0" }],
};

// ── 1. Explicit initialization failures must reject, even when "loading model" appears ─────────

test("Vulkan vkCreateDevice failure is rejected even though the output says 'loading model'", () => {
  const output = [
    "ggml_vulkan: Found 1 Vulkan devices:",
    "ggml_vulkan: 0 = NVIDIA GeForce RTX 5060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1",
    "ggml_vulkan: vkCreateDevice failed: VK_ERROR_INITIALIZATION_FAILED",
    "stable-diffusion.cpp version master-685-19bdfe2",
    `loading model from '${MISSING_MODEL_PATH}'`,
    "error: failed to open file: No such file or directory",
  ].join("\n");
  const verdict = classifyBackendProbe({ output, exitCode: 1, platform: "win32", cliName: "vulkan0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.deviceFailure, true);
  // The reason is the actual error line, not a generic message.
  assert.equal(verdict.reason, "ggml_vulkan: vkCreateDevice failed: VK_ERROR_INITIALIZATION_FAILED");
});

test("Vulkan VK_ERROR_DEVICE_LOST during init is rejected", () => {
  const output = "loading model from 'x.safetensors'\nggml_vulkan: 1 = NVIDIA GeForce RTX 5060 Laptop GPU\nVK_ERROR_DEVICE_LOST";
  const verdict = classifyBackendProbe({ output, exitCode: 0, platform: "linux", cliName: "vulkan1", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.match(verdict.reason, /VK_ERROR_DEVICE_LOST/);
});

test("Vulkan 'No usable Vulkan devices' (unavailable device) is rejected with the actual line", () => {
  const output = "stable-diffusion.cpp version master-685\nggml_vulkan: No usable Vulkan devices found, aborting\nloading model from 'x.safetensors'";
  const verdict = classifyBackendProbe({ output, exitCode: 1, platform: "linux", cliName: "vulkan0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, "ggml_vulkan: No usable Vulkan devices found, aborting");
});

test("Vulkan 'failed to create device' wording is rejected, but a benign 'failed to create cache directory' is not", () => {
  const failed = classifyBackendProbe({ output: "failed to create Vulkan device\nloading model from 'x'", exitCode: 1, platform: "linux", cliName: "vulkan0", stage: "primary", supportsFlags: true });
  assert.equal(failed.accepted, false);

  // A warning that does not name a device must not reject a working backend.
  const benign = classifyBackendProbe({
    output: "warning: failed to create cache directory /tmp/sd-cache\nloading model from 'x'",
    exitCode: 1,
    platform: "linux",
    cliName: "vulkan0",
    stage: "primary",
    supportsFlags: true,
  });
  assert.equal(benign.accepted, true);
  assert.equal(benign.initConfirmed, true);
});

test("CUDA 'no kernel image is available' (incompatible kernel) is rejected even after 'loading model'", () => {
  const output = [
    "stable-diffusion.cpp version master-782-b290693",
    `loading model from '${MISSING_MODEL_PATH}'`,
    "CUDA error: no kernel image is available for execution on the device",
  ].join("\n");
  const verdict = classifyBackendProbe({ output, exitCode: 1, platform: "linux", cliName: "cuda0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, "CUDA error: no kernel image is available for execution on the device");
});

test("CUDA driver/runtime mismatch and ggml_cuda_init failure are rejected", () => {
  const driver = classifyBackendProbe({
    output: "CUDA driver version is insufficient for CUDA runtime version\nloading model from 'x'",
    exitCode: 1,
    platform: "win32",
    cliName: "cuda0",
    stage: "primary",
    supportsFlags: true,
  });
  assert.equal(driver.accepted, false);

  const init = classifyBackendProbe({
    output: "ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected\nstable-diffusion.cpp version master",
    exitCode: 1,
    platform: "linux",
    cliName: "cuda0",
    stage: "primary",
    supportsFlags: true,
  });
  assert.equal(init.accepted, false);
  assert.match(init.reason, /ggml_cuda_init: failed to initialize CUDA/);
});

test("a missing DLL on Windows is rejected with the DLL name, and the Windows DLL exit code is a validation error", () => {
  const withMessage = classifyBackendProbe({
    output: "The code execution cannot proceed because cudart64_12.dll was not found.\nloading model from 'x'",
    exitCode: 1,
    platform: "win32",
    cliName: "cuda0",
    stage: "primary",
    supportsFlags: true,
  });
  assert.equal(withMessage.accepted, false);
  assert.match(withMessage.reason, /cudart64_12\.dll was not found/);

  // 0xC0000135 (STATUS_DLL_NOT_FOUND) as an exit code, with no message.
  const withCode = classifyBackendProbe({ output: "", exitCode: 0xC0000135 - 0x100000000, platform: "win32", cliName: "vulkan0", stage: "primary", supportsFlags: true });
  assert.equal(withCode.accepted, false);
  assert.equal(withCode.validationError, true);
  assert.match(withCode.reason, /required DLL is missing/);
});

test("a Linux shared-library failure is rejected even when the banner appears", () => {
  const output = "stable-diffusion.cpp version master\nerror while loading shared libraries: libcudart.so.12: cannot open shared object file";
  const verdict = classifyBackendProbe({ output, exitCode: 127, platform: "linux", cliName: "cuda0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.match(verdict.reason, /libcudart\.so\.12/);
});

test("an incompatible driver is rejected even with exit code 0 and a banner", () => {
  const output = "stable-diffusion.cpp version master-782\nincompatible driver: 535.54 is older than the runtime requires";
  const verdict = classifyBackendProbe({ output, exitCode: 0, platform: "linux", cliName: "cuda0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.match(verdict.reason, /incompatible driver/);
});

// ── 2. Expected missing-model failures must not reject a backend ───────────────────────────────

test("expected missing-model exit after a model-load banner is accepted, with initialization confirmed", () => {
  const verdict = classifyBackendProbe({ output: MISSING_MODEL_AFTER_LOAD, exitCode: 1, platform: "linux", cliName: "vulkan0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.initConfirmed, true);
  assert.equal(verdict.reason, undefined);
  assert.equal(verdict.note, null);
});

test("a missing-model message without a model-load banner is accepted, but the device is not confirmed", () => {
  const output = `Error: model file not found: ${MISSING_MODEL_PATH}`;
  assert.equal(isMissingModelOutput(output), true);
  const verdict = classifyBackendProbe({ output, exitCode: 1, platform: "linux", cliName: "cuda0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.initConfirmed, false);
  assert.match(verdict.note, /not that the device initialized/);
});

test("a banner-only run that exits 0 is accepted, with initialization not confirmed", () => {
  const verdict = classifyBackendProbe({ output: "stable-diffusion.cpp version master-685", exitCode: 0, platform: "linux", cliName: "vulkan0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.initConfirmed, false);
});

test("a banner-only run that exits nonzero is rejected, with the exit code in the reason", () => {
  const verdict = classifyBackendProbe({ output: "stable-diffusion.cpp version master-685", exitCode: 3, platform: "linux", cliName: "vulkan0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, "The backend exited with code 3 before loading a model.");
});

test("silent failure with no output is rejected with the exit status, not treated as success", () => {
  const verdict = classifyBackendProbe({ output: "", exitCode: 139, platform: "linux", cliName: "cuda0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.probeError, undefined, "a primary run that ends without output is an ordinary rejection");
  assert.equal(verdict.reason, "The backend exited with code 139 before loading a model.");
});

test("a healthy two-device Vulkan run is accepted with initialization confirmed", () => {
  const verdict = classifyBackendProbe({ output: VULKAN_TWO_DEVICES_HEALTHY, exitCode: 1, platform: "linux", cliName: "vulkan1", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.initConfirmed, true);
});

test("a primary timeout is reported as a timeout (probeError), not as an ordinary rejection", () => {
  const verdict = classifyBackendProbe({ output: "", exitCode: null, errorCode: "ETIMEDOUT", platform: "linux", cliName: "vulkan0", stage: "primary", supportsFlags: true });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.probeError, "timeout");
  assert.equal(verdict.reason, "The probe timed out after 5 seconds.");
});

// ── 3. Unsupported device-selection flags and fallback probes ──────────────────────────────────

test("'unknown argument --backend' triggers the fallback probe, and other unknown arguments do not", () => {
  assert.equal(shouldRetryWithoutDeviceFlags("error: unknown argument '--backend'\nUsage: sd [options]"), true);
  assert.equal(shouldRetryWithoutDeviceFlags("error: unknown argument '--params-backend'"), false, "needs both the argument and --backend text");
  assert.equal(shouldRetryWithoutDeviceFlags(MISSING_MODEL_AFTER_LOAD), false);
});

test("a successful fallback probe is accepted with supportsFlags false and initialization confirmed", () => {
  const verdict = classifyBackendProbe({ output: MISSING_MODEL_AFTER_LOAD, exitCode: 1, platform: "linux", cliName: "vulkan0", stage: "fallback", supportsFlags: false });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.supportsFlags, false);
  assert.equal(verdict.initConfirmed, true);
});

test("a fallback probe that times out is reported as a fallback timeout, not as a backend rejection", () => {
  const verdict = classifyBackendProbe({ output: "", exitCode: null, errorCode: "ETIMEDOUT", platform: "linux", cliName: "vulkan0", stage: "fallback", supportsFlags: false });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.probeError, "timeout");
  assert.equal(verdict.supportsFlags, false);
  assert.equal(verdict.reason, "The fallback probe without device flags timed out after 5 seconds.");
});

test("a fallback probe that cannot be started is reported as such", () => {
  const verdict = classifyBackendProbe({ output: "", exitCode: null, errorCode: "EACCES", platform: "win32", cliName: "cuda0", stage: "fallback", supportsFlags: false });
  assert.equal(verdict.probeError, "start");
  assert.equal(verdict.reason, "The fallback probe without device flags could not be started (EACCES).");
});

test("a fallback probe killed without output is reported as a missing result, not as a rejection", () => {
  const verdict = classifyBackendProbe({ output: "   \n", exitCode: null, errorCode: null, platform: "linux", cliName: "vulkan0", stage: "fallback", supportsFlags: false });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.probeError, "no-output");
  assert.equal(verdict.reason, "The fallback probe without device flags produced no output (it ended without an exit code).");
});

test("a fallback probe that shows a device failure is still classified as a device failure", () => {
  const verdict = classifyBackendProbe({
    output: "loading model from 'x'\nCUDA error: out of memory during device init",
    exitCode: 1,
    platform: "linux",
    cliName: "cuda0",
    stage: "fallback",
    supportsFlags: false,
  });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.deviceFailure, true);
  assert.equal(verdict.probeError, undefined);
});

// ── 4. Unconfirmed device identity ────────────────────────────────────────────────────────────

test("an unpinned backend that lists several devices does not identify the active one", () => {
  assert.equal(confirmUnpinnedDevice(VULKAN_TWO_DEVICES_HEALTHY, "vulkan"), null);
});

test("an unpinned backend that lists exactly one device identifies it", () => {
  const confirmed = confirmUnpinnedDevice(CUDA_HEALTHY_ONE_DEVICE, "cuda");
  assert.ok(confirmed);
  assert.equal(confirmed.name, "NVIDIA GeForce RTX 5060 Laptop GPU");
});

test("an unpinned backend that prints no device list does not identify any device", () => {
  assert.equal(confirmUnpinnedDevice(MISSING_MODEL_AFTER_LOAD, "cuda"), null);
});

test("unpinned CUDA with no device list: the candidate is NOT reported as the active GPU", () => {
  // The binary does not accept --backend. Its output lists no devices, so the device is not confirmed.
  const probe = classifyingProbe(
    { 0: MISSING_MODEL_AFTER_LOAD },
    { supportsFlags: false, cliName: (index) => `cuda${index}` },
  );
  const cuda = selectCudaBackend({ installed: true, nvidiaSmi: NVIDIA_SMI_ONE, inventory: null, probe });
  assert.equal(cuda.available, true);
  assert.equal(cuda.device.pinned, false);
  assert.equal(cuda.device.index, null);
  assert.equal(cuda.device.identityConfirmed, false);
  assert.equal(cuda.device.name, null, "the candidate name must not be reported as the active device");
  assert.equal(cuda.device.candidateName, "NVIDIA GeForce RTX 5060 Laptop GPU");
  assert.ok(cuda.notes.some((note) => /not confirmed/.test(note)));
  assert.ok(cuda.notes.some((note) => /does not accept --backend/.test(note)));
});

test("unpinned CUDA that lists its single device: the device is reported as confirmed by the backend", () => {
  const probe = classifyingProbe({ 0: CUDA_HEALTHY_ONE_DEVICE }, { supportsFlags: false, cliName: (index) => `cuda${index}` });
  const cuda = selectCudaBackend({ installed: true, nvidiaSmi: NVIDIA_SMI_ONE, inventory: null, probe });
  assert.equal(cuda.device.pinned, false);
  assert.equal(cuda.device.identityConfirmed, true);
  assert.equal(cuda.device.name, "NVIDIA GeForce RTX 5060 Laptop GPU");
  assert.equal(cuda.device.index, null);
});

test("unpinned Vulkan with several listed devices: no device name is reported, and the preferred candidate is labelled as such", () => {
  // Device 0 probes successfully without device flags. The output lists two devices, so the backend's
  // choice is not identified.
  const probe = classifyingProbe(
    { 0: VULKAN_TWO_DEVICES_HEALTHY },
    { supportsFlags: false, cliName: (index) => `vulkan${index}` },
  );
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: null,
    nvidiaPresent: true,
    probe,
  });
  assert.equal(vulkan.available, true);
  assert.equal(vulkan.device.pinned, false);
  assert.equal(vulkan.device.index, null);
  assert.equal(vulkan.device.identityConfirmed, false);
  assert.equal(vulkan.device.name, null);
  assert.ok(vulkan.device.candidateName, "the candidate is recorded for diagnosis, not as the device in use");
  assert.ok(vulkan.notes.some((note) => /The active Vulkan device is not confirmed/.test(note)));
});

test("pinned CUDA stays confirmed by its index, and a valid preference is still respected", () => {
  const probe = classifyingProbe({ 0: CUDA_HEALTHY_ONE_DEVICE, 1: CUDA_HEALTHY_ONE_DEVICE }, { cliName: (index) => `cuda${index}` });
  const cuda = selectCudaBackend({
    installed: true,
    nvidiaSmi: {
      ok: true,
      error: null,
      devices: [
        { index: 0, name: "NVIDIA GeForce RTX 5060 Laptop GPU", vendor: "nvidia", integrated: false, virtual: false, vramGb: 8, displayActive: false },
        { index: 1, name: "NVIDIA RTX A2000", vendor: "nvidia", integrated: false, virtual: false, vramGb: 6, displayActive: false },
      ],
    },
    inventory: null,
    preference: parseDevicePreference("cuda1", "cuda"),
    probe,
  });
  assert.equal(cuda.device.index, 1);
  assert.equal(cuda.device.pinned, true);
  assert.equal(cuda.device.identityConfirmed, true);
  assert.equal(cuda.device.source, "nvidia-smi");
});

// ── 5. Real probe output flows through selection ───────────────────────────────────────────────

test("a CUDA kernel-image failure on the only NVIDIA GPU makes CUDA unavailable with that error as the reason", () => {
  const probe = classifyingProbe({
    0: [
      "stable-diffusion.cpp version master-782",
      `loading model from '${MISSING_MODEL_PATH}'`,
      "CUDA error: no kernel image is available for execution on the device",
    ].join("\n"),
  }, { cliName: (index) => `cuda${index}` });
  const cuda = selectCudaBackend({ installed: true, nvidiaSmi: NVIDIA_SMI_ONE, inventory: null, probe });
  assert.equal(cuda.available, false);
  assert.match(cuda.reason, /could not initialize device 0: CUDA error: no kernel image/);
  assert.equal(cuda.probes[0].accepted, false);
});

test("Vulkan: the NVIDIA device fails vkCreateDevice while the iGPU initializes, so the iGPU is used and the failure is reported", () => {
  // Device 0 (the iGPU) initializes. Device 1 (the NVIDIA GPU) fails in vkCreateDevice.
  const listing = [
    "ggml_vulkan: Found 2 Vulkan devices:",
    "ggml_vulkan: 0 = AMD Radeon(TM) 610M (AMD proprietary driver) | uma: 1 | fp16: 1",
    "ggml_vulkan: 1 = NVIDIA GeForce RTX 5060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1",
  ];
  const igpuOk = [...listing, "stable-diffusion.cpp version master-685", `loading model from '${MISSING_MODEL_PATH}'`, "error: failed to open file: No such file or directory"].join("\n");
  const nvidiaFails = [...listing, "ggml_vulkan: vkCreateDevice failed: VK_ERROR_INITIALIZATION_FAILED", "stable-diffusion.cpp version master-685", `loading model from '${MISSING_MODEL_PATH}'`].join("\n");
  const probe = classifyingProbe({ 0: igpuOk, 1: nvidiaFails }, { platform: "win32", cliName: (index) => `vulkan${index}` });
  const vulkan = selectVulkanBackend({
    installed: true,
    inventory: [
      { name: "AMD Radeon(TM) 610M", vendor: "amd", integrated: true, virtual: false, vramGb: 4, displayAttached: true },
      { name: "NVIDIA GeForce RTX 5060 Laptop GPU", vendor: "nvidia", integrated: false, virtual: false, vramGb: 8, displayAttached: false },
    ],
    nvidiaPresent: true,
    probe,
  });
  assert.equal(vulkan.available, true);
  assert.equal(vulkan.device.index, 0, "the device that initialized is pinned by its index");
  assert.equal(vulkan.device.identityConfirmed, true);
  assert.equal(vulkan.device.name, "AMD Radeon(TM) 610M");
  assert.deepEqual(vulkan.probes.map((p) => [p.index, p.accepted]), [[0, true], [1, false]]);
  assert.equal(vulkan.probes[1].reason, "ggml_vulkan: vkCreateDevice failed: VK_ERROR_INITIALIZATION_FAILED");
  assert.ok(vulkan.notes.some((note) => /could not initialize it: ggml_vulkan: vkCreateDevice failed/.test(note)));
});

test("Vulkan: an unpinned binary is probed once, even when its output lists several devices", () => {
  const probe = classifyingProbe({ 0: VULKAN_TWO_DEVICES_HEALTHY }, { supportsFlags: false, cliName: (index) => `vulkan${index}` });
  const seen = [];
  const recording = (index) => { seen.push(index); return probe(index); };
  const vulkan = selectVulkanBackend({ installed: true, inventory: null, nvidiaPresent: true, probe: recording });
  assert.deepEqual(seen, [0], "no other index is probed, since --backend cannot select one");
  assert.equal(vulkan.probes.length, 1);
});

test("Vulkan: every device fails with an explicit error, so Vulkan is unavailable even though 'loading model' appears", () => {
  const failing = [
    "ggml_vulkan: Found 1 Vulkan devices:",
    "ggml_vulkan: 0 = NVIDIA GeForce RTX 5060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1",
    "ggml_vulkan: vkCreateDevice failed: VK_ERROR_INCOMPATIBLE_DRIVER",
    `loading model from '${MISSING_MODEL_PATH}'`,
  ].join("\n");
  const probe = classifyingProbe({ 0: failing }, { cliName: (index) => `vulkan${index}` });
  const vulkan = selectVulkanBackend({ installed: true, inventory: null, probe });
  assert.equal(vulkan.available, false);
  assert.match(vulkan.reason, /vkCreateDevice failed: VK_ERROR_INCOMPATIBLE_DRIVER/);
});

test("findDeviceFailureLine returns the matching line verbatim, and the missing-model text alone is not a device failure", () => {
  assert.equal(findDeviceFailureLine(MISSING_MODEL_AFTER_LOAD), null);
  assert.equal(findDeviceFailureLine("ok\nCUDA error: device-side assert triggered"), "CUDA error: device-side assert triggered");
});

// ── 6. serve.cjs uses the classifier and no longer applies the old acceptance rule ──────────────

// The probe sequence moved from serve.cjs into gpu-selection.cjs (runBackendProbeSequence), so the
// same assertions now read that file. serve.cjs must delegate to it. Behaviour is also covered by
// gpu-probe-sequence.test.cjs.
test("probe classification lives in gpu-selection.cjs and serve.cjs delegates to it", () => {
  const server = read("scripts/server/serve.cjs");
  const selection = read("scripts/server/gpu-selection.cjs");
  assert.match(server, /runBackendProbeSequence\(\{/);
  assert.match(selection, /classifyBackendProbe\(\{/);
  assert.match(selection, /shouldRetryWithoutDeviceFlags\(first\.output\)/);
  assert.doesNotMatch(server, /const isOk = lower\.includes\("loading model"\)/);
  assert.doesNotMatch(selection, /const isOk = lower\.includes\("loading model"\)/);
  assert.doesNotMatch(server, /const deviceFailure = \/failed to \(create\|init\|initialize\)\/i/);
});

test("the probe sequence reports a fallback-stage result separately from a primary-stage result", () => {
  const selection = read("scripts/server/gpu-selection.cjs");
  assert.match(selection, /stage: "fallback", supportsFlags/);
  assert.match(selection, /stage: "primary", supportsFlags/);
});

test("serve.cjs never labels an unpinned device with the preferred candidate's name", () => {
  const server = read("scripts/server/serve.cjs");
  assert.doesNotMatch(server, /formatBackendDeviceLabel\(selectedBackendDevice\.name/);
  assert.match(server, /describeBackendDeviceLabel\(selectedBackendDevice, requestedBackend\)/);
  assert.match(server, /Automatic device selection \(device not confirmed\)/);
});
