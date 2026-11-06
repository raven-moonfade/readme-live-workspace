#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证动效解析、采样、sidecar 存储与旧页面兼容。"""

from __future__ import annotations

import copy
import json
import logging
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

logging.disable(logging.CRITICAL)

from backend.config import ConfigStore, DEFAULT_CONFIG  # noqa: E402
from backend.motion import (  # noqa: E402
    MOTION_DEFAULTS,
    MOTION_FIELDS,
    MOTION_SCHEMA_VERSION,
    MotionResolver,
    motion_from_legacy,
    normalize_motion,
    reduced_motion_spec,
    sample_enter,
    sample_exit,
)

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


def close(a: float, b: float, tolerance: float = 0.002) -> bool:
    return abs(float(a) - float(b)) <= tolerance


def doc(motion: Any = None, animation: str = "slide") -> Dict[str, Any]:
    overlay: Dict[str, Any] = {"animation": animation}
    if motion is not None:
        overlay["motion"] = motion
    return {"overlay": overlay}


def run_resolver() -> None:
    print("\n-- resolver --")
    resolved = MotionResolver(doc()).resolve_all()
    check(
        set(resolved) == {
            "danmaku", "gift", "super_chat", "guard", "enter", "like", "social", "fansclub",
        },
        "八类齐全",
    )
    check(
        all(set(spec) == set(MOTION_FIELDS) for spec in resolved.values()),
        "每类 12 个动效字段",
    )
    check(
        all(spec == MOTION_DEFAULTS for spec in resolved.values()),
        "默认五类一致",
        resolved["danmaku"],
    )

    motion = {
        "global": {
            "enter_anim": "fade",
            "enter_ms": 300,
            "exit_distance": 12,
        },
        "types": {
            "gift": {"enter_anim": "scale", "enter_scale": 80},
            "super_chat": {"enter_dir": "down"},
            "enter": {"enter_anim": None, "exit_anim": "none"},
        },
    }
    resolver = MotionResolver(doc(motion))
    gift = resolver.resolve("gift")
    danmaku = resolver.resolve("danmaku")
    sc = resolver.resolve("sc")
    enter = resolver.resolve("enter")
    check(gift["enter_anim"] == "scale" and gift["enter_scale"] == 80, "类型覆盖生效")
    check(gift["enter_ms"] == 300 and gift["exit_distance"] == 12, "类型继承 global")
    check(danmaku["enter_anim"] == "fade", "global 影响未覆盖类型")
    check(sc["enter_dir"] == "down", "sc 别名映射到 super_chat")
    check(enter["enter_anim"] == "fade", "null 回退 global")
    check(enter["exit_anim"] == "none", "类型 none 是有效覆盖")

    cached = resolver.resolve("gift")
    cached["enter_ms"] = 9999
    check(resolver.resolve("gift")["enter_ms"] == 300, "解析结果返回副本")

    raised = False
    try:
        resolver.resolve("unknown")
    except ValueError:
        raised = True
    check(raised, "未知类型抛 ValueError")


def run_legacy() -> None:
    print("\n-- legacy animation --")
    for value in ("slide", "fade", "none", "unknown", None):
        motion = motion_from_legacy(value)
        expected = value if value in ("slide", "fade", "none") else "slide"
        check(motion["global"]["enter_anim"] == expected, "旧值 %r 映射" % value)
        check(motion["global"]["exit_anim"] == "fade", "旧退场始终 fade（%r）" % value)
        check(motion["global"]["exit_distance"] == 4, "旧 4px 退场位移（%r）" % value)
    check(motion_from_legacy("none")["global"]["enter_anim"] == "none", "旧 none 只关入场")
    check(
        all(value is None for values in motion_from_legacy("slide")["types"].values() for value in values.values()),
        "旧迁移五类全 null",
    )


def run_sampling() -> None:
    print("\n-- sampling --")
    enter_slide = {
        **MOTION_DEFAULTS,
        "enter_anim": "slide",
        "enter_dir": "right",
        "enter_distance": 0,
        "enter_ms": 220,
    }
    start = sample_enter(enter_slide, 0.0, 22.0)
    mid = sample_enter(enter_slide, 0.5, 22.0)
    end = sample_enter(enter_slide, 1.0, 22.0)
    check(close(start["dx"], 29.7), "自动入场距离 max(24, font*1.35)", start)
    check(close(start["opacity"], 0.0), "入场起点透明", start)
    check(close(mid["dx"], 29.7 * 0.125), "cubic ease-out 中点半程", mid)
    check(close(mid["opacity"], 0.875), "cubic ease-out 中点透明度", mid)
    check(close(end["dx"], 0.0) and close(end["opacity"], 1.0), "入场终点", end)

    enter_up = {**enter_slide, "enter_dir": "up", "enter_distance": 24}
    check(sample_enter(enter_up, 0.0)["dy"] < 0, "入场 up 从上方进入")
    enter_down = {**enter_slide, "enter_dir": "down", "enter_distance": 24}
    check(sample_enter(enter_down, 0.0)["dy"] > 0, "入场 down 从下方进入")

    exit_fade = {
        **MOTION_DEFAULTS,
        "exit_anim": "fade",
        "exit_dir": "up",
        "exit_distance": 4,
        "exit_ms": 180,
    }
    exit_mid = sample_exit(exit_fade, 0.5)
    exit_end = sample_exit(exit_fade, 1.0)
    check(close(exit_mid["dy"], -0.5), "旧淡出 4px 上移中点", exit_mid)
    check(close(exit_mid["opacity"], 0.875), "旧淡出中点透明度", exit_mid)
    check(close(exit_end["dy"], -4.0) and close(exit_end["opacity"], 0.0), "退场终点", exit_end)

    exit_down = {**exit_fade, "exit_dir": "down", "exit_distance": 10, "exit_anim": "slide"}
    check(sample_exit(exit_down, 0.5)["dy"] > 0, "退场 down 向下离开")

    enter_scale = {
        **MOTION_DEFAULTS,
        "enter_anim": "scale",
        "enter_scale": 80,
        "enter_opacity": 20,
    }
    scale_start = sample_enter(enter_scale, 0.0)
    check(close(scale_start["scale"], 0.8) and close(scale_start["opacity"], 0.2), "缩放入场起点", scale_start)

    none = sample_enter({**MOTION_DEFAULTS, "enter_anim": "none"}, 0.2)
    check(close(none["opacity"], 1.0) and close(none["dx"], 0.0), "none 短路")
    zero = sample_enter({**MOTION_DEFAULTS, "enter_anim": "slide", "enter_ms": 0}, 0.0)
    check(close(zero["opacity"], 1.0), "0ms 立即完成")
    exit_zero = {**MOTION_DEFAULTS, "exit_distance": 0, "exit_anim": "fade"}
    check(close(sample_exit(exit_zero, 1.0)["dy"], 0.0), "退场 0px 无位移")

    reduced = reduced_motion_spec({**MOTION_DEFAULTS, "enter_anim": "slide", "enter_ms": 500}, "enter")
    check(reduced["enter_anim"] == "fade" and reduced["enter_ms"] == 80, "减少动态效果改为 80ms 淡入")
    reduced_none = reduced_motion_spec({**MOTION_DEFAULTS, "enter_anim": "none"}, "enter")
    check(reduced_none["enter_anim"] == "none", "减少动态效果不覆盖显式 none")


def run_sidecar() -> None:
    print("\n-- sidecar / old page --")
    check(set(DEFAULT_CONFIG["overlay"]) == {"enabled", "geometry", "styles", "pins"}, "config.json 结构不变")
    with tempfile.TemporaryDirectory(prefix="mutai-motion-sidecar-") as tmp:
        root = Path(tmp)
        store = ConfigStore(tmp)
        disk = json.loads((root / "config.json").read_text(encoding="utf-8"))
        legacy = json.loads((root / "config.legacy.json").read_text(encoding="utf-8"))
        check("motion" not in disk["overlay"], "config.json 不含 motion")
        check(legacy.get("overlay", {}).get("motion", {}).get("schema_version") == MOTION_SCHEMA_VERSION,
              "legacy sidecar 含 motion schema_version")

        result, rejected = store.update(
            {"overlay": {"motion": {"types": {"gift": {"enter_anim": "scale", "enter_scale": 85}}}}}
        )
        check(not rejected, "motion 补丁无 rejected", rejected)
        gift = MotionResolver(store.overlay_v1()).resolve("gift")
        check(gift["enter_anim"] == "scale" and gift["enter_scale"] == 85, "motion 补丁生效")
        disk = json.loads((root / "config.json").read_text(encoding="utf-8"))
        legacy = json.loads((root / "config.legacy.json").read_text(encoding="utf-8"))
        check("motion" not in disk["overlay"], "motion 补丁后 config.json 仍不含 motion")
        check(legacy["overlay"]["motion"]["types"]["gift"]["enter_anim"] == "scale",
              "motion 已写入 legacy sidecar")

        # 旧页面：带 animation 的补丁必须忽略 motion / resolved_motion，且不产生 rejected。
        result, rejected = store.update(
            {
                "overlay": {
                    "animation": "fade",
                    "font_size": 24,
                    "motion": {"types": {"gift": {"enter_anim": "none"}}},
                    "resolved_motion": {"gift": {"enter_anim": "none"}},
                }
            }
        )
        check(not rejected, "旧页面回传无 rejected", rejected)
        gift = MotionResolver(store.overlay_v1()).resolve("gift")
        check(gift["enter_anim"] == "scale", "旧页面不改写类型覆盖")
        check(store.overlay_v1()["motion"]["global"]["enter_anim"] == "fade", "旧页面 animation 桥接到 global")
        check(store.overlay_v1()["animation"] == "fade", "旧投影 animation 同步")
        check(store.get("overlay", "styles", "global", "font_size") == 24, "旧页面其他字段正常保存")

        # 旧页面回传未变化的 animation 不能覆盖新 scale。
        result, rejected = store.update(
            {"overlay": {"animation": "fade", "resolved_motion": {"gift": {"enter_anim": "none"}}}}
        )
        check(not rejected, "未变化 animation 无 rejected", rejected)
        check(MotionResolver(store.overlay_v1()).resolve("gift")["enter_anim"] == "scale",
              "未变化 animation 不覆盖类型覆盖")

        # 非法 motion 进入 rejected。
        result, rejected = store.update(
            {"overlay": {"motion": {"types": {"gift": {"enter_anim": "zoom"}}}}}
        )
        check("overlay.motion.types.gift.enter_anim" in rejected, "非法 motion 进入 rejected", rejected)
        check(MotionResolver(store.overlay_v1()).resolve("gift")["enter_anim"] == "scale",
              "非法 motion 不改变旧值")


def run_v1_seed() -> None:
    print("\n-- v1 animation seed --")
    with tempfile.TemporaryDirectory(prefix="mutai-motion-v1-") as tmp:
        root = Path(tmp)
        v1 = {
            "room_id": 123,
            "sessdata": "",
            "overlay": {
                "enabled": True,
                "x": 20,
                "y": 30,
                "width": 520,
                "height": 620,
                "font_size": 22,
                "theme": "classic",
                "animation": "none",
            },
        }
        (root / "config.json").write_text(json.dumps(v1, ensure_ascii=False), encoding="utf-8")
        store = ConfigStore(tmp)
        motion = store.overlay_v1()["motion"]["global"]
        check(motion["enter_anim"] == "none", "v1 animation none seed 到 global")
        check(motion["exit_anim"] == "fade" and motion["exit_distance"] == 4,
              "v1 none 退场仍为 fade + 4px", motion)
        disk = json.loads((root / "config.json").read_text(encoding="utf-8"))
        check("motion" not in disk["overlay"], "v1 迁移不把 motion 写进 config.json")


def main() -> int:
    print("verify_motion · Python", sys.version.split()[0])
    run_resolver()
    run_legacy()
    run_sampling()
    run_sidecar()
    run_v1_seed()
    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())

