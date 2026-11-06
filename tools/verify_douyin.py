#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抖音 adapter 的离线契约测试（可选 --live 做真实房间探活）。"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import sys
import tempfile
import time
from http.cookies import SimpleCookie
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.douyin import (  # noqa: E402
    DouyinConnection,
    cookie_header_from_webview,
    cookie_value,
    has_login_cookie,
    merge_cookie_header,
    parse_room_input,
    resolve_web_rid,
)
from backend.config import ConfigStore  # noqa: E402
from backend.core import DanmakuTTSService  # noqa: E402
from backend.sessions import SessionStore  # noqa: E402
from backend.douyin_protobuf import (  # noqa: E402
    normalize_message,
    parse_fields,
    parse_response,
)

PASS = 0
FAIL = 0


def check(condition: bool, label: str, detail=None) -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  " + label)
        return
    FAIL += 1
    print("FAIL  " + label + (("  " + repr(detail)) if detail is not None else ""))


def varint(value: int) -> bytes:
    value = int(value)
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def field_varint(number: int, value: int) -> bytes:
    return varint(number << 3) + varint(value)


def field_bytes(number: int, value: bytes | str) -> bytes:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return varint((number << 3) | 2) + varint(len(value)) + value


def make_user(uid: int = 123456, name: str = "测试用户") -> bytes:
    avatar = field_bytes(1, "https://example.invalid/avatar.jpg")
    return (
        field_varint(1, uid)
        + field_varint(2, 987)
        + field_bytes(3, name)
        + field_bytes(9, avatar)
        + field_bytes(46, "sec-test")
    )


def make_message(method: str, payload: bytes, message_id: int) -> bytes:
    return field_bytes(1, method) + field_bytes(2, payload) + field_varint(3, message_id)


def make_response(*messages: bytes, cursor: str = "", internal_ext: str = "") -> bytes:
    body = b"".join(field_bytes(1, item) for item in messages)
    body += field_bytes(2, cursor)
    body += field_bytes(5, internal_ext)
    return body


def test_protobuf() -> None:
    chat_payload = (
        field_bytes(1, field_varint(2, 1001) + field_varint(3, 42))
        + field_bytes(2, make_user())
        + field_bytes(3, "你好，抖音")
        + field_varint(15, 1_700_000_000)
    )
    raw = make_response(
        make_message("WebcastChatMessage", chat_payload, 9001),
        cursor="cursor-1",
        internal_ext="ext-1",
    )
    parsed = parse_response(raw)
    check(parsed["cursor"] == "cursor-1", "解析 cursor")
    check(parsed["internal_ext"] == "ext-1", "解析 internal_ext")
    check(len(parsed["messages"]) == 1, "解析消息数量")
    kind, body = normalize_message(
        parsed["messages"][0]["method"],
        parsed["messages"][0]["payload"],
        parsed["messages"][0]["message_id"],
    )
    check(kind == "danmaku", "弹幕类型映射", kind)
    check(body and body["user"] == "测试用户", "弹幕用户名", body)
    check(body and body["text"] == "你好，抖音", "弹幕正文", body)
    check(body and body["meta"]["avatar"].startswith("https://"), "头像解析", body)
    check(body and body["meta"]["message_id"] == 9001, "原生消息 ID", body)

    gift = (
        field_varint(6, 3)
        + field_bytes(7, make_user(2222, "送礼人"))
        + field_bytes(15, field_varint(5, 88) + field_varint(12, 10) + field_bytes(16, "小心心"))
    )
    kind, body = normalize_message("WebcastGiftMessage", gift, 9002)
    check(kind == "gift", "礼物类型映射", kind)
    check(body and body["user"] == "送礼人", "礼物用户名", body)
    check(body and body["meta"]["gift_name"] == "小心心", "礼物名称", body)
    check(body and body["meta"]["num"] == 3, "礼物数量", body)
    check(body and body["meta"]["diamond_count"] == 10, "礼物钻石值", body)
    check(body and body["meta"]["price"] == 0, "礼物不伪造人民币", body)

    member = field_bytes(2, make_user(3333, "进场人"))
    kind, body = normalize_message("WebcastMemberMessage", member, 9003)
    check(kind == "enter", "入场类型映射", kind)
    check(body and body["user"] == "进场人", "入场用户名", body)

    like = (
        field_bytes(5, make_user(4444, "点赞人"))
        + field_varint(2, 7)
        + field_varint(3, 120)
    )
    kind, body = normalize_message("WebcastLikeMessage", like, 9005)
    check(kind == "like", "点赞类型映射", kind)
    check(body and body["user"] == "点赞人", "点赞用户名", body)
    check(body and body["meta"]["like_count"] == 7, "点赞数量", body)

    social = field_bytes(2, make_user(5555, "关注人")) + field_varint(4, 1)
    kind, body = normalize_message("WebcastSocialMessage", social, 9006)
    check(kind == "social", "关注类型映射", kind)
    check(body and body["meta"]["social_action"] == "关注了直播间", "关注文案", body)

    fansclub = (
        field_varint(2, 1)
        + field_bytes(3, make_user(6666, "团友"))
        + field_bytes(4, "加入了粉丝团")
    )
    kind, body = normalize_message("WebcastFansclubMessage", fansclub, 9007)
    check(kind == "fansclub", "粉丝团类型映射", kind)
    check(body and body["user"] == "团友", "粉丝团用户名", body)
    check(body and body["meta"]["fansclub_action"] == "加入了粉丝团", "粉丝团文案", body)

    compressed = gzip.compress(raw)
    check(len(parse_response(compressed)["messages"]) == 1, "兼容 gzip 响应")
    push_frame = field_bytes(8, raw)
    check(len(parse_response(push_frame)["messages"]) == 1, "兼容 PushFrame 包装")
    check(normalize_message("WebcastUnknownMessage", b"", 9004) is None, "未知类型安全忽略")
    try:
        parse_fields(b"\x0a\x05x")
        check(False, "截断 protobuf 应失败")
    except ValueError:
        check(True, "截断 protobuf 安全失败")


def test_room_input() -> None:
    check(parse_room_input("169473665515")["web_rid"] == "169473665515", "纯数字房间号")
    check(
        parse_room_input("https://live.douyin.com/169473665515?foo=1")["web_rid"]
        == "169473665515",
        "直播间 URL",
    )
    check(
        parse_room_input("live.douyin.com/169473665515")["web_rid"] == "169473665515",
        "无 scheme URL",
    )
    check(parse_room_input("https://v.douyin.com/abc")["web_rid"] == "", "短链接保留给异步解析")
    check(parse_room_input("")["web_rid"] == "", "空输入")
    check(parse_room_input("not a room")["web_rid"] == "", "非法输入")


def test_login_cookie() -> None:
    cookie = SimpleCookie()
    cookie["sessionid"] = "session-value"
    cookie["sessionid"]["domain"] = ".douyin.com"
    cookie["uid_tt"] = "42"
    cookie["uid_tt"]["domain"] = ".douyin.com"
    cookie["other"] = "skip"
    cookie["other"]["domain"] = ".example.com"
    cookies = [cookie]
    header = cookie_header_from_webview(cookies)
    check("sessionid=session-value" in header, "webview Cookie 头包含 sessionid", header)
    check("uid_tt=42" in header, "webview Cookie 头包含 uid", header)
    check("other=skip" not in header, "webview Cookie 头过滤其它域", header)
    check(has_login_cookie(cookies), "识别抖音登录 Cookie")
    check(cookie_value(header, "uid_tt") == "42", "读取 Cookie 值")
    merged = merge_cookie_header("fresh", "ttwid=old; sessionid=s")
    check(merged == "ttwid=old; sessionid=s", "ttwid 去重且保留登录 Cookie", merged)

    with tempfile.TemporaryDirectory(prefix="mutai-douyin-login-") as root:
        store = ConfigStore(root)
        plain = "sessionid=secret-session; uid_tt=42"
        check(store.set_douyin_cookie(plain), "写入抖音 Cookie")
        raw = (Path(root) / "config.legacy.json").read_text(encoding="utf-8")
        check("secret-session" not in raw, "Cookie 不以明文落盘")
        check(store.get_douyin_cookie() == plain, "重新读取抖音 Cookie")
        projected = store.project_v1()
        check("douyin_cookie_enc" not in projected, "Cookie 不进入前端投影")
        reloaded = ConfigStore(root)
        check(reloaded.get_douyin_cookie() == plain, "冷启动恢复抖音 Cookie")
        check(reloaded.set_douyin_cookie(""), "清除抖音 Cookie")
        check(reloaded.get_douyin_cookie() == "", "清除后 Cookie 为空")


async def test_short_links() -> None:
    from aiohttp import ClientSession, web

    async def ok(_request):
        return web.Response(text="ok")

    async def redirect(_request):
        raise web.HTTPFound("/live/987654321")

    async def expired(_request):
        return web.Response(status=410, text="expired")

    app = web.Application()
    app.router.add_get("/live/123456789", ok)
    app.router.add_get("/short", redirect)
    app.router.add_get("/expired", expired)
    app.router.add_get("/discover", ok)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    base = "http://127.0.0.1:%d" % port
    try:
        async with ClientSession(trust_env=False) as session:
            check(
                await resolve_web_rid(session, base + "/live/123456789") == "123456789",
                "完整链接解析",
            )
            check(
                await resolve_web_rid(session, base + "/short") == "987654321",
                "短链接跟随重定向",
            )
            check(
                await resolve_web_rid(session, base + "/expired") == "",
                "失效短链接安全返回空",
            )
            check(
                await resolve_web_rid(session, base + "/discover") == "",
                "非直播页不猜测房间号",
            )

        class TimeoutSession:
            def get(self, *_args, **_kwargs):
                raise asyncio.TimeoutError()

        try:
            await resolve_web_rid(TimeoutSession(), "https://v.douyin.com/timeout")
            check(False, "短链接超时安全失败")
        except RuntimeError as exc:
            check("解析抖音房间链接失败" in str(exc), "短链接超时安全失败", str(exc))
    finally:
        await runner.cleanup()


def test_room_end() -> None:
    states = []

    def on_state(state, room_id, title, live):
        states.append((state, room_id, title, live))

    connection = DouyinConnection(lambda *_args: None, on_state, lambda *_args: None)
    connection._room_id = 123
    connection._room_title = "结束测试"
    connection._room_live = True
    connection._handle_control(field_varint(2, 3))
    check(connection._room_live is False and connection._room_closed is True,
          "控房消息标记房间结束")
    check(states and states[-1][0] == "disconnected" and states[-1][3] is False,
          "房间结束回调携带 live=False", states)


def test_gift_read_threshold() -> None:
    read_cfg = {"gift": True, "gift_min_price": 10}
    diamond = {"gift_name": "小心心", "num": 1, "diamond_count": 88,
               "price": 0, "total_coin": 0, "coin_type": "diamond"}
    check(DanmakuTTSService._wants_read("gift", read_cfg, diamond) == (True, None),
          "抖音钻石礼物不套用人民币朗读门槛")
    check(DanmakuTTSService._wants_read(
        "gift", read_cfg, {"price": 0, "coin_type": "silver"}
    ) == (False, "gift_min_price"), "非钻石礼物仍受人民币门槛约束")
    check(DanmakuTTSService._wants_read(
        "gift", {"gift": False, "gift_min_price": 10}, diamond
    ) == (False, "disabled"), "关闭礼物朗读优先于钻石门槛")


async def test_poll_reconnect() -> None:
    states = []
    errors = []
    calls = []

    def on_state(state, room_id, title, live):
        states.append((state, room_id, title, live))

    def on_error(message, meta):
        errors.append((message, meta))

    connection = DouyinConnection(lambda *_args: None, on_state, on_error)
    connection._room_id = 123
    connection._room_title = "重连测试"
    connection._room_live = True
    connection._closing = False

    async def fake_poll_once():
        calls.append(len(calls) + 1)
        if len(calls) == 1:
            raise RuntimeError("temporary network error")
        connection._closing = True
        return {"fetch_interval": 1000}

    connection._poll_once = fake_poll_once
    real_sleep = asyncio.sleep

    async def fast_sleep(_delay):
        await real_sleep(0)

    asyncio.sleep = fast_sleep
    try:
        await asyncio.wait_for(connection._poll_loop(), timeout=2)
    finally:
        asyncio.sleep = real_sleep

    check(len(calls) >= 2, "轮询失败后继续尝试重连", calls)
    check(any(item[0] == "connecting" for item in states), "断线时回到连接中状态", states)
    check(any(item[0] == "connected" for item in states), "恢复后回到已连接状态", states)
    check(any("抖音弹幕拉取中断" in item[0] for item in errors), "断线错误可观测", errors)


async def test_poll_timeout_not_error() -> None:
    states = []
    errors = []
    calls = []

    def on_state(state, room_id, title, live):
        states.append((state, room_id, title, live))

    def on_error(message, meta):
        errors.append((message, meta))

    connection = DouyinConnection(lambda *_args: None, on_state, on_error)
    connection._room_id = 123
    connection._room_title = "超时测试"
    connection._room_live = True
    connection._closing = False

    async def fake_poll_once():
        calls.append(len(calls) + 1)
        if len(calls) == 1:
            raise asyncio.TimeoutError()
        connection._closing = True
        return {"fetch_interval": 1000}

    connection._poll_once = fake_poll_once
    real_sleep = asyncio.sleep

    async def fast_sleep(_delay):
        await real_sleep(0)

    asyncio.sleep = fast_sleep
    try:
        await asyncio.wait_for(connection._poll_loop(), timeout=2)
    finally:
        asyncio.sleep = real_sleep

    check(len(calls) >= 2, "长轮询超时后继续下一轮", calls)
    check(not errors, "长轮询空闲超时不记为错误", errors)
    check(any(item[0] == "connected" for item in states), "超时后收到消息恢复已连接状态", states)


async def test_first_empty_poll_connects() -> None:
    states = []
    errors = []
    calls = []

    def on_state(state, room_id, title, live):
        states.append((state, room_id, title, live))

    def on_error(message, meta):
        errors.append((message, meta))

    connection = DouyinConnection(lambda *_args: None, on_state, on_error)
    connection._room_id = 123
    connection._room_title = "首次空响应"
    connection._room_live = True
    connection._closing = False

    async def fake_poll_once():
        calls.append(len(calls) + 1)
        return None

    class StopLoop(Exception):
        pass

    async def stop_after_first_poll(_delay):
        raise StopLoop()

    connection._poll_once = fake_poll_once
    real_sleep = asyncio.sleep
    asyncio.sleep = stop_after_first_poll
    try:
        try:
            await asyncio.wait_for(connection._poll_loop(), timeout=2)
        except StopLoop:
            pass
    finally:
        asyncio.sleep = real_sleep

    check(calls == [1], "首次空响应只轮询一次", calls)
    check(connection._empty_polls == 1, "首次空响应计入空闲轮询", connection._empty_polls)
    check(any(item[0] == "connected" for item in states),
          "首次空响应即进入已连接状态", states)
    check(not errors, "首次空响应不记错误", errors)


def test_service_account() -> None:
    with tempfile.TemporaryDirectory(prefix="mutai-douyin-service-") as root:
        service = DanmakuTTSService(root)
        try:
            before = service.get_state()["account"]["douyin"]
            check(not before["logged_in"], "服务初始无抖音账号")
            applied = service.apply_douyin_login("sessionid=test; uid_tt=42", "测试抖音号", "42")
            check(applied.get("ok") is True, "服务应用抖音登录")
            after = service.get_state()["account"]["douyin"]
            check(after["logged_in"] is True and after["uid"] == 42, "服务暴露抖音账号状态", after)
            logged_out = service.logout_douyin()
            check(logged_out.get("ok") is True, "服务退出抖音登录")
            check(not service.get_state()["account"]["douyin"]["logged_in"], "退出后抖音账号关闭")
        finally:
            service.shutdown()


def test_invalid_connect_keeps_source() -> None:
    with tempfile.TemporaryDirectory(prefix="mutai-douyin-invalid-connect-") as root:
        service = DanmakuTTSService(root)
        try:
            service._source_platform = "bilibili"
            service._source_room_key = "12345"
            bad_douyin = service.connect("", "douyin")
            check(bad_douyin.get("ok") is False, "空抖音房间被拒绝")
            check(
                service._source_platform == "bilibili" and
                service._source_room_key == "12345",
                "空抖音房间不污染当前 B 站消息源",
            )
            bad_bili = service.connect("not-a-room", "bilibili")
            check(bad_bili.get("ok") is False, "非法 B 站房间号被拒绝")
            check(
                service._source_platform == "bilibili" and
                service._source_room_key == "12345",
                "非法 B 站房间号保留原消息源",
            )
        finally:
            service.shutdown()


async def live_probe(room: str) -> int:
    messages = []
    errors = []

    def on_message(kind, payload):
        messages.append((kind, payload))

    def on_state(state, room_id, title, live):
        print("STATE %s room_id=%s title=%s live=%s" % (state, room_id, title, live))

    def on_error(message, meta):
        errors.append((message, meta))

    connection = DouyinConnection(on_message, on_state, on_error)
    result = await connection.open(room)
    print("OPEN " + repr(result))
    if not result.get("ok"):
        await connection.close()
        return 1
    await asyncio.sleep(5)
    print("CONNECTED=%s MESSAGES=%d ERRORS=%d" % (connection.connected, len(messages), len(errors)))
    for kind, payload in messages[:3]:
        print("SAMPLE %s %r %r" % (kind, payload.get("user"), payload.get("text")))
    await connection.close()
    return 0 if connection.connected or messages else 1


async def live_soak(room: str, seconds: float) -> int:
    """连接真实房间并持续观测；每个归一化消息同步写入临时历史库。"""
    messages = []
    errors = []
    states = []
    with tempfile.TemporaryDirectory(prefix="mutai-douyin-soak-") as root:
        store = SessionStore(str(Path(root) / "data" / "history.sqlite3"))
        session_id = "douyin-soak-%d" % int(time.time())

        def on_message(kind, payload):
            messages.append((kind, payload))
            meta = payload.get("meta") if isinstance(payload, dict) else {}
            store.record_message(
                session_id,
                kind,
                time.time(),
                payload.get("uid"),
                meta if isinstance(meta, dict) else {},
            )

        def on_state(state, room_id, title, live):
            states.append((state, room_id, title, live))

        def on_error(message, meta):
            errors.append((message, meta))

        connection = DouyinConnection(on_message, on_state, on_error)
        started_at = time.time()
        store.start_session(
            session_id,
            0,
            "抖音真实房间 soak",
            platform="douyin",
            room_key=room,
        )
        try:
            result = await connection.open(room)
            print("OPEN " + repr(result))
            if not result.get("ok"):
                return 1
            started = time.monotonic()
            next_report = started + 60.0
            while time.monotonic() - started < seconds:
                await asyncio.sleep(min(5.0, max(0.0, seconds - (time.monotonic() - started))))
                now = time.monotonic()
                if now >= next_report:
                    print(
                        "SOAK elapsed=%ds connected=%s messages=%d errors=%d states=%d"
                        % (round(now - started), connection.connected, len(messages), len(errors), len(states))
                    )
                    next_report = now + 60.0
            store.finish_session(
                session_id,
                ended_at=started_at + seconds,
                reason="manual_disconnect",
            )
            flushed = store.flush(5.0)
            detail = store.get_session(session_id).get("session") or {}
            received = int(detail.get("real_received") or 0)
            print(
                "SOAK_RESULT connected=%s messages=%d errors=%d history_received=%d flushed=%s"
                % (connection.connected, len(messages), len(errors), received, flushed)
            )
            ok = bool(flushed and received >= 1 and messages and not errors)
            if not ok and errors:
                print("SOAK_ERRORS " + repr(errors[:3]))
            return 0 if ok else 1
        finally:
            await connection.close()
            store.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="连接真实抖音直播间")
    parser.add_argument("--room", default="", help="真实直播间号或链接")
    parser.add_argument("--soak-minutes", type=float, default=0,
                        help="真实房间持续观测分钟数；大于 0 时启用 soak")
    args = parser.parse_args()
    test_protobuf()
    test_room_input()
    asyncio.run(test_short_links())
    test_room_end()
    test_gift_read_threshold()
    asyncio.run(test_poll_reconnect())
    asyncio.run(test_poll_timeout_not_error())
    asyncio.run(test_first_empty_poll_connects())
    test_login_cookie()
    test_service_account()
    test_invalid_connect_keeps_source()
    if args.soak_minutes > 0:
        room = args.room or "169473665515"
        code = asyncio.run(live_soak(room, args.soak_minutes * 60.0))
        if code:
            print("SOAK_FAIL")
            return code
        print("SOAK_PASS")
    elif args.live:
        room = args.room or "169473665515"
        code = asyncio.run(live_probe(room))
        if code:
            print("LIVE_FAIL")
            return code
        print("LIVE_PASS")
    print("SUMMARY PASS=%d FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
