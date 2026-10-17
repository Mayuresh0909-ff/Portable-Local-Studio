# Windows manual acceptance: GPU selection

Run this on the target laptop (Radeon 610M drives the display, RTX 5060 Laptop GPU for compute).
The automated tests use mocked hardware. They cannot show that a real GPU renders an image, so
this procedure is required.

## Ground rules

- Do not download models, backends, or runtimes as part of this test. If a backend is missing, stop
  and report it. Do not install it during the test.
- Do not move, rename, overwrite, or delete model weights, backend binaries, or generated images.
  For CPU-fallback checks, choose CPU in the UI instead of hiding files.
- Do not uninstall or change GPU drivers or nvidia-smi.
- Record what you see. Mark each step PASS, FAIL, or NOT RUN, and paste the actual values.

## 0. Record the machine (before starting the app)

Open PowerShell and run:

```powershell
nvidia-smi --query-gpu=index,name,pci.bus_id,memory.total,display_active --format=csv
where.exe nvidia-smi
Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, VideoProcessor
```

Expected:

- `nvidia-smi` lists one device: `NVIDIA GeForce RTX 5060 Laptop GPU`, with `display_active` = `Disabled`.
- The `Win32_VideoController` output lists the Radeon 610M and the RTX 5060 in any order.

Write the results into the table at the end.

## 1. Start the app

1. Double-click `windows.bat` in the repository root.
2. Read the startup console. Find the two lines that start with `[gpu]`:
   - `[gpu] CUDA: using NVIDIA GeForce RTX 5060 Laptop GPU [cuda0]` (or another index), **or**
     `[gpu] CUDA: unavailable - <reason>`
   - `[gpu] Vulkan: using <name> [vulkan<N>]`, **or** `[gpu] Vulkan: unavailable - <reason>`
3. Note both lines. If a line says `unavailable`, the reason must be specific. A message like
   "no usable device" without a cause is a defect.

## 2. Check backend selection through the API

Open PowerShell and run (the app must be running):

```powershell
Invoke-RestMethod "http://localhost:1420/api/backend-options?refresh=1" | ConvertTo-Json -Depth 8
```

Check these fields:

| Field | Expected for this laptop |
|---|---|
| `selection.cuda.installed` | `true` if the CUDA backend is installed, otherwise `false` |
| `selection.cuda.available` | `true` if the CUDA backend initializes the RTX 5060 |
| `selection.cuda.device.name` | `NVIDIA GeForce RTX 5060 Laptop GPU` when `pinned` is `true`. When `pinned` is `false`, it is `null` unless the backend's output lists exactly one device |
| `selection.cuda.device.displayActive` | `false` (the NVIDIA GPU is not driving the display) |
| `selection.cuda.device.pinned` | `true`. If `false`, the backend chose the device itself, so the RTX 5060 is not confirmed as active |
| `selection.cuda.device.identityConfirmed` | `true` when the device is confirmed (pinned, or the only listed device). A `false` value means the device was not confirmed, and the run cannot prove the RTX 5060 was used |
| `selection.cuda.probes[].error` | Empty for a normal result. `timeout` or `start` means the probe never produced a verdict |
| `selection.vulkan.device.integrated` | `false` if Vulkan selects the RTX 5060; `true` only if no discrete device works |
| `selection.*.notes` | Explains any preference, rejection, or fallback |
| `selection.*.probes` | One entry per probed device, each with `accepted` and `reason` |

Pass: the selected device is the RTX 5060 whenever it initializes. The iGPU is not chosen over a
working discrete GPU. Every fallback has a reason in `notes` or `reason`.

Also test the refresh path. Stop the app, run `windows.bat` again, and confirm the first response is
the same as before without `?refresh=1`. This shows that the cache did not change the result.

## 3. Test the preference

1. Stop the app. In the same PowerShell window, set the variable and start the app from it:

   ```powershell
   $env:SD_CUDA_DEVICE = "0"
   .\windows.bat
   ```

2. Check that `selection.cuda.device.source` is `user-preference` and the index is `0`.
3. Set `$env:SD_CUDA_DEVICE = "7"` (not present). Restart. The note must say that `cuda7` is not an
   NVIDIA GPU on this system, and automatic selection must choose the RTX 5060.
4. Clear the variable (`Remove-Item Env:SD_CUDA_DEVICE`) and restart.

## 4. Successful image generation on the selected device

1. Open the app in a browser at `http://localhost:1420`.
2. In the image generator, select the GPU backend (CUDA if it is the selected backend, or Vulkan
   for the Vulkan run). Use the default settings with a short prompt, such as
   `a red ceramic teapot on a table`. Use a model that is already installed.
3. Start generation. Watch the loading text. For a pinned device it should read
   `Loading on <backend> • <name> [cuda0]` (or `[vulkan<N>]`). If the device was not pinned, it should
   read `Loading on <backend> • Automatic device selection (device not confirmed)`. Record which one you
   see. An unconfirmed label means the run does not prove which GPU rendered the image.
4. While it runs, open Task Manager → Performance. Check GPU usage by engine:
   - The RTX 5060 should show `Compute_0` or `3D` activity.
   - The Radeon 610M should not show a large rise caused by generation.
5. When the image finishes:
   - `GET http://localhost:1420/api/generation-progress` should show `backendDevice` containing
     `cuda0` (or `vulkan<N>`), and the name should be the RTX 5060.
   - A new image should appear in the app's outputs folder. Do not delete it.
6. Pass: the image completes, and the device label matches the RTX 5060 and the selected index.
   If the image completes but the label names the Radeon, record it as a FAIL.

Repeat step 4 once for each installed GPU backend (CUDA and Vulkan).

## 5. CPU fallback (no GPU)

1. In the UI, select CPU as the backend. Generate one small image.
2. Pass: generation completes, and the device label says CPU. No message claims GPU use.
3. Optional: in the backend-options response, a backend that is `available: false` should show a
   `reason`. That reason should be visible in the UI or in the startup log.

## 6. Optional: NVIDIA tooling missing

Only run this if it can be done safely. Do not remove the driver or edit system PATH permanently.

1. Start the app from a PowerShell session where `nvidia-smi` cannot be found, for example by
   running `windows.bat` from a shell that has a restricted PATH.
2. Pass: `selection.cuda.reason` names the missing NVIDIA tooling or the failed probe, not a generic
   message. Vulkan selection is unaffected by the CUDA result, and a usable Vulkan device is still selected.
3. Restart normally afterward and confirm step 2 again.

## Results table

| Step | Expected | Actual (paste values) | PASS / FAIL / NOT RUN |
|---|---|---|---|
| 0. nvidia-smi and display | RTX 5060 listed, display_active Disabled | | |
| 1. Startup `[gpu]` lines | CUDA and Vulkan both explain their result | | |
| 2. `selection.cuda.device.name` (pinned case) | RTX 5060 | | |
| 2. `selection.cuda.device.identityConfirmed` | `true` for the RTX 5060, or record that it was unpinned and unconfirmed | | |
| 2. `displayActive` | false | | |
| 2. `refresh=1` matches cached | same selection | | |
| 3. SD_CUDA_DEVICE=0 | pinned, source user-preference | | |
| 3. SD_CUDA_DEVICE=7 | note explains, auto choice | | |
| 4. CUDA image completes | image file produced | | |
| 4. Device label | `[cuda0]` with RTX 5060 name | | |
| 4. Task Manager | RTX 5060 compute rises | | |
| 4. Vulkan image completes (if installed) | image produced, discrete device label | | |
| 5. CPU fallback | completes, label says CPU | | |
| 6. NVIDIA tooling missing (optional) | clear reason, correct fallback | | |

## If something fails

Send these with the failing step number:

- The full JSON from `/api/backend-options?refresh=1`.
- The `[gpu]` lines from the startup console.
- The loading text and `/api/generation-progress` output from step 4.
- The `nvidia-smi` and `Win32_VideoController` output from step 0.
- The backend name and version, and whether it was installed by the user or by setup.

Do not paste model paths or personal files beyond these values.
