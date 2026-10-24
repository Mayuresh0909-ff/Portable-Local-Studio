# Video generation: feasibility (research only)

Status: **NEEDS MORE EVIDENCE.** This is a research note. No video code, UI, model download, or backend
download was added. Image generation is not changed by this document. Last updated 2026-10-24.

## Recommendation

**NEEDS MORE EVIDENCE.** Not GO: nothing has run video on the target GPU, and the 8 GB fit is not shown.
Not NO-GO: the pinned backends contain the video code (source-level, below), and the memory question is
measurable with one isolated run.

**What would change the decision**

- **To GO:** one clip completes on the RTX 5060 Laptop GPU with the Vulkan backend the app already uses, and
  peak `memory.used` from `nvidia-smi` stays at or below the image baseline the user already saw succeed
  (about 7,565 MiB out of 8,151 MiB). Time per clip must be acceptable to the user. Also settle the output
  format (below) before any integration.
- **To NO-GO:** the run fails with out-of-memory at 256×256, 5 frames, with the offload options on. Or the
  smallest set of files cannot fit within the card's limit, even with the text encoder quantised and offloaded.
- **Output format decision:** a browser-playable file needs either a WebM-enabled build or a converter
  (ffmpeg, a new dependency). Without one of these, no integration should start.

## Verified in this round (and how)

| Fact | How it was checked | Label |
|---|---|---|
| The pinned Vulkan release `master-685-19bdfe2` targets commit `19bdfe22d255d5b4dff39d449318b9bc5ea2317f`, published 2026-06-08. | GitHub API release metadata | TESTED — AUTOMATED (metadata only) |
| The pinned CUDA and CPU release `master-782-b290693` targets commit `b2906939774dc73453467215c80390404d0a2701`, published 2026-07-16. | GitHub API release metadata | TESTED — AUTOMATED (metadata only) |
| At `19bdfe2`, the CLI accepts `--mode vid_gen` (help text: `[img_gen, vid_gen, upscale, convert, metadata]`). | Source at that commit | Source-verified; the binary was not run |
| At `19bdfe2`, the server exposes `POST /sdcpp/v1/vid_gen`, job polling at `GET /sdcpp/v1/jobs/{id}`, cancel at `POST …/cancel`, and `GET /sdcpp/v1/capabilities`. The image-compatibility routes (`/sdapi/v1/txt2img`) are image-only. | Source at that commit | Source-verified; the binary was not run |
| The same route family is present at `b290693` (CUDA and CPU builds). | Source at that commit | Source-verified |
| The vid_gen request takes `width`, `height`, `seed`, `steps`, `video_frames`, `fps`, and `output_format`. The default `output_format` is `webm`. | Source, `routes_sdcpp.cpp` | Source-verified |
| WebM is offered only when the build defines `SD_USE_WEBM`. AVI is always listed. A request for `webm` on a build without it is rejected. | Source, `runtime.cpp` and `routes_sdcpp.cpp` | Source-verified. The server build's own WebM setting was not confirmed. |
| Upstream Wan documentation at `19bdfe2` lists the files for Wan 2.1 T2V 1.3B: the diffusion model, `wan_2.1_vae.safetensors`, and a UMT5-XXL text encoder (`--t5xxl`). The Wan VAE is noted as needing a lot of VRAM. | Upstream `docs/wan.md` | Source-verified |
| The server README documents `--diffusion-model`, `--vae`, `--t5xxl`, `--offload-to-cpu`, `--diffusion-fa`, `--vae-tiling`, `--video-frames`, and `--flow-shift`. | Upstream `examples/server/README.md` | Source-verified |
| Setup extracts only `sd-server.exe` from each zip, renamed to `sd-cuda.exe` or `sd-vulkan.exe`. The CLI (`sd-cli.exe`) is not installed by setup. Whether the zip also contains `sd-cli.exe` was not checked, because the zip was not downloaded. | `scripts/setup/setup.ps1` (lines 522, 685, 740) | Source-verified. The zip contents: UNVERIFIED. |

## File requirements and sizes (Wan 2.1 T2V 1.3B)

Sizes come from the Hugging Face file listings of the Comfy-Org repackaged Wan files. Nothing was downloaded.

| File | Role | Size (listing) |
|---|---|---|
| `wan2.1_t2v_1.3B_fp16.safetensors` | Diffusion model (`--diffusion-model`) | 2.84 GB |
| `wan_2.1_vae.safetensors` | VAE (`--vae`) | 254 MB |
| `umt5_xxl_fp16.safetensors` | Text encoder (`--t5xxl`), fp16 | 11.4 GB |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | Text encoder (`--t5xxl`), fp8 | 6.74 GB |

Total on disk: about **9.8 GB** with the fp8 text encoder, or about **14.5 GB** with fp16. Upstream also uses a
Q8_0 GGUF text encoder in its example. Its size was not checked, so it is not counted here.

Image-to-video also needs a CLIP vision file. This note covers text-to-video only.

## Memory: what is measured and what is not

| Figure | Source | Label |
|---|---|---|
| The image run on the RTX 5060 peaked at about 7,565 MiB of 8,151 MiB (SDXL, `juggernautXL_ragnarok.safetensors`). | User-supplied Windows observation | USER-REPORTED (TESTED — WINDOWS as reported) |
| Wan 2.1 T2V-1.3B "requires only 8.19 GB VRAM". A 5 s 480p clip takes about 4 minutes on an RTX 4090. | Wan2.1 README (`Wan-Video/Wan2.1`) | Upstream, but for the PyTorch reference implementation, not stable-diffusion.cpp. The 4090 is not an 8 GB card. Not applicable as a measurement for this app. |
| Peak VRAM of the stable-diffusion.cpp Wan run on the RTX 5060 | Not measured | PENDING |
| Time per clip on the RTX 5060 | Not measured | PENDING |

Two points follow from the table. First, the 8.19 GB figure is close to this card's 8,151 MiB total. The README
does not say whether it includes the text encoder, and it comes from a different implementation, so it cannot be
read as a fit for sd.cpp. Second, the SDXL run
used 7,565 MiB of 8,151 MiB, so there is little margin for a second large model on this card. Expect offload,
a quantised text encoder, and VAE tiling to be necessary. That is an expectation, not a measurement.

## Fit with this repository

- **Image API is not reused.** Video uses the asynchronous `/sdcpp/v1/vid_gen` route and job polling. It is not
  the `/sdapi/v1/txt2img` route the app proxies (`serve.cjs`, `proxyImageBackendRequest`). Integration needs a
  separate job client, not a mode switch.
- **Output.** The request default is `webm`, which a build without `SD_USE_WEBM` rejects. AVI is always supported,
  so a client must ask for `avi` explicitly unless WebM is confirmed. Browsers do not reliably play AVI, so the
  player path depends on the output decision above.
- **Model records.** The app lists one file per model (`ModelManager`, `/api/models`). Wan needs three files
  from separate folders, so a multi-file "video model" profile would be needed.
- **Errors.** `describeBackendError` already says that diffusion-only GGUF files need matching VAE and text-encoder
  files. The same wording would apply to Wan.
- **GPU selection.** The probes in `gpu-selection.cjs` cover image generation only. A video run needs its own
  probe, timeout, and memory check. The current 5 s probe timeout is not a video timeout.

## Proposed isolated spike (not run; needs user approval for the download)

The spike uses the server binary the install already has. It runs outside `app/backend`, `app/models`, and the app's
config. No PLS code changes.

1. Confirm the binary has the route: `GET /sdcpp/v1/capabilities` on the spike server must list `vid_gen`.
   If it does not, stop.
2. Download only the 1.3B fp16 diffusion model, the Wan 2.1 VAE, and the fp8 text encoder, into a separate
   folder, after the user approves the size (about 9.8 GB).
3. Start the existing Vulkan server (`sd-vulkan.exe`) on a spare port with `--diffusion-model`, `--vae`, `--t5xxl`,
   `--offload-to-cpu`, and `--vae-tiling`. Do not start the app's backend at the same time.
4. Submit one `vid_gen` job: 256×256, 5 frames, `output_format: "avi"`. Poll the job. Note the status and error text.
5. While it runs, record `nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv -l 1`.
6. Pass: the job completes, the AVI opens in a standard player, and peak `memory.used` is at or below 7,565 MiB.
   Record the time. Fail: any error. Record the exact line and the peak.

The spike shows only whether this backend can run video on this machine. It does not show that the video is
correct, that the output can be played in the app, or that the app's memory handling is safe.

## Known unknowns

- Whether the release zips contain `sd-cli.exe`, and whether the server build has WebM.
- Whether the Vulkan build performs as the CUDA build does for video. The RTX 5060 image run used Vulkan.
- Whether `umt5_xxl` loads and offloads correctly with `--offload-to-cpu` on this card.
- Real peak VRAM and time on the RTX 5060 Laptop GPU.
- How the Radeon 610M affects video memory and display use during a run.
- Laptop system RAM: the fp16 text encoder is 11.4 GB.

## Sources

Upstream sources are at the pinned commits, not the moving `master` branch.

[1] `docs/wan.md` at `19bdfe22d255d5b4dff39d449318b9bc5ea2317f`: https://github.com/leejet/stable-diffusion.cpp/blob/19bdfe22d255d5b4dff39d449318b9bc5ea2317f/docs/wan.md (file list, `-M vid_gen` examples, VAE VRAM note)
[2] `examples/cli/main.cpp` at `19bdfe22…`: https://github.com/leejet/stable-diffusion.cpp/blob/19bdfe22d255d5b4dff39d449318b9bc5ea2317f/examples/cli/main.cpp (`--mode vid_gen`)
[3] `examples/server/routes_sdcpp.cpp` at `19bdfe22…`: https://github.com/leejet/stable-diffusion.cpp/blob/19bdfe22d255d5b4dff39d449318b9bc5ea2317f/examples/server/routes_sdcpp.cpp (`/sdcpp/v1/vid_gen`, jobs, capabilities)
[4] `examples/server/runtime.cpp` at `19bdfe22…`: https://github.com/leejet/stable-diffusion.cpp/blob/19bdfe22d255d5b4dff39d449318b9bc5ea2317f/examples/server/runtime.cpp (output formats, `SD_USE_WEBM`)
[5] `examples/server/README.md` at `19bdfe22…`: https://github.com/leejet/stable-diffusion.cpp/blob/19bdfe22d255d5b4dff39d449318b9bc5ea2317f/examples/server/README.md (server flags)
[6] Release `master-685-19bdfe2` (API metadata, published 2026-06-08): https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-685-19bdfe2
[7] Release `master-782-b290693` (API metadata, published 2026-07-16): https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-782-b290693
[8] Wan2.1 README (8.19 GB; RTX 4090 timing; PyTorch reference): https://github.com/Wan-Video/Wan2.1
[9] Hugging Face file listings, Comfy-Org repackaged Wan 2.1 (sizes): https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/main/split_files (diffusion_models, vae, text_encoders)
[10] Secondary sources cited in the earlier version of this note (community guides and vendor blogs, including the 40–48 GB datacentre figure) are not used for any decision here.

Repository references: `scripts/setup/setup.ps1` (pins at lines 212–215; extraction of `sd-server.exe` at lines 522, 685, and 740).
