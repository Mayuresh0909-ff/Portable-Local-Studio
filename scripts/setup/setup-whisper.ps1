param([string]$Release = "v1.9.1")

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent (Split-Path -Parent $scriptDir)
$appDir = Join-Path $rootDir "app"
$toolsDir = Join-Path $appDir "tools"
$speechWinRoot = Join-Path $appDir "speech-backend\win"
$speechRoot = Join-Path $speechWinRoot "cpu"
$speechVulkanRoot = Join-Path $speechWinRoot "vulkan"

function Enable-Tls12 {
    try {
        $tls12 = [Enum]::ToObject([Net.SecurityProtocolType], 3072)
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor $tls12
    } catch {
        throw "TLS 1.2 could not be enabled: $($_.Exception.Message)"
    }
}

# Pinned SHA-256 for ggml-org/whisper.cpp release v1.9.1 asset whisper-bin-x64.zip
# (GitHub release-asset metadata, api.github.com/repos/ggml-org/whisper.cpp/releases/tags/v1.9.1).
# A -Release value without an entry here makes the install fail closed.
$whisperSha256ByRelease = @{
    "v1.9.1" = "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539"
}

function Assert-FileSha256 {
    param([string]$Path, [string]$ExpectedSha256, [string]$Label)
    Write-Host "   >>  Verifying SHA-256: $Label"
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "SHA-256 mismatch for $Label. Expected $ExpectedSha256 but got $actual. The download was deleted and was not extracted or run."
    }
    Write-Host "   OK  SHA-256 verified: $Label"
}

function Download-File {
    param([string]$Url, [string]$DestPath, [string]$Label)
    Write-Host "   >>  Downloading $Label..."
    Enable-Tls12
    $client = New-Object System.Net.WebClient
    $client.Headers.Add("User-Agent", "Uncensored-AI-Studio")
    try {
        $client.DownloadFile($Url, $DestPath)
    } finally {
        $client.Dispose()
    }
}

function Find-FirstFile {
    param([string]$Root, [string[]]$Names)
    foreach ($name in $Names) {
        $found = Get-ChildItem $Root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ieq $name } |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

New-Item -ItemType Directory -Force -Path $toolsDir, $speechRoot, $speechVulkanRoot | Out-Null

$cliPath = Join-Path $speechRoot "whisper-cli.exe"
if (Test-Path $cliPath) {
    Write-Host "   OK  whisper.cpp speech backend already ready."
    if (-not (Test-Path (Join-Path $speechVulkanRoot "whisper-cli.exe"))) {
        Write-Host "   ..  Optional Vulkan GPU backend slot: app/speech-backend/win/vulkan"
    }
    exit 0
}

$legacyCli = Join-Path $speechWinRoot "whisper-cli.exe"
$legacyServer = Join-Path $speechWinRoot "whisper-server.exe"
if (Test-Path $legacyCli) {
    Copy-Item $legacyCli $cliPath -Force
    if (Test-Path $legacyServer) {
        Copy-Item $legacyServer (Join-Path $speechRoot "whisper-server.exe") -Force
    }
    Get-ChildItem $speechWinRoot -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notin @("whisper-cli.exe", "whisper-server.exe") } |
        ForEach-Object { Copy-Item $_.FullName (Join-Path $speechRoot $_.Name) -Force }
    Write-Host "   OK  migrated existing whisper.cpp CPU backend to app/speech-backend/win/cpu."
    Write-Host "   ..  For GPU transcription, place a Vulkan-enabled whisper.cpp build in app/speech-backend/win/vulkan."
    exit 0
}

$asset = "whisper-bin-x64.zip"
$archive = Join-Path $toolsDir $asset
$extract = Join-Path $toolsDir "whisper-extract"
$url = "https://github.com/ggml-org/whisper.cpp/releases/download/$Release/$asset"
if (-not $whisperSha256ByRelease.ContainsKey($Release)) {
    throw "No pinned SHA-256 for whisper.cpp release $Release. Refusing to download an unverified archive."
}

Remove-Item $archive, $extract -Recurse -Force -ErrorAction SilentlyContinue
Download-File -Url $url -DestPath $archive -Label "whisper.cpp speech backend ($Release)"
Assert-FileSha256 -Path $archive -ExpectedSha256 $whisperSha256ByRelease[$Release] -Label "$asset ($Release)"

Write-Host "   >>  Extracting whisper.cpp speech backend..."
Expand-Archive -Path $archive -DestinationPath $extract -Force

$cli = Find-FirstFile -Root $extract -Names @("whisper-cli.exe", "main.exe")
$server = Find-FirstFile -Root $extract -Names @("whisper-server.exe", "server.exe")
if (-not $cli) {
    throw "whisper-cli.exe was not found after extracting $asset"
}

Get-ChildItem $extract -Recurse -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $speechRoot $_.Name) -Force
}
if ((Split-Path -Leaf $cli) -ine "whisper-cli.exe") {
    Copy-Item $cli $cliPath -Force
}
if ($server -and (Split-Path -Leaf $server) -ine "whisper-server.exe") {
    Copy-Item $server (Join-Path $speechRoot "whisper-server.exe") -Force
}

Remove-Item $archive, $extract -Recurse -Force -ErrorAction SilentlyContinue
if (-not (Test-Path $cliPath)) {
    throw "whisper-cli.exe was not installed."
}
Write-Host "   OK  whisper.cpp speech backend installed."
Write-Host "   ..  CPU backend path: app/speech-backend/win/cpu"
Write-Host "   ..  Optional Vulkan GPU backend path: app/speech-backend/win/vulkan"
