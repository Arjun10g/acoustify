$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Podcast Audio Extractor — Windows setup"
Write-Host ""

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "WinGet is required. Install or update Microsoft App Installer, then run this script again."
}

if (-not (Get-Command py -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
    winget install --exact --id Python.Python.3.14 --accept-package-agreements --accept-source-agreements
    Refresh-Path
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    winget install --exact --id Gyan.FFmpeg.Shared --accept-package-agreements --accept-source-agreements
    Refresh-Path
}

if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
    winget install --exact --id DenoLand.Deno --accept-package-agreements --accept-source-agreements
    Refresh-Path
}

$python = if (Get-Command py -ErrorAction SilentlyContinue) { "py" } else { "python" }
if ($python -eq "py") {
    & py -3 -m venv .venv
} else {
    & python -m venv .venv
}

& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install --upgrade --pre "yt-dlp[default]"

Write-Host ""
Write-Host "Setup complete. Opening the app…"
& .\.venv\Scripts\pythonw.exe app.py
