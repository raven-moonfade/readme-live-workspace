/* 幕台监看 · 工作台外观只读同步（本机配置优先，localStorage 为离线缓存） */
(function () {
  "use strict";
  var KEY = "mutai-appearance-prod-v1";
  var root = document.documentElement;
  var attempts = 0;
  var timer = 0;
  var themeMode = "dark";
  var lastData = null;
  var systemTheme = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  var THEMES = {
    dark: {
      bg: "#0B0D0C",
      surface: "#121512",
      surface2: "#171B17",
      surface3: "#1D221D",
      line: "rgba(241,243,237,.10)",
      lineStrong: "rgba(241,243,237,.18)",
      text: "#F1F3ED",
      text2: "#C4CAC1",
      muted: "#A7ADA4",
      faint: "#8B928A",
      inkRgb: "241, 243, 237",
      topbar: "rgba(11,14,20,.88)",
      panelSoft: "rgba(18,22,31,.70)",
      panel: "rgba(18,22,31,.86)",
      panelSolid: "#141A24",
      scrim: "rgba(4,6,10,.74)",
      ok: "#5DDCA9",
      warn: "#F6C667",
      danger: "#FF8EA0",
      danmaku: "#6DD2FA",
      gift: "#F5CA70",
      sc: "#FF93A8",
      guard: "#B8A7FF",
      enter: "#72DFB7",
      scheme: "dark"
    },
    light: {
      bg: "#EFF0EB",
      surface: "#FAFAF6",
      surface2: "#F3F4EF",
      surface3: "#E8EAE3",
      line: "#CDD1C8",
      lineStrong: "#B8BEB4",
      text: "#121411",
      text2: "#3F463F",
      muted: "#5E665E",
      faint: "#667066",
      inkRgb: "18, 20, 17",
      topbar: "rgba(250,250,246,.92)",
      panelSoft: "rgba(250,250,246,.88)",
      panel: "rgba(250,250,246,.96)",
      panelSolid: "#FAFAF6",
      scrim: "rgba(18,20,17,.34)",
      ok: "#2F6F58",
      warn: "#82571A",
      danger: "#B4442D",
      danmaku: "#176B89",
      gift: "#7A5410",
      sc: "#A83952",
      guard: "#5B46A3",
      enter: "#176B55",
      scheme: "light"
    }
  };

  function fontStack(name) {
    if (name === "system") {
      return '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
    }
    if (name === "humanist") {
      return '"Microsoft YaHei UI", "PingFang SC", "Segoe UI", system-ui, sans-serif';
    }
    return '"Bahnschrift", "Segoe UI Variable Display", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
  }

  function hexRgb(value) {
    var hex = String(value || "").replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(hex)) hex = "FF5F3A";
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16)
    ];
  }

  function mixHex(from, to, amount) {
    var a = hexRgb(from);
    var b = hexRgb(to);
    var t = Math.max(0, Math.min(1, amount));
    return "#" + a.map(function (value, index) {
      return Math.round(value + (b[index] - value) * t).toString(16).padStart(2, "0");
    }).join("").toUpperCase();
  }

  function luminance(value) {
    return hexRgb(value).map(function (channel) {
      var c = channel / 255;
      return c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4);
    }).reduce(function (sum, channel, index) {
      return sum + channel * [0.2126, 0.7152, 0.0722][index];
    }, 0);
  }

  function contrastRatio(a, b) {
    var high = Math.max(luminance(a), luminance(b));
    var low = Math.min(luminance(a), luminance(b));
    return (high + .05) / (low + .05);
  }

  function readableAccent(accent, background) {
    var target = luminance(background) > .45 ? "#121411" : "#F1F3ED";
    var candidate = accent;
    for (var step = 1; step <= 10; step += 1) {
      if (contrastRatio(candidate, background) >= 4.5) return candidate;
      candidate = mixHex(accent, target, step / 10);
    }
    return candidate;
  }

  function onAccent(accent) {
    return contrastRatio(accent, "#121411") >= contrastRatio(accent, "#FFFFFF")
      ? "#121411"
      : "#FFFFFF";
  }

  function resolvedTheme() {
    if (themeMode === "system") {
      return systemTheme && systemTheme.matches ? "dark" : "light";
    }
    return themeMode === "light" ? "light" : "dark";
  }

  function bridgeApi() {
    var api = window.pywebview && window.pywebview.api;
    return api && typeof api.appearance === "function" ? api : null;
  }

  function normalize(source) {
    if (!source || typeof source !== "object") return null;
    var value = source.appearance && typeof source.appearance === "object"
      ? source.appearance
      : source;
    if (
      !Object.prototype.hasOwnProperty.call(value, "accent") &&
      !Object.prototype.hasOwnProperty.call(value, "pattern") &&
      !Object.prototype.hasOwnProperty.call(value, "radius")
    ) {
      return null;
    }
    var mode = value.theme_mode || value.themeMode;
    var patternSource = value.pattern;
    var patternObject = patternSource && typeof patternSource === "object" ? patternSource : null;
    var pattern = patternObject
      ? (patternObject.type === "dots" ? "dots" : "none")
      : (patternSource === "dots" ? "dots" : "none");
    var spacing = patternObject
      ? Number(patternObject.spacing_px)
      : Number(value.spacing);
    var dotSize = patternObject
      ? Number(patternObject.dot_size_px)
      : Number(value.dotSize);
    return {
      accent: /^#[0-9a-f]{6}$/i.test(String(value.accent || "")) ? value.accent : "#FF5F3A",
      font: value.font === "system" || value.font === "humanist" ? value.font : "broadcast",
      themeMode: mode === "light" || mode === "system" ? mode : "dark",
      pattern: pattern,
      monitorPattern: typeof value.monitor_pattern === "boolean" ? value.monitor_pattern : true,
      spacing: Math.max(8, Math.min(40, Number.isFinite(spacing) ? spacing : 24)),
      dotSize: Math.max(0.5, Math.min(4, Number.isFinite(dotSize) ? dotSize : 1.5))
    };
  }

  function applyData(source) {
    var data = normalize(source);
    if (!data) return;
    lastData = data;
    themeMode = data.themeMode;
    var themeName = resolvedTheme();
    var theme = THEMES[themeName];
    var accent = data.accent;
    var accentInk = readableAccent(accent, theme.bg);
    root.style.setProperty("--bg", theme.bg);
    root.style.setProperty("--surface", theme.surface);
    root.style.setProperty("--surface-2", theme.surface2);
    root.style.setProperty("--surface-3", theme.surface3);
    root.style.setProperty("--line", theme.line);
    root.style.setProperty("--line-strong", theme.lineStrong);
    root.style.setProperty("--text", theme.text);
    root.style.setProperty("--text-2", theme.text2);
    root.style.setProperty("--muted", theme.muted);
    root.style.setProperty("--faint", theme.faint);
    root.style.setProperty("--ink-rgb", theme.inkRgb);
    root.style.setProperty("--topbar-bg", theme.topbar);
    root.style.setProperty("--panel-soft", theme.panelSoft);
    root.style.setProperty("--panel", theme.panel);
    root.style.setProperty("--panel-solid", theme.panelSolid);
    root.style.setProperty("--scrim", theme.scrim);
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-ink", accentInk);
    root.style.setProperty("--on-accent", onAccent(accent));
    root.style.setProperty("--focus", accentInk);
    root.style.setProperty("--accent-soft", accent + "20");
    root.style.setProperty("--accent-line", accent + "5C");
    root.style.setProperty("--cyan", accentInk);
    root.style.setProperty("--ap-dot-spacing", data.spacing + "px");
    root.style.setProperty("--ap-dot-radius", (data.dotSize / 2) + "px");
    var monitorPattern = data.monitorPattern && data.pattern === "dots";
    root.style.setProperty("--ap-dot", monitorPattern
      ? "color-mix(in srgb, " + accent + " 34%, transparent)"
      : "transparent");
    root.dataset.apPattern = monitorPattern ? "dots" : "none";
    root.style.setProperty("--ok", theme.ok);
    root.style.setProperty("--warn", theme.warn);
    root.style.setProperty("--danger", theme.danger);
    root.style.setProperty("--danmaku", theme.danmaku);
    root.style.setProperty("--gift", theme.gift);
    root.style.setProperty("--sc", theme.sc);
    root.style.setProperty("--guard", theme.guard);
    root.style.setProperty("--enter", theme.enter);
    root.style.setProperty("--font-ui", fontStack(data.font));
    root.dataset.theme = themeName;
    root.dataset.themeMode = themeMode;
    root.style.colorScheme = theme.scheme;
  }

  function applyCached() {
    try {
      applyData(JSON.parse(localStorage.getItem(KEY) || "null"));
    } catch (e) {}
  }

  function hydrate() {
    var api = bridgeApi();
    if (!api) {
      attempts += 1;
      if (attempts <= 20) {
        clearTimeout(timer);
        timer = setTimeout(hydrate, 250);
      }
      return;
    }
    attempts = 0;
    Promise.resolve(api.appearance()).then(applyData).catch(function () {
      // 后端不可用时保留缓存样式。
    });
  }

  applyCached();
  hydrate();
  window.addEventListener("pywebviewready", hydrate);
  window.addEventListener("storage", function (event) {
    if (event.key === KEY) applyCached();
  });
  window.addEventListener("focus", hydrate);
  if (systemTheme) {
    var onSystemThemeChange = function () {
      if (themeMode !== "system") return;
      if (lastData) applyData(lastData);
      else applyCached();
    };
    if (typeof systemTheme.addEventListener === "function") {
      systemTheme.addEventListener("change", onSystemThemeChange);
    } else if (typeof systemTheme.addListener === "function") {
      systemTheme.addListener(onSystemThemeChange);
    }
  }
})();
