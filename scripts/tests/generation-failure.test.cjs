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
  const { describeGenerationFailure } = await loadFailureModule();
  const titles = new Set();
  for (const category of ["out-of-memory", "device", "missing-runtime", "model-file", "unsupported-cpu", "model-context", "unknown"]) {
    const described = describeGenerationFailure({ category, message: "m", raw: "r" });
    assert.equal(described.category, category);
    assert.ok(described.title && described.action, `${category} has text`);
    titles.add(described.title);
  }
  assert.equal(titles.size, 7, "each category has a distinct title");
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
