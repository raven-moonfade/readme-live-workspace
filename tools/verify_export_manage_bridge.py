#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证导出文件管理 JsApi 桥接。"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import JsApi  # noqa: E402
from backend.core import DanmakuTTSService  # noqa: E402

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
        self.calls = []
        self.fail = False

    def export_storage_status(self, week=None):
        self.calls.append(("status", week))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "files": 2}

    def export_storage_preview(self, days, keep_latest, week=None):
        self.calls.append(("preview", days, keep_latest, week))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "preview_id": "p1"}

    def export_storage_prune(self, preview_id, days, keep_latest, week=None):
        self.calls.append(("prune", preview_id, days, keep_latest, week))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "deleted_count": 1}

    def open_export_dir(self):
        self.calls.append(("open",))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "directory": "D:/exports"}


def make_api(service):
    api = object.__new__(JsApi)
    api._svc = service
    return api


def main() -> int:
    service = FakeService()
    api = make_api(service)
    check(api.history_export_storage_status().get("files") == 2,
          "导出统计桥接成功")
    check(api.history_export_storage_status("2027-W02").get("files") == 2,
          "导出统计周参数桥接成功")
    check(api.history_export_storage_preview(30, 20).get("preview_id") == "p1",
          "导出预览桥接成功")
    check(api.history_export_storage_preview(30, 20, "2027-W02").get("preview_id") == "p1",
          "导出预览周参数桥接成功")
    check(api.history_export_storage_prune("p1", 30, 20).get("deleted_count") == 1,
          "导出清理桥接成功")
    check(api.history_export_storage_prune("p1", 30, 20, "2027-W02").get("deleted_count") == 1,
          "导出清理周参数桥接成功")
    check(api.history_export_storage_open_dir().get("directory") == "D:/exports",
          "打开导出目录桥接成功")
    check(service.calls == [
        ("status", None),
        ("status", "2027-W02"),
        ("preview", 30, 20, None),
        ("preview", 30, 20, "2027-W02"),
        ("prune", "p1", 30, 20, None),
        ("prune", "p1", 30, 20, "2027-W02"),
        ("open",),
    ], "导出管理参数按预期传递", service.calls)

    service.fail = True
    check(api.history_export_storage_status().get("error_code") == "internal",
          "统计异常不抛给 JS")
    check(api.history_export_storage_preview().get("error_code") == "internal",
          "预览异常不抛给 JS")
    check(api.history_export_storage_prune("p1").get("error_code") == "internal",
          "清理异常不抛给 JS")
    check(api.history_export_storage_open_dir().get("error_code") == "open_failed",
          "打开目录异常不抛给 JS")

    class MissingService:
        pass

    missing = make_api(MissingService())
    check(missing.history_export_storage_status().get("error_code") == "unsupported",
          "旧后端缺导出统计返回 unsupported")
    check(missing.history_export_storage_preview().get("error_code") == "unsupported",
          "旧后端缺导出预览返回 unsupported")
    check(missing.history_export_storage_prune("p1").get("error_code") == "unsupported",
          "旧后端缺导出清理返回 unsupported")
    check(missing.history_export_storage_open_dir().get("error_code") == "unsupported",
          "旧后端缺打开目录返回 unsupported")

    class Store:
        available = True
        error = ""
        dropped_ops = 0
        failed_ops = 0
        last_write_error = ""

    core = object.__new__(DanmakuTTSService)
    core.session_store = Store()
    status = core.history_status()
    check(status.get("capabilities", {}).get("export_manage") == 1,
          "历史状态暴露导出管理能力位", status.get("capabilities"))
    check(status.get("capabilities", {}).get("export_manage_week") == 1,
          "历史状态暴露按周导出能力位", status.get("capabilities"))

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
