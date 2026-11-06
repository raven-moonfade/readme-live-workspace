#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证多基准场对比报告的服务端重算、JSON/CSV 与失败边界。"""

from __future__ import annotations

import csv
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.sessions import SessionStore  # noqa: E402
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


def seed(
    store: SessionStore,
    session_id: str,
    started: float,
    received: int,
    *,
    duration: int = 3600,
    title: str = "",
    reason: str = "finished",
    mock: int = 0,
    spoken_ratio: float = 0.8,
    platform: str = "bilibili",
    room_key: str = "room:777",
    room_id: int = 777,
) -> None:
    store.start_session(
        session_id,
        room_id,
        title or session_id,
        started_at=started,
        platform=platform,
        room_key=room_key,
    )
    for index in range(received):
        kind = "gift" if index == 0 else "danmaku"
        meta = {"total_coin": 1000, "coin_type": "gold"} if kind == "gift" else {}
        store.record_message(
            session_id,
            kind,
            started + (10 + index % 5) * 60 + 5,
            "viewer-%d" % (index % 7 + 1),
            meta,
        )
    for index in range(mock):
        store.record_message(
            session_id,
            "danmaku",
            started + (20 + index) * 60 + 5,
            "",
            {},
            scope="mock",
        )
    store.bump_session(session_id, "real", "spoken", int(received * spoken_ratio))
    store.bump_session(session_id, "real", "dropped", int(received * 0.2))
    store.finish_session(session_id, ended_at=started + duration, reason=reason)


def read_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def read_csv(path: str) -> tuple[list[str], list[dict[str, str]]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def main() -> int:
    with tempfile.TemporaryDirectory(
        prefix="mutai-multi-export-",
        ignore_cleanup_errors=True,
    ) as tmp:
        store = SessionStore(str(Path(tmp) / "data" / "history.sqlite3"))
        base = datetime(2026, 1, 1, 20, 0, 0).timestamp()
        target_start = base
        seed(store, "target", target_start, 120, title="=夜航电台", mock=2)
        seed(
            store,
            "baseline-short",
            target_start - 2 * 86400,
            5,
            duration=300,
            title="短样本",
            reason="interrupted",
        )
        seed(
            store,
            "baseline-overlap",
            target_start + 1800,
            80,
            duration=3600,
            title="重叠场",
            spoken_ratio=0.6,
        )
        seed(
            store,
            "baseline-boundary",
            target_start + 3600,
            60,
            duration=3600,
            title="边界场",
        )
        seed(
            store,
            "dy-target",
            target_start,
            40,
            title="抖音目标",
            platform="douyin",
            room_key="dy:42",
            room_id=42,
        )
        seed(
            store,
            "dy-b1",
            target_start - 86400,
            30,
            title="抖音基准一",
            platform="douyin",
            room_key="dy:42",
            room_id=42,
        )
        seed(
            store,
            "dy-b2",
            target_start - 172800,
            20,
            title="抖音基准二",
            platform="douyin",
            room_key="dy:42",
            room_id=42,
        )
        store.flush(3.0)

        out = str(Path(tmp) / "exports")
        ids = ["baseline-short", "baseline-overlap", "baseline-boundary"]
        exported = store.export_compare_multi_report(
            "target",
            ids,
            fmt="json",
            output_dir=out,
        )
        check(exported.get("ok") is True, "多场 JSON 导出成功", exported)
        check(exported.get("kind") == "compare_multi", "多场报告 kind 正确", exported)
        report = read_json(exported["path"])
        check(
            report.get("report_schema_version") == 2 and
            report.get("compare_multi_schema_version") == 2 and
            report.get("definitions_version") == 1,
            "多场报告带 schema 与定义版本",
        )
        check(
            report.get("privacy") == "aggregate_only_no_message_bodies_or_user_identifiers",
            "多场报告带隐私声明",
        )
        check(
            [item.get("id") for item in report.get("baselines") or []] == ids and
            [item.get("key") for item in report.get("baselines") or []] == ["b1", "b2", "b3"],
            "多场基准保持请求顺序",
            report.get("baselines"),
        )
        check(report.get("baseline_count") == 3 and report.get("max_baselines") == 3,
              "多场报告基准数量正确")
        check(
            [item.get("key") for item in report.get("series") or []] ==
            ["current", "b1", "b2", "b3"],
            "series 包含当前与三个基准",
        )
        overlap = report.get("overlap") or {}
        overlap_text = json.dumps(overlap, ensure_ascii=False)
        pairs = overlap.get("pairs") or []
        check(
            len(pairs) == 2 and
            any(pair.get("left_key") == "current" and pair.get("right_key") == "b2"
                for pair in pairs) and
            "重叠" in overlap_text,
            "当前与基准重叠进入 overlap", overlap,
        )
        check(
            not any(pair.get("left_key") == "current" and pair.get("right_key") == "b3"
                    for pair in pairs),
            "边界相接不误报当前场重叠", overlap,
        )
        target_quality = (report.get("quality") or {}).get("target") or {}
        target_codes = [item.get("code") for item in target_quality.get("flags") or []]
        check("mock_excluded" in target_codes, "当前场模拟标记归因到当前", target_codes)
        baseline_quality = (report.get("quality") or {}).get("baselines") or []
        b1_codes = [item.get("code") for item in baseline_quality[0].get("flags") or []]
        check("mock_excluded" not in b1_codes and "short_sample" in b1_codes,
              "基准质量标记不继承当前场模拟标记", b1_codes)
        check(
            all(item.get("code") != "duration_skew_vs_current" for item in
                (baseline_quality[1].get("flags") or [])),
            "重叠基准时长正常时不误报时长差异",
        )
        metric_rows = (report.get("metrics") or {}).get("rows") or []
        received = next(
            item for item in metric_rows if item.get("metric_key") == "received"
        )
        check(
            received.get("deltas_vs_current", {}).get("b1") == 115 and
            received.get("deltas_vs_current", {}).get("b2") == 40,
            "deltas_vs_current 方向为当前减基准",
            received,
        )
        spoken_rate_row = next(
            item for item in metric_rows if item.get("metric_key") == "spoken_rate"
        )
        check(spoken_rate_row.get("delta_unit") == "比例",
              "比例指标 delta 单位与原始比例值一致", spoken_rate_row)
        check(
            abs(float(spoken_rate_row.get("values", {}).get("current")) - 0.8) < 1e-9 and
            abs(float(spoken_rate_row.get("values", {}).get("b2")) - 0.6) < 1e-9 and
            abs(float(spoken_rate_row.get("deltas_vs_current", {}).get("b2")) - 0.2) < 1e-9,
            "比例指标保留原始比例值且 delta 未乘 100",
            spoken_rate_row,
        )
        check(
            not any("average" in str(key).lower() or "rank" in str(key).lower()
                    for key in report.keys()),
            "报告不含平均值或排名字段",
        )
        text = json.dumps(report, ensure_ascii=False)
        check(
            "viewer-" not in text and "\"uid\"" not in text.lower() and
            "\"user_id\"" not in text.lower() and
            "username" not in text.lower(),
            "多场 JSON 不含用户标识",
            {
                "viewer": "viewer-" in text,
                "uid_key": "\"uid\"" in text.lower(),
                "user_id_key": "\"user_id\"" in text.lower(),
                "username": "username" in text.lower(),
            },
        )
        check(report.get("money", {}).get("comparable") is True,
              "B 平台金额可比")
        check(
            any(item.get("code") == "overlap_detected"
                for item in report.get("warnings") or []),
            "重叠写入全局 warning",
        )
        original_dropped = store._dropped_ops
        store._dropped_ops = 1
        dropped = store.export_compare_multi_report(
            "target", ids, fmt="json", output_dir=out
        )
        store._dropped_ops = original_dropped
        check(dropped.get("ok") is True, "写入丢弃仍可导出", dropped)
        dropped_report = read_json(dropped["path"])
        check(
            any(item.get("code") == "write_dropped"
                for item in dropped_report.get("warnings") or []),
            "写入丢弃写入 warning",
        )

        csv_result = store.export_compare_multi_report(
            "target",
            ids,
            fmt="csv",
            output_dir=out,
        )
        check(csv_result.get("ok") is True, "多场 CSV 导出成功", csv_result)
        columns, rows = read_csv(csv_result["path"])
        required = {
            "series_key", "series_label", "section", "metric_key",
            "value", "delta_vs_current", "value_text", "related_key",
            "baseline_ids", "warning_codes", "compare_multi_schema_version",
        }
        check(required.issubset(set(columns)), "多场 CSV 长表列完整", columns)
        keys = [
            (row.get("series_key"), row.get("related_key"), row.get("section"),
             row.get("metric_key"))
            for row in rows
        ]
        check(len(keys) == len(set(keys)), "多场 CSV 唯一键无重复", len(keys))
        check(
            all(row.get("baseline_ids") == ";".join(ids) for row in rows),
            "CSV 每行携带有序基准 ID",
        )
        check(
            any(row.get("series_key") == "b1" and row.get("section") == "quality"
                and row.get("metric_key") == "quality_short_sample"
                for row in rows),
            "CSV 写入基准质量标记",
        )
        check(
            any(row.get("series_key") == "b1" and
                row.get("metric_key") == "quality_duration_skew_vs_current" and
                row.get("related_key") == "current"
                for row in rows),
            "相对当前的质量标记写入 related_key",
        )
        check(
            any(row.get("section") == "overlap" and
                (row.get("related_key") in ("b2", "b3"))
                for row in rows),
            "CSV 写入重叠对",
        )
        check(
            all(row.get("delta_unit") == "比例"
                for row in rows
                if row.get("section") == "types"
                and row.get("metric_key", "").endswith("_share")
                and row.get("series_key") != "current"),
            "类型占比 delta 单位与原始比例值一致",
        )
        type_row = next(
            item for item in (report.get("types") or {}).get("rows", [])
            if item.get("type_key") == "danmaku"
        )
        current_share = float(type_row["shares"]["current"])
        b2_share = float(type_row["shares"]["b2"])
        share_csv = next(
            row for row in rows
            if row.get("section") == "types"
            and row.get("metric_key") == "danmaku_share"
            and row.get("series_key") == "b2"
        )
        check(
            abs(float(share_csv.get("value")) - b2_share) < 1e-9 and
            abs(float(share_csv.get("delta_vs_current")) - (current_share - b2_share)) < 1e-9,
            "类型占比 CSV 使用原始比例差值",
            {"current": current_share, "b2": b2_share, "row": share_csv},
        )
        check(
            any(row.get("scope_room_title", "").startswith("'=") for row in rows),
            "CSV 转义公式注入房间标题",
        )

        dy_export = store.export_compare_multi_report(
            "dy-target", ["dy-b1", "dy-b2"], fmt="json", output_dir=out
        )
        check(dy_export.get("ok") is True, "非 B 平台多场仍可导出")
        dy_report = read_json(dy_export["path"])
        check(dy_report.get("money", {}).get("comparable") is False,
              "非 B 平台金额不可比")
        check("钻石" in str(dy_report.get("money", {}).get("note") or "") and
              "SC/舰长" in str(dy_report.get("money", {}).get("note") or ""),
              "非 B 平台多场报告说明钻石与 SC/舰长边界",
              dy_report.get("money"))
        check(
            any(item.get("code") == "money_not_comparable"
                for item in dy_report.get("warnings") or []),
            "非 B 平台金额 warning",
        )
        dy_csv = store.export_compare_multi_report(
            "dy-target", ["dy-b1", "dy-b2"], fmt="csv", output_dir=out
        )
        _, dy_rows = read_csv(dy_csv["path"])
        money_rows = [row for row in dy_rows if row.get("section") == "money"]
        check(bool(money_rows) and all(row.get("value") == "" for row in money_rows),
              "非 B 平台 CSV 金额留空", money_rows[:3])

        one = store.export_compare_multi_report(
            "target", ["baseline-short"], fmt="json", output_dir=out
        )
        check(one.get("ok") is False and one.get("error_code") == "insufficient_baselines",
              "少于 2 个基准拒绝导出", one)
        four = store.export_compare_multi_report(
            "target", ids + ["baseline-boundary"], fmt="json", output_dir=out
        )
        check(four.get("ok") is False and four.get("error_code") == "too_many_baselines",
              "超过 3 个基准拒绝导出", four)
        missing = store.export_compare_multi_report(
            "target", ["baseline-short", "missing"], fmt="json", output_dir=out
        )
        check(missing.get("error_code") == "baseline_not_found" and
              missing.get("baseline_index") == 2,
              "缺失基准整体失败并带索引", missing)

        before = set(os.listdir(out))
        original_flush = store.flush
        store.flush = lambda timeout=None: False  # type: ignore[assignment]
        stale = store.export_compare_multi_report(
            "target", ids, fmt="json", output_dir=out
        )
        store.flush = original_flush  # type: ignore[assignment]
        check(stale.get("ok") is False and stale.get("error_code") == "data_stale",
              "多场导出 stale fail-closed", stale)
        check(set(os.listdir(out)) == before, "stale 不生成文件")

        first = store.export_compare_multi_report(
            "target", ids, fmt="json", output_dir=out
        )
        second = store.export_compare_multi_report(
            "target", ids, fmt="json", output_dir=out
        )
        check(first.get("ok") and second.get("ok") and first.get("path") != second.get("path"),
              "同秒导出文件名不冲突")

        store.flush(3.0)
        status = ExportManager(out).status()
        check(status.get("ok") is True and status.get("app_files", 0) >= 1,
              "导出管理能统计多场报告文件", status)

    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
