#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证配置 v3：appearance 严格校验、原子保存、v1/v2 迁移与失败回滚。"""

from __future__ import annotations

import copy
import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

logging.disable(logging.CRITICAL)

from backend.config import (  # noqa: E402
    APPEARANCE_SCHEMA_VERSION,
    APPEARANCE_THEME_MODES,
    DEFAULT_APPEARANCE,
    DEFAULT_CONFIG,
    SCHEMA_VERSION,
    WRITE_FAILED,
    ConfigStore,
    canonical_config,
    validate_config,
)
from backend.core import DanmakuTTSService  # noqa: E402
from backend import core as core_mod  # noqa: E402

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


def v2_fixture() -> Dict[str, Any]:
    value = copy.deepcopy(canonical_config(DEFAULT_CONFIG))
    value.pop("appearance", None)
    value["schema_version"] = 2
    value["overlay"]["geometry"].update({"x": -1280, "y": 72, "width": 610, "height": 580})
    value["monitor"]["font_px"] = 19
    value["hotkeys"] = {"enabled": False, "bindings": {"focus-mode": "G"}}
    return value


def valid_appearance() -> Dict[str, Any]:
    value = copy.deepcopy(DEFAULT_APPEARANCE)
    value.update(
        {
            "preset": "cobalt",
            "custom": True,
            "accent": "#78C4A4",
            "font": "humanist",
        }
    )
    value["pattern"] = {"type": "dots", "spacing_px": 30, "dot_size_px": 3.0}
    value["radius"] = {"enabled": True, "value_px": 10}
    return value


def run_defaults_and_validation() -> None:
    section("v3 默认值 / appearance 严格校验")
    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-default-") as tmp:
        store = ConfigStore(tmp)
        snap = store.snapshot()
        current = canonical_config(snap)
        check(SCHEMA_VERSION == 3, "当前 schema_version 常量为 3")
        check(snap["schema_version"] == 3, "默认快照 schema_version=3")
        check(set(current) == {"schema_version", "appearance", "overlay", "monitor"}, "v3 顶层四个字段")
        check(validate_config(current) == [], "默认配置通过 v3 校验")
        check(snap["appearance"] == DEFAULT_APPEARANCE, "appearance 默认值完整")
        disk = read_json(Path(tmp) / "config.json")
        check(disk["schema_version"] == 3 and "appearance" in disk, "默认配置已按 v3 落盘")
        check(
            snap["appearance"]["pattern"]["spacing_px"] == 24
            and snap["appearance"]["pattern"]["dot_size_px"] == 1.5,
            "点阵间距 24px / 点径 1.5px",
        )
        check(snap["appearance"]["monitor_pattern"] is True, "监看点阵默认开启")
        for mode in APPEARANCE_THEME_MODES:
            valid = copy.deepcopy(current)
            valid["appearance"]["theme_mode"] = mode
            check(validate_config(valid) == [], "主题模式 %s 合法" % mode)
        size_probe = copy.deepcopy(current)
        size_probe["monitor"]["font_px"] = 50
        size_probe["monitor"]["ui_size"] = "xlarge"
        check(validate_config(size_probe) == [], "监看超大档 50/xlarge 合法")

        bad_cases = []
        bad = copy.deepcopy(current)
        bad["appearance"]["accent"] = "red"
        bad_cases.append(("非法 accent", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["pattern"]["spacing_px"] = 41
        bad_cases.append(("点阵间距越界", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["pattern"]["dot_size_px"] = 0.25
        bad_cases.append(("点阵大小越界", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["radius"]["value_px"] = 1
        bad_cases.append(("圆角越界", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["font"] = "Comic Sans"
        bad_cases.append(("字体白名单", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["theme_mode"] = "sepia"
        bad_cases.append(("主题模式白名单", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["extra"] = True
        bad_cases.append(("appearance 未知键", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["schema_version"] = APPEARANCE_SCHEMA_VERSION + 1
        bad_cases.append(("appearance 版本", bad))
        bad = copy.deepcopy(current)
        bad["schema_version"] = float(SCHEMA_VERSION)
        bad_cases.append(("顶层版本必须是整数", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["schema_version"] = True
        bad_cases.append(("appearance 版本拒绝布尔", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["pattern"]["dot_size_px"] = 1.3
        bad_cases.append(("点阵步进 0.25", bad))
        bad = copy.deepcopy(current)
        bad["appearance"]["monitor_pattern"] = "yes"
        bad_cases.append(("监看点阵开关必须为布尔", bad))
        bad = copy.deepcopy(current)
        bad["monitor"]["ui_size"] = "huge"
        bad_cases.append(("监看 ui_size 白名单", bad))

        for label, value in bad_cases:
            check(bool(validate_config(value)), label)


def run_appearance_atomic_persistence() -> None:
    section("appearance 原子保存 / 重新加载")
    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-app-") as tmp:
        root = Path(tmp)
        store = ConfigStore(tmp)
        before = store.snapshot()
        before_bytes = (root / "config.json").read_bytes()

        bad = valid_appearance()
        bad["accent"] = "#12345"
        unchanged, rejected = store.update_appearance(bad)
        check(bool(rejected), "非法 appearance 返回 rejected")
        check(unchanged["appearance"] == before["appearance"], "非法 appearance 不改变内存")
        check((root / "config.json").read_bytes() == before_bytes, "非法 appearance 不改写磁盘")

        saved, rejected = store.update_appearance(valid_appearance())
        check(not rejected, "完整合法 appearance 保存无 rejected", str(rejected))
        check(saved["appearance"] == valid_appearance(), "保存后快照为清洗后的完整值")
        check(saved["appearance"]["monitor_pattern"] is True, "监看点阵开关随 appearance 保存")
        disk = read_json(root / "config.json")
        check(disk["appearance"] == valid_appearance(), "appearance 已写入 config.json")

        second = ConfigStore(tmp)
        check(second.get_appearance() == valid_appearance(), "重新打开后 appearance 一致")
        check(second.migration_status().get("state") == "ok", "v3 重新加载状态 ok")

        light = valid_appearance()
        light["theme_mode"] = "light"
        saved_light, rejected = store.update_appearance(light)
        check(not rejected and saved_light["appearance"]["theme_mode"] == "light", "晨光模式持久化")
        check(ConfigStore(tmp).get_appearance()["theme_mode"] == "light", "晨光模式重新加载")

        unchanged, rejected = store.update({"appearance": {"radius": {"value_px": 14}}})
        check(bool(rejected), "通用 update 拒绝 appearance 局部 patch")
        check(unchanged["appearance"] == saved_light["appearance"], "通用 update 不改 appearance")

        quantized = valid_appearance()
        quantized["pattern"]["dot_size_px"] = 1.33
        saved_q, rejected = store.update_appearance(quantized)
        check(not rejected, "小数步进由专用接口量化")
        check(saved_q["appearance"]["pattern"]["dot_size_px"] == 1.25, "点径量化为 0.25px 步进")

    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-writefail-") as tmp:
        store = ConfigStore(tmp)
        before = store.snapshot()

        def fail_write(*_args, **_kwargs):
            raise OSError("disk full")

        store._atomic_write_text = fail_write
        data, rejected = store.update({"room_id": 987654})
        check(WRITE_FAILED in rejected, "通用写入失败进入 rejected")
        check(data["room_id"] == before["room_id"], "通用写入失败回滚内存")

        data, rejected = store.update_appearance(valid_appearance())
        check(bool(rejected), "appearance 写入失败返回 rejected")
        check(data["appearance"] == before["appearance"], "appearance 写入失败回滚内存")

    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-transaction-") as tmp:
        root = Path(tmp)
        store = ConfigStore(tmp)
        before = store.snapshot()
        config_bytes = (root / "config.json").read_bytes()
        legacy_bytes = (root / "config.legacy.json").read_bytes()
        original_write = store._atomic_write_text

        def fail_second(path, text):
            if os.path.basename(path) == "config.json":
                raise OSError("config replace failed")
            return original_write(path, text)

        store._atomic_write_text = fail_second
        data, rejected = store.update({"room_id": 424242})
        check(WRITE_FAILED in rejected, "第二步写盘失败被识别")
        check(data["room_id"] == before["room_id"], "第二步写盘失败回滚内存")
        check((root / "config.json").read_bytes() == config_bytes, "第二步写盘失败恢复 config.json")
        check((root / "config.legacy.json").read_bytes() == legacy_bytes, "第二步写盘失败恢复 sidecar")


def run_v2_migration() -> None:
    section("v2 -> v3 迁移 / 备份 / legacy sidecar")
    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-migrate-") as tmp:
        root = Path(tmp)
        v2 = v2_fixture()
        original = write_json(root / "config.json", v2)
        legacy_fixture = {
            "room_id": 22625568,
            "tts": {"voice": "zh-CN-XiaoyiNeural", "rate": "+11%", "pitch": "+12Hz", "volume": "+0%"},
            "read": {"danmaku": True},
            "sessdata": "",
            "sessdata_enc": "",
        }
        legacy_original = write_json(root / "config.legacy.json", legacy_fixture)

        store = ConfigStore(tmp)
        snap = store.snapshot()
        disk = read_json(root / "config.json")
        backup = root / "config.v2.bak"
        check(backup.is_file(), "生成 config.v2.bak")
        check(backup.read_bytes() == original, "v2 备份与原字节一致")
        check(disk["schema_version"] == 3, "迁移后 schema_version=3")
        check(disk["appearance"] == DEFAULT_APPEARANCE, "v2 用户获得默认广播校样")
        check(validate_config(disk) == [], "迁移结果通过 v3 校验")
        check(disk["overlay"]["geometry"]["width"] == 610, "overlay.geometry 原样保留")
        check(disk["monitor"]["font_px"] == 19, "monitor 原样保留")
        check("hotkeys" not in disk, "v2 旧 hotkeys 在迁移时丢弃")
        check(store.get("tts", "voice") == "zh-CN-XiaoyiNeural", "legacy 运行时字段保留")
        check(
            (root / "config.legacy.v2.bak").read_bytes() == legacy_original,
            "v2 迁移成对备份 legacy sidecar",
        )
        check(store.migration_status().get("from") == 2, "迁移状态记录 from=2")
        check(store.migration_status().get("state") == "ok", "迁移状态 ok")

        (root / "config.json").write_bytes((root / "config.v2.bak").read_bytes())
        (root / "config.legacy.json").write_bytes((root / "config.legacy.v2.bak").read_bytes())
        rolled_back = ConfigStore(tmp)
        check(rolled_back.migration_status().get("from") == 2,
              "回滚到 v2 后可再次升级", rolled_back.migration_status())
        check(rolled_back.snapshot()["overlay"]["geometry"]["width"] == 610,
              "回滚后再次升级保留 v2 数据")
        check(rolled_back.snapshot()["monitor"]["font_px"] == 19,
              "回滚后再次升级保留监看配置")

        config_bytes = (root / "config.json").read_bytes()
        ConfigStore(tmp)
        check((root / "config.json").read_bytes() == config_bytes, "二次加载不重写 v3 配置")


def run_v1_migration() -> None:
    section("v1 -> v3 迁移包含 appearance")
    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-v1-") as tmp:
        root = Path(tmp)
        v1 = {
            "room_id": 123,
            "sessdata": "",
            "tts": {"voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%", "pitch": "+0Hz", "volume": "+0%"},
            "read": {"danmaku": True},
            "filters": {},
            "queue": {"max_size": 30},
            "mock": {},
            "overlay": {
                "enabled": True,
                "x": 20,
                "y": 30,
                "width": 520,
                "height": 620,
                "font_size": 22,
                "theme": "classic",
            },
        }
        write_json(root / "config.json", v1)
        store = ConfigStore(tmp)
        disk = read_json(root / "config.json")
        check((root / "config.v1.bak").is_file(), "生成 config.v1.bak")
        check(disk["schema_version"] == 3, "v1 直接迁移到 v3")
        check(disk["appearance"] == DEFAULT_APPEARANCE, "v1 迁移带 appearance 默认值")
        check(validate_config(disk) == [], "v1 迁移结果通过 v3 校验")
        check(store.get("tts", "voice") == "zh-CN-XiaoxiaoNeural", "v1 TTS 进入 legacy sidecar")


def run_failure_rollback() -> None:
    section("迁移/加载失败回滚")
    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-fail-v2-") as tmp:
        root = Path(tmp)
        invalid = v2_fixture()
        invalid["overlay"] = "not-an-object"
        original = write_json(root / "config.json", invalid)
        write_json(root / "config.legacy.json", {"tts": {"voice": "zh-CN-XiaoyiNeural"}})
        store = ConfigStore(tmp)
        check((root / "config.json").read_bytes() == original, "v2 迁移失败保留原字节")
        check((root / "config.v2.bak").read_bytes() == original, "v2 迁移失败仍保留备份")
        check(store.is_read_only, "v2 迁移失败进入只读")
        check(store.migration_status().get("state") == "failed", "v2 迁移失败状态")
        check(store.snapshot()["schema_version"] == 3, "只读内存提供安全 v3 视图")
        check(store.get("tts", "voice") == "zh-CN-XiaoyiNeural", "失败后 legacy 字段仍可读")

    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-fail-future-") as tmp:
        root = Path(tmp)
        future = copy.deepcopy(DEFAULT_CONFIG)
        future["schema_version"] = 99
        original = write_json(root / "config.json", future)
        store = ConfigStore(tmp)
        check((root / "config.json").read_bytes() == original, "未知未来版本绝不降级写回")
        check((root / "config.unknown.bak").read_bytes() == original, "未知未来版本生成 unknown 备份")
        check(store.is_read_only, "未知未来版本进入只读")
        check(store.migration_status().get("state") == "failed", "未知未来版本状态 failed")

    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-fail-current-") as tmp:
        root = Path(tmp)
        invalid = copy.deepcopy(canonical_config(DEFAULT_CONFIG))
        invalid["appearance"]["accent"] = "#GGGGGG"
        original = write_json(root / "config.json", invalid)
        store = ConfigStore(tmp)
        check((root / "config.json").read_bytes() == original, "当前版本非法配置不被覆盖")
        check(store.is_read_only, "当前版本非法配置进入只读")
        check(store.snapshot()["appearance"] == DEFAULT_APPEARANCE, "只读时提供默认 appearance")

    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-sidecar-broken-") as tmp:
        root = Path(tmp)
        original_config = write_json(root / "config.json", copy.deepcopy(canonical_config(DEFAULT_CONFIG)))
        broken = b'{not valid json\n'
        (root / "config.legacy.json").write_bytes(broken)
        store = ConfigStore(tmp)
        check((root / "config.json").read_bytes() == original_config, "损坏 sidecar 时 config 不被重写")
        check((root / "config.legacy.json").read_bytes() == broken, "损坏 sidecar 原字节保留")
        check((root / "config.legacy.bak").read_bytes() == broken, "损坏 sidecar 生成备份")
        check(store.is_read_only, "损坏 sidecar 进入只读")
        check(store.migration_status().get("state") == "failed", "损坏 sidecar 状态 failed")

    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-version-type-") as tmp:
        root = Path(tmp)
        invalid = copy.deepcopy(canonical_config(DEFAULT_CONFIG))
        invalid["schema_version"] = True
        original = write_json(root / "config.json", invalid)
        store = ConfigStore(tmp)
        check((root / "config.json").read_bytes() == original, "布尔版本号不被当作 1 迁移")
        check(store.is_read_only, "布尔版本号进入只读")
        check(store.migration_status().get("state") == "failed", "布尔版本号状态 failed")


def run_service_config_apply_preserves_credentials() -> None:
    section("服务局部更新不擦除登录凭证")
    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-service-") as tmp:
        service = DanmakuTTSService(tmp)
        try:
            seeded = service.update_config({"sessdata": "credential-before"})
            check(seeded.get("ok") is True, "测试凭证已写入运行时配置", seeded.get("rejected"))
            updated = service.update_config({"filters": {"max_len": 60}})
            check(updated.get("ok") is True, "普通配置更新成功", updated.get("rejected"))
            check(
                service._danmaku.sessdata == "credential-before",
                "保存普通配置后 B 站凭证保持不变",
                service._danmaku.sessdata,
            )

            changed = service.update_config({"sessdata": "credential-after"})
            check(changed.get("ok") is True, "显式更新凭证成功", changed.get("rejected"))
            check(
                service._danmaku.sessdata == "credential-after",
                "显式更新凭证后运行时连接立即生效",
                service._danmaku.sessdata,
            )
            check(
                changed.get("config", {}).get("sessdata") == "",
                "返回前端的配置快照仍不暴露凭证",
            )
            check(
                "sessdata_enc" not in service.config.project_v1(),
                "主界面配置投影不包含凭证 token",
            )

            logged_out = service.logout()
            check(logged_out.get("ok") is True and logged_out.get("persisted") is True,
                  "正常退出登录并写入磁盘", logged_out)
            check(service._danmaku.sessdata == "", "退出后运行时连接凭证已清空")

            service.update_config({"sessdata": "credential-readonly"})
            service.config._read_only = True
            failed_logout = service.logout()
            check(
                failed_logout.get("ok") is True and
                failed_logout.get("persisted") is False,
                "只读模式下退出登录明确返回未持久化",
                failed_logout,
            )
        finally:
            service.shutdown()


def run_current_v3_cleanup() -> None:
    section("当前 v3 旧字段一次性清理")
    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-cleanup-") as tmp:
        root = Path(tmp)
        raw = copy.deepcopy(canonical_config(DEFAULT_CONFIG))
        raw["hotkeys"] = {"enabled": True, "bindings": {"focus-mode": "G"}}
        raw["sessdata"] = "cleanup-credential"
        write_json(root / "config.json", raw)

        store = ConfigStore(tmp)
        disk = read_json(root / "config.json")
        check("hotkeys" not in disk, "清理后 config.json 不含 hotkeys")
        check("sessdata" not in disk, "清理后 config.json 不含明文 sessdata")
        check("sessdata_enc" not in disk, "清理后 config.json 不含 token")

        backup = root / "config.cleanup.bak"
        check(backup.is_file(), "清理前生成 config.cleanup.bak")
        backup_text = backup.read_text(encoding="utf-8")
        check("cleanup-credential" not in backup_text, "清理备份不含明文凭证")

        sidecar = read_json(root / "config.legacy.json")
        token = str(sidecar.get("sessdata_enc") or "")
        check(
            token.startswith("dpapi1:") or token.startswith("plain1:"),
            "清理后凭证迁移到 sidecar 密文",
            token[:12],
        )
        check(store.get("sessdata") == "cleanup-credential", "清理后运行时仍可读取凭证")


def run_login_persisted_status() -> None:
    section("扫码登录持久化状态")
    with tempfile.TemporaryDirectory(prefix="mutai-config-v3-login-") as tmp:
        service = DanmakuTTSService(tmp)
        old_poll = core_mod.account_mod.qr_poll
        old_refresh = service._refresh_account

        async def fake_poll(_key):
            return {
                "status": "success",
                "sessdata": "login-credential",
                "uname": "测试用户",
                "mid": 42,
            }

        async def fake_refresh(_sessdata_override=None):
            return None

        core_mod.account_mod.qr_poll = fake_poll
        service._refresh_account = fake_refresh
        try:
            saved = service.login_poll("qr-key")
            check(saved.get("status") == "success", "扫码登录成功", saved)
            check(saved.get("persisted") is True, "登录成功返回持久化状态", saved)
            check("sessdata" not in saved, "登录响应不返回凭证")

            service.config._read_only = True
            unsaved = service.login_poll("qr-key")
            check(unsaved.get("status") == "success", "只读时扫码登录仍可用", unsaved)
            check(unsaved.get("persisted") is False, "只读登录返回未持久化", unsaved)
            check(bool(unsaved.get("warning")), "只读登录返回可见警告", unsaved)
        finally:
            core_mod.account_mod.qr_poll = old_poll
            service._refresh_account = old_refresh
            service.shutdown()


def main() -> int:
    print("verify_config_v3 · Python", sys.version.split()[0])
    run_defaults_and_validation()
    run_appearance_atomic_persistence()
    run_v2_migration()
    run_v1_migration()
    run_failure_rollback()
    run_service_config_apply_preserves_credentials()
    run_current_v3_cleanup()
    run_login_persisted_status()
    print("\nSUMMARY  PASS=%d  FAIL=%d" % (PASS, FAIL))
    if FAILURES:
        print("FAILED:", ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
