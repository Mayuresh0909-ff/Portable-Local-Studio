# GPU detection and image-backend selection: diagnosis

Scope: GPU detection, backend selection, and their tests. No UI redesign, no video generation.
Baseline: `main` at `6c30594`. Source references below are to `scripts/server/serve.cjs` at that commit.

## Target hardware

- AMD Radeon 610M (integrated). Drives the display.
- NVIDIA GeForce RTX 5060 Laptop GPU (discrete). Used for compute and image generation.

The app must not treat the display GPU as the only usable GPU. It also must not treat "a GPU exists"
as proof that the installed backend can use it.

## Evidence status

Each finding is marked:

- **[source]**: confirmed by reading the code at HEAD.
- **[unverified]**: a plausible mechanism. It has not been reproduced on the target Windows machine.

The session record does not capture the user's exact failure message. The chain at the end of this
document is what the code does. It is not a reproduced log.

## Root causes

### 1. One "primary GPU" name was used as the NVIDIA signal [source]

`getGpuInfo()` (HEAD ~L761-806) chooses a single adapter from `Win32_VideoController`. Its keyword
list is `["nvidia", "amd", "arc", "geforce", "radeon", "rtx", "gtx"]`, and it takes the first
match. Both "amd" and "radeon" count as discrete keywords, so the Radeon 610M matches as readily as the
RTX 5060. Whichever adapter is listed first among the matches becomes the "primary" GPU. Listing order is not guaranteed, but when the iGPU comes first, it becomes the primary [unverified order on the target machine].

### 2. CUDA availability was inferred from the display adapter [source]

`hasNvidiaGpu()` (HEAD ~L3055) returns true only if the primary adapter name contains "nvidia".
Otherwise it runs `execSync("nvidia-smi", { stdio: "ignore" })`. Its only output is a boolean, and
any error becomes `false`. On the target hybrid machine, the primary name is the AMD iGPU, so the
result depends entirely on whether `nvidia-smi` runs successfully. A failure is silent: nothing is
logged, and the reason is discarded.

`getBackendOptions()` (HEAD ~L3203) then requires `cudaInstalled && hasNvidiaGpu() && backendAccepts(...)`.
A single failed step disables CUDA for the whole session. The CUDA probe is reached only if `nvidia-smi`
succeeds, so the display adapter's name effectively decides whether the NVIDIA GPU is tested.

### 3. Windows Vulkan never selected a device [source]

`getPreferredVulkanBackendName()` (HEAD ~L597-606) returns `"vulkan0"` before any probe when
`osPlatform !== "linux"`. On Windows, `vulkan0` is whatever index the Vulkan loader lists first. On a
hybrid machine that can be the iGPU. Nothing checks that the chosen device initializes.

### 4. Linux Vulkan mapped vulkaninfo indices onto ggml indices without verification [unverified]

On Linux, the code picks a `vulkaninfo --summary` GPU index, preferring discrete and then "amd" names.
It is not confirmed that vulkaninfo's index order matches the ggml/stable-diffusion Vulkan device
index. The mapping was not checked against the backend.

### 5. CUDA was always launched as `cuda0` without PCI ordering [source + unverified impact]

The image launch hard-codes `--backend cuda0` (HEAD ~L4601). Nothing sets `CUDA_DEVICE_ORDER`. With
more than one NVIDIA GPU, the CUDA index may not match the `nvidia-smi` index. Real impact not reproduced.

### 6. The device label came from the first device line in the log [source]

The launch log was parsed with `cleanOutput.match(/Device\s+\d+:\s*.../)` (HEAD ~L4760). That
returns the first device line, not the line for the device that was selected. The UI could therefore
show the wrong name.

### 7. Negative results were cached with no refresh path [source]

`cachedBackendOptions` (HEAD) was reset only after a backend download or install, an OpenVINO model delete,
or a process restart. There was no `refresh` option for `/api/backend-options`. A detection failure
at startup, such as a transient `nvidia-smi` timeout, persisted until restart.

## Probable user-visible chain (consistent with the code; not reproduced)

1. The Radeon 610M is listed first, so `getGpuInfo()` makes it the primary GPU. [source]
2. `hasNvidiaGpu()` takes the non-NVIDIA name path and depends on `nvidia-smi`. [source]
3. If `nvidia-smi` fails, CUDA is disabled, with no reason recorded. [source]
4. Vulkan launches as `vulkan0` without probing on Windows. [source]
5. If `vulkan0` is the iGPU, the image runs on the display GPU, or the device label is wrong, or the
   run falls back to CPU. [unverified which outcome occurs on the target machine]

## What was not changed

- Frontend classification (`Generator.jsx`) is unchanged. It still checks the device label for
  `cuda`, `vulkan`, or `rocm`, and the new label format keeps those substrings.
- Model weights, generated images, and backend binaries are not touched.
- No backend binary, model, or other large asset was downloaded. No network use was added.
- LocalForge was read as background only. No code was copied from it.

## Design response

See `docs/gpu-selection/DESIGN.md` for the layers, selection rules, and changed files.
