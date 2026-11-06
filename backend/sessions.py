# -*- coding: utf-8 -*-
"""本机直播场次存储。

只持久化聚合数据：场次元信息、真实/模拟计数、类型分布、分钟桶、去重用户数
和已知金额。不保存弹幕正文、用户名、UID 或登录凭证。
"""

from __future__ import annotations

import csv
import io
import json
import logging
import math
import os
import queue
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from .history_compare import (
    MAX_COMPARE_BASELINES,
    candidate_summary,
    compare_scope_error,
    comparison_scope,
    finite_epoch,
    intervals_overlap,
    normalize_id,
    relation,
    validate_session,
)
from .history_insights import (
    LOOKBACK_N,
    PEAK_WINDOW_MIN,
    WINDOW_DAYS,
    build_insights,
)
from .history_report import (
    REPORT_SCHEMA_VERSION,
    build_compare_report,
    build_insights_report,
    build_multi_compare_report,
    build_trend_report,
    render_csv,
    render_json,
)
from .history_trend import (
    TREND_GRANULARITIES,
    TREND_MAX_DAYS,
    TREND_MAX_HOURS,
    TREND_MAX_SECONDS_FAST,
    build_trend,
    day_bucket_count,
    hour_bucket_count,
)
from .platforms import (
    money_comparable as platform_money_comparable,
    money_note as platform_money_note,
    normalize_platform,
    normalize_room_key,
)
from .export_store import ExportManager

logger = logging.getLogger("danmaku_tts.sessions")

_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter", "like", "social", "fansclub")
_COUNTERS = ("received", "spoken", "dropped", "filtered")
_SCOPES = ("real", "mock")
_SCHEMA_VERSION = 4
_SETTING_DEFAULTS = {
    "auto_prune_enabled": False,
    "auto_prune_days": 90,
}


class SessionStore:
    """SQLite 聚合场次存储；写操作进入独立线程，读操作使用独立连接。"""

    def __init__(self, path: str, *, start_worker: bool = True):
        self.path = os.path.abspath(path)
        self.available = False
        self.error = ""
        self._queue: "queue.Queue[Optional[Tuple[str, Tuple[Any, ...]]]]" = queue.Queue(maxsize=50000)
        self._thread: Optional[threading.Thread] = None
        self._auto_prune_thread: Optional[threading.Thread] = None
        self._migration_backup_path = ""
        self._users: Dict[str, set[str]] = {}
        self._dropped_ops = 0
        self._failed_ops = 0
        self._last_write_error = ""
        self._export_manager = ExportManager(self.export_dir)
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            if os.path.isfile(self.path):
                with closing(sqlite3.connect(self.path)) as meta_conn:
                    existing_version = int(meta_conn.execute("PRAGMA user_version").fetchone()[0] or 0)
                    existing_sessions = meta_conn.execute(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"
                    ).fetchone()
                if existing_sessions and existing_version < _SCHEMA_VERSION:
                    self._migration_backup_path = self._backup_database(
                        "history-before-migration-v%d" % existing_version
                    )
            self._init_schema()
            self._mark_stale_sessions()
            self.available = True
            if start_worker:
                self._thread = threading.Thread(
                    target=self._writer_loop,
                    name="mutai-session-store",
                    daemon=True,
                )
                self._thread.start()
                self._start_auto_prune()
                threading.Thread(
                    target=self._cleanup_export_temps_safe,
                    name="mutai-export-temp-cleanup",
                    daemon=True,
                ).start()
        except Exception as exc:  # noqa: BLE001
            self.available = False
            self.error = "%s: %s" % (type(exc).__name__, exc)
            logger.exception("场次存储初始化失败：%s", self.path)

    def _cleanup_export_temps_safe(self) -> None:
        try:
            self._export_manager.cleanup_stale_temps()
        except Exception:  # noqa: BLE001
            logger.debug("清理导出临时文件失败", exc_info=True)

    # ------------------------------------------------------------ 基础连接
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA secure_delete=ON")
        conn.execute("PRAGMA wal_autocheckpoint=1000")
        return conn

    def _init_schema(self) -> None:
        with closing(self._connect()) as conn:
            with conn:
                version = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
                if version > _SCHEMA_VERSION:
                    raise RuntimeError(
                        "历史库版本 %d 高于当前程序支持的版本 %d" % (version, _SCHEMA_VERSION)
                    )
                existing_columns = {
                    str(row[1]) for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
                }
                if version == _SCHEMA_VERSION and existing_columns and "room_key" not in existing_columns:
                    raise RuntimeError("历史库版本为 4，但缺少 room_key 列")
                if version == _SCHEMA_VERSION and existing_columns and (
                    "real_filtered" not in existing_columns
                    or "mock_filtered" not in existing_columns
                ):
                    raise RuntimeError("历史库版本为 4，但缺少 filtered 列")
                if existing_columns and version < _SCHEMA_VERSION:
                    self._migrate_schema(conn)
                    version = _SCHEMA_VERSION
                    existing_columns.add("room_key")
                    existing_columns.update(("real_filtered", "mock_filtered"))
                if existing_columns and "room_key" not in existing_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN room_key TEXT NOT NULL DEFAULT ''")
                if existing_columns and "real_filtered" not in existing_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN real_filtered INTEGER")
                if existing_columns and "mock_filtered" not in existing_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN mock_filtered INTEGER")
                conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    platform TEXT NOT NULL DEFAULT 'bilibili',
                    room_id INTEGER NOT NULL DEFAULT 0,
                    room_key TEXT NOT NULL DEFAULT '',
                    room_title TEXT NOT NULL DEFAULT '',
                    started_at REAL NOT NULL,
                    ended_at REAL,
                    end_reason TEXT,
                    last_event_at REAL,
                    updated_at REAL NOT NULL,
                    real_received INTEGER NOT NULL DEFAULT 0,
                    real_spoken INTEGER NOT NULL DEFAULT 0,
                    real_dropped INTEGER NOT NULL DEFAULT 0,
                    real_filtered INTEGER,
                    mock_received INTEGER NOT NULL DEFAULT 0,
                    mock_spoken INTEGER NOT NULL DEFAULT 0,
                    mock_dropped INTEGER NOT NULL DEFAULT 0,
                    mock_filtered INTEGER,
                    unique_users INTEGER NOT NULL DEFAULT 0,
                    gift_cny REAL NOT NULL DEFAULT 0,
                    gift_silver INTEGER NOT NULL DEFAULT 0,
                    gift_unknown INTEGER NOT NULL DEFAULT 0,
                    super_chat_cny REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS session_types (
                    session_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, type),
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS session_minutes (
                    session_id TEXT NOT NULL,
                    minute INTEGER NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, minute),
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_started
                    ON sessions(started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_sessions_ended
                    ON sessions(ended_at, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_sessions_history_page
                    ON sessions(started_at DESC, id DESC)
                    WHERE ended_at IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_sessions_history_room_page
                    ON sessions(platform, room_id, started_at DESC, id DESC)
                    WHERE ended_at IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_sessions_history_room_key_page
                    ON sessions(platform, room_key, started_at DESC, id DESC)
                    WHERE ended_at IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_sessions_history_platform_page
                    ON sessions(platform, started_at DESC, id DESC)
                    WHERE ended_at IS NOT NULL;
                CREATE TABLE IF NOT EXISTS history_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                """
                )
                conn.execute(
                    """
                    UPDATE sessions
                       SET room_key = CAST(room_id AS TEXT)
                     WHERE (room_key IS NULL OR room_key = '')
                       AND platform = 'bilibili'
                       AND room_id > 0
                    """
                )
                if version < _SCHEMA_VERSION:
                    conn.execute("PRAGMA user_version=%d" % _SCHEMA_VERSION)

    def _migrate_schema(self, conn: sqlite3.Connection) -> None:
        """在单事务内完成旧库到 v4 的结构迁移。调用方负责先做备份。"""
        conn.execute("BEGIN IMMEDIATE")
        try:
            columns = {
                str(row[1]) for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
            }
            if "room_key" not in columns:
                conn.execute("ALTER TABLE sessions ADD COLUMN room_key TEXT NOT NULL DEFAULT ''")
            if "real_filtered" not in columns:
                conn.execute("ALTER TABLE sessions ADD COLUMN real_filtered INTEGER")
            if "mock_filtered" not in columns:
                conn.execute("ALTER TABLE sessions ADD COLUMN mock_filtered INTEGER")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS session_types (
                    session_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, type),
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS session_minutes (
                    session_id TEXT NOT NULL,
                    minute INTEGER NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, minute),
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS history_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at, started_at DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_history_page "
                "ON sessions(started_at DESC, id DESC) WHERE ended_at IS NOT NULL"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_history_room_page "
                "ON sessions(platform, room_id, started_at DESC, id DESC) WHERE ended_at IS NOT NULL"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_history_room_key_page "
                "ON sessions(platform, room_key, started_at DESC, id DESC) WHERE ended_at IS NOT NULL"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_history_platform_page "
                "ON sessions(platform, started_at DESC, id DESC) WHERE ended_at IS NOT NULL"
            )
            conn.execute(
                """
                UPDATE sessions
                   SET room_key = CAST(room_id AS TEXT)
                 WHERE (room_key IS NULL OR room_key = '')
                   AND platform = 'bilibili'
                   AND room_id > 0
                """
            )
            conn.execute("PRAGMA user_version=%d" % _SCHEMA_VERSION)
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def _mark_stale_sessions(self) -> None:
        now = time.time()
        with closing(self._connect()) as conn:
            with conn:
                conn.execute(
                """
                UPDATE sessions
                   SET ended_at = COALESCE(last_event_at, updated_at, ?),
                       end_reason = 'stale',
                       updated_at = ?
                 WHERE ended_at IS NULL
                """,
                (now, now),
                )
                conn.execute(
                    """
                    DELETE FROM sessions
                     WHERE ended_at IS NOT NULL
                       AND real_received = 0
                       AND mock_received > 0
                    """
                )

    def get_settings(self) -> Dict[str, Any]:
        if not self.available:
            return {"ok": False, "available": False, "error": self.error or "场次存储不可用"}
        try:
            with closing(self._connect()) as conn:
                rows = conn.execute("SELECT key, value FROM history_settings").fetchall()
            values = {str(row["key"]): str(row["value"]) for row in rows}
            settings = dict(_SETTING_DEFAULTS)
            settings["auto_prune_enabled"] = values.get("auto_prune_enabled", "").lower() in ("1", "true", "yes")
            try:
                days = int(values.get("auto_prune_days", settings["auto_prune_days"]))
            except (TypeError, ValueError):
                days = int(settings["auto_prune_days"])
            settings["auto_prune_days"] = days if days in (30, 90, 180, 365) else 90
            return {"ok": True, "available": True, "settings": settings}
        except Exception as exc:  # noqa: BLE001
            logger.exception("读取历史设置失败")
            return {"ok": False, "available": True, "error": str(exc), "settings": dict(_SETTING_DEFAULTS)}

    def update_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        if not self.available:
            return {"ok": False, "available": False, "error": self.error or "场次存储不可用"}
        if not isinstance(patch, dict):
            return {"ok": False, "error": "settings 必须是对象"}
        updates: Dict[str, str] = {}
        rejected: List[str] = []
        if "auto_prune_enabled" in patch:
            value = patch["auto_prune_enabled"]
            if isinstance(value, bool):
                updates["auto_prune_enabled"] = "1" if value else "0"
            else:
                rejected.append("auto_prune_enabled")
        if "auto_prune_days" in patch:
            try:
                days = int(patch["auto_prune_days"])
            except (TypeError, ValueError):
                days = 0
            if days in (30, 90, 180, 365):
                updates["auto_prune_days"] = str(days)
            else:
                rejected.append("auto_prune_days")
        for key in patch:
            if key not in ("auto_prune_enabled", "auto_prune_days"):
                rejected.append(str(key))
        if rejected:
            return {
                "ok": False,
                "error": "历史设置未保存",
                "rejected": rejected,
                "settings": self.get_settings().get("settings") or dict(_SETTING_DEFAULTS),
            }
        try:
            now = time.time()
            with closing(self._connect()) as conn:
                with conn:
                    for key, value in updates.items():
                        conn.execute(
                            """
                            INSERT INTO history_settings(key, value, updated_at)
                            VALUES (?, ?, ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                            """,
                            (key, value, now),
                        )
            return self.get_settings()
        except Exception as exc:  # noqa: BLE001
            logger.exception("保存历史设置失败")
            return {
                "ok": False,
                "error": str(exc),
                "settings": self.get_settings().get("settings") or dict(_SETTING_DEFAULTS),
            }

    def _start_auto_prune(self) -> None:
        try:
            settings_result = self.get_settings()
            settings = settings_result.get("settings") or {}
            if not settings.get("auto_prune_enabled"):
                return
            days = int(settings.get("auto_prune_days") or 90)
            self._auto_prune_thread = threading.Thread(
                target=self._run_auto_prune,
                args=(days,),
                name="mutai-history-auto-prune",
                daemon=True,
            )
            self._auto_prune_thread.start()
        except Exception:  # noqa: BLE001
            logger.exception("启动自动清理失败；不影响历史读写")

    def _run_auto_prune(self, days: int) -> None:
        try:
            cutoff = time.time() - max(1, int(days)) * 86400
            result = self.prune_sessions(cutoff, keep_latest=1, dry_run=False)
            if result.get("ok") and int(result.get("deleted") or 0) > 0:
                logger.info(
                    "历史自动清理完成：deleted=%s backup=%s",
                    result.get("deleted"),
                    result.get("backup_path"),
                )
            elif not result.get("ok"):
                logger.warning("历史自动清理失败：%s", result.get("error"))
        except Exception:  # noqa: BLE001
            logger.exception("历史自动清理异常")

    # ------------------------------------------------------------ 写入队列
    def _enqueue(self, op: str, args: Tuple[Any, ...]) -> bool:
        if not self.available:
            return False
        try:
            self._queue.put_nowait((op, args))
            return True
        except queue.Full:
            self._dropped_ops += 1
            if self._dropped_ops == 1 or self._dropped_ops % 100 == 0:
                logger.warning("场次写入队列已满，已丢弃 %d 个操作", self._dropped_ops)
            return False

    @property
    def dropped_ops(self) -> int:
        return int(self._dropped_ops + self._failed_ops)

    @property
    def failed_ops(self) -> int:
        return int(self._failed_ops)

    @property
    def last_write_error(self) -> str:
        return self._last_write_error

    def _writer_loop(self) -> None:
        conn: Optional[sqlite3.Connection] = None
        try:
            conn = self._connect()
            while True:
                try:
                    item = self._queue.get()
                except Exception:  # noqa: BLE001
                    continue
                if item is None:
                    break
                batch = [item]
                while len(batch) < 100:
                    try:
                        extra = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if extra is None:
                        self._apply_batch(conn, batch)
                        return
                    batch.append(extra)
                self._apply_batch(conn, batch)
        except Exception:  # noqa: BLE001
            logger.exception("场次存储写线程异常退出")
            self.available = False
            self.error = "写线程异常退出"
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass

    def _apply_batch(
        self,
        conn: sqlite3.Connection,
        batch: List[Tuple[str, Tuple[Any, ...]]],
    ) -> None:
        flush_events = []
        failed = 0
        users_before_batch = {session_id: set(users) for session_id, users in self._users.items()}
        try:
            for op, args in batch:
                if op == "flush":
                    flush_events.append(args[0])
                    continue
                session_id = args[0] if args else None
                had_users = session_id in self._users
                users_before_op = set(self._users.get(session_id, set()))
                conn.execute("SAVEPOINT mutai_op")
                try:
                    self._apply_op(conn, op, args)
                    conn.execute("RELEASE SAVEPOINT mutai_op")
                except Exception as exc:  # noqa: BLE001
                    failed += 1
                    self._last_write_error = "%s: %s" % (type(exc).__name__, exc)
                    conn.execute("ROLLBACK TO SAVEPOINT mutai_op")
                    conn.execute("RELEASE SAVEPOINT mutai_op")
                    if had_users:
                        self._users[session_id] = users_before_op
                    else:
                        self._users.pop(session_id, None)
                    logger.exception("场次写入操作失败：%s", op)
            conn.commit()
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            self._users = users_before_batch
            failed = max(failed, sum(1 for op, _args in batch if op != "flush"))
            self._last_write_error = "%s: %s" % (type(exc).__name__, exc)
            logger.exception("场次存储批量写入失败，本批 %d 个操作已回滚", len(batch))
        finally:
            if failed:
                self._failed_ops += failed
            for event in flush_events:
                try:
                    event.mutai_ok = failed == 0
                    event.set()
                except Exception:  # noqa: BLE001
                    logger.debug("设置场次写盘完成事件失败", exc_info=True)

    def _apply_op(self, conn: sqlite3.Connection, op: str, args: Tuple[Any, ...]) -> None:
        if op == "start":
            session_id, platform, room_id, room_key, room_title, started_at = args
            conn.execute(
                """
                INSERT OR IGNORE INTO sessions
                    (id, platform, room_id, room_key, room_title, started_at, updated_at,
                     real_filtered, mock_filtered)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
                """,
                (
                    session_id,
                    platform,
                    int(room_id),
                    str(room_key or ""),
                    room_title or "",
                    float(started_at),
                    time.time(),
                ),
            )
            self._users.setdefault(session_id, set())
        elif op == "meta":
            session_id, room_id, room_title, room_key = args
            conn.execute(
                """
                UPDATE sessions
                   SET room_id = ?, room_title = ?,
                       room_key = CASE WHEN ? <> '' THEN ? ELSE room_key END,
                       updated_at = ?
                 WHERE id = ? AND ended_at IS NULL
                """,
                (
                    int(room_id),
                    room_title or "",
                    str(room_key or ""),
                    str(room_key or ""),
                    time.time(),
                    session_id,
                ),
            )
        elif op == "bump":
            session_id, scope, key, count = args
            if scope not in _SCOPES or key not in _COUNTERS:
                return
            column = "%s_%s" % (scope, key)
            conn.execute(
                "UPDATE sessions SET %s = COALESCE(%s, 0) + ?, updated_at = ? "
                "WHERE id = ? AND ended_at IS NULL"
                % (column, column),
                (int(count), time.time(), session_id),
            )
        elif op == "message":
            self._apply_message(conn, args)
        elif op == "finish":
            session_id, ended_at, reason = args
            row = conn.execute(
                "SELECT ended_at, real_received, mock_received FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                return
            if row["ended_at"] is None:
                conn.execute(
                    """
                    UPDATE sessions
                       SET ended_at = ?, end_reason = ?, updated_at = ?
                     WHERE id = ? AND ended_at IS NULL
                    """,
                    (float(ended_at), str(reason or "finished"), time.time(), session_id),
                )
            if int(row["real_received"] or 0) == 0 and int(row["mock_received"] or 0) > 0:
                conn.execute("DELETE FROM session_types WHERE session_id = ?", (session_id,))
                conn.execute("DELETE FROM session_minutes WHERE session_id = ?", (session_id,))
                conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            self._users.pop(session_id, None)
    def _apply_message(self, conn: sqlite3.Connection, args: Tuple[Any, ...]) -> None:
        session_id, kind, ts, uid, meta = args[:5]
        uid = str(uid).strip() if uid not in (None, "", 0, "0") else ""
        scope = str(args[5]) if len(args) > 5 else "real"
        if scope not in _SCOPES:
            return
        row = conn.execute(
            "SELECT ended_at, platform FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if row is None or row["ended_at"] is not None:
            return
        platform = normalize_platform(row["platform"])
        now = time.time()
        minute = int(float(ts) // 60)
        column = "%s_received" % scope
        result = conn.execute(
            "UPDATE sessions SET %s = %s + 1, "
            "last_event_at = MAX(COALESCE(last_event_at, 0), ?), updated_at = ? "
            "WHERE id = ? AND ended_at IS NULL" % (column, column),
            (float(ts), now, session_id),
        )
        if result.rowcount != 1:
            return
        if kind not in _TYPES:
            return
        conn.execute(
            """
            INSERT INTO session_types(session_id, type, count)
            VALUES (?, ?, 1)
            ON CONFLICT(session_id, type) DO UPDATE SET count = count + 1
            """,
            (session_id, kind),
        )
        conn.execute(
            """
            INSERT INTO session_minutes(session_id, minute, count)
            VALUES (?, ?, 1)
            ON CONFLICT(session_id, minute) DO UPDATE SET count = count + 1
            """,
            (session_id, minute),
        )
        if uid:
            users = self._users.setdefault(session_id, set())
            if uid not in users:
                users.add(uid)
                conn.execute(
                    "UPDATE sessions SET unique_users = ?, updated_at = ? WHERE id = ?",
                    (len(users), now, session_id),
                )
        if kind == "gift":
            value = (
                self._gift_values(meta)
                if platform_money_comparable(platform)
                else {"cny": 0, "silver": 0, "unknown": 0}
            )
            conn.execute(
                """
                UPDATE sessions
                   SET gift_cny = gift_cny + ?,
                       gift_silver = gift_silver + ?,
                       gift_unknown = gift_unknown + ?,
                       updated_at = ?
                 WHERE id = ?
                """,
                (value["cny"], value["silver"], value["unknown"], now, session_id),
            )
        elif kind == "super_chat":
            try:
                sc = float(meta.get("price") or 0)
            except (TypeError, ValueError):
                sc = 0.0
            if sc > 0 and platform_money_comparable(platform):
                conn.execute(
                    "UPDATE sessions SET super_chat_cny = super_chat_cny + ?, updated_at = ? WHERE id = ?",
                    (sc, now, session_id),
                )

    @staticmethod
    def _gift_values(meta: Dict[str, Any]) -> Dict[str, float]:
        try:
            total_coin = float(meta.get("total_coin") or 0)
        except (TypeError, ValueError):
            total_coin = 0.0
        if total_coin <= 0:
            try:
                total_coin = float(meta.get("price") or 0) * max(1, int(meta.get("num") or 1))
            except (TypeError, ValueError):
                total_coin = 0.0
        coin_type = str(meta.get("coin_type") or "").lower()
        if coin_type == "gold":
            return {"cny": total_coin / 1000.0, "silver": 0, "unknown": 0}
        if coin_type == "silver":
            return {"cny": 0, "silver": int(total_coin), "unknown": 0}
        return {"cny": 0, "silver": 0, "unknown": int(total_coin)}

    # ------------------------------------------------------------ 公开写接口
    def start_session(
        self,
        session_id: str,
        room_id: int,
        room_title: str = "",
        *,
        started_at: Optional[float] = None,
        platform: str = "bilibili",
        room_key: str = "",
    ) -> bool:
        try:
            room_id_value = int(room_id or 0)
        except (TypeError, ValueError, OverflowError):
            return False
        normalized_platform = normalize_platform(platform)
        normalized_room_key = normalize_room_key(
            room_key,
            room_id_value,
            normalized_platform,
        )
        try:
            started_value = float(started_at if started_at is not None else time.time())
        except (TypeError, ValueError):
            return False
        if not math.isfinite(started_value) or started_value <= 0:
            return False
        if len(normalized_room_key) > 256:
            return False
        return self._enqueue(
            "start",
            (
                session_id,
                normalized_platform,
                room_id_value,
                normalized_room_key,
                room_title or "",
                started_value,
            ),
        )

    def update_session_meta(
        self,
        session_id: str,
        room_id: int,
        room_title: str,
        room_key: Optional[str] = None,
    ) -> bool:
        try:
            room_id_value = int(room_id or 0)
        except (TypeError, ValueError, OverflowError):
            return False
        normalized_key = (
            str(room_key).strip()
            if room_key is not None
            else (str(room_id_value) if room_id_value > 0 else "")
        )
        if len(normalized_key) > 256:
            return False
        return self._enqueue(
            "meta",
            (session_id, room_id_value, room_title or "", normalized_key),
        )

    def bump_session(self, session_id: str, scope: str, key: str, count: int = 1) -> bool:
        return self._enqueue("bump", (session_id, scope, key, int(count)))

    def record_message(
        self,
        session_id: str,
        kind: str,
        ts: float,
        uid: Any,
        meta: Dict[str, Any],
        scope: str = "real",
    ) -> bool:
        try:
            ts_value = float(ts)
        except (TypeError, ValueError):
            return False
        if not math.isfinite(ts_value) or ts_value <= 0:
            return False
        uid_text = str(uid).strip() if uid not in (None, "", 0, "0") else ""
        return self._enqueue(
            "message",
            (session_id, kind, ts_value, uid_text, dict(meta or {}), str(scope)),
        )

    def finish_session(
        self,
        session_id: str,
        *,
        ended_at: Optional[float] = None,
        reason: str = "finished",
    ) -> bool:
        try:
            ended_value = float(ended_at if ended_at is not None else time.time())
        except (TypeError, ValueError):
            return False
        if not math.isfinite(ended_value) or ended_value <= 0:
            return False
        return self._enqueue("finish", (session_id, ended_value, reason))

    def flush(self, timeout: float = 3.0) -> bool:
        if not self.available:
            return False
        event = threading.Event()
        event.mutai_ok = False
        if not self._enqueue("flush", (event,)):
            return False
        return event.wait(timeout) and bool(getattr(event, "mutai_ok", False))

    def close(self, timeout: float = 5.0) -> None:
        if not self.available:
            return
        try:
            self._queue.put(None, timeout=1.0)
        except queue.Full:
            logger.warning("场次存储停止时写入队列仍满")
        if self._auto_prune_thread is not None and self._auto_prune_thread.is_alive():
            self._auto_prune_thread.join(min(2.0, timeout))
        if self._thread is not None:
            self._thread.join(timeout)
        self.available = False

    # ------------------------------------------------------------ 读取接口
    @staticmethod
    def _session_dict(row: sqlite3.Row) -> Dict[str, Any]:
        data = {key: row[key] for key in row.keys()}
        for scope in _SCOPES:
            dropped_key = scope + "_dropped"
            filtered_key = scope + "_filtered"
            total = int(data.get(dropped_key) or 0)
            raw_filtered = data.get(filtered_key)
            known = raw_filtered is not None
            filtered = int(raw_filtered or 0)
            data[dropped_key + "_total"] = total
            data[filtered_key] = filtered
            data[dropped_key + "_known"] = known
            # 新场次从写入口开始记录 filtered；旧场次过滤列为 NULL，
            # 无法还原，保留旧的 dropped 总数并明确标记为未知口径。
            data[dropped_key] = max(0, total - filtered) if known else total
        return data

    @staticmethod
    def _like_pattern(value: Any) -> Optional[str]:
        query = str(value or "").strip()
        if not query:
            return None
        query = query[:120]
        query = query.replace("!", "!!").replace("%", "!%").replace("_", "!_")
        return "%" + query + "%"

    @staticmethod
    def _optional_epoch(value: Any) -> Optional[float]:
        if value is None or value == "":
            return None
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("时间范围必须是有限数值")
        return number

    def _history_where(
        self,
        query: Any = "",
        started_from: Any = None,
        started_to: Any = None,
        platform: Any = None,
        *,
        require_range: bool = False,
        room_key: Any = None,
        include_ended: bool = True,
    ) -> Dict[str, Any]:
        started_from_ts = self._optional_epoch(started_from)
        started_to_ts = self._optional_epoch(started_to)
        if require_range and (started_from_ts is None or started_to_ts is None):
            raise ValueError("趋势必须提供完整日期范围")
        if started_from_ts is not None and started_to_ts is not None and started_from_ts >= started_to_ts:
            raise ValueError("开始时间必须早于结束时间")
        where = ["ended_at IS NOT NULL"] if include_ended else []
        params: List[Any] = []
        pattern = self._like_pattern(query)
        if pattern:
            where.append(
                "(room_title LIKE ? ESCAPE '!' OR CAST(room_id AS TEXT) LIKE ? ESCAPE '!' "
                "OR room_key LIKE ? ESCAPE '!')"
            )
            params.extend((pattern, pattern, pattern))
        if started_from_ts is not None:
            where.append("started_at >= ?")
            params.append(started_from_ts)
        if started_to_ts is not None:
            where.append("started_at < ?")
            params.append(started_to_ts)
        platform_text = normalize_platform(platform)
        if platform_text:
            where.append("platform = ?")
            params.append(platform_text)
        room_key_text = str(room_key or "").strip()
        if len(room_key_text) > 256:
            raise ValueError("房间标识过长")
        if room_key_text:
            where.append("room_key = ?")
            params.append(room_key_text)
        if not where:
            where.append("1 = 1")
        return {
            "where": where,
            "params": params,
            "started_from": started_from_ts,
            "started_to": started_to_ts,
            "platform": platform_text or None,
            "room_key": room_key_text or None,
        }

    def list_sessions(
        self,
        limit: int = 30,
        offset: int = 0,
        *,
        query: Any = "",
        started_from: Any = None,
        started_to: Any = None,
        platform: Any = None,
        before_started_at: Any = None,
        before_id: Any = None,
    ) -> Dict[str, Any]:
        if not self.available:
            return {"ok": False, "error": self.error or "场次存储不可用", "sessions": [], "total": 0}
        try:
            limit = max(1, min(int(limit), 100))
            offset = max(0, int(offset))
            filter_data = self._history_where(query, started_from, started_to, platform)
            where = filter_data["where"]
            params = filter_data["params"]
            flushed = self.flush(2.0)
            cursor_started = self._optional_epoch(before_started_at)
            cursor_id = str(before_id or "").strip() or None
            base_where = " AND ".join(where)
            page_where = list(where)
            page_params = list(params)
            if cursor_started is not None and cursor_id:
                page_where.append("(started_at < ? OR (started_at = ? AND id < ?))")
                page_params.extend((cursor_started, cursor_started, cursor_id))
            page_sql = (
                "SELECT * FROM sessions WHERE " + " AND ".join(page_where) +
                " ORDER BY started_at DESC, id DESC LIMIT ?"
            )
            page_params.append(limit + 1)
            if cursor_started is None or not cursor_id:
                page_sql += " OFFSET ?"
                page_params.append(offset)
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                total = int(conn.execute(
                    "SELECT COUNT(*) FROM sessions WHERE " + base_where,
                    params,
                ).fetchone()[0])
                all_total = int(conn.execute(
                    "SELECT COUNT(*) FROM sessions WHERE ended_at IS NOT NULL"
                ).fetchone()[0])
                platform_rows = conn.execute(
                    """
                    SELECT platform, COUNT(*) AS count
                      FROM sessions
                     WHERE ended_at IS NOT NULL
                       AND platform <> ''
                     GROUP BY platform
                     ORDER BY platform
                    """
                ).fetchall()
                rows = conn.execute(page_sql, page_params).fetchall()
                conn.commit()
            has_more = len(rows) > limit
            rows = rows[:limit]
            next_cursor = None
            if rows:
                last = rows[-1]
                next_cursor = {
                    "started_at": float(last["started_at"]),
                    "id": str(last["id"]),
                }
            return {
                "ok": True,
                "sessions": [self._session_dict(row) for row in rows],
                "total": total,
                "all_total": all_total,
                "platforms": [
                    {"platform": str(row["platform"] or ""), "count": int(row["count"] or 0)}
                    for row in platform_rows
                ],
                "has_more": bool(has_more),
                "next_cursor": next_cursor,
                "db_path": self.path,
                "available": True,
                "stale": not flushed,
                "data_health": {
                    "flushed": bool(flushed),
                    "pending_writes": int(self._queue.qsize()),
                    "dropped_ops": int(self.dropped_ops),
                    "failed_ops": int(self._failed_ops),
                },
                "gap_events": int(self.dropped_ops),
                "failed_ops": int(self._failed_ops),
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("读取历史场次失败")
            return {"ok": False, "error": str(exc), "sessions": [], "total": 0, "available": True}

    def trend_sessions(
        self,
        started_from: Any,
        started_to: Any,
        *,
        query: Any = "",
        platform: Any = None,
        granularity: str = "day",
        room_key: Any = None,
    ) -> Dict[str, Any]:
        """对当前过滤范围做完整小时/日/周聚合，不使用历史列表分页。"""
        if not self.available:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": self.error or "场次存储不可用",
            }
        requested_granularity = str(granularity or "day").lower()
        if requested_granularity not in TREND_GRANULARITIES:
            return {
                "ok": False,
                "available": True,
                "error_code": "unsupported_granularity",
                "error": "趋势仅支持按小时、日或周聚合",
            }
        try:
            filter_data = self._history_where(
                query,
                started_from,
                started_to,
                platform,
                require_range=True,
            )
            range_from = float(filter_data["started_from"])
            range_to = float(filter_data["started_to"])
            if requested_granularity == "hour":
                if range_to - range_from > (TREND_MAX_HOURS + 2) * 3600:
                    return {
                        "ok": False,
                        "available": True,
                        "error_code": "range_too_large",
                        "error": "小时趋势最多支持 7 天",
                    }
                bucket_count = hour_bucket_count(range_from, range_to)
                bucket_limit = TREND_MAX_HOURS
                range_error = "小时趋势最多支持 7 天"
            else:
                if range_to - range_from > TREND_MAX_SECONDS_FAST:
                    return {
                        "ok": False,
                        "available": True,
                        "error_code": "range_too_large",
                        "error": "趋势范围超过 366 天",
                    }
                bucket_count = day_bucket_count(range_from, range_to)
                bucket_limit = TREND_MAX_DAYS
                range_error = "趋势范围超过 366 天"
            if bucket_count < 0:
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "invalid_range",
                    "error": "趋势时间超出支持范围",
                }
            if bucket_count > bucket_limit:
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "range_too_large",
                    "error": range_error,
                }
            flushed = self.flush(2.0)
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                rooms = [
                    {
                        "platform": str(row["platform"] or ""),
                        "room_key": str(row["room_key"] or ""),
                        "room_id": int(row["room_id"] or 0),
                        "room_title": str(row["room_title"] or ""),
                        "sessions": int(row["sessions"] or 0),
                        "last_started_at": float(row["last_started_at"] or 0),
                    }
                    for row in conn.execute(
                        """
                        SELECT
                            s.platform,
                            s.room_key,
                            MAX(s.room_id) AS room_id,
                            (
                                SELECT s2.room_title
                                  FROM sessions s2
                                 WHERE s2.platform = s.platform
                                   AND s2.room_key = s.room_key
                                   AND s2.ended_at IS NOT NULL
                                 ORDER BY s2.started_at DESC
                                 LIMIT 1
                            ) AS room_title,
                            COUNT(*) AS sessions,
                            MAX(s.started_at) AS last_started_at
                          FROM sessions s
                         WHERE {where}
                           AND s.room_key <> ''
                         GROUP BY s.platform, s.room_key
                         ORDER BY last_started_at DESC, platform, room_key
                        """.format(where=" AND ".join(filter_data["where"])),
                        filter_data["params"],
                    ).fetchall()
                ]
                unscoped_sessions = int(conn.execute(
                    """
                    SELECT COUNT(*)
                      FROM sessions
                     WHERE {where}
                       AND room_key = ''
                    """.format(where=" AND ".join(filter_data["where"])),
                    filter_data["params"],
                ).fetchone()[0])
                requested_room = str(room_key or "").strip()
                requested_platform = normalize_platform(platform)
                base_error = {
                    "ok": False,
                    "available": True,
                    "error_code": "scope_required",
                    "error": "历史趋势需要先选择一个直播间",
                    "rooms": rooms,
                    "unscoped_sessions": unscoped_sessions,
                    "filters": {
                        "query": str(query or "").strip(),
                        "platform": requested_platform or None,
                        "room_key": requested_room or None,
                    },
                }
                if requested_room:
                    matches = [
                        room for room in rooms
                        if room["room_key"] == requested_room and
                        (not requested_platform or room["platform"] == requested_platform)
                    ]
                    if not matches:
                        conn.commit()
                        base_error["error_code"] = "scope_not_found"
                        base_error["error"] = "所选直播间不在当前筛选范围内"
                        return base_error
                    if not requested_platform and len(matches) > 1:
                        conn.commit()
                        base_error["error_code"] = "platform_required"
                        base_error["error"] = "该房间标识属于多个平台，请先选择平台"
                        return base_error
                    scope = matches[0]
                elif not rooms:
                    if unscoped_sessions:
                        conn.commit()
                        base_error["error_code"] = "scope_incomplete"
                        base_error["error"] = (
                            "当前范围有 %d 场历史缺少房间标识，无法确定趋势范围"
                            % unscoped_sessions
                        )
                        return base_error
                    scope = None
                elif len(rooms) == 1:
                    scope = rooms[0]
                else:
                    conn.commit()
                    return base_error

                scoped_filter = self._history_where(
                    query,
                    started_from,
                    started_to,
                    scope["platform"] if scope else platform,
                    require_range=True,
                    room_key=scope["room_key"] if scope else None,
                )
                scope_filter = self._history_where(
                    query,
                    started_from,
                    started_to,
                    scope["platform"] if scope else platform,
                    room_key=scope["room_key"] if scope else None,
                    include_ended=False,
                )
                result = build_trend(
                    conn,
                    " AND ".join(scoped_filter["where"]),
                    scoped_filter["params"],
                    range_from,
                    range_to,
                    granularity=requested_granularity,
                    scope_where_sql=" AND ".join(scope_filter["where"]),
                    scope_params=scope_filter["params"],
                )
                conn.commit()
            if not result.get("ok"):
                return result
            result["filters"] = {
                "query": str(query or "").strip(),
                "platform": scoped_filter["platform"],
                "room_key": scoped_filter["room_key"],
            }
            result["scope"] = scope
            result["rooms"] = rooms
            if (not scoped_filter["platform"] or
                    not platform_money_comparable(scoped_filter["platform"])):
                result["money"]["comparable"] = False
                result["money"]["note"] = platform_money_note(scoped_filter["platform"])
                for money_key in ("gift_cny", "gift_silver", "gift_unknown", "super_chat_cny"):
                    result["money"][money_key] = None
            result["quality"]["unscoped_sessions"] = unscoped_sessions
            result["counts"]["unscoped_sessions"] = unscoped_sessions
            if scope is None:
                result["counts"]["room_count"] = 0
            else:
                result["counts"]["room_count"] = 1
            result["data_health"] = {
                "flushed": bool(flushed),
                "pending_writes": int(self._queue.qsize()),
                "dropped_ops": int(self.dropped_ops),
                "failed_ops": int(self._failed_ops),
            }
            if not flushed:
                result["stale"] = True
            return result
        except ValueError as exc:
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_range",
                "error": str(exc),
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("读取历史趋势失败")
            return {
                "ok": False,
                "available": True,
                "error_code": "internal",
                "error": "历史趋势读取失败",
            }

    def _read_session(self, conn: sqlite3.Connection, session_id: str) -> Optional[Dict[str, Any]]:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (str(session_id),)).fetchone()
        if row is None:
            return None
        session = self._session_dict(row)
        type_rows = conn.execute(
            "SELECT type, count FROM session_types WHERE session_id = ? ORDER BY type",
            (str(session_id),),
        ).fetchall()
        minute_rows = conn.execute(
            "SELECT minute, count FROM session_minutes WHERE session_id = ? ORDER BY minute",
            (str(session_id),),
        ).fetchall()
        session["types"] = {item["type"]: int(item["count"]) for item in type_rows}
        session["minutes"] = [
            {"minute": int(item["minute"]), "count": int(item["count"])}
            for item in minute_rows
        ]
        return session

    def get_session(self, session_id: str) -> Dict[str, Any]:
        if not self.available:
            return {"ok": False, "error": self.error or "场次存储不可用", "session": None}
        if not self.flush(2.0):
            return {
                "ok": False,
                "error_code": "data_stale",
                "error": "历史写入尚未落盘，请稍后重试",
                "session": None,
            }
        try:
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                session = self._read_session(conn, str(session_id))
                conn.commit()
            if session is None:
                return {"ok": False, "error": "场次不存在", "session": None}
            return {"ok": True, "session": session}
        except Exception as exc:  # noqa: BLE001
            logger.exception("读取历史场次详情失败：%s", session_id)
            return {"ok": False, "error": str(exc), "session": None}

    def get_previous_session(self, session_id: str) -> Dict[str, Any]:
        """返回同平台、同房间、开播时间更早的最近一场已结束场次。"""
        if not self.available:
            return {
                "ok": False,
                "available": False,
                "status": "unavailable",
                "error": self.error or "场次存储不可用",
                "target": None,
                "previous": None,
                "session": None,
            }
        if not self.flush(2.0):
            return {
                "ok": False,
                "available": True,
                "status": "data_stale",
                "error": "历史写入尚未落盘，请稍后重试",
                "target": None,
                "previous": None,
                "session": None,
                "has_previous": False,
            }
        try:
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                current = conn.execute(
                    "SELECT platform, room_id, room_key, started_at, ended_at FROM sessions WHERE id = ?",
                    (str(session_id),),
                ).fetchone()
                if current is None:
                    conn.commit()
                    return {
                        "ok": False,
                        "status": "target_not_found",
                        "error": "场次不存在",
                        "target": None,
                        "previous": None,
                        "session": None,
                        "has_previous": False,
                    }
                if current["ended_at"] is None:
                    conn.commit()
                    return {
                        "ok": False,
                        "status": "target_active",
                        "error": "当前场次尚未结束",
                        "target": None,
                        "previous": None,
                        "session": None,
                        "has_previous": False,
                    }
                platform = normalize_platform(current["platform"])
                room_key = str(current["room_key"] or "").strip()
                started_at = self._optional_epoch(current["started_at"])
                ended_at = self._optional_epoch(current["ended_at"])
                if (not platform or not room_key or started_at is None or
                        ended_at is None or ended_at < started_at):
                    conn.commit()
                    return {
                        "ok": False,
                        "status": "target_incomplete",
                        "error": "当前场次缺少可比对的平台、房间标识或开播时间",
                        "target": None,
                        "previous": None,
                        "session": None,
                        "has_previous": False,
                    }
                previous = conn.execute(
                    """
                    SELECT id, started_at FROM sessions
                     WHERE ended_at IS NOT NULL
                       AND ended_at >= started_at
                       AND started_at > 0 AND started_at < 1000000000000
                       AND ended_at > 0 AND ended_at < 1000000000000
                       AND typeof(started_at) IN ('integer', 'real')
                       AND typeof(ended_at) IN ('integer', 'real')
                       AND platform = ?
                       AND room_key = ?
                       AND room_key <> ''
                       AND started_at < ?
                       AND id <> ?
                     ORDER BY started_at DESC, id DESC
                     LIMIT 2
                    """,
                    (
                        platform,
                        room_key,
                        float(started_at),
                        str(session_id),
                    ),
                ).fetchall()
                target = self._read_session(conn, str(session_id))
                if not previous:
                    conn.commit()
                    return {
                        "ok": True,
                        "status": "no_previous",
                        "target": target,
                        "previous": None,
                        "session": None,
                        "has_previous": False,
                    }
                if len(previous) > 1 and float(previous[0]["started_at"]) == float(previous[1]["started_at"]):
                    conn.commit()
                    return {
                        "ok": False,
                        "status": "ambiguous_tie",
                        "error": "存在同开播时间的上一场记录，无法确定基准场次",
                        "target": target,
                        "previous": None,
                        "session": None,
                        "has_previous": False,
                    }
                session = self._read_session(conn, str(previous[0]["id"]))
                conn.commit()
            if session is None:
                return {
                    "ok": True,
                    "status": "no_previous",
                    "target": target,
                    "previous": None,
                    "session": None,
                    "has_previous": False,
                }
            return {
                "ok": True,
                "status": "found",
                "target": target,
                "previous": session,
                "session": session,
                "has_previous": True,
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("读取上一场历史场次失败：%s", session_id)
            return {
                "ok": False,
                "status": "error",
                "error": str(exc),
                "target": None,
                "previous": None,
                "session": None,
                "has_previous": False,
            }

    def _comparison_data_health(self, flushed: bool) -> Dict[str, Any]:
        return {
            "flushed": bool(flushed),
            "pending_writes": int(self._queue.qsize()),
            "dropped_ops": int(self.dropped_ops),
            "failed_ops": int(self._failed_ops),
        }

    def list_baseline_candidates(
        self,
        target_id: Any,
        limit: int = 30,
        *,
        before_distance: Any = None,
        before_started_at: Any = None,
        before_id: Any = None,
        before_target_id: Any = None,
    ) -> Dict[str, Any]:
        """列出 target 同平台、同 room_key 的已结束候选场次。"""
        if not self.available:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": self.error or "场次存储不可用",
                "candidates": [],
            }
        target_text = normalize_id(target_id)
        if not target_text:
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_argument",
                "error": "target_id 无效",
                "candidates": [],
            }
        try:
            limit_value = int(limit)
        except (TypeError, ValueError):
            limit_value = 0
        if limit_value < 1 or limit_value > 100:
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_argument",
                "error": "limit 必须在 1–100 之间",
                "candidates": [],
            }
        cursor_parts = (before_distance, before_started_at, before_id)
        cursor_count = sum(value is not None for value in cursor_parts)
        if cursor_count not in (0, 3) or (before_target_id is not None and cursor_count != 3):
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_cursor",
                "error": "候选分页游标不完整",
                "candidates": [],
            }
        cursor_distance = cursor_started = cursor_id = None
        if cursor_count == 3:
            cursor_distance = finite_epoch(before_distance)
            cursor_started = finite_epoch(before_started_at)
            cursor_id = normalize_id(before_id)
            cursor_target = normalize_id(before_target_id)
            if (cursor_distance is None or cursor_distance < 0 or
                    cursor_started is None or not cursor_id or
                    not cursor_target or cursor_target != target_text):
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "invalid_cursor",
                    "error": "候选分页游标无效或属于其他目标场",
                    "candidates": [],
                }
        flushed = self.flush(2.0)
        try:
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                target_row = conn.execute(
                    "SELECT * FROM sessions WHERE id = ?",
                    (target_text,),
                ).fetchone()
                target_error = validate_session(target_row, "target")
                if target_error:
                    conn.commit()
                    return {
                        "ok": False,
                        "available": True,
                        **target_error,
                        "candidates": [],
                        "stale": not flushed,
                        "data_health": self._comparison_data_health(flushed),
                    }
                target_data = self._session_dict(target_row)
                scope = comparison_scope(target_data)
                target_started = float(target_data["started_at"])
                base_where = [
                    "ended_at IS NOT NULL",
                    "ended_at >= started_at",
                    "started_at > 0 AND started_at < 1000000000000",
                    "ended_at > 0 AND ended_at < 1000000000000",
                    "typeof(started_at) IN ('integer', 'real')",
                    "typeof(ended_at) IN ('integer', 'real')",
                    "platform = ?",
                    "room_key = ?",
                    "id <> ?",
                ]
                base_params: List[Any] = [
                    scope["platform"],
                    scope["room_key"],
                    target_text,
                ]
                total = int(conn.execute(
                    "SELECT COUNT(*) FROM sessions WHERE " + " AND ".join(base_where),
                    base_params,
                ).fetchone()[0])
                page_where = list(base_where)
                page_params = list(base_params)
                if cursor_count == 3:
                    page_where.append(
                        "("
                        "ABS(started_at - ?) > ? OR "
                        "(ABS(started_at - ?) = ? AND started_at < ?) OR "
                        "(ABS(started_at - ?) = ? AND started_at = ? AND id < ?)"
                        ")"
                    )
                    page_params.extend((
                        target_started, cursor_distance,
                        target_started, cursor_distance, cursor_started,
                        target_started, cursor_distance, cursor_started, cursor_id,
                    ))
                page_sql = (
                    "SELECT * FROM sessions WHERE " + " AND ".join(page_where) +
                    " ORDER BY ABS(started_at - ?) ASC, started_at DESC, id DESC LIMIT ?"
                )
                page_params.extend((target_started, limit_value + 1))
                rows = conn.execute(page_sql, page_params).fetchall()
                conn.commit()
        except Exception as exc:  # noqa: BLE001
            logger.exception("读取基准场候选失败：%s", target_text)
            return {
                "ok": False,
                "available": True,
                "error_code": "internal",
                "error": "基准场候选读取失败",
                "candidates": [],
                "stale": not flushed,
                "data_health": self._comparison_data_health(flushed),
            }
        has_more = len(rows) > limit_value
        rows = rows[:limit_value]
        candidates = [candidate_summary(row, target_started) for row in rows]
        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            next_cursor = {
                "target_id": target_text,
                "distance_seconds": abs(float(last["started_at"]) - target_started),
                "started_at": float(last["started_at"]),
                "id": str(last["id"]),
            }
        return {
            "ok": True,
            "available": True,
            "api_version": 1,
            "target": {
                "id": target_text,
                "platform": scope["platform"],
                "room_key": scope["room_key"],
                "room_title": str(target_data.get("room_title") or ""),
                "started_at": target_started,
                "ended_at": float(target_data["ended_at"]),
            },
            "scope": scope,
            "candidates": candidates,
            "total": total,
            "scope_total": total,
            "has_more": bool(has_more),
            "next_cursor": next_cursor,
            "stale": not flushed,
            "data_health": self._comparison_data_health(flushed),
        }

    def compare_sessions(self, target_id: Any, baseline_id: Any) -> Dict[str, Any]:
        """在同一读事务中返回 target 与显式 baseline 的完整快照。"""
        if not self.available:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": self.error or "场次存储不可用",
                "target": None,
                "baseline": None,
            }
        target_text = normalize_id(target_id)
        baseline_text = normalize_id(baseline_id)
        if not target_text or not baseline_text:
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_argument",
                "error": "场次 id 无效",
                "target": None,
                "baseline": None,
            }
        if target_text == baseline_text:
            return {
                "ok": False,
                "available": True,
                "error_code": "same_session",
                "error": "当前场不能作为自己的基准",
                "target": None,
                "baseline": None,
            }
        flushed = self.flush(2.0)
        try:
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                target = self._read_session(conn, target_text)
                target_error = validate_session(target, "target")
                if target_error:
                    conn.commit()
                    return {
                        "ok": False,
                        "available": True,
                        **target_error,
                        "target": None,
                        "baseline": None,
                        "stale": not flushed,
                        "data_health": self._comparison_data_health(flushed),
                    }
                baseline = self._read_session(conn, baseline_text)
                baseline_error = validate_session(baseline, "baseline")
                if baseline_error:
                    conn.commit()
                    return {
                        "ok": False,
                        "available": True,
                        **baseline_error,
                        "target": target,
                        "baseline": None,
                        "stale": not flushed,
                        "data_health": self._comparison_data_health(flushed),
                    }
                scope_error = compare_scope_error(target, baseline)
                if scope_error:
                    conn.commit()
                    return {
                        "ok": False,
                        "available": True,
                        **scope_error,
                        "target": None,
                        "baseline": None,
                        "stale": not flushed,
                        "data_health": self._comparison_data_health(flushed),
                    }
                conn.commit()
        except Exception:  # noqa: BLE001
            logger.exception("历史场次对比失败：%s vs %s", target_text, baseline_text)
            return {
                "ok": False,
                "available": True,
                "error_code": "internal",
                "error": "历史场次对比失败",
                "target": None,
                "baseline": None,
                "stale": not flushed,
                "data_health": self._comparison_data_health(flushed),
            }
        return {
            "ok": True,
            "available": True,
            "api_version": 1,
            "scope": comparison_scope(target),
            "target": target,
            "baseline": baseline,
            "stale": not flushed,
            "data_health": self._comparison_data_health(flushed),
        }

    def compare_multi_sessions(self, target_id: Any, baseline_ids: Any) -> Dict[str, Any]:
        """在一次读事务中返回当前场与最多 3 个基准场的完整快照。"""
        if not self.available:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": self.error or "场次存储不可用",
                "target": None,
                "baselines": [],
            }
        target_text = normalize_id(target_id)
        if not target_text:
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_argument",
                "error": "target_id 无效",
                "target": None,
                "baselines": [],
            }
        if not isinstance(baseline_ids, (list, tuple)):
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_argument",
                "error": "baseline_ids 必须是数组",
                "target": None,
                "baselines": [],
            }
        if not baseline_ids:
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_argument",
                "error": "至少选择 1 个基准场",
                "target": None,
                "baselines": [],
            }
        if len(baseline_ids) > MAX_COMPARE_BASELINES:
            return {
                "ok": False,
                "available": True,
                "error_code": "too_many_baselines",
                "error": "最多选择 %d 个基准场" % MAX_COMPARE_BASELINES,
                "target": None,
                "baselines": [],
                "max_baselines": MAX_COMPARE_BASELINES,
            }
        normalized: List[str] = []
        seen: Dict[str, int] = {}
        for index, value in enumerate(baseline_ids, 1):
            baseline_text = normalize_id(value)
            if not baseline_text:
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "invalid_argument",
                    "error": "第 %d 个基准场 id 无效" % index,
                    "baseline_index": index,
                    "target": None,
                    "baselines": [],
                }
            if baseline_text == target_text:
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "same_session",
                    "error": "当前场不能作为自己的基准",
                    "baseline_index": index,
                    "baseline_id": baseline_text,
                    "target": None,
                    "baselines": [],
                }
            if baseline_text in seen:
                return {
                    "ok": False,
                    "available": True,
                    "error_code": "duplicate_baseline",
                    "error": "基准场不能重复选择",
                    "baseline_index": index,
                    "first_index": seen[baseline_text],
                    "baseline_id": baseline_text,
                    "target": None,
                    "baselines": [],
                }
            seen[baseline_text] = index
            normalized.append(baseline_text)

        flushed = self.flush(2.0)
        try:
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                target = self._read_session(conn, target_text)
                target_error = validate_session(target, "target")
                if target_error:
                    conn.commit()
                    return {
                        "ok": False,
                        "available": True,
                        **target_error,
                        "target": None,
                        "baselines": [],
                        "stale": not flushed,
                        "data_health": self._comparison_data_health(flushed),
                    }
                target_scope = comparison_scope(target)
                baselines: List[Dict[str, Any]] = []
                for index, baseline_text in enumerate(normalized, 1):
                    baseline = self._read_session(conn, baseline_text)
                    baseline_error = validate_session(baseline, "baseline")
                    if baseline_error:
                        conn.commit()
                        return {
                            "ok": False,
                            "available": True,
                            **baseline_error,
                            "baseline_index": index,
                            "baseline_id": baseline_text,
                            "target": target,
                            "baselines": [],
                            "stale": not flushed,
                            "data_health": self._comparison_data_health(flushed),
                        }
                    scope_error = compare_scope_error(target, baseline)
                    if scope_error:
                        conn.commit()
                        return {
                            "ok": False,
                            "available": True,
                            **scope_error,
                            "baseline_index": index,
                            "baseline_id": baseline_text,
                            "target": target,
                            "baselines": [],
                            "stale": not flushed,
                            "data_health": self._comparison_data_health(flushed),
                        }
                    baselines.append({
                        "index": index,
                        "id": baseline_text,
                        "session": baseline,
                    })
                conn.commit()
        except Exception:  # noqa: BLE001
            logger.exception("多基准场对比失败：%s", target_text)
            return {
                "ok": False,
                "available": True,
                "error_code": "internal",
                "error": "多基准场对比失败",
                "target": None,
                "baselines": [],
                "stale": not flushed,
                "data_health": self._comparison_data_health(flushed),
            }

        target_started = float(target["started_at"])
        for item in baselines:
            session = item["session"]
            item["relation"] = relation(target_started, float(session["started_at"]))
            item["distance_seconds"] = abs(float(session["started_at"]) - target_started)
            item["overlaps_target"] = intervals_overlap(target, session)
            item["overlaps_baselines"] = []
        overlap_pairs: List[Dict[str, str]] = []
        for index, item in enumerate(baselines):
            if item["overlaps_target"]:
                overlap_pairs.append({"left": "当前", "right": "B%d" % item["index"]})
            for other in baselines[index + 1:]:
                if intervals_overlap(item["session"], other["session"]):
                    item["overlaps_baselines"].append("B%d" % other["index"])
                    other["overlaps_baselines"].append("B%d" % item["index"])
                    overlap_pairs.append({
                        "left": "B%d" % item["index"],
                        "right": "B%d" % other["index"],
                    })
        return {
            "ok": True,
            "available": True,
            "api_version": 1,
            "scope": target_scope,
            "target": target,
            "baselines": baselines,
            "baseline_count": len(baselines),
            "max_baselines": MAX_COMPARE_BASELINES,
            "ordering": "requested",
            "overlap_pairs": overlap_pairs,
            "stale": not flushed,
            "data_health": self._comparison_data_health(flushed),
        }

    def session_insights(self, target_id: Any) -> Dict[str, Any]:
        """返回同房间事实基线、received/hour 名次和记录内 5 分钟峰值。"""
        if not self.available:
            return {
                "ok": False,
                "available": False,
                "error_code": "unavailable",
                "error": self.error or "场次存储不可用",
            }
        target_text = normalize_id(target_id)
        if not target_text:
            return {
                "ok": False,
                "available": True,
                "error_code": "invalid_argument",
                "error": "target_id 无效",
            }
        flushed = self.flush(2.0)
        if not flushed:
            return {
                "ok": False,
                "available": True,
                "error_code": "data_stale",
                "error": "历史写入尚未落盘，请稍后重试",
                "stale": True,
                "data_health": self._comparison_data_health(flushed),
            }
        try:
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                target = self._read_session(conn, target_text)
                target_error = validate_session(target, "target")
                if target_error:
                    conn.commit()
                    return {
                        "ok": False,
                        "available": True,
                        **target_error,
                        "stale": False,
                        "data_health": self._comparison_data_health(flushed),
                    }
                scope = comparison_scope(target)
                target_started = float(target["started_at"])
                window_from = target_started - WINDOW_DAYS * 86400
                candidate_rows = conn.execute(
                    """
                    SELECT *
                      FROM sessions
                     WHERE ended_at IS NOT NULL
                       AND ended_at >= started_at
                       AND started_at >= ? AND started_at < ?
                       AND started_at > 0 AND started_at < 1000000000000
                       AND ended_at > 0 AND ended_at < 1000000000000
                       AND typeof(started_at) IN ('integer', 'real')
                       AND typeof(ended_at) IN ('integer', 'real')
                       AND platform = ? AND room_key = ?
                       AND id <> ?
                     ORDER BY started_at DESC, id DESC
                     LIMIT ?
                    """,
                    (
                        window_from,
                        target_started,
                        scope["platform"],
                        scope["room_key"],
                        target_text,
                        LOOKBACK_N,
                    ),
                ).fetchall()
                candidate_ids = [str(row["id"]) for row in candidate_rows]
                minutes_by_id: Dict[str, List[Dict[str, Any]]] = {
                    target_text: list(target.get("minutes") or []),
                }
                if candidate_ids:
                    placeholders = ",".join("?" for _ in candidate_ids)
                    minute_rows = conn.execute(
                        """
                        SELECT session_id, minute, count
                          FROM session_minutes
                         WHERE session_id IN ({placeholders})
                         ORDER BY session_id, minute
                        """.format(placeholders=placeholders),
                        candidate_ids,
                    ).fetchall()
                    for row in minute_rows:
                        minutes_by_id.setdefault(str(row["session_id"]), []).append({
                            "minute": int(row["minute"]),
                            "count": int(row["count"]),
                        })
                conn.commit()
        except Exception:  # noqa: BLE001
            logger.exception("读取场次复盘洞察失败：%s", target_text)
            return {
                "ok": False,
                "available": True,
                "error_code": "internal",
                "error": "场次复盘读取失败",
                "stale": False,
                "data_health": self._comparison_data_health(flushed),
            }
        try:
            now = datetime.now().astimezone()
            offset = int(now.utcoffset().total_seconds()) if now.utcoffset() is not None else 0
            result = build_insights(
                target,
                candidate_rows,
                minutes_by_id,
                as_of=time.time(),
                timezone_name=time.tzname[0],
                utc_offset_seconds=offset,
            )
            result["window"]["started_from"] = window_from
            result["window"]["started_to"] = target_started
            result["metric_cohort"]["candidate_scan_count"] = len(candidate_rows)
            result["metric_cohort"]["candidate_limit"] = LOOKBACK_N
            result["peak"]["window_min"] = PEAK_WINDOW_MIN
            data_health = self._comparison_data_health(flushed)
            result["data_health"] = data_health
            result["quality"]["degraded"] = bool(
                data_health["dropped_ops"] or data_health["failed_ops"]
            )
            if result["quality"]["degraded"]:
                result["quality"]["flags"].append("degraded")
            result["quality"]["dropped_ops"] = data_health["dropped_ops"]
            result["quality"]["failed_ops"] = data_health["failed_ops"]
            result["quality"]["pending_writes"] = data_health["pending_writes"]
            result["quality"]["last_write_error"] = str(self.last_write_error or "")
            result["stale"] = False
            return result
        except Exception:  # noqa: BLE001
            logger.exception("构建场次复盘失败：%s", target_text)
            return {
                "ok": False,
                "available": True,
                "error_code": "internal",
                "error": "场次复盘读取失败",
                "stale": False,
                "data_health": self._comparison_data_health(flushed),
            }

    @staticmethod
    def _prune_plan(
        conn: sqlite3.Connection,
        cutoff_ts: float,
        keep_latest: int,
    ) -> Dict[str, Any]:
        total = int(conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE ended_at IS NOT NULL"
        ).fetchone()[0])
        protected_rows = conn.execute(
            """
            SELECT id FROM sessions
             WHERE ended_at IS NOT NULL
             ORDER BY ended_at DESC, id DESC
             LIMIT ?
            """,
            (keep_latest,),
        ).fetchall() if keep_latest > 0 else []
        protected = {str(row["id"]) for row in protected_rows}
        rows = conn.execute(
            """
            SELECT id, ended_at FROM sessions
             WHERE ended_at IS NOT NULL
               AND ended_at < ?
             ORDER BY ended_at ASC, id ASC
            """,
            (cutoff_ts,),
        ).fetchall()
        candidates = [row for row in rows if str(row["id"]) not in protected]
        return {
            "total": total,
            "protected": len(protected),
            "matched": len(candidates),
            "oldest_candidate": float(candidates[0]["ended_at"]) if candidates else None,
            "newest_candidate": float(candidates[-1]["ended_at"]) if candidates else None,
            "ids": [str(row["id"]) for row in candidates],
        }

    def _backup_database(self, label: str) -> str:
        directory = os.path.join(os.path.dirname(self.path), "backups")
        os.makedirs(directory, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        path = os.path.join(
            directory,
            "%s-%s-%d.sqlite3" % (label, stamp, time.time_ns()),
        )
        tmp_path = path + ".tmp"
        source = self._connect()
        target = sqlite3.connect(tmp_path)
        try:
            source.backup(target)
            target.close()
            target = None
            with closing(sqlite3.connect(tmp_path)) as check:
                integrity = str(check.execute("PRAGMA integrity_check").fetchone()[0] or "")
            if integrity != "ok":
                raise RuntimeError("历史备份完整性校验失败：%s" % integrity)
            os.replace(tmp_path, path)
            return path
        finally:
            if target is not None:
                target.close()
            source.close()
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                logger.debug("清理临时历史备份失败：%s", tmp_path, exc_info=True)

    def _backup_before_prune(self) -> str:
        return self._backup_database("history-before-prune")

    def prune_sessions(
        self,
        cutoff_ts: Any,
        *,
        keep_latest: int = 1,
        dry_run: bool = True,
        backup: bool = True,
        batch_size: int = 200,
    ) -> Dict[str, Any]:
        """按 ended_at 清理旧场次；默认只预览，实际删除前自动备份。"""
        if not self.available:
            return {"ok": False, "available": False, "error": self.error or "场次存储不可用"}
        try:
            cutoff = self._optional_epoch(cutoff_ts)
            if cutoff is None:
                return {"ok": False, "error": "清理截止时间不能为空"}
            keep_latest = max(0, int(keep_latest))
            batch_size = max(1, min(int(batch_size), 1000))
            with closing(self._connect()) as conn:
                conn.execute("BEGIN")
                plan = self._prune_plan(conn, cutoff, keep_latest)
                conn.commit()
            result = {
                "ok": True,
                "available": True,
                "dry_run": bool(dry_run),
                "cutoff_ts": cutoff,
                "total": plan["total"],
                "protected": plan["protected"],
                "matched": plan["matched"],
                "deleted": 0,
                "oldest_candidate": plan["oldest_candidate"],
                "newest_candidate": plan["newest_candidate"],
                "backup_path": None,
            }
            if dry_run or not plan["ids"]:
                return result
            if backup:
                result["backup_path"] = self._backup_before_prune()
            with closing(self._connect()) as conn:
                conn.execute("BEGIN IMMEDIATE")
                current = self._prune_plan(conn, cutoff, keep_latest)
                ids = current["ids"]
                for start in range(0, len(ids), batch_size):
                    chunk = ids[start:start + batch_size]
                    conn.executemany(
                        "DELETE FROM sessions WHERE id = ? AND ended_at IS NOT NULL AND ended_at < ?",
                        [(session_id, cutoff) for session_id in chunk],
                    )
                conn.commit()
            result["matched"] = current["matched"]
            result["deleted"] = len(ids)
            result["oldest_candidate"] = current["oldest_candidate"]
            result["newest_candidate"] = current["newest_candidate"]
            return result
        except Exception as exc:  # noqa: BLE001
            logger.exception("清理历史场次失败")
            return {"ok": False, "available": True, "error": str(exc)}

    @property
    def export_dir(self) -> str:
        """导出文件放在应用根目录的 exports/history，避免散落到临时目录。"""
        app_root = os.path.dirname(os.path.dirname(self.path))
        return os.path.join(app_root, "exports", "history")

    def _default_export_path_error(self, output_dir: Optional[str]) -> Optional[Dict[str, Any]]:
        if output_dir is not None:
            return None
        return self._export_manager.path_error()

    def export_storage_status(self, week: Any = None) -> Dict[str, Any]:
        return self._export_manager.status(week)

    def export_storage_preview(
        self,
        days: Any = 90,
        keep_latest: Any = 50,
        week: Any = None,
    ) -> Dict[str, Any]:
        return self._export_manager.preview(days, keep_latest, week)

    def export_storage_prune(
        self,
        preview_id: Any,
        days: Any = 90,
        keep_latest: Any = 50,
        week: Any = None,
    ) -> Dict[str, Any]:
        return self._export_manager.prune(preview_id, days, keep_latest, week)

    def open_export_dir(self) -> Dict[str, Any]:
        return self._export_manager.open_directory()

    @staticmethod
    def _safe_filename_part(value: str, fallback: str = "直播") -> str:
        text = str(value or "").strip()
        text = re.sub(r"[\x00-\x1f<>:\"/\\|?*]+", " ", text)
        text = re.sub(r"\s+", " ", text).strip(" .")
        return (text[:32].strip(" .") or fallback)

    @staticmethod
    def _csv_safe(value: Any) -> Any:
        """防止 CSV 单元格被表格软件当成公式执行。"""
        if not isinstance(value, str):
            return value
        if value and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
            return "'" + value
        return value

    @staticmethod
    def _write_atomic(path: str, text: str, encoding: str) -> None:
        tmp_path = "%s.tmp-%d-%d" % (path, os.getpid(), threading.get_ident())
        try:
            with open(tmp_path, "w", encoding=encoding, newline="") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                logger.debug("清理临时导出文件失败：%s", tmp_path, exc_info=True)

    def export_session(self, session_id: str, fmt: str = "json", output_dir: Optional[str] = None) -> Dict[str, Any]:
        """导出单场聚合数据；只允许已结束场次，永不读取原始消息正文。"""
        normalized = str(fmt or "json").lower()
        if normalized not in ("json", "csv"):
            return {"ok": False, "error": "仅支持导出 JSON 或 CSV"}
        if not self.available:
            return {"ok": False, "error": self.error or "场次存储不可用"}
        try:
            detail = self.get_session(session_id)
            if not detail.get("ok") or not detail.get("session"):
                return {"ok": False, "error": detail.get("error") or "场次不存在"}
            session = detail["session"]
            if session.get("ended_at") is None:
                return {"ok": False, "error": "只能导出已结束的场次"}

            directory = os.path.abspath(output_dir or self.export_dir)
            path_error = self._default_export_path_error(output_dir)
            if path_error:
                return path_error
            os.makedirs(directory, exist_ok=True)
            started = float(session.get("started_at") or time.time())
            stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(started))
            title = self._safe_filename_part(session.get("room_title") or session.get("room_id"))
            session_slug = re.sub(r"[^A-Za-z0-9_-]+", "", str(session_id))[:10] or "session"
            filename = "readme-session-%s-%s-%s.%s" % (stamp, title, session_slug, normalized)
            path = os.path.join(directory, filename)
            exported_at = int(time.time())

            if normalized == "json":
                payload = {
                    "schema_version": 2,
                    "exported_at": exported_at,
                    "privacy": "aggregate_only_no_message_bodies_or_user_identifiers",
                    "session": session,
                }
                text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
                self._write_atomic(path, text, "utf-8")
            else:
                types = session.get("types") if isinstance(session.get("types"), dict) else {}
                minutes = session.get("minutes") if isinstance(session.get("minutes"), list) else []
                columns = [
                    "schema_version", "exported_at", "id", "platform", "room_id", "room_key", "room_title",
                    "started_at", "ended_at", "end_reason", "last_event_at",
                    "real_received", "real_spoken", "real_dropped",
                    "mock_received", "mock_spoken", "mock_dropped",
                    "unique_users", "gift_cny", "gift_silver", "gift_unknown",
                    "super_chat_cny", "danmaku", "gift", "super_chat", "guard", "enter", "like", "social",
                    "fansclub",
                    "minutes_json",
                ]
                row = {
                    "schema_version": 2,
                    "exported_at": exported_at,
                    "id": session.get("id"),
                    "platform": session.get("platform"),
                    "room_id": session.get("room_id"),
                    "room_key": session.get("room_key"),
                    "room_title": session.get("room_title"),
                    "started_at": session.get("started_at"),
                    "ended_at": session.get("ended_at"),
                    "end_reason": session.get("end_reason"),
                    "last_event_at": session.get("last_event_at"),
                    "real_received": session.get("real_received"),
                    "real_spoken": session.get("real_spoken"),
                    "real_dropped": session.get("real_dropped"),
                    "mock_received": session.get("mock_received"),
                    "mock_spoken": session.get("mock_spoken"),
                    "mock_dropped": session.get("mock_dropped"),
                    "unique_users": session.get("unique_users"),
                    "gift_cny": session.get("gift_cny"),
                    "gift_silver": session.get("gift_silver"),
                    "gift_unknown": session.get("gift_unknown"),
                    "super_chat_cny": session.get("super_chat_cny"),
                    "danmaku": types.get("danmaku", 0),
                    "gift": types.get("gift", 0),
                    "super_chat": types.get("super_chat", 0),
                    "guard": types.get("guard", 0),
                    "enter": types.get("enter", 0),
                    "like": types.get("like", 0),
                    "social": types.get("social", 0),
                    "fansclub": types.get("fansclub", 0),
                    "minutes_json": json.dumps(minutes, ensure_ascii=False, separators=(",", ":")),
                }
                buffer = io.StringIO(newline="")
                writer = csv.writer(buffer, lineterminator="\n")
                writer.writerow(columns)
                writer.writerow([self._csv_safe(row.get(column, "")) for column in columns])
                self._write_atomic(path, buffer.getvalue(), "utf-8-sig")

            return {
                "ok": True,
                "format": normalized,
                "path": path,
                "size": int(os.path.getsize(path)),
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("导出历史场次失败：%s", session_id)
            return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}

    def _write_analysis_report(
        self,
        report: Dict[str, Any],
        fmt: str,
        *,
        slug: str = "",
        output_dir: Optional[str] = None,
    ) -> Dict[str, Any]:
        normalized = str(fmt or "json").lower()
        if normalized not in ("json", "csv"):
            return {"ok": False, "error": "仅支持导出 JSON 或 CSV"}
        path_error = self._default_export_path_error(output_dir)
        if path_error:
            return path_error
        directory = os.path.abspath(output_dir or self.export_dir)
        os.makedirs(directory, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        kind = str(report.get("kind") or "analysis")
        title = self._safe_filename_part(slug or kind, fallback="分析")
        path = ""
        for _attempt in range(8):
            unique = uuid.uuid4().hex[:12]
            filename = "readme-report-%s-%s-%s-%s.%s" % (
                kind, stamp, title, unique, normalized
            )
            candidate = os.path.join(directory, filename)
            if not os.path.exists(candidate):
                path = candidate
                break
        if not path:
            return {
                "ok": False,
                "error": "无法生成唯一导出文件名，请稍后重试",
            }
        try:
            if normalized == "json":
                text = render_json(report)
                self._write_atomic(path, text, "utf-8")
            else:
                text = render_csv(report)
                self._write_atomic(path, text, "utf-8-sig")
        except Exception as exc:  # noqa: BLE001
            logger.exception("写入分析报告失败：%s", path)
            return {"ok": False, "error": "报告写入失败：%s: %s" % (type(exc).__name__, exc)}
        return {
            "ok": True,
            "format": normalized,
            "path": path,
            "size": int(os.path.getsize(path)),
            "report_schema_version": REPORT_SCHEMA_VERSION,
            "kind": kind,
            "warnings": report.get("warnings") or [],
            "quality_flag_count": (
                (report.get("quality") or {}).get("summary", {}).get("flag_count")
                if isinstance(report.get("quality"), dict) else None
            ),
            "overlap_pair_count": (
                len((report.get("overlap") or {}).get("pairs") or [])
                if isinstance(report.get("overlap"), dict) else None
            ),
        }

    @staticmethod
    def _analysis_result_error(result: Optional[Dict[str, Any]], default: str) -> Optional[Dict[str, Any]]:
        if not isinstance(result, dict):
            return {
                "ok": False,
                "available": False,
                "error_code": "internal",
                "error": default,
            }
        if not result.get("ok"):
            error = {
                "ok": False,
                "available": bool(result.get("available", True)),
                "error_code": result.get("error_code") or "internal",
                "error": result.get("error") or default,
            }
            for key in (
                "baseline_index",
                "baseline_id",
                "first_index",
                "max_baselines",
                "min_baselines",
            ):
                if key in result:
                    error[key] = result[key]
            return error
        if result.get("stale"):
            return {
                "ok": False,
                "available": True,
                "error_code": "data_stale",
                "error": "历史写入尚未完成，暂不导出分析报告",
            }
        return None

    def export_trend_report(
        self,
        started_from: Any,
        started_to: Any,
        *,
        query: Any = "",
        platform: Any = None,
        granularity: str = "day",
        room_key: Any = None,
        fmt: str = "json",
        output_dir: Optional[str] = None,
    ) -> Dict[str, Any]:
        """服务端重新读取同一筛选范围后导出趋势报告。"""
        result = self.trend_sessions(
            started_from,
            started_to,
            query=query,
            platform=platform,
            granularity=granularity,
            room_key=room_key,
        )
        error = self._analysis_result_error(result, "趋势报告生成失败")
        if error:
            return error
        non_empty_buckets = [
            bucket for bucket in (result.get("buckets") or [])
            if isinstance(bucket, dict) and int(bucket.get("sessions") or 0) > 0
        ]
        if not non_empty_buckets:
            return {
                "ok": False,
                "available": True,
                "error_code": "no_data",
                "error": "当前趋势范围没有可导出的已结束场次",
            }
        report = build_trend_report(result, int(time.time()))
        scope = result.get("scope") if isinstance(result.get("scope"), dict) else {}
        return self._write_analysis_report(
            report,
            fmt,
            slug=str(scope.get("room_title") or scope.get("room_key") or "trend"),
            output_dir=output_dir,
        )

    def export_compare_report(
        self,
        target_id: Any,
        baseline_id: Any,
        *,
        fmt: str = "json",
        output_dir: Optional[str] = None,
    ) -> Dict[str, Any]:
        """服务端重新读取 target/baseline 后导出单基准对比报告。"""
        result = self.compare_sessions(target_id, baseline_id)
        error = self._analysis_result_error(result, "对比报告生成失败")
        if error:
            return error
        if not result.get("target") or not result.get("baseline"):
            return {
                "ok": False,
                "available": True,
                "error_code": "no_data",
                "error": "对比报告缺少当前记录或基准场",
            }
        report = build_compare_report(result, int(time.time()))
        target = result.get("target") if isinstance(result.get("target"), dict) else {}
        return self._write_analysis_report(
            report,
            fmt,
            slug=str(target.get("room_title") or target.get("room_key") or "compare"),
            output_dir=output_dir,
        )

    def export_compare_multi_report(
        self,
        target_id: Any,
        baseline_ids: Any,
        *,
        fmt: str = "json",
        output_dir: Optional[str] = None,
    ) -> Dict[str, Any]:
        """服务端重新读取当前场与 2–3 个基准后导出多场对比报告。"""
        result = self.compare_multi_sessions(target_id, baseline_ids)
        error = self._analysis_result_error(result, "多场对比报告生成失败")
        if error:
            return error
        baselines = result.get("baselines") if isinstance(
            result.get("baselines"), list
        ) else []
        if len(baselines) < 2:
            return {
                "ok": False,
                "available": True,
                "error_code": "insufficient_baselines",
                "error": "多场对比导出至少需要 2 个基准场",
                "min_baselines": 2,
            }
        if not result.get("target"):
            return {
                "ok": False,
                "available": True,
                "error_code": "no_data",
                "error": "多场对比报告缺少当前记录",
            }
        report = build_multi_compare_report(result, int(time.time()))
        target = result.get("target") if isinstance(result.get("target"), dict) else {}
        return self._write_analysis_report(
            report,
            fmt,
            slug=str(target.get("room_title") or target.get("room_key") or "compare-multi"),
            output_dir=output_dir,
        )

    def export_insights_report(
        self,
        target_id: Any,
        *,
        fmt: str = "json",
        output_dir: Optional[str] = None,
    ) -> Dict[str, Any]:
        """服务端重新计算复盘后导出；样本不足时保留降级说明。"""
        result = self.session_insights(target_id)
        error = self._analysis_result_error(result, "复盘报告生成失败")
        if error:
            return error
        target = result.get("target") if isinstance(result.get("target"), dict) else {}
        if not target:
            return {
                "ok": False,
                "available": True,
                "error_code": "no_data",
                "error": "复盘报告缺少目标场次",
            }
        report = build_insights_report(result, int(time.time()))
        return self._write_analysis_report(
            report,
            fmt,
            slug=str(target.get("room_title") or target.get("room_key") or "insights"),
            output_dir=output_dir,
        )

    def delete_session(self, session_id: str) -> Dict[str, Any]:
        if not self.available:
            return {"ok": False, "error": self.error or "场次存储不可用"}
        try:
            with closing(self._connect()) as conn:
                with conn:
                    row = conn.execute(
                        "SELECT ended_at FROM sessions WHERE id = ?",
                        (str(session_id),),
                    ).fetchone()
                    if row is None:
                        return {"ok": False, "error": "场次不存在", "reason": "not_found"}
                    if row["ended_at"] is None:
                        return {"ok": False, "error": "不能删除正在记录的场次", "reason": "active"}
                    result = conn.execute(
                        "DELETE FROM sessions WHERE id = ? AND ended_at IS NOT NULL",
                        (str(session_id),),
                    )
                    if result.rowcount != 1:
                        return {"ok": False, "error": "场次状态已变化，请刷新后重试", "reason": "changed"}
                try:
                    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                except Exception:  # noqa: BLE001
                    logger.debug("删除场次后 WAL checkpoint 未完成", exc_info=True)
            return {"ok": True, "deleted": 1}
        except Exception as exc:  # noqa: BLE001
            logger.exception("删除历史场次失败：%s", session_id)
            return {"ok": False, "error": str(exc)}
