/* ============================================================
   幕台 · 工作台排版域（字体 / 行高 / 字距）
   依赖 app-core + app-wb-core 的 MutaiApp.workbench context。
   ============================================================ */
(function () {
  "use strict";
  var ctx = window.MutaiApp;
  var wb = ctx && ctx.workbench;
  if (!ctx || !wb) throw new Error("workbench context missing");
  var wbState = wb.state;
  var wbDom = wb.dom;
  var clamp = wb.helpers.clamp;
  var wbConfirm = wb.helpers.wbConfirm;
  var wbEscape = wb.helpers.wbEscape;
  var wbFontStack = wb.helpers.wbFontStack;
  var wbMarkDirty = wb.helpers.wbMarkDirty;
  var wbNormalizeTypographyValue = wb.helpers.wbNormalizeTypographyValue;
  var wbRenderEditor = wb.helpers.wbRenderEditor;
  var wbResolveStyle = wb.helpers.wbResolveStyle;
  var wbResolveTypography = wb.helpers.wbResolveTypography;
  var wbResolveTypographyGlobal = wb.helpers.wbResolveTypographyGlobal;
  var wbRgba = wb.helpers.wbRgba;
  var wbShowToast = wb.helpers.wbShowToast;
  var wbUpdateCoverageDisplay = wb.helpers.wbUpdateCoverageDisplay;
  var wbUpdateTypeCounts = wb.helpers.wbUpdateTypeCounts;
  var WB_TYPOGRAPHY_FIELD_COUNT = wb.constants.WB_TYPOGRAPHY_FIELD_COUNT;
  var WB_TYPOGRAPHY_FIELDS = wb.constants.WB_TYPOGRAPHY_FIELDS;
  var WB_TYPOGRAPHY_FONT_SUGGESTIONS = wb.constants.WB_TYPOGRAPHY_FONT_SUGGESTIONS;
  var WB_TYPES = wb.constants.WB_TYPES;
  var WB_TYPE_META = wb.constants.WB_TYPE_META;

  function wbRenderTypographyEditor() {
    var type = wbState.currentType;
    var resolved = wbResolveTypography(wbState.draft, type);
    var source = wbState.draft.typography.types[type] || {};
    var familyOverridden = source.font_family !== null && source.font_family !== undefined;
    var family = familyOverridden ? source.font_family : resolved.font_family;
    var html = '<section class="wb-motion-card">' +
      '<div class="wb-motion-card-head"><b>字体</b><span>输入本机已安装字体名</span></div>' +
      '<div class="wb-motion-row wb-typography-font-row" data-wb-typography-field="font_family">' +
      '<span class="wb-motion-label">字体族</span>' +
      '<span class="wb-motion-control"><input id="wbTypographyFamily" class="input" type="text" list="wbTypographyFontList" maxlength="120" value="' +
      wbEscape(family) + '" data-wb-typography-input="font_family" aria-label="字体族"><datalist id="wbTypographyFontList">' +
      WB_TYPOGRAPHY_FONT_SUGGESTIONS.map(function (name) { return '<option value="' + wbEscape(name) + '"></option>'; }).join('') +
      '</datalist></span>' +
      '<span class="wb-motion-state">' +
      (familyOverridden ? '<button class="wb-motion-reset" type="button" data-wb-typography-reset="font_family" aria-label="字体族恢复继承">恢复</button>' : '<span class="wb-motion-inherit" title="继承全局"></span>') +
      '</span></div></section>' +
      '<section class="wb-motion-card">' +
      '<div class="wb-motion-card-head"><b>行与字</b><span>相对字号</span></div>' +
      wbTypographyRowHtml('line_height', resolved, source) +
      wbTypographyRowHtml('letter_spacing', resolved, source) +
      '</section>';
    wbDom.typographyGrid.innerHTML = html;
    if (wbDom.typographyBaseline) {
      var base = wbResolveTypographyGlobal(wbState.draft);
      wbDom.typographyBaseline.textContent = '主题基线：' + base.font_family + ' · ' +
        base.line_height.toFixed(2) + '× · ' + base.letter_spacing + 'px';
    }
    if (wbDom.typographyDemoBubble) {
      var demoStyle = wbResolveStyle(wbState.draft, type);
      wbDom.typographyDemoBubble.style.fontFamily = wbFontStack(resolved.font_family);
      wbDom.typographyDemoBubble.style.fontSize = Math.min(24, demoStyle.font_size) + 'px';
      wbDom.typographyDemoBubble.style.lineHeight = String(resolved.line_height);
      wbDom.typographyDemoBubble.style.letterSpacing = resolved.letter_spacing + 'px';
      wbDom.typographyDemoBubble.style.fontWeight = String(demoStyle.font_weight);
      wbDom.typographyDemoBubble.style.color = demoStyle.text_color;
      wbDom.typographyDemoBubble.style.background = wbRgba(demoStyle.bg_color, demoStyle.bg_opacity);
    }
    if (wbDom.typographyDemo) wbDom.typographyDemo.hidden = !wbState.typographyDemoOpen;
    wbUpdateTypographyCoverage();
  }

  function wbTypographyRowHtml(key, resolved, source) {
    var meta = key === 'line_height'
      ? { label: '行高', min: 1, max: 2.5, step: 0.05, suffix: '×' }
      : { label: '字距', min: 0, max: 8, step: 0.25, suffix: 'px' };
    var override = source[key];
    var overridden = override !== null && override !== undefined;
    var value = overridden ? override : resolved[key];
    return '<div class="wb-motion-row" data-wb-typography-field="' + key + '">' +
      '<span class="wb-motion-label">' + meta.label + '</span>' +
      '<span class="wb-motion-control"><div class="wb-stepper">' +
      '<button type="button" data-wb-typography-step="' + key + '" data-wb-typography-delta="-' + meta.step + '" aria-label="减少' + meta.label + '">−</button>' +
      '<input type="number" data-wb-typography-number="' + key + '" min="' + meta.min + '" max="' + meta.max + '" step="' + meta.step + '" value="' + value + '" aria-label="' + meta.label + '">' +
      '<span class="suffix">' + meta.suffix + '</span>' +
      '<button type="button" data-wb-typography-step="' + key + '" data-wb-typography-delta="' + meta.step + '" aria-label="增加' + meta.label + '">＋</button>' +
      '</div></span>' +
      '<span class="wb-motion-state">' +
      (overridden ? '<button class="wb-motion-reset" type="button" data-wb-typography-reset="' + key + '" aria-label="' + meta.label + '恢复继承">恢复</button>' : '<span class="wb-motion-inherit" title="继承全局"></span>') +
      '</span></div>';
  }

  function wbUpdateTypographyCoverage() {
    if (wbDom.typographyCount) {
      wbDom.typographyCount.textContent = '排版 · 3 项';
    }
  }

  function wbSetTypographyField(key, value, focusSelector) {
    if (WB_TYPOGRAPHY_FIELDS.indexOf(key) < 0) return;
    var cleaned = value === null || value === undefined || value === ''
      ? null
      : wbNormalizeTypographyValue(key, value);
    if (value !== null && value !== undefined && value !== '' && cleaned === null) return;
    wbState.draft.typography.types[wbState.currentType][key] = cleaned;
    wbMarkDirty();
    wbRenderTypographyEditor();
    wbUpdateCoverageDisplay();
    wbUpdateTypeCounts();
    if (focusSelector) {
      var node = wbDom.typographyPanel.querySelector(focusSelector);
      if (!node) node = wbDom.typographyPanel.querySelector('[data-wb-typography-number="' + key + '"]');
      if (node) node.focus();
    }
  }

  function wbOnTypographyClick(e) {
    var reset = e.target.closest ? e.target.closest('[data-wb-typography-reset]') : null;
    if (reset) {
      var resetKey = reset.getAttribute('data-wb-typography-reset');
      wbSetTypographyField(resetKey, null, '[data-wb-typography-input="' + resetKey + '"]');
      return;
    }
    var step = e.target.closest ? e.target.closest('[data-wb-typography-step]') : null;
    if (step) {
      var key = step.getAttribute('data-wb-typography-step');
      var meta = key === 'line_height' ? { min: 1, max: 2.5, step: 0.05 } : { min: 0, max: 8, step: 0.25 };
      var source = wbState.draft.typography.types[wbState.currentType];
      var resolved = wbResolveTypography(wbState.draft, wbState.currentType);
      var base = source[key] !== null && source[key] !== undefined ? source[key] : resolved[key];
      var next = clamp(Number(base) + Number(step.getAttribute('data-wb-typography-delta')), meta.min, meta.max);
      wbSetTypographyField(key, Math.round(next * 100) / 100,
        '[data-wb-typography-step="' + key + '"][data-wb-typography-delta="' + step.getAttribute('data-wb-typography-delta') + '"]');
    }
  }

  function wbOnTypographyChange(e) {
    var input = e.target.closest ? e.target.closest('[data-wb-typography-input]') : null;
    if (input) {
      wbSetTypographyField('font_family', input.value, '[data-wb-typography-input="font_family"]');
      return;
    }
    var number = e.target.closest ? e.target.closest('[data-wb-typography-number]') : null;
    if (!number) return;
    var key = number.getAttribute('data-wb-typography-number');
    var meta = key === 'line_height' ? { min: 1, max: 2.5, step: 0.05 } : { min: 0, max: 8, step: 0.25 };
    var value = clamp(Number(number.value), meta.min, meta.max);
    wbSetTypographyField(key, Math.round(value * 100) / 100, '[data-wb-typography-number="' + key + '"]');
  }

  function wbRestoreCurrentTypography() {
    if (!wbState.loadOk) return;
    var type = wbState.currentType;
    var meta = WB_TYPE_META[type];
    wbConfirm({
      title: '恢复「' + meta.name + '」本类排版？',
      body: '将清空本类 ' + WB_TYPOGRAPHY_FIELD_COUNT + ' 项排版覆盖。外观、动效、主题、固定规则与窗口几何不动。',
      confirmLabel: '恢复本类排版',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) {
        wbState.draft.typography.types[type][WB_TYPOGRAPHY_FIELDS[i]] = null;
      }
      wbMarkDirty();
      wbRenderEditor();
      wbUpdateCoverageDisplay();
      wbShowToast('已恢复本类排版 · 只清空 ' + WB_TYPOGRAPHY_FIELD_COUNT + ' 项覆盖');
    });
  }

  function wbRestoreAllTypography() {
    if (!wbState.loadOk) return;
    wbConfirm({
      title: '全部排版恢复默认？',
    body: '将清空全部消息类型共 ' + (WB_TYPES.length * WB_TYPOGRAPHY_FIELD_COUNT) +
        ' 个排版覆盖。外观、动效、主题、固定规则与窗口几何不动。',
      confirmLabel: '全部恢复排版',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      for (var t = 0; t < WB_TYPES.length; t++) {
        var type = WB_TYPES[t];
        for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) {
          wbState.draft.typography.types[type][WB_TYPOGRAPHY_FIELDS[i]] = null;
        }
      }
      wbMarkDirty();
      wbRenderEditor();
      wbUpdateCoverageDisplay();
      wbShowToast('已清空排版覆盖 · 外观、动效、规则与几何未动');
    });
  }

  ctx.modules.wbTypography = {
    wbRenderTypographyEditor: wbRenderTypographyEditor,
    wbTypographyRowHtml: wbTypographyRowHtml,
    wbUpdateTypographyCoverage: wbUpdateTypographyCoverage,
    wbSetTypographyField: wbSetTypographyField,
    wbOnTypographyClick: wbOnTypographyClick,
    wbOnTypographyChange: wbOnTypographyChange,
    wbRestoreCurrentTypography: wbRestoreCurrentTypography,
    wbRestoreAllTypography: wbRestoreAllTypography
  };
})();
