# -*- coding: utf-8 -*-
"""敏感字段的本地加密（Windows DPAPI）。

- Windows：使用 CryptProtectData / CryptUnprotectData，按当前用户加密；
  密文只能在同一用户（同一台机器）上解密，复制到其它机器无意义。
- 非 Windows 或调用失败：退化为带前缀的 base64（仅避免明文肉眼可见），
  并在日志里明确告警，不假装是强加密。

存储格式：`dpapi1:<base64>` 或 `plain1:<base64>`
"""

from __future__ import annotations

import base64
import ctypes
import logging
from ctypes import wintypes

logger = logging.getLogger("danmaku_tts")

_MAGIC_DPAPI = "dpapi1:"
_MAGIC_PLAIN = "plain1:"
_LAST_PROTECT_FALLBACK = False
_LAST_PROTECT_ERROR = ""
_LAST_UNPROTECT_ERROR = ""


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _to_blob(data: bytes):
    buf = ctypes.create_string_buffer(data, len(data))
    blob = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return blob, buf


def _dpapi_protect(data: bytes) -> bytes:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    blob_in, _buf = _to_blob(data)
    blob_out = _DataBlob()
    ok = crypt32.CryptProtectData(
        ctypes.byref(blob_in), "danmaku-tts", None, None, None, 0, ctypes.byref(blob_out)
    )
    if not ok:
        raise OSError("CryptProtectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _dpapi_unprotect(data: bytes) -> bytes:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    blob_in, _buf = _to_blob(data)
    blob_out = _DataBlob()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    )
    if not ok:
        raise OSError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def protect(text: str) -> str:
    """把明文加密成可写入 JSON 的字符串（空串返回空串）。"""
    global _LAST_PROTECT_FALLBACK, _LAST_PROTECT_ERROR
    _LAST_PROTECT_FALLBACK = False
    _LAST_PROTECT_ERROR = ""
    if not text:
        return ""
    raw = text.encode("utf-8")
    try:
        if hasattr(ctypes, "windll"):
            return _MAGIC_DPAPI + base64.b64encode(_dpapi_protect(raw)).decode("ascii")
    except Exception as e:  # noqa: BLE001
        _LAST_PROTECT_FALLBACK = True
        _LAST_PROTECT_ERROR = str(e)
        logger.warning("DPAPI 加密失败，退化为编码存储：%s", e)
    _LAST_PROTECT_FALLBACK = True
    if not _LAST_PROTECT_ERROR:
        _LAST_PROTECT_ERROR = "DPAPI 不可用（当前环境没有 Windows CryptProtectData）"
    return _MAGIC_PLAIN + base64.b64encode(raw).decode("ascii")


def unprotect_ex(token: str) -> tuple[str, bool]:
    """解密并返回 (明文, 是否失败)；失败时不把密文当明文使用。"""
    global _LAST_UNPROTECT_ERROR
    _LAST_UNPROTECT_ERROR = ""
    token = (token or "").strip()
    if not token:
        return "", False
    try:
        if token.startswith(_MAGIC_DPAPI):
            blob = base64.b64decode(token[len(_MAGIC_DPAPI):])
            return _dpapi_unprotect(blob).decode("utf-8"), False
        if token.startswith(_MAGIC_PLAIN):
            return base64.b64decode(token[len(_MAGIC_PLAIN):]).decode("utf-8"), False
    except Exception as e:  # noqa: BLE001
        _LAST_UNPROTECT_ERROR = str(e)
        logger.warning("解密敏感字段失败（可能来自其它用户/机器），已忽略：%s", e)
        return "", True
    # 兼容：旧版本明文
    return token, False


def unprotect(token: str) -> str:
    """解密；无法识别格式时按明文返回（兼容旧配置）。"""
    return unprotect_ex(token)[0]


def is_encoded_token(token: str) -> bool:
    """判断 token 是否使用本模块的密文/编码前缀。"""
    return str(token or "").startswith((_MAGIC_DPAPI, _MAGIC_PLAIN))


def is_plaintext_fallback_token(token: str) -> bool:
    """判断 token 是否是可逆编码的 plain1 降级格式。"""
    return str(token or "").startswith(_MAGIC_PLAIN)


def is_unprefixed_plaintext_token(token: str) -> bool:
    """旧版本可能直接保存无前缀明文 token。"""
    value = str(token or "").strip()
    return bool(value) and not is_encoded_token(value)


def dpapi_available() -> bool:
    """当前解释器是否具备 Windows DPAPI 入口。"""
    return bool(hasattr(ctypes, "windll"))


def storage_status() -> dict:
    """返回最近一次敏感字段加解密的非敏感状态，供配置层汇总。"""
    return {
        "backend": "dpapi" if dpapi_available() else "plain",
        "dpapi_available": dpapi_available(),
        "last_protect_fallback": bool(_LAST_PROTECT_FALLBACK),
        "last_error": _LAST_PROTECT_ERROR or _LAST_UNPROTECT_ERROR or "",
    }
