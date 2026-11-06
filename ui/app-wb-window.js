/* ============================================================
   幕台 · 工作台窗口域（几何 / 主题 / 显示 / 捕获提示）
   依赖 app-core + app-wb-core 的 MutaiApp.workbench context。
   ============================================================ */
(function () {
  "use strict";
  var ctx = window.MutaiApp;
  var wb = ctx && ctx.workbench;
  if (!ctx || !wb) throw new Error("workbench context missing");
  var state = ctx.state;
  var wbState = wb.state;
  var wbDom = wb.dom;
  var clamp = wb.helpers.clamp;
  var deepMerge = ctx.helpers.deepMerge;
  var defaultConfig = ctx.helpers.defaultConfig;
  var numFromStr = ctx.helpers.numFromStr;
  var overlayApi = ctx.helpers.overlayApi;
  var overlayErrorText = ctx.helpers.overlayErrorText;
  var extractOverlayConfig = ctx.helpers.extractOverlayConfig;
  var setLog = ctx.helpers.setLog;
  var setOverlayButtonActive = ctx.helpers.setOverlayButtonActive;
  var wbActiveTheme = wb.helpers.wbActiveTheme;
  var wbMarkDirty = wb.helpers.wbMarkDirty;
  var wbRenderBaseline = wb.helpers.wbRenderBaseline;
  var wbRenderEditor = wb.helpers.wbRenderEditor;
  var wbResolveBaseStyle = wb.helpers.wbResolveBaseStyle;
  var wbRound = wb.helpers.wbRound;
  var wbFinite = wb.helpers.wbFinite;
  var wbSetError = wb.helpers.wbSetError;
  var wbSetStatus = wb.helpers.wbSetStatus;
  var wbSetSwitch = wb.helpers.wbSetSwitch;
  var wbUpdateRulesBudget = wb.helpers.wbUpdateRulesBudget;
  var WB_THEME_META = wb.constants.WB_THEME_META;
  var geometryPollTimer = 0;
  var geometryPollBusy = false;

  function wbRenderWindow() {
    wbSetSwitch(wbDom.overlayEnabled, wbState.draft.enabled);
    wbSetSwitch(wbDom.clickThrough, wbState.draft.clickThrough);
    wbSetSwitch(wbDom.alwaysOnTop, wbState.draft.alwaysOnTop);
    if (document.activeElement !== wbDom.geoWidth) wbDom.geoWidth.value = String(wbState.draft.geometry.width);
    if (document.activeElement !== wbDom.geoHeight) wbDom.geoHeight.value = String(wbState.draft.geometry.height);
    if (document.activeElement !== wbDom.geoX) wbDom.geoX.value = String(wbState.draft.geometry.x);
    if (document.activeElement !== wbDom.geoY) wbDom.geoY.value = String(wbState.draft.geometry.y);
    var pct = clamp(Math.round(wbState.draft.geometry.scale * 100), 50, 400);
    wbDom.geoScale.value = String(pct);
    wbDom.geoScaleValue.textContent = pct + '%';
    wbDom.geoHint.textContent = '当前 ' + wbState.draft.geometry.width + ' × ' + wbState.draft.geometry.height +
      ' px · 内容缩放 ' + pct + '%';
    wbRenderThemeGrid();
    wbUpdateCapture();
  }

  function wbRenderThemeGrid() {
    var html = '';
    var active = wbActiveTheme();
    var keys = ['classic', 'shortvideo', 'minimal', 'highcontrast'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var meta = WB_THEME_META[key];
      html += '<button class="wb-theme-card' + (key === active ? ' is-active' : '') + '" type="button" data-wb-theme="' + key + '">' +
        '<span class="wb-theme-swatch" data-theme="' + key + '"></span><b>' + meta.name + '</b><span>' + meta.code.split(' · ')[0] + '</span></button>';
    }
    wbDom.themeGrid.innerHTML = html;
  }

  function wbApplyTheme(name) {
    if (!WB_THEME_META[name]) return;
    wbState.draft.styles.theme = name;
    wbMarkDirty();
    wbRenderBaseline();
    wbRenderThemeGrid();
    wbRenderEditor();
    wbUpdateRulesBudget();
    wbUpdateCapture();
  }

  function wbOnGeoInput(key, raw, finalize) {
    if (!finalize && String(raw).trim() === '') return;
    var limits = {
      width: { min: 200, max: 3840, fallback: 520 },
      height: { min: 200, max: 2160, fallback: 620 },
      x: { min: -10000, max: 10000, fallback: 60 },
      y: { min: -10000, max: 10000, fallback: 120 }
    };
    var limit = limits[key];
    if (!limit) return;
    var value = wbRound(raw, wbState.draft.geometry[key] || limit.fallback, limit.min, limit.max);
    wbState.draft.geometry[key] = value;
    if (finalize) {
      var input = key === 'width' ? wbDom.geoWidth : key === 'height' ? wbDom.geoHeight : key === 'x' ? wbDom.geoX : wbDom.geoY;
      input.value = String(value);
    }
    wbMarkDirty();
    wbUpdateRulesBudget();
    wbUpdateCapture();
    wbDom.geoHint.textContent = '当前 ' + wbState.draft.geometry.width + ' × ' + wbState.draft.geometry.height +
      ' px · 内容缩放 ' + Math.round(wbState.draft.geometry.scale * 100) + '%';
  }

  function wbApplyLiveGeometry(value) {
    if (!wbState.open || wbState.tab !== 'window' || wbState.dirty ||
      wbState.saving || wbState.autoSaveTimer) return;
    var source = extractOverlayConfig(value) || value;
    if (!source || typeof source !== 'object') return;
    var next = {
      width: wbRound(source.width, wbState.draft.geometry.width, 200, 3840),
      height: wbRound(source.height, wbState.draft.geometry.height, 200, 2160),
      x: wbRound(source.x, wbState.draft.geometry.x, -10000, 10000),
      y: wbRound(source.y, wbState.draft.geometry.y, -10000, 10000),
      scale: clamp(wbFinite(source.scale, wbState.draft.geometry.scale), 0.5, 4)
    };
    var changed = false;
    var keys = ['width', 'height', 'x', 'y', 'scale'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (wbState.draft.geometry[key] !== next[key]) {
        wbState.draft.geometry[key] = next[key];
        changed = true;
      }
    }
    if (!changed) return;
    state.config = deepMerge(state.config || defaultConfig(), {
      overlay: {
        width: next.width,
        height: next.height,
        x: next.x,
        y: next.y,
        scale: next.scale
      }
    });
    wbRenderWindow();
    wbUpdateRulesBudget();
  }

  function wbStopGeometryPoll() {
    if (geometryPollTimer) clearTimeout(geometryPollTimer);
    geometryPollTimer = 0;
    geometryPollBusy = false;
  }

  function wbPollGeometry() {
    if (!wbState.open || wbState.tab !== 'window') {
      wbStopGeometryPoll();
      return;
    }
    if (geometryPollBusy) return;
    geometryPollBusy = true;
    overlayApi('get_overlay_config', []).then(function (value) {
      wbApplyLiveGeometry(value);
    }).catch(function () {
      // The workbench has its own error surface; a transient poll failure
      // should not spam the status bar.
    }).then(function () {
      geometryPollBusy = false;
      if (wbState.open && wbState.tab === 'window') {
        geometryPollTimer = setTimeout(wbPollGeometry, 480);
      }
    });
  }

  function wbStartGeometryPoll() {
    wbStopGeometryPoll();
    if (!wbState.open || wbState.tab !== 'window') return;
    wbPollGeometry();
  }

  function wbQuickCenter() {
    var screen = window.screen || {};
    var left = numFromStr(screen.availLeft, 0);
    var top = numFromStr(screen.availTop, 0);
    var sw = numFromStr(screen.availWidth, 1920);
    var sh = numFromStr(screen.availHeight, 1080);
    wbState.draft.geometry.x = Math.round(left + (sw - wbState.draft.geometry.width) / 2);
    wbState.draft.geometry.y = Math.round(top + (sh - wbState.draft.geometry.height) / 2);
    wbMarkDirty();
    wbRenderWindow();
  }

  function wbQuickFillRight() {
    var screen = window.screen || {};
    var left = numFromStr(screen.availLeft, 0);
    var top = numFromStr(screen.availTop, 0);
    var sw = numFromStr(screen.availWidth, 1920);
    var sh = numFromStr(screen.availHeight, 1080);
    var w = clamp(Math.round(sw * 0.34), 200, 3840);
    wbState.draft.geometry.width = w;
    wbState.draft.geometry.height = clamp(Math.round(sh), 200, 2160);
    wbState.draft.geometry.x = Math.round(left + sw - w);
    wbState.draft.geometry.y = Math.round(top);
    wbState.draft.geometry.scale = 1;
    wbMarkDirty();
    wbRenderWindow();
    wbUpdateRulesBudget();
  }

  function wbToggleOverlayEnabled() {
    if (wbState.mock.visibilityBusy) return;
    var previous = !!wbState.draft.enabled;
    var desired = !previous;
    wbState.draft.enabled = desired;
    wbState.mock.visibilityBusy = true;
    wbSetSwitch(wbDom.overlayEnabled, desired);
    wbSetError('');
    wbSetStatus(desired ? '正在显示浮窗…' : '正在隐藏浮窗…', 'busy');
    overlayApi('set_overlay_visible', [desired]).then(function (res) {
      if (res && typeof res === 'object' && res.ok === false) throw new Error(res.error || '未知原因');
      var actual = res && typeof res.visible === 'boolean' ? res.visible : desired;
      wbState.draft.enabled = actual;
      wbSetSwitch(wbDom.overlayEnabled, actual);
      setOverlayButtonActive(actual);
      state.config = deepMerge(state.config || defaultConfig(), { overlay: { enabled: actual } });
      wbSetStatus(actual ? '浮窗已显示' : '浮窗已隐藏', 'ok');
      setLog(actual ? '浮窗已显示' : '浮窗已隐藏');
    }).catch(function (err) {
      wbState.draft.enabled = previous;
      wbSetSwitch(wbDom.overlayEnabled, previous);
      wbSetStatus('切换显示失败', '');
      wbSetError('切换浮窗显示失败：' + overlayErrorText(err));
    }).then(function () {
      wbState.mock.visibilityBusy = false;
    });
  }

  function wbUpdateCapture() {
    if (!wbDom.captureSize) return;
    var base = wbResolveBaseStyle(wbState.draft);
    var geom = wbState.draft.geometry;
    wbDom.captureSize.textContent = geom.width + ' × ' + geom.height;
    wbDom.captureFont.textContent = Math.round(base.font_size * geom.scale) + 'px（含缩放）';
    wbDom.captureScale.textContent = Math.round(geom.scale * 100) + '%';
    wbDom.geoHint.textContent = '当前 ' + geom.width + ' × ' + geom.height +
      ' px · 内容缩放 ' + Math.round(geom.scale * 100) + '%';
  }

  ctx.modules.wbWindow = {
    wbRenderWindow: wbRenderWindow,
    wbRenderThemeGrid: wbRenderThemeGrid,
    wbApplyTheme: wbApplyTheme,
    wbOnGeoInput: wbOnGeoInput,
    wbApplyLiveGeometry: wbApplyLiveGeometry,
    wbStartGeometryPoll: wbStartGeometryPoll,
    wbStopGeometryPoll: wbStopGeometryPoll,
    wbQuickCenter: wbQuickCenter,
    wbQuickFillRight: wbQuickFillRight,
    wbToggleOverlayEnabled: wbToggleOverlayEnabled,
    wbUpdateCapture: wbUpdateCapture
  };
})();
