#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证主窗口关闭会销毁隐藏监看/登录窗口并完成服务清理。"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, Callable, List

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

PASS = 0
FAIL = 0
FAILURES: List[str] = []


def check(condition: bool, label: str, detail: object = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))
    else:
        FAIL += 1
        FAILURES.append(label)
        print("FAIL  %s%s" % (label, ("  " + str(detail)) if detail != "" else ""))


class FakeEvent:
    def __init__(self) -> None:
        self._callbacks: List[Callable[..., Any]] = []

    def __iadd__(self, callback: Callable[..., Any]):
        self._callbacks.append(callback)
        return self

    def set(self) -> bool:
        cancelled = False
        for callback in list(self._callbacks):
            if callback() is False:
                cancelled = True
        return cancelled


class FakeEvents:
    def __init__(self) -> None:
        self.closed = FakeEvent()
        self.closing = FakeEvent()


class FakeGui:
    def __init__(self, webview_module: "FakeWebview") -> None:
        self._webview = webview_module

    def destroy_window(self, uid: str) -> None:
        for window in self._webview.windows:
            if window.uid == uid:
                window.destroy()
                return


class FakeWindow:
    def __init__(self, title: str, kwargs: dict[str, Any], owner: "FakeWebview") -> None:
        self.uid = title
        self.title = title
        self.kwargs = kwargs
        self.events = FakeEvents()
        self.gui = FakeGui(owner)
        self.destroyed = False
        self.width = int(kwargs.get("width") or 800)
        self.height = int(kwargs.get("height") or 600)
        self.x = int(kwargs.get("x") or 0)
        self.y = int(kwargs.get("y") or 0)

    def destroy(self) -> bool:
        if self.events.closing.set():
            return False
        self.events.closed.set()
        self.destroyed = True
        return True

    def show(self) -> None:
        return

    def hide(self) -> None:
        return

    def move(self, _x: int, _y: int) -> None:
        return

    def resize(self, _w: int, _h: int) -> None:
        return


class FakeWebview(types.ModuleType):
    def __init__(self) -> None:
        super().__init__("webview")
        self.windows: List[FakeWindow] = []
        self.all_windows: List[FakeWindow] = []
        self.main_window: FakeWindow | None = None
        self.start_count = 0

    def create_window(self, title: str, _url: str = "", **kwargs: Any) -> FakeWindow:
        window = FakeWindow(title, kwargs, self)
        self.windows.append(window)
        self.all_windows.append(window)
        if title == "ReadMe":
            self.main_window = window
        return window

    def start(self, callback: Callable[[], None] | None = None, **_kwargs: Any) -> None:
        self.start_count += 1
        if callback:
            callback()
        main = self.main_window
        if main is None:
            raise AssertionError("main window not created")
        if not main.destroy():
            raise AssertionError("main window close was cancelled")
        if any(not window.destroyed for window in self.windows):
            raise AssertionError(
                "auxiliary window remained alive: %r"
                % [(window.title, window.destroyed) for window in self.windows]
            )
        self.windows = []
        self.main_window = None


class FakeService:
    instances: List["FakeService"] = []

    def __init__(self, _base_dir: str) -> None:
        self.shutdown_count = 0
        self.instances.append(self)

    def get_config_v2(self) -> dict[str, Any]:
        return {}

    def get_overlay_config(self) -> dict[str, Any]:
        return {"enabled": False}

    def shutdown(self) -> None:
        self.shutdown_count += 1


class FakeOverlayManager:
    instances: List["FakeOverlayManager"] = []

    def __init__(self, _service: FakeService) -> None:
        self.shutdown_count = 0
        self.instances.append(self)

    def ensure_running(self) -> bool:
        return True

    def set_visible(self, visible: bool) -> dict[str, Any]:
        return {"ok": True, "visible": bool(visible)}

    def shutdown(self) -> None:
        self.shutdown_count += 1


class FakeDouyinLoginManager:
    instances: List["FakeDouyinLoginManager"] = []

    def __init__(self, _service: FakeService) -> None:
        self.shutdown_count = 0
        self.instances.append(self)

    def status(self) -> dict[str, Any]:
        return {"ok": True, "state": "idle"}

    def shutdown(self) -> None:
        self.shutdown_count += 1


def install_fake_app() -> tuple[types.ModuleType, FakeWebview]:
    fake_webview = FakeWebview()
    sys.modules["webview"] = fake_webview
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            sys.modules.pop(name, None)
    import app  # noqa: PLC0415

    app.webview = fake_webview
    app.DanmakuTTSService = FakeService
    app.OverlayManager = FakeOverlayManager
    app.DouyinLoginManager = FakeDouyinLoginManager
    app._acquire_single_instance = lambda: (1, False)
    app._apply_window_icon = lambda *_args, **_kwargs: None
    app._read_overlay_config = lambda _service: {"enabled": False}
    app._logical_work_area = lambda *_args, **_kwargs: (0, 0, 1280, 800)
    return app, fake_webview


def run() -> None:
    print("verify_app_lifecycle · Python", sys.version.split()[0])
    app, fake_webview = install_fake_app()
    app.main()
    app.main()

    check(fake_webview.start_count == 2, "主窗口生命周期可重复执行", fake_webview.start_count)
    check(len(FakeService.instances) == 2, "每次启动创建独立服务", len(FakeService.instances))
    check(all(service.shutdown_count == 1 for service in FakeService.instances),
          "服务在退出时完成关闭", [item.shutdown_count for item in FakeService.instances])
    check(
        all(manager.shutdown_count >= 1 for manager in FakeOverlayManager.instances),
        "浮窗管理在退出时完成关闭",
        [item.shutdown_count for item in FakeOverlayManager.instances],
    )
    check(
        all(manager.shutdown_count >= 1 for manager in FakeDouyinLoginManager.instances),
        "登录窗口在退出时完成关闭",
        [item.shutdown_count for item in FakeDouyinLoginManager.instances],
    )
    check(all(window.destroyed for window in fake_webview.all_windows),
          "主窗口关闭后无隐藏窗口残留",
          [(window.title, window.destroyed) for window in fake_webview.all_windows])
    created_order = [window.title for window in fake_webview.all_windows]
    check(
        created_order == ["ReadMe", "ReadMe 监看", "ReadMe", "ReadMe 监看"],
        "主窗口先于隐藏监看窗口创建",
        created_order,
    )

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))


def main() -> int:
    try:
        run()
    except Exception as exc:  # noqa: BLE001
        print("FAIL  未捕获异常：%r" % (exc,))
        import traceback
        traceback.print_exc()
        return 1
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
