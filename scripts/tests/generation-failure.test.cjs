// Tests for generation-time failure surfacing (Task 4).
//
// EXECUTED (Linux and macOS):
//   - The image proxy in the real scripts/server/serve.cjs, started as a child process, forwarding to
//     a fake image backend on loopback. The fake backend returns each error body under test.
//   - The real classification (generationErrorCategory, classifyBackendFailure).
//   - The real frontend error path: generateImage() in app/frontend/src/services/api.js, with a fake
//     fetch, and the pure text helpers in generationFailure.js.
// NOT EXECUTED: a real generation on a real GPU or backend. The error bodies are examples that the
// backend's own messages match, not captures from the RTX 5060.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const harness = require("./support/serve-harness.cjs");
const { generationErrorCategory, ERROR_CATEGORY_HEADER } = require(path.join(harness.root, "scripts", "server", "failure-classification.cjs"));
const root = harness.root;
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const OOM_BODY = JSON.stringify({ error: { message: "ggml_backend_cuda_buffer_type_alloc: out of memory while allocating 2048 MB" } });
const GENERIC_BODY = JSON.stringify({ error: { message: "internal error" } });
const CTX_BODY = JSON.stringify({ error: { message: "new_sd_ctx_t failed" } });
const SUCCESS_BODY = JSON.stringify({ images: ["iVBORw0KGgo="] });

// ── Classification of an error response (real function) ──────────────────────────

test("classification: an out-of-memory body is out-of-memory", () => {
  assert.equal(generationErrorCategory({ body: OOM_BODY, platform: "linux" }), "out-of-memory");
});

test("classification: a generic error body is unknown, never a model claim", () => {
  const category = generationErrorCategory({ body: GENERIC_BODY, platform: "linux" });
  assert.equal(category, "unknown");
  assert.notEqual(category, "model-file");
  assert.notEqual(category, "model-context");
});

test("classification: an empty body with no captured error is unknown", () => {
  assert.equal(generationErrorCategory({ body: "", backendError: "", platform: "linux" }), "unknown");
});

test("classification: the captured backend error is used when the body is empty", () => {
  assert.equal(generationErrorCategory({ body: "", backendError: "CUDA error: out of memory", platform: "linux" }), "out-of-memory");
});

test("classification: only the first 8000 characters of a long body are read, so the result is bounded", () => {
  const body = "x".repeat(20000) + " out of memory";
  assert.equal(generationErrorCategory({ body, platform: "linux" }), "unknown", "the match lies beyond the classified window");
});

// ── The real proxy in serve.cjs ─────────────────────────────────────────────────

const GENERATE_PATH = "/sdapi/v1/txt2img";
const GENERATE_PAYLOAD = JSON.stringify({ prompt: "a red cube", width: 512, height: 512, steps: 4 });

// Starts a fake backend that answers generation with the given status and body, and a serve.cjs
// that proxies to it. Returns { serve, backend, post }.
async function withProxy(status, body, extraHeaders = {}) {
  const backend = await harness.startFakeBackend((req, res) => {
    res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
    res.end(body);
  });
  const serve = await harness.startServe({ env: { BACKEND_PORT: String(backend.port) }, label: "proxy" });
  return { serve, backend };
}

const post = (port) => harness.request(port, {
  method: "POST",
  urlPath: GENERATE_PATH,
  body: GENERATE_PAYLOAD,
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(GENERATE_PAYLOAD) },
});

test("proxy: an out-of-memory error keeps its body byte for byte and adds the category header", { timeout: 60000 }, async () => {
  const { serve, backend } = await withProxy(500, OOM_BODY);
  try {
    const res = await post(serve.port);
    assert.equal(res.status, 500, "the backend's status is passed through");
    assert.equal(res.text, OOM_BODY, "the body is not changed");
    assert.equal(res.headers[ERROR_CATEGORY_HEADER.toLowerCase()], "out-of-memory");
    assert.equal(res.headers["content-length"], String(Buffer.byteLength(OOM_BODY)));
  } finally {
    await serve.stop();
    await backend.close();
  }
});

test("proxy: a generic error is categorised as unknown", { timeout: 60000 }, async () => {
  const { serve, backend } = await withProxy(500, GENERIC_BODY);
  try {
    const res = await post(serve.port);
    assert.equal(res.text, GENERIC_BODY);
    assert.equal(res.headers[ERROR_CATEGORY_HEADER.toLowerCase()], "unknown");
  } finally {
    await serve.stop();
    await backend.close();
  }
});

test("proxy: a context-creation error is categorised as model-context, which the UI does not treat as a model incompatibility", { timeout: 60000 }, async () => {
  const { serve, backend } = await withProxy(500, CTX_BODY);
  try {
    const res = await post(serve.port);
    assert.equal(res.headers[ERROR_CATEGORY_HEADER.toLowerCase()], "model-context");
  } finally {
    await serve.stop();
    await backend.close();
  }
});

test("proxy: a successful generation is passed through with no category header", { timeout: 60000 }, async () => {
  const { serve, backend } = await withProxy(200, SUCCESS_BODY);
  try {
    const res = await post(serve.port);
    assert.equal(res.status, 200);
    assert.equal(res.text, SUCCESS_BODY);
    assert.equal(res.headers[ERROR_CATEGORY_HEADER.toLowerCase()], undefined);
  } finally {
    await serve.stop();
    await backend.close();
  }
});

test("proxy: an unreachable backend returns 502 with a category and a clear message, and does not switch backend", { timeout: 60000 }, async () => {
  const closed = await harness.startFakeBackend(() => {});
  const closedPort = closed.port;
  await closed.close();
  const serve = await harness.startServe({ env: { BACKEND_PORT: String(closedPort) }, label: "proxy-down" });
  try {
    const res = await post(serve.port);
    assert.equal(res.status, 502);
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Image backend is not reachable/);
    assert.equal(parsed.errorCategory, "unknown", "no captured error, so no cause is claimed");
    assert.equal(res.headers[ERROR_CATEGORY_HEADER.toLowerCase()], "unknown");
  } finally {
    await serve.stop();
  }
});

// ── Frontend text helpers (real module) ──────────────────────────────────────────

async function loadFailureModule() {
  return import(`${pathToFileURL(path.join(root, "app/frontend/src/services/generationFailure.js")).href}?gf-test`);
}

test("frontend: each category has its own title and action, and an unknown category falls back to unknown", async () => {
  const { describeGenerationFailure, GENERATION_FAILURE_CATEGORIES } = await loadFailureModule();
  const titles = new Set();
  for (const category of GENERATION_FAILURE_CATEGORIES) {
    const described = describeGenerationFailure({ category, message: "m", raw: "r" });
    assert.equal(described.category, category);
    assert.ok(described.title && described.action, `${category} has text`);
    titles.add(described.title);
  }
  assert.deepEqual(
    [...GENERATION_FAILURE_CATEGORIES].sort(),
    ["device", "missing-runtime", "model-context", "model-file", "out-of-memory", "timeout", "unknown", "unsupported-cpu"],
    "the category list is the eight known categories",
  );
  assert.equal(titles.size, GENERATION_FAILURE_CATEGORIES.length, "each category has a distinct title");
  assert.equal(describeGenerationFailure({ category: "made-up" }).category, "unknown");
  assert.equal(describeGenerationFailure({}).category, "unknown");
});

test("frontend: only out-of-memory shows the resolution hint", async () => {
  const { describeGenerationFailure } = await loadFailureModule();
  assert.equal(describeGenerationFailure({ category: "out-of-memory" }).showsSizeHint, true);
  assert.equal(describeGenerationFailure({ category: "device" }).showsSizeHint, false);
  assert.equal(describeGenerationFailure({ category: "unknown" }).showsSizeHint, false);
});

test("frontend: no category text claims a model incompatibility", async () => {
  const { describeGenerationFailure } = await loadFailureModule();
  for (const category of ["out-of-memory", "device", "missing-runtime", "model-file", "unsupported-cpu", "model-context", "unknown"]) {
    const text = `${describeGenerationFailure({ category }).title} ${describeGenerationFailure({ category }).action}`;
    assert.doesNotMatch(text, /incompatib|not compatible|does not support this model|unsupported model/i, `${category} must not claim incompatibility`);
  }
  const unknown = describeGenerationFailure({ category: "unknown" }).action;
  assert.match(unknown, /No cause is claimed/);
});

test("frontend: the raw diagnostic hides user folders and is bounded", async () => {
  const { sanitizeDiagnostic, describeGenerationFailure } = await loadFailureModule();
  const raw = "loading /home/alice/models/x.safetensors and C:\\Users\\Bob\\models\\y.safetensors";
  const clean = sanitizeDiagnostic(raw);
  assert.doesNotMatch(clean.text, /alice|Bob/);
  assert.match(clean.text, /\/home\/<user>\/models/);
  assert.match(clean.text, /C:\\Users\\<user>\\models/);
  const long = sanitizeDiagnostic("e".repeat(5000), 2000);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length < 2100);
  assert.equal(describeGenerationFailure({ category: "unknown", raw: "e".repeat(5000) }).rawTruncated, true);
});

// ── api.js generateImage error handling (real function, fake fetch) ──────────────

// Runs generateImage() with a fake fetch that returns `response`. Returns the thrown error and the
// number of requests made, so a retry would show up.
async function runGenerateWith(response) {
  const originalFetch = global.fetch;
  const originalWindow = global.window;
  const calls = [];
  global.window = { location: { protocol: "http:" } };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  try {
    const { generateImage } = await import(`${pathToFileURL(path.join(root, "app/frontend/src/services/api.js")).href}?gen-failure-test`);
    let thrown = null;
    try {
      await generateImage("a red cube", "", { width: 512, height: 512, steps: 4, cfgScale: 7, seed: 1, sampler: "euler_a" }, "model.safetensors", null);
    } catch (error) {
      thrown = error;
    }
    return { thrown, calls };
  } finally {
    global.fetch = originalFetch;
    global.window = originalWindow;
  }
}

function fakeResponse({ status, body, category = null }) {
  const headers = new Map();
  if (category) headers.set(ERROR_CATEGORY_HEADER.toLowerCase(), category);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

test("api: an out-of-memory response becomes a categorised failure with the sanitized body, and is not retried", async () => {
  const { thrown, calls } = await runGenerateWith(fakeResponse({ status: 500, body: OOM_BODY, category: "out-of-memory" }));
  assert.equal(calls.length, 1, "no retry and no other backend");
  assert.ok(thrown, "the error is thrown");
  assert.equal(thrown.generationFailure, true);
  assert.equal(thrown.category, "out-of-memory");
  assert.match(thrown.message, /out of memory/);
  assert.equal(thrown.raw, OOM_BODY);
});

test("api: a 502 with a string error keeps its message (the old code dropped it)", async () => {
  const body = JSON.stringify({ ok: false, error: "Image backend is not reachable: connect ECONNREFUSED", errorCategory: "unknown" });
  const { thrown } = await runGenerateWith(fakeResponse({ status: 502, body, category: "unknown" }));
  assert.match(thrown.message, /Image backend is not reachable/);
  assert.equal(thrown.category, "unknown");
});

test("api: with no category header, the failure is unknown and is not reported as a model problem", async () => {
  const { thrown } = await runGenerateWith(fakeResponse({ status: 400, body: JSON.stringify({ detail: "bad request" }) }));
  assert.equal(thrown.category, "unknown");
  assert.equal(thrown.message, "bad request");
});

// ── Source wiring (supplements the behaviour tests above) ───────────────────────

test("source: the proxy classifies only error responses, and sends the body unchanged", () => {
  const serve = read("scripts/server/serve.cjs");
  assert.match(serve, /if \(status < 400\) \{[\s\S]*?proxyRes\.pipe\(res\);/);
  assert.match(serve, /generationErrorCategory\(\{ body: buffer\.toString\("utf8"\)/);
  assert.match(serve, /res\.end\(buffer\);/);
});

test("source: the generator shows the category text and a sanitized diagnostic, and does not retry", () => {
  const generator = read("app/frontend/src/components/Generator.jsx");
  assert.match(generator, /describeGenerationFailure\(\{[\s\S]*?category: e\.category \|\| "unknown"/);
  assert.match(generator, /Diagnostic \(sanitized\)/);
  const api = read("app/frontend/src/services/api.js");
  assert.match(api, /throw createGenerationFailure\(\{/);
  assert.doesNotMatch(api.slice(api.indexOf("export async function generateImage"), api.indexOf("export async function importModelFile")), /retry|setTimeout\(\(\) => generateImage/i);
});

// ── Timeouts, OpenVINO failures, and signal exits (this iteration) ───────────────

const TIMEOUT_BODY = JSON.stringify({ error: { message: "OpenVINO NPU 512x512 compile timed out after 6 minutes." } });

test("proxy: a timed-out generation body is categorised as timeout, and the body is unchanged", { timeout: 60000 }, async () => {
  const { serve, backend } = await withProxy(500, TIMEOUT_BODY);
  try {
    const res = await post(serve.port);
    assert.equal(res.text, TIMEOUT_BODY);
    assert.equal(res.headers[ERROR_CATEGORY_HEADER.toLowerCase()], "timeout");
  } finally {
    await serve.stop();
    await backend.close();
  }
});

test("frontend: the timeout text says nothing was changed and no other device was tried, and does not claim a model problem", async () => {
  const { describeGenerationFailure } = await loadFailureModule();
  const described = describeGenerationFailure({ category: "timeout", message: "m", raw: "r" });
  assert.equal(described.title, "Generation timed out");
  assert.match(described.action, /Nothing was changed automatically/);
  assert.match(described.action, /no other device was tried/);
  assert.doesNotMatch(described.action, /model file|incompatib|driver/i);
});

test("frontend: the model-file title covers both a missing file and an unreadable one", async () => {
  const { describeGenerationFailure } = await loadFailureModule();
  const described = describeGenerationFailure({ category: "model-file" });
  assert.match(described.title, /missing or unreadable/);
  assert.match(described.action, /find or read the model file/);
});

async function runOpenVinoWith(response) {
  const originalFetch = global.fetch;
  const originalWindow = global.window;
  const calls = [];
  global.window = { location: { protocol: "http:" } };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  try {
    const { generateImage } = await import(`${pathToFileURL(path.join(root, "app/frontend/src/services/api.js")).href}?openvino-failure-test`);
    let thrown = null;
    let result = null;
    try {
      result = await generateImage("a red cube", "", { width: 512, height: 512, steps: 4, cfgScale: 7, seed: 1, sampler: "euler_a", backendType: "openvino-npu" }, "model.safetensors", null);
    } catch (error) {
      thrown = error;
    }
    return { thrown, result, calls };
  } finally {
    global.fetch = originalFetch;
    global.window = originalWindow;
  }
}

test("api: an OpenVINO failure response keeps its message and category, and is not retried", async () => {
  const body = JSON.stringify({ ok: false, error: "OpenVINO NPU 512x512 compile timed out after 6 minutes.", errorCategory: "timeout" });
  const { thrown, calls } = await runOpenVinoWith(fakeResponse({ status: 500, body }));
  assert.equal(calls.length, 1, "no retry");
  assert.equal(calls[0].url, "/api/openvino-generate");
  assert.ok(thrown && thrown.generationFailure, "a generation failure is thrown, not a generic error");
  assert.equal(thrown.category, "timeout");
  assert.match(thrown.message, /compile timed out/);
  assert.equal(thrown.raw, body);
});

test("api: an OpenVINO success still returns the image (regression for the changed response handling)", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]).toString("base64");
  const body = JSON.stringify({ ok: true, data: [{ b64_json: png, seed: 7 }], duration_sec: 2.5 });
  const { thrown, result } = await runOpenVinoWith(fakeResponse({ status: 200, body }));
  assert.equal(thrown, null);
  assert.match(result.image, /^data:image\/png;base64,/);
  assert.equal(result.seed, 7);
  assert.equal(result.duration_sec, 2.5);
});

test("serve: the OpenVINO generate route returns an error category with its message when no worker is ready", { timeout: 60000 }, async () => {
  const serve = await harness.startServe({ label: "openvino-route" });
  try {
    const payload = JSON.stringify({ prompt: "a red cube", width: 512, height: 512, steps: 4 });
    const res = await harness.request(serve.port, {
      method: "POST",
      urlPath: "/api/openvino-generate",
      body: payload,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    });
    assert.equal(res.status, 500);
    const data = JSON.parse(res.text);
    assert.equal(data.ok, false);
    assert.match(data.error, /OpenVINO NPU worker is not ready/);
    assert.equal(data.errorCategory, "unknown", "the message names no cause, so the category is unknown");
  } finally {
    await serve.stop();
  }
});

test("source: a backend stopped by a signal is recorded, unless the app stopped it on purpose", () => {
  // SOURCE CHECK. The exit path needs a real backend process, which these tests do not start. The
  // text it writes is tested as behaviour in failure-classification.test.cjs.
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /const expectedBackendExits = new WeakSet\(\);/);
  assert.match(server, /expectedBackendExits\.add\(proc\);\s*\n\s*try \{ proc\.kill\("SIGTERM"\)/, "unload marks the process as expected before it sends SIGTERM");
  assert.match(server, /else if \(code === null && signal && !expectedBackendExits\.has\(proc\) && !backendError\) \{\s*\n\s*\/\/[^\n]*\n\s*backendError = describeBackendSignalExit\(signal\);/);
});
