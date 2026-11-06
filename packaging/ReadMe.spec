# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


ROOT = Path(SPECPATH).resolve().parent

datas = [
    (str(ROOT / "ui"), "ui"),
    (str(ROOT / "assets"), "assets"),
    (str(ROOT / "docs" / "release"), "docs/release"),
    (str(ROOT / "README.md"), "."),
    (str(ROOT / "LICENSE"), "."),
    (str(ROOT / "SECURITY.md"), "."),
]
binaries = []
hiddenimports = []

for package in ("webview", "pygame", "edge_tts", "pythonnet", "clr_loader"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

hiddenimports += collect_submodules("backend")
hiddenimports += collect_submodules("blivedm")
hiddenimports += [
    "clr",
    "qrcode.image.pil",
    "webview.platforms.edgechromium",
    "webview.platforms.winforms",
]

a = Analysis(
    [str(ROOT / "app.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pytest",
        "tests",
        "PySide6.QtWebEngineCore",
        "PySide6.QtWebEngineWidgets",
        "PySide6.QtWebEngineQuick",
    ],
    noarchive=False,
)

# Do not ship the Poppler/Codex-runtime ICU DLLs that may be on PATH during
# the build. Qt 6 uses the Windows system ICU implementation.
_icu_names = {"icuuc.dll", "icudt78.dll"}
a.binaries = [item for item in a.binaries if Path(item[0]).name.lower() not in _icu_names]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ReadMe",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=str(ROOT / "assets" / "app.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ReadMe",
)
