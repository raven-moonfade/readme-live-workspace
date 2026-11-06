#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""30 条/秒持续 10 分钟的后端高密度稳定性检查。"""

from __future__ import annotations

import argparse
import gc
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from backend.core import DanmakuTTSService  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=600)
    parser.add_argument("--rate", type=float, default=30)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="mutai-high-density-") as root:
        service = DanmakuTTSService(root)
        try:
            service._begin_session(0, "bilibili", "high-density")
            tracemalloc.start()
            started = time.monotonic()
            count = 0
            samples = []
            next_sample = started + 60
            interval = 1.0 / max(1.0, args.rate)
            while time.monotonic() - started < args.seconds:
                due = min(1.0 / max(1.0, args.rate), max(0.0, args.seconds - (time.monotonic() - started)))
                if due <= 0:
                    break
                service._handle_room_message(
                    "danmaku",
                    {
                        "user": "密度测试用户%d" % (count % 100),
                        "uid": "density-%d" % (count % 1000),
                        "text": "高密度消息 %d" % count,
                        "meta": {},
                    },
                    speak=False,
                )
                count += 1
                time.sleep(interval)
                now = time.monotonic()
                if now >= next_sample:
                    gc.collect()
                    current, peak = tracemalloc.get_traced_memory()
                    state = service.get_state()
                    session = state.get("session") or {}
                    real = session.get("real") or {}
                    event_count = len(service._events)
                    queue_len = int(state.get("queue_len") or 0)
                    samples.append({
                        "elapsed": round(now - started, 1),
                        "events": event_count,
                        "queue": queue_len,
                        "received": int(real.get("received") or 0),
                        "current_kb": round(current / 1024, 1),
                        "peak_kb": round(peak / 1024, 1),
                    })
                    print("SAMPLE " + repr(samples[-1]))
                    next_sample = now + 60

            time.sleep(0.1)
            state = service.get_state()
            real = (state.get("session") or {}).get("real") or {}
            current, peak = tracemalloc.get_traced_memory()
            elapsed = time.monotonic() - started
            received = int(real.get("received") or 0)
            event_count = len(service._events)
            queue_len = int(state.get("queue_len") or 0)
            # 事件环形缓冲固定 1000；队列由服务上限保护；采样内存不应无界线性增长。
            memory_ok = not samples or (
                max(item["current_kb"] for item in samples) -
                min(item["current_kb"] for item in samples) < 20 * 1024
            )
            ok = (
                received >= int(args.seconds * args.rate * 0.95)
                and event_count <= 1000
                and queue_len <= 30
                and memory_ok
            )
            print(
                "RESULT seconds=%.1f received=%d events=%d queue=%d current_kb=%.1f peak_kb=%.1f memory_ok=%s"
                % (elapsed, received, event_count, queue_len, current / 1024, peak / 1024, memory_ok)
            )
            print("SUMMARY PASS=%s FAIL=%s" % (1 if ok else 0, 0 if ok else 1))
            return 0 if ok else 1
        finally:
            service.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
