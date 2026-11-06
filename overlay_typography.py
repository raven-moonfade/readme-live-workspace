# -*- coding: utf-8 -*-
"""Typography resolution and rich-text measurement for the overlay."""

from __future__ import annotations

import logging
import re
import sys
from typing import Any

from PySide6.QtCore import QPointF
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontDatabase,
    QFontMetricsF,
    QPainterPath,
)

from overlay_types import _TextCluster, _VisualLine, _VisualSegment

try:
    from backend.typography import (
        OVERLAY_TYPES,
        TYPOGRAPHY_FIELDS,
        TypographyResolver,
        theme_typography,
    )
except Exception:  # pragma: no cover - only for minimal runtime environments
    OVERLAY_TYPES = ("danmaku", "gift", "super_chat", "guard", "enter")
    TYPOGRAPHY_FIELDS = ("font_family", "line_height", "letter_spacing")
    TypographyResolver = None  # type: ignore[assignment]
    theme_typography = None  # type: ignore[assignment]


LOG = logging.getLogger("overlay_qt")

_CJK_RE = re.compile(
    r"[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf"
    r"\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]"
)
CJK_NO_LINE_START = frozenset("，。？！、；：）】》」』")
CJK_NO_LINE_END = frozenset("（【《「『")

_FONT_FAMILIES: set[str] | None = None
_FONT_LOGGED_MISSING: set[str] = set()


def _font_families() -> set[str]:
    global _FONT_FAMILIES
    if _FONT_FAMILIES is None:
        try:
            _FONT_FAMILIES = set(QFontDatabase.families())
        except Exception:
            _FONT_FAMILIES = set()
    return _FONT_FAMILIES


def _fallback_typography(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if TypographyResolver is not None:
        try:
            return TypographyResolver(source).resolve_all()
        except Exception:
            LOG.debug("排版解析失败，退回本地默认", exc_info=True)
    theme = str(source.get("theme") or "classic")
    base = (
        theme_typography(theme)
        if theme_typography is not None
        else {"font_family": "Microsoft YaHei UI", "line_height": 1.55, "letter_spacing": 0.0}
    )
    return {kind: dict(base) for kind in OVERLAY_TYPES}


def _normalize_typographies(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    resolved = source.get("resolved_typography")
    if isinstance(resolved, dict) and any(isinstance(resolved.get(kind), dict) for kind in OVERLAY_TYPES):
        fallback = _fallback_typography(source)
        result: dict[str, dict[str, Any]] = {}
        for kind in OVERLAY_TYPES:
            spec = dict(fallback.get(kind) or {})
            raw = resolved.get(kind) or {}
            for name in TYPOGRAPHY_FIELDS:
                if raw.get(name) is not None:
                    spec[name] = raw[name]
            result[kind] = spec
        return result
    return _fallback_typography(source)


def _typography_fingerprint(typography: dict[str, Any]) -> str:
    return repr(tuple((key, typography.get(key)) for key in TYPOGRAPHY_FIELDS))


class _FontResolver:
    def __init__(self, family: str):
        requested = (family or "").split(",")[0].strip().strip('"').strip("'")
        available = _font_families()
        matched = ""
        if requested:
            if requested in available:
                matched = requested
            else:
                lowered = requested.casefold()
                matched = next((name for name in available if name.casefold() == lowered), "")
        if requested and available and not matched and requested not in _FONT_LOGGED_MISSING:
            _FONT_LOGGED_MISSING.add(requested)
            LOG.warning("字体不可用，使用 fallback：%s", requested)
        self.family = matched or "Microsoft YaHei UI"
        if sys.platform == "win32":
            fallbacks = ["Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "Segoe UI Emoji"]
        elif sys.platform == "darwin":
            fallbacks = ["PingFang SC", "Helvetica Neue", "Apple Color Emoji"]
        else:
            fallbacks = ["Noto Sans CJK SC", "Noto Sans", "DejaVu Sans", "Noto Color Emoji"]
        self.fallbacks = [name for name in fallbacks if name in available or not available]
        self._cache: dict[tuple[int, int, float], QFont] = {}

    def get(self, pixel_size: int, weight: int, letter_spacing: float = 0.0) -> QFont:
        spacing = round(float(letter_spacing or 0.0) * 4.0) / 4.0
        key = (int(pixel_size), int(weight), spacing)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        font = QFont()
        families = []
        for family in [self.family] + self.fallbacks:
            if family and family not in families:
                families.append(family)
        try:
            font.setFamilies(families)
        except Exception:
            font.setFamily(self.family)
        font.setPixelSize(max(1, int(pixel_size)))
        try:
            font.setWeight(QFont.Weight(int(weight)))
        except Exception:
            font.setWeight(QFont.Weight.Normal)
        if spacing:
            try:
                font.setLetterSpacing(QFont.SpacingType.AbsoluteSpacing, spacing)
            except Exception:
                pass
        font.setStyleStrategy(QFont.StyleStrategy.PreferAntialias)
        if len(self._cache) >= 64:
            self._cache.clear()
        self._cache[key] = font
        return font


class _RichTextBuilder:
    def __init__(self, family_resolver: _FontResolver):
        self.fonts = family_resolver

    def _tokenize(self, text: str) -> list[str]:
        if not text:
            return []
        tokens: list[str] = []
        index = 0
        length = len(text)
        while index < length:
            char = text[index]
            if char.isspace():
                end = index + 1
                while end < length and text[end].isspace():
                    end += 1
                tokens.append(text[index:end])
                index = end
                continue
            if _CJK_RE.match(char):
                tokens.append(char)
                index += 1
                continue
            end = index + 1
            while end < length:
                nxt = text[end]
                if nxt.isspace() or _CJK_RE.match(nxt):
                    break
                end += 1
            run = text[index:end]
            tokens.append(run)
            index = end
        return tokens

    def build_clusters(
        self,
        runs: list[tuple[str, QFont, QColor]],
        max_width: float,
    ) -> list[_TextCluster]:
        clusters: list[_TextCluster] = []
        for text, font, color in runs:
            metrics = QFontMetricsF(font)
            for token in self._tokenize(text):
                width = float(metrics.horizontalAdvance(token))
                if width <= max_width or len(token) <= 1:
                    clusters.append(_TextCluster(token, font, color, width))
                    continue
                for char in token:
                    clusters.append(
                        _TextCluster(char, font, color, float(metrics.horizontalAdvance(char)))
                    )
        return self._merge_kinsoku(clusters)

    @staticmethod
    def _merge_kinsoku(clusters: list[_TextCluster]) -> list[_TextCluster]:
        """简单 CJK 避头尾：把禁则标点粘在相邻字符上，保持为不可拆簇。"""
        merged: list[_TextCluster] = []
        index = 0
        while index < len(clusters):
            cluster = clusters[index]
            text = cluster.text
            if text and text[0] in CJK_NO_LINE_START and merged:
                previous = merged.pop()
                merged.append(
                    _TextCluster(
                        previous.text + text,
                        previous.font,
                        previous.color,
                        previous.width + cluster.width,
                    )
                )
                index += 1
                continue
            if text and text[-1] in CJK_NO_LINE_END and index + 1 < len(clusters):
                following = clusters[index + 1]
                merged.append(
                    _TextCluster(
                        text + following.text,
                        cluster.font,
                        cluster.color,
                        cluster.width + following.width,
                    )
                )
                index += 2
                continue
            merged.append(cluster)
            index += 1
        return merged

    def _layout_lines(
        self,
        clusters: list[_TextCluster],
        max_width: float,
        max_lines: int,
    ) -> tuple[list[list[_TextCluster]], bool]:
        lines: list[list[_TextCluster]] = []
        current: list[_TextCluster] = []
        width = 0.0
        index = 0
        overflow = False
        while index < len(clusters):
            cluster = clusters[index]
            if not current and cluster.text.isspace():
                index += 1
                continue
            if current and width + cluster.width > max_width + 0.25:
                lines.append(current)
                current = []
                width = 0.0
                if len(lines) >= max_lines:
                    overflow = True
                    break
                if cluster.text.isspace():
                    index += 1
                continue
            current.append(cluster)
            width += cluster.width
            index += 1
        if not overflow and current:
            lines.append(current)
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            overflow = True
        if overflow:
            if not lines:
                lines = [[]]
            last = lines[-1]
            ellipsis_font = last[-1].font if last else self.fonts.get(16, 600)
            ellipsis_color = last[-1].color if last else QColor("#ffffff")
            ellipsis_width = float(QFontMetricsF(ellipsis_font).horizontalAdvance("…"))
            while last and sum(item.width for item in last) + ellipsis_width > max_width:
                last.pop()
            last.append(_TextCluster("…", ellipsis_font, ellipsis_color, ellipsis_width))
        return lines, overflow

    def build_visual_lines(
        self,
        runs: list[tuple[str, QFont, QColor]],
        max_width: float,
        max_lines: int,
        text_top: float,
        text_left: float,
        line_height: float,
        body_font: QFont,
        letter_spacing: float = 0.0,
    ) -> tuple[list[_VisualLine], list[list[_TextCluster]]]:
        clusters = self.build_clusters(runs, max_width)
        cluster_lines, _ = self._layout_lines(clusters, max_width, max_lines)
        metrics = QFontMetricsF(body_font)
        visual_lines: list[_VisualLine] = []
        for line_index, line_clusters in enumerate(cluster_lines):
            baseline = text_top + line_index * line_height
            baseline += max(0.0, (line_height - metrics.height()) * 0.5) + metrics.ascent()
            x = text_left
            segments: list[_VisualSegment] = []
            shadow_segments: list[_VisualSegment] = []

            grouped: list[tuple[str, QFont, QColor, float]] = []
            for cluster in line_clusters:
                if (
                    grouped
                    and grouped[-1][1] is cluster.font
                    and grouped[-1][2].rgba() == cluster.color.rgba()
                ):
                    prev_text, prev_font, prev_color, prev_width = grouped[-1]
                    grouped[-1] = (prev_text + cluster.text, prev_font, prev_color, prev_width + cluster.width)
                else:
                    grouped.append((cluster.text, cluster.font, cluster.color, cluster.width))

            for text, font, color, segment_width in grouped:
                if not text:
                    continue
                path = QPainterPath()
                path.addText(QPointF(x, baseline), font, text)
                fallback = "" if not path.isEmpty() else text
                segment = _VisualSegment(
                    path=path,
                    color=color,
                    fallback_text=fallback,
                    fallback_font=font,
                    fallback_x=x,
                    fallback_baseline=baseline,
                )
                segments.append(segment)
                shadow_segments.append(segment)
                x += segment_width
            visual_lines.append(
                _VisualLine(
                    baseline=baseline,
                    width=max(
                        0.0,
                        sum(item.width for item in line_clusters)
                        - (float(letter_spacing) if line_clusters else 0.0),
                    ),
                    segments=segments,
                    shadow_segments=shadow_segments,
                )
            )
        return visual_lines, cluster_lines
