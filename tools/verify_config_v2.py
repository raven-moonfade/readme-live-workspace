#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证现行配置（v3）、历史迁移、备份、DPAPI 与 ConfigStore 字段持久化。

文件名保留为 verify_config_v2 以兼容既有 QA 入口；断言跟随
``SCHEMA_VERSION``，不再硬编码历史版本号。
"""

from __future__ import annotations

import copy
import base64
import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

logging.disable(logging.CRITICAL)

from backend import secrets_win  # noqa: E402
from backend.config import (  # noqa: E402
    DEFAULT_CONFIG,
    OVERLAY_TYPES,
    SCHEMA_VERSION,
    STYLE_FIELDS,
    ConfigStore,
    canonical_config,
    validate_config,
)

PASS = 0
FAIL = 0
FAILURES: List[str] = []


def check(condition: bool, label: str, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("PASS  %s%s" % (label, ("  " + str(detail)) if detail else ""))
    else:
        FAIL += 1
        FAILURES.append(label)
        print("FAIL  %s%s" % (label, ("  " + str(detail)) if detail else ""))


def section(title: str) -> None:
    print("\n-- %s --" % title)


def write_json(path: Path, value: Any) -> bytes:
    data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    path.write_bytes(data)
    return data


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    return value if isinstance(value, dict) else {}


def v1_fixture(token: str) -> Dict[str, Any]:
    return {
        "room_id": 22625568,
        "sessdata": "",
        "tts": {
            "voice": "zh-CN-XiaoyiNeural",
            "rate": "+11%",
            "pitch": "+12Hz",
            "volume": "+0%",
        },
        "read": {
            "danmaku": True,
            "gift": True,
            "super_chat": True,
            "guard": True,
            "enter": True,
            "gift_min_price": 0,
            "include_user": True,
            "templates": {
                "danmaku": "{user}说：{text}",
                "gift": "感谢{user}送出的{gift_name}乘以{num}",
                "super_chat": "{user}的醒目留言：{message}",
                "guard": "感谢{user}开通{guard_name}",
                "enter": "{user}进入直播间",
            },
        },
        "filters": {
            "blacklist": [],
            "dedup_seconds": 5.0,
            "max_len": 80,
            "user_cooldown": 3.0,
            "global_cooldown": 0.5,
        },
        "queue": {"max_size": 30},
        "overlay": {
            "enabled": True,
            "x": -1560,
            "y": 56,
            "width": 451,
            "height": 642,
            "scale": 1.0,
            "font_family": "Microsoft YaHei UI",
            "font_size": 22,
            "font_weight": 600,
            "line_height": 1.55,
            "color": "#FFFFFF",
            "name_color": "#8FE3FF",
            "name_sep": "：",
            "show_name": True,
            "name_max_len": 18,
            "text_max_len": 101,
            "outline": True,
            "outline_color": "#000000",
            "outline_width": 2,
            "shadow": True,
            "bg_color": "#000000",
            "bg_opacity": 0.22,
            "opacity": 1.0,
            "align": "left",
            "max_lines": 8,
            "animation": "slide",
            "dwell_ms": 120000,
            "gap": 8,
            "types": {
                "danmaku": True,
                "gift": True,
                "super_chat": True,
                "guard": True,
                "enter": True,
            },
            "click_through": False,
            "always_on_top": True,
            "show_avatar": False,
            "theme": "classic",
            "gift_pin": True,
            "gift_pin_position": "bottom",
            "gift_pin_duration_ms": 15000,
            "gift_pin_max": 2,
            "gift_pin_min_price": 0,
        },
        "mock": {
            "interval_ms": 1500,
            "per_tick": 1,
            "speak": True,
            "types": {
                "danmaku": True,
                "gift": True,
                "super_chat": True,
                "guard": True,
                "enter": True,
            },
        },
        "sessdata_enc": token,
    }


def run_defaults_and_validation() -> None:
    section("默认值 / 严格校验")
    with tempfile.TemporaryDirectory(prefix="dm-config-defaults-") as tmp:
        store = ConfigStore(tmp)
        snap = store.snapshot()
        v2 = canonical_config(snap)
        check(validate_config(v2) == [], "默认配置符合当前 schema")
        check(snap.get("schema_version") == SCHEMA_VERSION, "schema_version=%d" % SCHEMA_VERSION)
        check(
            set(v2) == {"schema_version", "appearance", "overlay", "monitor"},
            "当前顶层字段完整（快捷键已移除）",
        )
        types = snap["overlay"]["styles"]["types"]
        check(set(types) == set(OVERLAY_TYPES), "五类样式齐全")
        for kind in OVERLAY_TYPES:
            check(
                list(types[kind]) == list(STYLE_FIELDS) and all(value is None for value in types[kind].values()),
                "%s 的 12 个字段默认 null" % kind,
                "%d fields" % len(types[kind]),
            )
        gift = snap["overlay"]["pins"]["gift"]
        check(
            (gift["enabled"], gift["position"], gift["duration_ms"], gift["max"], gift["min_price"])
            == (True, "top", 8000, 3, 10),
            "pins.gift 默认值",
            repr((gift["enabled"], gift["position"], gift["duration_ms"], gift["max"], gift["min_price"])),
        )
        check(
            snap["monitor"]["font_px"] is None and snap["monitor"]["mode"] == "auto",
            "monitor 默认自动字号 / auto",
        )
        check("hotkeys" not in snap, "默认快照不包含快捷键段")

        bad = copy.deepcopy(v2)
        bad["monitor"]["font_px"] = 14
        check(bool(validate_config(bad)), "非法 font_px 被拒绝")
        bad = copy.deepcopy(v2)
        bad["overlay"]["styles"]["global"]["bg_opacity"] = 0
        check(bool(validate_config(bad)), "bg_opacity 低于 10 被拒绝")
        bad = copy.deepcopy(v2)
        bad["extra"] = True
        check(bool(validate_config(bad)), "未知顶层键被拒绝")
        bad = copy.deepcopy(v2)
        bad["overlay"]["styles"]["types"]["gift"]["unknown"] = 1
        check(bool(validate_config(bad)), "未知样式字段被拒绝")
        bad = copy.deepcopy(v2)
        bad["overlay"]["styles"]["global"]["font_size"] = None
        check(not validate_config(bad), "样式字段 null 合法")

        data, rejected = store.update(
            {
                "overlay": {
                    "styles": {"types": {"gift": {"font_size": 24, "color": "#112233"}}},
                    "pins": {"gift": {"max": 4}},
                    "geometry": {"width": 600},
                },
                "monitor": {
                    "font_px": 40,
                    "ui_size": "large",
                    "mode": "two_line",
                    "columns": ["time", "type", "user", "content", "status"],
                },
                "hotkeys": {"bindings": {"focus-mode": "G"}},
                "unknown_top": 1,
            }
        )
        check(data["overlay"]["styles"]["types"]["gift"]["font_size"] == 24, "type 覆盖已写入 snapshot")
        check(data["overlay"]["styles"]["types"]["gift"]["text_color"] == "#112233", "color 别名映射到 text_color")
        check(store.get("overlay", "styles", "types", "gift", "color") == "#112233", "get() 支持 color 别名")
        check(data["overlay"]["pins"]["gift"]["max"] == 4, "pins 更新未丢失")
        check(store.get("overlay", "pins", "super_chat", "max") == 2, "get() 支持 super_chat -> sc 别名")
        check(
            data["monitor"]["font_px"] == 40
            and data["monitor"]["ui_size"] == "large"
            and data["monitor"]["mode"] == "two_line",
            "monitor 更新未丢失",
        )
        data_x, rejected_x = store.update({"monitor": {"font_px": 50, "ui_size": "xlarge"}})
        check(
            not rejected_x
            and data_x["monitor"]["font_px"] == 50
            and data_x["monitor"]["ui_size"] == "xlarge",
            "monitor 超大档持久化",
        )
        check(any(item.startswith("hotkeys") for item in rejected) and "hotkeys" not in data,
              "hotkeys patch 被拒绝且不写入")
        check("unknown_top" in rejected, "未知键进入 rejected")
        check(store.get("overlay", "styles", "types", "gift", "font_size") == 24, "get() 能读取嵌套 v2 字段")

        before = canonical_config(store.snapshot())
        data2, rejected2 = store.update({"monitor": {"font_px": 14}})
        check("monitor.font_px" in rejected2, "非法 monitor patch 进入 rejected")
        check(canonical_config(data2) == before, "非法 patch 不改变状态")
        data_bool, rejected_bool = store.update({"overlay": {"enabled": "true"}})
        check("overlay.enabled" in rejected_bool, "v2 布尔字段拒绝字符串")
        check(canonical_config(data_bool) == before, "字符串布尔不改变 v2 状态")
        data3, rejected3 = store.update({"overlay": {"styles": {"types": {"gift": {"font_size": None}}}}})
        check(data3["overlay"]["styles"]["types"]["gift"]["font_size"] is None, "style null 可通过 patch")
        check(not rejected3, "合法 null 不产生 rejected")


def run_migration_and_idempotency() -> None:
    section("v1 -> 当前 schema 迁移 / 备份 / 幂等")
    plain = "SESSDATA_MIGRATION_TEST_%d" % os.getpid()
    token = secrets_win.protect(plain)
    with tempfile.TemporaryDirectory(prefix="dm-config-migrate-") as tmp:
        root = Path(tmp)
        v1 = v1_fixture(token)
        original = write_json(root / "config.json", v1)
        store = ConfigStore(tmp)
        snap = store.snapshot()
        v2 = read_json(root / "config.json")
        legacy = read_json(root / "config.legacy.json")
        backup = root / "config.v1.bak"

        check((root / "config.v1.bak").is_file(), "迁移前备份存在")
        check(backup.read_bytes() == original, "config.v1.bak 与原始字节一致")
        check(v2.get("schema_version") == SCHEMA_VERSION, "迁移后 schema_version=%d" % SCHEMA_VERSION)
        check(validate_config(v2) == [], "迁移后的 config.json 通过 schema 校验")
        check(
            set(v2) == {"schema_version", "appearance", "overlay", "monitor"},
            "迁移后顶层仅当前规范字段",
        )
        check("hotkeys" not in v2, "迁移丢弃已移除的 hotkeys 段")
        check("gift_pin" not in v2["overlay"], "旧 gift_pin* 不再出现在 v2 overlay")
        gift = v2["overlay"]["pins"]["gift"]
        check(
            (gift["enabled"], gift["position"], gift["duration_ms"], gift["max"], gift["min_price"])
            == (True, "bottom", 15000, 2, 0),
            "gift_pin* -> pins.gift",
            repr((gift["enabled"], gift["position"], gift["duration_ms"], gift["max"], gift["min_price"])),
        )
        global_style = v2["overlay"]["styles"]["global"]
        check(
            global_style["font_size"] == 22
            and global_style["font_weight"] == 600
            and global_style["text_color"] == "#FFFFFF"
            and global_style["bg_opacity"] == 22
            and global_style["opacity"] == 100,
            "旧全局样式保持不变",
            "font_size/bg_opacity/opacity=%s/%s/%s"
            % (global_style["font_size"], global_style["bg_opacity"], global_style["opacity"]),
        )
        check(
            all(all(value is None for value in v2["overlay"]["styles"]["types"][kind].values())
                for kind in OVERLAY_TYPES),
            "styles.types 默认全 null",
        )
        check(legacy.get("sessdata_enc") == token, "sessdata_enc 逐字符原样保留")
        check(store.get("sessdata") == plain, "迁移后内部 sessdata 可解密使用")
        check(snap.get("sessdata") == "", "snapshot 中 sessdata 脱敏为空")
        check(store.get("tts", "voice") == "zh-CN-XiaoyiNeural", "旧 TTS 字段进入 legacy 运行时视图")
        check(legacy.get("tts", {}).get("voice") == "zh-CN-XiaoyiNeural", "旧 TTS 字段写入 sidecar")
        check(store.overlay_v1().get("gift_pin") is True, "legacy 浮窗投影保留 gift_pin")

        print(
            "INFO  keys: v1 top-level=%d -> v2 top-level=%d + legacy sidecar=%d"
            % (len(v1), len(v2), len(legacy))
        )
        print(
            "INFO  gift_pin: enabled=%s position=%s duration=%s max=%s min_price=%s -> pins.gift"
            % (
                v1["overlay"]["gift_pin"],
                v1["overlay"]["gift_pin_position"],
                v1["overlay"]["gift_pin_duration_ms"],
                v1["overlay"]["gift_pin_max"],
                v1["overlay"]["gift_pin_min_price"],
            )
        )

        config_bytes = (root / "config.json").read_bytes()
        legacy_bytes = (root / "config.legacy.json").read_bytes()
        backup_bytes = backup.read_bytes()
        store2 = ConfigStore(tmp)
        snap2 = store2.snapshot()
        canonical2 = canonical_config(snap2)
        check(canonical2 == canonical_config(snap), "重复加载 snapshot 一致")
        check((root / "config.json").read_bytes() == config_bytes, "重复加载不重写 config.json")
        check((root / "config.legacy.json").read_bytes() == legacy_bytes, "重复加载不重写 legacy sidecar")
        check(backup.read_bytes() == backup_bytes, "重复加载不重写备份")
        check(store2.get("sessdata") == plain, "重复加载仍可登录")


def run_dpapi_roundtrip() -> None:
    section("DPAPI 往返 / 字段持久化")
    with tempfile.TemporaryDirectory(prefix="dm-config-secret-") as tmp:
        root = Path(tmp)
        store = ConfigStore(tmp)
        plain = "SESSDATA_DPAPI_ROUNDTRIP_%d" % os.getpid()
        data, rejected = store.update({"sessdata": plain})
        check(not rejected, "写入 sessdata 无 rejected")
        check(data.get("sessdata") == "", "update 返回快照时 sessdata 为空")
        token = store.get_sessdata_enc()
        check(bool(token) and (token.startswith("dpapi1:") or token.startswith("plain1:")), "sessdata 以密文/编码形式落盘")
        check(store.get("sessdata") == plain, "同实例内部可读取明文")
        legacy = read_json(root / "config.legacy.json")
        check(legacy.get("sessdata_enc") == token, "sidecar 保存完整 token")
        check(plain not in (root / "config.json").read_text(encoding="utf-8"), "config.json 不含明文 sessdata")
        check(plain not in (root / "config.legacy.json").read_text(encoding="utf-8"), "sidecar 不含明文 sessdata")

        second = ConfigStore(tmp)
        check(second.get("sessdata") == plain, "新实例 DPAPI 解密成功")
        check(second.snapshot().get("sessdata") == "", "新实例 snapshot 仍脱敏")
        check(second.get_sessdata_enc() == token, "未修改时 token 字节保持不变")
        status = second.credential_status()
        check(status.get("state") == ("ok" if token.startswith("dpapi1:") else "plaintext_fallback"),
              "凭证安全状态与存储格式一致", status)
        check(status.get("warning") is (not token.startswith("dpapi1:")),
              "仅非 DPAPI token 产生安全提示", status)


def run_credential_security_status() -> None:
    section("凭证安全提示 / 降级状态")
    plain = "SESSDATA_FALLBACK_TEST_%d" % os.getpid()
    with tempfile.TemporaryDirectory(prefix="dm-config-fallback-") as tmp:
        root = Path(tmp)

        def plain_protect(text: str) -> str:
            return "plain1:" + base64.b64encode(text.encode("utf-8")).decode("ascii")

        with patch.object(secrets_win, "protect", side_effect=plain_protect):
            store = ConfigStore(tmp)
            data, rejected = store.update({"sessdata": plain})
            cookie = "sessionid=fallback-cookie-value"
            saved_cookie = store.set_douyin_cookie(cookie)
            status = store.credential_status()
        check(not rejected and data.get("sessdata") == "", "降级写入仍不暴露明文", rejected)
        check(saved_cookie is True, "降级 cookie 写入成功")
        check(status.get("state") == "plaintext_fallback" and status.get("warning"),
              "plain1 token 触发安全提示", status)
        check("可逆编码" in str(status.get("message") or ""), "安全提示可读", status)
        check(plain not in (root / "config.json").read_text(encoding="utf-8"),
              "降级配置不含明文")
        check(plain not in (root / "config.legacy.json").read_text(encoding="utf-8"),
              "降级 sidecar 不含明文")
        check(cookie not in (root / "config.legacy.json").read_text(encoding="utf-8"),
              "降级 sidecar 不含明文 cookie")

        second = ConfigStore(tmp)
        check(second.credential_status().get("state") == "plaintext_fallback",
              "冷启动仍识别明文编码降级")

    with tempfile.TemporaryDirectory(prefix="dm-config-unprefixed-") as tmp:
        root = Path(tmp)
        naked = "SESSDATA_UNPREFIXED_%d" % os.getpid()
        write_json(root / "config.json", canonical_config(DEFAULT_CONFIG))
        write_json(root / "config.legacy.json", {"sessdata_enc": naked})
        store = ConfigStore(tmp)
        status = store.credential_status()
        check(status.get("state") == "plaintext_fallback" and status.get("warning"),
              "无前缀裸明文 token 触发安全提示", status)
        check(store.get("sessdata") == naked, "裸明文 token 仍可读取登录态")
        data, rejected = store.update({"sessdata": naked})
        token = store.get_sessdata_enc()
        check(not rejected and data.get("sessdata") == "", "裸明文 token 更新不暴露明文", rejected)
        check(secrets_win.is_encoded_token(token), "保存时把裸明文重新编码/加密", token[:7])
        sidecar = read_json(root / "config.legacy.json")
        check(sidecar.get("sessdata_enc") == token, "sidecar 写回受保护 token")
        check(naked not in (root / "config.legacy.json").read_text(encoding="utf-8"),
              "sidecar 不再包含裸明文")

    with tempfile.TemporaryDirectory(prefix="dm-config-decrypt-fail-") as tmp:
        root = Path(tmp)
        config = copy.deepcopy(canonical_config(DEFAULT_CONFIG))
        bad = "dpapi1:not-a-valid-blob"
        original_config = write_json(root / "config.json", config)
        original_legacy = write_json(
            root / "config.legacy.json",
            {"sessdata": "", "sessdata_enc": bad},
        )
        store = ConfigStore(tmp)
        status = store.credential_status()
        check(store.is_read_only and status.get("state") == "decrypt_failed",
              "解密失败进入只读安全模式", status)
        check(status.get("warning") and "不会清空原密文" in str(status.get("message")),
              "解密失败提示不覆盖密文", status)
        check((root / "config.json").read_bytes() == original_config,
              "解密失败不覆盖 config.json")
        check((root / "config.legacy.json").read_bytes() == original_legacy,
              "解密失败不覆盖 sidecar")


def run_sessdata_migration_and_failure() -> None:
    section("SESSDATA 明文迁移 / 解密失败 fail-closed")
    plain = "SESSDATA_PLAINTEXT_MIGRATION_%d" % os.getpid()
    with tempfile.TemporaryDirectory(prefix="dm-config-plain-secret-") as tmp:
        root = Path(tmp)
        v1 = v1_fixture("")
        v1.pop("sessdata_enc", None)
        v1["sessdata"] = plain
        original = write_json(root / "config.json", v1)
        store = ConfigStore(tmp)
        legacy = read_json(root / "config.legacy.json")
        token = str(legacy.get("sessdata_enc") or "")
        check(store.get("sessdata") == plain, "v1 明文 SESSDATA 迁移后可登录")
        check(token.startswith("dpapi1:") or token.startswith("plain1:"),
              "v1 明文迁移后写入加密/编码 token", token[:7])
        check(plain not in (root / "config.json").read_text(encoding="utf-8"),
              "迁移后 config.json 不含明文 SESSDATA")
        check(plain not in (root / "config.legacy.json").read_text(encoding="utf-8"),
              "迁移后 legacy sidecar 不含明文 SESSDATA")
        check((root / "config.v1.bak").read_bytes() == original,
              "明文迁移保留原始字节备份")

    with tempfile.TemporaryDirectory(prefix="dm-config-bad-secret-") as tmp:
        root = Path(tmp)
        bad_token = "dpapi1:not-a-valid-blob"
        v1 = v1_fixture(bad_token)
        write_json(root / "config.json", v1)
        store = ConfigStore(tmp)
        check(store.get("sessdata") == "", "DPAPI 解密失败时登录态 fail-closed")
        check(store.get_sessdata_enc() == bad_token,
              "解密失败不静默清空密文，便于恢复/换机处理")


def run_store_field_persistence() -> None:
    section("ConfigStore 不丢 v2 字段")
    with tempfile.TemporaryDirectory(prefix="dm-config-store-") as tmp:
        store = ConfigStore(tmp)
        data, rejected = store.update(
            {
                "overlay": {
                    "styles": {
                        "theme": "minimal",
                        "global": {"font_size": 26},
                        "types": {
                            "danmaku": {"name_color": "#ABCDEF"},
                            "gift": {"outline": False, "bg_opacity": 50},
                        },
                    },
                    "pins": {
                        "gift": {"enabled": False, "position": "bottom", "duration_ms": 9000, "max": 5, "min_price": 20},
                        "sc": {"max": 1},
                        "guard": {"position": "top"},
                    },
                },
                "monitor": {
                    "font_px": 19,
                    "mode": "single_line",
                    "columns": ["time", "type", "user", "content", "value"],
                    "geometry": {"x": 20, "y": 30, "width": 1600, "height": 900},
                },
            }
        )
        check(not rejected, "嵌套更新无 rejected", str(rejected) if rejected else "")
        check(data["overlay"]["styles"]["theme"] == "minimal", "styles.theme 持久化")
        check(data["overlay"]["styles"]["global"]["font_size"] == 26, "styles.global 持久化")
        check(data["overlay"]["styles"]["types"]["gift"]["outline"] is False, "styles.types 持久化")
        check(data["overlay"]["pins"]["guard"]["position"] == "top", "pins 部分更新不丢其他字段")
        check(data["monitor"]["geometry"]["width"] == 1600, "monitor.geometry 持久化")
        check("hotkeys" not in data, "嵌套更新不会重新生成 hotkeys")

        second = ConfigStore(tmp)
        reloaded = canonical_config(second.snapshot())
        check(reloaded == canonical_config(data), "重新打开后 snapshot 完全一致")
        check(second.migration_status().get("state") == "ok", "v2 加载状态 ok")


def run_two_file_transaction() -> None:
    section("配置双文件事务恢复")
    with tempfile.TemporaryDirectory(prefix="dm-config-txn-") as tmp:
        root = Path(tmp)
        store = ConfigStore(tmp)
        old_config = (root / "config.json").read_bytes()
        old_legacy = (root / "config.legacy.json").read_bytes()
        data, rejected = store.update(
            {"overlay": {"styles": {"global": {"font_size": 31}}}}
        )
        check(not rejected and data["overlay"]["styles"]["global"]["font_size"] == 31,
              "事务测试写入新值", rejected)
        new_config = (root / "config.json").read_bytes()
        new_legacy = (root / "config.legacy.json").read_bytes()
        check(not (root / "config.save.txn").exists(), "正常保存不留下事务标记")

        # Simulate a hard crash before either target file reached its final
        # replacement. The transaction marker is the recovery source.
        (root / "config.json").write_bytes(old_config)
        (root / "config.legacy.json").write_bytes(old_legacy)
        write_json(
            root / "config.save.txn",
            {
                "version": 1,
                "config": new_config.decode("utf-8"),
                "legacy": new_legacy.decode("utf-8"),
            },
        )
        recovered = ConfigStore(tmp)
        recovered_cfg = canonical_config(recovered.snapshot())
        check(recovered_cfg["overlay"]["styles"]["global"]["font_size"] == 31,
              "启动时从事务标记恢复新配置")
        check((root / "config.json").read_bytes() == new_config,
              "恢复后 config.json 字节一致")
        check((root / "config.legacy.json").read_bytes() == new_legacy,
              "恢复后 legacy sidecar 字节一致")
        check(not (root / "config.save.txn").exists(), "恢复后清理事务标记")


def run_migration_failure_restore() -> None:
    section("迁移失败恢复")
    with tempfile.TemporaryDirectory(prefix="dm-config-fail-") as tmp:
        root = Path(tmp)
        invalid = {"schema_version": 1, "overlay": "not-an-object", "room_id": 123}
        original = write_json(root / "config.json", invalid)
        store = ConfigStore(tmp)
        check((root / "config.v1.bak").read_bytes() == original, "失败时仍写原始备份")
        check((root / "config.json").read_bytes() == original, "失败时 config.json 保持旧字节")
        check(store.is_read_only, "失败时进入只读安全模式")
        check(store.migration_status().get("state") == "failed", "迁移状态为 failed")
        check(
            store.snapshot().get("schema_version") == SCHEMA_VERSION,
            "内存仍可提供安全默认视图",
        )


def main() -> int:
    print("verify_config_v2 · Python", sys.version.split()[0])
    run_defaults_and_validation()
    run_migration_and_idempotency()
    run_dpapi_roundtrip()
    run_credential_security_status()
    run_sessdata_migration_and_failure()
    run_store_field_persistence()
    run_two_file_transaction()
    run_migration_failure_restore()
    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
