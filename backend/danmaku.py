# -*- coding: utf-8 -*-
"""blivedm 封装：房间信息查询、连接 / 自动重连、消息归一化。

- 匿名连接（无 SESSDATA）时用户名会打码、uid=0，属正常现象；
- 断线由 blivedm 内部按指数退避（1s→30s 封顶）重连；客户端整体停止时由本模块接管，
  房间不存在 / 初始化失败（InitError、RuntimeError 等）重试 3 次后放弃并置 error。
"""

from __future__ import annotations

import asyncio
import http.cookies
import logging
import time
from typing import Any, Callable, Dict, List, Optional

import aiohttp
import blivedm
import blivedm.models.web as web_models
from blivedm.clients.ws_base import AuthError, InitError

logger = logging.getLogger("danmaku_tts.danmaku")

ROOM_INFO_URL = "https://api.live.bilibili.com/room/v1/Room/get_info"
ROOM_RECOMMEND_URL = "https://api.live.bilibili.com/room/v1/room/get_user_recommend"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)
REQUEST_HEADERS = {"User-Agent": USER_AGENT, "Referer": "https://live.bilibili.com/"}

GUARD_NAMES = {1: "总督", 2: "提督", 3: "舰长"}

HEARTBEAT_WAIT = 8.0          # 等待首个心跳（判定连接成功）的最长时间
RECONNECT_MAX_DELAY = 30.0    # 重连退避上限
MAX_FATAL_RETRY = 3           # 致命错误（房间不存在等）最多重试次数
ROOM_INFO_REFRESH = 120.0     # 连接期间刷新房间信息的间隔
GUARD_DEDUP_SECONDS = 10.0    # GUARD_BUY 与 USER_TOAST_MSG_V2 去重窗口

# 契约要求的连接状态
STATE_DISCONNECTED = "disconnected"
STATE_CONNECTING = "connecting"
STATE_CONNECTED = "connected"
STATE_ERROR = "error"


def make_session(sessdata: str = "") -> aiohttp.ClientSession:
    """创建带 SESSDATA cookie 的 aiohttp 会话（空值即匿名连接）。"""
    session = aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=30)
    )
    cookies = http.cookies.SimpleCookie()
    cookies["SESSDATA"] = sessdata or ""
    cookies["SESSDATA"]["domain"] = "bilibili.com"
    session.cookie_jar.update_cookies(cookies)
    return session


async def fetch_room_info(session: aiohttp.ClientSession, room_id: int, timeout: float = 8.0) -> Dict[str, Any]:
    """查询直播间信息。fatal=True 表示接口明确回答“房间不存在/不可用”。"""
    result: Dict[str, Any] = {
        "ok": False, "fatal": False, "room_id": int(room_id), "title": None,
        "live_status": None, "uid": None, "uname": None, "error": None,
    }
    try:
        async with session.get(
            ROOM_INFO_URL,
            params={"room_id": int(room_id)},
            headers=REQUEST_HEADERS,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as res:
            if res.status != 200:
                result["error"] = "HTTP %s" % res.status
                return result
            data = await res.json(content_type=None)
    except asyncio.TimeoutError:
        result["error"] = "请求超时"
        return result
    except Exception as e:  # noqa: BLE001
        result["error"] = "%s: %s" % (type(e).__name__, e)
        return result

    if not isinstance(data, dict):
        result["error"] = "返回内容不是 JSON 对象"
        return result
    if data.get("code") != 0:
        result["fatal"] = True
        result["error"] = "房间不可用：%s" % (data.get("message") or data.get("code"))
        return result
    info = data.get("data") or {}
    result.update(
        ok=True,
        title=info.get("title"),
        live_status=info.get("live_status"),
        uid=info.get("uid"),
        uname=info.get("uname"),
        room_id=info.get("room_id") or int(room_id),
    )
    return result


async def fetch_recommend_rooms(session: aiohttp.ClientSession) -> List[Dict[str, Any]]:
    """B 站公开推荐直播间列表（无需登录；带 UA/Referer 才返回 JSON）。"""
    try:
        async with session.get(
            ROOM_RECOMMEND_URL,
            params={"page": 1, "page_size": 20},
            headers=REQUEST_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as res:
            data = await res.json(content_type=None)
    except Exception as e:  # noqa: BLE001
        logger.warning("推荐房间列表获取失败：%s", e)
        return []
    rooms = data.get("data") if isinstance(data, dict) else None
    return [item for item in rooms if isinstance(item, dict)] if isinstance(rooms, list) else []


def _watched_num(item: Dict[str, Any]) -> int:
    watched = item.get("watched_show")
    if isinstance(watched, dict):
        try:
            return int(watched.get("num") or 0)
        except (TypeError, ValueError):
            return 0
    return 0


async def find_live_rooms(
    session: aiohttp.ClientSession,
    candidates: Optional[List[int]] = None,
    scan_limit: int = 6,
) -> List[int]:
    """按“可能在播且有人气”的顺序返回候选房间号（都用 get_info 校验 live_status==1）。

    先试固定候选房；再从公开推荐列表里按“看过人数”从高到低校验（控制请求频率）。
    """
    found: List[int] = []
    for room_id in candidates or []:
        info = await fetch_room_info(session, room_id)
        if info.get("ok") and info.get("live_status") == 1:
            found.append(int(room_id))
    rooms = await fetch_recommend_rooms(session)
    rooms.sort(key=_watched_num, reverse=True)
    for item in rooms[: max(0, scan_limit)]:
        room_id = item.get("roomid")
        if not room_id:
            continue
        info = await fetch_room_info(session, int(room_id))
        if info.get("ok") and info.get("live_status") == 1:
            found.append(int(room_id))
    return found


async def find_live_room(
    session: aiohttp.ClientSession,
    candidates: Optional[List[int]] = None,
    scan_limit: int = 6,
) -> Optional[int]:
    """找一个正在直播（live_status==1）的房间；等价于 find_live_rooms()[0]。"""
    rooms = await find_live_rooms(session, candidates, scan_limit)
    return rooms[0] if rooms else None


def _guard_name(level: Any) -> str:
    try:
        return GUARD_NAMES.get(int(level), "舰队")
    except (TypeError, ValueError):
        return "舰队"


class _LiveHandler(blivedm.BaseHandler):
    """把 blivedm 回调转成归一化消息（回调都在事件循环线程内执行）。"""

    def __init__(self, conn: "DanmakuConnection"):
        self._conn = conn

    def _on_heartbeat(self, client, message: web_models.HeartbeatMessage):
        self._conn._handle_heartbeat(message)

    def _on_danmaku(self, client, message: web_models.DanmakuMessage):
        self._conn._handle_danmaku(message)

    def _on_gift(self, client, message: web_models.GiftMessage):
        self._conn._handle_gift(message)

    def _on_super_chat(self, client, message: web_models.SuperChatMessage):
        self._conn._handle_super_chat(message)

    def _on_buy_guard(self, client, message: web_models.GuardBuyMessage):
        self._conn._handle_guard(message.username, message.uid, message.guard_level, message.num, message.price, "月")

    def _on_user_toast_v2(self, client, message: web_models.UserToastV2Message):
        # source==2 是赠送消息（与付费上舰重复），忽略
        if message.source == 2:
            return
        self._conn._handle_guard(
            message.username, message.uid, message.guard_level, message.num, message.price, message.unit or "月"
        )

    def _on_interact_word_v2(self, client, message: web_models.InteractWordV2Message):
        self._conn._handle_interact(message)

    def on_client_stopped(self, client, exception):
        self._conn._handle_client_stopped(client, exception)


class DanmakuConnection:
    """一条直播间连接的完整生命周期管理。

    :param on_message: 归一化消息回调 (kind, payload)，在事件循环线程内同步调用
    :param on_state: 连接状态回调 (state, room_id, room_title, room_live)
    :param on_error: 错误回调 (message, meta)
    """

    def __init__(
        self,
        on_message: Callable[[str, Dict[str, Any]], None],
        on_state: Callable[[str, int, Optional[str], Optional[bool]], None],
        on_error: Callable[[str, Dict[str, Any]], None],
        sessdata: str = "",
    ):
        self._on_message = on_message
        self._on_state = on_state
        self._on_error = on_error
        self._sessdata = sessdata or ""

        self._session: Optional[aiohttp.ClientSession] = None
        self._client: Optional[blivedm.BLiveClient] = None
        self._handler = _LiveHandler(self)
        self._closing = True
        self._connected = False
        self._room_id = 0
        self._room_title: Optional[str] = None
        self._room_live: Optional[bool] = None
        self._fatal_attempts = 0
        self._reconnect_task: Optional[asyncio.Task] = None
        self._refresh_task: Optional[asyncio.Task] = None
        self._guard_seen: Dict[Any, float] = {}

    # ------------------------------------------------------------ 只读属性
    @property
    def room_id(self) -> int:
        return self._room_id

    @property
    def room_title(self) -> Optional[str]:
        return self._room_title

    @property
    def room_live(self) -> Optional[bool]:
        return self._room_live

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def sessdata(self) -> str:
        return self._sessdata

    def set_sessdata(self, value: str) -> None:
        """更新登录凭证（下次连接生效）。"""
        self._sessdata = value or ""

    @property
    def uid(self) -> int:
        """当前登录用户 ID（0 = 匿名/未登录）。连接建立后可用。"""
        client = self._client
        if client is None:
            return 0
        return int(getattr(client, "uid", 0) or 0)

    # ------------------------------------------------------------ 连接管理
    async def open(self, room_id: int) -> Dict[str, Any]:
        """连接直播间：查询房间信息 → 建立弹幕连接 → 等首个心跳。"""
        await self.close()
        self._closing = False
        self._fatal_attempts = 0
        self._connected = False
        self._room_id = int(room_id)
        self._room_title = None
        self._room_live = None
        if self._session is None or self._session.closed:
            self._session = make_session(self._sessdata)

        self._on_state(STATE_CONNECTING, self._room_id, None, None)
        info = await self._fetch_info(attempts=3)
        if info.get("fatal"):
            return {"ok": False, "error": info.get("error"), "room_id": self._room_id}
        if info.get("ok"):
            self._apply_info(info)
        else:
            self._on_error(
                "获取房间信息失败：%s" % info.get("error"),
                {"room_id": self._room_id, "stage": "room_info"},
            )

        try:
            self._start_client()
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "启动弹幕连接失败：%s" % e, "room_id": self._room_id}
        if not await self._wait_connected(HEARTBEAT_WAIT):
            return {
                "ok": False,
                "error": "等待 B 站心跳超时",
                "room_id": self._room_id,
                "connected": False,
            }
        self._ensure_refresh_task()
        return {
            "ok": True,
            "room_id": self._room_id,
            "room_title": self._room_title,
            "room_live": self._room_live,
            "connected": self._connected,
        }

    async def close(self) -> None:
        """断开连接并释放会话；可重复调用。"""
        self._closing = True
        await self._cancel_task("_reconnect_task")
        await self._cancel_task("_refresh_task")
        client, self._client = self._client, None
        if client is not None:
            try:
                await client.stop_and_close()
            except Exception as e:  # noqa: BLE001
                logger.warning("关闭弹幕客户端异常：%s", e)
        session, self._session = self._session, None
        if session is not None and not session.closed:
            try:
                await session.close()
            except Exception as e:  # noqa: BLE001
                logger.warning("关闭 aiohttp 会话异常：%s", e)
        self._connected = False
        self._on_state(STATE_DISCONNECTED, self._room_id, self._room_title, self._room_live)

    async def refresh_room_info(self) -> None:
        """刷新房间标题 / 开播状态，变化时推送状态事件。"""
        if self._closing or self._session is None or self._session.closed:
            return
        info = await self._fetch_info(attempts=1)
        if not info.get("ok"):
            return
        changed = (info.get("title") != self._room_title) or (
            (info.get("live_status") == 1) != self._room_live
        )
        self._apply_info(info)
        if changed:
            self._on_state(
                STATE_CONNECTED if self._connected else STATE_CONNECTING,
                self._room_id, self._room_title, self._room_live,
            )

    # ------------------------------------------------------------ 内部实现
    async def _cancel_task(self, attr: str) -> None:
        task = getattr(self, attr, None)
        setattr(self, attr, None)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as e:  # noqa: BLE001
                logger.debug("取消后台任务异常：%s", e)

    async def _fetch_info(self, attempts: int = 3) -> Dict[str, Any]:
        last: Dict[str, Any] = {"ok": False, "fatal": False, "error": "未执行"}
        for i in range(max(1, attempts)):
            if self._session is None or self._session.closed:
                self._session = make_session(self._sessdata)
            last = await fetch_room_info(self._session, self._room_id)
            if last.get("ok") or last.get("fatal"):
                return last
            if i + 1 < attempts:
                await asyncio.sleep(min(2.0, 1.0 * (i + 1)))
        return last

    def _apply_info(self, info: Dict[str, Any]) -> None:
        if info.get("title"):
            self._room_title = str(info["title"])
        if info.get("room_id"):
            self._room_id = int(info["room_id"])
        status = info.get("live_status")
        self._room_live = (status == 1) if status is not None else self._room_live

    def _start_client(self) -> None:
        assert self._session is not None
        old = self._client
        self._client = None
        if old is not None:
            try:
                old.stop()
            except Exception as exc:  # noqa: BLE001
                logger.debug("停止旧弹幕客户端失败：%s", exc)
        client = blivedm.BLiveClient(self._room_id, session=self._session, heartbeat_interval=30)
        client.set_handler(self._handler)
        # 指数退避：1s → 2s → 4s → 8s → 16s → 30s（封顶）
        client.set_reconnect_policy(
            lambda retry_count, _total: min(RECONNECT_MAX_DELAY, float(2 ** max(0, retry_count - 1)))
        )
        client.start()
        self._client = client

    async def _wait_connected(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._connected:
                return True
            client = self._client
            if client is None or not client.is_running:
                return False
            await asyncio.sleep(0.1)
        return self._connected

    def _ensure_refresh_task(self) -> None:
        if self._refresh_task is None or self._refresh_task.done():
            self._refresh_task = asyncio.ensure_future(self._refresh_loop())

    async def _refresh_loop(self) -> None:
        try:
            while not self._closing:
                await asyncio.sleep(ROOM_INFO_REFRESH)
                if self._closing:
                    return
                try:
                    await self.refresh_room_info()
                except Exception as e:  # noqa: BLE001
                    logger.debug("刷新房间信息失败：%s", e)
        except asyncio.CancelledError:
            raise

    # ------------------------------------------------------- blivedm 回调
    def _handle_heartbeat(self, message: web_models.HeartbeatMessage) -> None:
        if self._connected:
            return
        self._connected = True
        self._fatal_attempts = 0
        self._on_state(STATE_CONNECTED, self._room_id, self._room_title, self._room_live)

    def _handle_client_stopped(self, client, exception: Optional[BaseException]) -> None:
        if client is not self._client:
            # A reconnect or a new room has already replaced this client.
            return
        self._connected = False
        if self._closing:
            return
        fatal = isinstance(exception, (InitError, RuntimeError, ValueError, KeyError)) if exception else False
        if fatal:
            self._fatal_attempts += 1
        if exception is not None and not isinstance(exception, asyncio.CancelledError):
            self._on_error(
                "连接中断：%s: %s" % (type(exception).__name__, exception),
                {"room_id": self._room_id, "fatal": fatal},
            )
        else:
            self._on_error("连接已断开", {"room_id": self._room_id, "fatal": False})

        if self._fatal_attempts >= MAX_FATAL_RETRY:
            self._on_error(
                "重试 %d 次仍无法连接，已停止重连" % MAX_FATAL_RETRY,
                {"room_id": self._room_id, "fatal": True, "give_up": True},
            )
            self._on_state(STATE_ERROR, self._room_id, self._room_title, self._room_live)
            return
        self._schedule_reconnect()

    def _schedule_reconnect(self) -> None:
        if self._closing:
            return
        if self._reconnect_task is not None and not self._reconnect_task.done():
            return
        self._on_state(STATE_CONNECTING, self._room_id, self._room_title, self._room_live)
        self._reconnect_task = asyncio.ensure_future(self._reconnect_loop())

    async def _reconnect_loop(self) -> None:
        delay = 1.0
        try:
            while not self._closing:
                await asyncio.sleep(delay)
                if self._closing:
                    return
                self._on_state(STATE_CONNECTING, self._room_id, self._room_title, self._room_live)
                info = await self._fetch_info(attempts=2)
                if info.get("fatal"):
                    self._fatal_attempts += 1
                    self._on_error(
                        "重连失败：%s" % info.get("error"),
                        {"room_id": self._room_id, "attempt": self._fatal_attempts, "fatal": True},
                    )
                    if self._fatal_attempts >= MAX_FATAL_RETRY:
                        self._on_error(
                            "重试 %d 次仍无法连接，已停止重连" % MAX_FATAL_RETRY,
                            {"room_id": self._room_id, "fatal": True, "give_up": True},
                        )
                        self._on_state(STATE_ERROR, self._room_id, self._room_title, self._room_live)
                        return
                else:
                    if info.get("ok"):
                        self._apply_info(info)
                    try:
                        self._start_client()
                    except Exception as e:  # noqa: BLE001
                        self._on_error("重连失败：%s" % e, {"room_id": self._room_id})
                    else:
                        if await self._wait_connected(HEARTBEAT_WAIT):
                            logger.info("room=%d 重连成功", self._room_id)
                            return
                        if self._fatal_attempts >= MAX_FATAL_RETRY:
                            self._on_error(
                                "重试 %d 次仍无法连接，已停止重连" % MAX_FATAL_RETRY,
                                {"room_id": self._room_id, "fatal": True, "give_up": True},
                            )
                            self._on_state(
                                STATE_ERROR, self._room_id, self._room_title, self._room_live
                            )
                            return
                delay = min(RECONNECT_MAX_DELAY, delay * 2)
        except asyncio.CancelledError:
            raise

    # -------------------------------------------------------- 消息归一化
    def _handle_danmaku(self, message: web_models.DanmakuMessage) -> None:
        self._on_message(
            "danmaku",
            {
                "user": message.uname or "",
                "uid": int(message.uid or 0),
                "text": message.msg or "",
                "meta": {
                    "mirror": bool(getattr(message, "is_mirror", False)),
                    "medal": message.medal_name or "",
                    "medal_level": int(message.medal_level or 0),
                },
            },
        )

    def _handle_gift(self, message: web_models.GiftMessage) -> None:
        self._on_message(
            "gift",
            {
                "user": message.uname or "",
                "uid": int(message.uid or 0),
                "text": message.gift_name or "礼物",
                "meta": {
                    "gift_name": message.gift_name or "礼物",
                    "num": int(message.num or 0),
                    "price": int(message.price or 0),
                    "total_coin": int(message.total_coin or 0),
                    "coin_type": message.coin_type or "",
                    "guard_level": int(message.guard_level or 0),
                },
            },
        )

    def _handle_super_chat(self, message: web_models.SuperChatMessage) -> None:
        self._on_message(
            "super_chat",
            {
                "user": message.uname or "",
                "uid": int(message.uid or 0),
                "text": message.message or "",
                "meta": {
                    "price": int(message.price or 0),
                    "guard_level": int(message.guard_level or 0),
                },
            },
        )

    def _handle_guard(self, username: str, uid: Any, level: Any, num: Any, price: Any, unit: str) -> None:
        try:
            level_i = int(level or 0)
        except (TypeError, ValueError):
            level_i = 0
        if level_i not in GUARD_NAMES:
            return
        key = (int(uid or 0), level_i, int(num or 0))
        now = time.monotonic()
        last = self._guard_seen.get(key)
        if last is not None and now - last < GUARD_DEDUP_SECONDS:
            return
        self._guard_seen[key] = now
        if len(self._guard_seen) > 200:
            for k, ts in list(self._guard_seen.items()):
                if now - ts > GUARD_DEDUP_SECONDS:
                    self._guard_seen.pop(k, None)
        name = _guard_name(level_i)
        self._on_message(
            "guard",
            {
                "user": username or "",
                "uid": int(uid or 0),
                "text": name,
                "meta": {
                    "guard_level": level_i,
                    "guard_name": name,
                    "num": int(num or 0),
                    "price": int(price or 0),
                    "unit": unit or "月",
                },
            },
        )

    def _handle_interact(self, message: web_models.InteractWordV2Message) -> None:
        # msg_type: 1=进入直播间，2=关注，3=分享
        msg_type = int(message.msg_type or 0)
        if msg_type == 1:
            self._on_message(
                "enter",
                {
                    "user": message.username or "",
                    "uid": int(message.uid or 0),
                    "text": "",
                    "meta": {"msg_type": msg_type},
                },
            )
            return
        if msg_type not in (2, 3, 4, 5):
            return
        action = "分享了直播间" if msg_type == 3 else "关注了直播间"
        self._on_message(
            "social",
            {
                "user": message.username or "",
                "uid": int(message.uid or 0),
                "text": action,
                "meta": {
                    "msg_type": msg_type,
                    "social_action": action,
                    "follow_type": "special" if msg_type == 4 else (
                        "mutual" if msg_type == 5 else "normal"
                    ),
                },
            },
        )
