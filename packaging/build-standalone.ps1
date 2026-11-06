$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$python = if ($env:README_BUILD_PYTHON) {
    $env:README_BUILD_PYTHON
} else {
    Join-Path $root ".venv\Scripts\python.exe"
}
$spec = Join-Path $root "packaging\ReadMe.spec"

if (-not (Test-Path -LiteralPath $python)) {
    throw "缺少构建环境：$python"
}

Push-Location $root
try {
    & $python -m PyInstaller --noconfirm --clean $spec
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller 构建失败，退出码 $LASTEXITCODE"
    }
    $version = (& $python -c "import backend; print(backend.__version__)").Trim()
    $dist = Join-Path $root "dist\ReadMe"
    foreach ($name in @("README.md", "LICENSE", "SECURITY.md")) {
        Copy-Item -LiteralPath (Join-Path $root $name) -Destination $dist -Force
    }
    $archive = Join-Path $root "dist\ReadMe-v$version-standalone.zip"
    Compress-Archive -LiteralPath $dist -DestinationPath $archive -CompressionLevel Optimal -Force
    Write-Host "Standalone archive: $archive"
} finally {
    Pop-Location
}

Write-Host "Standalone build: $(Join-Path $root 'dist\ReadMe\ReadMe.exe')"
