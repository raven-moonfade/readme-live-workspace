# -*- coding: utf-8 -*-
"""edge-tts 封装：文本清洗、语音合成、音色列表（带磁盘缓存）。

所有网络调用都有超时与异常兜底，失败时返回结构化结果，绝不向外抛异常。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

import edge_tts

logger = logging.getLogger("danmaku_tts.tts")

# 连续重复标点（如 "??????" "。。。"）压缩成一个
_REPEAT_PUNCT_RE = re.compile(r"([，。！？、；：,.!?;:~…\-—~])\1+")
_SPACE_RE = re.compile(r"[ \t\u00a0\u3000]+")
_NEWLINE_RE = re.compile(r"[\r\n]+")
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_EMOTICON_ONLY_RE = re.compile(r"^(?:\[[^\[\]]{1,40}\])+$")
_MEANINGFUL_RE = re.compile(
    r"[0-9A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]"
)

# 中文音色的显示名（其余音色自动从 ShortName 推导）
VOICE_NAME_ZH: Dict[str, str] = {
    "zh-CN-XiaoxiaoNeural": "晓晓",
    "zh-CN-XiaoyiNeural": "晓伊",
    "zh-CN-YunjianNeural": "云健",
    "zh-CN-YunxiNeural": "云希",
    "zh-CN-YunxiaNeural": "云夏",
    "zh-CN-YunyangNeural": "云扬",
    "zh-CN-liaoning-XiaobeiNeural": "晓北（东北）",
    "zh-CN-shaanxi-XiaoniNeural": "晓妮（陕西）",
    "zh-HK-HiuGaaiNeural": "曉佳",
    "zh-HK-HiuMaanNeural": "曉曼",
    "zh-HK-WanLungNeural": "雲龍",
    "zh-TW-HsiaoChenNeural": "曉臻",
    "zh-TW-HsiaoYuNeural": "曉雨",
    "zh-TW-YunJheNeural": "雲哲",
}


# --------------------------------------------------------------- 文本清洗
_CJK_CHAR_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]")
_CJK_VOICE_LANGS = ("zh", "ja", "ko")


def _humanize_synth_error(exc: Exception, voice: Optional[str], text: str) -> str:
    """把 edge-tts 原始异常翻译成用户能懂的中文提示。"""
    name = type(exc).__name__
    if name == "NoAudioReceived" or "No audio was received" in str(exc):
        lang = str(voice or "").split("-")[0].lower()
        if _CJK_CHAR_RE.search(text or "") and lang not in _CJK_VOICE_LANGS:
            return (
                "音色与文本语言不匹配：该音色（%s）无法朗读中文内容，"
                "请改用中文音色（zh-CN-*），或输入该音色支持的语言文本" % (voice or "?")
            )
        return "合成服务未返回音频（NoAudioReceived）：请尝试更换音色或调整参数"
    return "%s: %s" % (name, exc)


def clean_text(text: Any) -> str:
    """清洗朗读文本：去控制字符、折叠空白、压缩连续重复标点。"""
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    text = _CTRL_RE.sub("", text)
    text = _NEWLINE_RE.sub(" ", text)
    text = _SPACE_RE.sub(" ", text)
    text = _REPEAT_PUNCT_RE.sub(r"\1", text)
    return text.strip()


def truncate(text: str, max_len: Any) -> str:
    try:
        n = int(max_len)
    except (TypeError, ValueError):
        return text
    if n <= 0 or len(text) <= n:
        return text
    return text[:n]


def is_readable(text: str) -> bool:
    """是否值得朗读：纯表情（[xx]）、纯标点/空白一律跳过。"""
    if not text:
        return False
    if _EMOTICON_ONLY_RE.match(text):
        return False
    return bool(_MEANINGFUL_RE.search(text))


# --------------------------------------------------------------- 音色列表
def _derive_name(short_name: str) -> str:
    """从 zh-CN-XiaoxiaoNeural / en-US-EmmaMultilingualNeural 推导显示名。"""
    name = short_name or ""
    for suffix in ("MultilingualNeural", "Neural"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    parts = [p for p in name.split("-") if p]
    return parts[-1] if parts else short_name


def normalize_voice(raw: Dict[str, Any]) -> Dict[str, Any]:
    short = str(raw.get("ShortName") or raw.get("Name") or "").strip()
    tag = raw.get("VoiceTag") or {}
    tags: List[str] = []
    for item in list(tag.get("ContentCategories") or []) + list(tag.get("VoicePersonalities") or []):
        s = str(item).strip()
        if s and s not in tags:
            tags.append(s)
    return {
        "id": short,
        "name": VOICE_NAME_ZH.get(short) or _derive_name(short),
        "locale": str(raw.get("Locale") or ""),
        "gender": str(raw.get("Gender") or ""),
        "tags": tags,
    }


def _locale_rank(locale: str) -> int:
    if locale.startswith("zh-CN"):
        return 0
    if locale.startswith("zh"):
        return 1
    if locale.startswith("en"):
        return 2
    return 3


async def fetch_voice_list(timeout: float = 30.0) -> List[Dict[str, Any]]:
    """拉取全部音色并归一化为契约格式（按 locale 排序，中文优先）。"""
    raw = await asyncio.wait_for(edge_tts.list_voices(), timeout=timeout)
    voices: List[Dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        voice = normalize_voice(item)
        if voice["id"]:
            voices.append(voice)
    voices.sort(key=lambda v: (_locale_rank(v["locale"]), v["locale"], v["name"]))
    return voices


def load_voice_cache(path: str) -> List[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:  # noqa: BLE001
        return []
    if isinstance(data, dict):
        data = data.get("voices")
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if isinstance(item, dict) and item.get("id"):
            out.append(
                {
                    "id": str(item.get("id")),
                    "name": str(item.get("name") or item.get("id")),
                    "locale": str(item.get("locale") or ""),
                    "gender": str(item.get("gender") or ""),
                    "tags": [str(t) for t in (item.get("tags") or [])],
                }
            )
    return out


def save_voice_cache(path: str, voices: List[Dict[str, Any]]) -> None:
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"updated_at": time.time(), "voices": voices}, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception as e:  # noqa: BLE001
        logger.warning("写入音色缓存失败：%s", e)
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


# ----------------------------------------------------------------- 合成
async def synthesize(
    text: str,
    voice: str,
    rate: str = "+0%",
    pitch: str = "+0Hz",
    volume: str = "+0%",
    out_path: Optional[str] = None,
    *,
    connect_timeout: int = 10,
    receive_timeout: int = 45,
) -> Dict[str, Any]:
    """合成 mp3。返回 {"ok","bytes","path","elapsed","error"}，不抛异常。"""
    t0 = time.time()
    payload = clean_text(text)
    if not payload:
        return {"ok": False, "bytes": 0, "path": None, "elapsed": 0.0, "error": "文本为空"}
    if not _MEANINGFUL_RE.search(payload):
        # 纯标点/纯空白（例如 "……"、"？"）交给 edge-tts 只会拿到 NoAudioReceived
        return {"ok": False, "bytes": 0, "path": None, "elapsed": 0.0,
                "error": "文本无可朗读内容（纯符号）"}
    tmp = (out_path + ".part") if out_path else None
    try:
        communicate = edge_tts.Communicate(
            payload,
            voice or "zh-CN-XiaoxiaoNeural",
            rate=rate or "+0%",
            pitch=pitch or "+0Hz",
            volume=volume or "+0%",
            connect_timeout=int(connect_timeout),
            receive_timeout=int(receive_timeout),
        )
        audio = bytearray()
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                audio.extend(chunk["data"])
        if not audio:
            raise RuntimeError("edge-tts 未返回音频数据")
        if out_path:
            parent = os.path.dirname(out_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(audio)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, out_path)
        return {
            "ok": True,
            "bytes": len(audio),
            "path": out_path,
            "elapsed": round(time.time() - t0, 3),
            "error": None,
        }
    except Exception as e:  # noqa: BLE001
        if tmp:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
        return {
            "ok": False,
            "bytes": 0,
            "path": None,
            "elapsed": round(time.time() - t0, 3),
            "error": _humanize_synth_error(e, voice, payload),
        }
