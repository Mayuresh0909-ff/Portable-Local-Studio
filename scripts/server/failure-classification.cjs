// failure-classification.cjs — names the kind of failure in a backend error, for diagnosis.
//
// This is a label, not a fix. It does not change what the app does. The status endpoints expose
// it next to the existing error text, so a user or a log reader can tell a driver problem from a
// bad model file. Automatic CPU fallback is a separate, pending item.
//
// Input is the error text the app already keeps (backendError), or raw backend output, plus an
// optional exit code. Checks run in a fixed order. The first match wins:
//   1. out-of-memory        2. missing-runtime      3. unsupported-cpu
//   4. device               5. model-file          6. model-context (cause not identified)
//   7. timeout              8. unknown
// Out-of-memory comes first because VK_ERROR_OUT_OF_DEVICE_MEMORY would otherwise match the device
// patterns. Missing DLLs and shared libraries come before device checks, because a missing library
// is not a device fault.

const CATEGORY_LABELS = {
  "out-of-memory": "Out of memory (RAM or VRAM)",
  "missing-runtime": "Missing or incompatible runtime library",
  "unsupported-cpu": "CPU instruction not supported by this backend build",
  device: "Device or driver failure",
  "model-file": "Model file incomplete or unreadable",
  "model-context": "Backend could not create the model context (cause not identified)",
  timeout: "Timed out before the backend finished",
  unknown: "Unclassified backend failure",
};

const OUT_OF_MEMORY_PATTERNS = [
  /out of (device )?memory/i,
  /cudaErrorMemoryAllocation/i,
  /VK_ERROR_OUT_OF_(DEVICE_|HOST_)?MEMORY/,
  /failed to allocate \d/i,
  /not enough (free )?(RAM|VRAM|memory)/i,
  /std::bad_alloc/,
];

const MISSING_RUNTIME_PATTERNS = [
  /error while loading shared libraries/i,
  /cannot open shared object file/i,
  /\bGLIBC(XX)?_[\d.]+\b/,
  /\b(vcomp|msvcp|vcruntime|vulkan-1|cudart|cublas|cudnn)[\w.-]*\.dll\b[^\n]*\b(not found|missing|cannot|could not|is not a valid)/i,
  /could not load [\w.-]+\.dll/i,
];

const DEVICE_PATTERNS = [
  /vkCreateDevice failed/i,
  /VK_ERROR_(INITIALIZATION_FAILED|DEVICE_LOST|INCOMPATIBLE_DRIVER|FEATURE_NOT_PRESENT)/,
  /no (usable |compatible )?(vulkan|cuda|gpu) devices?\b/i,
  /CUDA error/i,
  /\bcudaError\w+/,
  /no kernel image is available/i,
  /no CUDA-capable device/i,
  /CUDA driver version is insufficient/i,
  /ggml_(cuda|vulkan)_init:[^\n]*\b(failed|error)\b/i,
  /incompatible (driver|runtime|kernel)/i,
];

// "Illegal instruction" is the shell's name for SIGILL. describeBackendSignalExit() writes the second form.
const UNSUPPORTED_CPU_PATTERNS = [/illegal instruction/i, /\bSIGILL\b/];

const MODEL_FILE_PATTERNS = [
  /read tensor data failed/i,
  /load tensors from file failed/i,
  /incomplete or corrupted/i,
  /invalid safetensors/i,
  // The app's own pre-launch checks (getModelLoadIssue in serve.cjs) use these two messages.
  /model file not found/i,
  /is too small to be a complete image model/i,
];

const MODEL_CONTEXT_PATTERNS = [/new_sd_ctx_t failed/i];

// Only explicit timeout wording. Nothing here is inferred from silence or from a slow run.
const TIMEOUT_PATTERNS = [/\btimed out\b/i, /\btimeout exceeded\b/i];

// Windows exit codes, as reported by Node (unsigned values).
const WINDOWS_EXIT_CPU = 0xC000001D;
const WINDOWS_EXIT_DLL = 0xC0000135;

function firstLineMatching(text, patterns) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && patterns.some((pattern) => pattern.test(trimmed))) return trimmed.slice(0, 240);
  }
  return null;
}

function anyMatch(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

// Returns { category, label, detail } or null when there is no error to classify.
// detail is the matching line of text, or the exit code description.
function classifyBackendFailure({ output = "", exitCode = null, platform = "linux" } = {}) {
  const text = String(output || "");
  const unsigned = exitCode === null || exitCode === undefined ? null : Number(exitCode) >>> 0;
  const make = (category, detail) => ({ category, label: CATEGORY_LABELS[category], detail: detail || null });

  if (anyMatch(text, OUT_OF_MEMORY_PATTERNS)) {
    return make("out-of-memory", firstLineMatching(text, OUT_OF_MEMORY_PATTERNS));
  }
  // The stored error text names Windows exit codes in hex, so the text is checked as well as the number.
  if ((platform === "win32" && unsigned === WINDOWS_EXIT_DLL) || /0xC0000135/i.test(text)) {
    return make("missing-runtime", "Windows exit code 0xC0000135: a required DLL was not found.");
  }
  if ((platform === "win32" && unsigned === WINDOWS_EXIT_CPU) || /0xC000001D/i.test(text)) {
    return make("unsupported-cpu", "Windows exit code 0xC000001D: illegal CPU instruction.");
  }
  if (anyMatch(text, MISSING_RUNTIME_PATTERNS)) {
    return make("missing-runtime", firstLineMatching(text, MISSING_RUNTIME_PATTERNS));
  }
  if (anyMatch(text, UNSUPPORTED_CPU_PATTERNS)) {
    return make("unsupported-cpu", firstLineMatching(text, UNSUPPORTED_CPU_PATTERNS));
  }
  if (anyMatch(text, DEVICE_PATTERNS)) {
    return make("device", firstLineMatching(text, DEVICE_PATTERNS));
  }
  if (anyMatch(text, MODEL_FILE_PATTERNS)) {
    return make("model-file", firstLineMatching(text, MODEL_FILE_PATTERNS));
  }
  if (anyMatch(text, MODEL_CONTEXT_PATTERNS)) {
    return make("model-context", firstLineMatching(text, MODEL_CONTEXT_PATTERNS));
  }
  if (anyMatch(text, TIMEOUT_PATTERNS)) {
    return make("timeout", firstLineMatching(text, TIMEOUT_PATTERNS));
  }
  if (text.trim()) {
    return make("unknown", null);
  }
  // A nonzero exit with no output is a failure, even though nothing can be matched.
  if (unsigned !== null && unsigned !== 0) {
    return make("unknown", `exited with code ${exitCode}`);
  }
  return null;
}

// Text for a backend process that ended by a signal rather than an exit code. The app records it
// only when the app did not stop the process itself (see serve.cjs). SIGILL is named as an illegal
// instruction. Other signals are stated without a cause, because the output does not show one.
function describeBackendSignalExit(signal) {
  if (!signal) return null;
  const name = String(signal);
  if (name === "SIGILL") {
    return "The backend process stopped with SIGILL (illegal instruction). The backend build may use a CPU instruction that this processor does not support.";
  }
  return `The backend process stopped by signal ${name} while running. The output does not say why.`;
}

// Header that carries the category of a failed image-generation response to the browser.
const ERROR_CATEGORY_HEADER = "X-Studio-Error-Category";
const CLASSIFY_CHARS = 8000;

// Category for an error response from the image backend. It uses only the response body and the
// captured backend error text. With no reliable evidence the answer is "unknown". A generic error is
// never reported as a model-compatibility problem.
function generationErrorCategory({ body = "", backendError = "", platform = process.platform } = {}) {
  const text = `${String(body || "").slice(0, CLASSIFY_CHARS)}\n${String(backendError || "").slice(-CLASSIFY_CHARS)}`;
  const found = classifyBackendFailure({ output: text, platform });
  return found ? found.category : "unknown";
}

module.exports = {
  CATEGORY_LABELS,
  classifyBackendFailure,
  describeBackendSignalExit,
  generationErrorCategory,
  ERROR_CATEGORY_HEADER,
};
