# -*- coding: utf-8 -*-
"""pygame.mixer 顺序播放器：独立线程、队列播放、支持插队。

线程模型：
- 所有 pygame 调用都发生在播放线程内（pygame.mixer 不是线程安全的）；
- enqueue() 追加到队尾；play_now() 插到队首并打断当前播放；
- status() / current_path() 线程安全，可被任意线程随时调用（get_state 用）。
"""

from __future__ import annotations

import collections
import logging
import os
import threading
import time
from typing import Any, Callable, Deque, Dict, Optional, Set

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

import pygame  # noqa: E402  (必须在隐藏欢迎语的环境变量之后导入)

logger = logging.getLogger("danmaku_tts.player")

_PUBLIC_KEYS = ("id", "user", "text", "kind")


class AudioPlayer:
    """基于 pygame.mixer.music 的顺序播放器。"""

    def __init__(self, on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None):
        self._on_event = on_event
        self._cond = threading.Condition()
        self._items: Deque[Dict[str, Any]] = collections.deque()
        self._current: Optional[Dict[str, Any]] = None
        self._skip = False
        self._stopping = False
        self._available = False
        self._init_error: Optional[str] = None
        self._played = 0
        self._failed = 0
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()

    # ------------------------------------------------------------ 生命周期
    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="danmaku-tts-player", daemon=True)
        self._thread.start()
        self._ready.wait(5.0)

    def shutdown(self, timeout: float = 3.0) -> None:
        with self._cond:
            self._stopping = True
            self._skip = True
            self._items.clear()
            self._cond.notify_all()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
        self._thread = None
        try:
            if pygame.mixer.get_init():
                pygame.mixer.music.stop()
                pygame.mixer.quit()
        except Exception:  # noqa: BLE001
            pass

    # -------------------------------------------------------------- 队列操作
    def enqueue(self, path: str, entry: Dict[str, Any]) -> bool:
        """追加到队尾（顺序播放）。"""
        if not self._available:
            self._report("error", {"entry": entry, "error": self._init_error or "播放器不可用"})
            return False
        item = dict(entry)
        item["path"] = path
        with self._cond:
            if self._stopping:
                return False
            self._items.append(item)
            self._cond.notify_all()
        return True

    def play_now(self, path: str, entry: Dict[str, Any], interrupt: bool = True) -> bool:
        """插队播放：放到队首；(interrupt=True 时) 打断当前正在播放的音频。"""
        if not self._available:
            self._report("error", {"entry": entry, "error": self._init_error or "播放器不可用"})
            return False
        item = dict(entry)
        item["path"] = path
        with self._cond:
            if self._stopping:
                return False
            self._items.appendleft(item)
            if interrupt and self._current is not None:
                self._skip = True
            self._cond.notify_all()
        return True

    def clear(self) -> int:
        """清空待播队列（不影响正在播放的音频），返回被清掉的条数。"""
        with self._cond:
            n = len(self._items)
            self._items.clear()
        return n

    def pending_count(self) -> int:
        with self._cond:
            return len(self._items)

    def drop_oldest(self, reason: str = "queue_full") -> bool:
        """Drop the oldest queued item and report it as not spoken."""
        dropped = None
        with self._cond:
            if self._items:
                dropped = self._items.popleft()
        if dropped is None:
            return False
        self._report("dropped", {"entry": dropped, "reason": reason})
        return True

    def stop_now(self, wait: float = 1.5, reason: str = "stop") -> int:
        """停止一切发声：打断当前播放并清空待播队列，返回被清掉的待播条数。

        - 调用后在 wait 秒内（默认 1.5s）等到当前音频真正停止，status() 的
          now_playing 随即变为 null；播放线程不可用时立即返回。
        - 被清掉、从未播放的条目不丢弃信息：逐个以 on_event("dropped",
          {"entry": 条目, "reason": reason}) 通知调用方，便于把事件回写为“未朗读”。
        """
        with self._cond:
            dropped = list(self._items)
            self._items.clear()
            if self._current is not None:
                self._skip = True
                self._cond.notify_all()
                deadline = time.monotonic() + max(0.0, wait)
                while self._current is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._cond.wait(remaining)
        for item in dropped:
            self._report("dropped", {"entry": item, "reason": reason})
        return len(dropped)

    # ---------------------------------------------------------------- 状态
    def status(self) -> Dict[str, Any]:
        with self._cond:
            current = self._current
            queue_len = len(self._items)
        now_playing = None
        if current is not None:
            now_playing = {k: current.get(k) for k in _PUBLIC_KEYS}
        return {
            "now_playing": now_playing,
            "queue_len": queue_len,
            "available": self._available,
            "played": self._played,
            "failed": self._failed,
            "init_error": self._init_error,
        }

    def current_path(self) -> Optional[str]:
        with self._cond:
            current = self._current
        return current.get("path") if current else None

    def pending_paths(self) -> Set[str]:
        """返回当前播放和待播文件的规范路径，供缓存清理避让。"""
        with self._cond:
            paths = [item.get("path") for item in self._items]
            if self._current is not None:
                paths.append(self._current.get("path"))
        return {
            os.path.normcase(str(path))
            for path in paths
            if path
        }

    # ------------------------------------------------------------ 线程主体
    def _run(self) -> None:
        try:
            pygame.mixer.init()
            pygame.mixer.music.set_volume(1.0)
            self._available = True
        except Exception as e:  # noqa: BLE001
            self._available = False
            self._init_error = "%s: %s" % (type(e).__name__, e)
            logger.error("pygame.mixer 初始化失败：%s", self._init_error)
            self._report("error", {"entry": {}, "error": "音频设备不可用：" + self._init_error})
        finally:
            self._ready.set()

        while True:
            with self._cond:
                while not self._items and not self._stopping:
                    self._cond.wait(0.5)
                if self._stopping:
                    return
                item = self._items.popleft()
                self._skip = False
                self._current = item
            if not self._available:
                self._failed += 1
                self._report("error", {"entry": item, "error": self._init_error or "播放器不可用"})
                with self._cond:
                    self._current = None
                    self._cond.notify_all()
                continue
            self._play_one(item)
            with self._cond:
                self._current = None
                self._cond.notify_all()

    def _play_one(self, item: Dict[str, Any]) -> None:
        path = item.get("path") or ""
        try:
            if not os.path.isfile(path):
                raise FileNotFoundError("音频文件不存在：" + path)
            pygame.mixer.music.load(path)
            pygame.mixer.music.play()
            self._report("started", {"entry": item})
            interrupted = False
            while True:
                with self._cond:
                    interrupted = self._skip or self._stopping
                if interrupted or not pygame.mixer.music.get_busy():
                    break
                time.sleep(0.05)
            try:
                pygame.mixer.music.stop()
                pygame.mixer.music.unload()
            except Exception:  # noqa: BLE001
                pass
            if interrupted:
                self._report("interrupted", {"entry": item})
            else:
                self._played += 1
                self._report("played", {"entry": item})
        except Exception as e:  # noqa: BLE001
            self._failed += 1
            logger.warning("播放失败：%s", e)
            self._report("error", {"entry": item, "error": "%s: %s" % (type(e).__name__, e)})
            try:
                pygame.mixer.music.unload()
            except Exception:  # noqa: BLE001
                pass

    def _report(self, kind: str, payload: Dict[str, Any]) -> None:
        if self._on_event is None:
            return
        try:
            self._on_event(kind, payload)
        except Exception:  # noqa: BLE001
            logger.exception("播放器回调异常")
