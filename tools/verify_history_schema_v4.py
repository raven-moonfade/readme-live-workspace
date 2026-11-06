#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证历史库 v5 的过滤/硬丢弃/钻石流水字段与旧库迁移。"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.sessions import SessionStore  # noqa: E402

PASS = 0
FAIL = 0


def check(condition: bool, label: str, detail=None) -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  " + label)
    else:
        FAIL += 1
        print("FAIL  " + label + (("  " + repr(detail)) if detail is not None else ""))


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-history-v4-", ignore_cleanup_errors=True) as root:
        path = str(Path(root) / "new.sqlite3")
        store = SessionStore(path)
        try:
            now = time.time()
            check(store.start_session("new", 7, "新场次", started_at=now), "新场次可开始")
            check(store.bump_session("new", "real", "dropped", 5), "写入总丢弃")
            check(store.bump_session("new", "real", "filtered", 2), "写入过滤")
            check(store.finish_session("new", ended_at=now + 60), "新场次可结束")
            check(store.flush(3.0), "新场次落盘")
            result = store.get_session("new")
            session = result.get("session") or {}
            check(session.get("real_dropped") == 3, "新场次只暴露硬丢弃", session)
            check(session.get("real_dropped_total") == 5, "新场次保留总丢弃", session)
            check(session.get("real_filtered") == 2, "新场次保留过滤数", session)
            check(session.get("real_dropped_known") is True, "新场次口径已知", session)
            check(session.get("gift_diamond") == 0, "新场次含钻石流水字段", session)
        finally:
            store.close()

        legacy_path = str(Path(root) / "legacy.sqlite3")
        legacy = SessionStore(legacy_path)
        try:
            now = time.time()
            legacy.start_session("legacy", 8, "旧场次", started_at=now)
            legacy.bump_session("legacy", "real", "dropped", 10)
            legacy.finish_session("legacy", ended_at=now + 60)
            legacy.flush(3.0)
        finally:
            legacy.close()

        with sqlite3.connect(legacy_path) as conn:
            conn.execute("ALTER TABLE sessions DROP COLUMN real_filtered")
            conn.execute("ALTER TABLE sessions DROP COLUMN mock_filtered")
            conn.execute("PRAGMA user_version=3")
            conn.commit()

        migrated = SessionStore(legacy_path)
        try:
            check(bool(migrated._migration_backup_path), "v3 到 v5 迁移前已备份")
            result = migrated.get_session("legacy")
            session = result.get("session") or {}
            check(session.get("real_dropped") == 10, "旧场次保留旧总丢弃", session)
            check(session.get("real_filtered") == 0, "旧场次过滤数显示为零", session)
            check(session.get("real_dropped_known") is False, "旧场次标记旧口径", session)
            check(session.get("gift_diamond") == 0, "旧场次迁移后钻石流水为零", session)
        finally:
            migrated.close()

    print("SUMMARY PASS=%d FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
