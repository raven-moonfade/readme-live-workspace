#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""B 站真实直播间链路检查：连接、消息、浮窗、监看、历史与导出。"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

from backend.core import DanmakuTTSService  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", choices=("bilibili", "douyin"), default="bilibili")
    parser.add_argument("--room", default="")
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--read", action="store_true", help="启用低频真实朗读")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="mutai-bilibili-live-") as root:
        root_path = Path(root)
        for name in ("config.json", "config.legacy.json"):
            source = ROOT / name
            if source.is_file():
                shutil.copy2(source, root_path / name)
        room = args.room or ("645585351083" if args.platform == "douyin" else "21144080")
        service = DanmakuTTSService(str(root_path))
        try:
            account = service.get_state().get("account") or {}
            if args.platform == "douyin":
                account = account.get("douyin") or {}
            print("ACCOUNT platform=%s logged_in=%s" % (args.platform, bool(account.get("logged_in"))))
            if args.read:
                service.update_config({
                    "read": {
                        "danmaku": True,
                        "gift": False,
                        "super_chat": False,
                        "guard": False,
                        "enter": False,
                    },
                    "filters": {"user_cooldown": 60, "global_cooldown": 20},
                    "queue": {"max_size": 5},
                })
            else:
                service.update_config({
                    "read": {
                        "danmaku": False,
                        "gift": False,
                        "super_chat": False,
                        "guard": False,
                        "enter": False,
                    },
                })

            result = service.connect(room, args.platform)
            print("CONNECT " + repr(result))
            started = time.monotonic()
            while time.monotonic() - started < args.seconds:
                time.sleep(min(2.0, args.seconds - (time.monotonic() - started)))
                state = service.get_state()
                if state.get("connection") in ("connected", "error"):
                    if state.get("connection") == "error":
                        break
            state = service.get_state()
            session = state.get("session") or {}
            real = session.get("real") or {}
            overlay = service.overlay_items(0)
            monitor = service.monitor_snapshot(50)
            session_id = str(session.get("id") or "")
            print(
                "LIVE connection=%s received=%s spoken=%s overlay=%s monitor=%s session=%s"
                % (
                    state.get("connection"),
                    real.get("received"),
                    real.get("spoken"),
                    len(overlay.get("items") or []),
                    len(monitor.get("items") or []),
                    bool(session_id),
                )
            )
            service.disconnect()
            service.session_store.flush(5.0)
            exported = service.export_history_session(session_id, "json") if session_id else {}
            export_ok = bool(exported.get("ok") and Path(str(exported.get("path") or "")).is_file())
            print("EXPORT ok=%s path=%s" % (export_ok, exported.get("path")))
            ok = (
                state.get("connection") == "connected"
                and int(real.get("received") or 0) > 0
                and len(overlay.get("items") or []) > 0
                and len(monitor.get("items") or []) > 0
                and bool(session_id)
                and export_ok
                and (not args.read or int(real.get("spoken") or 0) > 0)
            )
            print("SUMMARY PASS=%s FAIL=%s" % (1 if ok else 0, 0 if ok else 1))
            return 0 if ok else 1
        finally:
            service.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
