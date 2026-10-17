// Tests for backend failure classification (Stage F).
//
// EXECUTED: classifyBackendFailure() runs on realistic error strings. The strings are examples of
// what a backend or the app prints, not captures from the target GPU. Unclassified text is labelled
// "unknown" and is never guessed into a category.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const { classifyBackendFailure } = require(path.join(root, "scripts", "server", "failure-classification.cjs"));
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("no error text and a zero exit code is not classified; a nonzero exit with no text is unknown", () => {
  assert.equal(classifyBackendFailure({ output: "", exitCode: 0 }), null);
  assert.equal(classifyBackendFailure({ output: "   \n" }), null);
  const silent = classifyBackendFailure({ output: "", exitCode: 1 });
  assert.equal(silent.category, "unknown");
  assert.equal(silent.detail, "exited with code 1");
});

test("device-level CUDA and Vulkan failures are classified as device", () => {
  assert.equal(classifyBackendFailure({ output: "CUDA error: no kernel image is available for execution on the device" }).category, "device");
  assert.equal(classifyBackendFailure({ output: "ggml_vulkan: vkCreateDevice failed: -3" }).category, "device");
  assert.equal(classifyBackendFailure({ output: "ggml_cuda_init: failed to initialize CUDA: invalid device ordinal" }).category, "device");
  const found = classifyBackendFailure({ output: "loading model\nCUDA driver version is insufficient for CUDA runtime version" });
  assert.equal(found.category, "device");
  assert.match(found.detail, /CUDA driver version is insufficient/);
});

test("an out-of-device-memory error is out-of-memory, not device, even though it names Vulkan", () => {
  const result = classifyBackendFailure({ output: "ggml_vulkan: vkAllocateMemory: VK_ERROR_OUT_OF_DEVICE_MEMORY" });
  assert.equal(result.category, "out-of-memory");
});

test("allocation failures are out-of-memory", () => {
  assert.equal(classifyBackendFailure({ output: "ggml_cuda: cudaErrorMemoryAllocation: out of memory" }).category, "out-of-memory");
  assert.equal(classifyBackendFailure({ output: "failed to allocate 2048 MiB of buffer" }).category, "out-of-memory");
});

test("a missing DLL is missing-runtime, not device, even though the device patterns also mention DLLs", () => {
  const result = classifyBackendFailure({ output: "error: vulkan-1.dll not found" });
  assert.equal(result.category, "missing-runtime");
});

test("a missing shared library on Linux is missing-runtime", () => {
  const result = classifyBackendFailure({ output: "./sd-server: error while loading shared libraries: libcudart.so.12: cannot open shared object file" });
  assert.equal(result.category, "missing-runtime");
  assert.match(classifyBackendFailure({ output: "version `GLIBC_2.38' not found" }).category, /missing-runtime/);
});

test("Windows exit codes are recognised by number on Windows and by hex text anywhere", () => {
  assert.equal(classifyBackendFailure({ output: "", exitCode: 3221225781, platform: "win32" }).category, "missing-runtime");
  assert.equal(classifyBackendFailure({ output: "", exitCode: 3221225501, platform: "win32" }).category, "unsupported-cpu");
  // Stored error text (from describeBackendExitCode) names the hex value.
  assert.equal(classifyBackendFailure({ output: "exited with code 3221225501 (0xC000001D: illegal CPU instruction)." }).category, "unsupported-cpu");
  assert.equal(classifyBackendFailure({ output: "exited with code 3221225781 (0xC0000135: required DLL not found)." }).category, "missing-runtime");
});

test("a Windows exit code is not read as a CPU or DLL fault on Linux", () => {
  const result = classifyBackendFailure({ output: "", exitCode: 3221225501, platform: "linux" });
  assert.equal(result.category, "unknown", "no text and no matching platform: not guessed");
});

test("a corrupt or incomplete model file is model-file", () => {
  const result = classifyBackendFailure({ output: "[ERROR] read tensor data failed\nload tensors from file failed" });
  assert.equal(result.category, "model-file");
  assert.equal(classifyBackendFailure({ output: "the file is incomplete or corrupted" }).category, "model-file");
});

test("the generic new_sd_ctx_t failure is model-context, because its cause is not known", () => {
  const result = classifyBackendFailure({ output: "[ERROR] new_sd_ctx_t failed" });
  assert.equal(result.category, "model-context");
  assert.match(result.label, /cause not identified/);
});

test("unrecognised text is labelled unknown and is not guessed into a category", () => {
  const result = classifyBackendFailure({ output: "Backend server failed to start after applying configuration changes." });
  assert.equal(result.category, "unknown");
  assert.equal(result.detail, null);
});

test("the precedence order holds when several patterns are present", () => {
  // Out-of-memory beats device, and a model-file line beats model-context.
  assert.equal(classifyBackendFailure({ output: "CUDA error\nout of memory" }).category, "out-of-memory");
  assert.equal(classifyBackendFailure({ output: "new_sd_ctx_t failed\nread tensor data failed" }).category, "model-file");
});

test("the server attaches the category to both status responses, and the existing error text is kept", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /require\("\.\/failure-classification\.cjs"\)/);
  const statusCount = (server.match(/errorCategory: backendError \? classifyBackendFailure\(\{ output: backendError, platform: osPlatform \}\) : null/g) || []).length;
  assert.equal(statusCount, 2, "both status outputs carry the category");
  // The error text itself is still returned unchanged.
  assert.match(server, /error: backendError,/);
});
