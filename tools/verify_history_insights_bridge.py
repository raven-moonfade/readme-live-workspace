#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证场次洞察 JsApi 桥接。"""

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

    def session_insights(self, target_id):
        self.calls.append(target_id)
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "target": {"id": target_id}}


def make_api(service):
    api = object.__new__(JsApi)
    api._svc = service
    return api


def main() -> int:
    service = FakeService()
    api = make_api(service)
    result = api.history_session_insights("target")
    check(result.get("ok") and result.get("target", {}).get("id") == "target",
          "洞察桥接成功", result)
    check(service.calls == ["target"], "洞察桥接按 target id 传递", service.calls)

    service.fail = True
    failed = api.history_session_insights("target")
    check(not failed.get("ok") and failed.get("error_code") == "internal",
          "洞察异常不抛给 JS", failed)

    class MissingService:
        pass

    missing = make_api(MissingService()).history_session_insights("target")
    check(missing.get("error_code") == "unsupported",
          "旧后端缺洞察接口返回 unsupported")

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
