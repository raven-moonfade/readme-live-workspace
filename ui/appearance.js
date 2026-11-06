/* ============================================================
   ReadMe · 工作台外观（配置 v3）
   - 两个预设：广播校样 / 钴蓝点阵
   - 自定义：主题色、字体、点阵间距/点大小、圆角
   - 权威配置写入 config.json；localStorage 仅作离线缓存与旧版一次性导入
   - 明暗模式：晨光 / 夜航 / 跟随系统，独立于预设
   ============================================================ */
(function () {
  "use strict";

  var STORAGE_KEY = "mutai-appearance-prod-v1";
  var IMPORT_KEY = "mutai-appearance-imported-v3";
  var root = document.documentElement;

  var PRESETS = {
    broadcast: {
      label: "广播校样",
      accent: "#F0441C",
      accentBright: "#F0441C",
      accentDark: "#F0441C",
      pattern: "none",
      spacing: 24,
      dotSize: 1.5,
      radius: false,
      radiusSize: 12,
      font: "broadcast"
    },
    cobalt: {
      label: "钴蓝点阵",
      accent: "#2F4BFF",
      accentBright: "#3D5BFF",
      accentDark: "#2F4BFF",
      pattern: "dots",
      spacing: 24,
      dotSize: 1.5,
      radius: true,
      radiusSize: 12,
      font: "system"
    }
  };

  var THEMES = {
    dark: {
      bg: "#0B0D0C",
      bgSoft: "#101310",
      surface: "#121512",
      surfaceSoft: "#171B17",
      surface2: "#171B17",
      surface3: "#1D221D",
      line: "#2A2F2A",
      lineStrong: "#3A4039",
      text: "#F1F3ED",
      muted: "#A7ADA4",
      faint: "#8B928A",
      inkRgb: "241, 243, 237",
      dot: "transparent",
      topbar: "#121512",
      shadowCard: "none",
      shadowFloat: "0 30px 74px -38px rgba(0,0,0,.9)",
      shadowPop: "0 12px 28px -14px rgba(0,0,0,.85)",
      ok: "#78C4A4",
      warn: "#D9AF68",
      err: "#F08372",
      scheme: "dark"
    },
    light: {
      bg: "#EFF0EB",
      bgSoft: "#E4E6DF",
      surface: "#FAFAF6",
      surfaceSoft: "#F3F4EF",
      surface2: "#F3F4EF",
      surface3: "#E8EAE3",
      line: "#CDD1C8",
      lineStrong: "#B8BEB4",
      text: "#121411",
      muted: "#5E665E",
      faint: "#667066",
      inkRgb: "18, 20, 17",
      dot: "transparent",
      topbar: "#FAFAF6",
      shadowCard: "none",
      shadowFloat: "0 24px 64px -36px rgba(18,20,17,.28)",
      shadowPop: "0 14px 30px -18px rgba(18,20,17,.22)",
      ok: "#2F6F58",
      warn: "#82571A",
      err: "#B4442D",
      scheme: "light"
    }
  };

  var state = {
    schemaVersion: 1,
    preset: "broadcast",
    custom: false,
    themeMode: "dark",
    accent: PRESETS.broadcast.accent,
    pattern: PRESETS.broadcast.pattern,
    spacing: PRESETS.broadcast.spacing,
    dotSize: PRESETS.broadcast.dotSize,
    monitorPattern: true,
    radius: PRESETS.broadcast.radius,
    radiusSize: PRESETS.broadcast.radiusSize,
    font: PRESETS.broadcast.font,
    readOnly: false,
    dirty: false,
    pending: false
  };

  var els = {};
  var lastFocus = null;
  var toastTimer = 0;
  var hydrateTimer = 0;
  var hydrateAttempts = 0;
  var hydrateBusy = false;
  var saving = false;
  var systemTheme = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function $(id) {
    return document.getElementById(id);
  }

  function clamp(value, min, max, fallback) {
    var number = Number(value);
    if (!isFinite(number)) number = fallback;
    return Math.max(min, Math.min(max, number));
  }

  function safeHex(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
  }

  function hexRgb(value) {
    var hex = safeHex(value, "#000000").slice(1);
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
    if (state.themeMode === "system") {
      return systemTheme && systemTheme.matches ? "dark" : "light";
    }
    return state.themeMode === "light" ? "light" : "dark";
  }

  function themeLabel() {
    if (state.themeMode === "system") return "跟随系统";
    return state.themeMode === "light" ? "晨光" : "夜航";
  }

  function fontStack(name) {
    if (name === "system") {
      return '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
    }
    if (name === "humanist") {
      return '"Microsoft YaHei UI", "PingFang SC", "Segoe UI", system-ui, sans-serif';
    }
    return '"Bahnschrift", "Segoe UI Variable Display", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
  }

  function displayFontStack(name) {
    if (name === "broadcast") {
      return '"Bahnschrift", "Segoe UI Variable Display", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
    }
    return '"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
  }

  function apply() {
    var preset = PRESETS[state.preset] || PRESETS.broadcast;
    if (!state.custom) {
      state.accent = preset.accent;
      state.pattern = preset.pattern;
      state.spacing = preset.spacing;
      state.dotSize = preset.dotSize;
      state.radius = preset.radius;
      state.radiusSize = preset.radiusSize;
      state.font = preset.font;
    }

    var themeName = resolvedTheme();
    var theme = THEMES[themeName];
    var accent = state.custom
      ? safeHex(state.accent, PRESETS.broadcast.accent)
      : safeHex(themeName === "dark" ? preset.accentDark : preset.accent, preset.accent);
    var accentBright = state.custom ? accent : (preset.accentBright || accent);
    var radius = state.radius ? clamp(state.radiusSize, 2, 18, 12) : 0;
    var spacing = clamp(state.spacing, 8, 40, 24);
    var dotSize = clamp(state.dotSize, 0.5, 4, 1.5);
    var accentInk = readableAccent(accent, theme.bg);

    root.style.setProperty("--bg", theme.bg);
    root.style.setProperty("--bg-soft", theme.bgSoft);
    root.style.setProperty("--surface", theme.surface);
    root.style.setProperty("--surface-soft", theme.surfaceSoft);
    root.style.setProperty("--surface-2", theme.surface2);
    root.style.setProperty("--surface-3", theme.surface3);
    root.style.setProperty("--line", theme.line);
    root.style.setProperty("--line-strong", theme.lineStrong);
    root.style.setProperty("--text", theme.text);
    root.style.setProperty("--muted", theme.muted);
    root.style.setProperty("--faint", theme.faint);
    root.style.setProperty("--ink-rgb", theme.inkRgb);
    root.style.setProperty("--topbar-bg", theme.topbar);
    root.style.setProperty("--shadow-card", theme.shadowCard);
    root.style.setProperty("--shadow-float", theme.shadowFloat);
    root.style.setProperty("--shadow-pop", theme.shadowPop);
    root.style.setProperty("--ok", theme.ok);
    root.style.setProperty("--warn", theme.warn);
    root.style.setProperty("--err", theme.err);
    root.style.setProperty("--focus", accentInk);
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-lift", accent);
    root.style.setProperty("--accent-2", accent);
    root.style.setProperty("--accent-bright", accentBright);
    root.style.setProperty("--accent-soft", "color-mix(in srgb, " + accent + " 14%, transparent)");
    root.style.setProperty("--accent-wash", "color-mix(in srgb, " + accent + " 7.5%, transparent)");
    root.style.setProperty("--accent-ink", accentInk);
    root.style.setProperty("--on-accent", onAccent(accent));
    root.style.setProperty("--grad", "linear-gradient(135deg, " + accent + ", " + accent + ")");
    root.style.setProperty("--grad-btn", "linear-gradient(135deg, " + accent + ", " + accent + ")");
    root.style.setProperty("--font", fontStack("system"));
    root.style.setProperty("--font-ui", fontStack("system"));
    root.style.setProperty("--font-display", displayFontStack(state.font));
    root.style.setProperty("--font-mono", '"Cascadia Mono", "Consolas", "SFMono-Regular", monospace');
    root.style.setProperty("--r-card", radius + "px");
    root.style.setProperty("--r-control", (radius ? Math.max(2, Math.round(radius * .65)) : 2) + "px");
    root.style.setProperty("--r-ctl", (radius ? Math.max(2, Math.round(radius * .65)) : 2) + "px");
    root.style.setProperty("--r-sm", (radius ? Math.max(2, Math.round(radius * .5)) : 2) + "px");
    root.style.setProperty("--r-chip", radius ? "999px" : "2px");
    root.style.setProperty("--ap-dot-spacing", spacing + "px");
    root.style.setProperty("--ap-dot-radius", (dotSize / 2) + "px");
    root.style.setProperty("--ap-dot", state.pattern === "dots"
      ? "color-mix(in srgb, " + accent + " 34%, transparent)"
      : "transparent");
    root.dataset.apPattern = state.pattern === "dots" ? "dots" : "none";
    root.dataset.apPreset = state.preset || "broadcast";
    root.dataset.apFont = state.font || "broadcast";
    root.dataset.apRadius = state.radius ? "soft" : "sharp";
    root.dataset.theme = themeName;
    root.dataset.themeMode = state.themeMode;
    root.style.colorScheme = theme.scheme;

    syncUI();
  }

  function syncUI() {
    if (!els.modal) return;
    var label = state.custom ? "自定义" : (PRESETS[state.preset] || PRESETS.broadcast).label;
    var modeLabel = themeLabel();
    els.state.textContent = label;
    if (els.themeCopy) {
      els.themeCopy.textContent = "工作台 · " + modeLabel + "模式 · 同步主窗口与独立监看，直播浮窗保持独立样式";
    }
    els.status.textContent = state.readOnly
      ? "配置只读 · 外观草稿不会写入磁盘"
      : state.dirty
        ? "外观已修改 · 尚未保存"
        : "当前外观 · " + label + " · " + modeLabel;
    els.save.disabled = state.readOnly || saving;

    els.modal.querySelectorAll("[data-ap-theme]").forEach(function (button) {
      var active = button.getAttribute("data-ap-theme") === state.themeMode;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    });

    els.modal.querySelectorAll("[data-ap-preset]").forEach(function (card) {
      var selected = !state.custom && card.getAttribute("data-ap-preset") === state.preset;
      card.classList.toggle("is-selected", selected);
      card.classList.toggle("is-disabled", state.custom);
      card.setAttribute("aria-pressed", String(selected));
      card.disabled = state.custom;
    });

    els.customToggle.setAttribute("aria-checked", String(state.custom));
    els.customPanel.hidden = !state.custom;
    els.customToggle.setAttribute("aria-label", state.custom ? "关闭自定义外观" : "开启自定义外观");
    els.presetHint.textContent = state.custom ? "自定义中 · 预设已锁定" : "每个预设包含一套字体与几何";

    els.modal.querySelectorAll("[data-ap-accent]").forEach(function (button) {
      button.classList.toggle("is-selected", button.getAttribute("data-ap-accent").toLowerCase() === state.accent.toLowerCase());
    });
    els.color.value = state.accent;
    els.font.value = state.font;
    els.dotToggle.setAttribute("aria-checked", String(state.pattern === "dots"));
    els.spacing.value = String(state.spacing);
    els.spacingValue.textContent = String(state.spacing) + "px";
    els.spacing.disabled = state.pattern !== "dots";
    els.dotSize.value = String(state.dotSize);
    els.dotSizeValue.textContent = Number(state.dotSize) + "px";
    els.dotSize.disabled = state.pattern !== "dots";
    els.monitorDotToggle.setAttribute("aria-checked", String(state.monitorPattern));
    els.radiusToggle.setAttribute("aria-checked", String(state.radius));
    els.radiusSize.value = String(state.radiusSize);
    els.radiusSizeValue.textContent = String(state.radiusSize) + "px";
    els.radiusSize.disabled = !state.radius;
  }

  function fromServer(data) {
    if (!data || typeof data !== "object") return false;
    var source = data.appearance && typeof data.appearance === "object" ? data.appearance : data;
    if (
      !Object.prototype.hasOwnProperty.call(source, "accent") &&
      !Object.prototype.hasOwnProperty.call(source, "pattern") &&
      !Object.prototype.hasOwnProperty.call(source, "radius")
    ) {
      return false;
    }
    var pattern = source.pattern;
    var radius = source.radius;
    var themeMode = source.theme_mode || source.themeMode;

    state.schemaVersion = Number(source.schema_version) || 1;
    state.preset = PRESETS[source.preset] ? source.preset : "broadcast";
    state.custom = !!source.custom;
    state.themeMode = themeMode === "light" ||
      themeMode === "system" ||
      themeMode === "dark"
      ? themeMode
      : "dark";
    state.accent = safeHex(source.accent, PRESETS.broadcast.accent);
    state.pattern = pattern && typeof pattern === "object"
      ? (pattern.type === "dots" ? "dots" : "none")
      : (source.pattern === "dots" ? "dots" : "none");
    state.spacing = clamp(
      pattern && typeof pattern === "object" ? pattern.spacing_px : source.spacing,
      8, 40, 24
    );
    state.dotSize = clamp(
      pattern && typeof pattern === "object" ? pattern.dot_size_px : source.dotSize,
      0.5, 4, 1.5
    );
    state.monitorPattern = typeof source.monitor_pattern === "boolean"
      ? source.monitor_pattern
      : true;
    state.radius = radius && typeof radius === "object"
      ? !!radius.enabled
      : !!source.radius;
    state.radiusSize = clamp(
      radius && typeof radius === "object" ? radius.value_px : source.radiusSize,
      2, 18, 12
    );
    state.font = source.font === "system" || source.font === "humanist"
      ? source.font
      : "broadcast";
    return true;
  }

  function toServer() {
    return {
      schema_version: 1,
      preset: PRESETS[state.preset] ? state.preset : "broadcast",
      custom: !!state.custom,
      theme_mode: state.themeMode,
      accent: safeHex(state.accent, PRESETS.broadcast.accent).toUpperCase(),
      pattern: {
        type: state.pattern === "dots" ? "dots" : "none",
        spacing_px: Math.round(clamp(state.spacing, 8, 40, 24)),
        dot_size_px: Number(clamp(state.dotSize, 0.5, 4, 1.5).toFixed(2))
      },
      monitor_pattern: !!state.monitorPattern,
      radius: {
        enabled: !!state.radius,
        value_px: Math.round(clamp(state.radiusSize, 2, 18, 12))
      },
      font: state.font === "system" || state.font === "humanist" ? state.font : "broadcast"
    };
  }

  function unwrapAppearance(data) {
    if (!data || typeof data !== "object") return null;
    return data.appearance && typeof data.appearance === "object" ? data.appearance : data;
  }

  function isDefaultAppearance(data) {
    var source = unwrapAppearance(data);
    if (!source) return false;
    var pattern = source.pattern && typeof source.pattern === "object" ? source.pattern : null;
    var radius = source.radius && typeof source.radius === "object" ? source.radius : null;
    return !source.custom &&
      (source.preset || "broadcast") === "broadcast" &&
      (!source.theme_mode || source.theme_mode === "dark") &&
      safeHex(source.accent, "").toLowerCase() === PRESETS.broadcast.accent.toLowerCase() &&
      (!pattern || (pattern.type === "none" && Number(pattern.spacing_px) === 24 && Number(pattern.dot_size_px) === 1.5)) &&
      source.monitor_pattern !== false &&
      (!radius || (!radius.enabled && Number(radius.value_px) === 12)) &&
      (!source.font || source.font === "broadcast");
  }

  function localNeedsImport() {
    return !!state.custom ||
      state.themeMode !== "dark" ||
      safeHex(state.accent, "").toLowerCase() !== PRESETS.broadcast.accent.toLowerCase() ||
      state.pattern !== "none" ||
      Number(state.spacing) !== 24 ||
      Number(state.dotSize) !== 1.5 ||
      !state.monitorPattern ||
      !!state.radius ||
      Number(state.radiusSize) !== 12 ||
      state.font !== "broadcast";
  }

  function persistLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        preset: state.preset,
        custom: !!state.custom,
        themeMode: state.themeMode,
        accent: state.accent,
        pattern: state.pattern,
        spacing: state.spacing,
        dotSize: state.dotSize,
        monitorPattern: state.monitorPattern,
        radius: state.radius,
        radiusSize: state.radiusSize,
        font: state.font,
        pending: !!state.pending
      }));
    } catch (e) {}
  }

  function cacheFlag(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function setCacheFlag(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || typeof data !== "object") return;
      fromServer(data);
      state.pending = !!data.pending;
      state.dirty = state.pending;
    } catch (e) {}
  }

  function bridgeApi() {
    var api = window.pywebview && window.pywebview.api;
    return api && typeof api.get_appearance === "function" ? api : null;
  }

  function hydrateFromBackend() {
    if (hydrateBusy) return;
    var api = bridgeApi();
    if (!api) {
      hydrateAttempts += 1;
      if (hydrateAttempts <= 20) {
        clearTimeout(hydrateTimer);
        hydrateTimer = setTimeout(hydrateFromBackend, 250);
      }
      return;
    }
    hydrateAttempts = 0;
    hydrateBusy = true;
    var localWantsImport = localNeedsImport();
    var localDraft = toServer();
    Promise.resolve(api.get_appearance()).then(function (result) {
      if (state.dirty) return;
      state.readOnly = !!(result && result.read_only);
      var payload = unwrapAppearance(result);
      if (!fromServer(payload)) return;
      if (state.pending) {
        fromServer(localDraft);
        state.dirty = true;
        apply();
        showToast("本机外观草稿待保存");
        return;
      }

      var shouldImport = localWantsImport &&
        isDefaultAppearance(payload) &&
        !cacheFlag(IMPORT_KEY);
      if (shouldImport && state.readOnly) {
        fromServer(localDraft);
        state.dirty = true;
        apply();
        showToast("配置只读，已保留本机外观草稿");
        return;
      }
      if (shouldImport && api && typeof api.set_appearance === "function") {
        return Promise.resolve(api.set_appearance(localDraft)).then(function (saveResult) {
          if (!saveResult || saveResult.ok === false) {
            throw new Error(saveResult && saveResult.error ? saveResult.error : "导入被拒绝");
          }
          if (saveResult.appearance) fromServer(saveResult.appearance);
          setCacheFlag(IMPORT_KEY, "1");
          state.dirty = false;
          persistLocal();
          apply();
          showToast("已导入旧版外观到本机配置");
        }).catch(function (error) {
          fromServer(localDraft);
          state.dirty = true;
          apply();
          showToast("旧版外观未导入：" + (error && error.message ? error.message : "后端不可用"));
        });
      }

      setCacheFlag(IMPORT_KEY, "1");
      state.dirty = false;
      persistLocal();
      apply();
    }).catch(function () {
      // 后端不可用时保留 localStorage 缓存，静态预览与离线调试仍可用。
    }).then(function () {
      hydrateBusy = false;
    });
  }

  function touch() {
    state.dirty = true;
  }

  function saveAppearance() {
    if (saving) return;
    if (state.readOnly) {
      showToast("配置处于只读安全模式，无法写入外观");
      return;
    }
    var api = bridgeApi();
    if (!api || typeof api.set_appearance !== "function") {
      persistLocal();
      state.dirty = false;
      apply();
      showToast("已保存到本机缓存（桌面后端未就绪）");
      return;
    }

    saving = true;
    els.save.disabled = true;
    els.status.textContent = "正在写入本机配置…";
    Promise.resolve(api.set_appearance(toServer())).then(function (result) {
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : "后端拒绝保存");
      }
      var saved = result.appearance && typeof result.appearance === "object"
        ? result.appearance
        : toServer();
      fromServer(saved);
      state.pending = false;
      state.dirty = false;
      persistLocal();
      apply();
      els.status.textContent = "外观已保存 · " + (state.custom ? "自定义" : PRESETS[state.preset].label);
      showToast("外观已保存到本机配置");
    }).catch(function (error) {
      state.pending = true;
      persistLocal();
      els.status.textContent = "保存失败 · 草稿已缓存在本机";
      showToast(error && error.message ? error.message : "外观保存失败");
    }).then(function () {
      saving = false;
      els.save.disabled = state.readOnly;
    });
  }

  function showToast(text) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove("is-visible");
    }, 1800);
  }

  function focusable() {
    return Array.prototype.slice.call(
      els.modal.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")
    ).filter(function (node) {
      return node.getClientRects().length > 0;
    });
  }

  function open() {
    if (!els.mask) return;
    lastFocus = document.activeElement;
    els.mask.hidden = false;
    var app = document.querySelector(".app");
    if (app) app.inert = true;
    els.close.focus();
  }

  function close() {
    if (!els.mask) return;
    els.mask.hidden = true;
    var app = document.querySelector(".app");
    if (app) app.inert = false;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function bind() {
    els.trigger.addEventListener("click", open);
    els.close.addEventListener("click", close);
    els.mask.addEventListener("click", function (event) {
      if (event.target === els.mask) close();
    });
    document.addEventListener("keydown", function (event) {
      if (els.mask.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      var nodes = focusable();
      if (!nodes.length) return;
      var first = nodes[0];
      var last = nodes[nodes.length - 1];
      if (!els.modal.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    els.modal.querySelectorAll("[data-ap-theme]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.themeMode = button.getAttribute("data-ap-theme");
        touch();
        apply();
      });
    });

    els.modal.querySelectorAll("[data-ap-preset]").forEach(function (card) {
      card.addEventListener("click", function () {
        if (state.custom) return;
        state.preset = card.getAttribute("data-ap-preset");
        touch();
        apply();
      });
    });

    els.customToggle.addEventListener("click", function () {
      state.custom = !state.custom;
      touch();
      apply();
    });

    els.modal.querySelectorAll("[data-ap-accent]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.accent = button.getAttribute("data-ap-accent");
        touch();
        apply();
      });
    });
    els.color.addEventListener("input", function () {
      state.accent = safeHex(els.color.value, state.accent);
      touch();
      apply();
    });
    els.font.addEventListener("change", function () {
      state.font = els.font.value;
      touch();
      apply();
    });
    els.dotToggle.addEventListener("click", function () {
      state.pattern = state.pattern === "dots" ? "none" : "dots";
      touch();
      apply();
    });
    els.spacing.addEventListener("input", function () {
      state.spacing = clamp(els.spacing.value, 8, 40, 24);
      touch();
      apply();
    });
    els.dotSize.addEventListener("input", function () {
      state.dotSize = clamp(els.dotSize.value, 0.5, 4, 1.5);
      touch();
      apply();
    });
    els.monitorDotToggle.addEventListener("click", function () {
      state.monitorPattern = !state.monitorPattern;
      touch();
      apply();
    });
    els.radiusToggle.addEventListener("click", function () {
      state.radius = !state.radius;
      touch();
      apply();
    });
    els.radiusSize.addEventListener("input", function () {
      state.radius = true;
      state.radiusSize = clamp(els.radiusSize.value, 2, 18, 12);
      touch();
      apply();
    });
    els.reset.addEventListener("click", function () {
      state.custom = false;
      touch();
      apply();
      showToast("已恢复当前预设");
    });
    els.save.addEventListener("click", saveAppearance);
  }

  function template() {
    return [
      '<div class="ap-mask" id="apMask" hidden>',
      '  <section class="ap-card" id="apCard" role="dialog" aria-modal="true" aria-labelledby="apTitle" tabindex="-1">',
      '    <header class="ap-head">',
      '      <span class="ap-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.4-.7-.4-1.1 0-1 .8-1.8 1.8-1.8h2.1A4.2 4.2 0 0 0 21 10.4c0-3.8-4-6.9-9-6.9Z"/><circle cx="7.5" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="6.8" r=".8" fill="currentColor" stroke="none"/><circle cx="14.5" cy="6.6" r=".8" fill="currentColor" stroke="none"/><circle cx="17.3" cy="9.5" r=".8" fill="currentColor" stroke="none"/></svg></span>',
      '      <div class="ap-head-copy"><h2 id="apTitle">主题外观</h2><p id="apThemeCopy">工作台 · 夜航模式 · 同步主窗口与独立监看，直播浮窗保持独立样式</p></div>',
      '      <span class="ap-head-spacer"></span>',
      '      <span class="ap-head-state" id="apState">广播校样</span>',
      '      <button class="ap-icon-btn" id="apClose" type="button" aria-label="关闭外观设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>',
      '    </header>',
      '    <div class="ap-body">',
      '      <div class="ap-main">',
      '        <section class="ap-section">',
      '          <div class="ap-section-head"><b>明暗模式</b><span>只改变明暗，不改变预设与点阵</span></div>',
      '          <div class="ap-theme-mode" role="group" aria-label="明暗模式">',
      '            <button class="ap-theme-option" type="button" data-ap-theme="light" aria-pressed="false"><b>晨光</b><span>暖白纸面，适合日间与强环境光</span></button>',
      '            <button class="ap-theme-option is-selected" type="button" data-ap-theme="dark" aria-pressed="true"><b>夜航</b><span>低亮墨黑，适合长时间直播与副屏</span></button>',
      '            <button class="ap-theme-option" type="button" data-ap-theme="system" aria-pressed="false"><b>跟随系统</b><span>随 Windows 明暗设置自动切换</span></button>',
      '          </div>',
      '        </section>',
      '        <section class="ap-section">',
      '          <div class="ap-section-head"><b>预设外观</b><span id="apPresetHint">每个预设包含一套字体与几何</span></div>',
      '          <div class="ap-preset-grid">',
      '            <button class="ap-preset" type="button" data-ap-preset="cobalt" aria-pressed="false">',
      '              <span class="ap-preset-thumb is-cobalt"><span class="ap-thumb-top"><i></i><i></i><i></i></span><span class="ap-thumb-body"><span class="ap-thumb-rail"><i></i><i></i><i></i><i></i></span><span class="ap-thumb-main"><span class="ap-thumb-headline"></span><span class="ap-thumb-sub"></span><span class="ap-thumb-bars"><i></i><i></i><i></i><i></i></span></span></span></span>',
      '              <span class="ap-preset-copy"><b>钴蓝点阵</b><span>钴蓝主色、24px 点阵、圆角与系统无衬线。</span></span>',
      '              <span class="ap-preset-tags"><em>点阵 24px</em><em>圆角</em><em>钴蓝</em></span>',
      '            </button>',
      '            <button class="ap-preset is-selected" type="button" data-ap-preset="broadcast" aria-pressed="true">',
      '              <span class="ap-preset-thumb"><span class="ap-thumb-top"><i></i><i></i><i></i></span><span class="ap-thumb-body"><span class="ap-thumb-rail"><i></i><i></i><i></i><i></i></span><span class="ap-thumb-main"><span class="ap-thumb-headline"></span><span class="ap-thumb-sub"></span><span class="ap-thumb-bars"><i></i><i></i><i></i><i></i></span></span></span></span>',
      '              <span class="ap-preset-copy"><b>广播校样</b><span>冷灰纸面、信号橙、直角与 1px 规则线。</span></span>',
      '              <span class="ap-preset-tags"><em>无点阵</em><em>直角</em><em>信号橙</em></span>',
      '            </button>',
      '          </div>',
      '        </section>',
      '        <section class="ap-section">',
      '          <div class="ap-section-head"><b>监看显示</b><span>独立于主工作台的点阵开关</span></div>',
      '          <div class="ap-field"><span>监看窗口点阵</span><button class="ap-switch" id="apMonitorDotToggle" type="button" role="switch" aria-checked="true" aria-label="监看窗口点阵"></button><span class="ap-hint">单独控制独立监看；关闭不影响主工作台。</span></div>',
      '        </section>',
      '        <section class="ap-section">',
      '          <div class="ap-section-head"><b>自定义外观</b><span>开启后预设变灰，以下选项实时生效</span></div>',
      '          <div class="ap-custom-switch"><div class="ap-custom-switch-copy"><b>自定义外观</b><span>组合点阵、圆角、主题色和字体；可以随时回到预设。</span></div><button class="ap-switch" id="apCustomToggle" type="button" role="switch" aria-checked="false" aria-label="开启自定义外观"></button></div>',
      '          <div class="ap-custom-panel" id="apCustomPanel" hidden>',
      '            <div class="ap-custom-grid">',
      '              <label class="ap-field"><span>主题色</span><span class="ap-swatches"><button class="ap-swatch" type="button" data-ap-accent="#7C8CFF" style="--sw:#7C8CFF" aria-label="钴蓝"></button><button class="ap-swatch is-selected" type="button" data-ap-accent="#FF5F3A" style="--sw:#FF5F3A" aria-label="信号橙"></button><button class="ap-swatch" type="button" data-ap-accent="#78C4A4" style="--sw:#78C4A4" aria-label="翡翠绿"></button><button class="ap-swatch" type="button" data-ap-accent="#B59BFF" style="--sw:#B59BFF" aria-label="紫罗兰"></button><button class="ap-swatch" type="button" data-ap-accent="#F1F3ED" style="--sw:#F1F3ED" aria-label="纸白"></button><input class="ap-color" id="apColor" type="color" value="#FF5F3A" aria-label="自定义主题色"></span></label>',
      '              <label class="ap-field"><span>字体</span><select class="ap-select" id="apFont"><option value="broadcast">广播窄体 · Bahnschrift</option><option value="system">系统无衬线 · Segoe UI</option><option value="humanist">中文人文黑体 · 系统字体</option></select></label>',
      '              <div class="ap-field"><span>点阵背景</span><button class="ap-switch" id="apDotToggle" type="button" role="switch" aria-checked="false" aria-label="点阵背景"></button><span class="ap-hint">点阵只出现在工作台背景，不进入直播浮窗。</span></div>',
      '              <label class="ap-field"><span>点阵间距</span><span class="ap-range-row"><input class="ap-range" id="apSpacing" type="range" min="8" max="40" step="1" value="24" aria-label="点阵间距"><output class="ap-value" id="apSpacingValue">24px</output></span><span class="ap-hint">8–40px；钴蓝默认 24px。</span></label>',
      '              <label class="ap-field"><span>点阵大小</span><span class="ap-range-row"><input class="ap-range" id="apDotSize" type="range" min="0.5" max="4" step="0.25" value="1.5" aria-label="点阵大小"><output class="ap-value" id="apDotSizeValue">1.5px</output></span><span class="ap-hint">像素点直径；与点阵间距独立。</span></label>',
      '              <div class="ap-field"><span>圆角界面</span><button class="ap-switch" id="apRadiusToggle" type="button" role="switch" aria-checked="false" aria-label="圆角界面"></button><span class="ap-hint">关闭时为广播校样直角。</span></div>',
      '              <label class="ap-field"><span>圆角大小</span><span class="ap-range-row"><input class="ap-range" id="apRadiusSize" type="range" min="2" max="18" step="1" value="12" aria-label="圆角大小"><output class="ap-value" id="apRadiusSizeValue">12px</output></span></label>',
      '            </div>',
      '            <div class="ap-future"><b>后续开放</b>阴影强度、界面密度、按钮形状、图表色板、行高与字重。配置接口已预留。</div>',
      '          </div>',
      '        </section>',
      '      </div>',
      '      <aside class="ap-preview-pane" aria-label="外观实时预览">',
      '        <div class="ap-preview-label"><i></i>工作台预览</div>',
      '        <div class="ap-preview-shell"><div class="ap-preview-topbar"><i></i><b>ReadMe 预览</b><span>LIVE</span></div><div class="ap-preview-body"><div class="ap-preview-hero"><small>正在直播</small><b>夜航电台</b><span>02:14:37 · B站音乐区</span></div><div class="ap-preview-cards"><i></i><i></i><i></i></div><div class="ap-preview-table"><div class="ap-preview-row head"><span>时间</span><span>类型</span><span>内容</span><span>状态</span></div><div class="ap-preview-row"><span>22:14</span><b>弹幕</b><em>刚进来，请问前面唱的是哪一首？</em><i></i></div><div class="ap-preview-row"><span>22:13</span><b>SC</b><em>把这首歌送给正在加班的朋友们。</em><i></i></div><div class="ap-preview-row"><span>22:12</span><b>礼物</b><em>送出 心动话筒 ×1</em><i></i></div></div></div></div>',
      '        <p class="ap-note">外观会同步到独立监看；监看点阵可在自定义外观中单独关闭，直播浮窗保持独立样式。</p>',
      '      </aside>',
      '    </div>',
      '    <footer class="ap-foot"><span class="ap-foot-state" id="apStatus">外观预设 · 广播校样</span><span class="ap-foot-spacer"></span><button class="ap-btn" id="apReset" type="button">恢复预设</button><button class="ap-btn ap-btn-primary" id="apSave" type="button">保存外观</button></footer>',
      '  </section>',
      '</div>',
      '<div class="ap-toast" id="apToast" role="status" aria-live="polite"></div>'
    ].join("");
  }

  function init() {
    var topRight = document.querySelector(".topbar-right");
    if (!topRight) return;
    var trigger = document.createElement("button");
    trigger.id = "appearanceBtn";
    trigger.type = "button";
    trigger.className = "account-btn overlay-btn appearance-trigger";
    trigger.title = "主题外观";
    trigger.setAttribute("aria-label", "打开主题外观");
    trigger.innerHTML = '<span class="overlay-btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.4-.7-.4-1.1 0-1 .8-1.8 1.8-1.8h2.1A4.2 4.2 0 0 0 21 10.4c0-3.8-4-6.9-9-6.9Z"/><circle cx="7.5" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="6.8" r=".8" fill="currentColor" stroke="none"/><circle cx="14.5" cy="6.6" r=".8" fill="currentColor" stroke="none"/><circle cx="17.3" cy="9.5" r=".8" fill="currentColor" stroke="none"/></svg></span><span class="overlay-btn-label">外观</span>';
    var monitor = topRight.querySelector("#monitorBtn");
    if (monitor) topRight.insertBefore(trigger, monitor);
    else topRight.appendChild(trigger);

    var holder = document.createElement("div");
    holder.innerHTML = template();
    while (holder.firstChild) document.body.appendChild(holder.firstChild);

    els.trigger = trigger;
    els.mask = $("apMask");
    els.modal = $("apCard");
    els.close = $("apClose");
    els.state = $("apState");
    els.themeCopy = $("apThemeCopy");
    els.status = $("apStatus");
    els.presetHint = $("apPresetHint");
    els.customToggle = $("apCustomToggle");
    els.customPanel = $("apCustomPanel");
    els.color = $("apColor");
    els.font = $("apFont");
    els.dotToggle = $("apDotToggle");
    els.spacing = $("apSpacing");
    els.spacingValue = $("apSpacingValue");
    els.dotSize = $("apDotSize");
    els.dotSizeValue = $("apDotSizeValue");
    els.monitorDotToggle = $("apMonitorDotToggle");
    els.radiusToggle = $("apRadiusToggle");
    els.radiusSize = $("apRadiusSize");
    els.radiusSizeValue = $("apRadiusSizeValue");
    els.reset = $("apReset");
    els.save = $("apSave");
    els.toast = $("apToast");

    loadLocal();
    apply();
    bind();
    hydrateFromBackend();
    window.addEventListener("pywebviewready", hydrateFromBackend);
    if (systemTheme) {
      var onSystemThemeChange = function () {
        if (state.themeMode === "system") apply();
      };
      if (typeof systemTheme.addEventListener === "function") {
        systemTheme.addEventListener("change", onSystemThemeChange);
      } else if (typeof systemTheme.addListener === "function") {
        systemTheme.addListener(onSystemThemeChange);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
