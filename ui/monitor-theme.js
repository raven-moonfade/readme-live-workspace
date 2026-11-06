/* 独立监看窗口共享主工作台的外观状态；只改颜色/字体/点阵，不改 17px/38px 排版契约。 */
(function () {
  "use strict";

  var KEY = "mutai-appearance-prod-v1";
  var PRESETS = {
    broadcast: { accent: "#FF5F3A", pattern: "none", font: "broadcast", spacing: 24, dotSize: 1.5 },
    cobalt: { accent: "#7C8CFF", pattern: "dots", font: "system", spacing: 24, dotSize: 1.5 }
  };
  var root = document.documentElement;

  function rgba(hex, alpha) {
    var value = String(hex || "").replace("#", "");
    if (value.length === 3) value = value.split("").map(function (part) { return part + part; }).join("");
    if (!/^[0-9a-f]{6}$/i.test(value)) value = "FF5F3A";
    var number = parseInt(value, 16);
    return "rgba(" + ((number >> 16) & 255) + "," + ((number >> 8) & 255) + "," + (number & 255) + "," + alpha + ")";
  }

  function fontStack(name) {
    if (name === "system") return '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
    if (name === "humanist") return '"Microsoft YaHei UI", "PingFang SC", "Segoe UI", system-ui, sans-serif';
    return '"Bahnschrift", "Segoe UI Variable Display", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
  }

  function apply() {
    var preset = PRESETS.broadcast;
    var data = {};
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) data = JSON.parse(raw) || {};
    } catch (e) {}

    if (!data.custom && data.preset && PRESETS[data.preset]) preset = PRESETS[data.preset];
    var accent = /^#[0-9a-f]{6}$/i.test(String(data.accent || "")) ? data.accent : preset.accent;
    var font = data.font || preset.font;
    var pattern = data.pattern || preset.pattern;
    var spacing = Math.max(8, Math.min(40, Number(data.spacing) || preset.spacing || 24));
    var dotSize = Math.max(0.5, Math.min(4, Number(data.dotSize) || preset.dotSize || 1.5));

    root.style.setProperty("--bg", "#0B0D0C");
    root.style.setProperty("--surface", "#121512");
    root.style.setProperty("--surface-2", "#171B17");
    root.style.setProperty("--surface-3", "#1D221D");
    root.style.setProperty("--line", "rgba(241,243,237,.10)");
    root.style.setProperty("--line-strong", "rgba(241,243,237,.18)");
    root.style.setProperty("--text", "#F1F3ED");
    root.style.setProperty("--text-2", "#C4CAC1");
    root.style.setProperty("--muted", "#A7ADA4");
    root.style.setProperty("--faint", "#8B928A");
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-soft", rgba(accent, .14));
    root.style.setProperty("--accent-line", rgba(accent, .36));
    root.style.setProperty("--cyan", accent);
    root.style.setProperty("--font-ui", fontStack(font));
    root.style.setProperty("--ap-dot-spacing", spacing + "px");
    root.style.setProperty("--ap-dot-radius", (dotSize / 2) + "px");
    root.style.setProperty("--ap-dot", "rgba(241,243,237,.11)");
    root.setAttribute("data-ap-pattern", pattern === "dots" ? "dots" : "none");
  }

  apply();
  window.addEventListener("storage", function (event) {
    if (!event.key || event.key === KEY) apply();
  });
  window.addEventListener("focus", apply);
})();
