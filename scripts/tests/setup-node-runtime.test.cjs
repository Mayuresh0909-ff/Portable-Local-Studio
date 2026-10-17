const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

// Source-level checks only: pwsh is not available in this environment, so the PowerShell
// is not executed. These tests pin the ordering that keeps a working runtime alive.

function nodeInstallBlock(source) {
  const start = source.indexOf("if (-not $nodeReady) {");
  const end = source.indexOf("Ensure-VisualCppRuntime", start);
  assert.ok(start > 0 && end > start, "Node install block not found");
  return source.slice(start, end);
}

test("Test-PortableNodeRuntime can validate a staged directory", () => {
  const source = read("scripts/setup/setup.ps1");
  assert.match(source, /function Test-PortableNodeRuntime \{\s*param\(\[string\]\$ExpectedVersion, \[string\]\$Dir = \$nodeDir\)/);
  const fn = source.slice(source.indexOf("function Test-PortableNodeRuntime"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // The parameter default may name $nodeDir; the body must use only $Dir-derived paths.
  const afterParam = body.slice(body.indexOf("param("));
  assert.doesNotMatch(afterParam.slice(afterParam.indexOf("\n")), /\$nodeExe|\$nodeDir/);
});

test("the active Node runtime is not deleted before its replacement is validated", () => {
  const block = nodeInstallBlock(read("scripts/setup/setup.ps1"));
  const swapAt = block.indexOf("Rename-Item -LiteralPath $nodeDir -NewName $nodePreviousLeaf");
  assert.ok(swapAt > 0, "active runtime must be moved aside by rename");
  // Every removal of the active directory must come after the swap, never before the download.
  const removals = [...block.matchAll(/Remove-Item[^\n]*\$nodeDir\b(?!\w)/g)].map((m) => m.index);
  for (const at of removals) {
    assert.ok(at > swapAt, "Remove-Item on $nodeDir appears before the swap");
  }
  assert.ok(block.indexOf("Invoke-RichDownload") < swapAt);
});

test("the Node archive is copied to a staging folder, not straight over the active runtime", () => {
  const block = nodeInstallBlock(read("scripts/setup/setup.ps1"));
  assert.match(block, /Copy-Item -Destination \$nodeStagingDir -Recurse -Force -ErrorAction Stop/);
  assert.doesNotMatch(block, /Copy-Item -Destination \$nodeDir/);
});

test("staged runtime is validated before the swap, and the swap precedes cleanup of the old copy", () => {
  const block = nodeInstallBlock(read("scripts/setup/setup.ps1"));
  const copyAt = block.indexOf("-ErrorAction Stop");
  const validateAt = block.indexOf("Test-PortableNodeRuntime -ExpectedVersion $expectedNodeVersion -Dir $nodeStagingDir");
  const swapAt = block.indexOf("Rename-Item -LiteralPath $nodeDir -NewName $nodePreviousLeaf");
  const activateAt = block.indexOf("Rename-Item -LiteralPath $nodeStagingDir -NewName $nodeLeaf");
  const cleanupAt = block.lastIndexOf("Remove-Item -LiteralPath $nodePreviousDir -Recurse -Force -ErrorAction SilentlyContinue");
  assert.ok(copyAt > 0 && validateAt > copyAt, "validation must follow the staging copy");
  assert.ok(validateAt < swapAt, "validation must precede the swap");
  assert.ok(swapAt < activateAt, "old runtime is moved aside before the new one is activated");
  assert.ok(activateAt < cleanupAt, "old runtime is deleted only after activation");
});

test("a failed swap restores the previous runtime", () => {
  const block = nodeInstallBlock(read("scripts/setup/setup.ps1"));
  assert.match(block, /if \(-not \(Test-Path \$nodeDir\) -and \(Test-Path \$nodePreviousDir\)\) \{\s*Rename-Item -LiteralPath \$nodePreviousDir -NewName \$nodeLeaf/);
});

test("the Node install reports copy failures and leaves the previous runtime in place", () => {
  const block = nodeInstallBlock(read("scripts/setup/setup.ps1"));
  assert.match(block, /Print-Fail "Could not stage Node\.js: /);
  assert.match(block, /The existing Portable Node\.js runtime was kept\./);
});
