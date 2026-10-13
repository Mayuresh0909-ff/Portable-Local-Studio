# GPU selection design

Companion to `DIAGNOSIS.md`. This describes the fix as implemented in:

- `scripts/server/gpu-selection.cjs` (new): pure logic. No process, filesystem, or network access.
- `scripts/server/serve.cjs` (modified): discovery, probes, launch arguments, log parsing, and routes.
- `scripts/tests/gpu-selection.test.cjs` (new): regression tests.

## Four separate layers

Each layer answers one question. The code keeps them apart so one layer's answer cannot quietly decide another's.

| Layer | Question | Where |
|---|---|---|
| 1. Physical discovery | Which GPUs exist, and what are they? | `parseWindowsVideoControllers`, `parseNvidiaSmiCsv`, `parseVulkaninfoSummary`, `getGpuDiscovery` (serve.cjs) |
| 2. Backend availability | Is the backend installed, and does its runtime load? | `selectCudaBackend` / `selectVulkanBackend` (`installed`, `runtimeReason`) |
| 3. Device compatibility | Does the backend initialize this specific device? | `probeBackendDevice` per index, via `probe(index)` injected into the selectors |
| 4. Selected inference device | Which device will the launch use, and why? | `selection.device`, `notes`, `summarizeBackendSelection` |

Display attachment is recorded on each device (`displayAttached` / `displayActive`) and shown in the
selection summary. It is never a reason to reject a device.

## Selection rules

For CUDA and Vulkan, candidate devices are ordered as follows:

1. A valid explicit preference goes first: `SD_CUDA_DEVICE` for CUDA, and `SD_VULKAN_DEVICE` (or the
   older `UAIS_VULKAN_DEVICE` alias, kept from HEAD) for Vulkan. Accepted forms are `1`, `vulkan1`, and `cuda1`. Its probe still has to succeed. If it fails or is missing, the note says so and automatic
   selection runs.
2. Discrete devices before integrated devices.
3. Larger VRAM first, when VRAM is known.
4. Lower index last, as a deterministic tie-break.

Virtual and software devices (llvmpipe, Microsoft Basic Render, and similar) are never selected.

Probes run in the order of the candidates. The first device that passes is used. A device that fails
is recorded with its reason, and the next candidate is tried.

## Preserved behavior

- The existing `backendAccepts()` boolean is kept for the rocm path and other callers.
- The device label keeps the `[cuda0]` / `[vulkan1]` substrings, so `Generator.jsx`
  (`isConfirmedGpuBackend`) keeps working unchanged.
- The `cuda`, `vulkan`, and `rocm` launch branches still work when no device is pinned.
- Negative discovery results are retried after a short TTL (`GPU_NEGATIVE_CACHE_TTL_MS`, 5 min).
  `GET /api/backend-options?refresh=1` forces re-detection.

## Changes that matter for review

- `getGpuInfo()` no longer decides NVIDIA presence from the display adapter's name.
  NVIDIA presence comes from discovery (adapter list and nvidia-smi status).
- `hasNvidiaGpu()` is removed.
- On Windows, Vulkan no longer defaults to `vulkan0` without a probe.
- `CUDA_DEVICE_ORDER=PCI_BUS_ID` is set for CUDA probes and launches, so CUDA indices match
  nvidia-smi's PCI order.
- The device name in the UI comes from the log line for the selected index, not the first device line.
- Launch uses the selected device (`--backend cudaN` / `vulkanN`). It no longer hard-codes `cuda0`.

## Probe acceptance is a heuristic

A probe starts the backend with a model path that does not exist. It accepts the device when:

- the output contains `loading model`, or
- the banner is present and no device-failure marker appears
  (`failed to init`, `no usable vulkan devices`, and similar).

This shows that the backend initialized the device before the missing model stopped it. It does not
prove that a generation completes on that device. Only a real generation on Windows can show that
(see `WINDOWS_ACCEPTANCE.md`).

If a binary does not accept `--backend`, the probe retries without device flags. The device is then
not pinned, and the selection notes say so.

## Files and sizes

| File | Status | Notes |
|---|---|---|
| `scripts/server/gpu-selection.cjs` | new, 643 lines | pure logic |
| `scripts/server/serve.cjs` | modified, +405 / -168 | discovery, probes, launch, routes |
| `scripts/tests/gpu-selection.test.cjs` | new, 642 lines | 40 tests |
| `docs/gpu-selection/DIAGNOSIS.md` | new | root cause |
| `docs/gpu-selection/DESIGN.md` | new | this file |
| `docs/gpu-selection/WINDOWS_ACCEPTANCE.md` | new | manual test |

No model weights, generated images, backend binaries, or config files are created, moved, or deleted
by this change.
