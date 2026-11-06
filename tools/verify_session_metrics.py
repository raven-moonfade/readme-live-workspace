#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证场次统计与真实/模拟隔离的核心方法。"""

from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.core import DanmakuTTSService, _empty_session_metrics  # noqa: E402


def check(condition: bool, label: str) -> None:
    print(("PASS  " if condition else "FAIL  ") + label)
    if not condition:
        raise AssertionError(label)


def main() -> int:
    service = object.__new__(DanmakuTTSService)
    service._state_lock = threading.RLock()
    service._state = {
        "connection": "disconnected",
        "room_id": 0,
        "room_title": None,
        "last_error": None,
        "stats": {"received": 0, "spoken": 0, "dropped": 0},
        "session_id": None,
        "session_started_at": None,
        "session_stats": {
            "all": {"received": 0, "spoken": 0, "dropped": 0},
            "real": {"received": 0, "spoken": 0, "dropped": 0},
            "mock": {"received": 0, "spoken": 0, "dropped": 0},
        },
    }

    service._begin_session(1001)
    first = service._state["session_id"]
    check(bool(first), "显式连接创建场次 id")
    check(service._state["session_started_at"] is not None, "场次记录开始时间")
    check(
        service._state["session_stats"]["real"] == _empty_session_metrics(),
        "新场次真实统计归零",
    )

    service._session_message_bump(
        "gift", {"total_coin": 1000, "coin_type": "gold"}, uid="u1"
    )
    gift_snapshot = service._state["session_stats"]["real"]
    check(gift_snapshot["types"]["gift"] == 1, "礼物类型计入 real.types")
    check(gift_snapshot["gift_cny"] == 1.0, "金瓜子按 1000:1 计入 real.gift_cny")
    check(gift_snapshot["unique_users"] == 1, "UID 去重计入 real.unique_users")

    service._stats_bump("received")
    service._stats_bump("received", mock=True)
    service._stats_bump("spoken", mock=True)
    service._drop_event({"meta": {"mock": True}}, "mock_display_only")
    service._drop_event({"meta": {}}, "dedup")

    session = service._state["session_stats"]
    check(session["real"]["received"] == 1, "真实消息计入 real")
    check(session["mock"]["received"] == 1, "模拟消息计入 mock")
    check(session["real"]["dropped"] == 1, "真实丢弃计入 real")
    check(session["real"]["filtered"] == 1, "规则过滤单独计入 real.filtered")
    check(session["mock"]["dropped"] == 1, "模拟丢弃计入 mock")
    check(session["mock"]["spoken"] == 1, "模拟朗读计入 mock")
    check(session["real"]["spoken"] == 0, "模拟朗读不污染 real")
    service._handle_player_event(
        "started",
        {"entry": {"event": {"session_id": first, "meta": {}}}},
    )
    check(service._state["session_stats"]["real"]["spoken"] == 1, "播放开始后才增加真实朗读")
    started_event = {"session_id": first, "meta": {}}
    service._emit_event = lambda *_args, **_kwargs: {}
    service._handle_player_event("started", {"entry": {"event": started_event}})
    spoken_before_error = session["real"]["spoken"]
    dropped_before_error = session["real"]["dropped"]
    service._handle_player_event(
        "error",
        {"entry": {"event": started_event}, "error": "播放中断"},
    )
    check(session["real"]["spoken"] == spoken_before_error,
          "播放开始后的失败不回退开始朗读计数")
    check(session["real"]["dropped"] == dropped_before_error,
          "播放开始后的失败不再重复计入丢弃")
    check(started_event.get("spoken") is True and
          started_event.get("meta", {}).get("post_start_failure") is True,
          "开始后失败保留已开始状态并做标记")
    before_start_event = {"session_id": first, "meta": {}}
    service._handle_player_event(
        "error",
        {"entry": {"event": before_start_event}, "error": "文件不可用"},
    )
    check(session["real"]["dropped"] == dropped_before_error + 1,
          "未开始播放的失败计入丢弃")
    check(session["all"]["received"] == 2, "all 保留总览计数")
    check(service._state["stats"]["received"] == 2, "兼容 stats 保留生命周期口径")

    class FakePlayer:
        @staticmethod
        def status():
            return {"queue_len": 2, "now_playing": {"user": "测试", "text": "测试中"}}

    class FakeConfig:
        @staticmethod
        def project_v1():
            return {"room_id": 1001}

        @staticmethod
        def get(_key, default=None):
            return default

    service._pending_tts = 1
    service._player = FakePlayer()
    service._account = {"logged_in": False, "uname": None, "mid": None}
    service._config = FakeConfig()
    service.config = FakeConfig()
    service._mock_task = None
    service._mock_sent = 7
    service._state.update(
        connection="connected",
        room_id=1001,
        room_title="测试直播间",
    )
    snapshot = service.get_state()
    check(snapshot["session"]["id"] == first, "get_state 返回当前场次 id")
    check(snapshot["session"]["real"]["received"] == 1, "get_state 返回真实场次统计")
    check(snapshot["session"]["real"]["types"]["gift"] == 1, "get_state 返回类型计数")
    check(snapshot["session"]["real"]["gift_cny"] == 1.0, "get_state 返回本机流水分项")
    check(snapshot["session"]["real"]["unique_users"] == 1, "get_state 返回 UID 去重数")
    check(snapshot["session"]["mock"]["received"] == 1, "get_state 返回模拟场次统计")
    check(snapshot["mock"] == {"running": False, "sent": 7},
          "get_state 返回模拟任务状态")
    check(snapshot["queue_len"] == 3, "queue_len 保持待 TTS + 播放器队列")

    service._begin_session(1002)
    second = service._state["session_id"]
    check(second != first, "换房创建新场次 id")
    check(
        service._state["session_stats"]["all"] == _empty_session_metrics(),
        "新场次 all 统计归零",
    )

    class FakeDanmaku:
        async def open(self, room_id):
            return {"ok": True, "room_id": room_id, "room_title": "连接测试", "room_live": True}

    class FakeConfig:
        def update(self, _patch):
            return None

    class FakeStore:
        def __init__(self):
            self.started = []
            self.finished = []
            self.meta = []

        def start_session(self, session_id, room_id, room_title="", **_kwargs):
            self.started.append((session_id, room_id, room_title))

        def finish_session(self, session_id, **_kwargs):
            self.finished.append(session_id)

        def update_session_meta(self, session_id, room_id, room_title, room_key=None):
            self.meta.append((session_id, room_id, room_title))

    reconnect_service = object.__new__(DanmakuTTSService)
    reconnect_service._state_lock = threading.RLock()
    reconnect_service._state = {
        "session_id": "existing-session",
        "session_started_at": 1.0,
        "session_stats": {
            "all": {"received": 0, "spoken": 0, "dropped": 0},
            "real": {"received": 0, "spoken": 0, "dropped": 0},
            "mock": {"received": 0, "spoken": 0, "dropped": 0},
        },
        "room_id": 777,
        "connection": "connected",
    }
    reconnect_service._session_epoch = 0
    reconnect_service._danmaku = FakeDanmaku()
    reconnect_service.config = FakeConfig()
    reconnect_service.session_store = FakeStore()
    reconnect_service._set_connection = lambda *_args, **_kwargs: None
    reconnect_service._emit_event = lambda *_args, **_kwargs: {}
    reconnect_service.get_state = lambda: {"connection": "connected"}

    asyncio.run(reconnect_service._connect_async(777, new_session=False))
    check(not reconnect_service.session_store.started, "登录自动重连不创建新场次")
    check(reconnect_service._state["session_id"] == "existing-session", "登录自动重连保留场次 id")
    asyncio.run(reconnect_service._connect_async(888, new_session=True))
    check(
        "existing-session" in reconnect_service.session_store.finished
        and len(reconnect_service.session_store.started) == 1,
        "主动换房结束旧场次并创建新场次",
    )

    class FailingDanmaku:
        async def open(self, _room_id):
            raise RuntimeError("open failed")

    fail_service = object.__new__(DanmakuTTSService)
    fail_service._state_lock = threading.RLock()
    fail_service._state = {
        "session_id": None,
        "session_started_at": None,
        "session_open": False,
        "session_stats": {
            "all": {"received": 0, "spoken": 0, "dropped": 0},
            "real": {"received": 0, "spoken": 0, "dropped": 0},
            "mock": {"received": 0, "spoken": 0, "dropped": 0},
        },
        "room_id": 0,
        "connection": "disconnected",
    }
    fail_service._session_epoch = 0
    fail_service._danmaku = FailingDanmaku()
    fail_service.session_store = FakeStore()
    fail_service._set_connection = lambda *_args, **_kwargs: None
    fail_service._emit_event = lambda *_args, **_kwargs: {}
    failed_result = asyncio.run(fail_service._connect_async(999, new_session=True))
    failed_session = fail_service.session_store.started[0][0]
    check(failed_result.get("ok") is False, "连接异常返回结构化失败")
    check(failed_session in fail_service.session_store.finished,
          "连接异常结束新建场次")

    class CancelledDanmaku:
        async def open(self, _room_id):
            raise asyncio.CancelledError()

    cancel_service = object.__new__(DanmakuTTSService)
    cancel_service._state_lock = threading.RLock()
    cancel_service._state = {
        "session_id": None,
        "session_started_at": None,
        "session_open": False,
        "session_stats": {
            "all": {"received": 0, "spoken": 0, "dropped": 0},
            "real": {"received": 0, "spoken": 0, "dropped": 0},
            "mock": {"received": 0, "spoken": 0, "dropped": 0},
        },
        "room_id": 0,
        "connection": "disconnected",
    }
    cancel_service._session_epoch = 0
    cancel_service._danmaku = CancelledDanmaku()
    cancel_service.session_store = FakeStore()
    cancel_service._set_connection = lambda *_args, **_kwargs: None
    cancel_service._emit_event = lambda *_args, **_kwargs: {}
    try:
        asyncio.run(cancel_service._connect_async(1000, new_session=True))
    except asyncio.CancelledError:
        pass
    cancelled_session = cancel_service.session_store.started[0][0]
    check(cancelled_session in cancel_service.session_store.finished,
          "连接取消结束新建场次")

    print("\nSUMMARY PASS=29 FAIL=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
