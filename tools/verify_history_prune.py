#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证历史清理的预览、备份、保护最近场次与幂等性。"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.sessions import SessionStore  # noqa: E402

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


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-prune-") as tmp:
        path = str(Path(tmp) / "data" / "history.sqlite3")
        store = SessionStore(path)
        now = time.time()
        initial_settings = store.get_settings()
        check(initial_settings.get("ok") and not initial_settings["settings"]["auto_prune_enabled"], "自动清理默认关闭")
        check(initial_settings["settings"]["auto_prune_days"] == 90, "自动清理默认 90 天")
        invalid_setting = store.update_settings({"auto_prune_enabled": "yes"})
        check(not invalid_setting.get("ok") and "auto_prune_enabled" in invalid_setting.get("rejected", []), "拒绝非布尔自动清理开关")
        saved_settings = store.update_settings({"auto_prune_enabled": True, "auto_prune_days": 30})
        check(saved_settings.get("ok") and saved_settings["settings"]["auto_prune_enabled"], "保存自动清理开关")
        check(saved_settings["settings"]["auto_prune_days"] == 30, "保存自动清理天数")
        check(store.get_settings()["settings"]["auto_prune_days"] == 30, "自动清理设置持久化")
        store.update_settings({"auto_prune_enabled": False, "auto_prune_days": 90})

        for index in range(1, 5):
            session_id = "old-%d" % index
            store.start_session(session_id, 600, "场次 %d" % index, started_at=now - 10 * 86400 + index * 86400)
            store.record_message(session_id, "danmaku", now - 10 * 86400 + index * 86400, index, {})
            store.finish_session(session_id, ended_at=now - 10 * 86400 + index * 86400 + 600, reason="manual_disconnect")
        store.start_session("active", 600, "进行中", started_at=now)
        store.flush(3.0)

        preview = store.prune_sessions(now + 86400, keep_latest=1, dry_run=True)
        check(preview.get("ok") and preview.get("dry_run"), "清理预览成功", preview)
        check(preview.get("matched") == 3, "保留最近一场后匹配三场", preview.get("matched"))
        check(preview.get("protected") == 1, "保护最近一场", preview.get("protected"))
        check(preview.get("backup_path") is None, "预览不创建备份")
        check(store.list_sessions().get("total") == 4, "预览不删除数据")
        check(bool(store.get_session("active").get("ok")), "进行中场次仍在")

        actual = store.prune_sessions(now + 86400, keep_latest=1, dry_run=False)
        check(actual.get("ok") and not actual.get("dry_run"), "实际清理成功", actual)
        check(actual.get("deleted") == 3, "实际删除匹配场次", actual.get("deleted"))
        check(actual.get("backup_path") and Path(actual["backup_path"]).is_file(), "清理前生成备份", actual.get("backup_path"))
        check(store.list_sessions().get("total") == 1, "清理后只保留最近一场")
        check(bool(store.get_session("active").get("ok")), "清理不碰进行中场次")

        if actual.get("backup_path"):
            backup = sqlite3.connect(actual["backup_path"])
            try:
                backup_count = int(backup.execute(
                    "SELECT COUNT(*) FROM sessions WHERE ended_at IS NOT NULL"
                ).fetchone()[0])
            finally:
                backup.close()
            check(backup_count == 4, "备份包含清理前全部已结束场次", backup_count)

        second = store.prune_sessions(now + 86400, keep_latest=1, dry_run=False)
        check(second.get("ok") and second.get("deleted") == 0, "重复清理幂等", second)
        check(second.get("backup_path") is None, "无候选时不创建备份")

        invalid = store.prune_sessions(None, keep_latest=1, dry_run=True)
        check(not invalid.get("ok"), "空截止时间被拒绝")

        auto_store = SessionStore(str(Path(tmp) / "auto" / "data" / "history.sqlite3"))
        for index in range(2):
            session_id = "auto-old-%d" % index
            started = now - (50 - index * 5) * 86400
            auto_store.start_session(session_id, 601, "自动旧场 %d" % index, started_at=started)
            auto_store.record_message(session_id, "danmaku", started, index + 1, {})
            auto_store.finish_session(session_id, ended_at=started + 600, reason="manual_disconnect")
        auto_store.flush(3.0)
        auto_store.update_settings({"auto_prune_enabled": True, "auto_prune_days": 30})
        auto_store.close()
        auto_store = SessionStore(str(Path(tmp) / "auto" / "data" / "history.sqlite3"))
        if auto_store._auto_prune_thread is not None:
            auto_store._auto_prune_thread.join(5.0)
        check(auto_store.list_sessions().get("total") == 1, "启动时自动清理并保留最近一场")
        auto_store.update_settings({"auto_prune_enabled": False, "auto_prune_days": 90})
        auto_store.close()
        store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
