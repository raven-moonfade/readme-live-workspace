#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证趋势/对比/复盘分析导出 JsApi 桥接。"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import JsApi  # noqa: E402
from backend.core import DanmakuTTSService  # noqa: E402

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

    def export_history_trend(self, started_from, started_to, **kwargs):
        self.calls.append(("trend", started_from, started_to, kwargs))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "kind": "trend"}

    def export_history_compare(self, target_id, baseline_id, fmt="json"):
        self.calls.append(("compare", target_id, baseline_id, fmt))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "kind": "compare"}

    def export_history_compare_multi(self, target_id, baseline_ids, fmt="json"):
        self.calls.append(("compare_multi", target_id, baseline_ids, fmt))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "kind": "compare_multi"}

    def export_history_insights(self, target_id, fmt="json"):
        self.calls.append(("insights", target_id, fmt))
        if self.fail:
            raise RuntimeError("boom")
        return {"ok": True, "kind": "insights"}

    def history_trend(self, started_from, started_to, query="", platform=None,
                      granularity="day", room_key=None):
        self.calls.append(("trend-api", started_from, started_to, query, platform,
                           granularity, room_key))
        return {"ok": True, "granularity": granularity, "room_key": room_key}


def make_api(service):
    api = object.__new__(JsApi)
    api._svc = service
    return api


def main() -> int:
    service = FakeService()
    api = make_api(service)

    trend = api.history_export_trend(
        100,
        200,
        "search",
        "bilibili",
        "day",
        "room:777",
        "csv",
    )
    check(trend.get("ok") and trend.get("kind") == "trend", "趋势导出桥接成功", trend)
    check(
        service.calls[-1] == (
            "trend",
            100,
            200,
            {
                "query": "search",
                "platform": "bilibili",
                "granularity": "day",
                "room_key": "room:777",
                "fmt": "csv",
            },
        ),
        "趋势导出参数按关键字传递",
        service.calls[-1],
    )

    compare = api.history_export_compare("target", "baseline", "json")
    check(compare.get("ok") and compare.get("kind") == "compare", "对比导出桥接成功", compare)
    check(service.calls[-1] == ("compare", "target", "baseline", "json"),
          "对比导出传递双方场次 ID", service.calls[-1])

    multi = api.history_export_compare_multi(
        "target", ["b2", "b1", "b3"], "csv"
    )
    check(multi.get("ok") and multi.get("kind") == "compare_multi",
          "多场导出桥接成功", multi)
    check(service.calls[-1] == (
        "compare_multi", "target", ["b2", "b1", "b3"], "csv"
    ), "多场导出保持基准顺序", service.calls[-1])
    invalid_multi = api.history_export_compare_multi("target", "b1", "json")
    check(invalid_multi.get("error_code") == "invalid_argument",
          "多场导出拒绝非数组基准", invalid_multi)

    insights = api.history_export_insights("target", "csv")
    check(insights.get("ok") and insights.get("kind") == "insights", "复盘导出桥接成功", insights)
    check(service.calls[-1] == ("insights", "target", "csv"),
          "复盘导出传递目标与格式", service.calls[-1])

    service.fail = True
    trend_failed = api.history_export_trend(100, 200, fmt="json")
    compare_failed = api.history_export_compare("target", "baseline")
    multi_failed = api.history_export_compare_multi("target", ["b1", "b2"])
    insights_failed = api.history_export_insights("target")
    check(trend_failed.get("error_code") == "internal", "趋势导出异常不抛给 JS", trend_failed)
    check(compare_failed.get("error_code") == "internal", "对比导出异常不抛给 JS", compare_failed)
    check(multi_failed.get("error_code") == "internal",
          "多场导出异常不抛给 JS", multi_failed)
    check(insights_failed.get("error_code") == "internal", "复盘导出异常不抛给 JS", insights_failed)

    class MissingService:
        pass

    missing = make_api(MissingService())
    check(missing.history_export_trend(1, 2).get("error_code") == "unsupported",
          "旧后端缺趋势导出返回 unsupported")
    check(missing.history_export_compare("a", "b").get("error_code") == "unsupported",
          "旧后端缺对比导出返回 unsupported")
    check(missing.history_export_compare_multi("a", ["b", "c"]).get("error_code") == "unsupported",
          "旧后端缺多场导出返回 unsupported")
    check(missing.history_export_insights("a").get("error_code") == "unsupported",
          "旧后端缺复盘导出返回 unsupported")

    class Store:
        available = True
        error = ""
        dropped_ops = 0
        failed_ops = 0
        last_write_error = ""

    service_with_store = object.__new__(DanmakuTTSService)
    service_with_store.session_store = Store()
    status = service_with_store.history_status()
    check(status.get("capabilities", {}).get("analysis_export") == 1,
          "历史状态暴露 analysis_export 能力位", status)
    check(status.get("capabilities", {}).get("analysis_export_compare_multi") == 1,
          "历史状态暴露多场导出能力位", status.get("capabilities"))
    check(status.get("capabilities", {}).get("trend_granularities") == ["hour", "day", "week"],
          "历史状态暴露小时/日/周趋势能力位", status.get("capabilities"))

    legacy_trend = api.history_trend(1, 2, "q", "bilibili", "room:777")
    check(legacy_trend.get("ok") and legacy_trend.get("granularity") == "day" and
          legacy_trend.get("room_key") == "room:777",
          "旧 5 参数趋势调用兼容", service.calls[-1])

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
