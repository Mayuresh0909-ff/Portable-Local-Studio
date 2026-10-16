# Setup download pins (SHA-256)

Windows setup verifies the SHA-256 of the release archives listed below **before** extracting or running them.
On mismatch the file is deleted and setup stops with a `SHA-256 mismatch` error. Optional GPU archives (CUDA, CUDA runtime DLLs) fall back to the next backend instead of stopping setup.

## Pinned archives

| Script | Upstream release | Asset | SHA-256 |
| --- | --- | --- | --- |
| `setup.ps1` | leejet/stable-diffusion.cpp `master-782-b290693` | `sd-master-b290693-bin-win-cpu-x64.zip` | `38da3539…94ea0` |
| `setup.ps1` | leejet/stable-diffusion.cpp `master-782-b290693` | `sd-master-b290693-bin-win-cuda12-x64.zip` | `bc7aa2f6…8a02` |
| `setup.ps1` | leejet/stable-diffusion.cpp `master-782-b290693` | `cudart-sd-bin-win-cu12-x64.zip` | `fe203668…320f38d` |
| `setup.ps1` | leejet/stable-diffusion.cpp `master-685-19bdfe2` | `sd-master-19bdfe2-bin-win-vulkan-x64.zip` | `7a0c0a9c…14be` |
| `setup-llama.ps1` | ggml-org/llama.cpp `b9668` | `llama-b9668-bin-win-vulkan-x64.zip`, `…-cpu-x64.zip`, `…-cuda-12.4-x64.zip`, `…-sycl-x64.zip`, `cudart-llama-bin-win-cuda-12.4-x64.zip` | see `$llamaSha256ByAsset` |
| `setup-whisper.ps1` | ggml-org/whisper.cpp `v1.9.1` | `whisper-bin-x64.zip` | `7d8be46e…539` |

Full digests are in the script source next to each URL or version. They are the `sha256:` values from the GitHub release-asset metadata (`https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>`).

### What this does and does not prove

- The digests come from the upstream repositories' own release metadata, which GitHub computes when an asset is uploaded. They are not maintainer-signed checksums, and they were **not** re-computed by downloading the files in this change (the archives are large and downloads were not approved).
- Updating a version means updating the URL, the version string, and the digest together. A tag without a pin fails closed (llama and whisper refuse to download; `setup.ps1` throws on a missing pin).
- Not yet executed on Windows: the verification path has been checked by source-text tests only (`scripts/tests/setup-checksums.test.cjs`).

## Not pinned (gaps and proposed fallbacks)

| Download | Why it is not pinned | Proposed fallback |
| --- | --- | --- |
| Node.js `v22.23.3` portable ZIP (`setup.ps1`) | `nodejs.org/dist/v22.23.3/SHASUMS256.txt` is the official source, and it was not reachable from the build sandbox. No checksum was invented. | Maintainer copies the `node-v22.23.3-win-x64.zip` line from the official `SHASUMS256.txt` into `setup.ps1`. Until then, the post-extract version check remains the only integrity check. |
| Visual C++ Redistributable (`aka.ms` redirect, `setup.ps1`) | The redirect target changes and Microsoft publishes no stable checksum. | Check the Authenticode signature (Microsoft publisher) with `Get-AuthenticodeSignature` before running. |
| Embedded Python `3.11.9` (`setup-openvino-npu.ps1`) | `python.org` was not reachable from the build sandbox. | Pin the digest from the python.org release page once, as above. |
| `get-pip.py` (`setup-openvino-npu.ps1`) | The file on `bootstrap.pypa.io` changes over time and is executed directly. | Replace with a PyPI pip wheel pinned by the digest in the PyPI JSON API, or pin the file digest from the pypa/get-pip repository. |
| npm packages for Kokoro TTS (`setup-tts.ps1`) | `package-lock.json` is generated at install time, so npm integrity hashes are trust-on-first-use. | Commit a reviewed lock file for the TTS environment. |

The table shows abbreviated digests. The full 64-character values are in the scripts.
