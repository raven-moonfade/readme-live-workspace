#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证导出目录统计、预览令牌、白名单清理和临时文件边界。"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.export_store import ExportManager  # noqa: E402

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


def write(path: Path, age_days: float, content: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    stamp = NOW - age_days * 86400
    os.utime(path, (stamp, stamp))


def write_at(path: Path, when: datetime, content: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    stamp = when.timestamp()
    os.utime(path, (stamp, stamp))


def week_key(value: date) -> str:
    iso = value.isocalendar()
    return "%04d-W%02d" % (iso.year, iso.week)


NOW = 1_800_000_000.0


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mutai-export-manage-") as tmp:
        root = Path(tmp) / "exports" / "history"
        manager = ExportManager(
            str(root),
            now=lambda: NOW,
            pid_alive=lambda pid: pid == os.getpid(),
        )

        missing = manager.status()
        check(missing.get("ok") and missing.get("exists") is False,
              "目录不存在时统计不创建目录", missing)
        check(not root.exists(), "status 不产生目录副作用")

        write(root / "mutai-report-old.json", 120, "old")
        write(root / "readme-report-new.json", 20, "readme-new")
        write(root / "mutai-session-new.csv", 30, "new")
        write(root / "mutai-session-recent.json", 10, "recent")
        write(root / "notes.txt", 200, "keep")
        (root / "subdir").mkdir()
        write(root / "subdir" / "inside.json", 500, "nested")
        read_only = root / "mutai-report-readonly.json"
        write(read_only, 150, "readonly")
        try:
            os.chmod(read_only, 0o444)
        except OSError:
            pass
        write(root / "mutai-report-other.json", 30, "other")
        hardlink_created = False
        try:
            os.link(root / "mutai-report-other.json", root / "mutai-report-hardlink.json")
            hardlink_created = True
        except OSError:
            pass
        write(root / "mutai-report-x.json.tmp-999999-1", 2, "temp")
        write(root / "mutai-report-fresh.json.tmp-999999-2", 0.04, "fresh")
        write(root / ("mutai-report-current.json.tmp-%d-3" % os.getpid()), 2, "current")
        write(root / "mutai-report-invalid.json.tmp-not-a-pid", 2, "invalid")

        status = manager.status()
        expected_app_files = 7 if hardlink_created else 6
        check(status.get("ok") and status.get("app_files") == expected_app_files,
              "status 只统计应用导出文件", status)
        check(status.get("unknown_files") == 2,
              "status 区分未知与非法临时文件", status)
        check(status.get("subdirs") == 1, "status 统计子目录", status)
        check(status.get("temp_files") == 3 and status.get("stale_temp_files") == 1,
              "status 只把死亡且过旧的临时文件标为残留", status)
        check(status.get("protected_files", 0) >= 1,
              "status 标记只读/链接保护文件", status)
        if hardlink_created:
            check(status.get("protected_files", 0) >= 2,
                  "status 扫描阶段识别硬链接", status)

        preview = manager.preview(90, 3)
        check(preview.get("ok") and preview.get("preview_id"),
              "预览生成一次性令牌", preview)
        totals = preview.get("totals") or {}
        check(totals.get("app_count") == 1 and totals.get("temp_count") == 1 and
              totals.get("total_count") == 2,
              "保留最近 1 个与 90 天策略", totals)
        check(any(item.get("name") == "mutai-report-old.json"
                  for item in preview.get("sample") or []),
              "预览样本包含旧导出文件")
        check(any(item.get("kind") == "temp" for item in preview.get("sample") or []),
              "预览样本包含残留临时文件")

        stale_preview = manager.preview(90, 3)
        write(root / "mutai-report-old.json", 119, "changed")
        stale = manager.prune(stale_preview.get("preview_id"), 90, 3)
        check(stale.get("ok") is False and stale.get("error_code") == "stale_preview",
              "文件变化后预览 fail-closed", stale)
        check((root / "mutai-report-old.json").exists(),
              "stale 预览不删除任何文件")

        fresh_preview = manager.preview(90, 3)
        pruned = manager.prune(fresh_preview.get("preview_id"), 90, 3)
        check(pruned.get("ok") and pruned.get("deleted_count") == 2,
              "prune 只删除白名单候选", pruned)
        check(not (root / "mutai-report-old.json").exists() and
              not (root / "mutai-report-x.json.tmp-999999-1").exists(),
              "候选文件已删除")
        check((root / "mutai-session-new.csv").exists() and
              (root / "readme-report-new.json").exists() and
              (root / "mutai-session-recent.json").exists() and
              (root / "notes.txt").exists() and
              (root / "subdir" / "inside.json").exists() and
              (root / "mutai-report-fresh.json.tmp-999999-2").exists() and
              (root / ("mutai-report-current.json.tmp-%d-3" % os.getpid())).exists(),
              "受保护、未知、子目录和活跃临时文件保持不变")
        check((root / "mutai-report-other.json").exists() and
              (not hardlink_created or (root / "mutai-report-hardlink.json").exists()),
              "其他导出与硬链接入口保持不变")

        repeat = manager.prune(fresh_preview.get("preview_id"), 90, 3)
        check(repeat.get("error_code") == "stale_preview",
              "预览令牌不可重复使用", repeat)

        no_candidates = manager.preview(90, 200)
        check(no_candidates.get("ok") and
              (no_candidates.get("totals") or {}).get("total_count") == 0,
              "无候选时预览为空", no_candidates)
        noop = manager.prune(no_candidates.get("preview_id"), 90, 200)
        check(noop.get("ok") and noop.get("deleted_count") == 0,
              "零候选 prune 为无害 no-op", noop)

        write(root / "mutai-report-partial.json", 200, "partial")
        partial_preview = manager.preview(90, 3)
        with patch("backend.export_store.os.unlink", side_effect=PermissionError("denied")):
            partial = manager.prune(partial_preview.get("preview_id"), 90, 3)
        check(partial.get("ok") and partial.get("partial") is True and
              partial.get("failed_count") == 1 and
              partial.get("failed", [{}])[0].get("name") == "mutai-report-partial.json",
              "单文件删除失败返回可读 partial 结果", partial)

        write(root / "mutai-report-temp-clean.json.tmp-999999-4", 2, "temp-clean")
        cleaned = manager.cleanup_stale_temps()
        check(cleaned.get("ok") and cleaned.get("deleted") == 1,
              "启动清理只删除残留临时文件", cleaned)
        check(not (root / "mutai-report-temp-clean.json.tmp-999999-4").exists(),
              "残留临时文件已清理")

        opened = []
        opener_manager = ExportManager(
            str(Path(tmp) / "exports" / "open"),
            now=lambda: NOW,
            pid_alive=lambda pid: False,
            opener=lambda path: opened.append(path),
        )
        opened_result = opener_manager.open_directory()
        check(opened_result.get("ok") and opened and
              opened[0] == os.path.abspath(str(Path(tmp) / "exports" / "open")),
              "打开目录只使用固定路径", {"result": opened_result, "opened": opened})

        not_dir = Path(tmp) / "not-a-directory"
        not_dir.write_text("x", encoding="utf-8")
        unsafe = ExportManager(str(not_dir), now=lambda: NOW).status()
        check(unsafe.get("ok") is False and unsafe.get("error_code") == "path_unsafe",
              "根路径是文件时 fail-closed", unsafe)

        bad_policy = manager.preview(0, 10)
        check(bad_policy.get("error_code") == "invalid_policy",
              "非法策略 fail-closed", bad_policy)

        tiny = ExportManager(str(root), now=lambda: NOW, max_entries=1)
        tiny_result = tiny.preview(90, 1)
        check(tiny_result.get("error_code") == "scan_truncated",
              "扫描截断时预览 fail-closed", tiny_result)

        replace_root = Path(tmp) / "replace"
        replace_old = replace_root / "mutai-report-replace.json"
        write(replace_old, 200, "AAAA")
        write(replace_root / "mutai-report-new.json", 1, "new")
        replace_manager = ExportManager(str(replace_root), now=lambda: NOW)
        replace_preview = replace_manager.preview(90, 1)
        replacement = replace_root / "replacement.tmp"
        replacement.write_bytes(b"BBBB")
        original_stat = replace_old.stat()
        os.utime(
            replacement,
            ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
        )
        os.replace(replacement, replace_old)
        replace_stale = replace_manager.prune(replace_preview.get("preview_id"), 90, 1)
        check(replace_stale.get("error_code") == "stale_preview",
              "同名同尺寸同 mtime 替换仍识别为 stale", replace_stale)
        check(replace_old.read_bytes() == b"BBBB",
              "替换后的文件在 stale 时零删除")

        week_root = Path(tmp) / "week"
        write_at(week_root / "mutai-session-week-a.json", datetime(2027, 1, 12, 12))
        write_at(week_root / "mutai-session-week-b.json", datetime(2027, 1, 13, 12))
        write_at(week_root / "mutai-session-other-week.json", datetime(2026, 12, 20, 12))
        week_manager = ExportManager(str(week_root), now=lambda: NOW)
        current_week = week_key(date(2027, 1, 13))
        other_week = week_key(date(2026, 12, 20))
        all_status = week_manager.status()
        check(all_status.get("week") is None and
              len(all_status.get("weeks") or []) >= 2,
              "导出状态返回全部自然周", all_status.get("weeks"))
        current_status = week_manager.status(current_week)
        other_status = week_manager.status(other_week)
        check(current_status.get("week") == current_week and
              current_status.get("app_files") == 2,
              "指定自然周只统计周内文件", current_status)
        check(other_status.get("app_files") == 1 and
              other_status.get("week") == other_week,
              "切换自然周统计隔离", other_status)
        weekly_preview = week_manager.preview(1, 1, current_week)
        check(weekly_preview.get("week") == current_week and
              (weekly_preview.get("totals") or {}).get("app_count") == 1 and
              all(item.get("name") != "mutai-session-other-week.json"
                  for item in weekly_preview.get("sample") or []),
              "周筛选作用于预览候选", weekly_preview)
        wrong_week = week_manager.prune(
            weekly_preview.get("preview_id"), 1, 1, other_week
        )
        check(wrong_week.get("error_code") == "stale_preview" and
              (week_root / "mutai-session-week-a.json").exists(),
              "预览令牌绑定周范围", wrong_week)
        weekly_pruned = week_manager.prune(
            week_manager.preview(1, 1, current_week).get("preview_id"),
            1,
            1,
            current_week,
        )
        check(weekly_pruned.get("ok") and
              weekly_pruned.get("deleted_count") == 1 and
              not (week_root / "mutai-session-week-a.json").exists() and
              (week_root / "mutai-session-week-b.json").exists() and
              (week_root / "mutai-session-other-week.json").exists(),
              "周内保留最近 N 个且绝不删除周外文件", weekly_pruned)
        prune_status = weekly_pruned.get("status") or {}
        check(prune_status.get("week") == current_week and
              prune_status.get("app_files") == 1,
              "周清理后的统计仍停留在所选自然周", prune_status)
        clock = [NOW]
        expiring_manager = ExportManager(str(week_root), now=lambda: clock[0])
        expiring_preview = expiring_manager.preview(1, 1, other_week)
        clock[0] += 301
        expired = expiring_manager.prune(
            expiring_preview.get("preview_id"), 1, 1, other_week
        )
        check(expired.get("error_code") == "stale_preview" and
              (week_root / "mutai-session-other-week.json").exists(),
              "周内预览过期零删除", expired)
        check(week_manager.status("2027-W99").get("error_code") == "invalid_week",
              "非法自然周 fail-closed")

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
