#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证任意基准场对比的 JsApi 位置参数和错误兜底。"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import JsApi  # noqa: E402

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
    def __init__(self):
        self.calls = []
        self.fail = False

    def list_history_baselines(self, *args):
        self.calls.append(("list", args))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "args": args}

    def compare_history_sessions(self, *args):
        self.calls.append(("compare", args))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "args": args}

    def get_previous_history_session(self, session_id):
        self.calls.append(("previous", (session_id,)))
        return {"ok": True, "status": "no_previous", "target": None, "previous": None, "has_previous": False}


def make_api(service):
    api = object.__new__(JsApi)
    api._svc = service
    return api


def main() -> int:
    service = FakeService()
    api = make_api(service)

    result = api.history_list_baselines("target", 20, 100.5, 200.25, "id-1", "target")
    check(result.get("ok"), "候选桥接成功", result)
    check(service.calls[-1] == (
        "list",
        ("target", 20, 100.5, 200.25, "id-1", "target"),
    ), "候选桥接按位置参数完整传递", service.calls[-1])

    compare = api.history_compare_sessions("target", "baseline")
    check(compare.get("ok"), "显式对比桥接成功", compare)
    check(service.calls[-1] == ("compare", ("target", "baseline")),
          "显式对比桥接按 id 传递", service.calls[-1])

    previous = api.history_get_previous_session("target")
    check(previous.get("status") == "no_previous", "旧上一场桥接契约不变")

    defaults = api.history_list_baselines("target")
    check(defaults.get("args") == ("target", 30, None, None, None, None),
          "候选桥接默认 limit 和空 cursor", defaults)
    for bad_limit in ("abc", 0, 101, float("inf")):
        invalid_limit = api.history_list_baselines("target", bad_limit)
        check(invalid_limit.get("error_code") == "invalid_argument",
              "非法 limit 返回稳定错误码：%r" % (bad_limit,),
              invalid_limit)

    service.fail = True
    failed = api.history_list_baselines("target")
    check(not failed.get("ok") and failed.get("error_code") == "internal",
          "候选桥接异常不抛给 JS", failed)
    failed_compare = api.history_compare_sessions("a", "b")
    check(not failed_compare.get("ok") and failed_compare.get("error_code") == "internal",
          "对比桥接异常不抛给 JS", failed_compare)

    class MissingService:
        pass

    missing_api = make_api(MissingService())
    missing_candidates = missing_api.history_list_baselines("target")
    missing_compare = missing_api.history_compare_sessions("a", "b")
    check(missing_candidates.get("error_code") == "unsupported",
          "旧后端缺候选接口返回 unsupported")
    check(missing_compare.get("error_code") == "unsupported",
          "旧后端缺对比接口返回 unsupported")

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
