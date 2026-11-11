#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""核对 v1.0.1 版本身份、发布说明和固定依赖清单。"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import __version__  # noqa: E402
import app as app_module  # noqa: E402

PASS = 0
FAIL = 0


def check(condition: bool, label: str, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  " + label)
        return
    FAIL += 1
    print("FAIL  " + label + (("  " + detail) if detail else ""))


def main() -> int:
    info = app_module.JsApi(None).get_app_info()
    check(__version__ == "1.0.1", "backend.__version__ 为 1.0.1", __version__)
    check(info.get("version") == __version__, "get_app_info 与 backend 版本一致", info)
    check(info.get("name") == "ReadMe" and app_module.APP_TITLE == "ReadMe",
          "应用身份为 ReadMe", info)

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    check("v1.0.1" in readme, "README 标记 v1.0.1")
    check((ROOT / "docs" / "release" / "v1.0.1.md").is_file(),
          "发布说明 docs/release/v1.0.1.md 存在")

    stale = []
    version_pattern = re.compile(r"""(?:"version"\s*:\s*["']|版本[^\n]{0,24})0\.1\.0""")
    for path in (ROOT / "app.py", ROOT / "backend" / "__init__.py",
                 ROOT / "ui" / "index.html", ROOT / "README.md"):
        if path.is_file():
            content = path.read_text(encoding="utf-8", errors="replace")
            if version_pattern.search(content):
                stale.append(str(path.relative_to(ROOT)))
    check(not stale, "应用身份中无残留 0.1.0 版本", ", ".join(stale))

    requirements = ROOT / "requirements-v1.txt"
    check(requirements.is_file(), "固定依赖清单存在")
    if requirements.is_file():
        lines = [
            line.strip() for line in requirements.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        check(any(line.startswith("./vendor/blivedm-master") for line in lines),
              "依赖清单包含 vendored blivedm")
        pinned = [line for line in lines if not line.startswith(("./", "-e", "file:"))]
        check(pinned and all("==" in line for line in pinned),
              "依赖清单运行时项均固定版本", pinned[:3])
        check(any(line.startswith("pywebview==") for line in pinned) and
              any(line.startswith("edge-tts==") for line in pinned) and
              any(line.startswith("PySide6==") for line in pinned),
              "依赖清单覆盖桌面运行组件")

    release = (ROOT / "docs" / "release" / "v1.0.1.md")
    if release.is_file():
        notes = release.read_text(encoding="utf-8")
        check(("B站" in notes or "B 站" in notes) and "抖音" in notes and "已知限制" in notes,
              "发布说明覆盖支持平台与限制")
        check("升级" in notes and "回滚" in notes,
              "发布说明覆盖升级与回滚")

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
