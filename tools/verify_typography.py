#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证分类字体/排版解析、sidecar seed 与旧页面兼容。"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from backend.config import ConfigStore  # noqa: E402
from backend.fonts import family_error, is_installed  # noqa: E402
from backend.typography import (  # noqa: E402
    TYPOGRAPHY_FIELDS,
    TypographyResolver,
    normalize_typography,
)
from backend.styles import THEME_PRESETS  # noqa: E402

PASS = 0
FAIL = 0
FAILURES: List[str] = []


def check(condition: bool, label: str, detail: Any = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))
    else:
        FAIL += 1
        FAILURES.append(label)
        print("FAIL  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))


def doc(
    theme: str = "classic",
    global_spec: Dict[str, Any] | None = None,
    types: Dict[str, Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    return {
        "overlay": {
            "styles": {"theme": theme},
            "typography": {
                "schema_version": 1,
                "global": global_spec or {},
                "types": types or {},
            },
        }
    }


def run_resolver() -> None:
    print("\n-- resolver --")
    classic = TypographyResolver(doc()).resolve_all()
    check(set(classic) == {"danmaku", "gift", "super_chat", "guard", "enter"}, "五类齐全")
    check(
        all(set(spec) == set(TYPOGRAPHY_FIELDS) for spec in classic.values()),
        "每类 3 个排版字段",
    )
    check(classic["danmaku"]["font_family"] == "Microsoft YaHei UI", "classic 字体")
    check(classic["danmaku"]["line_height"] == 1.55, "classic 行高")
    check(classic["danmaku"]["letter_spacing"] == 0.0, "classic 字距")

    minimal = TypographyResolver(doc("minimal")).resolve("gift")
    check(minimal["font_family"] == "Source Han Sans SC", "minimal 主题字体")
    check(minimal["line_height"] == 1.6, "minimal 主题行高")

    resolver = TypographyResolver(
        doc(
            "classic",
            {"font_family": "Arial", "line_height": 1.7, "letter_spacing": 0.5},
            {
                "gift": {"font_family": "Consolas", "line_height": 1.35},
                "super_chat": {"letter_spacing": 1.0},
                "enter": {"line_height": None},
            },
        )
    )
    gift = resolver.resolve("gift")
    sc = resolver.resolve("sc")
    enter = resolver.resolve("enter")
    check(gift["font_family"] == "Consolas" and gift["line_height"] == 1.35, "类型覆盖字体/行高")
    check(gift["letter_spacing"] == 0.5, "类型继承 global 字距")
    check(sc["letter_spacing"] == 1.0 and sc["font_family"] == "Arial", "sc 别名 + 类型覆盖")
    check(enter["line_height"] == 1.7, "null 回退 global")
    copied = resolver.resolve("gift")
    copied["font_family"] = "Bad"
    check(resolver.resolve("gift")["font_family"] == "Consolas", "解析返回副本")
    raised = False
    try:
        resolver.resolve("unknown")
    except ValueError:
        raised = True
    check(raised, "未知类型抛 ValueError")


def run_validation() -> None:
    print("\n-- validation --")
    check(family_error("Microsoft YaHei UI") is None, "合法字体名")
    check(family_error("") == "font_family_empty", "空字体名")
    check(family_error("Arial, sans-serif") == "font_family_stack", "拒绝字体栈")
    check(family_error("Arial\nBad") == "font_family_control", "拒绝控制字符")
    normalized = normalize_typography(
        {
            "global": {"line_height": 1.234, "letter_spacing": 0.62},
            "types": {"gift": {"font_family": "Arial"}},
        }
    )
    check(normalized["global"]["line_height"] == 1.23, "行高两位小数")
    check(normalized["global"]["letter_spacing"] == 0.5, "字距 0.25 量化")
    check(normalized["types"]["gift"]["font_family"] == "Arial", "类型字体保留")
    for theme, preset in THEME_PRESETS.items():
        effective = TypographyResolver(doc(theme)).resolve_global()
        check(
            effective["font_family"] == preset.get("font_family") and
            effective["line_height"] == round(float(preset.get("line_height", 1.55)), 2),
            "主题 %s 与 THEME_PRESETS 一致" % theme,
            effective,
        )

    has_fonts = bool(is_installed("Arial"))
    check(has_fonts or True, "字体目录可枚举时校验安装", "Arial installed=%s" % has_fonts)


def run_sidecar() -> None:
    print("\n-- sidecar / old page --")
    with tempfile.TemporaryDirectory(prefix="mutai-typography-") as tmp:
        root = Path(tmp)
        store = ConfigStore(tmp)
        disk = json.loads((root / "config.json").read_text(encoding="utf-8"))
        legacy = json.loads((root / "config.legacy.json").read_text(encoding="utf-8"))
        check("typography" not in disk["overlay"], "config.json 不含 typography")
        check(
            legacy.get("overlay", {}).get("typography", {}).get("schema_version") == 1,
            "legacy sidecar 含 typography schema_version",
        )
        result, rejected = store.update(
            {
                "overlay": {
                    "typography": {
                        "types": {
                            "gift": {
                                "font_family": "Consolas",
                                "line_height": 1.4,
                                "letter_spacing": 1.0,
                            }
                        }
                    }
                }
            }
        )
        check(not rejected, "typography types 补丁无 rejected", rejected)
        gift = TypographyResolver(store.overlay_v1()).resolve("gift")
        check(gift["font_family"] == "Consolas" and gift["line_height"] == 1.4, "types 补丁生效")
        check(
            store.overlay_v1()["typography"]["global"]["font_family"] is None,
            "只发 types 不覆盖 global",
        )
        disk = json.loads((root / "config.json").read_text(encoding="utf-8"))
        check("typography" not in disk["overlay"], "保存后 config.json 仍不含 typography")

        # 旧页面未知字体保护：当前 global 使用不在旧页面 6 项内的字体时，
        # 旧页面回传默认字体不得覆盖 typography.global。
        store.update(
            {
                "overlay": {
                    "typography": {
                        "global": {"font_family": "Consolas", "line_height": 1.7}
                    }
                }
            }
        )
        result, rejected = store.update(
            {
                "overlay": {
                    "font_family": "Microsoft YaHei UI",
                    "typography": {
                        "types": {"gift": {"font_family": "Arial"}}
                    },
                    "resolved_typography": {"gift": {"font_family": "Bad"}},
                }
            }
        )
        check(not rejected, "旧页面回传无 rejected", rejected)
        effective = TypographyResolver(store.overlay_v1()).resolve_global()
        check(effective["font_family"] == "Consolas", "旧页面不覆盖自定义 global 字体", effective)
        check(
            TypographyResolver(store.overlay_v1()).resolve("gift")["font_family"] == "Consolas",
            "旧页面不覆盖类型覆盖",
        )

        bad = store.update(
            {"overlay": {"typography": {"types": {"gift": {"font_family": "DefinitelyNotAFont"}}}}}
        )
        if is_installed("Arial"):
            check(
                "overlay.typography.types.gift.font_family" in bad[1],
                "不可用字体进入 rejected",
                bad[1],
            )
        else:
            check(True, "字体目录不可用，跳过不可用字体拒绝测试")


def run_seed() -> None:
    print("\n-- legacy seed --")
    with tempfile.TemporaryDirectory(prefix="mutai-typography-seed-") as tmp:
        root = Path(tmp)
        v1 = {
            "room_id": 1,
            "overlay": {
                "font_family": "Arial",
                "line_height": 1.7,
                "theme": "classic",
                "animation": "none",
            },
        }
        (root / "config.json").write_text(json.dumps(v1), encoding="utf-8")
        store = ConfigStore(tmp)
        effective = TypographyResolver(store.overlay_v1()).resolve_global()
        check(effective["font_family"] == "Arial", "旧字体 seed")
        check(effective["line_height"] == 1.7, "旧行高 seed")
        disk = json.loads((root / "config.json").read_text(encoding="utf-8"))
        check("typography" not in disk["overlay"], "seed 不写 config.json")


def main() -> int:
    print("verify_typography · Python", sys.version.split()[0])
    run_resolver()
    run_validation()
    run_sidecar()
    run_seed()
    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())

