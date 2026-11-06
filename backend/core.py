# -*- coding: utf-8 -*-
"""DanmakuTTSService：幕台后端服务（线程安全的对外门面）。

线程模型
--------
- 调用线程（pywebview / 任意线程）：get_state / poll_events 只读内存快照，立即返回；
  其余方法通过 asyncio.run_coroutine_threadsafe 转交后台事件循环执行。
- 后台事件循环线程：blivedm 连接、edge-tts 合成、朗读队列消费。
- 播放线程：pygame 顺序播放（见 player.py）。

接口契约（已冻结）：get_state / poll_events / connect / disconnect / update_config /
list_voices / preview / replay / shutdown。
浮窗扩展（向后兼容）：get_overlay_config / overlay_items / apply_overlay。
工作台扩展（向后兼容）：get_state 额外返回 session（场次 real/mock 统计）与 mock 状态。
"""

from __future__ import annotations

import asyncio
import collections
import concurrent.futures
import copy
import logging
import logging.handlers
import os
import random
import re
import threading
import time
import traceback
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import account as account_mod
from . import tts as tts_mod
from .config import DEFAULT_LEGACY_OVERLAY, WRITE_FAILED, ConfigStore
from .danmaku import (
    STATE_CONNECTED,
    STATE_CONNECTING,
    STATE_DISCONNECTED,
    STATE_ERROR,
    DanmakuConnection,
)
from .douyin import DouyinConnection
from .history_trend import TREND_GRANULARITIES
from .platforms import money_comparable as platform_money_comparable
from .platforms import normalize_platform, platform_profiles
from .player import AudioPlayer
from .sessions import SessionStore

logger = logging.getLogger("danmaku_tts")

EVENT_BUFFER_SIZE = 1000      # 事件环形缓冲：最多保留最近 1000 条
CACHE_MAX_FILES = 200         # 音频缓存上限（超出删最旧）
SYNTH_TIMEOUT = 60.0          # 单条合成超时（秒）
VOICE_FETCH_TIMEOUT = 45.0    # 拉取音色列表超时（秒）
PREVIEW_MAX_CHARS = 200       # 试听文本上限
OVERLAY_MESSAGE_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter")
LOG_EVENT_LEVEL = logging.WARNING
LOG_EVENT_MAX_CHARS = 400
_LOGGER_NAMES = ("danmaku_tts", "blivedm")
_UNSET = object()
SESSION_MESSAGE_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter")
FILTER_REASONS = frozenset(
    (
        "disabled",
        "gift_min_price",
        "dedup",
        "user_cooldown",
        "global_cooldown",
        "no_text",
        "empty_template",
        "voice_lang_mismatch",
        "mock_display_only",
    )
)


def _empty_session_metrics() -> Dict[str, Any]:
    return {
        "received": 0,
        "spoken": 0,
        "dropped": 0,
        "filtered": 0,
        "types": {kind: 0 for kind in SESSION_MESSAGE_TYPES},
        "unique_users": 0,
        "gift_cny": 0.0,
        "gift_silver": 0,
        "gift_unknown": 0,
        "super_chat_cny": 0.0,
    }
_TEMPLATE_TOKEN_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")
_CJK_CHAR_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]")


def _history_capabilities() -> Dict[str, Any]:
    return {
        "list_sessions": 1,
        "previous_compare": 1,
        "arbitrary_compare": 1,
        "multi_compare": 1,
        "multi_compare_max": 3,
        "trend": 1,
        "trend_granularities": list(TREND_GRANULARITIES),
        "insights": 1,
        "analysis_export": 1,
        "analysis_export_compare_multi": 1,
        "export_manage": 1,
        "export_manage_week": 1,
        "platforms": [
            {
                "key": profile.key,
                "label": profile.label,
                "money_comparable": profile.money_comparable,
                "gift_value_unit": profile.gift_value_unit,
                "supports_super_chat": profile.supports_super_chat,
                "supports_guard": profile.supports_guard,
                "money_note": profile.money_note,
            }
            for profile in platform_profiles()
        ],
    }


_CJK_VOICE_LANGS = ("zh", "ja", "ko")
_STATE_NOTES = {
    STATE_CONNECTED: "已连接直播间",
    STATE_CONNECTING: "正在连接…",
    STATE_DISCONNECTED: "已断开连接",
    STATE_ERROR: "连接失败",
}


def _normalize_uid(value: Any) -> Any:
    """保留 B 站整数 UID，同时允许未来平台使用短字符串 UID。"""
    if value is None or isinstance(value, bool):
        return 0
    text = str(value).strip()
    if not text or text == "0":
        return 0
    try:
        return int(text)
    except (TypeError, ValueError):
        return text[:256]


# --------------------------------------------------------------------- 日志
class _EventLogHandler(logging.Handler):
    """把 WARNING 以上的日志包装成 log 事件（供前端展示）。"""

    def __init__(self, sink: Callable[[str, str, str], None]):
        super().__init__()
        self._sink = sink
        self._active = True

    def emit(self, record: logging.LogRecord) -> None:
        if not self._active:
            return
        try:
            message = record.getMessage()
            if record.exc_info:
                message += "\n" + "".join(traceback.format_exception(*record.exc_info))[-800:]
            if len(message) > LOG_EVENT_MAX_CHARS:
                message = message[:LOG_EVENT_MAX_CHARS] + "…"
            self._sink(record.levelname, record.name, message)
        except Exception:  # noqa: BLE001
            pass

    def deactivate(self) -> None:
        self._active = False


def _setup_logging(logs_dir: str, event_sink: Callable[[str, str, str], None]) -> List[logging.Handler]:
    """安装 RotatingFileHandler（1MB×3）+ 事件处理器，返回需要关闭的处理器列表。"""
    for name in _LOGGER_NAMES:
        target = logging.getLogger(name)
        for handler in list(target.handlers):
            if getattr(handler, "_danmaku_tts_handler", False):
                target.removeHandler(handler)
                try:
                    handler.close()
                except Exception:  # noqa: BLE001
                    pass

    app_logger = logging.getLogger("danmaku_tts")
    app_logger.setLevel(logging.DEBUG)
    app_logger.propagate = False
    handlers: List[logging.Handler] = []
    try:
        file_handler = logging.handlers.RotatingFileHandler(
            os.path.join(logs_dir, "app.log"),
            maxBytes=1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
        handlers.append(file_handler)
    except Exception as e:  # noqa: BLE001
        print("[danmaku-tts] 日志文件初始化失败：%s" % e)

    event_handler = _EventLogHandler(event_sink)
    event_handler.setLevel(LOG_EVENT_LEVEL)
    handlers.append(event_handler)

    for name in _LOGGER_NAMES:
        target = logging.getLogger(name)
        if name != "danmaku_tts":
            target.setLevel(logging.INFO)
        for handler in handlers:
            handler._danmaku_tts_handler = True  # type: ignore[attr-defined]
            target.addHandler(handler)
    return handlers


# ------------------------------------------------------------------- 工具函数
def render_template(template: str, values: Dict[str, Any], include_user: bool = True) -> str:
    """渲染朗读模板：{name} 占位符安全替换（未知占位符当空串）。"""
    tpl = template or ""
    if not include_user:
        # 去掉 {user} 及其后紧跟的称呼语，例如 "{user}说：{text}" → "{text}"
        tpl = re.sub(r"\{user\}[^{}]{0,4}(?=\{|$)", "", tpl)
        tpl = tpl.replace("{user}", "")

    def _sub(match: "re.Match[str]") -> str:
        value = values.get(match.group(1), "")
        return "" if value is None else str(value)

    return tts_mod.clean_text(_TEMPLATE_TOKEN_RE.sub(_sub, tpl))


def normalize_enter_template(template: str) -> str:
    """把旧版默认入场模板升级为「<名字>进入直播间」。"""
    cleaned = str(template or "").strip()
    if cleaned in ("", "欢迎{user}进入直播间"):
        return "{user}进入直播间"
    return template


def _truncate_overlay_text(value: Any, max_len: int) -> str:
    text = "" if value is None else str(value)
    if len(text) <= max_len:
        return text
    return text[:max_len] + "…"


class FilterEngine:
    """朗读前过滤：黑名单（正则/子串）→ 去重 → 用户冷却 → 全局冷却。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._dedup: "collections.OrderedDict[str, float]" = collections.OrderedDict()
        self._user_last: Dict[str, float] = {}
        self._global_last = 0.0
        self._blacklist_src: Tuple[str, ...] = ()
        self._blacklist_patterns: List[Optional[re.Pattern]] = []

    def _compile(self, blacklist: List[str]) -> List[Optional[re.Pattern]]:
        src = tuple(blacklist)
        if src != self._blacklist_src:
            patterns: List[Optional[re.Pattern]] = []
            for item in src:
                try:
                    patterns.append(re.compile(item, re.IGNORECASE))
                except re.error:
                    patterns.append(None)
            self._blacklist_src = src
            self._blacklist_patterns = patterns
        return self._blacklist_patterns

    @staticmethod
    def _user_key(user: str, uid: Any) -> str:
        uid_text = str(uid).strip() if uid not in (None, "", 0, "0") else ""
        # 匿名连接下 uid 为空，只能退化成用户名（会被打码）作为标识。
        return uid_text or (user or "")

    def check(self, text: str, user: str, uid: Any, cfg: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        """返回 (是否允许朗读, 被过滤的原因)。"""
        now = time.monotonic()
        with self._lock:
            blacklist = [str(x) for x in (cfg.get("blacklist") or [])]
            if blacklist:
                patterns = self._compile(blacklist)
                for item, pattern in zip(blacklist, patterns):
                    if pattern is not None:
                        if pattern.search(text):
                            return False, "blacklist"
                    elif item and item in text:
                        return False, "blacklist"

            try:
                dedup_seconds = float(cfg.get("dedup_seconds") or 0)
            except (TypeError, ValueError):
                dedup_seconds = 0.0
            if dedup_seconds > 0 and text:
                last = self._dedup.get(text)
                if last is not None and now - last < dedup_seconds:
                    return False, "dedup"

            try:
                user_cooldown = float(cfg.get("user_cooldown") or 0)
            except (TypeError, ValueError):
                user_cooldown = 0.0
            user_key = self._user_key(user, uid)
            if user_cooldown > 0 and user_key:
                last = self._user_last.get(user_key)
                if last is not None and now - last < user_cooldown:
                    return False, "user_cooldown"

            try:
                global_cooldown = float(cfg.get("global_cooldown") or 0)
            except (TypeError, ValueError):
                global_cooldown = 0.0
            if global_cooldown > 0 and self._global_last and now - self._global_last < global_cooldown:
                return False, "global_cooldown"

            # 通过过滤：登记时间戳
            if dedup_seconds > 0 and text:
                self._dedup[text] = now
                self._dedup.move_to_end(text)
                while len(self._dedup) > 500:
                    self._dedup.popitem(last=False)
            if user_cooldown > 0 and user_key:
                self._user_last[user_key] = now
                if len(self._user_last) > 500:
                    for key in list(self._user_last)[:200]:
                        self._user_last.pop(key, None)
            self._global_last = now
            return True, None


# ------------------------------------------------------------------- 服务主体
class DanmakuTTSService:
    """弹幕 → TTS 朗读服务（所有公开方法线程安全，接口契约已冻结）。"""

    def __init__(self, base_dir: str):
        self.base_dir = os.path.abspath(base_dir or ".")
        self.cache_dir = os.path.join(self.base_dir, "cache")
        self.logs_dir = os.path.join(self.base_dir, "logs")
        os.makedirs(self.cache_dir, exist_ok=True)
        os.makedirs(self.logs_dir, exist_ok=True)

        # ---- 事件缓冲 / 状态快照（先建，日志处理器会引用） ----
        self._events: "collections.deque[Dict[str, Any]]" = collections.deque(maxlen=EVENT_BUFFER_SIZE)
        self._events_lock = threading.Lock()
        self._seq = 0
        self._state_lock = threading.RLock()
        self._session_users = {"all": set(), "real": set(), "mock": set()}
        self._state: Dict[str, Any] = {
            "connection": STATE_DISCONNECTED,
            "platform": "bilibili",
            "room_key": "",
            "room_id": 0,
            "room_title": None,
            "stats": {"received": 0, "spoken": 0, "dropped": 0, "filtered": 0},
            "session_id": None,
            "session_started_at": None,
            "session_open": False,
            "session_minutes": {},
            "session_last_event_at": None,
            "session_stats": {
                "all": _empty_session_metrics(),
                "real": _empty_session_metrics(),
                "mock": _empty_session_metrics(),
            },
            "last_error": None,
        }
        self._room_live: Optional[bool] = None
        self._pending_tts = 0
        self._session_epoch = 0
        self._shutting_down = False
        self._shutdown_done = False

        self._log_handlers = _setup_logging(self.logs_dir, self._emit_log_record)
        logger.info("DanmakuTTSService 初始化，base_dir=%s", self.base_dir)

        # ---- 配置 / 过滤器 / 播放器 ----
        self.config = ConfigStore(self.base_dir)
        self.session_store = SessionStore(
            os.path.join(self.base_dir, "data", "history.sqlite3")
        )
        # D-101：把持久化的房间号带入状态快照，重启后前端可回填
        # （连接/断开时 room_id 的既有行为与契约字段语义不变）
        try:
            remembered_room = int(self.config.get("room_id", default=0) or 0)
        except (TypeError, ValueError):
            remembered_room = 0
        remembered_platform = normalize_platform(
            self.config.get("platform", default="bilibili") or "bilibili"
        )
        if remembered_platform not in ("bilibili", "douyin"):
            remembered_platform = "bilibili"
        if remembered_room > 0:
            with self._state_lock:
                self._state["room_id"] = remembered_room
                self._state["platform"] = remembered_platform
                self._state["room_key"] = str(remembered_room)
        self._filters = FilterEngine()
        self._voices: Optional[List[Dict[str, Any]]] = None
        self._voice_cache_path = os.path.join(self.logs_dir, "voices.json")

        self._player = AudioPlayer(on_event=self._handle_player_event)
        self._player.start()

        try:
            douyin_cookie = self.config.get_douyin_cookie()
        except Exception:  # noqa: BLE001
            douyin_cookie = ""
        self._douyin_cookie = douyin_cookie
        self._douyin_account: Dict[str, Any] = {
            "logged_in": bool(douyin_cookie),
            "uname": "抖音账号" if douyin_cookie else None,
            "uid": None,
        }

        # ---- 后台事件循环线程 ----
        self._loop = asyncio.new_event_loop()
        self._loop_ready = threading.Event()
        self._loop_thread = threading.Thread(target=self._loop_main, name="danmaku-tts-loop", daemon=True)
        self._loop_thread.start()
        self._loop_ready.wait(5.0)

        self._tts_queue: "collections.deque[Dict[str, Any]]" = collections.deque()
        self._tts_wakeup = asyncio.Event()
        self._danmaku = DanmakuConnection(
            on_message=self._handle_room_message,
            on_state=self._handle_connection_state,
            on_error=self._handle_connection_error,
            sessdata=self.config.get("sessdata", default="") or "",
        )
        self._douyin = DouyinConnection(
            on_message=self._handle_room_message,
            on_state=self._handle_connection_state,
            on_error=self._handle_connection_error,
            cookie=douyin_cookie,
        )
        self._source_platform = "bilibili"
        self._source_room_key = ""
        self._tts_worker_future = asyncio.run_coroutine_threadsafe(self._tts_worker(), self._loop)
        logger.info("后台事件循环已启动")

        # ---- 账号登录态（有凭证时后台校验并取昵称） ----
        self._account: Dict[str, Any] = {"logged_in": False, "uname": None, "mid": None}
        # ---- 调试：自动模拟发送 ----
        self._mock_task: Optional["concurrent.futures.Future"] = None
        self._mock_sent = 0
        if str(self.config.get("sessdata", default="") or "").strip():
            self._account["logged_in"] = True
            try:
                asyncio.run_coroutine_threadsafe(self._refresh_account(), self._loop)
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------ 线程基础设施
    def _loop_main(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop_ready.set()
        try:
            self._loop.run_forever()
        except Exception:  # noqa: BLE001
            logger.exception("后台事件循环异常退出")
        finally:
            try:
                for task in asyncio.all_tasks(self._loop):
                    task.cancel()
            except Exception:  # noqa: BLE001
                pass
            try:
                self._loop.close()
            except Exception:  # noqa: BLE001
                pass

    def _call(self, coro: Any, timeout: float) -> Any:
        """把协程交给后台事件循环执行并等待结果（任意线程可调用）。"""
        if self._shutdown_done or self._loop.is_closed():
            try:
                coro.close()  # 避免 "coroutine was never awaited" 警告
            except Exception:  # noqa: BLE001
                pass
            raise RuntimeError("服务已关闭")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise TimeoutError("操作超时")

    # ------------------------------------------------------------ 事件 / 状态
    def _emit_event(
        self,
        event_type: str,
        *,
        user: str = "",
        uid: Any = 0,
        text: str = "",
        spoken: Optional[bool] = None,
        meta: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        with self._events_lock:
            self._seq += 1
            event: Dict[str, Any] = {
                "seq": self._seq,
                "type": event_type,
                "id": str(uuid.uuid4()),
                "ts": time.time(),
                "user": user,
                "uid": _normalize_uid(uid),
                "text": text,
                "spoken": spoken,
                "meta": dict(meta or {}),
                "error": error,
            }
            if extra:
                event.update(extra)
            self._events.append(event)
            return event

    def _emit_log_record(self, level: str, name: str, message: str) -> None:
        try:
            self._emit_event("log", text=message, meta={"level": level, "logger": name})
        except Exception:  # noqa: BLE001
            pass

    def _begin_session(self, room_id: int, platform: str = "bilibili", room_key: str = "") -> str:
        """显式连接创建新场次；自动重连不调用此方法。"""
        now = time.time()
        old_session = None
        platform = normalize_platform(platform) or "bilibili"
        if platform not in ("bilibili", "douyin"):
            platform = "bilibili"
        with self._state_lock:
            old_session = self._state.get("session_id")
            self._state["session_id"] = uuid.uuid4().hex
            self._state["session_started_at"] = now
            self._state["session_open"] = True
            self._state["session_minutes"] = {}
            self._state["session_last_event_at"] = None
            self._state["platform"] = platform
            self._state["room_key"] = str(room_key or room_id or "")
            self._state["session_stats"] = {
                "all": _empty_session_metrics(),
                "real": _empty_session_metrics(),
                "mock": _empty_session_metrics(),
            }
            users = getattr(self, "_session_users", None)
            if users is None:
                users = {"all": set(), "real": set(), "mock": set()}
                self._session_users = users
            for user_set in users.values():
                user_set.clear()
            session_id = str(self._state["session_id"])
        store = getattr(self, "session_store", None)
        if store is not None:
            if old_session:
                store.finish_session(str(old_session), ended_at=now, reason="replaced")
            store.start_session(
                session_id,
                room_id,
                "",
                started_at=now,
                platform=platform,
                room_key=str(room_key or room_id or ""),
            )
        logger.info(
            "新场次开始：platform=%s room_id=%s room_key=%s session=%s",
            platform,
            room_id,
            room_key,
            session_id,
        )
        return session_id

    def _current_session_id(self) -> Optional[str]:
        with self._state_lock:
            value = self._state.get("session_id")
        return str(value) if value else None

    def _finish_current_session(self, reason: str) -> Optional[str]:
        session_id = self._current_session_id()
        with self._state_lock:
            self._state["session_open"] = False
        store = getattr(self, "session_store", None)
        if session_id and store is not None:
            store.finish_session(session_id, ended_at=time.time(), reason=reason)
        return session_id

    def _stats_bump(
        self,
        key: str,
        count: int = 1,
        *,
        mock: bool = False,
        session_id: Optional[str] = None,
    ) -> None:
        target_session = None
        with self._state_lock:
            stats = self._state["stats"]
            stats[key] = int(stats.get(key, 0)) + int(count)
            current_session = self._state.get("session_id")
            target_session = session_id or current_session
            if not session_id or session_id == current_session:
                session_stats = self._state.get("session_stats") or {}
                for scope in ("all", "mock" if mock else "real"):
                    bucket = session_stats.setdefault(
                        scope,
                        _empty_session_metrics(),
                    )
                    bucket[key] = int(bucket.get(key, 0)) + int(count)
        store = getattr(self, "session_store", None)
        # 真实 received 由 record_message 在同一事务里递增，避免类型/分钟已写入
        # 但 received 丢失；mock 消息不落历史，仍走普通计数。
        if target_session and store is not None and (mock or key != "received"):
            store.bump_session(
                str(target_session),
                "mock" if mock else "real",
                key,
                count,
            )

    def _session_message_bump(
        self,
        kind: str,
        meta: Dict[str, Any],
        *,
        mock: bool = False,
        uid: Any = None,
    ) -> None:
        """把类型、去重用户与金额写入当前场次的内存快照。"""
        if kind not in SESSION_MESSAGE_TYPES:
            return
        scope = "mock" if mock else "real"
        active_platform = str(getattr(self, "_source_platform", "") or "bilibili")
        uid_text = str(uid).strip() if uid not in (None, "", 0, "0") else ""
        with self._state_lock:
            session_stats = self._state.setdefault("session_stats", {})
            users = getattr(self, "_session_users", None)
            if users is None:
                users = {"all": set(), "real": set(), "mock": set()}
                self._session_users = users
            for name in ("all", scope):
                bucket = session_stats.setdefault(name, _empty_session_metrics())
                type_counts = bucket.setdefault("types", {})
                for type_key in SESSION_MESSAGE_TYPES:
                    type_counts.setdefault(type_key, 0)
                type_counts[kind] = int(type_counts.get(kind, 0)) + 1
                user_set = users.setdefault(name, set())
                if uid_text and uid_text not in user_set:
                    user_set.add(uid_text)
                    bucket["unique_users"] = int(bucket.get("unique_users") or 0) + 1
                if kind == "gift":
                    if mock:
                        try:
                            total = float(meta.get("total_coin") or 0)
                            if total <= 0:
                                total = float(meta.get("price") or 0) * max(1, int(meta.get("num") or 1))
                        except (TypeError, ValueError):
                            total = 0.0
                        values = {"cny": total, "silver": 0, "unknown": 0}
                    elif platform_money_comparable(active_platform):
                        values = SessionStore._gift_values(meta)
                    else:
                        values = {"cny": 0, "silver": 0, "unknown": 0}
                    bucket["gift_cny"] = round(
                        float(bucket.get("gift_cny") or 0) + float(values["cny"]), 2
                    )
                    bucket["gift_silver"] = int(bucket.get("gift_silver") or 0) + int(values["silver"])
                    bucket["gift_unknown"] = int(bucket.get("gift_unknown") or 0) + int(values["unknown"])
                elif kind == "super_chat":
                    try:
                        amount = float(meta.get("price") or 0)
                    except (TypeError, ValueError):
                        amount = 0.0
                    if amount > 0 and (mock or platform_money_comparable(active_platform)):
                        bucket["super_chat_cny"] = round(
                            float(bucket.get("super_chat_cny") or 0) + amount, 2
                        )

    # -------------------------------------------------------- 会话代数（D-104）
    def _current_epoch(self) -> int:
        with self._state_lock:
            return self._session_epoch

    def _bump_session_epoch(self) -> int:
        """使当前会话的在途朗读条目失效（断开 / 换房 / 关闭时调用）。"""
        with self._state_lock:
            self._session_epoch += 1
            return self._session_epoch

    def _discard_audio(self, path: str) -> None:
        """删除不发声的合成结果，避免缓存里留下播不出来的孤儿文件。"""
        try:
            if path and os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass

    def _discard_inflight(self, item: Dict[str, Any], reason: str) -> None:
        """会话已失效：在途条目不再进入播放，事件标记 spoken=False。"""
        event = item.get("event")
        if isinstance(event, dict):
            self._mark_post_drop(event, reason)
        logger.info(
            "会话已失效（断开/换房/关闭），丢弃在途朗读条目 seq=%s，不进入播放",
            (event or {}).get("seq"),
        )

    def _set_connection(
        self,
        state: str,
        *,
        room_id: Optional[int] = None,
        platform: Optional[str] = None,
        room_key: Any = _UNSET,
        room_title: Any = _UNSET,
        room_live: Any = _UNSET,
        last_error: Any = _UNSET,
        note: str = "",
    ) -> None:
        with self._state_lock:
            self._state["connection"] = state
            if room_id is not None:
                self._state["room_id"] = int(room_id)
            if platform is not None:
                value = normalize_platform(platform)
                if value in ("bilibili", "douyin"):
                    self._state["platform"] = value
            if room_key is not _UNSET:
                self._state["room_key"] = str(room_key or "")
            if room_title is not _UNSET:
                self._state["room_title"] = room_title
            if last_error is not _UNSET:
                self._state["last_error"] = last_error
            room_id_now = self._state["room_id"]
            platform_now = self._state["platform"]
            room_key_now = self._state["room_key"]
            title_now = self._state["room_title"]
            session_id = self._state.get("session_id")
        if room_live is not _UNSET:
            self._room_live = room_live
        if session_id and room_title is not _UNSET:
            store = getattr(self, "session_store", None)
            if store is not None:
                store.update_session_meta(
                    str(session_id),
                    int(room_id_now or 0),
                    str(title_now or ""),
                    str(room_key_now or ""),
                )
        self._emit_event(
            "status",
            text=note or _STATE_NOTES.get(state, state),
            meta={"room_id": room_id_now, "platform": platform_now, "room_key": room_key_now},
            extra={
                "connection": state,
                "platform": platform_now,
                "room_key": room_key_now,
                "room_title": title_now,
                "room_live": self._room_live,
            },
        )

    # ---------------------------------------------------------- 连接层回调
    def _handle_connection_state(
        self, state: str, room_id: int, room_title: Optional[str], room_live: Optional[bool]
    ) -> None:
        last_error: Any = _UNSET
        if state == STATE_CONNECTED:
            last_error = None
        self._set_connection(
            state,
            room_id=room_id,
            platform=getattr(self, "_source_platform", "bilibili"),
            room_key=getattr(self, "_source_room_key", "") or str(room_id),
            room_title=room_title,
            room_live=room_live,
            last_error=last_error,
            note=_STATE_NOTES.get(state, state),
        )
        if state == STATE_CONNECTED:
            logger.info("room=%s 已连接（%s，live=%s）", room_id, room_title, room_live)
            if getattr(self, "_source_platform", "bilibili") == "bilibili":
                self._notify_login_state()
            else:
                self._emit_event(
                    "log",
                    text="抖音公开弹幕连接已建立：当前读取公开消息，抖音账号登录与平台专属礼物结算尚未接入。",
                    meta={"stage": "connect", "platform": "douyin"},
                )

    def _notify_login_state(self) -> None:
        """连接成功后提示登录态：匿名连接时用户名会被打码（如 月***）。"""
        try:
            sessdata = str(self.config.get("sessdata", default="") or "").strip()
        except Exception:
            sessdata = ""
        try:
            uid = int(self._danmaku.uid or 0)
        except Exception:
            uid = 0
        if not sessdata:
            self._emit_event(
                "log",
                text="匿名连接：弹幕用户名会打码（如 月***）。点右上角「登录」扫码后重连即可显示完整用户名。",
                meta={"stage": "connect"},
            )
        elif uid > 0:
            uname = (self._account or {}).get("uname")
            self._emit_event(
                "log",
                text="已登录%s：用户名不再打码。" % (("（%s）" % uname) if uname else ("（uid=%d）" % uid)),
                meta={"stage": "connect"},
            )
        else:
            self._emit_event(
                "log",
                text="登录凭证已失效：用户名仍会打码，请点右上角「登录」重新扫码。",
                meta={"stage": "connect"},
            )

    # ------------------------------------------------------------ 账号扫码登录
    def login_qr(self) -> Dict[str, Any]:
        """获取扫码登录二维码（PNG data URL）。"""
        try:
            return self._call(account_mod.qr_generate(), 20.0)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "二维码获取失败：%s" % e}

    def login_poll(self, qrcode_key: str) -> Dict[str, Any]:
        """轮询扫码状态；成功时保存凭证并刷新账号信息。"""
        try:
            result = self._call(account_mod.qr_poll(str(qrcode_key or "")), 20.0)
        except Exception as e:  # noqa: BLE001
            return {"status": "error", "error": str(e)}
        if isinstance(result, dict) and result.get("status") == "success":
            applied = self._apply_login(str(result.get("sessdata") or ""))
            # 凭证只保留在服务端，不回传给前端/页面
            result = {k: v for k, v in result.items() if k != "sessdata"}
            result["persisted"] = bool(applied.get("persisted"))
            if not applied.get("persisted"):
                result["warning"] = "登录态仅本次运行有效，配置未能写入磁盘"
        return result

    def _apply_login(self, sessdata: str) -> Dict[str, Any]:
        if not sessdata:
            return {"ok": False, "persisted": False, "error": "登录凭证为空"}
        _data, rejected = self.config.update({"sessdata": sessdata})
        persisted = WRITE_FAILED not in rejected
        try:
            self._danmaku.set_sessdata(sessdata)
        except Exception:  # noqa: BLE001
            pass
        with self._state_lock:
            self._account = {"logged_in": True, "uname": None, "mid": None}

        async def _after_login() -> None:
            await self._refresh_account(sessdata_override=sessdata)
            uname = (self._account or {}).get("uname") or ""
            self._emit_event(
                "log",
                text="登录成功%s：弹幕用户名不再打码%s。" % (
                    (("：" + str(uname)) if uname else ""),
                    ("（仅本次运行）" if not persisted else ""),
                ),
                meta={"stage": "login", "persisted": persisted},
            )
            # 正在连接的会话仍是匿名身份：自动重连一次，让登录态立即生效
            try:
                with self._state_lock:
                    conn = str(self._state["connection"])
                    rid = int(self._state["room_id"] or 0)
                if rid > 0 and conn in (STATE_CONNECTED, STATE_CONNECTING):
                    self._emit_event("log", text="正在自动重连以应用登录态…", meta={"stage": "login"})
                    if getattr(self, "_source_platform", "bilibili") == "bilibili":
                        await self._connect_async(
                            rid,
                            new_session=False,
                            platform="bilibili",
                            room_key=str(rid),
                            public_room_id=rid,
                        )
            except Exception:  # noqa: BLE001
                logger.exception("登录后自动重连失败")

        try:
            asyncio.run_coroutine_threadsafe(_after_login(), self._loop)
        except Exception:  # noqa: BLE001
            logger.exception("调度登录后刷新失败")
        return {"ok": True, "persisted": persisted, "rejected": rejected}

    def logout(self) -> Dict[str, Any]:
        """清除登录凭证（恢复匿名连接）。"""
        _data, rejected = self.config.update({"sessdata": ""})
        persisted = WRITE_FAILED not in rejected
        try:
            self._danmaku.set_sessdata("")
        except Exception:  # noqa: BLE001
            pass
        with self._state_lock:
            self._account = {"logged_in": False, "uname": None, "mid": None}
        self._emit_event(
            "log",
            text=(
                "已退出登录：弹幕用户名将再次打码。"
                if persisted
                else "已清除本次登录态：配置未能写入磁盘，重启后可能恢复登录。"
            ),
            meta={"stage": "login", "persisted": persisted},
        )
        self._reconnect_active_bilibili()
        return {
            "ok": True,
            "persisted": persisted,
            "rejected": rejected,
            "account": self.get_account(),
        }

    def get_account(self) -> Dict[str, Any]:
        with self._state_lock:
            return dict(self._account)

    def get_douyin_account(self) -> Dict[str, Any]:
        with self._state_lock:
            return dict(getattr(self, "_douyin_account", {"logged_in": False, "uname": None, "uid": None}))

    def apply_douyin_login(self, cookie: str, uname: Optional[str] = None, uid: Any = None) -> Dict[str, Any]:
        """保存抖音登录 Cookie，并在当前抖音连接上立即生效。"""
        cookie = str(cookie or "").strip()
        if not cookie:
            return {"ok": False, "error": "抖音登录 Cookie 为空"}
        try:
            saved = bool(self.config.set_douyin_cookie(cookie))
        except Exception as exc:  # noqa: BLE001
            logger.warning("保存抖音登录 Cookie 失败：%s", exc)
            saved = False
        self._douyin_cookie = cookie
        try:
            self._douyin.set_cookie(cookie)
        except Exception:  # noqa: BLE001
            pass
        with self._state_lock:
            self._douyin_account = {
                "logged_in": True,
                "uname": str(uname or "抖音账号"),
                "uid": _normalize_uid(uid),
            }
        self._emit_event(
            "log",
            text="抖音账号登录成功%s。" % ("（仅本次运行）" if not saved else ""),
            meta={"stage": "login", "platform": "douyin", "persisted": saved},
        )
        self._reconnect_active_douyin()
        return {"ok": True, "persisted": saved, "account": self.get_douyin_account()}

    def logout_douyin(self) -> Dict[str, Any]:
        """清除抖音登录 Cookie，并恢复匿名连接。"""
        saved = True
        try:
            saved = bool(self.config.set_douyin_cookie(""))
        except Exception as exc:  # noqa: BLE001
            logger.warning("清除抖音登录 Cookie 失败：%s", exc)
            saved = False
        self._douyin_cookie = ""
        try:
            self._douyin.set_cookie("")
        except Exception:  # noqa: BLE001
            pass
        with self._state_lock:
            self._douyin_account = {"logged_in": False, "uname": None, "uid": None}
        self._emit_event(
            "log",
            text="已退出抖音账号：后续连接恢复匿名弹幕。" if saved else "已清除本次抖音登录态；配置只读，未能写入磁盘。",
            meta={"stage": "login", "platform": "douyin", "persisted": saved},
        )
        self._reconnect_active_douyin()
        return {"ok": True, "persisted": saved, "account": self.get_douyin_account()}

    def _reconnect_active_douyin(self) -> None:
        with self._state_lock:
            platform = str(self._state.get("platform") or "")
            connection = str(self._state.get("connection") or "")
            room_key = str(self._state.get("room_key") or "")
            room_id = int(self._state.get("room_id") or 0)
        if platform != "douyin" or connection not in (STATE_CONNECTED, STATE_CONNECTING) or not room_key:
            return

        async def _reconnect() -> None:
            try:
                await self._connect_async(
                    room_key,
                    new_session=False,
                    platform="douyin",
                    room_key=room_key,
                    public_room_id=room_id,
                )
            except Exception:  # noqa: BLE001
                logger.exception("抖音登录后重连失败")

        try:
            asyncio.run_coroutine_threadsafe(_reconnect(), self._loop)
        except Exception:  # noqa: BLE001
            logger.debug("调度抖音登录后重连失败", exc_info=True)

    def _reconnect_active_bilibili(self) -> None:
        with self._state_lock:
            platform = str(self._state.get("platform") or "")
            connection = str(self._state.get("connection") or "")
            room_id = int(self._state.get("room_id") or 0)
            room_key = str(self._state.get("room_key") or str(room_id or ""))
        if platform != "bilibili" or connection not in (STATE_CONNECTED, STATE_CONNECTING) or room_id <= 0:
            return

        async def _reconnect() -> None:
            try:
                await self._connect_async(
                    room_id,
                    new_session=False,
                    platform="bilibili",
                    room_key=room_key or str(room_id),
                    public_room_id=room_id,
                )
            except Exception:  # noqa: BLE001
                logger.exception("B 站登录态变更后重连失败")

        try:
            asyncio.run_coroutine_threadsafe(_reconnect(), self._loop)
        except Exception:  # noqa: BLE001
            logger.debug("调度 B 站登录态变更后重连失败", exc_info=True)

    async def _refresh_account(self, sessdata_override: Optional[str] = None) -> None:
        sessdata = (
            str(sessdata_override)
            if sessdata_override is not None
            else str(self.config.get("sessdata", default="") or "")
        ).strip()
        if not sessdata:
            with self._state_lock:
                self._account = {"logged_in": False, "uname": None, "mid": None}
            return
        prof = await account_mod.fetch_profile(sessdata)
        if prof.get("ok"):
            with self._state_lock:
                self._account = {"logged_in": True, "uname": prof.get("uname"), "mid": prof.get("mid")}
        else:
            with self._state_lock:
                self._account = {"logged_in": False, "uname": None, "mid": None}
            logger.warning("登录凭证无效或已过期：%s", prof.get("error"))

    def _handle_connection_error(self, message: str, meta: Dict[str, Any]) -> None:
        logger.warning("连接错误：%s %s", message, meta or "")
        with self._state_lock:
            self._state["last_error"] = message
        self._emit_event("error", text=message, error=message, meta=dict(meta or {}))

    # ------------------------------------------------------------ 弹幕流水线
    def _handle_room_message(self, kind: str, payload: Dict[str, Any], speak: bool = True) -> Optional[Dict[str, Any]]:
        """收到一条房间消息（事件循环线程内执行）：过滤 → 渲染 → 入朗读队列。"""
        try:
            user = str(payload.get("user") or "")
            uid = _normalize_uid(payload.get("uid"))
            meta = dict(payload.get("meta") or {})
            source_platform = str(getattr(self, "_source_platform", "bilibili") or "bilibili")
            declared_platform = normalize_platform(meta.get("platform") or source_platform)
            if declared_platform and declared_platform != source_platform:
                logger.debug("忽略非当前平台消息：%s != %s", declared_platform, source_platform)
                return None
            meta.setdefault("platform", source_platform)
            is_mock = bool(meta.get("mock"))
            session_id = self._current_session_id()
            self._stats_bump("received", mock=is_mock, session_id=session_id)
            self._session_message_bump(kind, meta, mock=is_mock, uid=uid)
            cfg = self.config.snapshot()
            read_cfg = cfg.get("read") or {}
            filters = cfg.get("filters") or {}

            text = tts_mod.clean_text(payload.get("text") or "")
            text = tts_mod.truncate(text, filters.get("max_len", 80))

            event = self._emit_event(
                kind,
                user=user,
                uid=uid,
                text=text,
                meta=meta,
                extra={
                    "session_id": session_id,
                    "source": "mock" if is_mock else "real",
                },
            )
            if not is_mock and session_id:
                event_ts = float(event.get("ts") or time.time())
                minute = int(event_ts // 60)
                with self._state_lock:
                    if self._state.get("session_id") == session_id:
                        minutes = self._state.setdefault("session_minutes", {})
                        minutes[minute] = int(minutes.get(minute, 0)) + 1
                        self._state["session_last_event_at"] = event_ts
            if session_id and not is_mock:
                store = getattr(self, "session_store", None)
                if store is not None:
                    store.record_message(session_id, kind, float(event.get("ts") or time.time()), uid, meta)

            # 调试注入：只上屏/进浮窗，不朗读
            if not speak:
                self._drop_event(event, "mock_display_only")
                return event

            allowed, reason = self._wants_read(kind, read_cfg, meta)
            if not allowed:
                self._drop_event(event, reason)
                return event
            if kind in ("danmaku", "super_chat"):
                if not text or not tts_mod.is_readable(text):
                    self._drop_event(event, "no_text")
                    return event

            templates = read_cfg.get("templates") or {}
            values = {
                "user": user,
                "text": text,
                "message": text,
                "gift_name": meta.get("gift_name") or text,
                "num": meta.get("num") or 1,
                "guard_name": meta.get("guard_name") or "舰队",
            }
            template = templates.get(kind, "{user}{text}")
            if kind == "enter":
                template = normalize_enter_template(template)
            spoken_text = render_template(
                template, values, bool(read_cfg.get("include_user", True))
            )
            if not spoken_text:
                self._drop_event(event, "empty_template")
                return event

            if self._voice_cannot_read(spoken_text, cfg):
                self._drop_event(event, "voice_lang_mismatch")
                return event

            ok, reason = self._filters.check(text or spoken_text, user, uid, filters)
            if not ok:
                self._drop_event(event, reason)
                return event

            event["spoken"] = True
            self._enqueue_tts(
                {
                    "id": event["id"],
                    "kind": kind,
                    "user": user,
                    "uid": uid,
                    "text": spoken_text,
                    "event": event,
                }
            )
            return event
        except Exception:  # noqa: BLE001
            logger.exception("处理房间消息失败：%s", kind)
            return None

    @staticmethod
    def _voice_cannot_read(text: str, cfg: Dict[str, Any]) -> bool:
        """非中/日/韩音色朗读 CJK 内容时，微软服务会返回空音频（NoAudioReceived）。

        提前跳过，避免每条中文弹幕都发起一次注定失败的合成并刷错误事件。
        """
        voice = str(((cfg or {}).get("tts") or {}).get("voice") or "")
        lang = voice.split("-")[0].lower()
        if lang in _CJK_VOICE_LANGS:
            return False
        return bool(_CJK_CHAR_RE.search(text or ""))

    @staticmethod
    def _wants_read(kind: str, read_cfg: Dict[str, Any], meta: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        if kind == "gift":
            if not read_cfg.get("gift", True):
                return False, "disabled"
            # 抖音礼物只有 diamond_count，price/total_coin 固定为 0。
            # 人民币礼物门槛不能套用到钻石计价，否则所有抖音礼物都会被误过滤。
            if str(meta.get("coin_type") or "").lower() == "diamond":
                return True, None
            try:
                threshold = int(read_cfg.get("gift_min_price") or 0)
            except (TypeError, ValueError):
                threshold = 0
            try:
                value = int(meta.get("total_coin") or 0) or int(meta.get("price") or 0)
            except (TypeError, ValueError):
                value = 0
            if value < threshold:
                return False, "gift_min_price"
            return True, None
        if kind in ("danmaku", "super_chat", "guard", "enter"):
            if not read_cfg.get(kind, True):
                return False, "disabled"
            return True, None
        return False, "unsupported"

    def _drop_event(self, event: Dict[str, Any], reason: Optional[str]) -> None:
        meta = event.get("meta")
        if not isinstance(meta, dict):
            meta = {}
            event["meta"] = meta
        if reason in FILTER_REASONS:
            self._stats_bump(
                "filtered",
                mock=bool(meta.get("mock")),
                session_id=event.get("session_id"),
            )
        self._stats_bump(
            "dropped",
            mock=bool(meta.get("mock")),
            session_id=event.get("session_id"),
        )
        meta["drop_counted"] = True
        if reason:
            meta["filter"] = reason
        logger.debug("丢弃事件 seq=%s type=%s reason=%s", event.get("seq"), event.get("type"), reason)

    def _mark_post_drop(self, event: Dict[str, Any], reason: str, *, force: bool = False) -> None:
        """统计已进入朗读管线、但最终未开始播放的条目；同一事件只计一次。"""
        if not isinstance(event, dict):
            return
        meta = event.get("meta")
        if not isinstance(meta, dict):
            meta = {}
            event["meta"] = meta
        if not force and event.get("spoken") is True:
            # 已经开始播放后的失败不属于“丢弃”；保留已开始状态，避免比率超过 100%。
            meta["filter"] = reason
            meta["post_start_failure"] = True
            return
        if not meta.get("drop_counted"):
            self._stats_bump(
                "dropped",
                mock=bool(meta.get("mock")),
                session_id=event.get("session_id"),
            )
            meta["drop_counted"] = True
        event["spoken"] = False
        meta["filter"] = reason

    # -------------------------------------------------------------- 朗读队列
    def _enqueue_tts(self, item: Dict[str, Any]) -> None:
        try:
            max_size = int(self.config.get("queue", "max_size", default=30) or 30)
        except (TypeError, ValueError):
            max_size = 30
        dropped: List[Dict[str, Any]] = []
        limit = max(1, max_size)
        while len(self._tts_queue) + self._player.pending_count() >= limit and self._tts_queue:
            dropped.append(self._tts_queue.popleft())
        for old in dropped:
            self._drop_event(old["event"], "queue_full")
            old["event"]["spoken"] = False
            logger.warning("朗读队列已满，丢弃 seq=%s", old["event"].get("seq"))
        while len(self._tts_queue) + self._player.pending_count() >= limit:
            if not self._player.drop_oldest("queue_full"):
                break
            logger.warning("播放队列已满，丢弃最旧待播音频")
        item["epoch"] = self._current_epoch()
        self._tts_queue.append(item)
        self._set_pending(len(self._tts_queue))
        self._tts_wakeup.set()

    def _set_pending(self, value: int) -> None:
        with self._state_lock:
            self._pending_tts = int(value)

    async def _tts_worker(self) -> None:
        logger.info("TTS 工作协程启动")
        try:
            while not self._shutting_down:
                try:
                    await asyncio.wait_for(self._tts_wakeup.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass
                self._tts_wakeup.clear()
                while self._tts_queue and not self._shutting_down:
                    item = self._tts_queue.popleft()
                    self._set_pending(len(self._tts_queue))
                    await self._speak(item)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("TTS 工作协程异常退出")
        finally:
            logger.info("TTS 工作协程退出")

    async def _speak(self, item: Dict[str, Any]) -> None:
        # D-104：会话已失效（断开/换房/关闭）的在途条目直接丢弃，不合成、不播放
        if item.get("epoch") != self._current_epoch():
            self._discard_inflight(item, "shutdown" if self._shutting_down else "disconnect")
            return
        cfg = self.config.snapshot().get("tts") or {}
        entry_id = item["id"]
        path = os.path.join(self.cache_dir, "%s.mp3" % entry_id)
        try:
            result = await asyncio.wait_for(
                tts_mod.synthesize(
                    item["text"],
                    cfg.get("voice") or "zh-CN-XiaoxiaoNeural",
                    cfg.get("rate") or "+0%",
                    cfg.get("pitch") or "+0Hz",
                    cfg.get("volume") or "+0%",
                    path,
                ),
                timeout=SYNTH_TIMEOUT,
            )
        except asyncio.TimeoutError:
            result = {"ok": False, "error": "合成超时"}
        # D-104：合成期间发生断开/换房/关闭 → 删除音频，绝不进入播放队列
        if item.get("epoch") != self._current_epoch():
            self._discard_audio(path)
            self._discard_inflight(item, "shutdown" if self._shutting_down else "disconnect")
            return
        if result.get("ok") and os.path.isfile(path) and os.path.getsize(path) > 0:
            self._player.enqueue(
                path,
                {
                    "id": entry_id,
                    "user": item.get("user") or "",
                    "text": item.get("text") or "",
                    "kind": item.get("kind") or "",
                    "event": item.get("event"),
                },
            )
            logger.debug("合成完成 seq=%s bytes=%s", (item.get("event") or {}).get("seq"), result.get("bytes"))
            self._trim_cache()
        else:
            error = result.get("error") or "合成失败"
            event = item.get("event")
            if event is not None:
                self._mark_post_drop(event, "synth_failed", force=True)
            logger.warning("TTS 合成失败 seq=%s：%s", (event or {}).get("seq"), error)
            self._emit_event(
                "error",
                user=item.get("user") or "",
                text=item.get("text") or "",
                error=error,
                meta={"entry_id": entry_id, "kind": item.get("kind") or "", "stage": "tts"},
            )

    def _handle_player_event(self, kind: str, payload: Dict[str, Any]) -> None:
        """播放线程回调（在播放线程内执行）。"""
        entry = payload.get("entry") or {}
        if kind == "started":
            event = entry.get("event")
            if isinstance(event, dict):
                event["spoken"] = True
                meta = event.get("meta") if isinstance(event.get("meta"), dict) else {}
                self._stats_bump(
                    "spoken",
                    mock=bool(meta.get("mock")),
                    session_id=event.get("session_id"),
                )
            return
        if kind == "dropped":
            # D-104：被清掉、没来得及播放的条目回写为“未朗读”（filter=断开原因）
            event = entry.get("event")
            reason = str(payload.get("reason") or "disconnect")
            if isinstance(event, dict) and event.get("spoken") is not False:
                self._mark_post_drop(event, reason, force=True)
                logger.info("断开清队：seq=%s 未播放，已标记为未朗读", event.get("seq"))
            return
        if kind != "error":
            return
        error = str(payload.get("error") or "播放失败")
        event = entry.get("event")
        if isinstance(event, dict):
            self._mark_post_drop(event, "play_failed")
        self._emit_event(
            "error",
            user=str(entry.get("user") or ""),
            text=str(entry.get("text") or ""),
            error=error,
            meta={"entry_id": entry.get("id"), "kind": entry.get("kind"), "stage": "player"},
        )

    def _trim_cache(self) -> None:
        """音频缓存最多保留 200 个，超出按修改时间删最旧（跳过正在播放的文件）。"""
        try:
            entries: List[Tuple[float, str]] = []
            with os.scandir(self.cache_dir) as it:
                for entry in it:
                    if entry.is_file() and entry.name.endswith(".mp3"):
                        try:
                            entries.append((entry.stat().st_mtime, entry.path))
                        except OSError:
                            continue
            if len(entries) <= CACHE_MAX_FILES:
                return
            entries.sort()
            protected = self._player.pending_paths()
            for _mtime, path in entries[: len(entries) - CACHE_MAX_FILES]:
                if os.path.normcase(path) in protected:
                    continue
                try:
                    os.remove(path)
                except OSError:
                    continue
        except Exception:  # noqa: BLE001
            logger.exception("清理音频缓存失败")

    # ------------------------------------------------------------ 对外接口
    def get_state(self) -> Dict[str, Any]:
        """立即返回当前状态（纯内存读取，不阻塞网络）。"""
        try:
            with self._state_lock:
                connection = self._state["connection"]
                platform = self._state.get("platform") or "bilibili"
                room_key = self._state.get("room_key") or ""
                room_id = self._state["room_id"]
                room_title = self._state["room_title"]
                stats = dict(self._state["stats"])
                session = {
                    "id": self._state.get("session_id"),
                    "started_at": self._state.get("session_started_at"),
                    "open": bool(self._state.get("session_open")),
                    "platform": platform,
                    "room_key": room_key,
                    "last_event_at": self._state.get("session_last_event_at"),
                    "minutes": [
                        {"minute": int(minute), "count": int(count)}
                        for minute, count in sorted(
                            (self._state.get("session_minutes") or {}).items()
                        )
                    ],
                    "stats": copy.deepcopy((self._state.get("session_stats") or {}).get("all") or {}),
                    "real": copy.deepcopy((self._state.get("session_stats") or {}).get("real") or {}),
                    "mock": copy.deepcopy((self._state.get("session_stats") or {}).get("mock") or {}),
                }
                last_error = self._state["last_error"]
                pending = self._pending_tts
                account = dict(self._account)
                account["douyin"] = dict(
                    getattr(self, "_douyin_account", {"logged_in": False, "uname": None, "uid": None})
                )
            player = self._player.status()
            try:
                mock = self.mock_status()
            except Exception:  # noqa: BLE001
                logger.debug("读取模拟发送状态失败", exc_info=True)
                mock = {"running": False, "sent": 0}
            history_store = getattr(self, "session_store", None)
            history_available = bool(history_store is not None and history_store.available)
            history_error = str(getattr(history_store, "error", "") or "") if history_store is not None else "场次存储未初始化"
            history_capabilities = _history_capabilities()
            return {
                "connection": connection,
                "room_id": room_id,
                "room_title": room_title,
                "stats": stats,
                "session": session,
                "mock": {"running": bool(mock.get("running")), "sent": int(mock.get("sent") or 0)},
                "history": {
                    "available": history_available,
                    "error": history_error or None,
                    "capabilities": history_capabilities,
                },
                "queue_len": int(pending) + int(player.get("queue_len") or 0),
                "now_playing": player.get("now_playing"),
                # 兼容现有主界面：仍下发 v1 扁平配置；新版界面用 get_config_v2()
                "config": self.config.project_v1(),
                "last_error": last_error,
                "account": account,
            }
        except Exception as e:  # noqa: BLE001
            logger.exception("get_state 失败")
            return {
                "connection": "error",
                "room_id": 0,
                "room_title": None,
                "stats": {"received": 0, "spoken": 0, "dropped": 0, "filtered": 0},
                "session": {
                    "id": None,
                    "started_at": None,
                    "open": False,
                    "last_event_at": None,
                    "minutes": [],
                    "stats": _empty_session_metrics(),
                    "real": _empty_session_metrics(),
                    "mock": _empty_session_metrics(),
                },
                "mock": {"running": False, "sent": 0},
                "history": {
                    "available": False,
                    "error": "场次存储不可用",
                    "capabilities": _history_capabilities(),
                },
                "queue_len": 0,
                "now_playing": None,
                "config": {},
                "last_error": str(e),
                "account": {
                    "logged_in": False,
                    "uname": None,
                    "mid": None,
                    "douyin": {"logged_in": False, "uname": None, "uid": None},
                },
            }

    def poll_events(self, cursor: int = 0) -> Dict[str, Any]:
        """返回 seq > cursor 的事件（最多最近 1000 条）。"""
        try:
            cursor_i = int(cursor or 0)
        except (TypeError, ValueError):
            cursor_i = 0
        with self._events_lock:
            events = [copy.deepcopy(e) for e in self._events if e["seq"] > cursor_i]
            latest = self._seq
        return {"cursor": latest, "events": events}

    # ------------------------------------------------------------ 浮窗接口
    def get_overlay_config(self) -> Dict[str, Any]:
        """返回旧 Qt 浮窗可消费的 v1 投影；v2 配置仍从 snapshot 读取。"""
        try:
            cfg = self.config.overlay_v1()
            if isinstance(cfg, dict):
                # v2 扩展：附上 5 类已解析样式与三类 pins，供新版浮窗渲染
                try:
                    snap = self.config.snapshot()
                    overlay_v2 = snap.get("overlay") or {}
                    cfg["styles"] = copy.deepcopy(overlay_v2.get("styles") or {})
                    cfg["pins"] = copy.deepcopy(overlay_v2.get("pins") or {})
                    from .styles import StyleResolver
                    from .motion import MotionResolver

                    cfg["resolved"] = StyleResolver(snap).resolve_all()
                    cfg["motion"] = copy.deepcopy(cfg.get("motion") or {})
                    cfg["resolved_motion"] = MotionResolver(cfg).resolve_all()
                except Exception:  # noqa: BLE001
                    logger.exception("附加 v2 样式/动效快照失败（沿用 v1 投影）")
                try:
                    from .typography import TypographyResolver

                    cfg["typography"] = copy.deepcopy(cfg.get("typography") or {})
                    cfg["resolved_typography"] = TypographyResolver(cfg).resolve_all()
                except Exception:  # noqa: BLE001
                    logger.exception("附加 v2 排版快照失败（沿用 v1 投影）")
                return cfg
        except Exception:  # noqa: BLE001
            logger.exception("读取 overlay 配置失败，使用默认值")
        return copy.deepcopy(DEFAULT_LEGACY_OVERLAY)

    def get_config_v2(self) -> Dict[str, Any]:
        """返回规范配置快照（兼容旧调用名；当前为 v3）。"""
        try:
            return self.config.snapshot()
        except Exception:  # noqa: BLE001
            logger.exception("读取规范配置失败")
            return {}

    def config_status(self) -> Dict[str, Any]:
        """返回配置安全状态，供 UI 区分正常默认值与只读故障。"""
        try:
            return {
                "read_only": bool(self.config.is_read_only),
                "migration": self.config.migration_status(),
                "security": self.config.credential_status(),
            }
        except Exception:  # noqa: BLE001
            logger.exception("读取配置状态失败")
            return {
                "read_only": True,
                "migration": {"state": "unknown"},
                "security": {
                    "state": "read_only",
                    "warning": True,
                    "message": "无法读取凭证安全状态，配置已按只读处理。",
                    "dpapi_available": False,
                    "plaintext_fallback": False,
                    "decrypt_failed": False,
                    "read_only": True,
                    "token_count": 0,
                    "error": False,
                },
            }

    def history_status(self) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {
                "ok": False,
                "available": False,
                "error": "场次存储未初始化",
                "capabilities": _history_capabilities(),
            }
        return {
            "ok": bool(store.available),
            "available": bool(store.available),
            "error": store.error or None,
            "gap_events": int(getattr(store, "dropped_ops", 0)),
            "failed_ops": int(getattr(store, "failed_ops", 0)),
            "last_write_error": str(getattr(store, "last_write_error", "") or ""),
            "capabilities": _history_capabilities(),
        }

    def list_history_sessions(
        self,
        limit: int = 30,
        offset: int = 0,
        query: Any = "",
        started_from: Any = None,
        started_to: Any = None,
        platform: Any = None,
        before_started_at: Any = None,
        before_id: Any = None,
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化", "sessions": [], "total": 0}
        return store.list_sessions(
            limit,
            offset,
            query=query,
            started_from=started_from,
            started_to=started_to,
            platform=platform,
            before_started_at=before_started_at,
            before_id=before_id,
        )

    def get_history_session(self, session_id: str) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化", "session": None}
        return store.get_session(str(session_id or ""))

    def get_previous_history_session(self, session_id: str) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化", "session": None}
        return store.get_previous_session(str(session_id or ""))

    def list_history_baselines(
        self,
        target_id: str,
        limit: int = 30,
        before_distance: Any = None,
        before_started_at: Any = None,
        before_id: Any = None,
        before_target_id: Any = None,
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": "场次存储未初始化",
                "candidates": [],
            }
        return store.list_baseline_candidates(
            target_id,
            limit,
            before_distance=before_distance,
            before_started_at=before_started_at,
            before_id=before_id,
            before_target_id=before_target_id,
        )

    def compare_history_sessions(self, target_id: str, baseline_id: str) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": "场次存储未初始化",
                "target": None,
                "baseline": None,
            }
        return store.compare_sessions(target_id, baseline_id)

    def compare_multi_history_sessions(
        self,
        target_id: str,
        baseline_ids: Any,
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": "场次存储未初始化",
                "target": None,
                "baselines": [],
            }
        return store.compare_multi_sessions(str(target_id or ""), baseline_ids)

    def session_insights(self, target_id: str) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": "场次存储未初始化",
            }
        return store.session_insights(str(target_id or ""))

    def preview_history_prune(self, cutoff_ts: Any, keep_latest: int = 1) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.prune_sessions(cutoff_ts, keep_latest=keep_latest, dry_run=True)

    def prune_history(self, cutoff_ts: Any, keep_latest: int = 1) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.prune_sessions(cutoff_ts, keep_latest=keep_latest, dry_run=False)

    def get_history_settings(self) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化", "settings": {}}
        return store.get_settings()

    def update_history_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化", "settings": {}}
        return store.update_settings(patch)

    def history_trend(
        self,
        started_from: Any,
        started_to: Any,
        query: Any = "",
        platform: Any = None,
        granularity: str = "day",
        room_key: Any = None,
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": "场次存储未初始化",
            }
        return store.trend_sessions(
            started_from,
            started_to,
            query=query,
            platform=platform,
            granularity=granularity,
            room_key=room_key,
        )

    def export_history_session(self, session_id: str, fmt: str = "json") -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.export_session(str(session_id or ""), str(fmt or "json"))

    def export_history_trend(
        self,
        started_from: Any,
        started_to: Any,
        query: Any = "",
        platform: Any = None,
        granularity: str = "day",
        room_key: Any = None,
        fmt: str = "json",
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.export_trend_report(
            started_from,
            started_to,
            query=query,
            platform=platform,
            granularity=granularity,
            room_key=room_key,
            fmt=fmt,
        )

    def export_history_compare(
        self,
        target_id: str,
        baseline_id: str,
        fmt: str = "json",
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.export_compare_report(
            str(target_id or ""),
            str(baseline_id or ""),
            fmt=fmt,
        )

    def export_history_compare_multi(
        self,
        target_id: str,
        baseline_ids: Any,
        fmt: str = "json",
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.export_compare_multi_report(
            str(target_id or ""),
            baseline_ids,
            fmt=fmt,
        )

    def export_history_insights(self, target_id: str, fmt: str = "json") -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.export_insights_report(str(target_id or ""), fmt=fmt)

    def export_storage_status(self, week: Any = None) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.export_storage_status(week)

    def export_storage_preview(
        self,
        days: Any = 90,
        keep_latest: Any = 50,
        week: Any = None,
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.export_storage_preview(days, keep_latest, week)

    def export_storage_prune(
        self,
        preview_id: Any,
        days: Any = 90,
        keep_latest: Any = 50,
        week: Any = None,
    ) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.export_storage_prune(preview_id, days, keep_latest, week)

    def open_export_dir(self) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        return store.open_export_dir()

    def delete_history_session(self, session_id: str) -> Dict[str, Any]:
        store = getattr(self, "session_store", None)
        if store is None:
            return {"ok": False, "available": False, "error": "场次存储未初始化"}
        with self._state_lock:
            current_id = str(self._state.get("session_id") or "")
            session_open = bool(self._state.get("session_open"))
        if session_open and str(session_id or "") == current_id:
            return {"ok": False, "error": "不能删除正在记录的场次"}
        return store.delete_session(str(session_id or ""))

    def get_appearance(self) -> Dict[str, Any]:
        """返回工作台外观；旧客户端拿不到该字段时使用默认值。"""
        try:
            return self.config.get_appearance()
        except Exception:  # noqa: BLE001
            logger.exception("读取 appearance 配置失败")
            return {}

    def set_appearance(self, appearance: Dict[str, Any]) -> Dict[str, Any]:
        """整体保存外观；校验失败时不改动现有配置。"""
        try:
            _data, rejected = self.config.update_appearance(appearance)
            current = self.get_appearance()
            if rejected:
                return {
                    "ok": False,
                    "appearance": current,
                    "rejected": rejected,
                    "error": "外观配置未保存：" + "; ".join(rejected[:6]),
                }
            return {"ok": True, "appearance": current, "rejected": []}
        except Exception as exc:  # noqa: BLE001
            logger.exception("保存 appearance 配置失败")
            return {
                "ok": False,
                "appearance": self.get_appearance(),
                "rejected": ["appearance"],
                "error": "%s: %s" % (type(exc).__name__, exc),
            }

    def overlay_items(self, cursor: int = 0) -> Dict[str, Any]:
        """返回 seq > cursor 的浮窗消息（不包含 status/error/log）。"""
        try:
            cursor_i = int(cursor or 0)
        except (TypeError, ValueError):
            cursor_i = 0

        cfg = self.get_overlay_config()
        types_cfg = cfg.get("types") if isinstance(cfg.get("types"), dict) else {}
        try:
            name_max_len = int(cfg.get("name_max_len") or 12)
            text_max_len = int(cfg.get("text_max_len") or 70)
        except (TypeError, ValueError):
            name_max_len, text_max_len = 12, 70
        name_max_len = max(1, name_max_len)
        text_max_len = max(1, text_max_len)

        with self._events_lock:
            latest = self._seq
            events = [
                event
                for event in self._events
                if event.get("seq", 0) > cursor_i
                and event.get("type") in OVERLAY_MESSAGE_TYPES
                and bool(types_cfg.get(event.get("type"), False))
            ]

        items: List[Dict[str, Any]] = []
        for event in events:
            event_type = str(event.get("type") or "")
            meta = event.get("meta") if isinstance(event.get("meta"), dict) else {}
            text = event.get("text") or ""
            message = meta.get("message")
            if message is None and event_type == "super_chat":
                message = text
            items.append(
                {
                    "seq": event.get("seq"),
                    "type": event_type,
                    "user": _truncate_overlay_text(event.get("user"), name_max_len),
                    "uid": event.get("uid", 0),
                    "text": _truncate_overlay_text(text, text_max_len),
                    "ts": event.get("ts"),
                    "meta": {
                        "gift_name": meta.get("gift_name", ""),
                        "num": meta.get("num", 0),
                        "price": meta.get("price", 0),
                        "guard_level": meta.get("guard_level", 0),
                        "message": "" if message is None else str(message),
                        "coin_type": meta.get("coin_type", ""),
                        "diamond_count": meta.get("diamond_count", 0),
                        "platform": meta.get("platform", ""),
                    },
                }
            )
        return {"cursor": latest, "items": items}

    # ------------------------------------------------------------ 监看窗口
    _MONITOR_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter")

    def monitor_snapshot(self, limit: int = 300) -> Dict[str, Any]:
        """返回最近 N 条消息（含最新 spoken 状态），供监看窗口整表刷新。"""
        try:
            n = max(20, min(int(limit), 1000))
        except (TypeError, ValueError):
            n = 300
        with self._events_lock:
            items = [
                copy.deepcopy(e)
                for e in self._events
                if e.get("type") in self._MONITOR_TYPES
            ][-n:]
            latest = self._seq
        return {"seq": latest, "items": items}

    def monitor_state(self) -> Dict[str, Any]:
        try:
            with self._state_lock:
                conn = self._state["connection"]
                title = self._state["room_title"]
                stats = dict(self._state["stats"])
            player = self._player.status()
            return {
                "connection": conn,
                "room_title": title,
                "stats": stats,
                "now_playing": player.get("now_playing"),
                "queue_len": int(self._pending_tts) + int(player.get("queue_len") or 0),
            }
        except Exception:  # noqa: BLE001
            logger.exception("monitor_state 失败")
            return {"connection": "error", "room_title": None,
                    "stats": {"received": 0, "spoken": 0, "dropped": 0, "filtered": 0},
                    "now_playing": None, "queue_len": 0}

    def apply_overlay(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        """overlay 配置局部更新（等价 update_config 的薄封装）。"""
        result = self.update_config({"overlay": patch})
        response = {
            "ok": bool(result.get("ok")),
            "config": self.get_overlay_config(),
            "rejected": list(result.get("rejected") or []),
        }
        if not response["ok"]:
            response["error"] = result.get("error") or "浮窗配置写入失败"
        return response

    # ------------------------------------------------------------ 调试：模拟数据
    _MOCK_SAMPLES = {
        "danmaku": [
            "主播这波操作太秀了", "声音好好听，求歌单", "刚进来，错过了什么？",
            "哈哈哈笑死我了", "这个 BGM 叫什么名字", "已经关注啦，每天蹲直播",
            "前方高能预警", "别慌，这波稳的", "666666", "今晚是唱歌还是聊天呀",
        ],
        "gift": [
            ("小心心", 1, 0), ("棒棒糖", 4, 4), ("桃花花", 5, 5), ("干杯", 10, 10),
            ("牛哇", 20, 20), ("打call", 30, 30), ("星星点点", 50, 50), ("嘉年华", 1, 2000),
        ],
        "super_chat": ["这条弹幕一定要读啊！", "主播唱歌吧，求求了", "加油，一直支持你"],
        "guard": [("总督", 1), ("提督", 2), ("舰长", 3)],
        "enter": ["进入直播间"],
    }
    _MOCK_USERS = [
        "夜色微凉", "柠檬气泡水", "三月的风", "咸鱼想翻身", "阿哲",
        "月见草", "发呆的猫", "半糖去冰", "星河入梦", "听风者",
    ]

    def inject_mock(self, kind: str = "danmaku", user: str = "", text: str = "",
                    meta: Optional[Dict[str, Any]] = None, speak: bool = False) -> Dict[str, Any]:
        """注入一条模拟消息（走与真实弹幕完全相同的管线，便于调试浮窗/朗读）。

        - `speak=False`：只上屏/进浮窗，不朗读（默认）
        - `speak=True`：同时进入 TTS 队列（会真的发声）
        """
        try:
            kind = str(kind or "danmaku")
            if kind not in ("danmaku", "gift", "super_chat", "guard", "enter"):
                return {"ok": False, "error": "不支持的消息类型：%s" % kind}
            seq_hint = self._mock_seq = getattr(self, "_mock_seq", 0) + 1
            uname = str(user or "").strip() or self._MOCK_USERS[seq_hint % len(self._MOCK_USERS)]
            payload_meta = dict(meta or {})
            body = str(text or "").strip()

            if kind == "gift":
                if not body or "gift_name" not in payload_meta:
                    name, num, price = self._MOCK_SAMPLES["gift"][seq_hint % len(self._MOCK_SAMPLES["gift"])]
                    payload_meta.setdefault("gift_name", name)
                    payload_meta.setdefault("num", num)
                    payload_meta.setdefault("price", price)
                try:
                    mock_num = max(1, int(payload_meta.get("num") or 1))
                    mock_price = max(0, int(payload_meta.get("price") or 0))
                except (TypeError, ValueError):
                    mock_num, mock_price = 1, 0
                payload_meta.setdefault("coin_type", "mock_cny")
                payload_meta.setdefault("total_coin", mock_price * mock_num)
                body = body or ("送出 %s" % payload_meta.get("gift_name"))
            elif kind == "super_chat":
                body = body or self._MOCK_SAMPLES["super_chat"][seq_hint % len(self._MOCK_SAMPLES["super_chat"])]
                payload_meta.setdefault("message", body)
                payload_meta.setdefault("price", 30)
            elif kind == "guard":
                if not body or "guard_name" not in payload_meta:
                    gname, level = self._MOCK_SAMPLES["guard"][seq_hint % len(self._MOCK_SAMPLES["guard"])]
                    payload_meta.setdefault("guard_name", gname)
                    payload_meta.setdefault("guard_level", level)
                body = body or ("开通了 %s" % payload_meta.get("guard_name"))
            elif kind == "enter":
                body = body or "进入直播间"
            else:
                body = body or self._MOCK_SAMPLES["danmaku"][seq_hint % len(self._MOCK_SAMPLES["danmaku"])]

            payload_meta["mock"] = True
            payload = {"user": uname, "uid": 0, "text": body, "meta": payload_meta}
            event = self._inject_on_loop(kind, payload, bool(speak))
            spoken = bool((event or {}).get("spoken"))
            reason = (event or {}).get("meta", {}).get("filter") if event else None
            return {
                "ok": True,
                "kind": kind,
                "user": uname,
                "text": body,
                "spoken": spoken,
                "filter": reason,
            }
        except Exception as e:  # noqa: BLE001
            logger.exception("注入模拟消息失败")
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def _inject_on_loop(self, kind: str, payload: Dict[str, Any], speak: bool):
        """把调试注入切到后台事件循环线程执行，避免与真实弹幕并发改队列。"""
        loop = getattr(self, "_loop", None)
        cur = threading.current_thread()
        if loop is None or loop.is_closed() or cur is getattr(self, "_loop_thread", None):
            return self._handle_room_message(kind, payload, speak=speak)
        fut: "concurrent.futures.Future" = concurrent.futures.Future()

        def _run() -> None:
            try:
                fut.set_result(self._handle_room_message(kind, payload, speak=speak))
            except Exception as e:  # noqa: BLE001
                fut.set_exception(e)

        loop.call_soon_threadsafe(_run)
        return fut.result(timeout=5.0)

    def inject_mock_burst(self, count: int = 10, kind: str = "mixed", speak: bool = False) -> Dict[str, Any]:
        """批量注入模拟消息（弹幕风暴调试）。`kind=mixed` 时混合五类消息。"""
        try:
            n = max(1, min(int(count), 200))
        except (TypeError, ValueError):
            n = 10
        kinds = ("danmaku", "gift", "super_chat", "guard", "enter")
        injected = 0
        spoken = 0
        filters: Dict[str, int] = {}
        for i in range(n):
            k = kinds[i % len(kinds)] if kind == "mixed" else kind
            res = self.inject_mock(k, speak=speak)
            if res.get("ok"):
                injected += 1
                if res.get("spoken"):
                    spoken += 1
                elif res.get("filter"):
                    filters[str(res["filter"])] = filters.get(str(res["filter"]), 0) + 1
        return {
            "ok": True,
            "count": injected,
            "kind": kind,
            "speak": bool(speak),
            "spoken_count": spoken,
            "filtered": filters,
        }

    # ------------------------------------------------------ 调试：自动模拟发送
    def mock_auto(self, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """开启/关闭自动模拟发送，并更新频率/类型等参数。"""
        payload = payload if isinstance(payload, dict) else {}
        patch: Dict[str, Any] = {}
        for key in ("interval_ms", "per_tick", "speak"):
            if key in payload:
                patch[key] = payload[key]
        if isinstance(payload.get("types"), dict):
            patch["types"] = payload["types"]
        if patch:
            self.update_config({"mock": patch})
        enabled = bool(payload.get("enabled"))
        self._set_mock_auto(enabled)
        status = self.mock_status()
        status["ok"] = True
        return status

    def mock_status(self) -> Dict[str, Any]:
        cfg = self.config.get("mock", default={}) or {}
        fut = self._mock_task
        running = bool(fut is not None and not fut.done() and not fut.cancelled())
        return {
            "running": running,
            "sent": int(self._mock_sent),
            "interval_ms": int(cfg.get("interval_ms") or 1500),
            "per_tick": int(cfg.get("per_tick") or 1),
            "speak": bool(cfg.get("speak")),
            "types": dict(cfg.get("types") or {}),
        }

    def _set_mock_auto(self, enabled: bool) -> None:
        try:
            if enabled:
                fut = self._mock_task
                if fut is not None and not fut.done() and not fut.cancelled():
                    return  # 已在运行，参数变化由循环内部每轮读取
                self._mock_sent = 0
                self._mock_task = asyncio.run_coroutine_threadsafe(self._mock_loop(), self._loop)
                logger.info("自动模拟发送已开启")
            else:
                fut, self._mock_task = self._mock_task, None
                if fut is not None:
                    fut.cancel()
                    logger.info("自动模拟发送已停止")
        except Exception:  # noqa: BLE001
            logger.exception("切换自动模拟发送失败")

    async def _mock_loop(self) -> None:
        """按配置的频率循环注入模拟消息（运行在后台事件循环线程）。"""
        try:
            while True:
                cfg = self.config.get("mock", default={}) or {}
                try:
                    interval = max(200, int(cfg.get("interval_ms") or 1500)) / 1000.0
                except (TypeError, ValueError):
                    interval = 1.5
                await asyncio.sleep(interval)
                cfg = self.config.get("mock", default={}) or {}
                types_cfg = cfg.get("types") or {}
                kinds = [k for k in ("danmaku", "gift", "super_chat", "guard", "enter") if types_cfg.get(k)]
                if not kinds:
                    continue
                try:
                    per_tick = max(1, min(20, int(cfg.get("per_tick") or 1)))
                except (TypeError, ValueError):
                    per_tick = 1
                speak = bool(cfg.get("speak"))
                for _ in range(per_tick):
                    self.inject_mock(random.choice(kinds), speak=speak)
                    self._mock_sent += 1
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("自动模拟发送循环异常退出")
            self._mock_task = None

    def connect(self, room_id: Any, platform: Any = None) -> Dict[str, Any]:
        """连接直播间；B 站用房间号，抖音用房间号或直播间链接。"""
        # 未显式传平台时保持旧契约：默认 B 站（UI 会显式传当前选择）。
        selected = normalize_platform(platform or "bilibili")
        if selected not in ("bilibili", "douyin"):
            return {"ok": False, "error": "暂不支持该直播平台"}
        if selected == "bilibili":
            try:
                rid = int(room_id)
            except (TypeError, ValueError):
                return {"ok": False, "error": "room_id 必须是整数"}
            if rid <= 0:
                return {"ok": False, "error": "room_id 必须为正整数"}
            source_room: Any = rid
            public_room_id = rid
            room_key = str(rid)
        else:
            source_room = str(room_id or "").strip()
            if not source_room:
                return {"ok": False, "error": "请输入抖音直播间号或链接"}
            public_room_id = 0
            room_key = source_room
        # 只有参数校验通过后才切换消息源，避免非法输入污染当前连接。
        self._source_platform = selected
        self._source_room_key = room_key
        try:
            return self._call(
                self._connect_async(
                    source_room,
                    platform=selected,
                    room_key=room_key,
                    public_room_id=public_room_id,
                ),
                timeout=35.0,
            )
        except TimeoutError:
            self._set_connection(
                STATE_ERROR,
                room_id=public_room_id,
                platform=selected,
                room_key=room_key,
                last_error="连接超时",
                note="连接超时",
            )
            self._emit_event("error", error="连接超时", meta={"room_id": public_room_id, "platform": selected})
            return {"ok": False, "error": "连接超时"}
        except Exception as e:  # noqa: BLE001
            logger.exception("connect 失败")
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    async def _connect_async(
        self,
        room_id: Any,
        *,
        new_session: bool = True,
        platform: str = "bilibili",
        room_key: str = "",
        public_room_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        # 新建会话：旧会话在途朗读条目一律失效（不跨会话发声）
        created_session = bool(new_session or not self._current_session_id())
        session_room_id = int(public_room_id if public_room_id is not None else (room_id or 0))
        session_room_key = str(room_key or room_id or "")
        if created_session:
            self._begin_session(session_room_id, platform, session_room_key)
        self._bump_session_epoch()
        self._source_platform = platform
        self._source_room_key = session_room_key
        try:
            await self._close_sources()
            source = self._danmaku if platform == "bilibili" else self._douyin
            result = await source.open(room_id)
        except asyncio.CancelledError:
            # Cancellation/timeout must not leave a half-open adapter or
            # aiohttp session behind.
            await self._close_sources()
            if created_session:
                self._finish_current_session("connect_failed")
            raise
        except Exception as exc:  # noqa: BLE001
            error = "%s: %s" % (type(exc).__name__, exc)
            await self._close_sources()
            self._set_connection(
                STATE_ERROR,
                room_id=session_room_id,
                platform=platform,
                room_key=session_room_key,
                last_error=error,
                note="连接失败",
            )
            self._emit_event(
                "error",
                error=error,
                meta={"room_id": session_room_id, "platform": platform, "stage": "connect"},
            )
            if created_session:
                self._finish_current_session("connect_failed")
            return {"ok": False, "error": error, "room_id": session_room_id}
        if not result.get("ok"):
            error = result.get("error") or "连接失败"
            await self._close_sources()
            self._set_connection(
                STATE_ERROR,
                room_id=int(result.get("room_id") or session_room_id),
                platform=platform,
                room_key=str(result.get("room_key") or session_room_key),
                last_error=error,
                note="连接失败",
            )
            self._emit_event(
                "error",
                error=error,
                meta={"room_id": session_room_id, "platform": platform, "stage": "connect"},
            )
            if created_session:
                self._finish_current_session("connect_failed")
            return {"ok": False, "error": error, "room_id": session_room_id}
        resolved_room_id = int(result.get("room_id") or session_room_id or 0)
        resolved_room_key = str(result.get("room_key") or session_room_key)
        self._source_room_key = resolved_room_key
        try:
            self.config.update({"room_id": resolved_room_id, "platform": platform})
        except Exception:  # noqa: BLE001
            pass
        session_id = self._current_session_id()
        store = getattr(self, "session_store", None)
        if session_id and store is not None:
            store.update_session_meta(
                session_id,
                resolved_room_id,
                str(result.get("room_title") or ""),
                resolved_room_key,
            )
        return {
            "ok": True,
            "platform": platform,
            "room_key": resolved_room_key,
            "room_id": resolved_room_id,
            "room_title": result.get("room_title"),
            "room_live": result.get("room_live"),
            "connection": self.get_state()["connection"],
        }

    def disconnect(self) -> Dict[str, Any]:
        """断开连接并清空待朗读队列。"""
        try:
            return self._call(self._disconnect_async(), timeout=15.0)
        except Exception as e:  # noqa: BLE001
            logger.exception("disconnect 失败")
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e), "connection": "disconnected"}

    async def _disconnect_async(self) -> Dict[str, Any]:
        # D-104：先让在途合成失效，再停连接，最后“停止发声”（打断当前 + 清空待播）
        self._bump_session_epoch()
        try:
            await self._close_sources()
        finally:
            while self._tts_queue:
                item = self._tts_queue.popleft()
                self._drop_event(item["event"], "disconnect")
                item["event"]["spoken"] = False
            self._set_pending(0)
            stopped = self._player.stop_now(reason="disconnect")
            if stopped:
                logger.info("断开：已停止播放并清空 %d 条待播放音频", stopped)
            else:
                logger.info("断开：已停止当前播放")
            self._finish_current_session("manual_disconnect")
            self._set_connection(STATE_DISCONNECTED, note="已断开连接")
        return {"ok": True, "connection": "disconnected"}

    async def _close_sources(self) -> None:
        """Close both adapters even if a test double implements only one."""
        for source in (getattr(self, "_danmaku", None), getattr(self, "_douyin", None)):
            if source is None:
                continue
            close = getattr(source, "close", None)
            if not callable(close):
                continue
            try:
                await close()
            except asyncio.CancelledError:
                # Cleanup must continue during connect cancellation.
                continue
            except Exception as exc:  # noqa: BLE001
                logger.debug("关闭消息源异常：%s", exc)

    def update_config(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        """局部更新配置（深合并），立即生效。"""
        if not isinstance(patch, dict):
            return {"ok": False, "error": "patch 必须是 dict", "config": self.config.snapshot()}
        data, rejected = self.config.update(patch)
        if WRITE_FAILED in rejected:
            return {
                "ok": False,
                "error": "配置写入失败，已回滚内存状态",
                "config": data,
                "rejected": rejected,
            }
        try:
            self._call(self._apply_config_async(data), timeout=5.0)
        except Exception:  # noqa: BLE001
            logger.debug("配置生效回调失败（忽略）", exc_info=True)
        return {"ok": True, "config": data, "rejected": rejected}

    async def _apply_config_async(self, data: Dict[str, Any]) -> None:
        # snapshot() 会脱敏 sessdata；运行时凭证必须从配置内部读取。
        self._danmaku.set_sessdata(str(self.config.get("sessdata", default="") or ""))
        try:
            max_size = int((data.get("queue") or {}).get("max_size") or 30)
        except (TypeError, ValueError):
            max_size = 30
        while len(self._tts_queue) > max(1, max_size):
            item = self._tts_queue.pop()  # 缩容时保留较早的条目，丢弃最新的
            self._drop_event(item["event"], "queue_full")
            item["event"]["spoken"] = False
        self._set_pending(len(self._tts_queue))

    def list_voices(self) -> List[Dict[str, Any]]:
        """返回音色列表（edge_tts.list_voices 结果，缓存到 logs/voices.json）。"""
        if self._voices:
            return copy.deepcopy(self._voices)
        try:
            voices = self._call(self._list_voices_async(), timeout=VOICE_FETCH_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            logger.warning("获取音色列表失败：%s", e)
            voices = tts_mod.load_voice_cache(self._voice_cache_path)
            self._voices = voices
        return copy.deepcopy(voices or [])

    async def _list_voices_async(self) -> List[Dict[str, Any]]:
        try:
            voices = await tts_mod.fetch_voice_list(timeout=30.0)
        except Exception as e:  # noqa: BLE001
            logger.warning("拉取音色列表失败，改用本地缓存：%s", e)
            voices = tts_mod.load_voice_cache(self._voice_cache_path)
        else:
            tts_mod.save_voice_cache(self._voice_cache_path, voices)
            logger.info("音色列表已更新（%d 个）", len(voices))
        self._voices = voices
        return voices

    def preview(
        self,
        text: str,
        voice: Optional[str] = None,
        rate: Optional[str] = None,
        pitch: Optional[str] = None,
        volume: Optional[str] = None,
    ) -> Dict[str, Any]:
        """试听：用指定参数合成并立即播放（插队），返回缓存条目信息。"""
        if not isinstance(text, str) or not text.strip():
            return {"ok": False, "error": "文本为空"}
        try:
            return self._call(
                self._preview_async(text, voice, rate, pitch, volume), timeout=SYNTH_TIMEOUT + 10.0
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("preview 失败")
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    async def _preview_async(
        self,
        text: str,
        voice: Optional[str],
        rate: Optional[str],
        pitch: Optional[str],
        volume: Optional[str],
    ) -> Dict[str, Any]:
        cfg = self.config.snapshot().get("tts") or {}
        use_voice = voice or cfg.get("voice") or "zh-CN-XiaoxiaoNeural"
        payload = tts_mod.truncate(tts_mod.clean_text(text), PREVIEW_MAX_CHARS)
        entry_id = str(uuid.uuid4())
        path = os.path.join(self.cache_dir, "%s.mp3" % entry_id)
        try:
            result = await asyncio.wait_for(
                tts_mod.synthesize(
                    payload,
                    use_voice,
                    rate or cfg.get("rate") or "+0%",
                    pitch or cfg.get("pitch") or "+0Hz",
                    volume or cfg.get("volume") or "+0%",
                    path,
                ),
                timeout=SYNTH_TIMEOUT,
            )
        except asyncio.TimeoutError:
            result = {"ok": False, "error": "合成超时"}
        if not result.get("ok"):
            error = result.get("error") or "合成失败"
            logger.warning("试听合成失败：%s", error)
            self._emit_event("error", text=payload, error=error, meta={"stage": "preview", "entry_id": entry_id})
            return {"ok": False, "error": error, "entry_id": entry_id}
        self._trim_cache()
        played = self._player.play_now(
            path,
            {"id": entry_id, "user": "试听", "text": payload, "kind": "preview"},
            interrupt=True,
        )
        return {
            "ok": True,
            "entry_id": entry_id,
            "path": path,
            "size": os.path.getsize(path),
            "text": payload,
            "voice": use_voice,
            "played": bool(played),
        }

    def replay(self, entry_id: str) -> Dict[str, Any]:
        """重播某条已朗读弹幕的缓存音频（插队立即播放）。"""
        if not isinstance(entry_id, str) or not entry_id.strip():
            return {"ok": False, "error": "entry_id 无效"}
        safe = os.path.basename(entry_id.strip())
        path = os.path.join(self.cache_dir, "%s.mp3" % safe)
        if not os.path.isfile(path):
            return {"ok": False, "error": "缓存不存在或已被清理", "entry_id": safe}
        if not self._player.play_now(path, {"id": safe, "kind": "replay"}, interrupt=True):
            return {"ok": False, "error": "播放器不可用", "entry_id": safe}
        return {"ok": True, "entry_id": safe, "path": path, "size": os.path.getsize(path)}

    def shutdown(self) -> None:
        """停止全部后台线程并落盘日志（可重复调用）。"""
        if self._shutdown_done:
            return
        self._shutting_down = True
        logger.info("服务开始关闭")
        try:
            future = None
            if not self._shutdown_done and not self._loop.is_closed():
                future = asyncio.run_coroutine_threadsafe(self._shutdown_async(), self._loop)
            if future is not None:
                try:
                    future.result(8.0)
                except Exception:  # noqa: BLE001
                    logger.debug("关闭协程未能正常结束（继续强制停止）", exc_info=True)
            self._finish_current_session("shutdown")
            store = getattr(self, "session_store", None)
            if store is not None:
                store.flush(4.0)
            # loop.stop() 必须由外部线程发起：否则事件循环会在任务回调投递前停下，
            # 调用方将永远等不到 future 的结果
            if not self._loop.is_closed():
                self._loop.call_soon_threadsafe(self._loop.stop)
        except Exception:  # noqa: BLE001
            logger.debug("关闭事件循环时出现异常（忽略）", exc_info=True)
        try:
            self._player.shutdown(timeout=3.0)
        except Exception:  # noqa: BLE001
            pass
        try:
            self._loop_thread.join(timeout=5.0)
        except Exception:  # noqa: BLE001
            pass
        store = getattr(self, "session_store", None)
        if store is not None:
            store.close(5.0)
        for handler in self._log_handlers:
            try:
                if isinstance(handler, _EventLogHandler):
                    handler.deactivate()
                handler.flush()
                handler.close()
            except Exception:  # noqa: BLE001
                pass
        self._shutdown_done = True

    async def _shutdown_async(self) -> None:
        # 关闭：在途合成一律失效，避免退出过程中再发声
        self._bump_session_epoch()
        try:
            await self._danmaku.close()
        except Exception as e:  # noqa: BLE001
            logger.warning("关闭弹幕连接异常：%s", e)
        try:
            await self._douyin.close()
        except Exception as e:  # noqa: BLE001
            logger.warning("关闭抖音连接异常：%s", e)
        while self._tts_queue:
            item = self._tts_queue.popleft()
            self._drop_event(item["event"], "shutdown")
        self._set_pending(0)
        self._player.stop_now(wait=0.5, reason="shutdown")
        self._tts_wakeup.set()
        current = asyncio.current_task()
        for task in asyncio.all_tasks(self._loop):
            if task is not current:
                task.cancel()
        await asyncio.sleep(0)
        logger.info("后台事件循环即将停止")
