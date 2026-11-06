# -*- coding: utf-8 -*-
"""导出目录的安全统计、预览与手动清理。

这里不保存导出内容，只处理固定目录第一层的应用生成文件。所有删除操作都必须
经过白名单、普通文件、非重解析点、指纹和预览令牌校验；未知文件永不处理。
"""

from __future__ import annotations

import ctypes
import os
import re
import secrets
import shutil
import stat
import threading
import time
from ctypes import wintypes
from datetime import date, datetime, time as datetime_time, timedelta
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple


APP_FILE_RE = re.compile(r"^(?:readme|mutai)-(session|report)-.+\.(json|csv)$", re.IGNORECASE)
TEMP_FILE_RE = re.compile(
    r"^(?:readme|mutai)-(session|report)-.+\.(json|csv)\.tmp-(\d+)-(\d+)$",
    re.IGNORECASE,
)
_REPARSE_POINT = 0x400
_HIDDEN_OR_SYSTEM = 0x2 | 0x4
_MAX_ENTRIES = 20000
_PREVIEW_TTL = 300
_MAX_PREVIEWS = 8
_TEMP_MAX_AGE = 24 * 3600
_WEEK_RE = re.compile(r"^(\d{4})-W(\d{2})$")


def _error(code: str, message: str, **extra: Any) -> Dict[str, Any]:
    result = {
        "ok": False,
        "available": code not in ("unsupported",),
        "error_code": code,
        "error": message,
    }
    result.update(extra)
    return result


def _is_reparse(path: str) -> bool:
    try:
        value = os.lstat(path)
    except OSError:
        return True
    return bool(
        (int(getattr(value, "st_file_attributes", 0) or 0) & _REPARSE_POINT)
        or stat.S_ISLNK(value.st_mode)
    )


def _is_hidden_or_system(st: os.stat_result) -> bool:
    attrs = int(getattr(st, "st_file_attributes", 0) or 0)
    return bool(attrs & _HIDDEN_OR_SYSTEM)


def _is_read_only(st: os.stat_result) -> bool:
    return not bool(st.st_mode & stat.S_IWRITE)


def _safe_name(name: str) -> bool:
    if not name or name in (".", "..") or name.startswith("."):
        return False
    if len(name) > 240 or any(ord(char) < 32 for char in name):
        return False
    return True


def _pid_alive(pid: int) -> bool:
    """Windows 下使用 OpenProcess，避免 os.kill(pid, 0) 终止进程。"""
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return True
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x1000, False, int(pid))  # QUERY_LIMITED_INFORMATION
    if handle:
        exit_code = wintypes.DWORD()
        alive = True
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            alive = int(exit_code.value) == 259  # STILL_ACTIVE
        kernel32.CloseHandle(handle)
        return alive
    # ERROR_INVALID_PARAMETER 才表示 PID 不存在；ERROR_ACCESS_DENIED 视为存活。
    return ctypes.get_last_error() != 87


def _safe_fingerprint(record: Dict[str, Any]) -> Tuple[Any, ...]:
    return (
        str(record.get("kind") or ""),
        str(record.get("name") or ""),
        int(record.get("size") or 0),
        int(record.get("mtime_ns") or 0),
        int(record.get("ino") or 0),
    )


def _week_info(value: Any) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    text = str(value or "").strip().upper()
    if not text:
        return None, None
    match = _WEEK_RE.match(text)
    if not match:
        return None, _error("invalid_week", "自然周必须使用 YYYY-Www 格式")
    year, week = int(match.group(1)), int(match.group(2))
    try:
        monday = date.fromisocalendar(year, week, 1)
    except ValueError:
        return None, _error("invalid_week", "自然周超出有效范围")
    start_dt = datetime.combine(monday, datetime_time.min)
    end_dt = start_dt + timedelta(days=7)
    label = "%s · %s ~ %s" % (
        text,
        monday.isoformat(),
        (monday + timedelta(days=6)).isoformat(),
    )
    return {
        "key": text,
        "label": label,
        "start": start_dt.timestamp(),
        "end": end_dt.timestamp(),
    }, None


def _week_key(epoch: Any) -> str:
    try:
        value = datetime.fromtimestamp(float(epoch))
    except (TypeError, ValueError, OSError, OverflowError):
        return ""
    iso = value.isocalendar()
    return "%04d-W%02d" % (iso.year, iso.week)


def _week_options(records: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    groups: Dict[str, Dict[str, Any]] = {}
    for item in records:
        if item.get("kind") != "app":
            continue
        info, error = _week_info(_week_key(item.get("mtime")))
        if error or not info:
            continue
        group = groups.setdefault(info["key"], {
            **info,
            "app_files": 0,
            "app_bytes": 0,
        })
        group["app_files"] += 1
        group["app_bytes"] += int(item.get("size") or 0)
    return sorted(groups.values(), key=lambda item: item["start"], reverse=True)


class ExportManager:
    """固定导出目录的只读扫描与受控删除。"""

    def __init__(
        self,
        directory: str,
        *,
        now: Optional[Callable[[], float]] = None,
        pid_alive: Optional[Callable[[int], bool]] = None,
        opener: Optional[Callable[[str], None]] = None,
        max_entries: int = _MAX_ENTRIES,
    ) -> None:
        self.directory = os.path.abspath(str(directory))
        self._now = now or time.time
        self._pid_alive = pid_alive or _pid_alive
        self._opener = opener
        self._max_entries = max(1, int(max_entries))
        self._preview_lock = threading.Lock()
        self._prune_lock = threading.Lock()
        self._previews: Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------------ 路径
    def _path_error(self) -> Optional[Dict[str, Any]]:
        parent = os.path.dirname(self.directory)
        if os.path.lexists(parent) and _is_reparse(parent):
            return _error("path_unsafe", "导出目录的父目录是链接或重解析点")
        if os.path.lexists(self.directory):
            try:
                value = os.lstat(self.directory)
            except OSError as exc:
                return _error("unavailable", "无法读取导出目录：%s" % exc)
            if _is_reparse(self.directory):
                return _error("path_unsafe", "导出目录是链接或重解析点")
            if not stat.S_ISDIR(value.st_mode):
                return _error("path_unsafe", "导出路径不是目录")
        return None

    def path_error(self) -> Optional[Dict[str, Any]]:
        """供导出写入方复用的固定目录安全检查。"""
        return self._path_error()

    def _record(self, entry: os.DirEntry[str], now: float) -> Optional[Dict[str, Any]]:
        name = entry.name
        try:
            # 不能使用 DirEntry.stat() 的缓存：Windows 上它可能返回 st_ino=0、
            # st_nlink=0。统一走 lstat，保证硬链接保护与预览/删除指纹一致。
            value = os.lstat(entry.path)
        except OSError:
            return None
        if stat.S_ISLNK(value.st_mode) or (int(getattr(value, "st_file_attributes", 0) or 0) & _REPARSE_POINT):
            return {"kind": "symlink", "name": name}
        if stat.S_ISDIR(value.st_mode):
            return {"kind": "subdir", "name": name}
        if not stat.S_ISREG(value.st_mode):
            return {"kind": "unknown", "name": name, "size": 0}

        temp_match = TEMP_FILE_RE.match(name)
        app_match = APP_FILE_RE.match(name)
        protected_reason = ""
        if not _safe_name(name):
            protected_reason = "unsafe_name"
        elif _is_read_only(value):
            protected_reason = "read_only"
        elif _is_hidden_or_system(value):
            protected_reason = "hidden_system"
        elif int(getattr(value, "st_nlink", 1) or 1) > 1:
            protected_reason = "hard_link"

        kind = "app" if app_match else ("temp" if temp_match else "unknown")
        record: Dict[str, Any] = {
            "kind": kind,
            "name": name,
            "size": int(value.st_size),
            "mtime": float(value.st_mtime),
            "mtime_ns": int(getattr(value, "st_mtime_ns", int(value.st_mtime * 1_000_000_000))),
            "ino": int(getattr(value, "st_ino", 0) or 0),
            "protected_reason": protected_reason,
        }
        if temp_match:
            record["pid"] = int(temp_match.group(3))
            record["thread_id"] = int(temp_match.group(4))
            record["stale_temp"] = bool(
                not protected_reason
                and record["mtime"] < now - _TEMP_MAX_AGE
                and record["mtime"] <= now
                and record["pid"] != os.getpid()
                and not self._pid_alive(record["pid"])
            )
        return record

    def _scan(self) -> Dict[str, Any]:
        path_error = self._path_error()
        if path_error:
            return path_error
        if not os.path.isdir(self.directory):
            return {
                "exists": False,
                "scan_truncated": False,
                "records": [],
                "directory": self.directory,
            }
        records: List[Dict[str, Any]] = []
        truncated = False
        try:
            with os.scandir(self.directory) as entries:
                for index, entry in enumerate(entries):
                    if index >= self._max_entries:
                        truncated = True
                        break
                    record = self._record(entry, self._now())
                    if record is not None:
                        records.append(record)
        except OSError:
            return _error("unavailable", "无法扫描导出目录")
        return {
            "exists": True,
            "scan_truncated": truncated,
            "records": records,
            "directory": self.directory,
        }

    @staticmethod
    def _public_status(scan: Dict[str, Any]) -> Dict[str, Any]:
        records = scan.get("records") or []
        app = [item for item in records if item.get("kind") == "app"]
        temp = [item for item in records if item.get("kind") == "temp"]
        unknown = [item for item in records if item.get("kind") == "unknown"]
        subdirs = [item for item in records if item.get("kind") == "subdir"]
        symlinks = [item for item in records if item.get("kind") == "symlink"]
        protected = [item for item in app + temp if item.get("protected_reason")]
        stale_temp = [item for item in temp if item.get("stale_temp")]
        all_files = [item for item in records if item.get("kind") in ("app", "temp", "unknown")]
        app_times = [float(item["mtime"]) for item in app]
        all_times = [float(item["mtime"]) for item in all_files]
        disk_free = None
        try:
            disk_free = int(shutil.disk_usage(scan["directory"]).free)
        except (OSError, FileNotFoundError):
            pass
        return {
            "ok": True,
            "available": True,
            "directory": scan.get("directory") or "",
            "exists": bool(scan.get("exists")),
            "scan_truncated": bool(scan.get("scan_truncated")),
            "files": len(all_files),
            "bytes": sum(int(item.get("size") or 0) for item in all_files),
            "app_files": len(app),
            "app_bytes": sum(int(item.get("size") or 0) for item in app),
            "unknown_files": len(unknown),
            "unknown_bytes": sum(int(item.get("size") or 0) for item in unknown),
            "subdirs": len(subdirs),
            "symlinks": len(symlinks),
            "protected_files": len(protected),
            "temp_files": len(temp),
            "temp_bytes": sum(int(item.get("size") or 0) for item in temp),
            "stale_temp_files": len(stale_temp),
            "stale_temp_bytes": sum(int(item.get("size") or 0) for item in stale_temp),
            "oldest_mtime": min(all_times) if all_times else None,
            "newest_mtime": max(all_times) if all_times else None,
            "app_oldest_mtime": min(app_times) if app_times else None,
            "app_newest_mtime": max(app_times) if app_times else None,
            "volume_free_bytes": disk_free,
        }

    @staticmethod
    def _filter_scan(scan: Dict[str, Any], week: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not week:
            return scan
        records = [
            item for item in (scan.get("records") or [])
            if float(item.get("mtime") or 0) >= float(week["start"])
            and float(item.get("mtime") or 0) < float(week["end"])
        ]
        return dict(scan, records=records)

    def status(self, week: Any = None) -> Dict[str, Any]:
        week_info, week_error = _week_info(week)
        if week_error:
            return week_error
        scan = self._scan()
        if scan.get("ok") is False:
            return scan
        result = self._public_status(self._filter_scan(scan, week_info))
        result["week"] = week_info["key"] if week_info else None
        result["week_label"] = week_info["label"] if week_info else "全部时间"
        result["week_start"] = week_info["start"] if week_info else None
        result["week_end"] = week_info["end"] if week_info else None
        result["weeks"] = _week_options(scan.get("records") or [])
        return result

    # -------------------------------------------------------------- 候选计划
    def _plan(self, scan: Dict[str, Any], days: int, keep_latest: int,
              now: float) -> Dict[str, Any]:
        records = scan.get("records") or []
        app = [item for item in records if item.get("kind") == "app"]
        app.sort(key=lambda item: (int(item.get("mtime_ns") or 0), str(item.get("name") or "")), reverse=True)
        recent_names = {str(item.get("name") or "") for item in app[:keep_latest]}
        cutoff = now - days * 86400
        candidates: List[Dict[str, Any]] = []
        recent_count = 0
        unexpired_count = 0
        unsafe_count = 0
        for item in app:
            name = str(item.get("name") or "")
            if name in recent_names:
                recent_count += 1
            elif float(item.get("mtime") or 0) >= cutoff:
                unexpired_count += 1
            elif item.get("protected_reason"):
                unsafe_count += 1
            else:
                candidate = dict(item)
                candidate["kind"] = "app"
                candidates.append(candidate)
        temp_all = [item for item in records if item.get("kind") == "temp"]
        temp_candidates = [dict(item) for item in temp_all if item.get("stale_temp")]
        candidates.extend(temp_candidates)
        candidates.sort(key=lambda item: (float(item.get("mtime") or 0), str(item.get("name") or "")))
        temp_protected = [
            item for item in temp_all
            if not item.get("stale_temp")
        ]
        return {
            "candidates": candidates,
            "protected": {
                "recent_keep_latest": recent_count,
                "not_expired": unexpired_count,
                "unsafe": unsafe_count,
                "unknown_files": len([item for item in records if item.get("kind") == "unknown"]),
                "subdirs": len([item for item in records if item.get("kind") == "subdir"]),
                "symlinks": len([item for item in records if item.get("kind") == "symlink"]),
                "temp_alive_or_fresh": len(temp_protected),
            },
            "temp_count": len(temp_candidates),
            "app_count": len(candidates) - len(temp_candidates),
        }

    @staticmethod
    def _sample(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {
                "name": str(item.get("name") or ""),
                "bytes": int(item.get("size") or 0),
                "mtime": float(item.get("mtime") or 0),
                "kind": str(item.get("kind") or ""),
            }
            for item in list(candidates)[:30]
        ]

    def _validate_policy(self, days: Any, keep_latest: Any) -> Optional[Dict[str, Any]]:
        try:
            days_value = int(days)
            keep_value = int(keep_latest)
        except (TypeError, ValueError):
            return _error("invalid_policy", "保留天数和保留个数必须是整数")
        if days_value < 1 or days_value > 3650:
            return _error("invalid_policy", "保留天数必须在 1–3650 天之间")
        if keep_value < 1 or keep_value > 10000:
            return _error("invalid_policy", "至少保留个数必须在 1–10000 之间")
        return None

    # -------------------------------------------------------------- 预览
    def preview(self, days: Any, keep_latest: Any, week: Any = None) -> Dict[str, Any]:
        policy_error = self._validate_policy(days, keep_latest)
        if policy_error:
            return policy_error
        week_info, week_error = _week_info(week)
        if week_error:
            return week_error
        days_value, keep_value = int(days), int(keep_latest)
        scan = self._scan()
        if scan.get("ok") is False:
            return scan
        if scan.get("scan_truncated"):
            return _error("scan_truncated", "导出目录条目过多，拒绝在截断结果上生成删除计划")
        now = self._now()
        scan = self._filter_scan(scan, week_info)
        plan = self._plan(scan, days_value, keep_value, now)
        candidates = plan["candidates"]
        fingerprints = tuple(_safe_fingerprint(item) for item in candidates)
        preview_id = secrets.token_hex(16)
        expires_at = now + _PREVIEW_TTL
        with self._preview_lock:
            self._prune_expired_previews(now)
            while len(self._previews) >= _MAX_PREVIEWS:
                oldest = min(self._previews, key=lambda key: self._previews[key]["created_at"])
                self._previews.pop(oldest, None)
            self._previews[preview_id] = {
                "created_at": now,
                "expires_at": expires_at,
                "days": days_value,
                "keep_latest": keep_value,
                "week": week_info["key"] if week_info else "",
                "fingerprints": fingerprints,
            }
        app_candidates = [item for item in candidates if item.get("kind") == "app"]
        temp_candidates = [item for item in candidates if item.get("kind") == "temp"]
        times = [float(item.get("mtime") or 0) for item in candidates]
        return {
            "ok": True,
            "available": True,
            "preview_id": preview_id,
            "expires_at": expires_at,
            "policy": {
                "days": days_value,
                "keep_latest": keep_value,
                "week": week_info["key"] if week_info else None,
            },
            "week": week_info["key"] if week_info else None,
            "week_label": week_info["label"] if week_info else "全部时间",
            "week_start": week_info["start"] if week_info else None,
            "week_end": week_info["end"] if week_info else None,
            "totals": {
                "app_count": len(app_candidates),
                "app_bytes": sum(int(item.get("size") or 0) for item in app_candidates),
                "temp_count": len(temp_candidates),
                "temp_bytes": sum(int(item.get("size") or 0) for item in temp_candidates),
                "total_count": len(candidates),
                "total_bytes": sum(int(item.get("size") or 0) for item in candidates),
                "oldest_mtime": min(times) if times else None,
                "newest_mtime": max(times) if times else None,
            },
            "protected": plan["protected"],
            "sample": self._sample(candidates),
            "sample_truncated": len(candidates) > 30,
            "warnings": [
                warning for warning in (
                    "存在未被识别的文件，不会删除" if plan["protected"]["unknown_files"] else "",
                    "存在子目录或链接，不会递归处理" if (
                        plan["protected"]["subdirs"] or plan["protected"]["symlinks"]
                    ) else "",
                ) if warning
            ],
        }

    def _prune_expired_previews(self, now: float) -> None:
        for key, value in list(self._previews.items()):
            if float(value.get("expires_at") or 0) <= now:
                self._previews.pop(key, None)

    # -------------------------------------------------------------- 删除
    def prune(
        self,
        preview_id: Any,
        days: Any,
        keep_latest: Any,
        week: Any = None,
    ) -> Dict[str, Any]:
        policy_error = self._validate_policy(days, keep_latest)
        if policy_error:
            return policy_error
        week_info, week_error = _week_info(week)
        if week_error:
            return week_error
        token = str(preview_id or "").strip()
        if not token:
            return _error("stale_preview", "清理预览已失效，请重新预览")
        if not self._prune_lock.acquire(blocking=False):
            return _error("busy", "已有清理任务在执行")
        try:
            now = self._now()
            with self._preview_lock:
                preview = self._previews.get(token)
            if not preview:
                return _error("stale_preview", "清理预览已失效，请重新预览")
            if (int(preview.get("days") or 0) != int(days) or
                    int(preview.get("keep_latest") or 0) != int(keep_latest) or
                    str(preview.get("week") or "") != (week_info["key"] if week_info else "") or
                    float(preview.get("expires_at") or 0) <= now):
                if float(preview.get("expires_at") or 0) <= now:
                    with self._preview_lock:
                        self._previews.pop(token, None)
                return _error("stale_preview", "清理参数或预约已变化，请重新预览")
            with self._preview_lock:
                self._previews.pop(token, None)
            scan = self._scan()
            if scan.get("ok") is False:
                return scan
            if scan.get("scan_truncated"):
                return _error("scan_truncated", "导出目录条目过多，拒绝清理")
            scan = self._filter_scan(scan, week_info)
            plan = self._plan(scan, int(days), int(keep_latest), now)
            current = tuple(_safe_fingerprint(item) for item in plan["candidates"])
            if current != tuple(preview.get("fingerprints") or ()):
                return _error("stale_preview", "文件已变化，请重新预览")
            deleted_count = 0
            deleted_bytes = 0
            skipped: Dict[str, int] = {}
            failed: List[Dict[str, str]] = []
            for item in plan["candidates"]:
                name = str(item.get("name") or "")
                path = os.path.join(self.directory, name)
                try:
                    if os.path.commonpath((self.directory, os.path.abspath(path))) != self.directory:
                        skipped["outside"] = skipped.get("outside", 0) + 1
                        continue
                    value = os.lstat(path)
                except FileNotFoundError:
                    skipped["already_gone"] = skipped.get("already_gone", 0) + 1
                    continue
                except OSError:
                    failed.append({"name": name, "error_code": "lstat_failed"})
                    continue
                if (not stat.S_ISREG(value.st_mode) or _is_reparse(path) or
                        _is_read_only(value) or _is_hidden_or_system(value) or
                        int(getattr(value, "st_nlink", 1) or 1) > 1):
                    skipped["protected"] = skipped.get("protected", 0) + 1
                    continue
                if _safe_fingerprint({
                    "kind": item.get("kind"),
                    "name": name,
                    "size": value.st_size,
                    "mtime_ns": getattr(value, "st_mtime_ns", int(value.st_mtime * 1_000_000_000)),
                    "ino": getattr(value, "st_ino", 0),
                }) != _safe_fingerprint(item):
                    skipped["changed"] = skipped.get("changed", 0) + 1
                    continue
                try:
                    os.unlink(path)
                    deleted_count += 1
                    deleted_bytes += int(item.get("size") or 0)
                except OSError:
                    failed.append({
                        "name": name,
                        "error_code": "delete_failed",
                        "error": "删除失败",
                    })
            status = self.status(week_info["key"] if week_info else None)
            return {
                "ok": True,
                "available": True,
                "deleted_count": deleted_count,
                "deleted_bytes": deleted_bytes,
                "failed_count": len(failed),
                "failed": failed[:20],
                "failed_truncated": len(failed) > 20,
                "skipped": skipped,
                "partial": bool(failed or any(
                    count for key, count in skipped.items() if key != "already_gone"
                )),
                "status": status,
            }
        except Exception:  # noqa: BLE001
            return _error("delete_failed", "清理导出文件失败")
        finally:
            self._prune_lock.release()

    # ---------------------------------------------------------- 残留临时文件
    def cleanup_stale_temps(self) -> Dict[str, Any]:
        if not self._prune_lock.acquire(blocking=False):
            return {"ok": False, "error_code": "busy", "deleted": 0}
        try:
            return self._cleanup_stale_temps()
        finally:
            self._prune_lock.release()

    def _cleanup_stale_temps(self) -> Dict[str, Any]:
        scan = self._scan()
        if scan.get("ok") is False:
            return scan
        if scan.get("scan_truncated"):
            return {"ok": False, "error_code": "scan_truncated", "deleted": 0}
        now = self._now()
        deleted = 0
        failed = 0
        for item in scan.get("records") or []:
            if item.get("kind") != "temp" or not item.get("stale_temp"):
                continue
            name = str(item.get("name") or "")
            path = os.path.join(self.directory, name)
            try:
                value = os.lstat(path)
                if (not stat.S_ISREG(value.st_mode) or _is_reparse(path) or
                        _is_read_only(value) or _is_hidden_or_system(value) or
                        int(getattr(value, "st_nlink", 1) or 1) > 1 or
                        float(value.st_mtime) >= now - _TEMP_MAX_AGE):
                    continue
                os.unlink(path)
                deleted += 1
            except OSError:
                failed += 1
        return {"ok": True, "deleted": deleted, "failed": failed}

    # -------------------------------------------------------------- 打开目录
    def open_directory(self) -> Dict[str, Any]:
        path_error = self._path_error()
        if path_error:
            return path_error
        try:
            os.makedirs(self.directory, exist_ok=True)
            path_error = self._path_error()
            if path_error:
                return path_error
            if self._opener is not None:
                self._opener(self.directory)
            elif os.name == "nt" and hasattr(os, "startfile"):
                os.startfile(self.directory)  # type: ignore[attr-defined]
            else:
                import subprocess
                subprocess.Popen(["xdg-open", self.directory])
            return {"ok": True, "available": True, "directory": self.directory}
        except Exception:  # noqa: BLE001
            return _error("open_failed", "无法打开导出目录")
