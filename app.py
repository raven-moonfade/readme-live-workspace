# -*- coding: utf-8 -*-
"""ReadMe — pywebview 主壳。

职责：
- 创建窗口，加载 ui/index.html（WebView2 渲染）
- 把 backend.core.DanmakuTTSService 暴露为 JS API（window.pywebview.api.*）
"""

import ctypes
import os
import pathlib
import secrets
import subprocess
import sys
import threading
import time
import traceback
from ctypes import wintypes

APP_DIR = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).resolve().parent))
DATA_DIR = (
    pathlib.Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else APP_DIR
)
sys.path.insert(0, str(APP_DIR))

if __name__ == "__main__" and "--overlay-child" in sys.argv:
    from overlay_qt import main as overlay_main

    child_args = [arg for arg in sys.argv[1:] if arg != "--overlay-child"]
    raise SystemExit(overlay_main(child_args))

import webview

from backend import __version__ as APP_VERSION  # noqa: E402
from backend.core import DanmakuTTSService  # noqa: E402
from backend.douyin import (  # noqa: E402
    cookie_header_from_webview,
    cookie_value,
    has_login_cookie,
)

APP_TITLE = "ReadMe"
OVERLAY_TITLE = "ReadMe 浮窗"
MONITOR_TITLE = "ReadMe 监看"
ICON_PATH = str(APP_DIR / "assets" / "app.ico")
IPC_CONNECTION_TIMEOUT = 5.0

# Win32 常量
GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
SW_HIDE = 0
SW_SHOWNOACTIVATE = 4
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010


class _MonitorInfo(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def _monitor_work_area_logical(x=None, y=None):
    """Return the work area and DPI scale of the monitor nearest to (x, y)."""
    user32 = ctypes.windll.user32
    point = wintypes.POINT(int(x) if x is not None else 0, int(y) if y is not None else 0)
    monitor = user32.MonitorFromPoint(point, 2)  # MONITOR_DEFAULTTONEAREST
    if not monitor:
        raise OSError("MonitorFromPoint returned NULL")
    info = _MonitorInfo()
    info.cbSize = ctypes.sizeof(_MonitorInfo)
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        raise OSError("GetMonitorInfoW failed")

    dpi = 96
    try:
        dx = wintypes.UINT()
        dy = wintypes.UINT()
        shcore = ctypes.windll.shcore
        if shcore.GetDpiForMonitor(monitor, 0, ctypes.byref(dx), ctypes.byref(dy)) == 0:
            dpi = int(dx.value) or 96
    except Exception:
        try:
            dpi = int(user32.GetDpiForWindow(user32.GetForegroundWindow())) or 96
        except Exception:
            dpi = 96
    scale = dpi / 96.0 if dpi else 1.0
    rect = info.rcWork
    return (
        int(rect.left / scale),
        int(rect.top / scale),
        int((rect.right - rect.left) / scale),
        int((rect.bottom - rect.top) / scale),
        scale,
    )


def _logical_work_area(x=None, y=None):
    """逻辑像素下的目标显示器工作区 (left, top, w, h)。"""
    try:
        left, top, width, height, _scale = _monitor_work_area_logical(x, y)
        return left, top, width, height
    except Exception:
        return 0, 0, 1280, 800


def _safe_window_geometry(x, y, width, height):
    """把完全落在主屏外的窗口移回主屏；多屏布局保持原坐标。"""
    try:
        probe_x = int(x) if x is not None else None
        probe_y = int(y) if y is not None else None
        work_l, work_t, work_w, work_h = _logical_work_area(probe_x, probe_y)
        x = int(x) if x is not None else work_l + max(0, (work_w - int(width)) // 2)
        y = int(y) if y is not None else work_t + max(0, (work_h - int(height)) // 2)
        width = max(240, min(int(width), max(240, work_w)))
        height = max(160, min(int(height), max(160, work_h)))
        monitor_count = int(ctypes.windll.user32.GetSystemMetrics(80) or 1)
        overlaps_target = (
            x < work_l + work_w
            and x + width > work_l
            and y < work_t + work_h
            and y + height > work_t
        )
        if monitor_count > 1 and overlaps_target:
            return x, y, width, height
        right = x + width
        bottom = y + height
        outside = (
            right <= work_l
            or x >= work_l + work_w
            or bottom <= work_t
            or y >= work_t + work_h
        )
        if outside:
            x = work_l + max(0, (work_w - width) // 2)
            y = work_t + max(0, (work_h - height) // 2)
        return x, y, width, height
    except Exception:
        return x, y, width, height


def _apply_window_icon(title: str, ico_path: str):
    """pywebview 没有 icon 参数，这里用 Win32 消息给窗口换图标。"""
    if os.name != "nt" or not os.path.exists(ico_path):
        return
    try:
        user32 = ctypes.windll.user32
        IMAGE_ICON = 1
        LR_LOADFROMFILE = 0x0010
        WM_SETICON = 0x0080
        ICON_SMALL, ICON_BIG = 0, 1
        for _ in range(60):
            hwnd = user32.FindWindowW(None, title)
            if hwnd:
                h_small = user32.LoadImageW(None, ico_path, IMAGE_ICON, 16, 16, LR_LOADFROMFILE)
                h_big = user32.LoadImageW(None, ico_path, IMAGE_ICON, 32, 32, LR_LOADFROMFILE)
                if h_small:
                    user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, h_small)
                if h_big:
                    user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, h_big)
                return
            time.sleep(0.25)
    except Exception:
        pass


class JsApi:
    """JS ↔ Python 桥。方法是冻结契约的一部分，不要改名。"""

    def __init__(self, service: DanmakuTTSService, overlay=None, monitor=None, douyin_login=None):
        self._svc = service
        self._overlay = overlay
        self._monitor = monitor
        self._douyin_login = douyin_login
        self._monitor_visible = False
        self._shutting_down = False
        self._monitor_events_bound = False
        self._bind_monitor_events()

    def set_monitor(self, monitor):
        self._monitor = monitor
        self._monitor_events_bound = False
        self._monitor_visible = False
        self._shutting_down = False
        self._bind_monitor_events()

    def begin_shutdown(self):
        """Allow the hidden monitor window to be destroyed during app exit."""
        self._shutting_down = True

    # -- 状态与事件 ------------------------------------------------------
    def get_state(self):
        return self._svc.get_state()

    def poll_events(self, cursor):
        try:
            cursor = int(cursor or 0)
        except (TypeError, ValueError):
            cursor = 0
        return self._svc.poll_events(cursor)

    # -- 连接控制 --------------------------------------------------------
    def connect(self, room_id, platform=None):
        return self._svc.connect(room_id, platform)

    def disconnect(self):
        return self._svc.disconnect()

    # -- 配置与功能 ------------------------------------------------------
    def update_config(self, patch):
        if not isinstance(patch, dict):
            return {"ok": False, "error": "patch 必须是对象"}
        return self._svc.update_config(patch)

    def list_voices(self):
        return self._svc.list_voices()

    def preview(self, text, voice=None, rate=None, pitch=None, volume=None):
        return self._svc.preview(str(text or ""), voice, rate, pitch, volume)

    def replay(self, entry_id):
        return self._svc.replay(str(entry_id or ""))

    # -- B站账号（扫码登录） ---------------------------------------------
    def login_qr(self):
        return self._svc.login_qr()

    def login_poll(self, qrcode_key):
        return self._svc.login_poll(str(qrcode_key or ""))

    def logout(self):
        return self._svc.logout()

    # -- 抖音账号（独立登录窗口） ---------------------------------------
    def douyin_login_start(self):
        if self._douyin_login is None:
            return {"ok": False, "error": "抖音登录窗口未初始化"}
        return self._douyin_login.start()

    def douyin_login_status(self):
        if self._douyin_login is None:
            return {"ok": False, "error": "抖音登录窗口未初始化"}
        return self._douyin_login.status()

    def douyin_logout(self):
        return self._svc.logout_douyin()

    # -- 弹幕浮窗 --------------------------------------------------------
    def get_overlay_config(self):
        return _read_overlay_config(self._svc)

    def get_config_v2(self):
        fn = getattr(self._svc, "get_config_v2", None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                traceback.print_exc()
        return {}

    def get_appearance(self):
        fn = getattr(self._svc, "get_appearance", None)
        data = {}
        if callable(fn):
            try:
                data = fn()
            except Exception:
                traceback.print_exc()
        status_fn = getattr(self._svc, "config_status", None)
        status = status_fn() if callable(status_fn) else {}
        return {
            "ok": True,
            "appearance": data if isinstance(data, dict) else {},
            "read_only": bool((status or {}).get("read_only")),
            "migration": (status or {}).get("migration") or {},
            "security": (status or {}).get("security") or {},
        }

    def config_status(self):
        fn = getattr(self._svc, "config_status", None)
        return fn() if callable(fn) else {
            "read_only": True,
            "migration": {"state": "unknown"},
            "security": {},
        }

    def history_status(self):
        fn = getattr(self._svc, "history_status", None)
        if callable(fn):
            return fn()
        return {"ok": False, "available": False, "error": "后端未提供历史场次"}

    def history_list_sessions(
        self,
        limit=30,
        offset=0,
        query="",
        started_from=None,
        started_to=None,
        platform=None,
        before_started_at=None,
        before_id=None,
    ):
        fn = getattr(self._svc, "list_history_sessions", None)
        if callable(fn):
            try:
                return fn(
                    limit,
                    offset,
                    query,
                    started_from,
                    started_to,
                    platform,
                    before_started_at,
                    before_id,
                )
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc), "sessions": [], "total": 0}
        return {"ok": False, "error": "后端未提供历史场次", "sessions": [], "total": 0}

    def history_get_session(self, session_id):
        fn = getattr(self._svc, "get_history_session", None)
        if callable(fn):
            try:
                return fn(str(session_id or ""))
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc), "session": None}
        return {"ok": False, "error": "后端未提供历史场次", "session": None}

    def history_get_previous_session(self, session_id):
        fn = getattr(self._svc, "get_previous_history_session", None)
        if callable(fn):
            try:
                return fn(str(session_id or ""))
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc), "session": None, "has_previous": False}
        return {"ok": False, "error": "后端未提供上一场历史场次", "session": None, "has_previous": False}

    def history_list_baselines(
        self,
        target_id,
        limit=30,
        before_distance=None,
        before_started_at=None,
        before_id=None,
        before_target_id=None,
    ):
        fn = getattr(self._svc, "list_history_baselines", None)
        if callable(fn):
            try:
                limit_value = 30 if limit is None else int(limit)
            except (TypeError, ValueError, OverflowError):
                limit_value = 0
            if limit_value < 1 or limit_value > 100:
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "invalid_argument",
                    "error": "limit 必须在 1–100 之间",
                    "candidates": [],
                }
            try:
                return fn(
                    str(target_id or ""),
                    limit_value,
                    before_distance,
                    before_started_at,
                    before_id,
                    before_target_id,
                )
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "基准场候选读取失败",
                    "candidates": [],
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供任意基准场对比",
            "candidates": [],
        }

    def history_compare_sessions(self, target_id, baseline_id):
        fn = getattr(self._svc, "compare_history_sessions", None)
        if callable(fn):
            try:
                return fn(str(target_id or ""), str(baseline_id or ""))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "历史场次对比失败",
                    "target": None,
                    "baseline": None,
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供任意基准场对比",
            "target": None,
            "baseline": None,
        }

    def history_compare_multi(self, target_id, baseline_ids):
        fn = getattr(self._svc, "compare_multi_history_sessions", None)
        if callable(fn):
            try:
                if not isinstance(baseline_ids, (list, tuple)):
                    return {
                        "ok": False,
                        "available": True,
                        "error_code": "invalid_argument",
                        "error": "baseline_ids 必须是数组",
                        "target": None,
                        "baselines": [],
                    }
                return fn(str(target_id or ""), list(baseline_ids))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "多基准场对比失败",
                    "target": None,
                    "baselines": [],
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供多基准场对比",
            "target": None,
            "baselines": [],
        }

    def history_session_insights(self, target_id):
        fn = getattr(self._svc, "session_insights", None)
        if callable(fn):
            try:
                return fn(str(target_id or ""))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "场次复盘读取失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供场次复盘",
        }

    def history_prune_preview(self, cutoff_ts, keep_latest=1):
        fn = getattr(self._svc, "preview_history_prune", None)
        if callable(fn):
            try:
                return fn(cutoff_ts, int(keep_latest or 1))
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc)}
        return {"ok": False, "error": "后端未提供历史清理预览"}

    def history_prune(self, cutoff_ts, keep_latest=1):
        fn = getattr(self._svc, "prune_history", None)
        if callable(fn):
            try:
                return fn(cutoff_ts, int(keep_latest or 1))
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc)}
        return {"ok": False, "error": "后端未提供历史清理"}

    def history_settings(self):
        fn = getattr(self._svc, "get_history_settings", None)
        if callable(fn):
            try:
                return fn()
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc), "settings": {}}
        return {"ok": False, "error": "后端未提供历史设置", "settings": {}}

    def history_update_settings(self, patch):
        if not isinstance(patch, dict):
            return {"ok": False, "error": "patch 必须是对象", "settings": {}}
        fn = getattr(self._svc, "update_history_settings", None)
        if callable(fn):
            try:
                return fn(patch)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc), "settings": {}}
        return {"ok": False, "error": "后端未提供历史设置", "settings": {}}

    def history_trend(
        self,
        started_from,
        started_to,
        query="",
        platform=None,
        granularity="day",
        room_key=None,
    ):
        # 兼容旧调用顺序 (from, to, query, platform, room_key)。
        if str(granularity or "").lower() not in ("hour", "day", "week") and room_key is None:
            room_key = granularity
            granularity = "day"
        fn = getattr(self._svc, "history_trend", None)
        if callable(fn):
            try:
                return fn(started_from, started_to, query, platform, granularity, room_key)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "历史趋势读取失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unavailable",
            "error": "后端未提供历史趋势",
        }

    def history_export_trend(
        self,
        started_from,
        started_to,
        query="",
        platform=None,
        granularity="day",
        room_key=None,
        fmt="json",
    ):
        fn = getattr(self._svc, "export_history_trend", None)
        if callable(fn):
            try:
                return fn(
                    started_from,
                    started_to,
                    query=query,
                    platform=platform,
                    granularity=granularity,
                    room_key=room_key,
                    fmt=fmt,
                )
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "趋势报告导出失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供趋势报告导出",
        }

    def history_export_compare(self, target_id, baseline_id, fmt="json"):
        fn = getattr(self._svc, "export_history_compare", None)
        if callable(fn):
            try:
                return fn(str(target_id or ""), str(baseline_id or ""), str(fmt or "json"))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "对比报告导出失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供对比报告导出",
        }

    def history_export_compare_multi(self, target_id, baseline_ids, fmt="json"):
        fn = getattr(self._svc, "export_history_compare_multi", None)
        if callable(fn):
            try:
                if not isinstance(baseline_ids, (list, tuple)):
                    return {
                        "ok": False,
                        "available": True,
                        "error_code": "invalid_argument",
                        "error": "baseline_ids 必须是数组",
                    }
                return fn(
                    str(target_id or ""),
                    list(baseline_ids),
                    str(fmt or "json"),
                )
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "多场对比报告导出失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供多场对比报告导出",
        }

    def history_export_insights(self, target_id, fmt="json"):
        fn = getattr(self._svc, "export_history_insights", None)
        if callable(fn):
            try:
                return fn(str(target_id or ""), str(fmt or "json"))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "复盘报告导出失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供复盘报告导出",
        }

    def history_export_storage_status(self, week=None):
        fn = getattr(self._svc, "export_storage_status", None)
        if callable(fn):
            try:
                return fn(week)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "导出目录统计失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供导出目录管理",
        }

    def history_export_storage_preview(self, days=90, keep_latest=50, week=None):
        fn = getattr(self._svc, "export_storage_preview", None)
        if callable(fn):
            try:
                return fn(days, keep_latest, week)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "导出文件预览失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供导出目录管理",
        }

    def history_export_storage_prune(self, preview_id, days=90, keep_latest=50, week=None):
        fn = getattr(self._svc, "export_storage_prune", None)
        if callable(fn):
            try:
                return fn(str(preview_id or ""), days, keep_latest, week)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "internal",
                    "error": "导出文件清理失败",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供导出目录管理",
        }

    def history_export_storage_open_dir(self):
        fn = getattr(self._svc, "open_export_dir", None)
        if callable(fn):
            try:
                return fn()
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "open_failed",
                    "error": str(exc) or "无法打开导出目录",
                }
        return {
            "ok": False,
            "available": False,
            "error_code": "unsupported",
            "error": "后端未提供导出目录管理",
        }

    def history_export_session(self, session_id, fmt="json"):
        fn = getattr(self._svc, "export_history_session", None)
        if callable(fn):
            try:
                return fn(str(session_id or ""), str(fmt or "json"))
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc)}
        return {"ok": False, "error": "后端未提供历史场次导出"}

    def history_delete_session(self, session_id):
        fn = getattr(self._svc, "delete_history_session", None)
        if callable(fn):
            try:
                return fn(str(session_id or ""))
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc)}
        return {"ok": False, "error": "后端未提供历史场次"}

    def set_appearance(self, appearance):
        if not isinstance(appearance, dict):
            return {"ok": False, "error": "appearance 必须是对象"}
        fn = getattr(self._svc, "set_appearance", None)
        if callable(fn):
            try:
                return fn(appearance)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return {"ok": False, "error": str(exc)}
        return {"ok": False, "error": "后端不支持外观持久化"}

    # -- 监看窗口 --------------------------------------------------------
    def _bind_monitor_events(self):
        if self._monitor is None or self._monitor_events_bound:
            return
        events = getattr(self._monitor, "events", None)
        if events is None:
            return
        try:
            closing = getattr(events, "closing", None)
            if closing is not None:
                closing += self._on_monitor_closing
            closed = getattr(events, "closed", None)
            if closed is not None:
                closed += self._on_monitor_closed
            self._monitor_events_bound = True
        except Exception:
            pass

    def _on_monitor_closing(self):
        """Turn title-bar X into hide so the same window can be shown again."""
        if self._shutting_down:
            return None
        try:
            if self._monitor is not None:
                self._monitor.hide()
        except Exception:
            pass
        self._monitor_visible = False
        return False

    def _on_monitor_closed(self):
        self._monitor_visible = False

    def toggle_monitor(self, show=None):
        if self._monitor is None:
            return {"ok": False, "error": "监看窗口未创建"}
        try:
            visible = bool(show) if show is not None else not self._monitor_visible
            if visible:
                try:
                    x, y, width, height = _safe_window_geometry(
                        self._monitor.x,
                        self._monitor.y,
                        self._monitor.width,
                        self._monitor.height,
                    )
                    if (x, y, width, height) != (
                        self._monitor.x,
                        self._monitor.y,
                        self._monitor.width,
                        self._monitor.height,
                    ):
                        self._monitor.move(x, y)
                        self._monitor.resize(width, height)
                except Exception:
                    pass
                self._monitor.show()
            else:
                self._monitor.hide()
            self._monitor_visible = visible
            return {"ok": True, "visible": visible}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def monitor_visible(self):
        return {"visible": bool(self._monitor is not None and self._monitor_visible)}

    def apply_overlay(self, patch):
        if not isinstance(patch, dict):
            return {"ok": False, "error": "patch 必须是对象"}
        result = self._svc.update_config({"overlay": patch}) or {}
        cfg = _read_overlay_config(self._svc)
        if result.get("ok") is False:
            return {
                "ok": False,
                "error": result.get("error") or "浮窗配置写入失败",
                "config": cfg,
                "rejected": list(result.get("rejected") or []),
            }
        if self._overlay is not None:
            # 旧版（pywebview 浮窗）才有 apply_config；Qt 浮窗靠 IPC 轮询配置（≈1.2s），
            # 因此这里存在即调用、不存在则跳过，不能报错。
            apply_fn = getattr(self._overlay, "apply_config", None)
            if callable(apply_fn):
                try:
                    apply_fn(cfg, persist=False)
                except Exception:
                    traceback.print_exc()
        return {"ok": True, "config": cfg, "rejected": result.get("rejected") or []}

    def set_overlay_visible(self, visible):
        if self._overlay is not None:
            try:
                return self._overlay.set_visible(bool(visible))
            except Exception:
                traceback.print_exc()
        result = self._svc.update_config({"overlay": {"enabled": bool(visible)}})
        rejected = list((result or {}).get("rejected") or [])
        if (result or {}).get("ok") is False or rejected:
            return {
                "ok": False,
                "visible": bool(_read_overlay_config(self._svc).get("enabled")),
                "saved": False,
                "error": (result or {}).get("error") or "浮窗状态保存失败",
                "rejected": rejected,
            }
        return {"ok": True, "visible": bool(visible), "saved": True}

    # -- 调试：模拟数据 --------------------------------------------------
    def inject_mock(self, payload):
        payload = payload if isinstance(payload, dict) else {}
        return self._svc.inject_mock(
            kind=str(payload.get("kind") or "danmaku"),
            user=str(payload.get("user") or ""),
            text=str(payload.get("text") or ""),
            meta=payload.get("meta") if isinstance(payload.get("meta"), dict) else None,
            speak=bool(payload.get("speak")),
        )

    def inject_mock_burst(self, payload):
        payload = payload if isinstance(payload, dict) else {}
        try:
            count = int(payload.get("count") or 10)
        except (TypeError, ValueError):
            count = 10
        return self._svc.inject_mock_burst(
            count=count,
            kind=str(payload.get("kind") or "mixed"),
            speak=bool(payload.get("speak")),
        )

    def mock_auto(self, payload):
        return self._svc.mock_auto(payload if isinstance(payload, dict) else {})

    def mock_status(self):
        return self._svc.mock_status()

    # -- 辅助 ------------------------------------------------------------
    def get_app_info(self):
        return {
            "name": "ReadMe",
            "version": APP_VERSION,
        "base_dir": str(DATA_DIR),
        }


def _read_overlay_config(service) -> dict:
    """读取 overlay 配置（兼容后端尚未提供专用方法的情况）。"""
    fn = getattr(service, "get_overlay_config", None)
    if callable(fn):
        try:
            cfg = fn()
            if isinstance(cfg, dict):
                return dict(cfg)
        except Exception:
            pass
    try:
        cfg = (service.config.snapshot() or {}).get("overlay")
        if isinstance(cfg, dict):
            return dict(cfg)
    except Exception:
        pass
    return {}


def _save_config_patch(service, patch: dict, error_text: str) -> dict:
    """统一配置写盘结果，避免几何/显示状态在失败时伪装成功。"""
    try:
        result = service.update_config(patch)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "saved": False, "error": "%s：%s" % (error_text, exc)}
    result = result if isinstance(result, dict) else {}
    rejected = list(result.get("rejected") or [])
    if result.get("ok") is False or rejected:
        return {
            "ok": False,
            "saved": False,
            "error": result.get("error") or error_text,
            "rejected": rejected,
        }
    return {"ok": True, "saved": True, "rejected": []}


class MonitorApi:
    """监看窗口专用 JS API。"""

    def __init__(self, service):
        self._svc = service
        self._last_read = 0

    def snapshot(self, limit=300):
        try:
            return self._svc.monitor_snapshot(int(limit))
        except Exception as e:  # noqa: BLE001
            return {"seq": 0, "items": [], "error": str(e)}

    def state(self):
        return self._svc.monitor_state()

    def config(self):
        cfg = self._svc.get_config_v2() if hasattr(self._svc, "get_config_v2") else {}
        return (cfg or {}).get("monitor") or {}

    def appearance(self):
        fn = getattr(self._svc, "get_appearance", None)
        data = {}
        if callable(fn):
            try:
                data = fn()
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        status_fn = getattr(self._svc, "config_status", None)
        status = status_fn() if callable(status_fn) else {}
        return {
            "ok": True,
            "appearance": data if isinstance(data, dict) else {},
            "read_only": bool((status or {}).get("read_only")),
            "security": (status or {}).get("security") or {},
        }

    def set_font(self, px, ui_size=None):
        try:
            px = int(px)
        except (TypeError, ValueError):
            return {"ok": False, "error": "font_px 非法"}
        patch = {"font_px": px}
        if ui_size in ("small", "medium", "large", "xlarge"):
            patch["ui_size"] = ui_size
        result = self._svc.update_config({"monitor": patch})
        rejected = (result or {}).get("rejected") or []
        if (result or {}).get("ok") is False or rejected:
            return {"ok": False, "error": "字号保存失败", "rejected": rejected}
        return {"ok": True, "font_px": px}

    def mark_read(self, seq):
        try:
            self._last_read = max(self._last_read, int(seq))
        except (TypeError, ValueError):
            pass
        return {"ok": True, "last_read": self._last_read}

    def last_read(self):
        return {"last_read": self._last_read}

    def save_geometry(self, geom):
        if not isinstance(geom, dict):
            return {"ok": False, "saved": False, "error": "geometry 必须是对象"}
        patch = {}
        for k in ("x", "y", "width", "height"):
            if isinstance(geom.get(k), (int, float)):
                patch[k] = int(geom[k])
        if not patch:
            return {"ok": False, "saved": False, "error": "geometry 没有有效字段"}
        saved = _save_config_patch(
            self._svc,
            {"monitor": {"geometry": patch}},
            "监看窗口位置保存失败",
        )
        saved["geometry"] = patch
        return saved


def _write_boot_error(exc: BaseException):
    """启动失败时把堆栈写到 logs/boot_error.log（pythonw 无控制台，便于排查）。"""
    try:
        log_dir = os.path.join(str(DATA_DIR), "logs")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "boot_error.log"), "a", encoding="utf-8") as f:
            f.write("=" * 60 + "\n")
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=f)
    except Exception:
        pass


def _log_boot(message: str) -> None:
    """把浮窗相关的非致命错误写进 logs/app.log 同目录的 boot_error.log。"""
    try:
        log_dir = os.path.join(str(DATA_DIR), "logs")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "boot_error.log"), "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
    except Exception:
        pass


class OverlayBridge:
    """向浮窗子进程提供配置/事件的本地 IPC（127.0.0.1 + 换行分隔 JSON）。

    浮窗是独立 Qt 进程：pywebview 的 WebView2 在 Windows 上无法实现真透明
    （官方 issue #1779/#745 未解决），Qt 的逐像素 alpha 才满足"付费软件级"要求。
    """

    def __init__(self, service):
        self._svc = service
        self._server = None
        self._thread = None
        self.port = 0
        self.token = ""

    def start(self) -> int:
        import json
        import hmac
        import socketserver

        svc = self._svc
        token = secrets.token_urlsafe(24)
        self.token = token
        slots = threading.Semaphore(8)

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                # 限制并发连接数，避免本机进程刷连接造成资源耗尽
                if not slots.acquire(blocking=False):
                    return
                try:
                    # 未发送完整请求的空闲连接不能永久占住处理槽。
                    self.connection.settimeout(IPC_CONNECTION_TIMEOUT)
                    self._serve()
                finally:
                    slots.release()

            def _serve(self):
                while True:
                    try:
                        # 限制单行长度（配置/事件远小于 64KB），防止超大请求耗尽内存
                        line = self.rfile.readline(65537)
                        if not line:
                            return
                        if len(line) > 65536 or not line.endswith(b"\n"):
                            return
                        req = json.loads(line.decode("utf-8"))
                    except Exception:
                        return
                    # 本地 IPC 鉴权：仅接受持有一本次性令牌的客户端（防止本机其它进程
                    # 读取含 SESSDATA 的配置或注入消息）
                    got = str(req.get("token") or "")
                    if not hmac.compare_digest(got, token):
                        time.sleep(0.15)
                        try:
                            self.wfile.write(
                                (json.dumps({"ok": False, "error": "unauthorized"}) + "\n").encode("utf-8")
                            )
                            self.wfile.flush()
                        except Exception:
                            pass
                        return
                    try:
                        resp = self._dispatch(svc, req)
                    except Exception as e:  # noqa: BLE001
                        resp = {"ok": False, "error": repr(e)}
                    try:
                        self.wfile.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
                        self.wfile.flush()
                    except Exception:
                        return
                    if req.get("op") == "quit":
                        return

            @staticmethod
            def _dispatch(service, req):
                op = req.get("op")
                if op == "config":
                    return {"ok": True, "config": _read_overlay_config(service)}
                if op == "items":
                    try:
                        cursor = int(req.get("cursor") or 0)
                    except (TypeError, ValueError):
                        cursor = 0
                    fn = getattr(service, "overlay_items", None)
                    if callable(fn):
                        return {"ok": True, **(fn(cursor) or {})}
                    return {"ok": True, "cursor": cursor, "items": []}
                if op == "geometry":
                    patch = {}
                    for key in ("x", "y", "width", "height"):
                        if req.get(key) is not None:
                            try:
                                patch[key] = int(req[key])
                            except (TypeError, ValueError):
                                pass
                    if not patch:
                        return {"ok": False, "saved": {}, "error": "geometry 没有有效字段"}
                    saved = _save_config_patch(
                        service,
                        {"overlay": patch},
                        "浮窗位置保存失败",
                    )
                    saved["saved"] = patch if saved.get("saved") else {}
                    return saved
                if op == "click_through":
                    val = bool(req.get("value"))
                    saved = _save_config_patch(
                        service,
                        {"overlay": {"click_through": val}},
                        "鼠标穿透保存失败",
                    )
                    saved["click_through"] = val
                    return saved
                if op == "ping":
                    return {"ok": True, "pong": True}
                if op == "quit":
                    return {"ok": True}
                return {"ok": False, "error": "unknown op: %r" % (op,)}

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self._server = Server(("127.0.0.1", 0), Handler)
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, name="overlay-ipc", daemon=True)
        self._thread.start()
        # 便于排查与自动化测试：端口落盘
        try:
            with open(os.path.join(str(DATA_DIR), "logs", "overlay_ipc_port.txt"), "w", encoding="utf-8") as f:
                f.write(str(self.port))
        except Exception:
            pass
        return self.port

    def stop(self) -> None:
        if self._server is not None:
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception:
                pass
            self._server = None
        try:
            p = os.path.join(str(DATA_DIR), "logs", "overlay_ipc_port.txt")
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass


def _launch_overlay(port: int, token: str = ""):
    """启动 Qt 浮窗子进程（独立进程，避免与 pywebview 抢主线程）。"""
    if getattr(sys, "frozen", False):
        command = [
            sys.executable,
            "--overlay-child",
            "--port", str(port),
            "--base", str(DATA_DIR),
        ]
    else:
        script = os.path.join(str(APP_DIR), "overlay_qt.py")
        if not os.path.exists(script):
            _log_boot("浮窗脚本不存在：%s" % script)
            return None
        exe = os.path.join(str(APP_DIR), ".venv", "Scripts", "pythonw.exe")
        if not os.path.exists(exe):
            exe = sys.executable
        command = [exe, script, "--port", str(port), "--base", str(DATA_DIR)]
    try:
        env = dict(os.environ)
        env.pop("DM_OVERLAY_TOKEN", None)  # 不再通过环境变量传递令牌
        proc = subprocess.Popen(
            command,
            cwd=str(DATA_DIR),
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        # 令牌通过 stdin 一次性下发（不落盘、不进命令行、不进环境变量）
        try:
            if proc.stdin is not None:
                proc.stdin.write((token + "\n").encode("utf-8"))
                proc.stdin.flush()
                proc.stdin.close()
        except Exception:
            pass
        return proc
    except Exception as e:  # noqa: BLE001
        _log_boot("浮窗进程启动失败：%r" % (e,))
        return None


def _webview_browser_pid(window):
    """Best-effort PID of the WebView2 browser process behind a pywebview window."""
    try:
        gui = getattr(window, "gui", None)
        browser = getattr(gui, "browser", None)
        webview = getattr(browser, "webview", None)
        core = getattr(webview, "CoreWebView2", None)
        return int(core.BrowserProcessId) if core is not None else 0
    except Exception:
        return 0


def _wait_or_terminate_process(pid: int, timeout_ms: int = 2500) -> None:
    """Wait for a WebView2 browser process and terminate only that process if stale."""
    if os.name != "nt" or not pid:
        return
    kernel32 = ctypes.windll.kernel32
    SYNCHRONIZE = 0x00100000
    PROCESS_TERMINATE = 0x0001
    WAIT_TIMEOUT = 0x00000102
    handle = kernel32.OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, False, int(pid))
    if not handle:
        return
    try:
        if kernel32.WaitForSingleObject(handle, int(timeout_ms)) == WAIT_TIMEOUT:
            _terminate_process_tree(pid)
            kernel32.WaitForSingleObject(handle, 1000)
    finally:
        kernel32.CloseHandle(handle)


def _terminate_process_tree(pid: int) -> None:
    """Terminate a child process and all descendants (venv shim -> real python)."""
    if not pid:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(int(pid)), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=5,
            )
            return
        except Exception:
            pass
    try:
        os.kill(int(pid), 15)
    except Exception:
        pass


def _close_stale_overlays(wait: float = 2.0) -> int:
    """终止上次残留的浮窗进程（按窗口标题精确定位，避免误杀）。

    注意：只发 WM_CLOSE 不够——旧进程仍持有单实例互斥锁，会让新浮窗启动即退出。
    这里直接对"拥有该标题窗口的进程"做 TerminateProcess。
    """
    if os.name != "nt":
        return 0
    killed = 0
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        PROCESS_TERMINATE = 0x0001
        found = []
        EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

        def _cb(hwnd, _lparam):
            buf = ctypes.create_unicode_buffer(128)
            user32.GetWindowTextW(hwnd, buf, 128)
            if buf.value == OVERLAY_TITLE:
                found.append(hwnd)
            return True

        user32.EnumWindows(EnumProc(_cb), 0)
        for hwnd in found:
            try:
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if not pid.value:
                    continue
                handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid.value)
                if handle:
                    kernel32.TerminateProcess(handle, 0)
                    kernel32.CloseHandle(handle)
                    killed += 1
            except Exception:
                pass
        if killed:
            deadline = time.time() + wait
            while time.time() < deadline:
                alive = [h for h in found if user32.IsWindow(h)]
                if not alive:
                    break
                time.sleep(0.1)
            for hwnd in found:
                if user32.IsWindow(hwnd):
                    try:
                        user32.DestroyWindow(hwnd)
                    except Exception:
                        pass
    except Exception as e:  # noqa: BLE001
        _log_boot("清理残留浮窗失败：%r" % (e,))
    return killed


def _acquire_single_instance():
    """创建命名互斥体；返回 (handle, already_running)。"""
    if os.name != "nt":
        return 0, False
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(None, False, "Local\\DanmakuTTS_SingleInstance")
        ERROR_ALREADY_EXISTS = 183
        already = kernel32.GetLastError() == ERROR_ALREADY_EXISTS
        return handle, already
    except Exception:
        return 0, False


class OverlayManager:
    """浮窗子进程的生命周期（懒启动 + 幂等关闭）。"""

    def __init__(self, service):
        self._svc = service
        self._bridge = OverlayBridge(service)
        self._proc = None

    def ensure_running(self) -> bool:
        if self._proc is not None and self._proc.poll() is None:
            return True
        # 上次异常退出可能留下孤儿浮窗（T5 缺陷）：先清掉，避免单实例互斥把新进程挡掉
        stale = _close_stale_overlays()
        if stale:
            _log_boot("已清理 %d 个残留浮窗" % stale)
        try:
            port = self._bridge.port or self._bridge.start()
        except Exception as e:  # noqa: BLE001
            _log_boot("浮窗 IPC 启动失败：%r" % (e,))
            return False
        self._proc = _launch_overlay(port, self._bridge.token)
        return self._proc is not None

    def set_visible(self, visible: bool) -> dict:
        desired = bool(visible)
        saved = _save_config_patch(
            self._svc,
            {"overlay": {"enabled": desired}},
            "浮窗状态保存失败",
        )
        if not saved.get("ok"):
            return {
                **saved,
                "visible": bool(_read_overlay_config(self._svc).get("enabled")),
            }
        if desired and not self.ensure_running():
            rollback = _save_config_patch(
                self._svc,
                {"overlay": {"enabled": False}},
                "浮窗状态回滚失败",
            )
            return {
                "ok": False,
                "visible": False,
                "saved": bool(rollback.get("ok")),
                "error": "浮窗进程启动失败，已恢复隐藏状态"
                if rollback.get("ok")
                else "浮窗进程启动失败，且隐藏状态写盘失败",
            }
        return {"ok": True, "visible": desired, "saved": True}

    def shutdown(self) -> None:
        if self._proc is not None:
            if self._proc.poll() is None:
                _terminate_process_tree(getattr(self._proc, "pid", 0))
            self._proc = None
        self._bridge.stop()


class DouyinLoginManager:
    """用 WebView2 打开抖音扫码登录页，并在登录后取回 Cookie。"""

    WINDOW_TITLE = "ReadMe 抖音登录"

    def __init__(self, service):
        self._svc = service
        self._lock = threading.RLock()
        self._window = None
        self._watch_thread = None
        self._stop = threading.Event()
        self._status = "idle"
        self._error = ""

    def start(self):
        with self._lock:
            if self._window is not None:
                try:
                    self._window.show()
                    self._window.on_top = True
                except Exception:
                    pass
                return {"ok": True, "already_open": True, "state": self._status}
            self._stop.clear()
            self._status = "opening"
            self._error = ""
            try:
                window = webview.create_window(
                    self.WINDOW_TITLE,
                    "https://www.douyin.com/user/self",
                    width=520,
                    height=760,
                    min_size=(420, 620),
                    background_color="#0B0E14",
                    on_top=True,
                )
            except Exception as exc:  # noqa: BLE001
                self._status = "error"
                self._error = "打开抖音登录窗口失败：%s" % exc
                return {"ok": False, "error": self._error, "state": self._status}
            if window is None:
                self._status = "error"
                self._error = "抖音登录窗口未创建"
                return {"ok": False, "error": self._error, "state": self._status}
            self._window = window
            try:
                window.events.closed += self._on_closed
            except Exception:
                pass
            self._watch_thread = threading.Thread(
                target=self._watch_cookies,
                name="douyin-login-watch",
                daemon=True,
            )
            self._watch_thread.start()
        return {"ok": True, "state": self._status}

    def status(self):
        with self._lock:
            return {
                "ok": True,
                "window_open": self._window is not None,
                "state": self._status,
                "error": self._error or None,
                "account": self._svc.get_douyin_account(),
            }

    def shutdown(self):
        self._stop.set()
        with self._lock:
            window, self._window = self._window, None
        self._close_window(window)

    @staticmethod
    def _close_window(window):
        if window is None:
            return
        pid = _webview_browser_pid(window)
        try:
            window.destroy()
        except Exception:
            pass
        if pid:
            _wait_or_terminate_process(pid, 1500)

    def _on_closed(self):
        with self._lock:
            window = self._window
            self._window = None
            self._stop.set()
            if self._status == "opening":
                self._status = "closed"
        if window is not None:
            pid = _webview_browser_pid(window)
            if pid:
                _wait_or_terminate_process(pid, 1500)

    def _watch_cookies(self):
        deadline = time.monotonic() + 600
        while not self._stop.is_set() and time.monotonic() < deadline:
            time.sleep(1.0)
            if self._stop.is_set():
                return
            with self._lock:
                window = self._window
            if window is None:
                return
            try:
                cookies = window.get_cookies()
            except Exception:
                continue
            if not has_login_cookie(cookies):
                continue
            cookie_header = cookie_header_from_webview(cookies)
            if not cookie_header:
                continue
            uid = cookie_value(cookie_header, "uid_tt") or cookie_value(cookie_header, "uid_tt_ss")
            result = self._svc.apply_douyin_login(
                cookie_header,
                uname="抖音账号",
                uid=uid,
            )
            with self._lock:
                if result.get("ok"):
                    self._status = "success"
                    self._error = ""
                else:
                    self._status = "error"
                    self._error = str(result.get("error") or "保存抖音登录失败")
            self._stop.set()
            with self._lock:
                window = self._window
                self._window = None
            self._close_window(window)
            return
        with self._lock:
            if self._status == "opening":
                self._status = "timeout"
                self._error = "等待抖音登录超时，可重新打开登录窗口"
                window, self._window = self._window, None
            else:
                window = None
        self._close_window(window)


def main():
    mutex, already = _acquire_single_instance()
    if already:
        try:
            user32 = ctypes.windll.user32
            hwnd = user32.FindWindowW(None, APP_TITLE)
            if hwnd:
                # 已有实例：把它切到前台（不弹阻塞对话框）
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                user32.SetForegroundWindow(hwnd)
            else:
                user32.MessageBoxW(
                    None, "ReadMe 已经在运行。\n请在任务栏切换到已有窗口。",
                    APP_TITLE, 0x40,
                )
        except Exception:
            pass
        _log_boot("检测到已有实例，本次启动已退出")
        return
    service = DanmakuTTSService(str(DATA_DIR))

    index = APP_DIR / "ui" / "index.html"
    url = index.as_uri()

    work_l, work_t, work_w, work_h = _logical_work_area()
    avail_w, avail_h = work_w - 60, work_h - 40
    # 目标尺寸优先，其次适配工作区；工作区异常小时允许低于舒适下限但仍不越界
    win_w = min(1280, avail_w) if avail_w >= 900 else max(360, avail_w)
    win_h = min(820, avail_h) if avail_h >= 560 else max(320, avail_h)
    win_x = int(work_l + max(0, (work_w - win_w) / 2))
    win_y = int(work_t + max(0, (work_h - win_h) / 2))

    overlay_mgr = OverlayManager(service)
    douyin_login_mgr = DouyinLoginManager(service)

    def _startup_cleanup():
        try:
            douyin_login_mgr.shutdown()
        except Exception:
            pass
        try:
            overlay_mgr.shutdown()
        except Exception:
            pass
        try:
            service.shutdown()
        except Exception:
            pass

    overlay_cfg = _read_overlay_config(service)
    try:
        if overlay_cfg.get("enabled"):
            overlay_mgr.ensure_running()
    except Exception as e:  # noqa: BLE001
        _log_boot("浮窗初始化失败：%r" % (e,))

    monitor_path = APP_DIR / "ui" / "monitor.html"
    monitor_window = None
    # The first pywebview window is the master window. Create the visible
    # main window first; a hidden monitor created first would delay the
    # entire UI until its `shown` event, which never fires while hidden.
    api = JsApi(service, overlay_mgr, None, douyin_login_mgr)
    webview_pids = []
    webview_capture_attempts = 0

    def _capture_webview_pids():
        nonlocal webview_capture_attempts
        for candidate in (main_window, monitor_window):
            pid = _webview_browser_pid(candidate)
            if pid and pid not in webview_pids:
                webview_pids.append(pid)
        webview_capture_attempts += 1
        if webview_capture_attempts < 3:
            timer = threading.Timer(0.9, _capture_webview_pids)
            timer.daemon = True
            timer.start()

    try:
        main_window = webview.create_window(
            APP_TITLE,
            url,
            js_api=api,
            width=win_w,
            height=win_h,
            x=win_x,
            y=win_y,
            min_size=(min(980, win_w), min(640, win_h)),
            background_color="#0B0E14",
        )
    except Exception:
        _startup_cleanup()
        raise

    # ---- 监看窗口（默认隐藏，按需显示；必须是子窗口） ----
    if monitor_path.exists():
        try:
            mcfg = (service.get_config_v2() or {}).get("monitor") or {}
        except Exception:
            mcfg = {}
        geom = mcfg.get("geometry") or {}
        monitor_x, monitor_y, monitor_w, monitor_h = _safe_window_geometry(
            geom.get("x"),
            geom.get("y"),
            geom.get("width") or 1280,
            geom.get("height") or 820,
        )
        try:
            monitor_window = webview.create_window(
                MONITOR_TITLE,
                monitor_path.as_uri(),
                js_api=MonitorApi(service),
                width=monitor_w,
                height=monitor_h,
                x=monitor_x,
                y=monitor_y,
                min_size=(760, 480),
                background_color="#0B0E14",
                hidden=True,
            )
            api.set_monitor(monitor_window)
        except Exception:
            try:
                main_window.destroy()
            except Exception:
                pass
            _startup_cleanup()
            raise

    def _on_main_closed():
        """主窗口关闭时清理不参与“最后窗口”判断的隐藏/辅助窗口。"""
        api.begin_shutdown()
        try:
            douyin_login_mgr.shutdown()
        except Exception:  # noqa: BLE001
            _log_boot("main closed: douyin cleanup failed")
        if monitor_window is not None:
            try:
                gui = getattr(monitor_window, "gui", None)
                if gui is not None:
                    # 监看窗口通常从未 show，不能走 Window.destroy() 的 shown 等待。
                    gui.destroy_window(monitor_window.uid)
                else:
                    monitor_window.destroy()
            except Exception as exc:  # noqa: BLE001
                _log_boot("main closed: monitor destroy failed: %r" % (exc,))
        try:
            overlay_mgr.shutdown()
        except Exception as exc:  # noqa: BLE001
            _log_boot("main closed: overlay cleanup failed: %r" % (exc,))

    if main_window is not None:
        # Run cleanup before the main window is destroyed. Waiting for
        # `closed` leaves the hidden monitor window alive, and pywebview then
        # keeps the whole process running after the main UI disappeared.
        main_window.events.closing += _on_main_closed
        main_window.events.closed += _on_main_closed

    def _after_start():
        _apply_window_icon(APP_TITLE, ICON_PATH)
        _apply_window_icon(MONITOR_TITLE, ICON_PATH)
        _capture_webview_pids()
        # 首次启动后把浮窗拉起来（用户可在设置里关闭；关闭只是隐藏，进程保留）
        if _read_overlay_config(service).get("enabled"):
            try:
                overlay_mgr.ensure_running()
            except Exception as e:  # noqa: BLE001
                _log_boot("浮窗进程启动失败：%r" % (e,))

    try:
        webview.start(_after_start, debug=False)
    finally:
        douyin_login_mgr.shutdown()
        overlay_mgr.shutdown()
        for pid in list(webview_pids):
            _wait_or_terminate_process(pid, 1200)
        try:
            service.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except BaseException as e:
        _write_boot_error(e)
        raise
