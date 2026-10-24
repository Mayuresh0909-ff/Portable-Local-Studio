const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

// These tests check the PowerShell source text only; pwsh is not available in CI here,
// so they cannot prove the scripts run. They do pin the verify-before-extract ordering.

const SETUP_SCRIPTS = [
  "scripts/setup/setup.ps1",
  "scripts/setup/setup-llama.ps1",
  "scripts/setup/setup-whisper.ps1",
];

test("every pinned download SHA-256 is a 64-character lowercase hex digest", () => {
  for (const file of SETUP_SCRIPTS) {
    const source = read(file);
    const pins = [...source.matchAll(/"([0-9a-f]{64})"/gi)].map((m) => m[1]);
    for (const pin of pins) {
      assert.match(pin, /^[0-9a-f]{64}$/, `${file} has a malformed digest: ${pin}`);
    }
  }
});

test("setup.ps1 verifies stable-diffusion.cpp archives before any extraction", () => {
  const source = read("scripts/setup/setup.ps1");
  assert.match(source, /function Assert-FileSha256/);
  assert.match(source, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/);
  assert.match(source, /SHA-256 mismatch for \$Label/);
  // The mismatch path deletes the file and throws before returning.
  const helper = source.slice(source.indexOf("function Assert-FileSha256"));
  const body = helper.slice(0, helper.indexOf("\n}\n"));
  assert.match(body, /Remove-Item -LiteralPath \$Path -Force[\s\S]*throw "SHA-256 mismatch/);

  const sites = [
    { download: "$cpuBackendZip", pin: "$sdCpuSha256", extract: "Expand-WithProgress -ZipPath $cpuBackendZip" },
    { download: "$backendZip", pin: "$sdCudaSha256", extract: "Expand-WithProgress -ZipPath $backendZip -Destination $tempExt -Label \"CUDA Backend\"" },
    { download: "$dllZip", pin: "$sdCudartSha256", extract: "Expand-WithProgress -ZipPath $dllZip" },
    { download: "$backendZip", pin: "$sdVulkanSha256", extract: "Expand-WithProgress -ZipPath $backendZip -Destination $tempExt -Label \"Vulkan Backend\"" },
  ];
  for (const site of sites) {
    const verifyAt = source.indexOf(`-ExpectedSha256 ${site.pin} `);
    const extractAt = source.indexOf(site.extract);
    assert.ok(verifyAt > 0, `missing verification for ${site.pin}`);
    assert.ok(extractAt > 0, `missing extraction for ${site.pin}`);
    assert.ok(verifyAt < extractAt, `verification for ${site.pin} must precede extraction`);
  }
});

test("setup.ps1 pins the four sd.cpp archives used by the image backend", () => {
  const source = read("scripts/setup/setup.ps1");
  assert.match(source, /\$sdCpuSha256\s+=\s+"38da3539d3af6918f4c218fd198ac6e26cd71249e54feb3a491d184d3ca94ea0"/);
  assert.match(source, /\$sdCudaSha256\s+=\s+"bc7aa2f6d471b324bfbc76f108a5cb3b76de29cb892d12609647e11b041f8a02"/);
  assert.match(source, /\$sdCudartSha256\s+=\s+"fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d"/);
  assert.match(source, /\$sdVulkanSha256\s+=\s+"7a0c0a9c3f5a23079174e6f18965177077faeaa7745fcf03c1fc81ae995c14be"/);
});

test("optional CUDA archives fall back instead of aborting setup on mismatch", () => {
  const source = read("scripts/setup/setup.ps1");
  // Both optional CUDA downloads must catch verification failure and clear $ok.
  const catches = source.match(/Assert-FileSha256 -Path \$(backendZip|dllZip)[^\n]*\n\s*\} catch \{\n\s*Print-Warn \$_\.Exception\.Message\n\s*\$ok = \$false/g) || [];
  assert.equal(catches.length, 2);
});

test("llama.cpp installer refuses unpinned releases and verifies before extraction", () => {
  const source = read("scripts/setup/setup-llama.ps1");
  assert.match(source, /\$llamaSha256ByAsset = @\{/);
  assert.match(source, /if \(-not \$llamaSha256ByAsset\.ContainsKey\(\$AssetName\)\)/);
  const verifyAt = source.indexOf("Assert-FileSha256 -Path $archive");
  const extractAt = source.indexOf("Expand-Archive -Path $archive");
  assert.ok(verifyAt > 0 && extractAt > 0 && verifyAt < extractAt, "archive must be verified before Expand-Archive");
  const cudartVerifyAt = source.indexOf("Assert-FileSha256 -Path $cudartArchive");
  const cudartExtractAt = source.indexOf("Expand-Archive -Path $cudartArchive");
  assert.ok(cudartVerifyAt > 0 && cudartExtractAt > 0 && cudartVerifyAt < cudartExtractAt, "CUDA runtime must be verified before extraction");
});

test("whisper installer refuses unpinned releases and verifies before extraction", () => {
  const source = read("scripts/setup/setup-whisper.ps1");
  assert.match(source, /\$whisperSha256ByRelease = @\{/);
  assert.match(source, /"v1\.9\.1" = "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539"/);
  const verifyAt = source.indexOf("Assert-FileSha256 -Path $archive");
  const extractAt = source.indexOf("Expand-Archive -Path $archive");
  assert.ok(verifyAt > 0 && extractAt > 0 && verifyAt < extractAt, "archive must be verified before Expand-Archive");
});

test("Node.js v22.23.3 Windows x64 ZIP is pinned to the supplied official SHA-256", () => {
  const source = read("scripts/setup/setup.ps1");
  assert.match(source, /\$nodeZipSha256 = "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71"/);
  // The old "not verified" warning must be gone once a digest is pinned.
  assert.doesNotMatch(source, /NOT SHA-256 verified/);
});

test("Node.js archive is verified after download and before any extraction", () => {
  const source = read("scripts/setup/setup.ps1");
  const downloadAt = source.indexOf('-Label "Node.js v22.23.3 LTS (Portable ZIP)"');
  const verifyAt = source.indexOf("Assert-FileSha256 -Path $nodeZip -ExpectedSha256 $nodeZipSha256");
  const guardAt = source.indexOf("Get-NodeArchivePathLengths -ZipPath $nodeZip");
  const extractAt = source.indexOf("Expand-WithProgress -ZipPath $nodeZip");
  assert.ok(downloadAt > 0 && verifyAt > downloadAt, "verification must follow the download");
  assert.ok(verifyAt < guardAt && guardAt < extractAt, "verification and path guard must precede extraction");
});

test("a Node.js checksum mismatch stops setup, keeps the runtime, and reports the cleanup", () => {
  const source = read("scripts/setup/setup.ps1");
  const verifyAt = source.indexOf("Assert-FileSha256 -Path $nodeZip");
  const catchAt = source.indexOf("} catch {", verifyAt);
  const block = source.slice(catchAt, source.indexOf("}", source.indexOf("Read-Host; exit 1", catchAt)) + 1);
  assert.ok(catchAt > verifyAt, "a catch block must follow the Node.js verification");
  assert.match(block, /Print-Fail \$_\.Exception\.Message/);
  assert.match(block, /The existing Portable Node\.js runtime was kept/);
  assert.match(block, /Read-Host; exit 1/);
  // Nothing before verification may delete the active runtime.
  const beforeVerify = source.slice(source.indexOf("if (-not $nodeReady) {"), verifyAt);
  assert.doesNotMatch(beforeVerify, /Remove-Item -LiteralPath \$nodeDir /);
});

test("the helper deletes a mismatched archive before throwing", () => {
  const source = read("scripts/setup/setup.ps1");
  const helper = source.slice(source.indexOf("function Assert-FileSha256"));
  const body = helper.slice(0, helper.indexOf("\n}\n"));
  assert.match(body, /Remove-Item -LiteralPath \$Path -Force -ErrorAction SilentlyContinue\s*\n\s*throw "SHA-256 mismatch/);
});

test("the Node.js path-length guard runs before extraction and uses MAX_PATH minus NUL", () => {
  const source = read("scripts/setup/setup.ps1");
  assert.match(source, /\$nodeMaxPathLength = 259/);
  assert.match(source, /function Get-NodeArchivePathLengths/);
  // The guard reads only the zip directory: no extraction call may precede it in that function.
  const fn = source.slice(source.indexOf("function Get-NodeArchivePathLengths"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.doesNotMatch(body, /Expand-|ExtractToFile|ExtractToDirectory/);
  assert.match(source, /if \(\$pathLengths\.StageMax -gt \$nodeMaxPathLength\)/);
  assert.match(source, /if \(\$pathLengths\.ExtractMax -gt \$nodeMaxPathLength\)/);
});

test("path-length messages give actionable steps without changing system settings", () => {
  const source = read("scripts/setup/setup.ps1");
  assert.match(source, /Move the Portable-Local-Studio folder to a shorter location, for example C:\\PLS/);
  assert.match(source, /set TEMP=C:\\Temp and set TMP=C:\\Temp/);
  assert.match(source, /Windows system settings were not changed/);
  assert.doesNotMatch(source, /LongPathsEnabled|HKLM|reg add|Set-ItemProperty/);
});
