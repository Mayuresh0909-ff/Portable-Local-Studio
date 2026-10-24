# Local AI Studio - Kokoro TTS setup for Windows

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent (Split-Path -Parent $scriptDir)
$appDir = Join-Path $rootDir "app"
$toolsDir = Join-Path $appDir "tools"
$nodeDir = Join-Path $toolsDir "node-win"
$nodeExe = Join-Path $nodeDir "node.exe"
$npmCmd = Join-Path $nodeDir "npm.cmd"
$runtimeDir = Join-Path $appDir "tts-runtime"
$modelsDir = Join-Path $appDir "tts-models"
$outputsDir = Join-Path $appDir "tts-outputs"
$cacheDir = Join-Path $appDir "tts-cache"

function Print-OK { param([string]$m); Write-Host "   OK  $m" -ForegroundColor Green }
function Print-Info { param([string]$m); Write-Host "   >>  $m" -ForegroundColor Cyan }
function Print-Fail { param([string]$m); Write-Host "   XX  $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   Setting up Kokoro ONNX Text-to-Speech runtime" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $runtimeDir, $modelsDir, $outputsDir, $cacheDir | Out-Null

if (-not (Test-Path $nodeExe) -or -not (Test-Path $npmCmd)) {
    $message = "Portable Node.js is missing. Run scripts/setup/setup.ps1 first."
    Print-Fail $message
    throw $message
}

$packageJson = Join-Path $runtimeDir "package.json"
if (-not (Test-Path $packageJson)) {
    '{"private":true,"type":"module","dependencies":{"kokoro-js":"^1.2.1"}}' | Out-File -FilePath $packageJson -Encoding utf8
}

Push-Location $runtimeDir
$oldPath = $env:PATH
$oldOrtCuda = $env:ONNXRUNTIME_NODE_INSTALL_CUDA
try {
    $env:PATH = "$nodeDir;$env:PATH"
    # Kokoro runs on CPU. Skipping ONNX Runtime's optional Linux CUDA payload
    # also avoids setup failures when a machine has a newer CUDA toolkit.
    $env:ONNXRUNTIME_NODE_INSTALL_CUDA = "skip"
    $installMode = if (Test-Path (Join-Path $runtimeDir "package-lock.json")) { "ci" } else { "install" }
    Print-Info "Installing kokoro-js dependencies into app/tts-runtime..."
    # Capture npm stderr/stdout so an optional TTS failure does not flood the setup
    # console with a long red stack trace. npm still records its detailed debug log.
    $npmOutput = & $npmCmd $installMode --prefer-online --no-audit --no-fund --loglevel=error 2>&1
    $npmExitCode = $LASTEXITCODE
    if ($npmExitCode -ne 0) {
        # npm prints: "npm error A complete log of this run can be found in: C:\...\_logs\...log"
        # The pattern is a single-quoted PowerShell string on purpose: in a double-quoted
        # string the backslashes are not escapes, so a regex written there with doubled
        # backslashes only matches literal double backslashes and never npm's Windows path.
        $npmLogPattern = 'A complete log of this run can be found in:\s*(.+)$'
        $npmLogPath = ""
        foreach ($line in $npmOutput) {
            if ([string]$line -match $npmLogPattern) {
                $npmLogPath = $Matches[1].Trim()
            }
        }
        # npm's default cache on Windows is %LOCALAPPDATA%\npm-cache, with debug logs in _logs.
        $npmLogDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "npm-cache\_logs" } else { "%LOCALAPPDATA%\npm-cache\_logs" }
        $message = "kokoro-js install failed (npm exit code $npmExitCode)."
        if ($npmLogPath) {
            $message += " Details: $npmLogPath"
        } else {
            $message += " Check npm's debug log under $npmLogDir."
        }
        Print-Fail $message
        throw $message
    }
} finally {
    $env:PATH = $oldPath
    $env:ONNXRUNTIME_NODE_INSTALL_CUDA = $oldOrtCuda
    Pop-Location
}

Print-OK "Kokoro TTS runtime is ready."
