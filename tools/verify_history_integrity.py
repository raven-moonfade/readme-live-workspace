#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证历史库的错误路径：初始化、写屏障、重复 start、删除和写入失败隔离。"""

from __future__ import annotations

import sys
import tempfile
import threading
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.core import DanmakuTTSService
from backend.sessions import SessionStore

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


def temp_store(tmp: str, name: str) -> SessionStore:
    return SessionStore(str(Path(tmp) / name / "data" / "history.sqlite3"))


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-integrity-") as tmp:
        # 初始化失败必须 fail-closed，不能“看起来可用但没有 writer”。
        original_stale = SessionStore._mark_stale_sessions
        try:
            def broken_stale(self):
                raise RuntimeError("stale sweep failed")

            SessionStore._mark_stale_sessions = broken_stale
            broken = SessionStore(str(Path(tmp) / "broken" / "data" / "history.sqlite3"))
        finally:
            SessionStore._mark_stale_sessions = original_stale
        check(not broken.available, "初始化失败标记不可用")
        check(not broken.start_session("bad", 1, "坏库"), "初始化失败拒绝写入")
        check(not broken.flush(0.2), "初始化失败 flush 不成功")

        store = temp_store(tmp, "store")
        check(store.available, "正常库可用", store.error)
        now = time.time()
        store.start_session("frozen", 1001, "冻结前", started_at=now - 10)
        store.record_message("frozen", "danmaku", now, 101, {})
        store.finish_session("frozen", ended_at=now, reason="manual_disconnect")
        check(store.flush(3.0), "正常场次写入完成")
        before = store.get_session("frozen").get("session") or {}
        store.bump_session("frozen", "real", "received", 5)
        store.record_message("frozen", "gift", now, 102, {"total_coin": 1000, "coin_type": "gold"})
        store.update_session_meta("frozen", 1001, "冻结后")
        check(store.flush(3.0), "结束后的迟到写入可被安全忽略")
        after = store.get_session("frozen").get("session") or {}
        check(after.get("real_received") == before.get("real_received") == 1, "结束后计数不再改变", after.get("real_received"))
        check(after.get("room_title") == "冻结前", "结束后标题不再改变", after.get("room_title"))
        check(after.get("types") == {"danmaku": 1}, "结束后类型不再改变", after.get("types"))

        store.start_session("dup", 1002, "重复场次", started_at=now - 5)
        store.bump_session("dup", "real", "received", 2)
        store.start_session("dup", 1002, "重复场次覆盖", started_at=now - 1)
        store.flush(3.0)
        duplicate = store.get_session("dup").get("session") or {}
        check(duplicate.get("real_received") == 2, "重复 start 不清空已有计数", duplicate.get("real_received"))
        check(duplicate.get("room_title") == "重复场次", "重复 start 不覆盖场次标题", duplicate.get("room_title"))

        check(not store.delete_session("active-only-missing").get("ok"), "删除不存在的场次返回失败")
        store.start_session("active", 1003, "进行中", started_at=now)
        store.flush(3.0)
        check(not store.delete_session("active").get("ok"), "存储层拒绝删除进行中场次")
        store.finish_session("active", ended_at=now, reason="manual_disconnect")
        store.flush(3.0)
        check(store.delete_session("active").get("ok"), "存储层允许删除已结束场次")
        store.close()

        stale_path = str(Path(tmp) / "stale" / "data" / "history.sqlite3")
        stale_store = SessionStore(stale_path)
        stale_store.start_session("mock-only", 1004, "模拟崩溃残留", started_at=now)
        stale_store.bump_session("mock-only", "mock", "received", 3)
        stale_store.flush(3.0)
        stale_store.close()
        reopened = SessionStore(stale_path)
        check(reopened.list_sessions().get("total") == 0, "重启 stale sweep 清除纯模拟场次")
        reopened.close()

        failed_store = temp_store(tmp, "failed-batch")
        original_apply = failed_store._apply_op

        def flaky_apply(conn, op, args):
            if op == "bump" and args[0] == "poison":
                raise RuntimeError("poison op")
            return original_apply(conn, op, args)

        failed_store._apply_op = flaky_apply
        failed_store.start_session("good", 1005, "好场次", started_at=now)
        failed_store.bump_session("good", "real", "received", 1)
        failed_store.bump_session("poison", "real", "received", 1)
        check(not failed_store.flush(3.0), "坏操作使 flush 返回失败")
        failed_store.finish_session("good", ended_at=now, reason="manual_disconnect")
        failed_store.flush(3.0)
        good_rows = failed_store.list_sessions().get("sessions") or []
        check(len(good_rows) == 1 and good_rows[0].get("id") == "good", "坏操作不拖回滚同批好场次", good_rows)
        check(failed_store.failed_ops >= 1, "坏操作计入 failed_ops", failed_store.failed_ops)
        failed_store._apply_op = original_apply
        failed_store.close()

        # 播放器/队列层的迟到丢弃也必须计入降级统计。
        service = object.__new__(DanmakuTTSService)
        service._state_lock = threading.RLock()
        service._state = {
            "stats": {"received": 1, "spoken": 0, "dropped": 0},
            "session_stats": {
                "all": {"received": 1, "spoken": 0, "dropped": 0},
                "real": {"received": 1, "spoken": 0, "dropped": 0},
                "mock": {"received": 0, "spoken": 0, "dropped": 0},
            },
            "session_id": "s1",
        }

        class FakeStore:
            @staticmethod
            def bump_session(*args, **kwargs):
                return True

        service.session_store = FakeStore()
        event = {"session_id": "s1", "meta": {}, "spoken": True}
        service._handle_player_event("dropped", {"entry": {"event": event}, "reason": "disconnect"})
        check(service._state["session_stats"]["real"]["dropped"] == 1, "播放器 dropped 计入 dropped")
        check(event.get("spoken") is False and event.get("meta", {}).get("drop_counted"), "播放器 dropped 标记事件")
        service._handle_player_event("dropped", {"entry": {"event": event}, "reason": "disconnect"})
        check(service._state["session_stats"]["real"]["dropped"] == 1, "播放器 dropped 不重复计数")

        uid_service = object.__new__(DanmakuTTSService)
        uid_service._state_lock = threading.RLock()
        uid_service._events_lock = threading.Lock()
        uid_service._state = {
            "connection": "connected",
            "room_id": 1,
            "room_title": "UID 测试",
            "stats": {"received": 0, "spoken": 0, "dropped": 0},
            "session_id": "uid-session",
            "session_stats": {
                "all": {"received": 0, "spoken": 0, "dropped": 0},
                "real": {"received": 0, "spoken": 0, "dropped": 0},
                "mock": {"received": 0, "spoken": 0, "dropped": 0},
            },
            "last_error": None,
        }
        uid_service._events = []
        uid_service._seq = 0

        class UidConfig:
            @staticmethod
            def snapshot():
                return {"read": {}, "filters": {}}

        class UidStore:
            def __init__(self):
                self.messages = []

            def record_message(self, session_id, kind, ts, uid, meta, scope="real"):
                self.messages.append((session_id, kind, uid, scope))
                return True

            @staticmethod
            def bump_session(*args, **kwargs):
                return True

        uid_service.config = UidConfig()
        uid_service.session_store = UidStore()
        uid_event = uid_service._handle_room_message(
            "danmaku",
            {"uid": "viewer-α", "user": "字符串用户", "text": "字符串 UID 测试"},
            speak=False,
        )
        check(uid_event is not None, "字符串 UID 不丢消息")
        check(uid_event.get("uid") == "viewer-α", "字符串 UID 保留在事件中", uid_event.get("uid"))
        check(uid_service.session_store.messages and uid_service.session_store.messages[0][2] == "viewer-α", "字符串 UID 到达存储层")

        service._state["session_open"] = True
        service._state["session_id"] = "current"

        class DeleteStore:
            @staticmethod
            def delete_session(session_id):
                return {"ok": True, "deleted": 1, "session_id": session_id}

        service.session_store = DeleteStore()
        check(not service.delete_history_session("current").get("ok"), "当前进行中场次删除被核心拒绝")
        service._state["session_open"] = False
        check(service.delete_history_session("current").get("ok"), "当前已结束场次允许删除")

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
