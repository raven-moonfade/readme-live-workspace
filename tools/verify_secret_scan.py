#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""扫描本机配置、sidecar、日志和前端投影中的明文凭证。"""

from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import secrets_win  # noqa: E402
from backend.config import ConfigStore  # noqa: E402

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


def read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except (OSError, UnicodeError, ValueError):
        return {}


def token_values(config: Dict[str, Any], legacy: Dict[str, Any]) -> List[str]:
    values = [
        str((config or {}).get("sessdata_enc") or ""),
        str((legacy or {}).get("sessdata_enc") or ""),
        str((legacy or {}).get("douyin_cookie_enc") or ""),
    ]
    return [value for value in values if value]


def iter_text(path: Path) -> Iterable[str]:
    if not path.is_file():
        return
    try:
        yield path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return


def has_plaintext_pattern(text: str) -> bool:
    pattern = re.compile(
        r"(?:SESSDATA|sessionid(?:__ss)?|sessionid_ss|sid_guard)\s*=\s*[A-Za-z0-9._%~+/=-]{8,}",
        re.IGNORECASE,
    )
    return bool(pattern.search(text))


def main() -> int:
    config_path = ROOT / "config.json"
    legacy_path = ROOT / "config.legacy.json"
    config = read_json(config_path)
    legacy = read_json(legacy_path)
    tokens = token_values(config, legacy)

    plain_values: List[str] = []
    for token in tokens:
        plain, failed = secrets_win.unprotect_ex(token)
        if not failed and plain:
            plain_values.append(plain)

    check(not config.get("sessdata"), "config.json 不含明文 sessdata 字段")
    check("douyin_cookie_enc" not in config, "config.json 不含 cookie 字段")

    for path in (config_path, legacy_path):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        leaked = [value for value in plain_values if value and value in text]
        check(not leaked, "%s 不含可解出的明文凭证" % path.name)
        check(not has_plaintext_pattern(text), "%s 不含明文 Cookie 形态" % path.name)

    with tempfile.TemporaryDirectory(prefix="mutai-secret-scan-") as tmp:
        tmp_root = Path(tmp)
        for source in (config_path, legacy_path):
            if source.is_file():
                shutil.copy2(source, tmp_root / source.name)
        store = ConfigStore(str(tmp_root))
        snapshot = store.snapshot()
        projection = store.project_v1()
        check(not snapshot.get("sessdata"), "snapshot 不暴露 sessdata")
        check("douyin_cookie_enc" not in snapshot, "snapshot 不暴露抖音 cookie")
        check("sessdata_enc" not in snapshot, "snapshot 不暴露凭证 token")
        check(not projection.get("sessdata"), "project_v1 不暴露 sessdata")
        check("douyin_cookie_enc" not in projection, "project_v1 不暴露抖音 cookie")
        check("sessdata_enc" not in projection, "project_v1 不暴露凭证 token")
        check(bool(store.credential_status().get("state")), "凭证安全状态可读取")

    log_root = ROOT / "logs"
    log_hits: List[str] = []
    if log_root.is_dir():
        for path in log_root.rglob("*"):
            if not path.is_file():
                continue
            for text in iter_text(path):
                if has_plaintext_pattern(text):
                    log_hits.append(str(path.relative_to(ROOT)))
                    break
                if any(value and value in text for value in plain_values):
                    log_hits.append(str(path.relative_to(ROOT)))
                    break
    check(not log_hits, "logs 不含明文凭证", ", ".join(log_hits[:5]))

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
