// generationFailure.js — turns an image-generation failure into short, actionable text.
//
// Pure functions only: no DOM and no network, so the same code runs in the app and in the tests.
// The category comes from the server (see failure-classification.cjs) through the
// X-Studio-Error-Category header. A failure with no reliable evidence is "unknown". No text here
// claims a model-compatibility problem, because the evidence never supports one for a generic error.

export const GENERATION_FAILURE_CATEGORIES = [
  "out-of-memory",
  "device",
  "missing-runtime",
  "model-file",
  "unsupported-cpu",
  "model-context",
  "timeout",
  "unknown",
];

const CATEGORY_TEXT = {
  "out-of-memory": {
    title: "Out of memory",
    action: "The backend ran out of memory while generating. Try a smaller size or fewer steps, close other memory-heavy apps, and generate again. Nothing was changed automatically.",
    showsSizeHint: true,
  },
  device: {
    title: "GPU or driver error",
    action: "The GPU or its driver reported an error. Check the GPU driver, restart the app, and try again. The app did not switch to another device.",
  },
  "missing-runtime": {
    title: "Missing runtime file",
    action: "The backend could not load a file it needs at runtime, such as a DLL. Run the setup script again, then retry.",
  },
  "model-file": {
    title: "Model file missing or unreadable",
    action: "The backend could not find or read the model file, or the file is incomplete. Check the file in Model Manager, or import it again.",
  },
  "unsupported-cpu": {
    title: "CPU feature not supported",
    action: "The backend needs a CPU instruction set that this computer does not report. The backend build does not match this CPU.",
  },
  "model-context": {
    title: "Backend could not set up the model",
    action: "The backend failed while creating the model context. Its output does not say why, so no cause is claimed. Check the diagnostic below.",
  },
  timeout: {
    title: "Generation timed out",
    action: "The backend did not finish within the app's time limit. Nothing was changed automatically and no other device was tried. Try a smaller size or fewer steps, then start the generation again yourself.",
  },
  unknown: {
    title: "Generation failed",
    action: "The cause could not be identified from the backend output. Check the diagnostic below. No cause is claimed.",
  },
};

const DEFAULT_RAW_CHARS = 2000;

// Hides user folder names in a diagnostic before it is shown. Bounded, so a long log stays small.
export function sanitizeDiagnostic(text, maxChars = DEFAULT_RAW_CHARS) {
  let out = String(text === undefined || text === null ? "" : text);
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"'<>|]+/g, "C:\\Users\\<user>");
  out = out.replace(/\/(home|Users)\/[^/\s"'<>|:]+/g, "/$1/<user>");
  const truncated = out.length > maxChars;
  if (truncated) out = `${out.slice(0, maxChars)}\n...[truncated]`;
  return { text: out, truncated };
}

// Returns what the failure panel shows. An unknown or missing category falls back to "unknown".
export function describeGenerationFailure({ category = null, message = "", raw = "" } = {}) {
  const key = Object.prototype.hasOwnProperty.call(CATEGORY_TEXT, category) ? category : "unknown";
  const text = CATEGORY_TEXT[key];
  const diagnostic = sanitizeDiagnostic(raw);
  return {
    category: key,
    title: text.title,
    action: text.action,
    showsSizeHint: text.showsSizeHint === true,
    message: sanitizeDiagnostic(message, 300).text,
    raw: diagnostic.text,
    rawTruncated: diagnostic.truncated,
  };
}

// The Error thrown for a failed generation response. `generationFailure` lets callers tell it apart
// from network errors, so it is not replaced by a generic message.
export function createGenerationFailure({ status = null, category = null, message = "", raw = "" } = {}) {
  const error = new Error(message || "Generation failed");
  error.generationFailure = true;
  error.status = status;
  error.category = Object.prototype.hasOwnProperty.call(CATEGORY_TEXT, category) ? category : "unknown";
  error.raw = String(raw || "");
  return error;
}
