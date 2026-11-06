# -*- coding: utf-8 -*-
"""滚动区到达率与高密度保护状态机。

纯内存、无 Qt 依赖；只统计最终进入滚动流的消息。固定区、被类型关闭
的消息和固定失败 drop 的消息不参与。
"""

from __future__ import annotations

from collections import deque
from typing import Deque


class DensityMeter:
    """带滞回的高密度检测器。

    默认值按 250ms 轮询与 30 条/秒压力设计：
    - 24 条/秒持续 1 秒进入保护；
    - 进入后至少保持 4 秒；
    - 低于 8 条/秒持续 3 秒恢复；
    - 单批达到 max_lines（默认 8）时立即进入保护。
    """

    def __init__(
        self,
        high_rate: float = 24.0,
        low_rate: float = 8.0,
        enter_hold_s: float = 1.0,
        min_hold_s: float = 4.0,
        recover_s: float = 3.0,
        window_s: float = 1.0,
        emergency_batch: int = 8,
    ) -> None:
        self.high_rate = float(high_rate)
        self.low_rate = float(low_rate)
        self.enter_hold_s = float(enter_hold_s)
        self.min_hold_s = float(min_hold_s)
        self.recover_s = float(recover_s)
        self.window_s = float(window_s)
        self.emergency_batch = max(1, int(emergency_batch))
        self._arrivals: Deque[float] = deque()
        self._last_add = -1.0
        self._dense = False
        self._high_since = 0.0
        self._low_since = 0.0
        self._hold_until = 0.0
        self._rate = 0.0

    @property
    def dense(self) -> bool:
        return self._dense

    @property
    def rate(self) -> float:
        return self._rate

    def add(self, now: float) -> None:
        now = float(now)
        if self._last_add >= 0.0 and now - self._last_add > 5.0:
            self.reset()
        self._arrivals.append(now)
        self._last_add = now
        self._prune(now)

    def reset(self) -> None:
        self._arrivals.clear()
        self._last_add = -1.0
        self._dense = False
        self._high_since = 0.0
        self._low_since = 0.0
        self._hold_until = 0.0
        self._rate = 0.0

    def update(self, now: float, batch_count: int = 0) -> bool:
        """更新状态；返回是否发生模式切换。"""
        now = float(now)
        if self._dense and self._last_add >= 0.0 and now - self._last_add > 5.0:
            self.reset()
            return True
        self._prune(now)
        self._rate = float(len(self._arrivals)) / max(0.001, self.window_s)
        batch = max(0, int(batch_count))

        if not self._dense:
            if batch >= self.emergency_batch or self._rate >= self.high_rate:
                if self._high_since <= 0.0:
                    self._high_since = now
                if batch >= self.emergency_batch or now - self._high_since >= self.enter_hold_s:
                    self._dense = True
                    self._hold_until = now + self.min_hold_s
                    self._low_since = 0.0
                    return True
            else:
                self._high_since = 0.0
            return False

        if now < self._hold_until:
            return False
        if self._rate <= self.low_rate:
            if self._low_since <= 0.0:
                self._low_since = now
            if now - self._low_since >= self.recover_s:
                self._dense = False
                self._high_since = 0.0
                self._low_since = 0.0
                self._hold_until = 0.0
                return True
        else:
            self._low_since = 0.0
        return False

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_s
        while self._arrivals and self._arrivals[0] <= cutoff:
            self._arrivals.popleft()

