# -*- coding: utf-8 -*-
"""弹幕浮窗后端自测：配置校验、事件过滤、截断、持久化与性能。

用法（PowerShell）：
    & <项目目录>\\.venv\\Scripts\\python.exe `
      D:\\Document\\ChatGPT\\弹幕姬\\tools\\overlay_backend_test.py
"""

from __future__ import annotations

import copy
import json
import os
import sys
import time
from typing import Any, Dict, List

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(PROJECT_ROOT, "config.json")
LEGACY_CONFIG_PATH = os.path.join(PROJECT_ROOT, "config.legacy.json")
CLEANUP_BACKUP_PATH = os.path.join(PROJECT_ROOT, "config.cleanup.bak")
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from backend import DanmakuTTSService  # noqa: E402
from backend.config import DEFAULT_CONFIG  # noqa: E402

LEGACY_REQUIRED = {
    "enabled", "x", "y", "width", "height", "scale", "font_family",
    "font_size", "font_weight", "line_height", "color", "name_color",
    "show_name", "name_max_len", "text_max_len", "outline", "outline_color",
    "outline_width", "shadow", "bg_color", "bg_opacity", "opacity", "align",
    "max_lines", "animation", "dwell_ms", "gap", "types", "click_through",
    "always_on_top", "show_avatar", "theme", "template_id", "styles", "pins", "resolved",
    "motion", "resolved_motion",
    "typography", "resolved_typography",
}

CANONICAL_OVERLAY_KEYS = {"enabled", "geometry", "styles", "pins"}

FAILURES: List[str] = []


def log(message: str = "") -> None:
    print(message, flush=True)


def section(title: str) -> None:
    log("")
    log("=" * 72)
    log(title)
    log("=" * 72)


def check(condition: bool, label: str, detail: str = "") -> bool:
    if condition:
        log("  ok %s%s" % (label, ("：" + detail) if detail else ""))
        return True
    FAILURES.append(label)
    log("  x  %s%s" % (label, ("：" + detail) if detail else ""))
    return False


def read_config_file() -> Dict[str, Any]:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def read_config_bytes(path: str = CONFIG_PATH) -> bytes | None:
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return f.read()


def restore_config_bytes(data: bytes | None, path: str = CONFIG_PATH) -> None:
    if data is None:
        if os.path.exists(path):
            os.remove(path)
        return
    tmp = path + ".overlay-test.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def main() -> int:
    section("弹幕浮窗 · 后端自测")
    log("项目根目录：%s" % PROJECT_ROOT)
    log("Python：%s" % sys.executable)

    original_config_bytes = read_config_bytes()
    original_legacy_bytes = read_config_bytes(LEGACY_CONFIG_PATH)
    original_cleanup_bytes = read_config_bytes(CLEANUP_BACKUP_PATH)
    service = DanmakuTTSService(PROJECT_ROOT)
    original_overlay = copy.deepcopy(service.get_overlay_config())
    second: DanmakuTTSService | None = None
    exit_code = 1
    file_restored = False
    legacy_file_restored = False

    try:
        section("1. 默认配置与字段完整性")
        defaults = DEFAULT_CONFIG.get("overlay")
        check(isinstance(defaults, dict), "DEFAULT_CONFIG.overlay 存在")
        if isinstance(defaults, dict):
            check(
                set(defaults) == CANONICAL_OVERLAY_KEYS,
                "DEFAULT_CONFIG.overlay 使用 v3 结构",
                repr(sorted(defaults)),
            )
            check(
                set(defaults.get("geometry") or {}) ==
                {"x", "y", "width", "height", "scale"},
                "默认 geometry 字段齐全",
            )
            check(
                set(defaults.get("pins") or {}) == {
                    "gift", "sc", "guard", "danmaku", "enter", "like", "social", "fansclub",
                },
                "默认 pins 覆盖全部 lane",
            )

        actual = service.get_overlay_config()
        check(LEGACY_REQUIRED.issubset(set(actual)), "运行实例 overlay legacy 投影字段齐全")
        check(
            set((actual.get("types") or {}).keys()) ==
            {"danmaku", "gift", "super_chat", "guard", "enter", "like", "social", "fansclub"},
            "types 包含 8 个消息类型",
            repr(sorted((actual.get("types") or {}).keys())),
        )
        check(
            (actual.get("motion") or {}).get("schema_version") == 1 and
            (actual.get("motion") or {}).get("global", {}).get("enter_anim") == "slide",
            "motion 进入 legacy 投影且带 schema_version",
            repr(actual.get("motion")),
        )
        check(
            set((actual.get("resolved_motion") or {}).keys()) ==
            {"danmaku", "gift", "super_chat", "guard", "enter", "like", "social", "fansclub"},
            "resolved_motion 覆盖八类",
        )
        check(
            (actual.get("typography") or {}).get("schema_version") == 1 and
            set((actual.get("resolved_typography") or {}).keys()) ==
            {"danmaku", "gift", "super_chat", "guard", "enter", "like", "social", "fansclub"},
            "typography / resolved_typography 投影齐全",
        )

        state = service.get_state()
        state_keys = {
            "connection",
            "room_id",
            "room_title",
            "stats",
            "session",
            "mock",
            "history",
            "queue_len",
            "now_playing",
            "config",
            "last_error",
            "account",
        }
        check(set(state.keys()) == state_keys, "get_state 顶层契约未新增键", repr(sorted(state.keys())))
        check("overlay" in (state.get("config") or {}), "get_state().config 自动包含 overlay")

        section("2. 合法更新与深合并")
        before = copy.deepcopy(service.get_overlay_config())
        result = service.apply_overlay(
            {"font_size": 30, "color": "#ff0000", "types": {"enter": True}}
        )
        after = service.get_overlay_config()
        scale = max(0.5, min(4.0, float(after.get("scale") or 1.0)))
        projected_30 = max(12, min(96, int(round(30 * scale))))
        check(result.get("ok") is True, "apply_overlay 返回 ok=True")
        check(result.get("rejected") == [], "合法补丁 rejected 为空", repr(result.get("rejected")))
        check(after.get("font_size") == projected_30, "font_size 已按缩放生效",
              "projected=%s scale=%s" % (after.get("font_size"), scale))
        check(after.get("color") == "#FF0000", "短颜色已规范为 #FF0000", repr(after.get("color")))
        check(after.get("types", {}).get("enter") is True, "types.enter 已生效")
        template_result = service.apply_overlay({"template_id": "focus"})
        check(template_result.get("ok") is True and template_result.get("rejected") == [],
              "template_id 合法值可写入", repr(template_result.get("rejected")))
        check(service.get_overlay_config().get("template_id") == "focus",
              "template_id 投影为 focus")
        bad_template = service.apply_overlay({"template_id": "missing"})
        check("overlay.template_id" in set(bad_template.get("rejected") or []),
              "非法 template_id 进入 rejected", repr(bad_template.get("rejected")))
        service.apply_overlay({"template_id": before.get("template_id", "bubble")})
        kept = [
            key for key in before
            if key not in ("font_size", "color", "types", "resolved", "styles")
        ]
        check(
            all(after.get(key) == before.get(key) for key in kept),
            "overlay 同层其它键保持不变",
            "%d 个键" % len(kept),
        )
        kept_types = [key for key in before["types"] if key != "enter"]
        check(
            all(after["types"].get(key) == before["types"].get(key) for key in kept_types),
            "types 深合并未覆盖其它类型",
            repr({key: after["types"].get(key) for key in kept_types}),
        )

        section("3. 非法值与拒绝列表")
        before_bad = copy.deepcopy(service.get_overlay_config())
        bad = service.apply_overlay(
            {
                "font_size": 5,
                "width": 100,
                "opacity": 2,
                "color": "red",
                "align": "middle",
                "animation": "zoom",
                "types": {"unknown": True},
            }
        )
        expected_rejected = {
            "overlay.font_size",
            "overlay.width",
            "overlay.opacity",
            "overlay.color",
            "overlay.align",
            "overlay.animation",
            "overlay.types.unknown",
        }
        rejected = set(bad.get("rejected") or [])
        check(rejected == expected_rejected, "全部非法项进入 rejected", repr(sorted(rejected)))
        check(
            service.get_overlay_config() == before_bad,
            "非法补丁后 overlay 原值完整保持",
        )

        section("4. 持久化与冷启动")
        persisted_font = 31 if original_overlay.get("font_size") != 31 else 32
        persisted = service.apply_overlay({"font_size": persisted_font})
        canonical = service.get_config_v2().get("overlay") or {}
        global_style = ((canonical.get("styles") or {}).get("global") or {})
        on_disk = read_config_file().get("overlay") or {}
        on_disk_global = ((on_disk.get("styles") or {}).get("global") or {})
        check(persisted.get("rejected") == [], "持久化补丁无拒绝项")
        check(global_style.get("font_size") == persisted_font,
              "内存 v3 styles.global.font_size=%s" % persisted_font)
        check(on_disk_global.get("font_size") == persisted_font,
              "config.json 已落盘 styles.global.font_size=%s" % persisted_font)
        check(on_disk_global.get("text_color") == service.get_overlay_config().get("color"),
              "config.json styles.global.text_color 与 legacy color 一致")

        second = DanmakuTTSService(PROJECT_ROOT)
        cold = second.get_overlay_config()
        projected_persisted = max(
            12,
            min(96, int(round(persisted_font * scale))),
        )
        check(cold.get("font_size") == projected_persisted,
              "新实例冷启动读取一致",
              "projected=%s" % cold.get("font_size"))
        check(cold == service.get_overlay_config(), "新实例完整 overlay 一致")
        second.shutdown()
        second = None
        log("  冷启动实例已关闭")

        section("5. overlay_items 消息过滤")
        service.apply_overlay(
            {
                "name_max_len": 12,
                "text_max_len": 70,
                "types": {
                    "danmaku": True,
                    "gift": True,
                    "super_chat": True,
                    "guard": True,
                    "enter": False,
                },
            }
        )
        cursor = service.overlay_items(0)["cursor"]
        first = service._emit_event("danmaku", user="甲", uid=101, text="第一条")
        service._emit_event("danmaku", user="乙", uid=102, text="第二条")
        gift = service._emit_event(
            "gift",
            user="丙",
            uid=103,
            text="火箭",
            meta={
                "gift_name": "火箭",
                "num": 2,
                "price": 100,
                "guard_level": 0,
                "coin_type": "diamond",
                "diamond_count": 88,
                "platform": "douyin",
            },
        )
        service._emit_event("log", text="日志不应出现", meta={"level": "WARNING"})
        service._emit_event("status", text="状态不应出现", extra={"connection": "connected"})
        enter = service._emit_event("enter", user="丁", uid=104, text="")
        batch = service.overlay_items(cursor)
        items = batch.get("items") or []
        check(len(items) == 3, "只返回 3 条消息类事件", "types=%s" % [item.get("type") for item in items])
        check(
            [item.get("type") for item in items] == ["danmaku", "danmaku", "gift"],
            "事件类型与顺序正确",
        )
        check(all(item.get("type") not in ("log", "status", "enter") for item in items), "log/status/enter 均未出现")
        check(batch.get("cursor") == enter.get("seq"), "cursor 推进到最新事件 seq", repr(batch.get("cursor")))
        item_keys = {"seq", "type", "user", "uid", "text", "ts", "meta"}
        check(all(set(item) == item_keys for item in items), "每项顶层字段符合冻结结构")
        meta_keys = {
            "gift_name", "num", "price", "guard_level", "message",
            "coin_type", "diamond_count", "platform",
        }
        check(all(set(item.get("meta") or {}) == meta_keys for item in items), "每项 meta 字段符合冻结结构")
        check(items[0].get("seq") == first.get("seq"), "第一条 seq 对应注入事件")
        check(items[2].get("meta", {}).get("gift_name") == gift.get("meta", {}).get("gift_name"), "礼物 meta 透传正确")
        gift_meta = items[2].get("meta", {})
        check(
            gift_meta.get("coin_type") == "diamond" and
            gift_meta.get("diamond_count") == 88 and
            gift_meta.get("platform") == "douyin",
            "抖音礼物计价字段未被 overlay_items 裁剪",
            repr(gift_meta),
        )
        check(service.overlay_items(batch.get("cursor"))["items"] == [], "再次拉取无重复事件")

        section("6. 用户名与文本截断")
        service.apply_overlay({"name_max_len": 12, "text_max_len": 70, "types": {"danmaku": True}})
        cursor = service.overlay_items(0)["cursor"]
        long_user = "用" * 20
        long_text = "弹" * 100
        raw_event = service._emit_event("danmaku", user=long_user, uid=105, text=long_text)
        one = service.overlay_items(cursor)["items"][0]
        expected_user = ("用" * 12) + "…"
        expected_text = ("弹" * 70) + "…"
        check(one.get("user") == expected_user, "用户名按 12 字截断并加 …", repr(one.get("user")))
        check(one.get("text") == expected_text, "文本按 70 字截断并加 …", "%d 字符" % len(one.get("text") or ""))
        check(raw_event.get("user") == long_user, "原始事件 user 未被修改")
        check(raw_event.get("text") == long_text, "原始事件 text 未被修改")

        section("7. 性能（1000 条缓冲 × 200 次）")
        for i in range(1000):
            service._emit_event("danmaku", user="压测用户", uid=i + 1, text="性能测试文本 %d" % i)
        sample = service.overlay_items(0)
        check(len(sample.get("items") or []) == 1000, "环形缓冲最多返回 1000 条", str(len(sample.get("items") or [])))
        started = time.perf_counter()
        for _ in range(200):
            service.overlay_items(0)
        elapsed = time.perf_counter() - started
        average_ms = elapsed * 1000.0 / 200.0
        check(average_ms < 5.0, "overlay_items 平均耗时 < 5ms", "%.3f ms/次（200 次 %.1f ms）" % (average_ms, elapsed * 1000.0))

        section("8. 还原原 overlay 配置")
        restored = service.apply_overlay(original_overlay)
        check(restored.get("ok") is True, "原 overlay 配置恢复调用成功",
              repr(restored.get("rejected")))
        stable_keys = (
            "font_size", "font_family", "line_height", "color", "name_color",
            "bg_color", "align", "animation", "show_name", "types",
        )
        restore_config_bytes(original_config_bytes)
        restore_config_bytes(original_legacy_bytes, LEGACY_CONFIG_PATH)
        restore_config_bytes(original_cleanup_bytes, CLEANUP_BACKUP_PATH)
        file_restored = read_config_bytes() == original_config_bytes
        legacy_file_restored = read_config_bytes(LEGACY_CONFIG_PATH) == original_legacy_bytes
        cleanup_file_restored = read_config_bytes(CLEANUP_BACKUP_PATH) == original_cleanup_bytes
        check(file_restored, "config.json 已字节级恢复为测试前文件")
        check(legacy_file_restored, "config.legacy.json 已字节级恢复为测试前文件")
        check(cleanup_file_restored, "config.cleanup.bak 已恢复为测试前状态")
        service.shutdown()
        restored_service = DanmakuTTSService(PROJECT_ROOT)
        restored_projection = restored_service.get_overlay_config()
        restored_service.shutdown()
        check(
            all(restored_projection.get(key) == original_overlay.get(key)
                for key in stable_keys),
            "恢复后冷启动投影关键字段与测试前一致",
            repr({key: (original_overlay.get(key), restored_projection.get(key))
                  for key in stable_keys
                  if restored_projection.get(key) != original_overlay.get(key)}),
        )
        exit_code = 0 if not FAILURES else 1
    finally:
        if second is not None:
            try:
                second.shutdown()
            except Exception:  # noqa: BLE001
                pass
        if not file_restored:
            try:
                service.apply_overlay(original_overlay)
            except Exception:  # noqa: BLE001
                pass
        service.shutdown()
        if read_config_bytes() != original_config_bytes:
            restore_config_bytes(original_config_bytes)
        if read_config_bytes(LEGACY_CONFIG_PATH) != original_legacy_bytes:
            restore_config_bytes(original_legacy_bytes, LEGACY_CONFIG_PATH)
        if read_config_bytes(CLEANUP_BACKUP_PATH) != original_cleanup_bytes:
            restore_config_bytes(original_cleanup_bytes, CLEANUP_BACKUP_PATH)

    section("9. 结论")
    if FAILURES:
        log("失败项 %d 个：" % len(FAILURES))
        for item in FAILURES:
            log("  - %s" % item)
    else:
        log("全部通过")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
