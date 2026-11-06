/* ============================================================
   ReadMe · overlay six-layer preset import/export
   Layers: content / style / layout / animation / template / preset meta.
   Imported JSON is validated before it can touch the workbench draft.
   ============================================================ */
(function () {
  "use strict";
  var ctx = window.MutaiApp;
  var wb = ctx && ctx.workbench;
  if (!ctx || !wb) throw new Error("workbench context missing");
  var wbState = wb.state;
  var helpers = wb.helpers;
  var wbClone = helpers.wbClone;
  var wbMarkDirty = helpers.wbMarkDirty;
  var wbShowToast = helpers.wbShowToast;
  var wbNormalizeStylePatch = helpers.wbNormalizeStylePatch;
  var wbNormalizeMotionPartial = helpers.wbNormalizeMotionPartial;
  var wbNormalizeTypographyPatch = helpers.wbNormalizeTypographyPatch;
  var WB_TYPES = wb.constants.WB_TYPES;
  var wbTypesForPlatform = wb.helpers.wbTypesForPlatform;
  var wbPlatform = wb.helpers.wbPlatform;
  var WB_STYLE_FIELDS = wb.constants.WB_STYLE_FIELDS;
  var WB_MOTION_FIELDS = wb.constants.WB_MOTION_FIELDS;
  var WB_TYPOGRAPHY_FIELDS = wb.constants.WB_TYPOGRAPHY_FIELDS;

  var TEMPLATES = {
    bubble: { label: "气泡 · 标准", maxLines: 8, gap: 8, align: "left", showName: true },
    compact: { label: "气泡 · 紧凑", maxLines: 5, gap: 4, align: "left", showName: false },
    focus: { label: "气泡 · 专注", maxLines: 3, gap: 12, align: "center", showName: true },
  };
  var VALID_THEMES = ["classic", "shortvideo", "minimal", "highcontrast"];
  var parsed = null;
  var importedMeta = null;
  var bound = false;

  function $(id) {
    return document.getElementById(id);
  }

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function has(source, key) {
    return Object.prototype.hasOwnProperty.call(source, key);
  }

  function setStatus(text, kind) {
    var el = $("wbPresetStatus");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", kind === "error");
    el.classList.toggle("is-ok", kind === "ok");
  }

  function setApplyEnabled(enabled) {
    var button = $("wbPresetApply");
    if (button) button.disabled = !enabled;
  }

  function byteLength(text) {
    try {
      if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
      return unescape(encodeURIComponent(text)).length;
    } catch (e) {
      return text.length;
    }
  }

  function fail(message) {
    throw new Error(message);
  }

  function strictBoolean(value, name) {
    if (typeof value !== "boolean") fail(name + " 必须是布尔值");
    return value;
  }

  function strictInteger(value, min, max, name) {
    if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value ||
      value < min || value > max) {
      fail(name + " 必须是 " + min + "–" + max + " 的整数");
    }
    return value;
  }

  function strictString(value, max, name) {
    if (typeof value !== "string" || !value.length || value.length > max) {
      fail(name + " 必须是 1–" + max + " 字符的字符串");
    }
    return value;
  }

  function warnUnknown(source, allowed, prefix, warnings) {
    Object.keys(source).forEach(function (key) {
      if (allowed.indexOf(key) < 0) warnings.push(prefix + "." + key + " 已忽略");
    });
  }

  function normalizeTypes(source, warnings) {
    if (!isPlainObject(source)) fail("content.types 必须是对象");
    var out = {};
    Object.keys(source).forEach(function (key) {
      if (WB_TYPES.indexOf(key) < 0) {
        warnings.push("content.types." + key + " 已忽略");
        return;
      }
      out[key] = strictBoolean(source[key], "content.types." + key);
    });
    return out;
  }

  function normalizeContent(source, warnings) {
    if (!isPlainObject(source)) fail("content 层必须是对象");
    var out = {};
    if (has(source, "show_name")) out.show_name = strictBoolean(source.show_name, "content.show_name");
    if (has(source, "name_separator")) {
      out.name_separator = strictString(source.name_separator, 4, "content.name_separator");
    }
    if (has(source, "name_max_len")) {
      out.name_max_len = strictInteger(source.name_max_len, 4, 24, "content.name_max_len");
    }
    if (has(source, "text_max_len")) {
      out.text_max_len = strictInteger(source.text_max_len, 1, 10000, "content.text_max_len");
    }
    if (has(source, "max_lines")) {
      out.max_lines = strictInteger(source.max_lines, 0, 30, "content.max_lines");
    }
    if (has(source, "types")) out.types = normalizeTypes(source.types, warnings);
    warnUnknown(source, ["show_name", "name_separator", "name_max_len", "text_max_len", "max_lines", "types", "overflow"], "content", warnings);
    if (has(source, "overflow")) warnings.push("content.overflow 尚未进入渲染层，已忽略");
    if (!Object.keys(out).length) fail("content 层没有可应用字段");
    return out;
  }

  function normalizePins(source, warnings) {
    if (!isPlainObject(source)) fail("layout.pins 必须是对象");
    var lanes = ["gift", "sc", "guard"];
    var out = {};
    Object.keys(source).forEach(function (lane) {
      if (lanes.indexOf(lane) < 0) {
        warnings.push("layout.pins." + lane + " 已忽略");
        return;
      }
      var raw = source[lane];
      if (!isPlainObject(raw)) fail("layout.pins." + lane + " 必须是对象");
      var laneOut = {};
      if (has(raw, "enabled")) laneOut.enabled = strictBoolean(raw.enabled, "layout.pins." + lane + ".enabled");
      if (has(raw, "position")) {
        if (raw.position !== "top" && raw.position !== "bottom") {
          fail("layout.pins." + lane + ".position 仅支持 top / bottom");
        }
        laneOut.position = raw.position;
      }
      if (has(raw, "duration_ms")) {
        laneOut.duration_ms = strictInteger(raw.duration_ms, 2000, 30000, "layout.pins." + lane + ".duration_ms");
      }
      if (has(raw, "max")) laneOut.max = strictInteger(raw.max, 1, 6, "layout.pins." + lane + ".max");
      if (lane === "gift" && has(raw, "min_price")) {
        if (typeof raw.min_price !== "number" || !isFinite(raw.min_price) ||
          raw.min_price < 0 || raw.min_price > 100000) {
          fail("layout.pins.gift.min_price 必须是 0–100000 的数字");
        }
        laneOut.min_price = raw.min_price;
      }
      warnUnknown(raw, ["enabled", "position", "duration_ms", "max", "min_price"], "layout.pins." + lane, warnings);
      if (!Object.keys(laneOut).length) fail("layout.pins." + lane + " 没有可应用字段");
      out[lane] = laneOut;
    });
    return out;
  }

  function normalizeLayout(source, warnings) {
    if (!isPlainObject(source)) fail("layout 层必须是对象");
    var out = {};
    if (has(source, "align")) {
      if (["left", "center", "right"].indexOf(source.align) < 0) fail("layout.align 仅支持 left / center / right");
      out.align = source.align;
    }
    if (has(source, "gap_px")) out.gap = strictInteger(source.gap_px, 0, 40, "layout.gap_px");
    else if (has(source, "gap")) out.gap = strictInteger(source.gap, 0, 40, "layout.gap");
    if (has(source, "pins")) out.pins = normalizePins(source.pins, warnings);
    warnUnknown(source, ["align", "gap_px", "gap", "pins"], "layout", warnings);
    if (!Object.keys(out).length) fail("layout 层没有可应用字段");
    return out;
  }

  function normalizeStylePatch(source, prefix, warnings) {
    if (!isPlainObject(source)) fail(prefix + " 必须是对象");
    var input = wbClone(source);
    if (has(input, "color") && !has(input, "text_color")) input.text_color = input.color;
    var patch = wbNormalizeStylePatch(input);
    Object.keys(source).forEach(function (key) {
      if (key === "color") {
        if (source.color !== null && !has(patch, "text_color")) fail(prefix + ".color 非法");
        return;
      }
      if (WB_STYLE_FIELDS.indexOf(key) < 0) {
        warnings.push(prefix + "." + key + " 已忽略");
        return;
      }
      if (source[key] !== null && !has(patch, key)) fail(prefix + "." + key + " 非法");
    });
    return patch;
  }

  function normalizeTypographyPatch(source, prefix, warnings) {
    if (!isPlainObject(source)) fail(prefix + " 必须是对象");
    var patch = wbNormalizeTypographyPatch(source);
    Object.keys(source).forEach(function (key) {
      if (WB_TYPOGRAPHY_FIELDS.indexOf(key) < 0) {
        warnings.push(prefix + "." + key + " 已忽略");
        return;
      }
      if (source[key] !== null && !has(patch, key)) fail(prefix + "." + key + " 非法");
    });
    return patch;
  }

  function normalizeMotionPatch(source, prefix, warnings) {
    if (!isPlainObject(source)) fail(prefix + " 必须是对象");
    var patch = wbNormalizeMotionPartial(source);
    Object.keys(source).forEach(function (key) {
      if (WB_MOTION_FIELDS.indexOf(key) < 0) {
        warnings.push(prefix + "." + key + " 已忽略");
        return;
      }
      if (source[key] === null) {
        patch[key] = null;
        return;
      }
      if (!has(patch, key)) fail(prefix + "." + key + " 非法");
    });
    return patch;
  }

  function normalizeTypePatches(source, prefix, normalizer, warnings) {
    if (!isPlainObject(source)) fail(prefix + " 必须是对象");
    var out = {};
    Object.keys(source).forEach(function (key) {
      if (WB_TYPES.indexOf(key) < 0) {
        warnings.push(prefix + "." + key + " 已忽略");
        return;
      }
      out[key] = normalizer(source[key], prefix + "." + key, warnings);
      if (!Object.keys(out[key]).length) fail(prefix + "." + key + " 没有可应用字段");
    });
    if (!Object.keys(out).length) fail(prefix + " 没有可应用类型");
    return out;
  }

  function normalizeStyle(source, warnings) {
    if (!isPlainObject(source)) fail("style 层必须是对象");
    var out = {};
    if (has(source, "theme")) {
      if (VALID_THEMES.indexOf(source.theme) < 0) fail("style.theme 非法");
      out.theme = source.theme;
    }
    if (has(source, "global")) out.global = normalizeStylePatch(source.global, "style.global", warnings);
    if (has(source, "types")) {
      out.types = normalizeTypePatches(source.types, "style.types", normalizeStylePatch, warnings);
    }
    if (has(source, "typography")) {
      if (!isPlainObject(source.typography)) fail("style.typography 必须是对象");
      var typography = {};
      if (has(source.typography, "global")) {
        typography.global = normalizeTypographyPatch(source.typography.global, "style.typography.global", warnings);
      }
      if (has(source.typography, "types")) {
        typography.types = normalizeTypePatches(
          source.typography.types, "style.typography.types", normalizeTypographyPatch, warnings
        );
      }
      if (!Object.keys(typography).length) fail("style.typography 没有可应用字段");
      out.typography = typography;
    }
    warnUnknown(source, ["theme", "global", "types", "typography"], "style", warnings);
    if (!Object.keys(out).length) fail("style 层没有可应用字段");
    return out;
  }

  function normalizeAnimation(source, warnings) {
    if (!isPlainObject(source)) fail("animation 层必须是对象");
    var out = {};
    if (has(source, "global")) out.global = normalizeMotionPatch(source.global, "animation.global", warnings);
    if (has(source, "types")) {
      out.types = normalizeTypePatches(source.types, "animation.types", normalizeMotionPatch, warnings);
    }
    warnUnknown(source, ["global", "types"], "animation", warnings);
    if (!Object.keys(out).length) fail("animation 层没有可应用字段");
    return out;
  }

  function normalizeTemplate(source) {
    if (!isPlainObject(source)) fail("template 层必须是对象");
    var id = source.id || "bubble";
    if (!TEMPLATES[id]) fail("template.id 仅支持 bubble / compact / focus");
    return { id: id };
  }

  function normalizeMeta(source) {
    var src = isPlainObject(source) ? source : {};
    return {
      id: typeof src.id === "string" ? src.id.slice(0, 96) : "",
      name: typeof src.name === "string" ? src.name.slice(0, 80) : "未命名预设",
      version: typeof src.version === "string" ? src.version.slice(0, 32) : "",
      tags: Array.isArray(src.tags) ? src.tags.slice(0, 8).map(function (x) { return String(x).slice(0, 24); }) : [],
    };
  }

  function parsePack(text) {
    if (typeof text !== "string" || !text.trim()) fail("JSON 为空");
    if (byteLength(text) > 1048576) fail("JSON 超过 1 MiB 限制");
    var raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      fail("JSON 解析失败：" + err.message);
    }
    if (!isPlainObject(raw)) fail("顶层必须是对象");
    if (raw.format !== "readme.danmaku-preset" && raw.format !== "mutai.danmaku-preset") {
      fail("format 必须为 readme.danmaku-preset（兼容 mutai.danmaku-preset）");
    }
    var version = raw.format_version == null && raw.format === "mutai.danmaku-preset" ? 1 : raw.format_version;
    if (version !== 1) fail("format_version 必须为 1");
    if (!isPlainObject(raw.layers)) fail("layers 必须是对象");
    var sourceLayers = raw.layers;
    var warnings = [];
    var layers = {};
    if (has(sourceLayers, "content")) layers.content = normalizeContent(sourceLayers.content, warnings);
    if (has(sourceLayers, "style")) layers.style = normalizeStyle(sourceLayers.style, warnings);
    if (has(sourceLayers, "layout")) layers.layout = normalizeLayout(sourceLayers.layout, warnings);
    if (has(sourceLayers, "animation")) layers.animation = normalizeAnimation(sourceLayers.animation, warnings);
    if (has(sourceLayers, "motion")) layers.animation = normalizeAnimation(sourceLayers.motion, warnings);
    if (has(sourceLayers, "template")) layers.template = normalizeTemplate(sourceLayers.template);
    warnUnknown(sourceLayers, ["content", "style", "layout", "animation", "motion", "template"], "layers", warnings);
    if (!Object.keys(layers).length) fail("没有可应用的层");
    return {
      meta: normalizeMeta(raw.preset || raw),
      layers: layers,
      warnings: warnings,
    };
  }

  function syncControls() {
    var draft = wbState.draft;
    if (!draft) return;
    $("wbPresetShowName").checked = !!draft.showName;
    $("wbPresetNameSep").value = draft.nameSeparator || "：";
    $("wbPresetNameMax").value = String(draft.nameMaxLen || 12);
    $("wbPresetTextMax").value = String(draft.textMaxLen || 100);
    $("wbPresetMaxLines").value = String(draft.maxLines || 8);
    $("wbPresetGap").value = String(draft.gap === undefined ? 8 : draft.gap);
    $("wbPresetAlign").value = draft.align || "left";
    var typeBox = $("wbPresetTypes");
    if (typeBox) {
      var types = wbTypesForPlatform();
      var sig = types.join(",");
      if (typeBox.getAttribute("data-platform-types") !== sig) {
        var labels = {
          danmaku: "弹幕", gift: "礼物", super_chat: "SC", guard: "舰长",
          enter: "入场", like: "点赞", social: "关注", fansclub: "粉丝团"
        };
        typeBox.innerHTML = types.map(function (type) {
          return '<label><input type="checkbox" data-wb-preset-type="' + type + '">' +
            labels[type] + '</label>';
        }).join("");
        typeBox.setAttribute("data-platform-types", sig);
      }
    }
    document.querySelectorAll("[data-wb-preset-type]").forEach(function (el) {
      el.checked = !!(draft.types && draft.types[el.getAttribute("data-wb-preset-type")]);
    });
    $("wbPresetTemplate").value = TEMPLATES[draft.templateId] ? draft.templateId : "bubble";
  }

  function reset() {
    parsed = null;
    importedMeta = null;
    if ($("wbPresetText")) $("wbPresetText").value = "";
    setApplyEnabled(false);
    setStatus("等待导入预设包。当前编辑内容会随“导出当前”写入六层 JSON。", "");
  }

  function render() {
    bind();
    syncControls();
    if (!parsed) {
      setStatus("等待导入预设包。当前编辑内容会随“导出当前”写入六层 JSON。", "");
    }
  }

  function applyTemplate(id) {
    var tpl = TEMPLATES[id];
    if (!tpl) return;
    wbState.draft.templateId = id;
    wbState.draft.maxLines = tpl.maxLines;
    wbState.draft.gap = tpl.gap;
    wbState.draft.align = tpl.align;
    wbState.draft.showName = tpl.showName;
  }

  function mergeStyleLayer(layer) {
    if (!layer) return;
    if (layer.theme) wbState.draft.styles.theme = layer.theme;
    if (layer.global) {
      wbState.draft.styles.global = Object.assign({}, wbState.draft.styles.global || {}, layer.global);
    }
    if (layer.types) {
      wbState.draft.styles.types = wbState.draft.styles.types || {};
      Object.keys(layer.types).forEach(function (type) {
        wbState.draft.styles.types[type] = Object.assign(
          {}, wbState.draft.styles.types[type] || {}, layer.types[type]
        );
      });
    }
    if (layer.typography) mergeTypographyLayer(layer.typography);
  }

  function mergeMotionLayer(layer) {
    var draft = wbState.draft.motion || {};
    if (layer.global) draft.global = Object.assign({}, draft.global || {}, layer.global);
    if (layer.types) {
      draft.types = draft.types || {};
      Object.keys(layer.types).forEach(function (type) {
        draft.types[type] = Object.assign({}, draft.types[type] || {}, layer.types[type]);
      });
    }
    wbState.draft.motion = draft;
  }

  function mergeTypographyLayer(layer) {
    var draft = wbState.draft.typography || {};
    if (layer.global) draft.global = Object.assign({}, draft.global || {}, layer.global);
    if (layer.types) {
      draft.types = draft.types || {};
      Object.keys(layer.types).forEach(function (type) {
        draft.types[type] = Object.assign({}, draft.types[type] || {}, layer.types[type]);
      });
    }
    wbState.draft.typography = draft;
  }

  function applyParsed() {
    if (!parsed || !wbState.draft) return;
    var selected = {};
    document.querySelectorAll("[data-wb-preset-layer]").forEach(function (el) {
      if (el.checked) selected[el.getAttribute("data-wb-preset-layer")] = true;
    });
    var layers = parsed.layers;
    var applied = Object.keys(selected).filter(function (name) { return !!layers[name]; });
    if (!applied.length) {
      setStatus("没有勾选可用的层；草稿未修改。", "error");
      return;
    }
    if (selected.template && layers.template) applyTemplate(layers.template.id);
    var content = selected.content && layers.content;
    if (content) {
      if (content.show_name !== undefined) wbState.draft.showName = content.show_name;
      if (content.name_separator !== undefined) wbState.draft.nameSeparator = content.name_separator;
      if (content.name_max_len !== undefined) wbState.draft.nameMaxLen = content.name_max_len;
      if (content.text_max_len !== undefined) wbState.draft.textMaxLen = content.text_max_len;
      if (content.max_lines !== undefined) wbState.draft.maxLines = content.max_lines;
      if (content.types) {
        wbState.draft.types = wbState.draft.types || {};
        Object.keys(content.types).forEach(function (type) {
          wbState.draft.types[type] = content.types[type];
        });
      }
    }
    var layout = selected.layout && layers.layout;
    if (layout) {
      if (layout.align !== undefined) wbState.draft.align = layout.align;
      if (layout.gap !== undefined) wbState.draft.gap = layout.gap;
      if (layout.pins) {
        wbState.draft.pins = wbState.draft.pins || {};
        Object.keys(layout.pins).forEach(function (lane) {
          wbState.draft.pins[lane] = Object.assign({}, wbState.draft.pins[lane] || {}, layout.pins[lane]);
        });
      }
    }
    var style = selected.style && layers.style;
    if (style) mergeStyleLayer(style);
    var animation = selected.animation && layers.animation;
    if (animation) mergeMotionLayer(animation);
    wbState.presetGlobalLayers = {
      motion: !!(animation && animation.global),
      typography: !!(style && style.typography && style.typography.global),
    };
    importedMeta = parsed.meta;
    wbMarkDirty();
    if (ctx.modules.wbCore && ctx.modules.wbCore.wbRenderAll) ctx.modules.wbCore.wbRenderAll();
    syncControls();
    var templateNote = selected.template && layers.template
      ? "\n模板层会写入结构默认值（行数/间距/对齐/用户名），内容/布局层随后覆盖。"
      : "";
    setStatus("预览已应用：实际写入 " + applied.length + " 层。请检查样式页/预览后点保存。" +
      templateNote +
      (parsed.warnings.length ? "\n警告：\n- " + parsed.warnings.join("\n- ") : ""), "ok");
    wbShowToast("预设已应用到草稿，尚未保存");
  }

  function buildCurrentPack() {
    var draft = wbState.draft;
    return {
      format: "readme.danmaku-preset",
      format_version: 1,
      name: importedMeta && importedMeta.name ? importedMeta.name : "当前浮窗设置",
      preset: {
        id: importedMeta && importedMeta.id ? importedMeta.id : "readme.current",
        name: importedMeta && importedMeta.name ? importedMeta.name : "当前浮窗设置",
        version: importedMeta && importedMeta.version ? importedMeta.version : "1.0.0",
        tags: importedMeta && importedMeta.tags ? importedMeta.tags : [],
      },
      layers: {
        content: {
          show_name: !!draft.showName,
          name_separator: draft.nameSeparator || "：",
          name_max_len: draft.nameMaxLen,
          text_max_len: draft.textMaxLen,
          max_lines: draft.maxLines,
          types: wbClone(draft.types),
        },
        style: {
          theme: draft.styles.theme,
          global: wbClone(draft.styles.global),
          types: wbClone(draft.styles.types),
          typography: wbClone(draft.typography),
        },
        layout: {
          align: draft.align,
          gap_px: draft.gap,
          pins: wbClone(draft.pins),
        },
        animation: wbClone(draft.motion),
        template: { id: draft.templateId || "bubble" },
      },
    };
  }

  function exportCurrent() {
    if (ctx.modules.wbCore && typeof ctx.modules.wbCore.wbClampDraft === "function") {
      ctx.modules.wbCore.wbClampDraft();
      syncControls();
    }
    var text = JSON.stringify(buildCurrentPack(), null, 2);
    try {
      parsePack(text);
    } catch (err) {
      setStatus("导出前校验失败：" + (err && err.message ? err.message : String(err)), "error");
      return;
    }
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "readme-overlay-preset.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus("已导出当前六层预设。", "ok");
  }

  function validateCurrentText() {
    try {
      parsed = parsePack($("wbPresetText").value);
      setApplyEnabled(true);
      var layerNames = Object.keys(parsed.layers);
      setStatus("校验通过：" + (parsed.meta.name || "未命名预设") +
        "\n可应用层：" + layerNames.join(" / ") +
        (parsed.warnings.length ? "\n警告：\n- " + parsed.warnings.join("\n- ") : ""), "ok");
    } catch (err) {
      parsed = null;
      setApplyEnabled(false);
      setStatus("校验失败：" + (err && err.message ? err.message : String(err)), "error");
    }
  }

  function clearParsedForEdit() {
    parsed = null;
    setApplyEnabled(false);
    setStatus("内容已修改，请重新校验后再应用。", "");
  }

  function clampFormDraft() {
    if (ctx.modules.wbCore && typeof ctx.modules.wbCore.wbClampDraft === "function") {
      ctx.modules.wbCore.wbClampDraft();
    }
    syncControls();
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > 1048576) {
      parsed = null;
      setApplyEnabled(false);
      setStatus("文件超过 1 MiB 限制。", "error");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      $("wbPresetText").value = String(reader.result || "");
      validateCurrentText();
    };
    reader.onerror = function () {
      parsed = null;
      setApplyEnabled(false);
      setStatus("读取文件失败。", "error");
    };
    reader.readAsText(file, "utf-8");
  }

  function bind() {
    if (bound) return;
    bound = true;
    $("wbPresetChoose").addEventListener("click", function () { $("wbPresetFile").click(); });
    $("wbPresetFile").addEventListener("change", function (event) {
      readFile(event.target.files && event.target.files[0]);
      event.target.value = "";
    });
    $("wbPresetExport").addEventListener("click", exportCurrent);
    $("wbPresetValidate").addEventListener("click", validateCurrentText);
    $("wbPresetApply").addEventListener("click", applyParsed);
    $("wbPresetText").addEventListener("input", clearParsedForEdit);
    $("wbPresetTemplate").addEventListener("change", function (event) {
      applyTemplate(event.target.value);
      wbMarkDirty();
      syncControls();
      clearParsedForEdit();
    });
    ["wbPresetShowName", "wbPresetNameSep", "wbPresetNameMax", "wbPresetTextMax", "wbPresetMaxLines", "wbPresetGap", "wbPresetAlign"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", function () {
        var draft = wbState.draft;
        if (id === "wbPresetShowName") draft.showName = el.checked;
        if (id === "wbPresetNameSep") draft.nameSeparator = String(el.value || "：").slice(0, 4);
        if (id === "wbPresetNameMax") draft.nameMaxLen = Number(el.value);
        if (id === "wbPresetTextMax") draft.textMaxLen = Number(el.value);
        if (id === "wbPresetMaxLines") draft.maxLines = Number(el.value);
        if (id === "wbPresetGap") draft.gap = Number(el.value);
        if (id === "wbPresetAlign") draft.align = el.value;
        clampFormDraft();
        clearParsedForEdit();
        wbMarkDirty();
      });
    });
    var presetTypes = $("wbPresetTypes");
    if (presetTypes) {
      presetTypes.addEventListener("change", function (event) {
        var input = event.target;
        if (!input || !input.matches || !input.matches("[data-wb-preset-type]")) return;
        wbState.draft.types[input.getAttribute("data-wb-preset-type")] = input.checked;
        clearParsedForEdit();
        wbMarkDirty();
      });
    }
  }

  function debugSnapshot() {
    return {
      parsed: parsed ? wbClone(parsed) : null,
      importedMeta: importedMeta ? wbClone(importedMeta) : null,
      current: buildCurrentPack(),
    };
  }

  ctx.modules.wbPresets = {
    render: render,
    reset: reset,
    parsePack: parsePack,
    buildCurrentPack: buildCurrentPack,
    debugSnapshot: debugSnapshot,
  };
  window.__wbPresetDebug = debugSnapshot;
})();
