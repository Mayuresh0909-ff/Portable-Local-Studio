# GPU reliability: status

Branch: `arena/c7760438-portable-local-studio` (PR branch; not merged).
Target laptop: AMD Radeon 610M (integrated, drives the display) and NVIDIA GeForce RTX 5060 Laptop GPU
(discrete, compute, 8 GB).

**The repository still has no real capture from the RTX 5060.** No `gpu-evidence/` report from that
machine is committed or referenced. The RTX 5060 generation success below is what the user reported. It
was not observed or checked by any run in this repository.

## Labels

- **IMPLEMENTED**: the code or document exists in the repository.
- **TESTED — AUTOMATED**: an automated test in `scripts/tests/` runs the behaviour on the development
  machine (Linux, Node 22). Hardware, drivers and backend binaries are faked. Source-text assertions are
  named as such when they are the only evidence.
- **USER-REPORTED**: the user observed this on their own machine. The repository does not contain the logs.
  It is not independently verified.
- **TESTED — WINDOWS**: run on a real Windows machine. Nothing in this table has this label yet.
- **PENDING**: not done, or waiting on a real Windows run.

## Status table

| Area | Status | Evidence / notes |
|---|---|---|
| Diagnosis of GPU detection and CUDA selection (`DIAGNOSIS.md`) | IMPLEMENTED | Root causes are marked `[source]` or `[unverified]`. |
| Four-layer discovery, availability, compatibility, selection (`DESIGN.md`) | IMPLEMENTED; TESTED — AUTOMATED | `scripts/tests/gpu-selection.test.cjs`, `scripts/tests/backend-probe.test.cjs`. Hardware is mocked. |
| Probe classification (`classifyBackendProbe`) | IMPLEMENTED; TESTED — AUTOMATED | Realistic output strings. These are examples, not captures from the RTX 5060. |
| Compute capability does not decide compatibility | IMPLEMENTED; TESTED — AUTOMATED | `computeCap` is information only. A test with `computeCap` 12.0 and a rejecting probe shows the CUDA backend is not available (`gpu-probe-sequence.test.cjs`). |
| Server binds to loopback only | IMPLEMENTED; TESTED — AUTOMATED | Commit `c0cc716`; `scripts/tests/issue-regressions.test.cjs`. |
| SHA-256 verification of pinned setup downloads before extraction | IMPLEMENTED; TESTED — AUTOMATED | Commit `fb9fe3f`; `scripts/tests/setup-checksums.test.cjs`. Windows run: PENDING. |
| Node.js v22.23.3 Windows x64 ZIP pinned to SHA-256 `2b0ff57b…ed71` | IMPLEMENTED; TESTED — AUTOMATED (pin and ordering are checked in source) | Commit `e7fce73`. The digest was not computed by downloading the ZIP. It is the official value supplied for this task. Windows run: PENDING. |
| Node.js path-length guard (final destination too long) | IMPLEMENTED; TESTED — AUTOMATED (source-level only) | `scripts/tests/setup-node-runtime.test.cjs`. Windows run: PENDING. |
| Kokoro npm debug-log path regex (single-quoted) | IMPLEMENTED; TESTED — AUTOMATED | Commit `08ee3c2`; `scripts/tests/setup-tts-diagnostics.test.cjs`. Windows run: PENDING. |
| Node runtime staging and rollback | IMPLEMENTED; TESTED — AUTOMATED (ordering checked in source) | Commit `f4bbc77`. Windows run: PENDING. |
| Evidence capture (`scripts/capture-gpu-evidence.cjs`) | IMPLEMENTED; TESTED — AUTOMATED (Linux/macOS, fake nvidia-smi and fake backends); TESTED — WINDOWS: PENDING | `scripts/tests/gpu-evidence-capture.test.cjs`. Report schema `gpu-evidence/2`. Each nvidia-smi query and each probe attempt is kept with its stdout, stderr, exit code, timeout or spawn error. The primary and fallback attempts are both kept. Output is bounded and marked when cut. Absolute user paths are redacted. The backend version comes only from a version line in the probe output (never from a file name, and `--version` is not run). The loopback read of `/api/backend-status` is optional, has a 1.5 s timeout, and never fails the capture. `gpu-evidence/` is git-ignored. The RTX 5060 capture on Windows: PENDING. |
| NVIDIA `driver_version` and `compute_cap` in discovery | IMPLEMENTED; TESTED — AUTOMATED (fake nvidia-smi output) | Query order: both fields, then `driver_version` alone, then the existing fields, then the oldest form without `display_active`. A driver that rejects `compute_cap` still reports its driver version. Explicit nulls are kept. Information only: selection does not use them. Not shown in the UI. Real RTX 5060 values: PENDING. |
| Backend-options refresh guard (409 while a runtime is active) | IMPLEMENTED; TESTED — AUTOMATED (real `serve.cjs` child process) | `scripts/tests/refresh-route.test.cjs`. Idle: refresh succeeds and runs discovery. Active runtime: `GET /api/backend-options?refresh=1` and `/api/hardware-specs?refresh=1` return 409 and start no probe, and the cached discovery is kept. The runtime state comes from the test seam `UAIS_TEST_RUNTIME_FLAGS`, which is unset in normal use. A live backend 409 on Windows: TESTED — WINDOWS: PENDING. |
| Safetensors header inspector and UI note | IMPLEMENTED; TESTED — AUTOMATED (real files); frontend build passes in this workspace | `scripts/server/safetensors-header.cjs`. `GET /api/models/inspect?file=` reads only the header. Each report gives `evidence` (the tensor-name facts used) and `confidence` (`high`, `low`, or `none`). Family labels stay “likely” or “not recognised”. A compatibility note is given in one case only: a high-confidence Flux-style diffusion file with no text encoder or VAE, because the app launches `.safetensors` files with `--model` and supplies no separate encoder or VAE files. No sampler, resolution, or config rule is inferred from a family label. Warnings never block Generate. Not run: a real model file on Windows, and whether the backend loads each family. |
| Failure classification and UI text | IMPLEMENTED; TESTED — AUTOMATED (classifier; the real image proxy against a fake backend; the real `generateImage()` with a fake `fetch`) | `scripts/server/failure-classification.cjs`, `scripts/server/serve.cjs` (proxy), `app/frontend/src/services/generationFailure.js`, `app/frontend/src/components/Generator.jsx`. A failed generation response carries `X-Studio-Error-Category`. The body is passed through unchanged. The panel shows a title and one action for out-of-memory, GPU or driver error, missing runtime file, unreadable model file, CPU feature not supported, and unknown. A sanitized raw diagnostic is in a collapsible section. A generic error is never reported as a model-compatibility problem. No retry, no backend switch, no CPU fallback. Categories come from the backend's own text, so real messages on Windows: PENDING. Automatic CPU fallback on device failure: NOT IMPLEMENTED (it changes what generation does). |
| Video generation feasibility (research only) | IMPLEMENTED as a research document; no code; PENDING the Windows spike | `docs/gpu-selection/VIDEO-FEASIBILITY.md`. Upstream stable-diffusion.cpp supports Wan 2.1/2.2 video through `vid_gen`. Whether the bundled binaries expose it is NOT verified. |
| Historical detection failure: CUDA shown unavailable and an iGPU chosen on the hybrid laptop | USER-REPORTED (historical; not re-verified on hardware) | The earlier report, kept as history. The exact message is not in the repository. The discovery and selection work above was written in response; it has not been run on the laptop. |
| RTX 5060 image generation after switching to a compatible model | USER-REPORTED | The user reports successful image generation on the RTX 5060 after switching to a compatible model. The model name and logs are not in the repository. It is not verified by any capture or test here. |
| RTX 5060 capture, selection and generation on Windows | PENDING | No capture exists in the repository. Follow `WINDOWS_ACCEPTANCE.md`, section 7 (evidence capture) and the steps after it. |

## What is not verified

- No test in this repository has run on the RTX 5060 or on Windows.
- The NVIDIA query fallback, the backend version line, and the failure texts are checked against fake
  output. The real drivers and backend binaries may print other text.
- The refresh-guard route tests use a test seam (`UAIS_TEST_RUNTIME_FLAGS`) for the runtime state. They do
  not start a real backend.
- The failure-category text is written from the classifier's patterns. The real backend messages on
  Windows are not captured.
- The Safetensors compatibility note is based on the app's launch mode. Whether the backend loads a given
  file is decided only by the backend.
- Source-text assertions show that code was written in a particular form. They do not prove that the
  Windows script or the UI behaves correctly.
- `pwsh` is not available in the development sandbox, so PowerShell scripts have not been executed.

## Windows checks still needed

1. `node scripts/capture-gpu-evidence.cjs` on the laptop. Check `nvidiaSmi.devices` (driver version, compute
   capability, bus ID), `nvidiaSmi.attempts`, each probe's `attempts`, `backends[].version`, and `localApi`.
2. The refresh 409 with a real image runtime running (`WINDOWS_ACCEPTANCE.md`).
3. A generation failure on purpose (for example a very large size) and the panel text. Check whether the
   category matches what the backend printed.
4. A real Flux-style `.safetensors` file in the models folder: check the compatibility note, and whether
   the backend generates from the file.
5. The setup scripts (`scripts/setup/*.ps1`) on Windows. These are unchanged in this iteration.
6. Video: only after the separate CLI spike in `VIDEO-FEASIBILITY.md` passes.

## Manual steps

See `WINDOWS_ACCEPTANCE.md` for the GPU procedure. To capture evidence on the target laptop, run
`node scripts/capture-gpu-evidence.cjs` from the repository root. It writes `gpu-evidence/gpu-evidence-<time>.json`,
which is git-ignored. The RTX 5060 capture is PENDING until the user runs it on Windows.
