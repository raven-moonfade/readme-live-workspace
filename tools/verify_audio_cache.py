#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证播放队列中的音频不会被缓存清理误删。"""

from __future__ import annotations

import collections
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.core import CACHE_MAX_FILES, DanmakuTTSService  # noqa: E402
from backend.player import AudioPlayer  # noqa: E402

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


class FakePlayer:
    def __init__(self, paths):
        self.paths = {os.path.normcase(str(path)) for path in paths}

    def pending_paths(self):
        return set(self.paths)


def main() -> int:
    player = object.__new__(AudioPlayer)
    player._cond = threading.Condition()
    player._items = collections.deque([
        {"path": r"C:\cache\queued.mp3"},
        {"path": r"C:\cache\next.mp3"},
    ])
    player._current = {"path": r"C:\cache\current.mp3"}
    pending = player.pending_paths()
    check(
        {os.path.normcase(p) for p in (
            r"C:\cache\queued.mp3",
            r"C:\cache\next.mp3",
            r"C:\cache\current.mp3",
        )} <= pending,
        "播放队列和当前音频都进入保护集合",
        pending,
    )

    with tempfile.TemporaryDirectory(prefix="mutai-audio-cache-") as root:
        cache_dir = Path(root)
        paths = []
        now = time.time()
        for i in range(CACHE_MAX_FILES + 5):
            path = cache_dir / ("%03d.mp3" % i)
            path.write_bytes(b"x")
            os.utime(path, (now + i, now + i))
            paths.append(path)
        protected = paths[0]
        service = object.__new__(DanmakuTTSService)
        service.cache_dir = str(cache_dir)
        service._player = FakePlayer([protected])
        DanmakuTTSService._trim_cache(service)
        check(protected.is_file(), "队列中的最旧音频不会被删除")
        check(
            sum(1 for path in paths if path.is_file()) <= CACHE_MAX_FILES + 1,
            "清理仍会删除队列外的旧音频",
            sum(1 for path in paths if path.is_file()),
        )

    print("\nSUMMARY PASS=%d FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
