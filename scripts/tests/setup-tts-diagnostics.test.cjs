const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

// npm 10 prints this exact line when a run fails (verified with: npm install ... --loglevel=error).
const npmLine =
  "npm error A complete log of this run can be found in: " +
  "C:\\Users\\Test User\\AppData\\Local\\npm-cache\\_logs\\2026-10-17T11_46_44_821Z-debug-0.log";
const expectedLogPath =
  "C:\\Users\\Test User\\AppData\\Local\\npm-cache\\_logs\\2026-10-17T11_46_44_821Z-debug-0.log";

// Extracts the single-quoted PowerShell pattern. PowerShell -match uses .NET regex, which
// agrees with JavaScript RegExp for this pattern (literal text, \s, (.+), $).
function extractPowerShellPattern(source) {
  const line = source.split("\n").find((l) => l.includes("$npmLogPattern = '"));
  assert.ok(line, "setup-tts.ps1 must define $npmLogPattern as a single-quoted string");
  const match = line.match(/\$npmLogPattern = '([^']*)'/);
  return match[1];
}

test("setup-tts extracts npm's Windows debug-log path from the failure line", () => {
  const pattern = extractPowerShellPattern(read("scripts/setup/setup-tts.ps1"));
  const match = npmLine.match(new RegExp(pattern));
  assert.ok(match, "pattern must match npm's failure line");
  assert.equal(match[1].trim(), expectedLogPath);
});

test("the previous doubled-backslash pattern could not match npm's Windows path", () => {
  // Inside a double-quoted PowerShell string the old "\\\\s" stayed four backslashes,
  // which as a regex matches two literal backslashes. Kept as the documented failure mode.
  const brokenPattern = "A complete log of this run can be found in:\\\\\\\\s*(.+)$";
  assert.equal(npmLine.match(new RegExp(brokenPattern)), null);
});

test("setup-tts builds the npm log fallback path with Join-Path, not doubled backslashes", () => {
  const source = read("scripts/setup/setup-tts.ps1");
  assert.ok(source.includes('Join-Path $env:LOCALAPPDATA "npm-cache\\_logs"'));
  assert.ok(!source.includes("npm-cache\\\\_logs"));
  assert.ok(!source.includes("LOCALAPPDATA\\\\npm-cache"));
});
