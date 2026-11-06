#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证浮窗配置写盘失败时 JsApi 不伪装成功。"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import JsApi, MonitorApi, OverlayManager  # noqa: E402

PASS = 0
FAIL = 0


def check(condition: bool, label: str, detail: object = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + repr(detail)) if detail != "" else ""))
    else:
        FAIL += 1
        print("FAIL  %s%s" % (label, ("  " + repr(detail)) if detail != "" else ""))


class FakeService:
    def __init__(self):
        self.applied = []
        self.config = {
            "overlay": {
                "enabled": False,
                "font_size": 22,
            }
        }

    def update_config(self, patch):
        self.applied.append(patch)
        return {
            "ok": False,
            "error": "配置写入失败，已回滚内存状态",
            "config": {"overlay": {"enabled": False, "font_size": 22}},
            "rejected": ["config.write_failed"],
        }

    def get_overlay_config(self):
        return dict(self.config["overlay"])


class Overlay:
    def __init__(self):
        self.calls = []

    def apply_config(self, cfg, persist=False):
        self.calls.append((dict(cfg), persist))


def main() -> int:
    service = FakeService()
    overlay = Overlay()
    api = object.__new__(JsApi)
    api._svc = service
    api._overlay = overlay

    result = api.apply_overlay({"font_size": 30})
    check(result.get("ok") is False, "写盘失败不返回成功", result)
    check(result.get("error") == "配置写入失败，已回滚内存状态",
          "写盘失败保留后端错误", result)
    check(result.get("rejected") == ["config.write_failed"],
          "写盘失败保留拒绝原因", result)
    check(result.get("config", {}).get("font_size") == 22,
          "写盘失败返回回滚后的配置", result)
    check(overlay.calls == [], "写盘失败不应用浮窗配置", overlay.calls)
    check(service.applied == [{"overlay": {"font_size": 30}}],
          "补丁已交给后端校验", service.applied)

    monitor_api = object.__new__(MonitorApi)
    monitor_api._svc = service
    geometry = monitor_api.save_geometry({"x": 1, "y": 2, "width": 800, "height": 600})
    check(geometry.get("ok") is False and geometry.get("saved") is False,
          "监看几何写盘失败不返回成功", geometry)
    check(geometry.get("geometry") == {"x": 1, "y": 2, "width": 800, "height": 600},
          "监看几何失败仍返回请求值", geometry.get("geometry"))

    manager = object.__new__(OverlayManager)
    manager._svc = service
    shown = manager.set_visible(False)
    check(shown.get("ok") is False and shown.get("saved") is False,
          "浮窗隐藏写盘失败不返回成功", shown)
    check(shown.get("visible") is False, "浮窗写盘失败返回真实当前可见态", shown)

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
