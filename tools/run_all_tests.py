#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""运行 ReadMe 当前的后端与工作台回归套件。

默认会跑 tools 下的 verify_*.py、overlay_backend_test.py、smoke_test.py，
以及 tests/ui 下的 test-workspace-*.js。每个测试单独进程运行，
失败时保留完整日志路径，避免一个失败遮住后续结果。
"""

from __future__ import annotations

import argparse
import atexit
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import List, Tuple


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORK_DIR = PROJECT_ROOT / "tests" / "ui"
EXPECTED_UI_TESTS = 12
EXPECTED_BACKEND_TESTS = 43
CONFIG_NAMES = ("config.json", "config.legacy.json", "config.cleanup.bak", "config.save.txn")
DEFAULT_PW_ROOT = PROJECT_ROOT / "node_modules"


def _python_tests(skip_smoke: bool = False) -> List[Path]:
    tools = PROJECT_ROOT / "tools"
    tests = sorted(tools.glob("verify_*.py"))
    for name in ("overlay_backend_test.py", "smoke_test.py"):
        if name == "smoke_test.py" and skip_smoke:
            continue
        path = tools / name
        if path.exists():
            tests.append(path)
    return tests


def _ui_tests(work_dir: Path) -> List[Path]:
    if not work_dir.is_dir():
        return []
    return sorted(work_dir.glob("test-workspace-*.js"))


def _run(
    command: List[str],
    cwd: Path,
    timeout: int,
    log_dir: Path,
    label: str,
    env: dict | None = None,
) -> Tuple[int, float, Path]:
    started = time.perf_counter()
    log_path = log_dir / (label.replace(os.sep, "_") + ".log")
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
            env=env,
        )
        output = completed.stdout.decode("utf-8", errors="replace")
        code = completed.returncode
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or b"").decode("utf-8", errors="replace")
        output += "\n[timeout] %d 秒内未完成\n" % timeout
        code = 124
    except Exception as exc:  # noqa: BLE001
        output = "[runner] %s: %s\n" % (type(exc).__name__, exc)
        code = 125
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(output, encoding="utf-8")
    return code, time.perf_counter() - started, log_path


def _print_tail(path: Path, lines: int = 24) -> None:
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return
    for line in content[-lines:]:
        print("    " + line)


def _snapshot_configs() -> dict:
    snapshot = {}
    for name in CONFIG_NAMES:
        path = PROJECT_ROOT / name
        snapshot[name] = path.read_bytes() if path.is_file() else None
    return snapshot


def _restore_configs(snapshot: dict) -> None:
    changed = []
    for name, original in snapshot.items():
        path = PROJECT_ROOT / name
        current = path.read_bytes() if path.is_file() else None
        if current == original:
            continue
        if original is None:
            if current is not None:
                path.unlink()
                changed.append(name)
            continue
        tmp = path.with_name(path.name + ".runner-restore.tmp")
        tmp.write_bytes(original)
        os.replace(tmp, path)
        changed.append(name)
    if changed:
        print("CONFIG_RESTORED=" + ",".join(changed), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="运行 ReadMe 回归套件")
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_WORK_DIR,
                        help="工作台 JS 测试目录（默认 tests/ui）")
    parser.add_argument("--backend-only", action="store_true")
    parser.add_argument("--ui-only", action="store_true")
    parser.add_argument("--list", action="store_true", help="只列出测试")
    parser.add_argument("--skip-smoke", action="store_true",
                        help="跳过耗时约 84 秒的 smoke_test.py")
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()

    backend = [] if args.ui_only else _python_tests(args.skip_smoke)
    expected_backend = EXPECTED_BACKEND_TESTS - (1 if args.skip_smoke else 0)
    if backend and len(backend) != expected_backend:
        print(
            "后端测试数量不符：期望 %d，实际 %d" % (expected_backend, len(backend)),
            file=sys.stderr,
        )
        return 2
    if not args.backend_only and not args.work_dir.is_dir():
        print("工作台测试目录不存在：" + str(args.work_dir), file=sys.stderr)
        return 2
    ui = [] if args.backend_only else _ui_tests(args.work_dir)
    if ui and len(ui) != EXPECTED_UI_TESTS:
        print(
            "工作台测试数量不符：期望 %d，实际 %d" % (EXPECTED_UI_TESTS, len(ui)),
            file=sys.stderr,
        )
        return 2
    if not args.backend_only and not ui:
        print("没有找到工作台测试。", file=sys.stderr)
        return 2
    node = shutil.which("node")
    if ui and not node:
        print("找不到 node，无法运行工作台 JS 测试。", file=sys.stderr)
        return 2

    if args.list:
        print("后端：")
        for path in backend:
            print("  " + str(path.relative_to(PROJECT_ROOT)))
        print("工作台：")
        for path in ui:
            print("  " + str(path))
        return 0

    # Some legacy diagnostics still instantiate a service in PROJECT_ROOT.
    # Keep the user's paired config byte-identical even if one of them writes.
    atexit.register(_restore_configs, _snapshot_configs())

    log_dir = Path(tempfile.mkdtemp(prefix="mutai-tests-"))
    results: List[Tuple[str, int, float, Path]] = []
    test_env = os.environ.copy()
    test_env["MUTAI_PROJECT_ROOT"] = str(PROJECT_ROOT)
    test_env["MUTAI_UI_SHOTS"] = str(PROJECT_ROOT / "qa" / "shots" / "ui")
    pw_root = os.environ.get("MUTAI_PW_ROOT") or str(DEFAULT_PW_ROOT)
    if (Path(pw_root) / "playwright").exists():
        test_env["MUTAI_PW_ROOT"] = pw_root.rstrip("\\/") + os.sep
    else:
        test_env.pop("MUTAI_PW_ROOT", None)
    started = time.perf_counter()

    print("后端测试（%d）" % len(backend))
    for path in backend:
        label = "backend_" + path.stem
        print("  [RUN] " + path.name)
        code, elapsed, log = _run(
            [sys.executable, str(path)],
            PROJECT_ROOT,
            args.timeout,
            log_dir,
            label,
            env=test_env,
        )
        results.append((label, code, elapsed, log))
        print("  [%s] %.1fs" % ("PASS" if code == 0 else "FAIL", elapsed))
        if code != 0:
            _print_tail(log)

    print("工作台测试（%d）" % len(ui))
    for path in ui:
        label = "ui_" + path.stem
        print("  [RUN] " + path.name)
        code, elapsed, log = _run(
            [node, str(path)],
            path.parent,
            args.timeout,
            log_dir,
            label,
            env=test_env,
        )
        results.append((label, code, elapsed, log))
        print("  [%s] %.1fs" % ("PASS" if code == 0 else "FAIL", elapsed))
        if code != 0:
            _print_tail(log)

    failed = [item for item in results if item[1] != 0]
    print("")
    print("SUMMARY  total=%d  pass=%d  fail=%d  elapsed=%.1fs" % (
        len(results),
        len(results) - len(failed),
        len(failed),
        time.perf_counter() - started,
    ))
    print("logs: " + str(log_dir))
    if failed:
        print("FAILED:")
        for label, _code, _elapsed, log in failed:
            print("  - %s  %s" % (label, log))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
