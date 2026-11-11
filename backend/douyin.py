# -*- coding: utf-8 -*-
"""抖音网页直播 adapter（公开弹幕 + 可选登录态）。

当前使用抖音网页端的短轮询接口，不依赖浏览器或 WebSocket 签名：

1. 从 ``live.douyin.com`` 获取匿名 ``ttwid``；
2. 用 ``web_rid`` 查询房间信息和内部 ``room_id``；
3. 轮询 ``/webcast/im/fetch/`` 的 protobuf 消息；
4. 把弹幕 / 礼物 / 入场映射成 ReadMe 现有五类消息。

登录 Cookie 由宿主进程的 WebView2 登录窗口获取，经 DPAPI 保存后通过
``cookie`` 参数传入；adapter 只把它拼进请求头，不写日志、不下发给前端。

抖音金额以“钻石”计价，和 B 站人民币口径不可直接比较；这里只保留
``diamond_count``，不写入 ``price`` / ``total_coin``，历史层继续按平台能力
显示“不可比”。
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import random
import re
import time
import urllib.parse
from typing import Any, Callable, Deque, Dict, Optional, Set, Tuple

import aiohttp

from .danmaku import (
    STATE_CONNECTED,
    STATE_CONNECTING,
    STATE_DISCONNECTED,
    STATE_ERROR,
)
from .douyin_protobuf import normalize_message, parse_response

logger = logging.getLogger("danmaku_tts.douyin")

HOME_URL = "https://live.douyin.com/"
ROOM_ENTER_URL = "https://live.douyin.com/webcast/room/web/enter/"
IM_FETCH_URL = "https://live.douyin.com/webcast/im/fetch/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0"
)
REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://live.douyin.com/",
}
POLL_MIN_DELAY = 0.35
POLL_MAX_DELAY = 3.0
OPEN_WAIT_SECONDS = 8.0
MAX_SEEN_IDS = 3000
LOGIN_COOKIE_NAMES = ("sessionid", "sessionid_ss", "sid_guard")


def _cookie_value(cookie_header: str, name: str) -> str:
    for part in str(cookie_header or "").split(";"):
        key, sep, value = part.strip().partition("=")
        if sep and key == name:
            return value
    return ""


def merge_cookie_header(ttwid: str, cookie: str = "") -> str:
    """合并已登录 Cookie 与当前匿名 ttwid，按名称去重。"""
    parts: list[str] = []
    seen: set[str] = set()
    for source in (cookie or "", ("ttwid=" + ttwid) if ttwid else ""):
        for raw in source.split(";"):
            item = raw.strip()
            if not item or "=" not in item:
                continue
            name = item.split("=", 1)[0].strip()
            if not name or name in seen:
                continue
            seen.add(name)
            parts.append(item)
    return "; ".join(parts)


def cookie_header_from_webview(cookies: Any) -> str:
    """把 pywebview ``get_cookies()`` 的结果转成 Cookie 请求头。"""
    if not isinstance(cookies, list):
        return ""
    values: Dict[str, str] = {}
    for item in cookies:
        pairs = []
        if isinstance(item, dict) and "name" in item:
            pairs = [(str(item.get("name") or ""), str(item.get("value") or ""), str(item.get("domain") or ""))]
        elif hasattr(item, "items"):
            try:
                pairs = [
                    (str(name), str(morsel.value), str(morsel.get("domain") or ""))
                    for name, morsel in item.items()
                ]
            except Exception:  # noqa: BLE001
                continue
        for name, value, domain in pairs:
            name = name.strip()
            domain = domain.lstrip(".").lower()
            if not name or not value:
                continue
            if domain and "douyin.com" not in domain:
                continue
            values[name] = value
    return "; ".join("%s=%s" % (name, value) for name, value in values.items())


def cookie_value(cookie_header: str, name: str) -> str:
    return _cookie_value(cookie_header, name)


def has_login_cookie(cookies: Any) -> bool:
    if not isinstance(cookies, list):
        return False
    pairs = []
    for item in cookies:
        if isinstance(item, dict) and "name" in item:
            pairs.append((str(item.get("name") or ""), str(item.get("value") or "")))
        elif hasattr(item, "items"):
            try:
                pairs.extend(
                    (str(name), str(morsel.value))
                    for name, morsel in item.items()
                )
            except Exception:  # noqa: BLE001
                continue
    for name, value in pairs:
        if name in LOGIN_COOKIE_NAMES and value:
            return True
    return False


def _numeric_web_rid(value: Any) -> str:
    text = str(value or "").strip()
    if text.isdigit() and text:
        return text
    return ""


def parse_room_input(value: Any) -> Dict[str, str]:
    """从直播间号、完整 URL 或短链接中提取 web_rid / URL。"""
    raw = str(value or "").strip()
    if not raw:
        return {"web_rid": "", "url": ""}
    direct = _numeric_web_rid(raw)
    if direct:
        return {"web_rid": direct, "url": ""}

    match = re.search(r"https?://[^\s]+", raw, re.IGNORECASE)
    url = match.group(0) if match else ""
    if not url and raw.lower().startswith(("live.douyin.com/", "v.douyin.com/")):
        url = "https://" + raw
    if url:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or "").lower()
        query = urllib.parse.parse_qs(parsed.query)
        for key in ("web_rid", "room_id"):
            candidate = _numeric_web_rid((query.get(key) or [""])[0])
            if candidate:
                return {"web_rid": candidate, "url": url}
        path_parts = [part for part in parsed.path.split("/") if part]
        # webcast.amemv.com/douyin/webcast/reflow/<内部 room_id> 不是 web_rid，
        # 需要由 resolve_web_rid 读取页面里的 webRid 字段。
        if host.endswith("webcast.amemv.com") and "reflow" in path_parts:
            return {"web_rid": "", "url": url}
        for part in path_parts:
            candidate = _numeric_web_rid(part)
            if candidate:
                return {"web_rid": candidate, "url": url}
        return {"web_rid": "", "url": url}

    # 兼容“房间号/昵称”这种非 URL 输入的最后一段数字。
    tail = raw.rsplit("/", 1)[-1]
    tail = _numeric_web_rid(tail)
    return {"web_rid": tail, "url": ""}


def web_rid_from_reflow_html(html: str) -> str:
    """从 webcast reflow 页面提取真正的 webRid（页面 JSON 可能带转义）。"""
    match = re.search(r'webRid\\?"\s*:\s*\\?"(\d+)', str(html or ""))
    return match.group(1) if match else ""


def _ttwid_from_jar(session: aiohttp.ClientSession) -> str:
    try:
        jar = session.cookie_jar.filter_cookies(HOME_URL)
        morsel = jar.get("ttwid")
        return str(morsel.value if morsel is not None else "")
    except Exception:  # noqa: BLE001
        pass
    try:
        for cookie in session.cookie_jar:
            if cookie.key == "ttwid":
                return str(cookie.value)
    except Exception:  # noqa: BLE001
        pass
    return ""


async def ensure_ttwid(session: aiohttp.ClientSession, value: str = "", cookie: str = "") -> str:
    if value:
        return value
    from_cookie = _cookie_value(cookie, "ttwid")
    if from_cookie:
        return from_cookie
    existing = _ttwid_from_jar(session)
    if existing:
        return existing
    headers = dict(REQUEST_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    try:
        async with session.get(
            HOME_URL,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as response:
            await response.read()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("获取抖音 ttwid 失败：%s" % exc) from exc
    ttwid = _ttwid_from_jar(session)
    if not ttwid:
        raise RuntimeError("抖音未返回 ttwid")
    return ttwid


async def resolve_web_rid(
    session: aiohttp.ClientSession,
    value: Any,
    *,
    cookie: str = "",
    ttwid: str = "",
) -> str:
    parsed = parse_room_input(value)
    if parsed["web_rid"]:
        return parsed["web_rid"]
    url = parsed.get("url") or ""
    if not url:
        return ""
    headers = dict(REQUEST_HEADERS)
    if cookie or ttwid:
        headers["Cookie"] = merge_cookie_header(ttwid, cookie)
    try:
        async with session.get(
            url,
            headers=headers,
            allow_redirects=True,
            max_redirects=5,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as response:
            final_url = str(response.url)
            html = await response.text(errors="ignore")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("解析抖音房间链接失败：%s" % exc) from exc
    # 直播分享短链会跳到 webcast.amemv.com/.../reflow/<内部 room_id>，
    # 页面内带有真正的 webRid，可直接用于房间接口。
    reflow_web_rid = web_rid_from_reflow_html(html)
    if reflow_web_rid:
        logger.info(
            "抖音短链解析成功：web_rid=%s（来源=reflow 页面，页面 %d 字节）",
            reflow_web_rid,
            len(html),
        )
        return reflow_web_rid
    fallback = parse_room_input(final_url)["web_rid"]
    logger.warning(
        "抖音短链解析：reflow 页面未找到 webRid，回退按链接取号 -> web_rid=%s"
        "（页面 %d 字节，final=%s）",
        fallback or "(空)",
        len(html),
        final_url.split("?")[0],
    )
    return fallback


async def fetch_room_info(
    session: aiohttp.ClientSession,
    web_rid: str,
    ttwid: str,
    timeout: float = 12.0,
    cookie: str = "",
) -> Dict[str, Any]:
    """查询公开房间信息。status=2 表示正在直播，4 表示已结束。"""
    web_rid = _numeric_web_rid(web_rid)
    result: Dict[str, Any] = {
        "ok": False,
        "fatal": False,
        "web_rid": web_rid,
        "room_id": int(web_rid) if web_rid else 0,
        "room_key": web_rid,
        "internal_room_id": "",
        "title": None,
        "live_status": None,
        "room_live": None,
        "user_count": None,
        "error": None,
    }
    if not web_rid:
        result["fatal"] = True
        result["error"] = "缺少抖音直播间号"
        return result

    params = {
        "aid": "6383",
        "app_name": "douyin_web",
        "live_id": "1",
        "device_platform": "web",
        "language": "zh-CN",
        "enter_from": "web_live",
        "cookie_enabled": "true",
        "screen_width": "1280",
        "screen_height": "720",
        "browser_language": "zh-CN",
        "browser_platform": "Win32",
        "browser_name": "Mozilla",
        "browser_version": USER_AGENT,
        "web_rid": web_rid,
    }
    headers = dict(REQUEST_HEADERS)
    headers["Referer"] = "https://live.douyin.com/%s" % web_rid
    headers["Cookie"] = merge_cookie_header(ttwid, cookie)
    try:
        async with session.get(
            ROOM_ENTER_URL,
            params=params,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as response:
            http_status = response.status
            raw = await response.read()
            if http_status != 200:
                result["error"] = "HTTP %s" % http_status
                logger.warning(
                    "抖音房间接口 HTTP %s：web_rid=%s（解析已成功，是接口请求失败）",
                    http_status,
                    web_rid,
                )
                return result
    except asyncio.TimeoutError:
        result["error"] = "请求超时"
        logger.warning("抖音房间接口超时：web_rid=%s", web_rid)
        return result
    except Exception as exc:  # noqa: BLE001
        result["error"] = "%s: %s" % (type(exc).__name__, exc)
        logger.warning("抖音房间接口异常：web_rid=%s %s: %s", web_rid, type(exc).__name__, exc)
        return result

    if not raw:
        result["fatal"] = True
        result["error"] = "抖音房间接口返回空响应（可能触发风控）"
        logger.warning(
            "抖音房间接口返回空响应：web_rid=%s http=%s ttwid=%s cookie=%s"
            "（web_rid 已解析成功，说明卡在房间接口请求，不是房间号问题）",
            web_rid,
            http_status,
            "有" if ttwid else "无",
            "有" if cookie else "无",
        )
        return result
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        result["error"] = "抖音房间接口返回非 JSON：%s" % exc
        logger.warning(
            "抖音房间接口返回非 JSON：web_rid=%s 长度=%d %s",
            web_rid,
            len(raw),
            exc,
        )
        return result
    status_code = payload.get("status_code") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or str(status_code) not in ("None", "0", ""):
        detail = ""
        if isinstance(payload, dict):
            data_node = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            detail = str(
                data_node.get("message")
                or data_node.get("prompts")
                or payload.get("message")
                or ""
            ).strip()
        result["fatal"] = True
        result["error"] = "抖音房间接口返回异常" + (
            "：%s" % detail if detail else
            ("（status_code=%s）" % status_code if status_code is not None else "")
        )
        logger.warning(
            "抖音房间接口返回异常：web_rid=%s status_code=%s detail=%s",
            web_rid,
            status_code,
            detail or "-",
        )
        return result
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    rooms = data.get("data") if isinstance(data.get("data"), list) else []
    room = next((item for item in rooms if isinstance(item, dict)), None)
    if not isinstance(room, dict):
        result["fatal"] = True
        result["error"] = "抖音直播间不存在或已关闭"
        logger.warning(
            "抖音直播间不存在：web_rid=%s status_code=%s rooms=%d"
            "（web_rid 格式合法但查不到房间，多为链接解析到了错误的号）",
            web_rid,
            status_code,
            len(rooms),
        )
        return result

    status = room.get("status")
    try:
        status_int = int(status)
    except (TypeError, ValueError):
        status_int = None
    result.update(
        ok=True,
        internal_room_id=str(room.get("id_str") or room.get("id") or ""),
        title=str(room.get("title") or "").strip() or None,
        live_status=status_int,
        room_live=status_int == 2,
        user_count=str(room.get("user_count_str") or "").strip() or None,
    )
    logger.info(
        "抖音房间就绪：web_rid=%s internal=%s live=%s title=%s online=%s",
        web_rid,
        result["internal_room_id"],
        result["room_live"],
        result["title"],
        result["user_count"],
    )
    return result


class DouyinConnection:
    """抖音直播间连接：房间查询 + 短轮询 + 消息归一化。"""

    def __init__(
        self,
        on_message: Callable[[str, Dict[str, Any]], None],
        on_state: Callable[[str, int, Optional[str], Optional[bool]], None],
        on_error: Callable[[str, Dict[str, Any]], None],
        ttwid: str = "",
        cookie: str = "",
    ):
        self._on_message = on_message
        self._on_state = on_state
        self._on_error = on_error
        self._ttwid = str(ttwid or "")
        self._cookie = str(cookie or "")
        self._session: Optional[aiohttp.ClientSession] = None
        self._poll_task: Optional[asyncio.Task] = None
        self._closing = True
        self._connected = False
        self._opened = asyncio.Event()
        self._web_rid = ""
        self._room_id = 0
        self._internal_room_id = ""
        self._room_title: Optional[str] = None
        self._room_live: Optional[bool] = None
        self._cursor = ""
        self._internal_ext = ""
        self._last_rtt = 0
        self._user_unique_id = str(random.randint(10 ** 18, 10 ** 19 - 1))
        self._seen_ids: Set[int] = set()
        self._seen_order: Deque[int] = collections.deque()
        self._empty_polls = 0
        self._room_closed = False

    @property
    def web_rid(self) -> str:
        return self._web_rid

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

    def set_ttwid(self, value: str) -> None:
        self._ttwid = str(value or "")

    def set_cookie(self, value: str) -> None:
        self._cookie = str(value or "")

    async def open(self, room: Any) -> Dict[str, Any]:
        await self.close()
        self._closing = False
        self._connected = False
        self._opened.clear()
        self._cursor = ""
        self._internal_ext = ""
        self._last_rtt = 0
        self._empty_polls = 0
        self._room_closed = False
        self._seen_ids.clear()
        self._seen_order.clear()
        self._on_state(STATE_CONNECTING, 0, None, None)

        try:
            if self._session is None or self._session.closed:
                self._session = aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=30),
                    trust_env=True,
                )
            self._ttwid = await ensure_ttwid(self._session, self._ttwid, self._cookie)
            self._web_rid = await resolve_web_rid(
                self._session, room, cookie=self._cookie, ttwid=self._ttwid
            )
            if not self._web_rid:
                parsed_input = parse_room_input(room)
                if parsed_input.get("url"):
                    raise RuntimeError(
                        "抖音短链接无法解析为直播间，请重新复制直播间链接，"
                        "或直接输入 live.douyin.com/<房间号>"
                    )
                raise RuntimeError("需要抖音直播间号或 live.douyin.com 链接")
            try:
                self._room_id = int(self._web_rid)
            except (TypeError, ValueError):
                self._room_id = 0
            info = await fetch_room_info(self._session, self._web_rid, self._ttwid, cookie=self._cookie)
            if not info.get("ok"):
                error = str(info.get("error") or "抖音房间信息获取失败")
                self._on_error(error, {"stage": "room_info", "fatal": bool(info.get("fatal"))})
                self._on_state(STATE_ERROR, self._room_id, None, None)
                await self._close_session()
                return {"ok": False, "error": error, "room_id": self._room_id}
            self._internal_room_id = str(info.get("internal_room_id") or "")
            self._room_title = info.get("title")
            self._room_live = bool(info.get("room_live"))
            if not self._internal_room_id:
                error = "抖音房间缺少内部 room_id"
                self._on_error(error, {"stage": "room_info"})
                self._on_state(STATE_ERROR, self._room_id, None, None)
                await self._close_session()
                return {"ok": False, "error": error, "room_id": self._room_id}
            self._on_state(
                STATE_CONNECTING,
                self._room_id,
                self._room_title,
                self._room_live,
            )
            if not self._room_live:
                error = "抖音直播间当前未开播"
                self._on_error(error, {"stage": "room_info", "fatal": False})
                self._on_state(STATE_ERROR, self._room_id, self._room_title, False)
                await self._close_session()
                return {
                    "ok": False,
                    "error": error,
                    "room_id": self._room_id,
                    "room_key": self._web_rid,
                    "platform": "douyin",
                }
        except Exception as exc:  # noqa: BLE001
            error = str(exc) if isinstance(exc, RuntimeError) else "%s: %s" % (
                type(exc).__name__, exc
            )
            self._on_error(error, {"stage": "open"})
            self._on_state(STATE_ERROR, self._room_id, None, None)
            await self._close_session()
            return {"ok": False, "error": error, "room_id": self._room_id}

        self._poll_task = asyncio.ensure_future(self._poll_loop())
        try:
            await asyncio.wait_for(self._opened.wait(), timeout=OPEN_WAIT_SECONDS)
        except asyncio.TimeoutError:
            # 第一次轮询可能比房间查询慢；保留连接任务，由后续轮询续上。
            logger.info("抖音首次轮询尚未返回，连接继续后台进行")
        return {
            "ok": True,
            "room_id": self._room_id,
            "room_key": self._web_rid,
            "room_title": self._room_title,
            "room_live": self._room_live,
            "connected": self._connected,
            "platform": "douyin",
        }

    async def close(self) -> None:
        self._closing = True
        task, self._poll_task = self._poll_task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as exc:  # noqa: BLE001
                logger.debug("取消抖音轮询异常：%s", exc)
        await self._close_session()
        self._connected = False
        self._opened.set()
        self._on_state(STATE_DISCONNECTED, self._room_id, self._room_title, self._room_live)

    async def _close_session(self) -> None:
        session, self._session = self._session, None
        if session is not None and not session.closed:
            try:
                await session.close()
            except Exception as exc:  # noqa: BLE001
                logger.debug("关闭抖音 aiohttp 会话异常：%s", exc)

    async def _poll_loop(self) -> None:
        delay = POLL_MIN_DELAY
        try:
            while not self._closing and not self._room_closed:
                try:
                    response = await self._poll_once()
                except asyncio.CancelledError:
                    raise
                except asyncio.TimeoutError:
                    # 长轮询在直播间安静时本来就会超时，不应记为刷屏错误。
                    if self._closing:
                        raise
                    self._empty_polls += 1
                    if self._empty_polls == 1:
                        self._opened.set()
                    if not self._connected:
                        self._connected = True
                        self._on_state(
                            STATE_CONNECTED,
                            self._room_id,
                            self._room_title,
                            self._room_live,
                        )
                    delay = max(POLL_MIN_DELAY, min(1.2, delay))
                    logger.debug("抖音长轮询空闲超时，继续下一轮")
                except Exception as exc:  # noqa: BLE001
                    self._connected = False
                    self._opened.set()
                    if not self._closing:
                        self._on_state(
                            STATE_CONNECTING,
                            self._room_id,
                            self._room_title,
                            self._room_live,
                        )
                        self._on_error(
                            "抖音弹幕拉取中断：%s: %s" % (type(exc).__name__, exc),
                            {"stage": "poll", "room_id": self._room_id},
                        )
                    delay = min(30.0, max(1.0, delay * 2))
                else:
                    if response is None:
                        self._empty_polls += 1
                        if self._empty_polls == 1:
                            self._opened.set()
                        if not self._connected:
                            self._connected = True
                            self._on_state(
                                STATE_CONNECTED,
                                self._room_id,
                                self._room_title,
                                self._room_live,
                            )
                        delay = max(POLL_MIN_DELAY, min(1.2, delay))
                    else:
                        self._empty_polls = 0
                        if not self._connected:
                            self._connected = True
                            self._opened.set()
                            self._on_state(
                                STATE_CONNECTED,
                                self._room_id,
                                self._room_title,
                                self._room_live,
                            )
                        interval = float(response.get("fetch_interval") or 0) / 1000.0
                        if interval <= 0:
                            interval = POLL_MIN_DELAY
                        delay = max(POLL_MIN_DELAY, min(POLL_MAX_DELAY, interval))
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            raise
        finally:
            self._connected = False
            self._opened.set()

    async def _poll_once(self) -> Optional[Dict[str, Any]]:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=30),
                trust_env=True,
            )
        self._ttwid = await ensure_ttwid(self._session, self._ttwid, self._cookie)
        params = {
            "resp_content_type": "protobuf",
            "did_rule": "3",
            "device_id": "",
            "app_name": "douyin_web",
            "endpoint": "live_pc",
            "support_wrds": "1",
            "user_unique_id": self._user_unique_id,
            "identity": "audience",
            "need_persist_msg_count": "15",
            "insert_task_id": "",
            "live_reason": "",
            "room_id": self._internal_room_id,
            "version_code": "180800",
            "last_rtt": str(self._last_rtt),
            "live_id": "1",
            "aid": "6383",
            "fetch_rule": "1",
            "cursor": self._cursor,
            "internal_ext": self._internal_ext,
            "device_platform": "web",
            "cookie_enabled": "true",
            "screen_width": "1280",
            "screen_height": "720",
            "browser_language": "zh-CN",
            "browser_platform": "Win32",
            "browser_name": "Mozilla",
            "browser_version": USER_AGENT,
            "browser_online": "true",
            "tz_name": "Asia/Shanghai",
        }
        headers = dict(REQUEST_HEADERS)
        headers.update(
            {
                "Accept": "application/protobuffer",
                "Origin": "https://live.douyin.com",
                "Referer": "https://live.douyin.com/%s" % self._web_rid,
                "Cookie": merge_cookie_header(self._ttwid, self._cookie),
            }
        )
        started = time.monotonic()
        async with self._session.get(
            IM_FETCH_URL,
            params=params,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=25),
        ) as response:
            raw = await response.read()
            if response.status != 200:
                raise RuntimeError("抖音弹幕接口 HTTP %s" % response.status)
        self._last_rtt = max(0, int((time.monotonic() - started) * 1000))
        if not raw:
            return None
        parsed = parse_response(raw)
        self._cursor = str(parsed.get("cursor") or self._cursor)
        self._internal_ext = str(parsed.get("internal_ext") or self._internal_ext)
        for message in parsed.get("messages") or []:
            self._handle_message(message)
            if self._room_closed:
                break
        return parsed

    def _handle_message(self, message: Dict[str, Any]) -> None:
        message_id = int(message.get("message_id") or 0)
        if message_id:
            if message_id in self._seen_ids:
                return
            self._seen_ids.add(message_id)
            self._seen_order.append(message_id)
            while len(self._seen_order) > MAX_SEEN_IDS:
                old = self._seen_order.popleft()
                self._seen_ids.discard(old)

        method = str(message.get("method") or "")
        payload = message.get("payload") or b""
        if method == "WebcastControlMessage":
            self._handle_control(payload)
            return
        normalized = normalize_message(method, payload, message_id)
        if normalized is None:
            return
        kind, body = normalized
        self._on_message(kind, body)

    def _handle_control(self, payload: bytes) -> None:
        try:
            from .douyin_protobuf import as_int, first, parse_fields

            status = as_int(first(parse_fields(payload), 2))
        except Exception:  # noqa: BLE001
            return
        if status == 3:
            self._room_live = False
            self._room_closed = True
            self._on_state(
                STATE_DISCONNECTED,
                self._room_id,
                self._room_title,
                False,
            )

