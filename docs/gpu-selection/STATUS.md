# GPU reliability: status

Branch: `arena/c7760438-portable-local-studio` (PR #1, open, not merged).
Target laptop: AMD Radeon 610M (integrated, drives the display) and NVIDIA GeForce RTX 5060 Laptop GPU
(discrete, compute, 8 GB).

**Summary.** Image generation on the RTX 5060 has been observed on the user's laptop, through the Vulkan
backend (`vulkan1`). The observations below were supplied by the user. Arena did not run them, and the
repository does not contain the logs or the evidence capture. The CUDA path has not been shown to work in the
tested installation.

## Labels

- **IMPLEMENTED**: the code or document exists in the repository.
- **TESTED — AUTOMATED**: an automated test in `scripts/tests/` runs the behaviour on the development machine
  (Linux, Node 22). Hardware, drivers, and backend binaries are faked unless stated. Source-text assertions are
  named as such when they are the only evidence.
- **TESTED — WINDOWS**: run on a real Windows machine. In this table, the Windows runs were carried out by the
  user, and the observations were supplied to Arena. Arena did not run them. The repository holds no logs or
  capture file for them.
- **USER-REPORTED**: reported by the user without the supporting output being available here.
- **PENDING**: not done, or waiting on a real Windows run.

## Windows acceptance evidence (supplied by the user; TESTED — WINDOWS)

### Hardware (direct observations, `nvidia-smi`)

- GPU: NVIDIA GeForce RTX 5060 Laptop GPU. Integrated GPU: AMD Radeon 610M, which drives the display.
- NVIDIA driver version `616.56`. Compute capability `12.0`.
- Total GPU memory about 8,151 MiB.
- During image generation, NVIDIA utilization rose from idle to a peak of 97%. Memory use reached about 7,565 MiB.

*Limit:* utilization and memory were measured during the run. The measurements show the GPU was busy and
memory was in use while generation ran. They do not, by themselves, prove that this GPU alone did the work.

### Application and API (application output)

- Generation completed with `juggernautXL_ragnarok.safetensors`.
- One screenshot shows a completed 512 × 512 image in 6.3 s. An earlier run took 24.0 s. The two timings are
  from different runs. It is not recorded whether model loading was included. They are not a benchmark.
- The application reported `Vulkan GPU` and `NVIDIA GeForce RTX 5060 Laptop GPU [vulkan1]`.
- `/api/generation-progress` after the run: `active: false`, `backendMode: "Vulkan GPU"`,
  `backendDevice: "NVIDIA GeForce RTX 5060 Laptop GPU [vulkan1]"`.
- `/api/backend-options`: Vulkan device index 1, `pinned: true`, `identityConfirmed: true`,
  `initConfirmed: true`.

*Limits:* `backendDevice` on `/api/generation-progress` is the current backend label. It is not a record of the
device used by a particular generation. The app does not store that per generation. `identityConfirmed` means
the backend's own log named the device. `initConfirmed` means the backend reached model loading on that device.
Neither flag alone shows that an image was generated on that device. Taken together with the telemetry above,
they make the result strong evidence, not a complete proof.

### Telemetry inconsistency (OPEN; to investigate separately)

- `/api/backend-options` returned `null` for `selection.vulkan.device.vramGb`. Other inventory data reports a
  VRAM value for the same card. `nvidia-smi` (about 8,151 MiB) is the strongest measurement here.
- Likely cause, from reading the code and not reproduced: the selected Vulkan device record is built from the
  probe result. `parseVulkanDeviceLog` and `parseVulkaninfoSummary` (`scripts/server/gpu-selection.cjs`) both set
  `vramGb` to `null`, so a device identified from the log has no VRAM. The inventory value is kept separately.
  This has not been tested.
- Not changed. Selection logic was not modified to make the displayed VRAM agree.

### Historical observations (not the current state)

- The first evidence capture reported missing backend executables. A later application launch exposed and ran
  `sd-vulkan.exe`. The earlier report is kept as history. The current runtime state is the one above.
- The earlier user report of a detection failure (CUDA shown unavailable and an iGPU chosen on the hybrid laptop)
  is kept as history. It was not re-verified on the hardware in this round.

## Status table

| Area | Status | Evidence / notes |
|---|---|---|
| Diagnosis of GPU detection and CUDA selection (`DIAGNOSIS.md`) | IMPLEMENTED | Root causes are marked `[source]` or `[unverified]`. |
| Four-layer discovery, availability, compatibility, selection (`DESIGN.md`) | IMPLEMENTED; TESTED — AUTOMATED | `scripts/tests/gpu-selection.test.cjs`, `scripts/tests/backend-probe.test.cjs`. Hardware is mocked. |
| RTX 5060 image generation through the Vulkan backend (`vulkan1`) | TESTED — WINDOWS (user-run; observations supplied to Arena) | See the section above. Limits: the telemetry inconsistency below, and no logs in the repository. |
| Backend identity: configured settings, backend-reported selection, last-generation device | IMPLEMENTED; TESTED — WINDOWS (partly, as above) | The app does not record a device per generation. `lastGenerationDevice` is reported as not recorded. |
| Telemetry: Vulkan selected-device `vramGb` is `null` | OPEN; investigate separately | Likely cause in `gpu-selection.cjs`; not reproduced. Selection not changed. |
| Probe classification (`classifyBackendProbe`) | IMPLEMENTED; TESTED — AUTOMATED | Realistic output strings. These are examples, not captures from the RTX 5060. |
| Compute capability does not decide compatibility | IMPLEMENTED; TESTED — AUTOMATED | `computeCap` is information only. A test with `computeCap` 12.0 and a rejecting probe shows the CUDA backend is not available (`gpu-probe-sequence.test.cjs`). |
| Server binds to loopback only | IMPLEMENTED; TESTED — AUTOMATED | Commit `c0cc716`; `scripts/tests/issue-regressions.test.cjs`. |
| SHA-256 verification of pinned setup downloads before extraction | IMPLEMENTED; TESTED — AUTOMATED | Commit `fb9fe3f`; `scripts/tests/setup-checksums.test.cjs`. Windows run of the setup: PENDING. |
| Node.js v22.23.3 Windows x64 ZIP pinned to SHA-256 `2b0ff57b…ed71` | IMPLEMENTED; TESTED — AUTOMATED (pin and ordering are checked in source) | Commit `e7fce73`. The digest was not computed by downloading the ZIP. Windows run: PENDING. |
| Node.js path-length guard (final destination too long) | IMPLEMENTED; TESTED — AUTOMATED (source-level only) | `scripts/tests/setup-node-runtime.test.cjs`. Windows run: PENDING. |
| Kokoro npm debug-log path regex (single-quoted) | IMPLEMENTED; TESTED — AUTOMATED | Commit `08ee3c2`; `scripts/tests/setup-tts-diagnostics.test.cjs`. Windows run: PENDING. |
| Node runtime staging and rollback | IMPLEMENTED; TESTED — AUTOMATED (ordering checked in source) | Commit `f4bbc77`. Windows run: PENDING. |
| Evidence capture (`scripts/capture-gpu-evidence.cjs`) | IMPLEMENTED; TESTED — AUTOMATED (Linux/macOS, fake nvidia-smi and fake backends); TESTED — WINDOWS: PENDING | `scripts/tests/gpu-evidence-capture.test.cjs`. Schema `gpu-evidence/2`. The backend version comes only from a stable-diffusion.cpp version banner (no banner means "not determined"). The loopback reads are optional and never fail the capture. `gpu-evidence/` is git-ignored. No capture from the target laptop is in the repository. |
| NVIDIA `driver_version` and `compute_cap` in discovery | IMPLEMENTED; TESTED — AUTOMATED (fake nvidia-smi output) | Query order and fallbacks as in `DESIGN.md`. Information only: selection does not use them. The RTX 5060 values (`616.56`, `12.0`) were reported by the user: TESTED — WINDOWS (user-run). |
| Backend-options refresh guard (409 while a runtime is active) | IMPLEMENTED; TESTED — AUTOMATED (real `serve.cjs` child process) | `scripts/tests/refresh-route.test.cjs`. A live 409 with a real image runtime on Windows: PENDING. |
| Safetensors header inspector and compatibility note | IMPLEMENTED; TESTED — AUTOMATED (real files) | `scripts/server/safetensors-header.cjs`. Header-only; no weights are read. The audit added: the Flux and SD3 markers accept the `model.diffusion_model.` prefix; the header reads are checked for short reads; the language-model wording no longer says "will not work". The only compatibility note is a high-confidence Flux-style diffusion file with no text encoder or VAE, for the launch mode that passes only `--model`. Warnings never block Generate. Whether the backend loads a given family: PENDING, not claimed. |
| Failure classification and UI text | IMPLEMENTED; TESTED — AUTOMATED (classifier; real proxy and real OpenVINO route against fake or unready backends; real `generateImage()` with a fake `fetch`) | `scripts/server/failure-classification.cjs`, `scripts/server/serve.cjs`, `app/frontend/src/services/generationFailure.js`, `app/frontend/src/services/api.js`. Categories: out-of-memory, device, missing-runtime, unsupported-cpu, model-file, model-context, **timeout** (new), unknown. Added this round: an OpenVINO generation failure now carries its category; a backend killed by a signal (for example SIGILL) is recorded as an error, except when the app stopped it; the app's own model-file messages are classified as model-file. No retry, no backend switch, no CPU fallback. Real backend wording on Windows: PENDING. |
| Video generation feasibility (research) | NEEDS MORE EVIDENCE; source-level facts verified; no video code | `docs/gpu-selection/VIDEO-FEASIBILITY.md`. The pinned Vulkan (`19bdfe2`) and CUDA/CPU (`b290693`) sources both contain the `vid_gen` route. The binaries were not run. Peak VRAM and time on the RTX 5060: PENDING. |
| Historical detection failure (CUDA shown unavailable; iGPU chosen) | USER-REPORTED (historical) | Kept as history. The exact message is not in the repository. |
| RTX 5060 capture, selection and generation on Windows (`WINDOWS_ACCEPTANCE.md`) | Image generation: TESTED — WINDOWS (user-run). Capture file, CUDA path, and video: PENDING | No `gpu-evidence/` report from the laptop is committed. |

## What is not verified

- Arena did not run any Windows test. The Windows observations above were supplied by the user.
- The telemetry inconsistency (Vulkan `vramGb` is `null`) has not been reproduced or fixed.
- The CUDA executable has not been shown to work in the tested installation.
- The failure categories are matched against text the app and the backends are known to produce, plus example
  messages written from those patterns. Real Windows messages are not captured for every category. The timeout,
  signal, and OpenVINO-category paths are tested with fake or unready backends, not with a real crash.
- The signal-exit recording in `serve.cjs` is checked by a source assertion. No test kills a real backend process.
- The Safetensors family labels are guesses from tensor names. The compatibility note is based on the launch mode.
- Source-text assertions show code was written in a particular form. They do not prove that a Windows script or the
  UI behaves correctly.
- `pwsh` is not available in the development sandbox, so the PowerShell scripts have not been executed.

## Known issues found and not changed (proposed separate changes)

- `getModelLoadIssue` (in `serve.cjs`) blocks `.gguf` loads by file name ("flux", "qwen", "wan", and so on). A file
  name is not evidence of architecture. This is a load gate, not a warning. It needs its own change and tests.
- The Safetensors compatibility note and the "partial file" warning are shown in the error colour of the Generator
  panel (`role="status"`). They do not block Generate, but the colour can read as an error. This is a styling change.
- The setup and TTS scripts were not modified in this round.

## Windows checks still needed

1. `node scripts/capture-gpu-evidence.cjs` on the laptop. Check `nvidiaSmi`, each probe's `attempts`, `backends[].version`
   (expect "not determined" unless a stable-diffusion.cpp banner is printed), and `localApi` (`configuredSettings`,
   `backendReportedSelection`, `lastGenerationDevice`).
2. Resolve the Vulkan `vramGb` `null` in `/api/backend-options`. Check the probe record and the inventory on the laptop.
3. Generation failures on purpose (for example a very large size) and the panel text. Check whether the category
   matches what the backend printed.
4. A real Flux-style `.safetensors` file, including a prefixed combined checkpoint: check the compatibility note and
   whether the backend generates from the file.
5. The CUDA path on the laptop, if it is to be used: does `sd-cuda.exe` initialize the RTX 5060?
6. The setup scripts (`scripts/setup/*.ps1`) on Windows. These are unchanged in this round.
7. Video: only after the isolated spike in `VIDEO-FEASIBILITY.md` passes, and only after the user approves the download.

## Manual steps

See `WINDOWS_ACCEPTANCE.md` for the GPU procedure. To capture evidence on the target laptop, run
`node scripts/capture-gpu-evidence.cjs` from the repository root. It writes `gpu-evidence/gpu-evidence-<time>.json`,
which is git-ignored.
