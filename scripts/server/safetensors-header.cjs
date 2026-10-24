// safetensors-header.cjs — reads only the header of a .safetensors file and reports what it can see.
//
// Format: 8 bytes little-endian unsigned length N, then N bytes of UTF-8 JSON, then tensor data.
// The JSON maps tensor names to { dtype, shape, data_offsets: [begin, end] } (offsets are relative
// to the end of the header). "__metadata__" is optional and is not a tensor.
//
// This module never reads tensor data, and it never loads a model. The family label is a guess
// from tensor-name prefixes. It is labelled "likely" and is not a compatibility guarantee: whether
// the image backend can load a file is decided only by the backend itself.
//
// Each report carries:
//   - evidence: the tensor-name facts the guess used, as short sentences;
//   - confidence: "high" (a family-specific marker, with the components that family needs),
//     "low" (a marker shared with other families, or only part of the evidence), or "none".
// A compatibility warning is given only where the header itself supports it, for one setting that
// the app really uses (the launch mode). Warnings never block Generate.

const fs = require("node:fs");
const path = require("node:path");

// The reference safetensors implementation rejects headers above 100 MB. Anything larger is not a
// safetensors header, so it is reported as invalid rather than read into memory.
const MAX_HEADER_BYTES = 100 * 1024 * 1024;
const LENGTH_FIELD_BYTES = 8;

const FAMILY_LABELS = {
  "sd1-sd2": "Stable Diffusion 1.x / 2.x (likely)",
  sdxl: "Stable Diffusion XL (likely)",
  sd3: "Stable Diffusion 3 (likely)",
  flux: "Flux (likely)",
  "diffusion-unknown": "Diffusion weights; family not recognised",
  "language-model": "Language model, not an image model",
  unknown: "Family not recognised",
};

// Tensor-name markers. `shared` markers are also used by other families, so they alone are weak.
const MARKERS = [
  { id: "sdxlSecondEncoder", pattern: /^conditioner\.embedders\.1\./, prefix: "conditioner.embedders.1.", meaning: "SDXL second text encoder" },
  // Some combined checkpoints store the transformer under "model.diffusion_model." (the prefix the
  // diffusion component check already accepts), so the family markers accept that prefix too.
  { id: "sd3Joint", pattern: /^(model\.diffusion_model\.)?joint_blocks\./, prefix: "joint_blocks.", meaning: "SD3-style joint transformer blocks" },
  { id: "fluxBlocks", pattern: /^(model\.diffusion_model\.)?(double|single)_blocks\./, prefix: "double_blocks. / single_blocks.", meaning: "Flux-style transformer blocks" },
  { id: "sd1TextModel", pattern: /^cond_stage_model\.transformer\.text_model\./, prefix: "cond_stage_model.transformer.text_model.", meaning: "SD 1.x / 2.x CLIP text encoder" },
  { id: "unetInputBlocks", pattern: /^model\.diffusion_model\.input_blocks\./, prefix: "model.diffusion_model.input_blocks.", meaning: "UNet input blocks, shared by SD 1.x, 2.x and SDXL" },
];

// Looks at tensor names only. Returns the family id, which components are present, the confidence,
// and the evidence used.
function detectSafetensorsFamily(names) {
  const list = Array.isArray(names) ? names : [];
  const has = (pattern) => list.some((name) => pattern.test(name));
  const components = {
    diffusion: has(/^model\.diffusion_model\.|^(double|single)_blocks\.|^joint_blocks\.|^transformer_blocks\.|^input_blocks\./),
    textEncoder: has(/^cond_stage_model\.|^conditioner\.embedders\.|^text_encoders\.|^text_model\./),
    vae: has(/^first_stage_model\.|^vae\.|^decoder\.up_blocks\.|^encoder\.down_blocks\./),
    languageModel: has(/^model\.layers\.\d+\./) && has(/embed_tokens/),
  };
  const found = Object.fromEntries(MARKERS.map((marker) => [marker.id, has(marker.pattern)]));

  const evidence = [];
  for (const marker of MARKERS) {
    if (found[marker.id]) evidence.push(`tensor names start with "${marker.prefix}" (${marker.meaning})`);
  }
  if (components.languageModel) evidence.push("model.layers.N and embed_tokens names found");
  evidence.push(components.diffusion ? "diffusion weight names found" : "no diffusion weight names found");
  evidence.push(components.textEncoder ? "text encoder names found" : "no text encoder names found");
  evidence.push(components.vae ? "VAE names found" : "no VAE names found");

  let family = "unknown";
  let confidence = "none";
  if (components.languageModel && !components.diffusion) {
    family = "language-model";
    confidence = "high";
  } else if (found.sdxlSecondEncoder && components.diffusion) {
    family = "sdxl";
    confidence = "high";
  } else if (found.sd3Joint) {
    family = "sd3";
    confidence = "low"; // joint blocks are not unique to one family, so this stays a likely guess
  } else if (found.fluxBlocks) {
    family = "flux";
    confidence = "high";
  } else if (found.sd1TextModel && found.unetInputBlocks) {
    family = "sd1-sd2";
    confidence = "high";
  } else if (components.diffusion) {
    // Input-block names alone also appear in SDXL refiners and other models, so no family is claimed.
    family = "diffusion-unknown";
    confidence = found.unetInputBlocks || found.sd1TextModel ? "low" : "none";
  }
  return { family, label: FAMILY_LABELS[family], components, confidence, evidence };
}

// Checks a parsed header object. Returns { ok: true, tensorNames, dtypes, maxDataEnd } or
// { ok: false, reason }.
function checkHeaderObject(header) {
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    return { ok: false, reason: "the header is not a JSON object" };
  }
  const tensorNames = [];
  const dtypes = new Set();
  let maxDataEnd = 0;
  for (const [name, entry] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    if (!entry || typeof entry !== "object" || typeof entry.dtype !== "string" || !Array.isArray(entry.shape)) {
      return { ok: false, reason: `tensor "${name}" has no dtype or shape` };
    }
    const offsets = entry.data_offsets;
    if (!Array.isArray(offsets) || offsets.length !== 2
      || !offsets.every((value) => Number.isSafeInteger(value) && value >= 0)
      || offsets[0] > offsets[1]) {
      return { ok: false, reason: `tensor "${name}" has invalid data_offsets` };
    }
    tensorNames.push(name);
    dtypes.add(entry.dtype);
    maxDataEnd = Math.max(maxDataEnd, offsets[1]);
  }
  return { ok: true, tensorNames, dtypes: [...dtypes].sort(), maxDataEnd };
}

// Reads the header of a file. Never reads past the header. Returns a plain report object.
function inspectSafetensorsFile(filePath) {
  const report = readSafetensorsHeader(filePath);
  if (!report.evidence) report.evidence = report.reason ? [report.reason] : [];
  return report;
}

function readSafetensorsHeader(filePath) {
  const base = { path: filePath, status: "invalid", reason: null, fileBytes: 0, expectedBytes: null, missingBytes: null, tensorCount: 0, dtypes: [], family: null, components: null, confidence: "none", evidence: null };
  let fd;
  try {
    const stats = fs.statSync(filePath);
    base.fileBytes = stats.size;
    if (stats.size < LENGTH_FIELD_BYTES) {
      return { ...base, reason: `the file is ${stats.size} bytes, smaller than the 8-byte header length field` };
    }
    fd = fs.openSync(filePath, "r");
    const lengthBuffer = Buffer.alloc(LENGTH_FIELD_BYTES);
    const lengthRead = fs.readSync(fd, lengthBuffer, 0, LENGTH_FIELD_BYTES, 0);
    if (lengthRead !== LENGTH_FIELD_BYTES) return { ...base, reason: "the file could not be read for its header length" };
    const headerLength = lengthBuffer.readBigUInt64LE(0);
    if (headerLength === 0n) return { ...base, reason: "the header length is zero" };
    if (headerLength > BigInt(MAX_HEADER_BYTES)) {
      return { ...base, reason: "the header length is larger than 100 MB, so this is not a safetensors header" };
    }
    const headerBytes = Number(headerLength);
    if (headerBytes > stats.size - LENGTH_FIELD_BYTES) {
      return {
        ...base,
        status: "incomplete",
        reason: "the file ends before its header does",
        expectedBytes: LENGTH_FIELD_BYTES + headerBytes,
        missingBytes: LENGTH_FIELD_BYTES + headerBytes - stats.size,
      };
    }
    const headerBuffer = Buffer.alloc(headerBytes);
    const headerRead = fs.readSync(fd, headerBuffer, 0, headerBytes, LENGTH_FIELD_BYTES);
    if (headerRead !== headerBytes) {
      return { ...base, reason: "the file changed while its header was being read" };
    }
    let parsed;
    try {
      parsed = JSON.parse(headerBuffer.toString("utf8"));
    } catch (error) {
      return { ...base, reason: `the header is not valid JSON (${error.message})` };
    }
    const check = checkHeaderObject(parsed);
    if (!check.ok) return { ...base, reason: check.reason };

    const expectedBytes = LENGTH_FIELD_BYTES + headerBytes + check.maxDataEnd;
    const family = detectSafetensorsFamily(check.tensorNames);
    const report = {
      ...base,
      tensorCount: check.tensorNames.length,
      dtypes: check.dtypes,
      family: family.family,
      familyLabel: family.label,
      components: family.components,
      confidence: family.confidence,
      evidence: [`${check.tensorNames.length} tensors, dtypes ${check.dtypes.join(", ") || "none"}`, ...family.evidence],
      expectedBytes,
    };
    if (stats.size < expectedBytes) {
      return {
        ...report,
        status: "incomplete",
        reason: "the file ends before the tensor data the header describes",
        missingBytes: expectedBytes - stats.size,
      };
    }
    return { ...report, status: "ok", reason: null };
  } catch (error) {
    return { ...base, reason: `the file could not be read (${error.code || error.message})` };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* already closed */ }
    }
  }
}

// Warnings for the UI. Only conditions the header can actually show are reported.
function warningsForReport(report) {
  const warnings = [];
  if (report.status === "invalid") {
    warnings.push(`This file is not a readable safetensors model: ${report.reason}. Delete it and download or import it again.`);
    return warnings;
  }
  if (report.status === "incomplete") {
    warnings.push(`This file looks incomplete: it is ${report.fileBytes.toLocaleString("en-US")} bytes, but its header describes ${report.expectedBytes.toLocaleString("en-US")} bytes. Delete it and download or import it again.`);
    return warnings;
  }
  if (report.family === "language-model") {
    warnings.push("This looks like a language model, not an image model, so image generation is not expected to work with it.");
  }
  if (report.components && report.components.diffusion && (!report.components.textEncoder || !report.components.vae)) {
    warnings.push("This file contains only some of the parts an image model needs (no text encoder or no VAE was found). It may need matching files to generate images.");
  }
  return warnings;
}

// Maps a request name to a safe path inside the models folder. Returns null for anything that is
// not a bare .safetensors filename, so a request cannot reach outside the folder.
function safeSafetensorsPath(modelsDir, requestedName) {
  const name = String(requestedName || "");
  if (!name || /[\\/]/.test(name) || name !== path.basename(name) || name.includes("\0")) return null;
  if (!/\.safetensors$/i.test(name)) return null;
  return path.join(modelsDir, name);
}

// Compatibility warnings against the app's own settings. Only conditions the header supports are
// reported. Each one is non-blocking and names the setting it is about.
//
// The only setting checked is the launch mode. The app launches every .safetensors file with
// --model and passes no separate text-encoder or VAE files (see serve.cjs, the launch arguments).
// A Flux-style diffusion file with no text encoder or no VAE therefore lacks files the app will not
// supply. Nothing else is checked, because no reliable evidence links a family to a sampler,
// resolution, or config restriction.
const LAUNCH_SETTING = "launch: --model (single-file)";

function compatibilityForReport(report) {
  if (!report || report.status !== "ok") return [];
  const components = report.components || {};
  const compatibility = [];
  if (report.family === "flux" && report.confidence === "high" && components.diffusion && (!components.textEncoder || !components.vae)) {
    const missing = [!components.textEncoder ? "text encoder" : null, !components.vae ? "VAE" : null].filter(Boolean).join(" and ");
    compatibility.push({
      setting: LAUNCH_SETTING,
      severity: "warning",
      message: `This is a Flux-style diffusion file with no ${missing} tensors. The app launches .safetensors files with --model and does not supply separate text-encoder or VAE files, so this file may not generate images on its own. This warning does not block Generate.`,
      evidence: report.evidence || [],
    });
  }
  return compatibility;
}

module.exports = {
  LAUNCH_SETTING,
  compatibilityForReport,
  MAX_HEADER_BYTES,
  FAMILY_LABELS,
  detectSafetensorsFamily,
  checkHeaderObject,
  inspectSafetensorsFile,
  warningsForReport,
  safeSafetensorsPath,
};
