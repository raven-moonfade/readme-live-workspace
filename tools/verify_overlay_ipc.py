#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证浮窗 IPC 不会被未认证空闲连接永久占满。"""

from __future__ import annotations

import json
import socket
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import app  # noqa: E402

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


class FakeService:
    def get_overlay_config(self):
        return {}


def main() -> int:
    original_timeout = app.IPC_CONNECTION_TIMEOUT
    app.IPC_CONNECTION_TIMEOUT = 0.4
    bridge = app.OverlayBridge(FakeService())
    port = bridge.start()
    idle = []
    probe = None
    try:
        for _ in range(8):
            idle.append(socket.create_connection(("127.0.0.1", port), timeout=2.0))
        time.sleep(0.9)

        probe = socket.create_connection(("127.0.0.1", port), timeout=2.0)
        probe.sendall(
            (json.dumps({"op": "ping", "token": bridge.token}) + "\n").encode("utf-8")
        )
        reader = probe.makefile("rb")
        raw = reader.readline()
        response = json.loads(raw.decode("utf-8")) if raw else {}
        check(response.get("ok") is True and response.get("pong") is True,
              "空闲连接超时后仍能接受新请求", response)
    finally:
        if probe is not None:
            try:
                probe.close()
            except OSError:
                pass
        for sock in idle:
            try:
                sock.close()
            except OSError:
                pass
        bridge.stop()
        app.IPC_CONNECTION_TIMEOUT = original_timeout

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
