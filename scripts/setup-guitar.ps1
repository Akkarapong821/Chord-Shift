$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $rootDir
New-Item -ItemType Directory -Force '.tools' | Out-Null
$uvExe = Get-ChildItem '.tools/uv' -Filter uv.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $uvExe) {
    $release = Invoke-RestMethod 'https://api.github.com/repos/astral-sh/uv/releases/latest'
    $asset = $release.assets | Where-Object name -eq 'uv-x86_64-pc-windows-msvc.zip'
    Invoke-WebRequest $asset.browser_download_url -OutFile '.tools/uv.zip'
    $hash = (Get-FileHash '.tools/uv.zip' -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $asset.digest -or $asset.digest -ne ('sha256:' + $hash)) { throw 'uv checksum could not be verified' }
    Expand-Archive -LiteralPath '.tools/uv.zip' -DestinationPath '.tools/uv' -Force
    $uvExe = Get-ChildItem '.tools/uv' -Filter uv.exe -Recurse | Select-Object -First 1
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $rootDir '.tools/python'
if (-not (Test-Path '.tools/guitar-env/Scripts/python.exe')) {
    & $uvExe.FullName venv --python 3.11.11 '.tools/guitar-env'
    if ($LASTEXITCODE -ne 0) { throw 'Python setup failed' }
}
& $uvExe.FullName pip install --python '.tools/guitar-env/Scripts/python.exe' torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'PyTorch setup failed' }
& $uvExe.FullName pip install --python '.tools/guitar-env/Scripts/python.exe' demucs==4.0.1 'numpy<2' soundfile imageio-ffmpeg
if ($LASTEXITCODE -ne 0) { throw 'Demucs setup failed' }
& '.tools/guitar-env/Scripts/python.exe' scripts/separate-guitar.py --prepare
if ($LASTEXITCODE -ne 0) { throw 'Guitar model setup failed' }
Write-Output 'Guitar separation is ready on this home computer.'
