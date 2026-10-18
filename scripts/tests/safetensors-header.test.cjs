// Behaviour tests for the Safetensors header inspector (Stage E).
//
// EXECUTED: each test writes real .safetensors files (length prefix, JSON header, data bytes) to a
// temporary folder and runs inspectSafetensorsFile() on them. No model is downloaded or loaded.
// The family labels are guesses from tensor names. These tests check the guess rules, not whether
// any backend can load the files.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const st = require(path.join(root, "scripts", "server", "safetensors-header.cjs"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safetensors-header-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

// Builds a safetensors file. `tensors` maps names to byte sizes; each tensor's data is laid out
// back to back, and the header records the offsets. `headerOverride` replaces the JSON text.
function writeSafetensors(name, tensors, options = {}) {
  let offset = 0;
  const header = { __metadata__: { format: "pt" } };
  for (const [tensorName, size] of Object.entries(tensors)) {
    header[tensorName] = { dtype: "F16", shape: [size / 2], data_offsets: [offset, offset + size] };
    offset += size;
  }
  const headerText = options.headerText !== undefined ? options.headerText : JSON.stringify(header);
  const headerBuffer = Buffer.from(headerText, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(options.headerLength !== undefined ? options.headerLength : headerBuffer.length));
  const dataBytes = options.dataBytes !== undefined ? options.dataBytes : offset;
  const data = Buffer.alloc(dataBytes, 1);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([length, headerBuffer, data]));
  return file;
}

const SD15_KEYS = {
  "cond_stage_model.transformer.text_model.embeddings.token_embedding.weight": 64,
  "model.diffusion_model.input_blocks.0.0.weight": 64,
  "first_stage_model.decoder.conv_in.weight": 64,
};

test("a complete SD 1.x-style file is reported ok, with its components and a likely family", () => {
  const file = writeSafetensors("sd15.safetensors", SD15_KEYS);
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.status, "ok");
  assert.equal(report.reason, null);
  assert.equal(report.tensorCount, 3, "__metadata__ is not counted as a tensor");
  assert.equal(report.family, "sd1-sd2");
  assert.match(report.familyLabel, /likely/);
  assert.deepEqual(report.components, { diffusion: true, textEncoder: true, vae: true, languageModel: false });
  assert.equal(report.expectedBytes, report.fileBytes);
  assert.deepEqual(st.warningsForReport(report), []);
});

test("SDXL is told apart from SD 1.x by its second conditioner", () => {
  const file = writeSafetensors("sdxl.safetensors", {
    "conditioner.embedders.0.transformer.text_model.x": 32,
    "conditioner.embedders.1.model.text_projection": 32,
    "model.diffusion_model.input_blocks.0.0.weight": 32,
    "first_stage_model.decoder.conv_in.weight": 32,
  });
  assert.equal(st.inspectSafetensorsFile(file).family, "sdxl");
});

test("a Flux-style file with no text encoder or VAE is ok, but the warning says it may need more files", () => {
  const file = writeSafetensors("flux-only.safetensors", {
    "double_blocks.0.img_attn.qkv.weight": 64,
    "single_blocks.0.linear1.weight": 64,
  });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.status, "ok");
  assert.equal(report.family, "flux");
  assert.equal(report.components.textEncoder, false);
  const warnings = st.warningsForReport(report);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /may need matching files/);
});

test("a language model is named as one, and the warning says image generation will not work", () => {
  const file = writeSafetensors("llm.safetensors", {
    "model.embed_tokens.weight": 64,
    "model.layers.0.self_attn.q_proj.weight": 64,
  });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.family, "language-model");
  assert.match(st.warningsForReport(report).join("\n"), /not an image model/);
});

test("a file that ends before its tensor data is reported incomplete, with the missing byte count", () => {
  const file = writeSafetensors("truncated.safetensors", { "model.diffusion_model.a": 100 }, { dataBytes: 60 });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.status, "incomplete");
  assert.equal(report.missingBytes, 40);
  assert.match(st.warningsForReport(report)[0], /looks incomplete/);
});

test("a header length that runs past the end of the file is reported incomplete, not read", () => {
  const file = writeSafetensors("short-header.safetensors", SD15_KEYS, { headerLength: 999999 });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.status, "incomplete");
  assert.match(report.reason, /ends before its header/);
});

test("an implausibly large header length is invalid, and nothing is read into memory", () => {
  const file = path.join(dir, "huge-length.safetensors");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(2n ** 40n);
  fs.writeFileSync(file, Buffer.concat([length, Buffer.from("{}")]));
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.status, "invalid");
  assert.match(report.reason, /larger than 100 MB/);
});

test("a header that is not JSON is invalid", () => {
  const file = writeSafetensors("bad-json.safetensors", {}, { headerText: "{not json" });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.status, "invalid");
  assert.match(report.reason, /not valid JSON/);
});

test("a tensor with reversed data_offsets is invalid", () => {
  const file = writeSafetensors("reversed.safetensors", {}, {
    headerText: JSON.stringify({ t: { dtype: "F16", shape: [1], data_offsets: [10, 2] } }),
  });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.status, "invalid");
  assert.match(report.reason, /invalid data_offsets/);
});

test("a JSON header that is not an object (an array) is invalid", () => {
  const file = writeSafetensors("array.safetensors", {}, { headerText: "[1,2,3]" });
  assert.equal(st.inspectSafetensorsFile(file).status, "invalid");
});

test("a file smaller than the length field is invalid, and a missing file is invalid without throwing", () => {
  const tiny = path.join(dir, "tiny.safetensors");
  fs.writeFileSync(tiny, Buffer.from([1, 2, 3]));
  assert.equal(st.inspectSafetensorsFile(tiny).status, "invalid");
  const missing = st.inspectSafetensorsFile(path.join(dir, "does-not-exist.safetensors"));
  assert.equal(missing.status, "invalid");
  assert.match(missing.reason, /could not be read/);
});

test("extra bytes after the tensor data are not treated as an error", () => {
  const file = writeSafetensors("extra.safetensors", SD15_KEYS, { dataBytes: 3 * 64 + 16 });
  assert.equal(st.inspectSafetensorsFile(file).status, "ok");
});

test("the family detector does not claim a family when no known prefix matches", () => {
  assert.equal(st.detectSafetensorsFamily(["something.weight"]).family, "unknown");
  assert.equal(st.detectSafetensorsFamily([]).family, "unknown");
});

test("a request can only name a .safetensors file directly inside the models folder", () => {
  const models = path.join(root, "app", "models");
  assert.equal(st.safeSafetensorsPath(models, "model.safetensors"), path.join(models, "model.safetensors"));
  for (const bad of ["../secret.safetensors", "sub/model.safetensors", "sub\\model.safetensors", "model.gguf", "", "x\0.safetensors"]) {
    assert.equal(st.safeSafetensorsPath(models, bad), null, JSON.stringify(bad));
  }
});

// ── HTTP endpoint (real server process) ─────────────────────────────────────────
// EXECUTED: starts scripts/server/serve.cjs on a spare port and sends real requests. Only names
// that must be refused, or a file that does not exist, are requested. No file is written to app/models.

const { spawn } = require("node:child_process");
const http = require("node:http");

function httpGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: requestPath, timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject).on("timeout", function onTimeout() { this.destroy(new Error("timeout")); });
  });
}

async function waitForServer(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await httpGet(port, "/api/models/inspect?file=none.safetensors");
      return true;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

test("the inspect endpoint refuses names outside the models folder and reports a missing file", { timeout: 90000 }, async () => {
  const port = 15000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [path.join(root, "scripts", "server", "serve.cjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    assert.equal(await waitForServer(port, 30000), true, "server did not start");
    for (const bad of ["..%2Fsecret.safetensors", "sub%2Fmodel.safetensors", "model.gguf"]) {
      const response = await httpGet(port, `/api/models/inspect?file=${bad}`);
      assert.equal(response.status, 400, bad);
      assert.equal(JSON.parse(response.body).ok, false);
    }
    const missing = await httpGet(port, "/api/models/inspect?file=does-not-exist-anywhere.safetensors");
    assert.equal(missing.status, 404);
    const noName = await httpGet(port, "/api/models/inspect");
    assert.equal(noName.status, 400);
  } finally {
    child.kill("SIGTERM");
  }
});

// ── UI wiring (source-text; supplements the endpoint test, does not replace it) ─

test("the generator checks the selected model's header and shows warnings without blocking the button", () => {
  const api = fs.readFileSync(path.join(root, "app", "frontend", "src", "services", "api.js"), "utf8");
  const generator = fs.readFileSync(path.join(root, "app", "frontend", "src", "components", "Generator.jsx"), "utf8");
  assert.match(api, /export async function inspectModelFile\(filename\)/);
  assert.match(api, /\/api\/models\/inspect\?file=/);
  assert.match(generator, /inspectModelFile,?\s*\n?\} from "\.\.\/services\/api"|  inspectModelFile\n\} from/);
  assert.match(generator, /setModelWarnings\(report && Array\.isArray\(report\.warnings\)/);
  // The Generate button's disabled condition must not depend on the warnings.
  const button = generator.slice(generator.indexOf("{/* Generate Trigger Button */}"));
  assert.match(button, /disabled=\{isGenerating \|\| !prompt\.trim\(\) \|\| !activeModel\}/);
  assert.doesNotMatch(button.slice(0, 400), /modelWarnings/);
});

// ── Evidence, confidence, and compatibility (Task 3) ─────────────────────────────

test("high confidence: an SDXL file names the marker it used, and gets no compatibility warning", () => {
  const file = writeSafetensors("sdxl-complete.safetensors", {
    "conditioner.embedders.0.transformer.text_model.x": 32,
    "conditioner.embedders.1.model.text_projection": 32,
    "model.diffusion_model.input_blocks.0.0.weight": 32,
    "first_stage_model.decoder.conv_in.weight": 32,
  });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.family, "sdxl");
  assert.equal(report.confidence, "high");
  assert.ok(report.evidence.some((line) => /conditioner\.embedders\.1\./.test(line)), "the evidence names the SDXL marker");
  assert.ok(report.evidence.some((line) => /^\d+ tensors, dtypes F16/.test(line)), "the evidence gives the tensor count and dtypes");
  assert.deepEqual(st.compatibilityForReport(report), []);
});

test("high confidence: an SD 1.x file needs both its text model and its UNet blocks", () => {
  const report = st.inspectSafetensorsFile(writeSafetensors("sd15-high.safetensors", SD15_KEYS));
  assert.equal(report.family, "sd1-sd2");
  assert.equal(report.confidence, "high");
  assert.ok(report.evidence.some((line) => /cond_stage_model\.transformer\.text_model\./.test(line)));
});

test("low confidence: UNet block names alone make no family claim, so the label is not 'likely'", () => {
  const file = writeSafetensors("unet-only.safetensors", {
    "model.diffusion_model.input_blocks.0.0.weight": 64,
    "model.diffusion_model.middle_block.0.weight": 64,
  });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.family, "diffusion-unknown");
  assert.equal(report.confidence, "low");
  assert.equal(report.familyLabel, st.FAMILY_LABELS["diffusion-unknown"]);
  assert.doesNotMatch(report.familyLabel, /likely/, "no family is claimed");
  assert.deepEqual(st.compatibilityForReport(report), []);
});

test("low confidence: an SD3-style joint block is named 'likely' with low confidence, and gets no warning", () => {
  const file = writeSafetensors("sd3-like.safetensors", {
    "joint_blocks.0.x.weight": 64,
    "model.diffusion_model.joint_blocks.1.y.weight": 64,
  });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.family, "sd3");
  assert.equal(report.confidence, "low");
  assert.match(report.familyLabel, /likely/);
  assert.deepEqual(st.compatibilityForReport(report), [], "no reliable evidence links SD3 to a launch restriction");
});

test("unknown family: no recognised names gives family unknown, confidence none, and no warnings of any kind", () => {
  const file = writeSafetensors("unknown.safetensors", { "custom.weight": 64, "custom.bias": 64 });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.family, "unknown");
  assert.equal(report.confidence, "none");
  assert.ok(report.evidence.includes("no diffusion weight names found"));
  assert.deepEqual(st.warningsForReport(report), []);
  assert.deepEqual(st.compatibilityForReport(report), []);
});

test("unsupported setting: a Flux-style file with no text encoder or VAE gets one non-blocking compatibility warning for the launch mode", () => {
  const file = writeSafetensors("flux-compat.safetensors", {
    "double_blocks.0.img_attn.qkv.weight": 64,
    "single_blocks.0.linear1.weight": 64,
  });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.status, "ok", "the file itself is readable, so nothing blocks");
  assert.equal(report.confidence, "high");
  const compatibility = st.compatibilityForReport(report);
  assert.equal(compatibility.length, 1);
  assert.equal(compatibility[0].setting, st.LAUNCH_SETTING);
  assert.equal(compatibility[0].severity, "warning");
  assert.match(compatibility[0].message, /--model/);
  assert.match(compatibility[0].message, /does not block Generate/);
  assert.match(compatibility[0].message, /text encoder and VAE/);
  assert.ok(compatibility[0].evidence.some((line) => /double_blocks/.test(line)), "the warning carries its evidence");
  assert.match(st.warningsForReport(report).join("\n"), /may need matching files/, "the existing general warning is kept");
});

test("no warning: a Flux-style file that includes its text encoder and VAE is compatible with the launch", () => {
  const file = writeSafetensors("flux-all-in-one.safetensors", {
    "double_blocks.0.img_attn.qkv.weight": 64,
    "single_blocks.0.linear1.weight": 64,
    "text_encoders.t5xxl.encoder.weight": 64,
    "vae.decoder.conv_in.weight": 64,
  });
  const report = st.inspectSafetensorsFile(file);
  assert.equal(report.family, "flux");
  assert.equal(report.components.textEncoder, true);
  assert.equal(report.components.vae, true);
  assert.deepEqual(st.compatibilityForReport(report), []);
  assert.deepEqual(st.warningsForReport(report), []);
});

test("no warning: a complete SD 1.x file and a language model get no compatibility warning", () => {
  assert.deepEqual(st.compatibilityForReport(st.inspectSafetensorsFile(writeSafetensors("sd15-compat.safetensors", SD15_KEYS))), []);
  const llm = st.inspectSafetensorsFile(writeSafetensors("llm-compat.safetensors", {
    "model.embed_tokens.weight": 64,
    "model.layers.0.self_attn.q_proj.weight": 64,
  }));
  assert.deepEqual(st.compatibilityForReport(llm), []);
});

test("no compatibility warning for a file that is invalid or incomplete, and the evidence says why", () => {
  const incomplete = st.inspectSafetensorsFile(writeSafetensors("flux-short.safetensors", {
    "double_blocks.0.img_attn.qkv.weight": 64,
  }, { dataBytes: 10 }));
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(st.compatibilityForReport(incomplete), []);
  assert.ok(incomplete.evidence.length >= 1);

  const invalid = st.inspectSafetensorsFile(path.join(dir, "does-not-exist.safetensors"));
  assert.equal(invalid.status, "invalid");
  assert.deepEqual(invalid.evidence, [invalid.reason], "an invalid file's evidence is the reason it was rejected");
  assert.deepEqual(st.compatibilityForReport(invalid), []);
});

const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("source: the inspect route returns compatibility, and the generator shows it without disabling Generate", () => {
  const serve = read("scripts/server/serve.cjs");
  assert.match(serve, /compatibility: compatibilityForReport\(report\)/);
  const generator = read("app/frontend/src/components/Generator.jsx");
  assert.match(generator, /setModelCompatibility\(report && Array\.isArray\(report\.compatibility\)/);
  assert.match(generator, /role="note"[\s\S]*?Compatibility check \(does not block Generate\)/);
  // Generate stays enabled. Only prompt and model state disable it, as before.
  assert.match(generator, /disabled=\{isGenerating \|\| !prompt\.trim\(\) \|\| !activeModel\}/);
});
