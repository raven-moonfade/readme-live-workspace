# -*- coding: utf-8 -*-
"""B站账号扫码登录（官方 passport 二维码接口）。

流程：generate 获取二维码 → 渲染 PNG data URL → 轮询 poll 直到成功/过期 →
从成功响应中提取 SESSDATA → 供弹幕连接使用。
"""

from __future__ import annotations

import base64
import io
import logging
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse

import aiohttp
import yarl

logger = logging.getLogger("danmaku_tts")

QR_GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
QR_POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
NAV_URL = "https://api.bilibili.com/x/web-interface/nav"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# poll 接口 data.code
POLL_SUCCESS = 0
POLL_EXPIRED = 86038
POLL_SCANNED = 86090   # 已扫码待确认
POLL_WAITING = 86101   # 未扫码

_POLL_STATUS = {
    POLL_SUCCESS: "success",
    POLL_EXPIRED: "expired",
    POLL_SCANNED: "scanned",
    POLL_WAITING: "waiting",
}


def _qr_png_data_url(text: str) -> str:
    import qrcode

    img = qrcode.make(text)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


async def qr_generate(timeout: float = 10.0) -> Dict[str, Any]:
    """获取登录二维码。返回 {ok, qrcode_key, image, url, error}。"""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(QR_GENERATE_URL, headers={"User-Agent": UA}) as res:
                data = await res.json(content_type=None)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "二维码获取失败：%s" % e}
    if data.get("code") != 0:
        return {"ok": False, "error": "二维码获取失败：%s" % (data.get("message") or data.get("code"))}
    payload = data.get("data") or {}
    url = str(payload.get("url") or "")
    key = str(payload.get("qrcode_key") or "")
    if not url or not key:
        return {"ok": False, "error": "二维码数据不完整"}
    try:
        image = _qr_png_data_url(url)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "二维码渲染失败：%s" % e}
    return {"ok": True, "qrcode_key": key, "image": image, "url": url, "error": None}


def _extract_sessdata(url: str) -> str:
    """从成功响应的 url 参数里取 SESSDATA（官方回调链接携带 cookie）。"""
    if not url:
        return ""
    try:
        qs = parse_qs(urlparse(url).query)
        return str((qs.get("SESSDATA") or [""])[0])
    except Exception:  # noqa: BLE001
        return ""


async def qr_poll(qrcode_key: str, timeout: float = 10.0) -> Dict[str, Any]:
    """轮询扫码状态。

    返回 {status: waiting|scanned|expired|success|error, sessdata?, error?}
    """
    if not qrcode_key:
        return {"status": "error", "error": "缺少 qrcode_key"}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(
                QR_POLL_URL,
                params={"qrcode_key": qrcode_key},
                headers={"User-Agent": UA},
            ) as res:
                data = await res.json(content_type=None)
            jar_cookies = {c.key: c.value for c in session.cookie_jar}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "error": "轮询失败：%s" % e}
    if data.get("code") != 0:
        return {"status": "error", "error": "轮询失败：%s" % (data.get("message") or data.get("code"))}
    payload = data.get("data") or {}
    try:
        code = int(payload.get("code", -1))
    except (TypeError, ValueError):
        code = -1
    status = _POLL_STATUS.get(code, "error")
    if status == "success":
        sessdata = _extract_sessdata(str(payload.get("url") or "")) or str(jar_cookies.get("SESSDATA") or "")
        if not sessdata:
            return {"status": "error", "error": "登录成功但未取到 SESSDATA"}
        return {"status": "success", "sessdata": sessdata}
    if status == "error":
        return {"status": "error", "error": "未知状态码：%s（%s）" % (code, payload.get("message") or "")}
    return {"status": status}


async def fetch_profile(sessdata: str, timeout: float = 10.0) -> Dict[str, Any]:
    """用 SESSDATA 查询账号信息。返回 {ok, uname, mid, error}。"""
    if not sessdata:
        return {"ok": False, "uname": None, "mid": None, "error": "未登录"}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            session.cookie_jar.update_cookies(
                {"SESSDATA": sessdata}, response_url=yarl.URL("https://api.bilibili.com")
            )
            async with session.get(NAV_URL, headers={"User-Agent": UA}) as res:
                data = await res.json(content_type=None)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "uname": None, "mid": None, "error": str(e)}
    payload = data.get("data") or {}
    if data.get("code") == 0 and payload.get("isLogin"):
        return {
            "ok": True,
            "uname": str(payload.get("uname") or ""),
            "mid": int(payload.get("mid") or 0),
            "error": None,
        }
    return {"ok": False, "uname": None, "mid": None, "error": "凭证无效或已过期"}
