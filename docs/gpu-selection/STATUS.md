# GPU reliability: status

Branch: `arena/c7760438-portable-local-studio` (PR branch; not merged).
Target laptop: AMD Radeon 610M (integrated, drives the display) and NVIDIA GeForce RTX 5060 Laptop GPU
(discrete, compute). The RTX 5060 has not been exercised by any run in this repository yet.

## Labels

- **IMPLEMENTED**: the code or document exists in the repository.
- **TESTED — AUTOMATED**: an automated test in `scripts/tests/` runs the behaviour, or a Node check runs
  against the code. Source-text assertions are labelled separately below when they are the only evidence.
- **TESTED — WINDOWS**: run on a real Windows machine. Nothing in this table has this label yet.
- **USER-REPORTED**: the user observed this on their machine. The repository does not contain the logs.
- **PENDING**: not done, or waiting on real hardware or a user run.

## Status table

| Area | Status | Evidence / notes |
|---|---|---|
| Diagnosis of GPU detection and CUDA selection (`DIAGNOSIS.md`) | IMPLEMENTED | Root causes are marked `[source]` or `[unverified]`. |
| Four-layer discovery, availability, compatibility, selection (`DESIGN.md`) | IMPLEMENTED; TESTED — AUTOMATED | `scripts/tests/gpu-selection.test.cjs`, `scripts/tests/backend-probe.test.cjs`. Hardware is mocked. |
| Probe classification (`classifyBackendProbe`) | IMPLEMENTED; TESTED — AUTOMATED | Realistic output strings. These are examples, not captures from the RTX 5060. |
| Server binds to loopback only | IMPLEMENTED; TESTED — AUTOMATED | Commit `c0cc716`; `scripts/tests/issue-regressions.test.cjs`. |
| SHA-256 verification of pinned setup downloads before extraction | IMPLEMENTED; TESTED — AUTOMATED | Commit `fb9fe3f`; `scripts/tests/setup-checksums.test.cjs`. Windows run: PENDING. |
| Node.js v22.23.3 Windows x64 ZIP pinned to SHA-256 `2b0ff57b…ed71` | IMPLEMENTED; TESTED — AUTOMATED (pin and ordering are checked in source) | Commit `e7fce73`. The digest was not computed by downloading the ZIP. It is the official value supplied for this task. Windows run: PENDING. |
| Node.js path-length guard (final destination too long) | IMPLEMENTED; TESTED — AUTOMATED (source-level only) | `scripts/tests/setup-node-runtime.test.cjs`. Windows run: PENDING. |
| Kokoro npm debug-log path regex (single-quoted) | IMPLEMENTED; TESTED — AUTOMATED | Commit `08ee3c2`; `scripts/tests/setup-tts-diagnostics.test.cjs`. Windows run: PENDING. |
| Node runtime staging and rollback | IMPLEMENTED; TESTED — AUTOMATED (ordering checked in source) | Commit `f4bbc77`. Windows run: PENDING. |
| User report: CUDA shown unavailable and an iGPU chosen on the hybrid laptop | USER-REPORTED | The exact message is not in the repository. |
| Evidence capture script (`scripts/capture-gpu-evidence.cjs`) | IMPLEMENTED; TESTED — AUTOMATED (Linux/macOS, fake backends) | `scripts/tests/gpu-evidence-capture.test.cjs`, `scripts/tests/gpu-probe-sequence.test.cjs`. Shares probe args, the 5 s timeout, the fallback sequence and the nvidia-smi query with the server (`gpu-selection.cjs`, `gpu-probe-runner.cjs`, `backend-paths.cjs`). The Windows run on the RTX 5060 is PENDING. |
| NVIDIA `compute_cap` and `driver_version` in discovery | IMPLEMENTED; TESTED — AUTOMATED (fake nvidia-smi output) | Read as optional trailing columns in `parseNvidiaSmiCsv`; the first query requests them and falls back on older drivers. Information only: selection does not use them. Not shown in the UI. Real RTX 5060 values: PENDING (run the evidence capture). |
| Backend-options refresh guard (409 while a runtime is active) | PENDING (Stage D) | |
| Safetensors header detector and UI warning | PENDING (Stage E) | |
| Failure classification for backend errors | PENDING (Stage F) | Automatic CPU fallback is a separate, pending item. |
| Video generation feasibility (research only) | PENDING (Stage G) | `docs/gpu-selection/VIDEO-FEASIBILITY.md` |
| RTX 5060 selection and generation on Windows | PENDING | Follow `WINDOWS_ACCEPTANCE.md`. No run has happened. |

## What is not verified

- No test in this repository has run on the RTX 5060 or on Windows.
- Source-text assertions show that code was written in a particular form. They do not prove that
  the Windows script or the UI behaves correctly.
- `pwsh` is not available in the development sandbox, so PowerShell scripts have not been executed.

## Manual steps

See `WINDOWS_ACCEPTANCE.md` for the GPU procedure. To capture evidence on the target laptop, run
`node scripts/capture-gpu-evidence.cjs` from the repository root. It writes `gpu-evidence/gpu-evidence-<time>.json`,
which is git-ignored. The RTX 5060 capture is PENDING until the user runs it on Windows.
