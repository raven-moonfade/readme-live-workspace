$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $root ".venv"
$venvPython = Join-Path $venv "Scripts\python.exe"

if ($venv.Length -gt 80) {
    Write-Warning "项目路径较长（$venv）。PySide6 安装可能触发 Windows 260 字符路径限制，建议移动到较短目录后重试。"
}

function Find-Python {
    $candidates = @(
        $env:README_PYTHON
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return @($py.Source, "-3.11")
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return $python.Source
    }
    throw "找不到 Python 3.11。请安装 Python 3.11 或设置 README_PYTHON。"
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    $found = Find-Python
    if ($found -is [array]) {
        & $found[0] $found[1] -m venv $venv
    } else {
        & $found -m venv $venv
    }
    if ($LASTEXITCODE -ne 0) {
        throw "创建虚拟环境失败。"
    }
}

Push-Location $root
try {
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r (Join-Path $root "requirements-v1.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "安装依赖失败。"
    }
} finally {
    Pop-Location
}

Write-Host "环境已准备好：" $venvPython
