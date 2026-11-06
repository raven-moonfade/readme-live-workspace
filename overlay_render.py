# -*- coding: utf-8 -*-
"""Snapshot-driven rendering contract and pure badge helpers."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontMetricsF,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
)

from overlay_types import _BadgeVisual, _BubbleVisual, _Message
from overlay_typography import _FontResolver, _RichTextBuilder
from overlay_util import (
    LANE_LABELS,
    TYPE_COLORS,
    TYPE_NAMES,
    avatar_colors,
    clip_codepoints,
    first_glyph,
    format_price,
    guard_title,
    parse_badge_bg,
    positive_int,
    qcolor,
    readable_on_dark,
    str_value,
    with_alpha,
)


@dataclass(frozen=True)
class KindRender:
    style: Mapping[str, Any]
    typography: Mapping[str, Any]
    style_fp: str
    typography_fp: str
    resolver: _FontResolver
    rich: _RichTextBuilder


@dataclass(frozen=True)
class RenderContext:
    width: float
    dpr: float
    theme: str
    align: str
    show_avatar: bool
    show_name: bool
    name_sep: str
    name_max_len: int
    text_max_len: int
    global_font_size: float
    global_font_weight: int
    kinds: Mapping[str, KindRender]
    default_resolver: _FontResolver


def header_badges(
    message: _Message,
    theme: str,
    style: Mapping[str, Any],
) -> list[tuple[str, str, str]]:
    """Return (text, background, foreground) compact type badges."""
    if message.pinned:
        return []
    accent = str(style.get("badge_color") or TYPE_COLORS.get(message.kind, "#4aa8ff"))
    text_color = str(style.get("text_color") or "#ffffff")
    if message.kind == "danmaku":
        return []
    if theme == "highcontrast":
        bg = "#ffdf4d"
        fg = "#000000"
    elif theme == "minimal":
        bg = "rgba(255,255,255,0.08)"
        fg = text_color
    elif theme == "shortvideo":
        bg = "rgba(0,0,0,0.46)"
        fg = readable_on_dark(accent)
    else:
        bg = "rgba(8,12,19,0.58)"
        fg = readable_on_dark(accent)

    result: list[tuple[str, str, str]] = []
    if message.kind == "gift":
        result.append(("礼物", bg, fg))
    elif message.kind == "super_chat":
        result.append(("醒目留言", bg, fg))
        price = format_price(message.meta.get("price"))
        result.append(
            (
                "¥ " + price,
                "rgba(255,111,145,0.30)" if theme != "highcontrast" else "#ffdf4d",
                readable_on_dark(accent) if theme != "highcontrast" else "#000000",
            )
        )
    elif message.kind == "guard":
        title = guard_title(message.meta)
        result.append(
            (
                "舰",
                "rgba(255,224,138,0.30)" if theme != "highcontrast" else "#ffdf4d",
                readable_on_dark(accent) if theme != "highcontrast" else "#000000",
            )
        )
        if title not in message.text:
            result.append((title, bg, fg))
    elif message.kind == "enter":
        if "进入" not in message.text:
            result.append(("进入", bg, fg))
    elif message.kind == "like":
        if "点赞" not in message.text:
            result.append(("点赞", bg, fg))
    elif message.kind == "social":
        action = str(message.meta.get("social_action") or "关注")
        label = "分享" if "分享" in action else "关注"
        if label not in message.text:
            result.append((label, bg, fg))
    elif message.kind == "fansclub":
        action = str(message.meta.get("fansclub_action") or "粉丝团")
        label = "升级" if "升级" in action else "粉丝团"
        if label not in message.text:
            result.append((label, bg, fg))
    return result


def visual_key(context: RenderContext, message: _Message) -> str:
    kind = context.kinds.get(message.kind) or context.kinds.get("danmaku")
    style_fp = kind.style_fp if kind else None
    typography_fp = kind.typography_fp if kind else None
    family = kind.resolver.family if kind else ""
    relevant = (
        int(context.width),
        context.global_font_size,
        context.global_font_weight,
        context.name_sep,
        context.show_name,
        context.name_max_len,
        context.text_max_len,
        context.show_avatar,
        context.theme,
        style_fp,
        typography_fp,
        family,
        round(float(context.dpr), 3),
        bool(message.pinned),
        message.lane,
        int(message.pin_count),
        int(message.line_limit),
        message.kind,
        message.text,
        message.user,
        tuple(sorted((str(key), str(value)) for key, value in message.meta.items())),
    )
    return repr(relevant)


def pinned_display_parts(
    context: RenderContext,
    message: _Message,
    lane: str,
    gift_name: str,
) -> tuple[str, list[tuple[str, QFont, QColor]], list[tuple[str, str, str]]]:
    kind = context.kinds.get(message.kind) or context.kinds["danmaku"]
    style = kind.style
    resolver = kind.resolver
    letter_spacing = float(style.get("letter_spacing", 0.0) or 0.0)
    font_size = int(style.get("font_size", 22))
    weight = int(style.get("font_weight", 600))
    body_font = resolver.get(font_size, weight, letter_spacing)
    name_font = resolver.get(font_size, max(700, weight), letter_spacing)
    accent_font = resolver.get(font_size, max(800, weight), letter_spacing)
    num_font = resolver.get(font_size, 900, letter_spacing)
    body_color = qcolor(style.get("text_color"), "#ffffff")
    name_color = qcolor(style.get("name_color"), "#8fe3ff")
    accent_color = qcolor(style.get("badge_color"), TYPE_COLORS.get(message.kind, "#4aa8ff"))
    user = (
        clip_codepoints(message.user, int(context.name_max_len), ellipsis=True)
        if context.show_name
        else ""
    )
    meta = message.meta or {}
    runs: list[tuple[str, QFont, QColor]] = []
    if lane == "gift":
        gift_name = clip_codepoints(gift_name, 48, ellipsis=True)
        number = positive_int(meta.get("num"), 1)
        runs.append((LANE_LABELS["gift"] + " ", accent_font, accent_color))
        runs.append(("感谢 ", body_font, body_color))
        if user:
            runs.append((user, name_font, name_color))
            runs.append((" ", body_font, body_color))
        runs.append(("送出 ", body_font, body_color))
        runs.append((gift_name, accent_font, accent_color))
        runs.append((" ×" + str(number), num_font, accent_color))
    elif lane == "sc":
        body = str_value(meta.get("message"), "", 8000).strip() or message.text or "醒目留言"
        body = clip_codepoints(body, 120, ellipsis=True)
        price = format_price(meta.get("price"))
        runs.append((LANE_LABELS["sc"] + " ", accent_font, accent_color))
        runs.append(("¥" + price + " ", accent_font, accent_color))
        if user:
            runs.append((user, name_font, name_color))
            if context.name_sep:
                runs.append((context.name_sep, body_font, body_color))
        runs.append((body, body_font, body_color))
        if int(message.pin_count) > 1:
            runs.append((" ×" + str(message.pin_count), num_font, accent_color))
    elif lane == "guard":
        title = guard_title(meta)
        body = message.text or ("开通了 " + title)
        body = clip_codepoints(body, 120, ellipsis=True)
        runs.append((LANE_LABELS["guard"] + " ", accent_font, accent_color))
        if user:
            runs.append((user, name_font, name_color))
            runs.append((" ", body_font, body_color))
        runs.append((body, body_font, body_color))
        if int(message.pin_count) > 1:
            runs.append((" ×" + str(message.pin_count), num_font, accent_color))
    elif lane in ("danmaku", "enter", "like", "social", "fansclub"):
        if lane == "like":
            body = message.text or "点赞了直播间"
        elif lane == "social":
            body = message.text or str_value(meta.get("social_action"), "关注了直播间")
        elif lane == "fansclub":
            body = message.text or str_value(meta.get("fansclub_action"), "加入了粉丝团")
        elif lane == "enter":
            body = message.text or "进入直播间"
        else:
            body = message.text or ""
        body = clip_codepoints(body, 120, ellipsis=True)
        runs.append((LANE_LABELS.get(lane, "") + " ", accent_font, accent_color))
        if user and user not in body:
            runs.append((user, name_font, name_color))
            runs.append((" ", body_font, body_color))
        runs.append((body, body_font, body_color))
    else:
        runs.append((message.text or "", body_font, body_color))
    return "", runs, []


def display_parts(
    context: RenderContext,
    message: _Message,
    lane: str = "",
    gift_name: str = "",
) -> tuple[str, list[tuple[str, QFont, QColor]], list[tuple[str, str, str]]]:
    if message.pinned:
        return pinned_display_parts(context, message, lane, gift_name)
    kind = context.kinds.get(message.kind) or context.kinds["danmaku"]
    style = kind.style
    resolver = kind.resolver
    letter_spacing = float(style.get("letter_spacing", 0.0) or 0.0)
    font_size = int(style.get("font_size", 22))
    weight = int(style.get("font_weight", 600))
    body_font = resolver.get(font_size, weight, letter_spacing)
    name_font = resolver.get(font_size, max(700, weight), letter_spacing)
    body_color = qcolor(style.get("text_color"), "#ffffff")
    name_color = qcolor(style.get("name_color"), "#8fe3ff")
    accent = qcolor(style.get("badge_color"), TYPE_COLORS.get(message.kind, "#4aa8ff"))
    meta = message.meta or {}
    body = ""
    multiplier = ""

    if message.kind == "gift":
        name = str_value(meta.get("gift_name"), "", 300).strip()
        body = message.text if message.text and not name else "送出 " + (name or "礼物")
        multiplier = " ×" + str(positive_int(meta.get("num"), 1))
    elif message.kind == "super_chat":
        body = str_value(meta.get("message"), "", 8000).strip() or message.text or "发来一条醒目留言"
    elif message.kind == "guard":
        body = message.text or "开通成功"
    elif message.kind == "enter":
        body = message.text or "来了"
    elif message.kind == "like":
        count = positive_int(meta.get("like_count"), 1)
        body = message.text or ("点赞了直播间" + (" ×" + str(count) if count > 1 else ""))
    elif message.kind == "social":
        body = message.text or str_value(meta.get("social_action"), "关注了直播间")
    elif message.kind == "fansclub":
        body = message.text or str_value(meta.get("fansclub_action"), "加入了粉丝团")
    else:
        body = message.text

    body = clip_codepoints(body, int(context.text_max_len), ellipsis=True)
    user = (
        clip_codepoints(message.user, int(context.name_max_len), ellipsis=True)
        if context.show_name
        else ""
    )

    runs: list[tuple[str, QFont, QColor]] = []
    if user:
        runs.append((user, name_font, name_color))
        if context.name_sep:
            sep_color = QColor(name_color)
            sep_color.setAlphaF(0.62)
            runs.append((context.name_sep, body_font, sep_color))
    runs.append((body, body_font, body_color))
    if multiplier:
        runs.append((multiplier, resolver.get(font_size, max(800, weight), letter_spacing), accent))
    badges = header_badges(message, context.theme, style)
    return body, runs, badges


def build_visual(
    context: RenderContext,
    message: _Message,
    lane: str = "",
    gift_name: str = "",
) -> _BubbleVisual:
    kind = context.kinds.get(message.kind) or context.kinds["danmaku"]
    style = kind.style
    typography = kind.typography
    resolver = kind.resolver
    font_size = int(style.get("font_size", 22))
    weight = int(style.get("font_weight", 600))
    theme = context.theme
    letter_spacing = float(typography.get("letter_spacing", 0.0) or 0.0)
    body_font = resolver.get(font_size, weight, letter_spacing)
    name_font = resolver.get(font_size, max(700, weight), letter_spacing)
    body_metrics = QFontMetricsF(body_font)
    line_height = max(
        float(font_size) * float(typography.get("line_height", 1.55)),
        body_metrics.height() * 0.98,
    )
    side_margin = 12.0
    max_bubble_width = max(80.0, float(context.width) - side_margin * 2)
    pad_x = max(9.0, min(22.0, font_size * 0.44))
    pad_y = max(5.0, min(12.0, font_size * 0.22))
    accent_width = max(2.0, min(4.0, font_size * 0.13))
    avatar_size = max(22.0, min(42.0, font_size * 0.9)) if context.show_avatar else 0.0
    avatar_gap = max(7.0, font_size * 0.28) if avatar_size else 0.0
    extra_left = pad_x + accent_width + 5.0 + (avatar_size + avatar_gap if avatar_size else 0.0)
    text_max_width = max(60.0, max_bubble_width - extra_left - pad_x)

    _, runs, badge_specs = display_parts(context, message, lane, gift_name)
    accent_color = qcolor(style.get("badge_color"), TYPE_COLORS.get(message.kind, "#4aa8ff"))

    badge_font = resolver.get(max(9, int(round(font_size * 0.38))), 700, 0.0)
    badge_h = float(max(14, min(22, int(round(font_size * 0.8)))))
    badge_metrics = QFontMetricsF(badge_font)
    badges: list[_BadgeVisual] = []
    badge_x = pad_x + accent_width + 5.0 + (avatar_size + avatar_gap if avatar_size else 0.0)
    badge_y = pad_y
    for label, bg, fg in badge_specs:
        badge_pad = float(max(3, min(4, int(round(font_size * 0.18)))))
        width = float(badge_metrics.horizontalAdvance(label)) + badge_pad * 2
        if badge_x + width > pad_x + text_max_width:
            break
        badges.append(
            _BadgeVisual(
                rect=QRectF(badge_x, badge_y, width, badge_h),
                text=label,
                font=badge_font,
                text_color=qcolor(fg, "#ffffff"),
                bg_color=parse_badge_bg(bg),
                border_color=with_alpha(accent_color, 0.3),
                radius=min(badge_h * 0.42, 7.0),
                strong="¥" in label or label == "舰",
            )
        )
        badge_x += width + max(5.0, font_size * 0.22)

    header_height = badge_h if badges else 0.0
    header_gap = max(3.0, font_size * 0.16) if badges else 0.0
    text_left = pad_x + accent_width + 5.0 + (avatar_size + avatar_gap if avatar_size else 0.0)
    text_top = pad_y + header_height + header_gap
    visual_lines, _ = kind.rich.build_visual_lines(
        runs,
        text_max_width,
        max_lines=1 if message.pinned else max(1, min(3, int(message.line_limit))),
        text_top=text_top,
        text_left=text_left,
        line_height=line_height,
        body_font=body_font,
        letter_spacing=letter_spacing,
    )
    text_width = max((line.width for line in visual_lines), default=0.0)
    badge_width = max((badge.rect.right() for badge in badges), default=0.0) - (
        pad_x + accent_width + 5.0 + (avatar_size + avatar_gap if avatar_size else 0.0)
    )
    badge_width = max(0.0, badge_width)
    content_width = max(text_width, badge_width, 1.0)
    bubble_width = min(max_bubble_width, extra_left + content_width + pad_x)
    if avatar_size:
        bubble_height = max(
            pad_y * 2 + len(visual_lines) * line_height,
            pad_y * 2 + avatar_size,
        )
    else:
        bubble_height = pad_y * 2 + len(visual_lines) * line_height
    if badges:
        bubble_height = max(
            bubble_height,
            pad_y * 2 + badge_h + header_gap + len(visual_lines) * line_height,
        )

    if theme == "shortvideo":
        radius = 4.0
    elif theme == "highcontrast":
        radius = 2.0
    elif theme == "minimal":
        radius = 8.0
    else:
        radius = max(7.0, min(14.0, font_size * 0.4))

    bg_alpha = float(style.get("bg_opacity", 0.22))
    bg_color = with_alpha(qcolor(style.get("bg_color"), "#000000"), bg_alpha)
    if message.pinned:
        border_color = with_alpha(accent_color, 0.78)
    elif bg_alpha <= 0.015:
        border_color = QColor(0, 0, 0, 0)
    else:
        if theme == "highcontrast":
            border_color = QColor(255, 255, 255, 46)
        elif theme == "minimal":
            border_color = QColor(255, 255, 255, 17)
        else:
            border_color = QColor(255, 255, 255, 29)
        if message.kind != "danmaku":
            border_color = with_alpha(accent_color, 0.34)

    avatar_rect = None
    if avatar_size:
        avatar_rect = QRectF(pad_x + accent_width + 5.0, pad_y, avatar_size, avatar_size)
    avatar_a, avatar_b = avatar_colors(message.user, message.uid)

    return _BubbleVisual(
        width=bubble_width,
        height=bubble_height,
        radius=radius,
        pad_left=pad_x,
        pad_right=pad_x,
        pad_top=pad_y,
        pad_bottom=pad_y,
        accent_width=accent_width,
        avatar_rect=avatar_rect,
        avatar_text=first_glyph(message.user),
        avatar_color_a=avatar_a,
        avatar_color_b=avatar_b,
        badges=badges,
        lines=visual_lines,
        line_height=line_height,
        header_height=header_height,
        text_left=text_left,
        text_top=text_top,
        bg_color=bg_color,
        border_color=border_color,
        accent_color=accent_color,
        type_name=(
            LANE_LABELS.get(lane or message.lane, "固定")
            if message.pinned
            else TYPE_NAMES.get(message.kind, "")
        ),
        theme=theme,
        font_size=float(font_size),
        pinned=bool(message.pinned),
        outline=bool(style.get("outline", True)),
        outline_color=qcolor(style.get("outline_color"), "#000000"),
        outline_width=float(style.get("outline_width", 2.0)),
        shadow=bool(style.get("shadow", True)),
        opacity=float(style.get("opacity", 1.0)),
    )


def message_x(width: float, align: str, visual: _BubbleVisual) -> float:
    margin = 12.0
    if align == "center":
        x = (width - visual.width) / 2.0
    elif align == "right":
        x = width - margin - visual.width
    else:
        x = margin
    return max(margin, min(float(width) - margin - visual.width, x))


def paint_bubble_background(
    painter: QPainter,
    visual: _BubbleVisual,
    x: float,
    y: float,
) -> None:
    rect = QRectF(x, y, visual.width, visual.height)
    bg_alpha = visual.bg_color.alphaF()
    if bg_alpha > 0.015:
        painter.save()
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(visual.bg_color)
        painter.drawRoundedRect(rect, visual.radius, visual.radius)
        painter.restore()
    if visual.border_color.alpha() > 0:
        painter.save()
        pen = QPen(visual.border_color, 1.8 if visual.pinned else 1.1)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        inset = 0.55
        painter.drawRoundedRect(
            rect.adjusted(inset, inset, -inset, -inset),
            visual.radius,
            visual.radius,
        )
        painter.restore()
    painter.save()
    painter.setPen(Qt.PenStyle.NoPen)
    bar = QRectF(
        x + max(2.0, visual.pad_left * 0.32),
        y + max(8.0, visual.pad_top),
        visual.accent_width,
        max(8.0, visual.height - max(8.0, visual.pad_top) * 2),
    )
    painter.setBrush(visual.accent_color)
    painter.drawRoundedRect(bar, bar.width() / 2.0, bar.width() / 2.0)
    painter.restore()


def paint_badges(
    painter: QPainter,
    visual: _BubbleVisual,
    x: float,
    y: float,
) -> None:
    if not visual.badges:
        return
    painter.save()
    painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
    for badge in visual.badges:
        rect = badge.rect.translated(x, y)
        painter.setPen(QPen(badge.border_color, 0.8))
        painter.setBrush(badge.bg_color)
        painter.drawRoundedRect(rect, badge.radius, badge.radius)
        painter.setFont(badge.font)
        painter.setPen(badge.text_color)
        painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, badge.text)
    painter.restore()


def paint_avatar(
    painter: QPainter,
    visual: _BubbleVisual,
    x: float,
    y: float,
    default_resolver: _FontResolver,
) -> None:
    if visual.avatar_rect is None:
        return
    rect = visual.avatar_rect.translated(x, y)
    painter.save()
    gradient = QLinearGradient(rect.left(), rect.top(), rect.right(), rect.bottom())
    gradient.setColorAt(0.0, visual.avatar_color_a)
    gradient.setColorAt(1.0, visual.avatar_color_b)
    path = QPainterPath()
    path.addEllipse(rect)
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(gradient)
    painter.drawPath(path)
    painter.setBrush(Qt.BrushStyle.NoBrush)
    border = QColor(255, 255, 255, 45)
    painter.setPen(QPen(border, 1.0))
    painter.drawEllipse(rect.adjusted(0.5, 0.5, -0.5, -0.5))
    font = default_resolver.get(max(10, int(rect.height() * 0.44)), 750)
    painter.setFont(font)
    painter.setPen(QColor(255, 255, 255, 238))
    painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, visual.avatar_text)
    painter.restore()


def paint_text(
    painter: QPainter,
    visual: _BubbleVisual,
    x: float,
    y: float,
) -> None:
    outline = bool(visual.outline)
    outline_width = float(visual.outline_width)
    outline_color = QColor(visual.outline_color)
    pen_width = 0.0
    if outline and outline_width > 0:
        pen_width = max(1.0, round(outline_width * visual.font_size / 22.0))
    elif visual.theme == "minimal":
        pen_width = max(1.0, min(1.6, visual.font_size / 16.0))
        outline_color = QColor("#07111e")
    shadow = bool(visual.shadow)
    painter.save()
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
    for line in visual.lines:
        for segment in line.segments:
            path = segment.path.translated(x, y)
            if path.isEmpty():
                if segment.fallback_font is not None and segment.fallback_text:
                    painter.setFont(segment.fallback_font)
                    painter.setPen(segment.color)
                    painter.drawText(
                        QPointF(x + segment.fallback_x, y + segment.fallback_baseline),
                        segment.fallback_text,
                    )
                continue
            if shadow:
                painter.save()
                painter.setPen(Qt.PenStyle.NoPen)
                for dx, dy, alpha in ((0.0, 1.2, 0.12), (0.6, 1.8, 0.05)):
                    painter.setBrush(QColor(0, 0, 0, int(255 * alpha)))
                    painter.drawPath(path.translated(dx, dy))
                painter.restore()
            if pen_width > 0:
                painter.save()
                pen = QPen(
                    outline_color,
                    pen_width,
                    Qt.PenStyle.SolidLine,
                    Qt.PenCapStyle.RoundCap,
                    Qt.PenJoinStyle.RoundJoin,
                )
                painter.setPen(pen)
                painter.setBrush(Qt.BrushStyle.NoBrush)
                painter.drawPath(path)
                painter.restore()
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(segment.color)
            painter.drawPath(path)
    painter.restore()


def build_bubble_pixmap(
    visual: _BubbleVisual,
    dpr: float,
    default_resolver: _FontResolver,
) -> QPixmap:
    dpr = max(1.0, float(dpr))
    pad = visual.pixmap_pad
    width = max(1, int(math.ceil((visual.width + pad * 2.0) * dpr)))
    height = max(1, int(math.ceil((visual.height + pad * 2.0) * dpr)))
    pixmap = QPixmap(width, height)
    pixmap.setDevicePixelRatio(dpr)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    try:
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        painter.translate(pad, pad)
        paint_bubble_background(painter, visual, 0.0, 0.0)
        paint_badges(painter, visual, 0.0, 0.0)
        paint_avatar(painter, visual, 0.0, 0.0, default_resolver)
        paint_text(painter, visual, 0.0, 0.0)
    finally:
        painter.end()
    return pixmap
