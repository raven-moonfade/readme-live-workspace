# -*- coding: utf-8 -*-
"""浮窗动画帧率保护。

只根据浮窗自身的帧间隔/绘制耗时调整动画定时器，不触碰 TTS、朗读队列或
消息 journal。高密度消息降级仍由 ``backend.density.DensityMeter`` 负责。
"""

from __future__ import annotations

import math


BASE_INTERVAL_MS = 16
MID_INTERVAL_MS = 33
LOW_INTERVAL_MS = 50
SLOW_FRAME_MS = 38.0
SLOW_PAINT_MS = 28.0
MID_STREAK = 3
LOW_STREAK = 8
RECOVER_SECONDS = 2.0


class FrameBudget:
    """带滞回的动画帧率状态机；输出定时器间隔（毫秒）。"""

    def __init__(self) -> None:
        self.reset()

    @property
    def interval_ms(self) -> int:
        return self._interval_ms

    @property
    def reduced(self) -> bool:
        return self._interval_ms > BASE_INTERVAL_MS

    def reset(self) -> None:
        self._interval_ms = BASE_INTERVAL_MS
        self._slow_streak = 0
        self._fast_since: float | None = None

    def observe(self, frame_ms: float, paint_ms: float | None, now: float) -> int:
        """记录一帧，返回下一帧建议间隔。非法数值按正常帧处理。"""
        try:
            frame = float(frame_ms)
        except (TypeError, ValueError):
            frame = 0.0
        try:
            paint = float(paint_ms) if paint_ms is not None else 0.0
        except (TypeError, ValueError):
            paint = 0.0
        if not math.isfinite(frame) or frame < 0:
            frame = 0.0
        if not math.isfinite(paint) or paint < 0:
            paint = 0.0

        # 降档后的定时器本身就会拉长帧间隔；阈值必须高于当前档位的正常
        # 间隔，否则 50ms 档永远会被自己判成慢帧，无法恢复。
        frame_slow_ms = max(float(SLOW_FRAME_MS), self._interval_ms * 1.5)
        slow = frame >= frame_slow_ms or paint >= SLOW_PAINT_MS
        if slow:
            self._slow_streak += 1
            self._fast_since = None
        else:
            self._slow_streak = 0
            if self._interval_ms > BASE_INTERVAL_MS:
                if self._fast_since is None:
                    self._fast_since = float(now)
                elif float(now) - self._fast_since >= RECOVER_SECONDS:
                    self._interval_ms = (
                        MID_INTERVAL_MS
                        if self._interval_ms >= LOW_INTERVAL_MS
                        else BASE_INTERVAL_MS
                    )
                    self._fast_since = None

        if self._slow_streak >= LOW_STREAK:
            self._interval_ms = LOW_INTERVAL_MS
        elif self._slow_streak >= MID_STREAK:
            self._interval_ms = max(self._interval_ms, MID_INTERVAL_MS)
        return self._interval_ms
