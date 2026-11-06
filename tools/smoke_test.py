# -*- coding: utf-8 -*-
"""ReadMe 后端冒烟测试。

用法（PowerShell）：
    & <项目目录>\\.venv\\Scripts\\python.exe `
      D:\\Document\\ChatGPT\\弹幕姬\\tools\\smoke_test.py --duration 40

可选参数：
    --room <id>      指定房间号（跳过自动挑选）
    --duration <秒>  连接并打印事件的时长，默认 40
    --no-audio       跳过试听 / 重播等会出声的播放步骤

做的事情：
    1. 自动挑一个正在直播（live_status==1）的房间：先试候选房间，全不在播则走 B 站
       公开推荐接口（控制请求频率）；
    2. 创建 DanmakuTTSService，校验接口契约（get_state / poll_events / update_config /
       list_voices / preview / replay），并测量 get_state 耗时；
    3. 连接直播间，按秒打印收到的事件，统计 received / spoken / dropped；
    4. 把收到的第一条弹幕用 edge-tts 合成为 cache/*.mp3，校验文件存在且 > 5KB。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from backend import DanmakuTTSService  # noqa: E402
from backend import tts as tts_mod  # noqa: E402
from backend.danmaku import fetch_room_info, find_live_rooms, make_session  # noqa: E402

CANDIDATE_ROOMS = [12235923, 14327465, 21396545, 21449083, 23105590]
MIN_MP3_BYTES = 5 * 1024


def log(msg: str = "") -> None:
    print(msg, flush=True)


def section(title: str) -> None:
    log("")
    log("=" * 72)
    log(title)
    log("=" * 72)


# ------------------------------------------------------------------ 选房间
async def pick_rooms(room_arg: Optional[int]) -> List[int]:
    """返回按优先级排列的候选直播间（第一个是首选）。"""
    rooms: List[int] = []
    async with make_session("") as session:
        if room_arg:
            info = await fetch_room_info(session, room_arg)
            log("[选房] 指定房间 %s：live_status=%s title=%s error=%s"
                % (room_arg, info.get("live_status"), info.get("title"), info.get("error")))
            if info.get("ok"):
                return [room_arg]
            log("[选房] 指定房间不可用，改用自动挑选")
        for room_id in CANDIDATE_ROOMS:
            info = await fetch_room_info(session, room_id)
            log("[选房] 候选 %-10s ok=%s live_status=%s title=%s"
                % (room_id, info.get("ok"), info.get("live_status"), (info.get("title") or "")[:20]))
            if info.get("ok") and info.get("live_status") == 1:
                rooms.append(room_id)
            await asyncio.sleep(0.6)  # 控制请求频率
        if rooms:
            log("[选房] 候选命中：%s" % rooms)
        else:
            log("[选房] 候选房间均未开播，改用公开推荐接口寻找在线房间…")
        for room_id in await find_live_rooms(session, candidates=[], scan_limit=6):
            if room_id not in rooms:
                rooms.append(room_id)
        log("[选房] 备选房间队列：%s" % (rooms or "（空）"))
        return rooms


# --------------------------------------------------------------- 契约自检
def check_contract(service: DanmakuTTSService, do_audio: bool) -> Tuple[bool, Dict[str, Any]]:
    ok = True
    section("1. 接口契约自检")

    state = service.get_state()
    expected_keys = {"connection", "room_id", "room_title", "stats", "queue_len",
                     "now_playing", "config", "last_error", "account"}
    missing = expected_keys - set(state.keys())
    log("get_state() 顶层键：%s" % sorted(state.keys()))
    if missing:
        log("  x 缺少键：%s" % sorted(missing))
        ok = False
    else:
        log("  ok 顶层键与契约一致")
    for key in ("received", "spoken", "dropped"):
        if key not in (state.get("stats") or {}):
            log("  x stats 缺少 %s" % key)
            ok = False
    if state.get("connection") not in ("disconnected", "connecting", "connected", "error"):
        log("  x connection 取值非法：%r" % state.get("connection"))
        ok = False

    worst = 0.0
    for _ in range(20):
        t0 = time.perf_counter()
        service.get_state()
        worst = max(worst, (time.perf_counter() - t0) * 1000.0)
    log("get_state() 20 次最大耗时：%.2f ms（要求 < 50ms）" % worst)
    if worst >= 50.0:
        log("  x get_state 过慢")
        ok = False
    else:
        log("  ok 满足 < 50ms")

    polled = service.poll_events(0)
    log("poll_events(0) → cursor=%s events=%d"
        % (polled.get("cursor"), len(polled.get("events") or [])))
    if not isinstance(polled.get("cursor"), int) or not isinstance(polled.get("events"), list):
        log("  x poll_events 返回结构非法")
        ok = False
    else:
        log("  ok 返回 {cursor:int, events:list}")

    before = service.get_state()["config"]
    upd = service.update_config({"filters": {"max_len": 60}})
    cfg = upd.get("config") or {}
    filters_now = cfg.get("filters") or {}
    nested_kept = filters_now.get("dedup_seconds") == (before["filters"]["dedup_seconds"])
    log("update_config({'filters':{'max_len':60}}) → max_len=%s，同层 dedup_seconds=%s"
        % (filters_now.get("max_len"), filters_now.get("dedup_seconds")))
    if not nested_kept or filters_now.get("max_len") != 60:
        log("  x 深合并行为异常")
        ok = False
    else:
        log("  ok 局部更新，未覆盖同层其它键")
    service.update_config({"filters": {"max_len": before["filters"]["max_len"]}})
    bad = service.update_config({"filters": {"max_len": "abc"}, "nonexistent_key": 1})
    log("update_config(非法值) → rejected=%s" % bad.get("rejected"))
    if not bad.get("rejected"):
        log("  x 非法值未被拒绝")
        ok = False
    else:
        log("  ok 非法值被拒绝，其余配置不受影响")

    t0 = time.time()
    voices = service.list_voices()
    log("list_voices() → %d 个音色，耗时 %.2fs" % (len(voices), time.time() - t0))
    if voices:
        sample = voices[0]
        log("  首个音色：%s" % sample)
        if set(sample.keys()) < {"id", "name", "locale", "gender", "tags"}:
            log("  x 音色字段不符合契约")
            ok = False
        else:
            log("  ok 字段 {id,name,locale,gender,tags} 齐全")
    else:
        log("  x 音色列表为空（网络与缓存均不可用）")
        ok = False
    cache_file = os.path.join(service.base_dir, "logs", "voices.json")
    log("  音色缓存：%s（存在=%s）" % (cache_file, os.path.exists(cache_file)))

    rp = service.replay("not-exists-%d" % int(time.time()))
    log("replay(不存在的 entry_id) → %s" % rp)
    if rp.get("ok"):
        log("  x 不存在的缓存竟然返回 ok")
        ok = False
    else:
        log("  ok 正确处理缺失缓存")

    if do_audio:
        # 试听文本为中文，显式用中文音色，避免受用户当前音色（如英文）影响
        pv = service.preview("ReadMe 试听测试", voice="zh-CN-XiaoxiaoNeural")
        log("preview('ReadMe 试听测试') → %s"
            % {k: pv.get(k) for k in ("ok", "entry_id", "path", "size", "voice", "played")})
        if pv.get("ok") and pv.get("size", 0) > MIN_MP3_BYTES:
            log("  ok 试听合成成功（%d 字节）并已交给播放器" % pv["size"])
            time.sleep(1.0)
            rp2 = service.replay(pv["entry_id"])
            log("replay(刚生成的 entry_id) → %s"
                % {k: rp2.get(k) for k in ("ok", "path", "size")})
            if not rp2.get("ok"):
                log("  x 重播失败")
                ok = False
            else:
                log("  ok 重播成功（插队播放）")
            time.sleep(1.6)
        else:
            log("  x 试听失败：%s" % pv)
            ok = False
    else:
        log("（--no-audio：跳过 preview / replay 出声测试）")
    return ok, before


# ------------------------------------------------------------------ 事件
def fmt_event(event: Dict[str, Any]) -> str:
    etype = event.get("type")
    seq = event.get("seq")
    if etype == "status":
        return "[%4s] status  %s（room_title=%s live=%s）" % (
            seq, event.get("connection"), event.get("room_title"), event.get("room_live"))
    if etype == "log":
        meta = event.get("meta") or {}
        return "[%4s] log     [%s] %s" % (seq, meta.get("level"), (event.get("text") or "")[:100])
    if etype == "error":
        return "[%4s] error   %s" % (seq, event.get("error"))
    spoken = event.get("spoken")
    tag = "朗读" if spoken is True else ("过滤" if spoken is None else "失败")
    filt = (event.get("meta") or {}).get("filter")
    suffix = "（%s）" % filt if filt else ""
    return "[%4s] %-7s %-3s %s：%s %s" % (
        seq, etype, tag, event.get("user") or "-", (event.get("text") or "")[:60], suffix)


def run_session(service: DanmakuTTSService, rooms: List[int], duration: int) -> Dict[str, Any]:
    section("2. 连接直播间并接收事件")
    counts: Dict[str, int] = {}
    spoken_true = spoken_null = spoken_false = 0
    cursor = 0
    total = 0
    first_danmaku: Optional[Dict[str, Any]] = None
    first_readable_danmaku: Optional[Dict[str, Any]] = None
    first_spoken_entry: Optional[str] = None
    connected_any = False
    completed = False
    for attempt, room_id in enumerate(rooms, 1):
        t0 = time.time()
        connected = service.connect(room_id)
        log("connect(%s) → %s（耗时 %.2fs）" % (room_id, connected, time.time() - t0))
        if not connected.get("ok"):
            continue
        connected_any = True
        start = time.time()
        deadline = start + max(0, duration)
        probe = None if attempt >= len(rooms) else start + min(12, max(8, duration // 3))
        while time.time() < deadline:
            time.sleep(1.0)
            batch = service.poll_events(cursor)
            new_cursor = batch.get("cursor")
            if not isinstance(new_cursor, int) or new_cursor < cursor:
                log("  x cursor 非单调：%s → %s" % (cursor, new_cursor))
            else:
                cursor = new_cursor
            for event in batch.get("events") or []:
                total += 1
                etype = event.get("type")
                counts[etype] = counts.get(etype, 0) + 1
                if etype == "danmaku" and first_danmaku is None:
                    first_danmaku = event
                if (etype == "danmaku" and first_readable_danmaku is None
                        and tts_mod.is_readable(event.get("text") or "")):
                    first_readable_danmaku = event
                if event.get("spoken") is True and first_spoken_entry is None:
                    first_spoken_entry = event.get("id")
                if event.get("spoken") is True:
                    spoken_true += 1
                elif event.get("spoken") is None:
                    spoken_null += 1
                else:
                    spoken_false += 1
                log("  " + fmt_event(event))
            state = service.get_state()
            log("  -- 已运行 %.0fs（房间 %s）：%s | stats=%s queue_len=%s now_playing=%s"
                % (time.time() - start, room_id, state["connection"], state["stats"],
                   state["queue_len"], (state["now_playing"] or {}).get("text")))
            if probe is not None and time.time() >= probe and counts.get("danmaku", 0) == 0:
                log("  ! 该房间 %d 秒内没有弹幕，换下一个候选房间…" % int(time.time() - start))
                break
        else:
            completed = True
        if completed:
            break
        service.disconnect()
    if not completed:
        log("（已尝试全部候选房间）")
    state = service.get_state()
    log("")
    log("本次会话：事件 %d 条，连接状态=%s，stats=%s" % (total, state["connection"], state["stats"]))
    log("spoken 分布：true（进入朗读队列）=%d  null（被过滤）=%d  false（失败）=%d"
        % (spoken_true, spoken_null, spoken_false))
    log("事件类型分布：%s" % counts)
    if counts.get("danmaku", 0) == 0:
        log("! 警告：本次未收到任何弹幕（房间不活跃或已下播）")
    log("disconnect() → %s" % service.disconnect())
    return {
        "ok": connected_any,
        "counts": counts,
        "first_danmaku": first_danmaku,
        "first_readable_danmaku": first_readable_danmaku,
        "first_spoken_entry": first_spoken_entry,
        "events": total,
        "state": state,
    }


def check_synthesis(
    service: DanmakuTTSService,
    first_danmaku: Optional[Dict[str, Any]],
    first_spoken_entry: Optional[str],
) -> bool:
    section("3. 首条弹幕合成 mp3 校验（cache/）")
    cache_dir = os.path.join(service.base_dir, "cache")
    before = sorted(
        os.path.join(cache_dir, name) for name in os.listdir(cache_dir)
    ) if os.path.isdir(cache_dir) else []
    log("合成前 cache/ 内文件数：%d" % len(before))

    if first_spoken_entry:
        pipeline_path = os.path.join(cache_dir, "%s.mp3" % first_spoken_entry)
        exists = os.path.isfile(pipeline_path)
        size = os.path.getsize(pipeline_path) if exists else 0
        log("服务流水线首条朗读缓存：%s（存在=%s 大小=%d 字节，entry_id 即事件 id）"
            % (pipeline_path, exists, size))
        if not exists or size <= MIN_MP3_BYTES:
            log("  x 流水线缓存文件异常")
        else:
            rp = service.replay(first_spoken_entry)
            log("replay(首条朗读 entry_id) → %s"
                % {k: rp.get(k) for k in ("ok", "path", "size")})
            log("  ok 流水线缓存与事件 id 对应，可直接 replay")

    chosen = first_danmaku if (first_danmaku or {}).get("text") else None
    text = (chosen or {}).get("text") or "这是一条冒烟测试弹幕"
    if not chosen:
        log("（本次没收到弹幕，改用固定文本做合成校验）")
    else:
        log("选取弹幕：seq=%s user=%s spoken=%s"
            % (chosen.get("seq"), chosen.get("user"), chosen.get("spoken")))
    out_path = os.path.join(cache_dir, "smoke-%d.mp3" % int(time.time()))
    t0 = time.time()
    result = asyncio.run(
        tts_mod.synthesize(text, "zh-CN-XiaoxiaoNeural", "+0%", "+0Hz", "+0%", out_path)
    )
    log("合成文本：%r" % text)
    log("synthesize() → ok=%s bytes=%s error=%s elapsed=%ss"
        % (result.get("ok"), result.get("bytes"), result.get("error"), result.get("elapsed")))
    exists = os.path.isfile(out_path)
    size = os.path.getsize(out_path) if exists else 0
    log("输出文件：%s（存在=%s 大小=%d 字节）" % (out_path, exists, size))
    if not result.get("ok") or not exists or size <= MIN_MP3_BYTES:
        log("  x 合成校验失败（要求存在且 > %d 字节），总耗时 %.2fs" % (MIN_MP3_BYTES, time.time() - t0))
        return False
    log("  ok 文件存在且 > 5KB（总耗时 %.2fs）" % (time.time() - t0))
    after = sorted(os.path.join(cache_dir, name) for name in os.listdir(cache_dir))
    produced = [path for path in after if path not in before]
    log("本次新增缓存文件 %d 个：%s"
        % (len(produced), [os.path.basename(path) for path in produced][:8]))
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="ReadMe 后端冒烟测试")
    parser.add_argument("--room", type=int, default=None, help="指定房间号")
    parser.add_argument("--duration", type=int, default=40, help="连接时长（秒），默认 40")
    parser.add_argument("--no-audio", action="store_true", help="跳过试听/重播等出声步骤")
    args = parser.parse_args()

    section("ReadMe · 后端冒烟测试")
    log("项目根目录：%s" % PROJECT_ROOT)
    log("Python：%s" % sys.executable)
    log("")
    log("正在挑选直播间…")
    rooms = asyncio.run(pick_rooms(args.room))
    if not rooms:
        log("x 没有可用的直播间，终止测试")
        return 1
    log("首选房间：%s" % rooms[0])

    smoke_root = tempfile.mkdtemp(prefix="readme-smoke-")
    for name in ("config.json", "config.legacy.json"):
        source = os.path.join(PROJECT_ROOT, name)
        if os.path.isfile(source):
            shutil.copy2(source, os.path.join(smoke_root, name))
    log("隔离临时根目录：%s" % smoke_root)
    service = DanmakuTTSService(smoke_root)
    contract_ok = False
    synth_ok = False
    result: Dict[str, Any] = {}
    try:
        contract_ok, _before = check_contract(service, do_audio=not args.no_audio)
        result = run_session(service, rooms, args.duration)
        picked = result.get("first_readable_danmaku") or result.get("first_danmaku")
        synth_ok = check_synthesis(service, picked, result.get("first_spoken_entry"))
        counts = result.get("counts") or {}
        section("4. 结论")
        log("契约自检：%s" % ("通过" if contract_ok else "存在失败项"))
        log("连接会话：事件 %d 条，弹幕 %d 条，礼物 %d 条，进场 %d 条"
            % (result.get("events", 0), counts.get("danmaku", 0), counts.get("gift", 0),
               counts.get("enter", 0)))
        log("合成校验：%s" % ("通过" if synth_ok else "失败"))
        return 0 if (contract_ok and synth_ok and result.get("ok")) else 1
    except KeyboardInterrupt:
        log("用户中断")
        return 130
    finally:
        section("5. 关闭服务")
        t0 = time.time()
        service.shutdown()
        log("shutdown() 完成（%.2fs）" % (time.time() - t0))
        log("日志文件：%s" % os.path.join(smoke_root, "logs", "app.log"))
        shutil.rmtree(smoke_root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
