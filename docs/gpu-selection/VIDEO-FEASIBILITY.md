# Video generation: feasibility (research only)

Status: **PENDING**. This is a research note. No code, no UI, and no model download was added.
Image generation is not changed by this document.

## Question

Could this app add local video generation on the target laptop (AMD Radeon 610M for display,
NVIDIA GeForce RTX 5060 Laptop GPU for compute), using the backends it already bundles?

## Short answer

Plausible for a small text-to-video model at low resolution. It is not ready to build yet. Three things
must be verified on the Windows machine first:

1. Whether the bundled stable-diffusion.cpp binaries can run video at all.
2. How much VRAM the RTX 5060 Laptop GPU actually has, as reported by `nvidia-smi`.
3. Whether a short clip completes in an acceptable time on that GPU.

## What the upstream project supports

- stable-diffusion.cpp lists Wan2.1 and Wan2.2 (text-to-video, image-to-video, VACE), LTX-2.3,
  HunyuanVideo 1.5 and others as supported models [1][2].
- Video is run in a separate mode. The upstream example uses `sd-cli.exe -M vid_gen` with
  `--video-frames`, `--diffusion-fa`, `--offload-to-cpu` and `--flow-shift` [3].
- A Wan 2.1 text-to-video run needs several files: the diffusion model, a Wan VAE, and a UMT5-XXL text
  encoder. Image-to-video also needs a CLIP vision file [3]. A standard VAE is VRAM-intensive, and a
  tiny autoencoder (TAE) is available as a lighter alternative [4].

## Hardware evidence (mixed quality)

| Claim | Source type | Confidence |
|---|---|---|
| Wan 2.1 T2V-1.3B needs 8.19 GB VRAM. It makes a 5 s 480p clip on an RTX 4090 in about 4 minutes, without quantisation. | Upstream model card [5] | Official, but measured on an RTX 4090, not on an 8 GB laptop GPU |
| The 1.3B model runs in about 4–6 GB with GGUF quantisation at 480p. | Third-party guides [6][7] | Community estimates; unverified here |
| Wan 2.1 14B at 480p needs about 40–48 GB in FP8 on a datacentre GPU. | Hosting vendor blog [8] | Vendor estimate; not applicable to an 8 GB laptop |

The RTX 5060 Laptop GPU's VRAM depends on the laptop configuration. Read `memory.total` from
`nvidia-smi` (or the evidence capture) on the target machine. Do not assume a figure.

## Fit with this repository

- **Pinned backends.** The CUDA and CPU Windows builds are `master-782-b290693` (`setup.ps1` lines 212–213,
  and the release is dated 16 July 2026 [9]). The Vulkan build is `master-685-19bdfe2` (`setup.ps1`
  line 215). The Vulkan build's date was not checked.
- **Unverified.** Whether `vid_gen` exists in these builds was not checked. The app runs `sd-cuda.exe`
  and `sd-vulkan.exe` with an HTTP image API. Whether those binaries expose video through that API
  was not checked either. Check locally with `sd-cli.exe --help` and the server's documentation. Do not
  assume the answer.
- **Image API.** Generation is proxied to the backend's image endpoint and expects an image back
  (`serve.cjs`, `proxyImageBackendRequest`; `api.js`, `generateImage`). Video needs its own endpoint or
  a subprocess mode, a frame or MP4 output format, storage under `app/outputs`, and a player in the UI.
- **Model records.** The app downloads and lists one file per model (`ModelManager`, `/api/models`).
  Wan needs three or four coordinated files. Supporting it needs multi-file model records, or a
  separate "video model" profile that points at each file.
- **Errors.** The current error text for diffusion-only SDXL GGUF files already says that matching VAE
  and text-encoder files are needed (`describeBackendError`). The same problem would apply to video.
- **GPU selection.** The device probes in `gpu-selection.cjs` are for image generation. A video run
  would need its own probe, timeout, and memory checks. The 5 s probe timeout is not a video timeout.

## Options

| Option | What it changes | Risk | Recommendation |
|---|---|---|---|
| A. Keep video out of scope | Nothing | None | Default until the Windows spike succeeds |
| B. Separate spike: run `sd-cli vid_gen` as a child process, outside the image API | A script and output folder, no change to image generation | Low. Isolated, and easy to remove | Do this first, after GPU validation |
| C. Add video to the server's HTTP API and UI | Routes, model profiles, output format, UI | High. Touches the generation path | Only after B shows it works |

## Proposed Windows spike (for the user to run; not run here)

1. Confirm `sd-cli.exe --help` lists `vid_gen`. If it does not, stop. Option B is off the table with
   this build.
2. Download the Wan 2.1 T2V-1.3B files only if you approve the download size. Do not put them in
   `app/models` until the spike has a plan for them.
3. Run one clip of 5 frames at 480×480 (or lower). Use the RTX 5060 device through the same CUDA
   path the image backend uses.
4. While it runs, record `nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv -l 1`.
5. Pass: a clip completes, the output file opens, and peak VRAM fits in the GPU's `memory.total` with
   room to spare. Record the time. Fail: any error. Record the exact line.

Nothing in this spike shows that a video is correct, or that the app can present it. It shows only
whether the backend can run video on this machine.

## Known unknowns

- The Vulkan build's support for Wan (the CUDA build is the more likely path on the RTX 5060).
- Whether the bundled `sd-server` binary exposes video at all.
- Real generation time on the RTX 5060 Laptop GPU.
- How the Radeon 610M affects video memory and display use during a run.

## Sources

[1] https://github.com/leejet/stable-diffusion.cpp (feature list: Wan2.1/2.2, LTX-2.3, HunyuanVideo 1.5)
[2] https://deepwiki.com/leejet/stable-diffusion.cpp/5.6-video-generation (T2V, I2V, VACE; VAE and TAE requirements)
[3] https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/wan.md (`-M vid_gen` examples and required files)
[4] https://deepwiki.com/leejet/stable-diffusion.cpp/6.1.6-wan-video-models (VAE versus TAE)
[5] https://github.com/Wan-Video/Wan2.1 (8.19 GB VRAM for the 1.3B model; about 4 minutes for a 5 s 480p clip on an RTX 4090)
[6] https://willitrunai.com/blog/wan-2-2-vram-requirements (GGUF estimates; community)
[7] https://runaihome.com/blog/wan-video-local-ai-gpu-guide-2026/ (8 GB tier guidance; community)
[8] https://www.spheron.network/blog/deploy-wan-2-1-ai-video-generation-gpu-setup/ (datacentre VRAM figures; vendor)
[9] https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-782-b290693 (release date and commit)
Repository: `scripts/setup/setup.ps1` lines 211–215 (pinned backend builds); `scripts/server/serve.cjs` (`proxyImageBackendRequest`, `describeBackendError`).
