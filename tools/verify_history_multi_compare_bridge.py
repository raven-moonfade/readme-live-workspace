#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证多基准场对比的 JsApi 位置参数与错误兜底。"""

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

    def compare_multi_history_sessions(self, *args):
        self.calls.append(args)
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "args": args}


def make_api(service):
    api = object.__new__(JsApi)
    api._svc = service
    return api


def main() -> int:
    service = FakeService()
    api = make_api(service)

    result = api.history_compare_multi("target", ["b1", "b2", "b3"])
    check(result.get("ok"), "多场对比桥接成功", result)
    check(service.calls[-1] == ("target", ["b1", "b2", "b3"]),
          "桥接保持目标与基准顺序", service.calls[-1])

    tuple_result = api.history_compare_multi("target", ("b1", "b2"))
    check(tuple_result.get("ok") and service.calls[-1] == ("target", ["b1", "b2"]),
          "桥接接受 tuple 并转为 list", service.calls[-1])

    for bad_ids in (None, "b1", 3, {"b1": 1}):
        before = len(service.calls)
        invalid = api.history_compare_multi("target", bad_ids)
        check(invalid.get("error_code") == "invalid_argument" and
              len(service.calls) == before,
              "非数组 baseline_ids 不进入服务层：%r" % (bad_ids,), invalid)

    service.fail = True
    failed = api.history_compare_multi("target", ["b1", "b2"])
    check(not failed.get("ok") and failed.get("error_code") == "internal",
          "服务异常不抛给 JS", failed)

    class MissingService:
        pass

    missing_api = make_api(MissingService())
    missing = missing_api.history_compare_multi("target", ["b1", "b2"])
    check(missing.get("error_code") == "unsupported",
          "旧后端缺多场接口返回 unsupported", missing)

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
