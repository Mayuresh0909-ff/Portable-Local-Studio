// Behaviour tests for the shared backend-probe launch and the nvidia-smi query.
//
// EXECUTED: these tests call the real functions in scripts/server/gpu-selection.cjs and
// scripts/server/gpu-probe-runner.cjs. Only the process spawn is replaced by a fake, so no GPU,
// driver, or backend binary is needed. Backend output strings are examples of what a backend
// prints. They are not captures from the RTX 5060.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const selection = require(path.join(root, "scripts", "server", "gpu-selection.cjs"));
const runner = require(path.join(root, "scripts", "server", "gpu-probe-runner.cjs"));

const MISSING = "/models/__backend_probe_missing__.safetensors";

// ── Probe arguments and environment ─────────────────────────────────────────────

test("probe args pin the device and use the 5 second timeout", () => {
  assert.deepEqual(
    selection.buildBackendProbeArgs({ cliName: "cuda0", missingModelPath: MISSING }),
    ["--backend", "cuda0", "--params-backend", "cuda0", "--model", MISSING, "--listen-port", "18082"],
  );
  assert.equal(selection.PROBE_TIMEOUT_MS, 5000);
  const options = selection.buildBackendProbeSpawnOptions({ X: "1" });
  assert.equal(options.timeout, 5000);
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(options.env, { X: "1" });
});

test("metal probes receive no device flag, only model and port", () => {
  assert.deepEqual(
    selection.buildBackendProbeArgs({ cliName: "metal", missingModelPath: MISSING }),
    ["--model", MISSING, "--listen-port", "18082"],
  );
});

test("fallback args never include a device flag", () => {
  const args = selection.buildBackendProbeFallbackArgs({ missingModelPath: MISSING });
  assert.deepEqual(args, ["--model", MISSING, "--listen-port", "18082"]);
  assert.equal(args.includes("--backend"), false);
});

test("CUDA probes pin PCI bus order and prepend the binary folder on Linux", () => {
  const env = selection.buildBackendProbeEnv({
    baseEnv: { LD_LIBRARY_PATH: "/opt/x" },
    backendName: "cuda",
    platform: "linux",
    libraryDir: "/app/backend/linux/cuda",
  });
  assert.equal(env.CUDA_DEVICE_ORDER, "PCI_BUS_ID");
  assert.equal(env.LD_LIBRARY_PATH, "/app/backend/linux/cuda:/opt/x");
});

test("library path is not set when the platform has none to set", () => {
  const env = selection.buildBackendProbeEnv({
    baseEnv: {}, backendName: "vulkan", platform: "win32", libraryDir: "C:\\backend",
  });
  assert.equal(env.CUDA_DEVICE_ORDER, undefined);
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.DYLD_LIBRARY_PATH, undefined);
});

// ── Probe sequence (fake run function) ──────────────────────────────────────────

function fakeRun(responses) {
  const calls = [];
  const run = (binaryPath, args, options) => {
    calls.push({ binaryPath, args, options });
    return responses.shift();
  };
  return { run, calls };
}

const LOADING_OUTPUT = [
  "ggml_cuda_init: found 1 CUDA devices",
  "  Device 0: NVIDIA GeForce RTX 5060 Laptop GPU",
  "stable-diffusion.cpp",
  "loading model from '__backend_probe_missing__.safetensors'",
  "error: model file not found",
].join("\n");

test("a pinned probe that reaches model loading is accepted with initConfirmed", () => {
  const { run, calls } = fakeRun([{ output: LOADING_OUTPUT, exitCode: 1, errorCode: null }]);
  const { verdict, supportsFlags } = selection.runBackendProbeSequence({
    run, binaryPath: "/bin/sd", cliName: "cuda0", missingModelPath: MISSING, platform: "linux",
    spawnOptions: { timeout: 5000 },
  });
  assert.equal(calls.length, 1, "no fallback when the binary accepts --backend");
  assert.deepEqual(calls[0].args.slice(0, 2), ["--backend", "cuda0"]);
  assert.equal(supportsFlags, true);
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.initConfirmed, true);
  assert.equal(verdict.stage, undefined, "stage is a classifier input, not an output");
});

test("a binary that rejects --backend is retried without device flags, and the verdict says so", () => {
  const { run, calls } = fakeRun([
    { output: "error: unknown argument '--backend'", exitCode: 1, errorCode: null },
    { output: "stable-diffusion.cpp\nmodel file not found __backend_probe_missing__.safetensors", exitCode: 1, errorCode: null },
  ]);
  const { verdict, supportsFlags } = selection.runBackendProbeSequence({
    run, binaryPath: "/bin/sd", cliName: "cuda0", missingModelPath: MISSING, platform: "linux",
    spawnOptions: { timeout: 5000 },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes("--backend"), false, "fallback drops device flags");
  assert.equal(supportsFlags, false);
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.initConfirmed, false, "missing-model output does not confirm the device");
  assert.match(verdict.note, /not that the device initialized/);
});

test("a timed-out probe is reported as a probe error, not as a rejection, and is not retried", () => {
  const { run, calls } = fakeRun([{ output: "", exitCode: null, errorCode: "ETIMEDOUT" }]);
  const { verdict } = selection.runBackendProbeSequence({
    run, binaryPath: "/bin/sd", cliName: "vulkan0", missingModelPath: MISSING, platform: "linux",
    spawnOptions: { timeout: 5000 },
  });
  assert.equal(calls.length, 1);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.probeError, "timeout");
  assert.match(verdict.reason, /timed out after 5 seconds/);
});

test("a fallback that produces no output is reported as no-output, not as a device failure", () => {
  const { run } = fakeRun([
    { output: "error: unknown argument '--backend'", exitCode: 1, errorCode: null },
    { output: "   ", exitCode: 1, errorCode: null },
  ]);
  const { verdict, supportsFlags } = selection.runBackendProbeSequence({
    run, binaryPath: "/bin/sd", cliName: "cuda0", missingModelPath: MISSING, platform: "linux",
    spawnOptions: { timeout: 5000 },
  });
  assert.equal(supportsFlags, false);
  assert.equal(verdict.probeError, "no-output");
  assert.equal(verdict.deviceFailure, undefined);
});

test("an explicit device error in the output rejects the device and quotes the line", () => {
  const { run } = fakeRun([{
    output: "ggml_vulkan: vkCreateDevice failed: VK_ERROR_INITIALIZATION_FAILED\nloading model",
    exitCode: 1, errorCode: null,
  }]);
  const { verdict } = selection.runBackendProbeSequence({
    run, binaryPath: "/bin/sd", cliName: "vulkan1", missingModelPath: MISSING, platform: "linux",
    spawnOptions: { timeout: 5000 },
  });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.deviceFailure, true);
  assert.match(verdict.reason, /vkCreateDevice failed/);
});

// ── nvidia-smi query (fake spawn) ───────────────────────────────────────────────

const SMI_FULL_CSV = "0, NVIDIA GeForce RTX 5060 Laptop GPU, 8151, 7000, Disabled, 00000000:01:00.0, 581.57, 12.0\n";

test("nvidia-smi CSV maps driver_version and compute_cap, and rejects malformed values", () => {
  const devices = selection.parseNvidiaSmiCsv([
    "0, NVIDIA GeForce RTX 5060 Laptop GPU, 8151, 7000, Disabled, 00000000:01:00.0, 581.57, 12.0",
    "1, NVIDIA RTX A2000, [N/A], [N/A], Enabled, 00000000:02:00.0, [N/A], [N/A]",
    "2, NVIDIA Tesla X, 1024, 900, Disabled, 00000000:03:00.0, 581.57.1-beta, 8.6.1",
  ].join("\n"));
  assert.equal(devices[0].driverVersion, "581.57");
  assert.equal(devices[0].computeCap, "12.0");
  assert.equal(devices[1].driverVersion, null);
  assert.equal(devices[1].computeCap, null);
  assert.equal(devices[2].computeCap, null, "a three-part capability is not a valid compute_cap value");
  assert.equal(devices[2].driverVersion, null, "a driver string with a suffix is not accepted");
});

test("nvidia-smi CSV without the new columns (older query) still parses, with null fields", () => {
  const devices = selection.parseNvidiaSmiCsv("0, NVIDIA GeForce RTX 3060, 12288, 11000, Enabled, 00000000:01:00.0");
  assert.equal(devices[0].computeCap, null);
  assert.equal(devices[0].driverVersion, null);
  assert.equal(devices[0].busId, "00000000:01:00.0");
});

test("nvidia-smi requests the full query first, including driver and compute capability", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args[0]);
    return { status: 0, stdout: SMI_FULL_CSV, stderr: "" };
  };
  const result = runner.queryNvidiaSmi({ platform: "linux", spawn, exists: () => true });
  assert.equal(result.ok, true);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].name, "NVIDIA GeForce RTX 5060 Laptop GPU");
  assert.equal(result.devices[0].displayActive, false);
  assert.equal(result.devices[0].busId, "00000000:01:00.0");
  assert.equal(result.devices[0].driverVersion, "581.57");
  assert.equal(result.devices[0].computeCap, "12.0");
  assert.equal(calls[0], "--query-gpu=index,name,memory.total,memory.free,display_active,pci.bus_id,driver_version,compute_cap");
  assert.equal(calls.length, 1, "no fallback query when the first one works");
});

test("a driver that rejects compute_cap falls back to the query without it, and the fields are null", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args[0]);
    if (calls.length === 1) return { status: 2, stdout: "", stderr: 'Field "compute_cap" is not a valid field to query.' };
    return { status: 0, stdout: "0, NVIDIA GeForce RTX 3060, 12288, 11000, Enabled, 00000000:01:00.0, 566.36\n", stderr: "" };
  };
  const result = runner.queryNvidiaSmi({ platform: "linux", spawn, exists: () => true });
  assert.equal(calls.length, 2);
  // The second query keeps driver_version and drops only compute_cap.
  assert.equal(calls[1], "--query-gpu=index,name,memory.total,memory.free,display_active,pci.bus_id,driver_version");
  assert.equal(result.ok, true);
  assert.equal(result.devices[0].computeCap, null);
  assert.equal(result.devices[0].driverVersion, "566.36");
  assert.equal(result.devices[0].displayActive, true);
});

test("nvidia-smi falls back to the smaller query when a driver rejects a field", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args[0]);
    if (calls.length === 1) return { status: 2, stdout: "", stderr: "Field \"display_active\" is not a valid field to query." };
    return { status: 0, stdout: "0, NVIDIA GeForce RTX 3060, 12288, 11000\n", stderr: "" };
  };
  const result = runner.queryNvidiaSmi({ platform: "linux", spawn, exists: () => true });
  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.devices[0].vramGb !== null, true);
  assert.equal(result.devices[0].displayActive, null);
});

test("a missing nvidia-smi is reported as not found, without throwing", () => {
  const spawn = () => ({ error: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
  const result = runner.queryNvidiaSmi({ platform: "linux", spawn, exists: () => true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "nvidia-smi was not found");
});

test("macOS does not query nvidia-smi", () => {
  let spawned = false;
  const result = runner.queryNvidiaSmi({ platform: "darwin", spawn: () => { spawned = true; return {}; } });
  assert.equal(spawned, false);
  assert.equal(result.ok, false);
});

test("the real nvidia-smi query returns a well-formed result on this machine", () => {
  // EXECUTED on whatever machine runs the tests. On a machine without NVIDIA tools the result is
  // ok:false with a reason. This does not prove that any NVIDIA GPU is present.
  const result = runner.queryNvidiaSmi();
  assert.equal(typeof result.ok, "boolean");
  assert.ok(Array.isArray(result.devices));
  if (!result.ok) assert.equal(typeof result.error, "string");
});

test("the query chain keeps driver_version when compute_cap is rejected, and reaches the oldest query in order", () => {
  // A driver that knows driver_version but not compute_cap must keep the driver version.
  // A driver that knows neither extra field must still reach the 4-field query.
  const calls = [];
  const rejects = (field) => (args) => args[0].includes(field);
  const spawn = (command, args) => {
    calls.push(args[0]);
    if (rejects("compute_cap")(args) || rejects("driver_version")(args) || rejects("display_active")(args)) {
      const field = ["compute_cap", "driver_version", "display_active"].find((f) => args[0].includes(f));
      return { status: 2, stdout: "", stderr: `Field "${field}" is not a valid field to query.` };
    }
    return { status: 0, stdout: "0, NVIDIA GeForce RTX 3060, 12288, 11000\n", stderr: "" };
  };
  const result = runner.queryNvidiaSmi({ platform: "linux", spawn, exists: () => true });
  assert.deepEqual(calls, [
    "--query-gpu=index,name,memory.total,memory.free,display_active,pci.bus_id,driver_version,compute_cap",
    "--query-gpu=index,name,memory.total,memory.free,display_active,pci.bus_id,driver_version",
    "--query-gpu=index,name,memory.total,memory.free,display_active,pci.bus_id",
    "--query-gpu=index,name,memory.total,memory.free",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.devices[0].driverVersion, null);
  assert.equal(result.devices[0].computeCap, null);
  assert.equal(result.devices[0].busId, null);
});

test("a compute capability alone does not make a CUDA backend available", () => {
  // computeCap is information only. A device with compute capability 12.0 is not usable unless
  // the backend probe accepts it.
  const nvidiaSmi = {
    ok: true,
    devices: [{ index: 0, name: "NVIDIA GeForce RTX 5060 Laptop GPU", vramGb: 8, freeVramGb: 7, displayActive: false, busId: "00000000:01:00.0", driverVersion: "580.00", computeCap: "12.0", source: "nvidia-smi" }],
  };
  const rejected = selection.selectCudaBackend({
    installed: true,
    nvidiaSmi,
    inventory: null,
    preference: null,
    probe: () => ({ accepted: false, reason: "CUDA error: device not supported by this build" }),
  });
  assert.equal(rejected.available, false, "a compute capability with a rejecting probe must not be available");

  const accepted = selection.selectCudaBackend({
    installed: true,
    nvidiaSmi,
    inventory: null,
    preference: null,
    probe: () => ({ accepted: true, initConfirmed: true }),
  });
  assert.equal(accepted.available, true, "an accepting probe makes the backend available, whatever the capability");
});
