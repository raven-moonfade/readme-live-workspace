#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证本机历史场次 SQLite 存储、聚合、隐私与删除。"""

from __future__ import annotations

import csv
import json
import os
import sqlite3
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from backend.sessions import SessionStore  # noqa: E402

PASS = 0
FAIL = 0


def check(condition: bool, label: str, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + str(detail)) if detail else ""))
    else:
        FAIL += 1
        print("FAIL  %s%s" % (label, ("  " + str(detail)) if detail else ""))


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-history-") as tmp:
        path = str(Path(tmp) / "data" / "history.sqlite3")
        store = SessionStore(path)
        check(store.available, "SQLite 场次存储可用", store.error)
        now = time.time()

        session_id = "session-a"
        check(store.start_session(session_id, 123456, "测试直播间", started_at=now - 300), "写入场次开始")
        check(store.update_session_meta(session_id, 123456, "测试直播间 · 改"), "更新场次标题")
        for key, count in (("spoken", 1), ("dropped", 1)):
            check(store.bump_session(session_id, "real", key, count), "真实计数 %s" % key)
        check(store.bump_session(session_id, "mock", "received", 4), "模拟计数隔离")

        check(
            store.record_message(
                session_id,
                "gift",
                now - 120,
                101,
                {
                    "gift_name": "测试礼物",
                    "price": 1000,
                    "num": 1,
                    "total_coin": 1000,
                    "coin_type": "gold",
                },
            ),
            "记录金瓜子礼物聚合",
        )
        check(
            store.record_message(
                session_id,
                "super_chat",
                now - 60,
                102,
                {"price": 50},
            ),
            "记录 SC 聚合",
        )
        check(
            store.record_message(
                session_id,
                "danmaku",
                now,
                101,
                {},
            ),
            "记录弹幕聚合",
        )
        check(store.finish_session(session_id, ended_at=now, reason="manual_disconnect"), "结束场次")
        check(store.flush(3.0), "写入线程完成 flush")

        listed = store.list_sessions()
        check(listed.get("ok") and listed.get("total") == 1, "历史列表只包含已结束场次", repr(listed))
        summary = (listed.get("sessions") or [{}])[0]
        check(summary.get("room_title") == "测试直播间 · 改", "列表保留场次标题")
        check(summary.get("real_received") == 3, "真实收到计数")
        check(summary.get("real_spoken") == 1, "真实播放计数")
        check(summary.get("real_dropped") == 1, "真实丢弃计数")
        check(summary.get("mock_received") == 4, "模拟计数单独保存")
        check(summary.get("unique_users") == 2, "去重用户只保存数量")
        check(abs(float(summary.get("gift_cny") or 0) - 1.0) < 1e-9, "1000 金瓜子 = ¥1.00")
        check(abs(float(summary.get("super_chat_cny") or 0) - 50.0) < 1e-9, "SC 金额独立汇总")
        check(summary.get("end_reason") == "manual_disconnect", "结束原因")

        detail = store.get_session(session_id)
        types = (detail.get("session") or {}).get("types") or {}
        minutes = (detail.get("session") or {}).get("minutes") or []
        check(detail.get("ok") and types == {"danmaku": 1, "gift": 1, "super_chat": 1}, "类型分布正确", repr(types))
        check(len(minutes) == 3, "分钟桶按实际分钟聚合", repr(minutes))

        json_export = store.export_session(session_id, "json")
        check(json_export.get("ok") and os.path.isfile(json_export.get("path", "")), "导出 JSON 文件", repr(json_export))
        if json_export.get("ok"):
            payload = json.loads(Path(json_export["path"]).read_text(encoding="utf-8"))
            exported_session = payload.get("session") or {}
            check(payload.get("schema_version") == 2, "JSON 导出含 schema 版本")
            check(exported_session.get("real_received") == 3, "JSON 导出保留聚合指标")
            check(exported_session.get("types", {}).get("gift") == 1, "JSON 导出保留类型分布")
            check(
                not {"text", "user", "user_name", "uid", "viewer_key"}.intersection(exported_session),
                "JSON 导出不包含正文或用户标识",
            )

        csv_export = store.export_session(session_id, "csv")
        check(csv_export.get("ok") and os.path.isfile(csv_export.get("path", "")), "导出 CSV 文件", repr(csv_export))
        if csv_export.get("ok"):
            with open(csv_export["path"], "r", encoding="utf-8-sig", newline="") as handle:
                csv_rows = list(csv.DictReader(handle))
            check(len(csv_rows) == 1, "CSV 导出一行聚合数据")
            check(csv_rows and csv_rows[0].get("real_received") == "3", "CSV 导出保留真实收到数")
            check(csv_rows and csv_rows[0].get("gift") == "1", "CSV 导出保留礼物类型数")
            check(csv_rows and csv_rows[0].get("room_key") == "123456", "CSV 导出保留房间键")

        bad_format = store.export_session(session_id, "xml")
        check(not bad_format.get("ok"), "拒绝未知导出格式")
        missing_export = store.export_session("missing-session", "json")
        check(not missing_export.get("ok"), "拒绝导出不存在的场次")

        active_id = "session-active"
        store.start_session(active_id, 123456, "进行中的场次", started_at=now)
        store.bump_session(active_id, "real", "received", 1)
        store.flush(3.0)
        active_export = store.export_session(active_id, "json")
        check(not active_export.get("ok"), "拒绝导出进行中的场次", repr(active_export))
        store.finish_session(active_id, ended_at=now, reason="manual_disconnect")
        store.flush(3.0)
        store.delete_session(active_id)

        formula_id = "session-formula"
        store.start_session(formula_id, 123456, "=HYPERLINK(\"https://example.invalid\",\"x\")", started_at=now - 10)
        store.bump_session(formula_id, "real", "received", 1)
        store.finish_session(formula_id, ended_at=now, reason="manual_disconnect")
        store.flush(3.0)
        formula_export = store.export_session(formula_id, "csv")
        check(formula_export.get("ok"), "可导出含特殊标题的场次")
        if formula_export.get("ok"):
            with open(formula_export["path"], "r", encoding="utf-8-sig", newline="") as handle:
                formula_row = next(csv.DictReader(handle), {})
            check(
                str(formula_row.get("room_title", "")).startswith("'="),
                "CSV 公式注入已转义",
                repr(formula_row.get("room_title")),
            )
        store.delete_session(formula_id)

        mock_only = "session-mock-only"
        store.start_session(mock_only, 999, "模拟场次", started_at=now)
        store.bump_session(mock_only, "mock", "received", 2)
        store.finish_session(mock_only, ended_at=now, reason="shutdown")
        store.flush(3.0)
        listed2 = store.list_sessions()
        check(listed2.get("total") == 1, "纯模拟场次不进入历史")

        douyin_id = "session-douyin"
        store.start_session(
            douyin_id,
            0,
            "抖音场次",
            started_at=now,
            platform="douyin",
            room_key="dy:test",
        )
        store.record_message(
            douyin_id,
            "gift",
            now + 1,
            "dy-user",
            {"diamond_count": 100, "num": 3, "coin_type": "diamond"},
        )
        store.finish_session(douyin_id, ended_at=now + 2, reason="manual_disconnect")
        store.flush(3.0)
        douyin_detail = store.get_session(douyin_id).get("session") or {}
        check(douyin_detail.get("gift_diamond") == 300,
              "抖音礼物钻石流水按单颗 × 数量累计", douyin_detail)
        check(douyin_detail.get("gift_cny") == 0,
              "抖音钻石流水不写入人民币金额", douyin_detail)
        store.delete_session(douyin_id)

        with closing(sqlite3.connect(path)) as conn:
            tables = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            columns = {
                row[1]
                for row in conn.execute("PRAGMA table_info(sessions)")
            }
        check({"sessions", "session_types", "session_minutes"}.issubset(tables), "历史表结构存在", repr(tables))
        check(not {"text", "user_name", "uid", "viewer_key"}.intersection(columns), "场次表不保存正文/用户名/UID")
        check("gift_diamond" in columns, "场次表保存抖音钻石流水字段", repr(columns))

        deleted = store.delete_session(session_id)
        check(deleted.get("ok"), "删除历史场次")
        check(store.list_sessions().get("total") == 0, "删除后列表为空")
        store.close()

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
