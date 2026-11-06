/* ============================================================
   幕台 · 工作台 core 模块
   负责 DOM 缓存、状态反馈与共享显示基元。
   ============================================================ */
(function () {
  "use strict";
  var ctx = window.MutaiApp;
  var wb = ctx && ctx.workbench;
  if (!ctx || !wb) throw new Error("workbench context missing");
  var state = ctx.state;
  var clamp = wb.helpers.clamp;
  var wbConfirmState = wb.confirm;
  var wbState = wb.state;
  var wbDom = wb.dom;
  var extractOverlayConfig = ctx.helpers.extractOverlayConfig;
  var deepMerge = ctx.helpers.deepMerge;
  var defaultConfig = ctx.helpers.defaultConfig;
  var overlayApi = ctx.helpers.overlayApi;
  var overlayErrorText = ctx.helpers.overlayErrorText;
  var setLog = ctx.helpers.setLog;
  var setOverlayButtonActive = ctx.helpers.setOverlayButtonActive;
  var wbCancelMotionPreview = wb.helpers.wbCancelMotionPreview;
  var wbClone = wb.helpers.wbClone;
  var wbComputeBudget = wb.helpers.wbComputeBudget;
  var wbEscape = wb.helpers.wbEscape;
  var wbFinite = wb.helpers.wbFinite;
  var wbMotionCoverageCount = wb.helpers.wbMotionCoverageCount;
  var wbNormalizeConfig = wb.helpers.wbNormalizeConfig;
  var wbNormalizeHex = wb.helpers.wbNormalizeHex;
  var wbNormalizeMotion = wb.helpers.wbNormalizeMotion;
  var wbNormalizeMotionOverride = wb.helpers.wbNormalizeMotionOverride;
  var wbNormalizeMotionPartial = wb.helpers.wbNormalizeMotionPartial;
  var wbNormalizePins = wb.helpers.wbNormalizePins;
  var wbNormalizeStylePatch = wb.helpers.wbNormalizeStylePatch;
  var wbNormalizeStyleOverride = wb.helpers.wbNormalizeStyleOverride;
  var wbNormalizeTypography = wb.helpers.wbNormalizeTypography;
  var wbNormalizeTypographyOverride = wb.helpers.wbNormalizeTypographyOverride;
  var wbNormalizeTypographyPatch = wb.helpers.wbNormalizeTypographyPatch;
  var wbRestoreAllMotion = wb.helpers.wbRestoreAllMotion;
  var wbRestoreAllTypography = wb.helpers.wbRestoreAllTypography;
  var wbRestoreCurrentMotion = wb.helpers.wbRestoreCurrentMotion;
  var wbRestoreCurrentTypography = wb.helpers.wbRestoreCurrentTypography;
  var wbRenderMockControls = wb.helpers.wbRenderMockControls;
  var wbRenderMotionEditor = wb.helpers.wbRenderMotionEditor;
  var wbRenderRules = wb.helpers.wbRenderRules;
  var wbRenderTypographyEditor = wb.helpers.wbRenderTypographyEditor;
  var wbRenderWindow = wb.helpers.wbRenderWindow;
  var wbResolveStyle = wb.helpers.wbResolveStyle;
  var wbRound = wb.helpers.wbRound;
  var wbScheduleStructureFit = wb.helpers.wbScheduleStructureFit;
  var wbSetDebugTab = wb.helpers.wbSetDebugTab;
  var wbStyleValue = wb.helpers.wbStyleValue;
  var wbTypeCoverageCount = wb.helpers.wbTypeCoverageCount;
  var wbTypeCoverageTotal = wb.helpers.wbTypeCoverageTotal;
  var wbTypographyCoverageCount = wb.helpers.wbTypographyCoverageCount;
  var wbUpdateCapture = wb.helpers.wbUpdateCapture;
  var WB_FIELD_META = wb.constants.WB_FIELD_META;
  var WB_MOTION_FIELD_COUNT = wb.constants.WB_MOTION_FIELD_COUNT;
  var WB_STYLE_FIELD_COUNT = wb.constants.WB_STYLE_FIELD_COUNT;
  var WB_STYLE_FIELDS = wb.constants.WB_STYLE_FIELDS;
  var WB_THEME_META = wb.constants.WB_THEME_META;
  var WB_TYPE_META = wb.constants.WB_TYPE_META;
  var WB_TYPOGRAPHY_FIELD_COUNT = wb.constants.WB_TYPOGRAPHY_FIELD_COUNT;
  var WB_TYPES = wb.constants.WB_TYPES;
  var wbPlatform = wb.helpers.wbPlatform;
  var wbTypesForPlatform = wb.helpers.wbTypesForPlatform;
  var wbPinLanesForPlatform = wb.helpers.wbPinLanesForPlatform;

  function $(id) {
    return document.getElementById(id);
  }

  function wbCacheDom() {
    wbDom.modal = $('wbModal');
    wbDom.card = $('wbCard');
    wbDom.app = document.querySelector('.app');
    wbDom.closeBtn = $('wbCloseBtn');
    wbDom.closeAction = $('wbCloseAction');
    wbDom.sync = $('wbSync');
    wbDom.syncText = $('wbSyncText');
    wbDom.tabs = $('wbTabs');
    wbDom.tabButtons = Array.prototype.slice.call(wbDom.tabs.querySelectorAll('[data-wb-tab]'));
    wbDom.panels = {
      style: $('wbPanelStyle'), rules: $('wbPanelRules'),
      presets: $('wbPanelPresets'), window: $('wbPanelWindow'),
      debug: $('wbPanelDebug')
    };
    wbDom.footNote = $('wbFootNote');
    wbDom.status = $('wbStatus');
    wbDom.error = $('wbError');
    wbDom.saveBtn = $('wbSaveBtn');

    wbDom.typeList = $('wbTypeList');
    wbDom.typeStrip = $('wbTypeStrip');
    wbDom.typeIcon = $('wbTypeIcon');
    wbDom.typeTitle = $('wbTypeTitle');
    wbDom.typeCode = $('wbTypeCode');
    wbDom.typeSub = $('wbTypeSub');
    wbDom.baselineSwatch = $('wbBaselineSwatch');
    wbDom.baselineName = $('wbBaselineName');
    wbDom.baselineCode = $('wbBaselineCode');
    wbDom.editorPanel = document.querySelector('#wbPanelStyle .wb-editor');
    wbDom.matrix = $('wbMatrix');
    wbDom.styleDomain = $('wbStyleDomain');
    wbDom.typographyPanel = $('wbTypographyPanel');
    wbDom.typographyGrid = $('wbTypographyGrid');
    wbDom.typographyCount = $('wbTypographyCount');
    wbDom.typographyBaseline = $('wbTypographyBaseline');
    wbDom.typographyPreview = $('wbTypographyPreview');
    wbDom.typographyDemo = $('wbTypographyDemo');
    wbDom.typographyDemoClose = $('wbTypographyDemoClose');
    wbDom.typographyDemoBubble = $('wbTypographyDemoBubble');
    wbDom.motionPanel = $('wbMotionPanel');
    wbDom.motionCore = $('wbMotionCore');
    wbDom.motionAdvancedGrid = $('wbMotionAdvancedGrid');
    wbDom.motionCount = $('wbMotionCount');
    wbDom.motionReduced = $('wbMotionReduced');
    wbDom.coverageText = $('wbCoverageText');
    wbDom.coverageBar = $('wbCoverageBar');
    wbDom.restoreType = $('wbRestoreType');
    wbDom.restoreAll = $('wbRestoreAll');
    wbDom.rulesViewSwitch = $('wbRulesViewSwitch');
    wbDom.rulesTableWrap = $('wbRulesTableWrap');
    wbDom.rulesBody = $('wbRulesBody');
    wbDom.rulesCards = $('wbRulesCards');
    wbDom.restoreRules = $('wbRestoreRules');
    wbDom.summaryFixed = $('wbSummaryFixed');
    wbDom.summaryScroll = $('wbSummaryScroll');
    wbDom.summaryLanes = $('wbSummaryLanes');
    wbDom.summaryNote = $('wbSummaryNote');
    wbDom.budgetHeadMeta = $('wbBudgetHeadMeta');
    wbDom.budgetUsedBig = $('wbBudgetUsedBig');
    wbDom.budgetFormula = $('wbBudgetFormula');
    wbDom.budgetUsedLine = $('wbBudgetUsedLine');
    wbDom.scrollUsedLine = $('wbScrollUsedLine');
    wbDom.budgetCapLine = $('wbBudgetCapLine');
    wbDom.budgetBar = $('wbBudgetBar');
    wbDom.budgetLegend = $('wbBudgetLegend');
    wbDom.laneRows = $('wbLaneRows');
    wbDom.capacityNote = $('wbCapacityNote');
    wbDom.structureStage = $('wbStructureStage');
    wbDom.structureCanvas = $('wbStructureCanvas');
    wbDom.structureTop = $('wbStructureTop');
    wbDom.structureBottom = $('wbStructureBottom');
    wbDom.structureTopMeta = $('wbStructureTopMeta');
    wbDom.structureBottomMeta = $('wbStructureBottomMeta');
    wbDom.structureTopLanes = $('wbStructureTopLanes');
    wbDom.structureBottomLanes = $('wbStructureBottomLanes');
    wbDom.structureTopCards = $('wbStructureTopCards');
    wbDom.structureBottomCards = $('wbStructureBottomCards');
    wbDom.structureScrollMeta = $('wbStructureScrollMeta');
    wbDom.structureNote = $('wbStructureNote');

    wbDom.overlayEnabled = $('wbOverlayEnabled');
    wbDom.clickThrough = $('wbClickThrough');
    wbDom.alwaysOnTop = $('wbAlwaysOnTop');
    wbDom.geoWidth = $('wbGeoWidth');
    wbDom.geoHeight = $('wbGeoHeight');
    wbDom.geoX = $('wbGeoX');
    wbDom.geoY = $('wbGeoY');
    wbDom.geoScale = $('wbGeoScale');
    wbDom.geoScaleValue = $('wbGeoScaleValue');
    wbDom.geoHint = $('wbGeoHint');
    wbDom.centerBtn = $('wbCenterBtn');
    wbDom.fillRightBtn = $('wbFillRightBtn');
    wbDom.themeGrid = $('wbThemeGrid');
    wbDom.captureSize = $('wbCaptureSize');
    wbDom.captureFont = $('wbCaptureFont');
    wbDom.captureScale = $('wbCaptureScale');

    wbDom.mockKind = $('wbMockKind');
    wbDom.mockUser = $('wbMockUser');
    wbDom.mockText = $('wbMockText');
    wbDom.mockSpeak = $('wbMockSpeak');
    wbDom.mockSpeakFlag = $('wbMockSpeakFlag');
    wbDom.mockSend = $('wbMockSend');
    wbDom.mockBurst10 = $('wbMockBurst10');
    wbDom.mockStorm30 = $('wbMockStorm30');
    wbDom.mockFeedback = $('wbMockFeedback');
    wbDom.mockAutoState = $('wbMockAutoState');
    wbDom.mockAutoNote = $('wbMockAutoNote');
    wbDom.mockAutoEnabled = $('wbMockAutoEnabled');
    wbDom.mockInterval = $('wbMockInterval');
    wbDom.mockIntervalValue = $('wbMockIntervalValue');
    wbDom.mockPerTick = $('wbMockPerTick');
    wbDom.mockTypes = $('wbMockTypes');
    wbDom.mockTypesHint = $('wbMockTypesHint');
    wbDom.mockAutoSpeak = $('wbMockAutoSpeak');
    wbDom.mockAutoSpeakFlag = $('wbMockAutoSpeakFlag');
    wbDom.mockAutoStatus = $('wbMockAutoStatus');
    wbDom.mockAutoStatusDetail = $('wbMockAutoStatusDetail');

    wbDom.confirmMask = $('wbConfirmMask');
    wbDom.confirmCard = $('wbConfirmCard');
    wbDom.confirmTitle = $('wbConfirmTitle');
    wbDom.confirmBody = $('wbConfirmBody');
    wbDom.confirmCancel = $('wbConfirmCancel');
    wbDom.confirmOk = $('wbConfirmOk');
    wbDom.toast = $('wbToast');
    wbDom.toastText = $('wbToastText');
    wbDom.undoBtn = $('wbUndoBtn');
  }

  function wbTypeIcon(type) {
    var meta = WB_TYPE_META[type] || WB_TYPE_META.danmaku;
    return '<svg class="wb-icon" aria-hidden="true"><use href="' + meta.icon + '"></use></svg>';
  }

  function wbCoverageCount(type) {
    var source = wbState.draft.styles.types[type] || {};
    var count = 0;
    for (var i = 0; i < WB_STYLE_FIELDS.length; i++) {
      if (source[WB_STYLE_FIELDS[i]] !== null && source[WB_STYLE_FIELDS[i]] !== undefined) count += 1;
    }
    return count;
  }

  function wbActiveTheme() {
    var theme = wbState.draft.styles.theme;
    return WB_THEME_META[theme] ? theme : 'classic';
  }

  function wbSetSwitch(node, on, labels) {
    if (!node) return;
    var state = !!on;
    node.classList.toggle('is-on', state);
    node.setAttribute('aria-checked', state ? 'true' : 'false');
    var label = node.querySelector('.wb-switch-label');
    if (label) label.textContent = state ? ((labels && labels.on) || '开') : ((labels && labels.off) || '关');
  }

  function wbSetSync(text, tone) {
    if (!wbDom.sync || !wbDom.syncText) return;
    wbDom.syncText.textContent = text || '';
    wbDom.sync.classList.toggle('is-busy', tone === 'busy');
    wbDom.sync.classList.toggle('is-error', tone === 'error');
  }

  function wbSetStatus(text, tone) {
    if (!wbDom.status) return;
    wbDom.status.textContent = text || '';
    wbDom.status.classList.toggle('is-ok', tone === 'ok');
    wbDom.status.classList.toggle('is-busy', tone === 'busy');
  }

  function wbSetError(text) {
    if (!wbDom.error) return;
    var value = String(text === null || text === undefined ? '' : text);
    wbDom.error.textContent = value;
    wbDom.error.hidden = !value;
  }

  function wbSetSaveState() {
    if (!wbDom.saveBtn) return;
    var locked = !wbState.open || wbState.loading || wbState.saving || !wbState.loadOk;
    wbDom.saveBtn.disabled = locked;
    if (wbState.saving) {
      wbDom.saveBtn.textContent = '保存中…';
      wbDom.saveBtn.classList.remove('is-saved');
    } else if (Date.now() < wbState.justSavedUntil) {
      wbDom.saveBtn.textContent = '已保存 ✓';
      wbDom.saveBtn.classList.add('is-saved');
    } else {
      wbDom.saveBtn.textContent = '保存';
      wbDom.saveBtn.classList.remove('is-saved');
    }
  }

  function wbCancelAutoSave() {
    if (wbState.autoSaveTimer) clearTimeout(wbState.autoSaveTimer);
    wbState.autoSaveTimer = 0;
  }

  function wbScheduleAutoSave() {
    if (!wbState.open || wbState.loading || !wbState.loadOk) return;
    wbCancelAutoSave();
    wbState.autoSaveTimer = setTimeout(function () {
      wbState.autoSaveTimer = 0;
      if (!wbState.open || !wbState.dirty || wbState.saving) return;
      wbSaveSettings({ auto: true });
    }, 320);
  }

  function wbMarkDirty() {
    wbState.dirty = true;
    wbState.editSeq += 1;
    wbState.justSavedUntil = 0;
    wbSetError('');
    wbSetSync('有未保存修改', '');
    wbSetStatus('有未保存修改', '');
    wbSetSaveState();
    wbScheduleAutoSave();
  }

  function wbUpdateFootNote() {
    if (!wbDom.footNote) return;
    if (wbState.tab === 'style') {
      wbDom.footNote.innerHTML = '<b>修改后自动应用</b>；外观、排版、动效分别计数、分别恢复。';
    } else if (wbState.tab === 'rules') {
    wbDom.footNote.innerHTML = '<b>修改后自动应用</b>；恢复规则默认只改当前平台的固定规则。';
    } else if (wbState.tab === 'window') {
    wbDom.footNote.innerHTML = '<b>位置、尺寸、缩放与主题修改后自动应用</b>；不改变各类型外观覆盖。';
    } else if (wbState.tab === 'presets') {
      wbDom.footNote.innerHTML = '<b>预设应用后自动写入</b>；只替换所选层。';
    } else {
      wbDom.footNote.innerHTML = '<b>调试操作</b>不会改动画文、队列或配置，除非点击保存。';
    }
  }

  function wbFetchConfig(seq, attempt) {
    Promise.all([
      overlayApi('get_config_v2', []).catch(function () { return null; }),
      overlayApi('get_overlay_config', []).catch(function () { return null; })
    ]).then(function (results) {
      if (!wbState.open || seq !== wbState.loadSeq) return;
      var raw = results[0];
      var flat = extractOverlayConfig(results[1]);
      var hasV2 = !!(raw && typeof raw === 'object' && raw.overlay);
      if (!hasV2 && !flat) {
        if (!state.api && attempt < 8) {
          setTimeout(function () { wbFetchConfig(seq, attempt + 1); }, 160);
          return;
        }
        throw new Error('后端未返回浮窗配置');
      }
      var normalized = wbNormalizeConfig(raw, flat);
      wbState.draft = normalized.draft;
      wbState.loading = false;
      wbState.loadOk = true;
      wbState.dirty = false;
      wbSetError('');
      wbSetStatus('');
      wbSetSync('已读取 · ' + (state.isMock ? 'Mock' : '本地配置'), '');
      setOverlayButtonActive(!!wbState.draft.enabled);
      wbRenderAll();
      wbSetTab(wbState.tab, { focus: false });
      wbSetDebugTab(wbState.debugTab, { focus: false });
      wbSetSaveState();
      wbScheduleStructureFit();
    }).catch(function (err) {
      if (!wbState.open || seq !== wbState.loadSeq) return;
      wbState.loading = false;
      wbState.loadOk = false;
      wbSetError('读取浮窗配置失败：' + overlayErrorText(err));
      wbSetStatus('读取失败', '');
      wbSetSync('读取失败', 'error');
      wbSetSaveState();
    });
  }

  function wbSetTab(name, options) {
    var next = wbDom.panels[name] ? name : 'style';
    if (next !== 'style') wbCancelMotionPreview();
    wbState.tab = next;
    for (var i = 0; i < wbDom.tabButtons.length; i++) {
      var btn = wbDom.tabButtons[i];
      var active = btn.getAttribute('data-wb-tab') === next;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('tabindex', active ? '0' : '-1');
    }
    for (var key in wbDom.panels) {
      if (!Object.prototype.hasOwnProperty.call(wbDom.panels, key)) continue;
      wbDom.panels[key].hidden = key !== next;
    }
    wbUpdateFootNote();
    if (next === 'style') {
      wbRenderTypeList();
      wbRenderEditor();
    } else if (next === 'rules') {
      wbRenderRules();
      wbScheduleStructureFit();
    } else if (next === 'window') {
      wbRenderWindow();
    } else if (next === 'presets') {
      if (ctx.modules.wbPresets && ctx.modules.wbPresets.render) {
        ctx.modules.wbPresets.render();
      }
    } else {
      wbSetDebugTab(wbState.debugTab, { focus: false });
      wbRenderMockControls();
    }
    if (ctx.modules.wbWindow) {
      if (next === 'window' && typeof ctx.modules.wbWindow.wbStartGeometryPoll === 'function') {
        ctx.modules.wbWindow.wbStartGeometryPoll();
      } else if (typeof ctx.modules.wbWindow.wbStopGeometryPoll === 'function') {
        ctx.modules.wbWindow.wbStopGeometryPoll();
      }
    }
    if (options && options.focus) {
      var target = document.querySelector('[data-wb-tab="' + next + '"]');
      if (target) target.focus();
    }
    wbSetSaveState();
  }

  function wbOnTabsKeydown(e) {
    var key = e.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    e.preventDefault();
    var index = wbDom.tabButtons.indexOf(document.activeElement);
    if (index < 0) index = 0;
    if (key === 'Home') index = 0;
    else if (key === 'End') index = wbDom.tabButtons.length - 1;
    else if (key === 'ArrowLeft') index = (index + wbDom.tabButtons.length - 1) % wbDom.tabButtons.length;
    else index = (index + 1) % wbDom.tabButtons.length;
    wbSetTab(wbDom.tabButtons[index].getAttribute('data-wb-tab'), { focus: true });
  }

  function wbRenderAll() {
    wbRenderTypeList();
    wbRenderEditor();
    wbRenderBaseline();
    wbRenderRules();
    wbRenderWindow();
    wbRenderMockControls();
    if (ctx.modules.wbPresets && ctx.modules.wbPresets.render) {
      ctx.modules.wbPresets.render();
    }
    wbUpdateFootNote();
    wbSetSaveState();
  }

  function wbRenderTypeList() {
    var platformTypes = wbTypesForPlatform();
    if (platformTypes.indexOf(wbState.currentType) < 0) wbState.currentType = platformTypes[0];
    var html = '';
    var strip = '';
    for (var i = 0; i < platformTypes.length; i++) {
      var type = platformTypes[i];
      var meta = WB_TYPE_META[type];
      var count = wbTypeCoverageCount(type);
      var total = wbTypeCoverageTotal();
      var active = type === wbState.currentType;
      html += '<button class="wb-type-item' + (active ? ' is-active' : '') + '" type="button" data-wb-type="' + type + '"' +
        ' style="--type:' + meta.color + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
        '<span class="wb-type-icon">' + wbTypeIcon(type) + '</span>' +
        '<span class="wb-type-copy"><span class="wb-type-name">' + wbEscape(meta.name) +
        '<code>' + wbEscape(meta.code) + '</code></span><span class="wb-type-sub">' + wbEscape(meta.sub) + '</span></span>' +
        '<span class="wb-type-count' + (count ? ' has-override' : '') + '" title="覆盖 ' + count + '/' +
        total + '" aria-label="覆盖 ' + count + '/' + total + '">' +
        count + '/' + total + '</span>' +
        '</button>';
      strip += '<button class="wb-type-strip-item' + (active ? ' is-active' : '') + '" type="button" data-wb-type="' + type +
        '" style="--type:' + meta.color + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
        wbEscape(meta.name) + '<span class="wb-type-count-mini">' + count + '/' + total + '</span></button>';
    }
    wbDom.typeList.innerHTML = html;
    if (wbDom.typeStrip) wbDom.typeStrip.innerHTML = strip;
  }

  function wbSelectType(type) {
    if (wbTypesForPlatform().indexOf(type) < 0) return;
    var active = document.activeElement;
    var restoreFocus = !!(active && active.closest &&
      active.closest('#wbTypeList, #wbTypeStrip'));
    wbState.currentType = type;
    wbCancelMotionPreview();
    wbRenderTypeList();
    wbRenderEditor();
    if (restoreFocus) {
      var target = document.querySelector('#wbTypeList [data-wb-type="' + type + '"]') ||
        document.querySelector('#wbTypeStrip [data-wb-type="' + type + '"]');
      if (target) target.focus();
    }
  }

  function wbRenderBaseline() {
    var theme = wbActiveTheme();
    var meta = WB_THEME_META[theme];
    wbDom.baselineSwatch.setAttribute('data-theme', theme);
    wbDom.baselineName.textContent = meta.name;
    wbDom.baselineCode.textContent = meta.code;
  }

  function wbRenderEditor() {
    var type = wbState.currentType;
    var meta = WB_TYPE_META[type];
    var resolved = wbResolveStyle(wbState.draft, type);
    var count = wbCoverageCount(type);
    wbDom.editorPanel.style.setProperty('--type', meta.color);
    wbDom.typeIcon.innerHTML = wbTypeIcon(type);
    wbDom.typeTitle.textContent = meta.name;
    wbDom.typeCode.textContent = meta.code;
    wbDom.typeSub.textContent = meta.sub;
    var groups = [
      { index: '01', title: '文字层', fields: ['font_size', 'font_weight', 'text_color', 'name_color'] },
      { index: '02', title: '底板与层次', fields: ['bg_color', 'bg_opacity', 'opacity'] },
      { index: '03', title: '轮廓与识别', fields: ['outline', 'outline_color', 'outline_width', 'shadow', 'badge_color'] }
    ];
    var html = '';
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      html += '<div class="wb-prop-group"><span class="wb-group-index">' + group.index + '</span><h4>' + group.title +
        '</h4><span>' + group.fields.length + ' 项 · 逐字段继承</span></div>';
      for (var i = 0; i < group.fields.length; i++) {
        html += wbFieldRowHtml(group.fields[i], resolved);
      }
    }
    wbDom.matrix.innerHTML = html;
    wbRenderTypographyEditor();
    wbRenderMotionEditor();
    wbUpdateCoverageDisplay();
    wbSetStyleDomain(wbState.styleDomain, { focus: false, render: false });
  }

  function wbUpdateCoverageDisplay() {
    if (wbState.styleDomain === 'motion') {
      var mcount = wbMotionCoverageCount(wbState.currentType);
      wbDom.coverageText.innerHTML = '<b>本类动效覆盖 ' + mcount + ' / ' + WB_MOTION_FIELD_COUNT +
        ' 项</b> <span>6 项核心 · 6 项高级</span>';
      wbDom.coverageBar.style.width = (mcount / WB_MOTION_FIELD_COUNT * 100).toFixed(2) + '%';
      return;
    }
    if (wbState.styleDomain === 'typography') {
      var tcount = wbTypographyCoverageCount(wbState.currentType);
      wbDom.coverageText.innerHTML = '<b>本类排版覆盖 ' + tcount + ' / ' + WB_TYPOGRAPHY_FIELD_COUNT +
        ' 项</b> <span>字体族 · 行高 · 字距</span>';
      wbDom.coverageBar.style.width = (tcount / WB_TYPOGRAPHY_FIELD_COUNT * 100).toFixed(2) + '%';
      return;
    }
    var count = wbCoverageCount(wbState.currentType);
    wbDom.coverageText.innerHTML = '<b>本类覆盖 ' + count + ' / ' + WB_STYLE_FIELD_COUNT +
      ' 项</b> <span>' + (WB_STYLE_FIELD_COUNT - count) + ' 项跟随全局</span>';
    wbDom.coverageBar.style.width = (count / WB_STYLE_FIELD_COUNT * 100).toFixed(2) + '%';
  }

  function wbSetStyleDomain(domain, options) {
    options = options || {};
    var next = domain === 'motion' ? 'motion' : (domain === 'typography' ? 'typography' : 'style');
    if (next !== wbState.styleDomain) wbCancelMotionPreview();
    wbState.styleDomain = next;
    var buttons = wbDom.styleDomain.querySelectorAll('[data-wb-style-domain]');
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute('data-wb-style-domain') === next;
      buttons[i].classList.toggle('is-active', active);
      buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    wbDom.matrix.hidden = next !== 'style';
    wbDom.typographyPanel.hidden = next !== 'typography';
    wbDom.motionPanel.hidden = next !== 'motion';
    wbDom.restoreAll.hidden = false;
    wbDom.restoreType.innerHTML = '<svg class="wb-icon" aria-hidden="true"><use href="#wb-i-reset"></use></svg>' +
      '恢复本类';
    wbDom.restoreType.title = next === 'motion' ? '恢复本类动效' : (next === 'typography' ? '恢复本类排版' : '恢复本类外观');
    wbDom.restoreType.setAttribute('aria-label', wbDom.restoreType.title);
    wbDom.restoreAll.textContent = '全部恢复';
    wbDom.restoreAll.title = next === 'motion' ? '全部恢复动效' : (next === 'typography' ? '全部恢复排版' : '全部恢复外观');
    wbDom.restoreAll.setAttribute('aria-label', wbDom.restoreAll.title);
    wbRenderTypeList();
    if (next === 'typography') {
      wbRenderTypographyEditor();
    }
    if (next === 'motion') {
      wbRenderMotionEditor();
    }
    wbUpdateCoverageDisplay();
    if (options.focus && buttons.length) {
      var activeBtn = wbDom.styleDomain.querySelector('[data-wb-style-domain="' + next + '"]');
      if (activeBtn) activeBtn.focus();
    }
  }

  function wbFieldRowHtml(key, resolved) {
    var meta = WB_FIELD_META[key];
    var override = wbState.draft.styles.types[wbState.currentType][key];
    var overridden = override !== null && override !== undefined;
    var value = overridden ? override : resolved[key];
    var control = '';
    if (meta.type === 'stepper') {
      control = '<div class="wb-stepper">' +
        '<button type="button" data-wb-step="' + key + '" data-wb-delta="-' + meta.step + '" aria-label="减少' + meta.label + '">−</button>' +
        '<input type="number" data-wb-number="' + key + '" min="' + meta.min + '" max="' + meta.max + '" step="' + meta.step + '" value="' + value + '" aria-label="' + meta.label + '">' +
        '<span class="suffix">' + meta.suffix + '</span>' +
        '<button type="button" data-wb-step="' + key + '" data-wb-delta="' + meta.step + '" aria-label="增加' + meta.label + '">＋</button>' +
        '</div>';
    } else if (meta.type === 'segmented') {
      control = '<div class="wb-seg">';
      for (var i = 0; i < meta.options.length; i++) {
        var opt = meta.options[i];
        control += '<button type="button" data-wb-set="' + key + '" data-wb-value="' + opt + '"' +
          (String(value) === String(opt) ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"') + '>' + opt + '</button>';
      }
      control += '</div>';
    } else if (meta.type === 'color') {
      var color = wbNormalizeHex(value) || '#FFFFFF';
      control = '<div class="wb-color-control"><input class="wb-color-swatch" type="color" data-wb-color="' + key +
        '" value="' + color + '" aria-label="' + meta.label + '取色器"><input class="wb-hex" type="text" data-wb-hex="' +
        key + '" value="' + color + '" maxlength="7" spellcheck="false" autocomplete="off" aria-label="' + meta.label + '十六进制"></div>';
    } else if (meta.type === 'range') {
      control = '<input class="wb-range" type="range" data-wb-range="' + key + '" min="' + meta.min + '" max="' + meta.max +
        '" step="1" value="' + value + '" aria-label="' + meta.label + '"><output class="wb-range-output" data-wb-output="' + key + '">' +
        value + meta.suffix + '</output>';
    } else {
      control = '<button class="wb-switch' + (value ? ' is-on' : '') + '" type="button" data-wb-toggle="' + key +
        '" role="switch" aria-checked="' + (value ? 'true' : 'false') + '"><span class="track"></span><span class="wb-switch-label">' +
        (value ? '开' : '关') + '</span></button>';
    }
    return '<div class="wb-prop-row' + (overridden ? '' : ' is-inherited') + '" data-wb-field="' + key + '">' +
      '<span class="wb-prop-label">' + meta.label + '</span>' +
      '<span class="wb-prop-control">' + control + '</span>' +
      '<button class="wb-state-chip' + (overridden ? ' is-overridden' : '') + '" type="button" data-wb-chip="' + key +
      '" aria-pressed="' + (overridden ? 'true' : 'false') + '"><i aria-hidden="true"></i>' +
      (overridden ? '已覆盖' : '跟随全局') + '</button>' +
      '</div>';
  }

  function wbUpdateCoverage() {
    wbUpdateCoverageDisplay();
    wbUpdateTypeCounts();
  }

  function wbUpdateTypeCounts() {
    if (!wbDom.typeList) return;
    var items = wbDom.typeList.querySelectorAll('[data-wb-type]');
    var total = wbTypeCoverageTotal();
    for (var i = 0; i < items.length; i++) {
      var type = items[i].getAttribute('data-wb-type');
      var count = wbTypeCoverageCount(type);
      var badge = items[i].querySelector('.wb-type-count');
      if (!badge) continue;
      badge.textContent = count + '/' + total;
      badge.title = '覆盖 ' + count + '/' + total;
      badge.setAttribute('aria-label', '覆盖 ' + count + '/' + total);
      badge.classList.toggle('has-override', count > 0);
    }
    if (wbDom.typeStrip) {
      var stripItems = wbDom.typeStrip.querySelectorAll('[data-wb-type]');
      for (var s = 0; s < stripItems.length; s++) {
        var stripType = stripItems[s].getAttribute('data-wb-type');
        var mini = stripItems[s].querySelector('.wb-type-count-mini');
        if (mini) mini.textContent = wbTypeCoverageCount(stripType) + '/' + total;
      }
    }
  }

  function wbUpdateFieldMeta(key) {
    var row = wbDom.matrix.querySelector('[data-wb-field="' + key + '"]');
    if (!row) return;
    var override = wbState.draft.styles.types[wbState.currentType][key];
    var overridden = override !== null && override !== undefined;
    row.classList.toggle('is-inherited', !overridden);
    var chip = row.querySelector('[data-wb-chip]');
    if (chip) {
      chip.classList.toggle('is-overridden', overridden);
      chip.setAttribute('aria-pressed', overridden ? 'true' : 'false');
      chip.innerHTML = '<i aria-hidden="true"></i>' + (overridden ? '已覆盖' : '跟随全局');
    }
  }

  function wbSyncRowControl(key, value) {
    var row = wbDom.matrix.querySelector('[data-wb-field="' + key + '"]');
    if (!row) return;
    var meta = WB_FIELD_META[key];
    var resolved = wbResolveStyle(wbState.draft, wbState.currentType)[key];
    var current = value === undefined ? resolved : value;
    if (meta.type === 'stepper' || meta.type === 'range') {
      var input = row.querySelector(meta.type === 'stepper' ? '[data-wb-number]' : '[data-wb-range]');
      if (input && document.activeElement !== input) input.value = current;
      var output = row.querySelector('[data-wb-output]');
      if (output) output.textContent = current + meta.suffix;
    } else if (meta.type === 'segmented') {
      var buttons = row.querySelectorAll('[data-wb-set]');
      for (var i = 0; i < buttons.length; i++) {
        var active = String(buttons[i].getAttribute('data-wb-value')) === String(current);
        buttons[i].classList.toggle('is-active', active);
        buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    } else if (meta.type === 'color') {
      var picker = row.querySelector('[data-wb-color]');
      var hex = row.querySelector('[data-wb-hex]');
      var color = wbNormalizeHex(current) || '#FFFFFF';
      if (picker && document.activeElement !== picker) picker.value = color;
      if (hex && document.activeElement !== hex) {
        hex.value = color;
        hex.classList.remove('is-invalid');
      }
    } else if (meta.type === 'switch') {
      var toggle = row.querySelector('[data-wb-toggle]');
      if (toggle) {
        toggle.classList.toggle('is-on', !!current);
        toggle.setAttribute('aria-checked', current ? 'true' : 'false');
        var label = toggle.querySelector('.wb-switch-label');
        if (label) label.textContent = current ? '开' : '关';
      }
    }
  }

  function wbSetField(key, value) {
    var cleaned = key === 'font_weight' && Number(value) === 800 ? 700 : wbStyleValue(key, value);
    if (cleaned === null) return;
    wbState.draft.styles.types[wbState.currentType][key] = cleaned;
    wbMarkDirty();
    wbUpdateFieldMeta(key);
    wbSyncRowControl(key, cleaned);
    wbUpdateCoverage();
    wbUpdateCapture();
  }

  function wbSetFieldToFollow(key) {
    var type = wbState.currentType;
    var source = wbState.draft.styles.types[type];
    var previous = source[key];
    if (previous === null || previous === undefined) return;
    var meta = WB_FIELD_META[key];
    source[key] = null;
    wbMarkDirty();
    wbRenderEditor();
    wbUpdateCoverage();
    wbUpdateCapture();
    wbShowToast('已恢复「' + meta.label + '」为跟随全局', {
      undo: function () {
        wbState.draft.styles.types[type][key] = previous;
        wbMarkDirty();
        if (wbState.currentType === type) wbRenderEditor();
        wbUpdateCoverage();
        wbUpdateCapture();
        wbShowToast('已撤销 · 「' + meta.label + '」恢复为覆盖值');
      }
    });
  }

  function wbToggleFieldChip(key) {
    var source = wbState.draft.styles.types[wbState.currentType];
    if (source[key] === null || source[key] === undefined) {
      var resolved = wbResolveStyle(wbState.draft, wbState.currentType)[key];
      if (key === 'font_weight' && WB_FIELD_META.font_weight.options.indexOf(Number(resolved)) < 0) resolved = 700;
      wbSetField(key, resolved);
    } else {
      wbSetFieldToFollow(key);
    }
  }

  function wbOnMatrixClick(e) {
    var target = e.target;
    var chip = target.closest ? target.closest('[data-wb-chip]') : null;
    if (chip) {
      wbToggleFieldChip(chip.getAttribute('data-wb-chip'));
      return;
    }
    var step = target.closest ? target.closest('[data-wb-step]') : null;
    if (step) {
      var stepKey = step.getAttribute('data-wb-step');
      var meta = WB_FIELD_META[stepKey];
      var source = wbState.draft.styles.types[wbState.currentType];
      var resolved = wbResolveStyle(wbState.draft, wbState.currentType)[stepKey];
      var base = source[stepKey] !== null && source[stepKey] !== undefined ? source[stepKey] : resolved;
      var next = clamp(Number(base) + Number(step.getAttribute('data-wb-delta')), meta.min, meta.max);
      wbSetField(stepKey, Math.round(next));
      return;
    }
    var set = target.closest ? target.closest('[data-wb-set]') : null;
    if (set) {
      var setKey = set.getAttribute('data-wb-set');
      var raw = set.getAttribute('data-wb-value');
      var numeric = Number(raw);
      wbSetField(setKey, isFinite(numeric) ? numeric : raw);
      return;
    }
    var toggle = target.closest ? target.closest('[data-wb-toggle]') : null;
    if (toggle) {
      var toggleKey = toggle.getAttribute('data-wb-toggle');
      var current = wbResolveStyle(wbState.draft, wbState.currentType)[toggleKey];
      var override = wbState.draft.styles.types[wbState.currentType][toggleKey];
      if (override !== null && override !== undefined) current = override;
      wbSetField(toggleKey, !current);
    }
  }

  function wbOnMatrixInput(e) {
    var target = e.target;
    var range = target.closest ? target.closest('[data-wb-range]') : null;
    if (range) {
      var rangeKey = range.getAttribute('data-wb-range');
      var meta = WB_FIELD_META[rangeKey];
      var value = wbRound(range.value, meta.min, meta.min, meta.max);
      wbSetField(rangeKey, value);
      var output = range.parentElement.querySelector('[data-wb-output]');
      if (output) output.textContent = value + meta.suffix;
      return;
    }
    var number = target.closest ? target.closest('[data-wb-number]') : null;
    if (number) {
      var numberKey = number.getAttribute('data-wb-number');
      var numberMeta = WB_FIELD_META[numberKey];
      if (number.value === '') return;
      var numberValue = wbRound(number.value, numberMeta.min, numberMeta.min, numberMeta.max);
      wbSetField(numberKey, numberValue);
      return;
    }
    var color = target.closest ? target.closest('[data-wb-color]') : null;
    if (color) {
      var colorKey = color.getAttribute('data-wb-color');
      var hex = wbNormalizeHex(color.value);
      if (!hex) return;
      wbSetField(colorKey, hex);
      return;
    }
    var hexInput = target.closest ? target.closest('[data-wb-hex]') : null;
    if (hexInput) {
      var hexKey = hexInput.getAttribute('data-wb-hex');
      var normalized = wbNormalizeHex(hexInput.value);
      if (!normalized) {
        hexInput.classList.add('is-invalid');
        return;
      }
      hexInput.classList.remove('is-invalid');
      wbSetField(hexKey, normalized);
    }
  }

  function wbOnMatrixChange(e) {
    var target = e.target;
    var number = target.closest ? target.closest('[data-wb-number]') : null;
    if (number) {
      var key = number.getAttribute('data-wb-number');
      var meta = WB_FIELD_META[key];
      var value = wbRound(number.value, meta.min, meta.min, meta.max);
      wbSetField(key, value);
      number.value = String(value);
      return;
    }
    var hexInput = target.closest ? target.closest('[data-wb-hex]') : null;
    if (hexInput) {
      var hexKey = hexInput.getAttribute('data-wb-hex');
      var normalized = wbNormalizeHex(hexInput.value);
      if (!normalized) {
        hexInput.value = wbNormalizeHex(wbResolveStyle(wbState.draft, wbState.currentType)[hexKey]) || '#FFFFFF';
        hexInput.classList.remove('is-invalid');
      } else {
        wbSetField(hexKey, normalized);
        hexInput.value = normalized;
      }
    }
  }

  function wbOnMatrixBlur(e) {
    var target = e.target;
    var hexInput = target.closest ? target.closest('[data-wb-hex]') : null;
    if (!hexInput) return;
    var key = hexInput.getAttribute('data-wb-hex');
    if (!wbNormalizeHex(hexInput.value)) {
      hexInput.value = wbNormalizeHex(wbResolveStyle(wbState.draft, wbState.currentType)[key]) || '#FFFFFF';
      hexInput.classList.remove('is-invalid');
    }
  }

  function wbShowToast(text, options) {
    if (!wbDom.toast) return;
    wbClearToast();
    wbDom.toastText.textContent = String(text || '');
    wbDom.toast.hidden = false;
    if (options && typeof options.undo === 'function') {
      var remaining = 10;
      wbState.undoAction = options.undo;
      wbDom.undoBtn.hidden = false;
      wbDom.undoBtn.innerHTML = '<svg class="wb-icon" aria-hidden="true"><use href="#wb-i-undo"></use></svg>撤销 (' + remaining + 's)';
      wbState.undoTimer = setInterval(function () {
        remaining -= 1;
        if (remaining <= 0) {
          wbClearToast();
          return;
        }
        wbDom.undoBtn.innerHTML = '<svg class="wb-icon" aria-hidden="true"><use href="#wb-i-undo"></use></svg>撤销 (' + remaining + 's)';
      }, 1000);
    } else {
      wbDom.undoBtn.hidden = true;
    }
    wbState.toastTimer = setTimeout(function () {
      wbClearToast();
    }, options && options.undo ? 10000 : 2600);
  }

  function wbClearToast() {
    if (wbState.toastTimer) { clearTimeout(wbState.toastTimer); wbState.toastTimer = 0; }
    if (wbState.undoTimer) { clearInterval(wbState.undoTimer); wbState.undoTimer = 0; }
    wbState.undoAction = null;
    if (wbDom.toast) wbDom.toast.hidden = true;
    if (wbDom.undoBtn) wbDom.undoBtn.hidden = true;
  }

  function wbConfirm(options) {
    if (wbConfirmState.open) return Promise.resolve(false);
    return new Promise(function (resolve) {
      wbConfirmState.open = true;
      wbConfirmState.resolve = resolve;
      wbConfirmState.trigger = document.activeElement;
      wbDom.confirmTitle.textContent = options && options.title ? options.title : '确认';
      wbDom.confirmBody.textContent = options && options.body ? options.body : '';
      wbDom.confirmOk.textContent = options && options.confirmLabel ? options.confirmLabel : '确认';
      wbDom.confirmOk.classList.add('wb-danger');
      wbDom.confirmMask.hidden = false;
      wbSetConfirmInert(true);
      requestAnimationFrame(function () {
        if (wbConfirmState.open) wbDom.confirmCancel.focus();
      });
    });
  }
  function wbCloseConfirm(result) {
    if (!wbConfirmState.open) return;
    var resolve = wbConfirmState.resolve;
    var trigger = wbConfirmState.trigger;
    wbConfirmState.open = false;
    wbConfirmState.resolve = null;
    wbConfirmState.trigger = null;
    wbDom.confirmMask.hidden = true;
    wbSetConfirmInert(false);
    if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) trigger.focus();
    if (resolve) resolve(!!result);
  }
  function wbSetConfirmInert(on) {
    var nodes = [
      wbDom.card.querySelector('.wb-head'),
      wbDom.card.querySelector('.wb-tabs'),
      wbDom.card.querySelector('.wb-body'),
      wbDom.card.querySelector('.wb-foot')
    ];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue;
      if (on) nodes[i].setAttribute('inert', '');
      else nodes[i].removeAttribute('inert');
    }
  }

  function wbRestoreCurrentType() {
    if (!wbState.loadOk) return;
    if (wbState.styleDomain === 'motion') {
      wbRestoreCurrentMotion();
      return;
    }
    if (wbState.styleDomain === 'typography') {
      wbRestoreCurrentTypography();
      return;
    }
    var type = wbState.currentType;
    var meta = WB_TYPE_META[type];
    wbConfirm({
      title: '恢复「' + meta.name + '」本类默认？',
      body: '将清空本类 ' + WB_STYLE_FIELD_COUNT + ' 个外观覆盖。主题、其他类型、固定规则与窗口几何不动。',
      confirmLabel: '恢复本类',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      for (var i = 0; i < WB_STYLE_FIELDS.length; i++) {
        wbState.draft.styles.types[type][WB_STYLE_FIELDS[i]] = null;
      }
      wbMarkDirty();
      wbRenderEditor();
      wbUpdateCoverage();
      wbShowToast('已恢复本类默认 · 只清空本类 ' + WB_STYLE_FIELD_COUNT + ' 项覆盖');
    });
  }
  function wbRestoreAllStyles() {
    if (!wbState.loadOk) return;
    wbConfirm({
      title: '全部外观恢复默认？',
    body: '将清空全部消息类型共 ' + (WB_TYPES.length * WB_STYLE_FIELD_COUNT) +
        ' 个外观覆盖。主题、固定规则、窗口几何与监看字号不动。',
      confirmLabel: '全部恢复',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      for (var t = 0; t < WB_TYPES.length; t++) {
        var type = WB_TYPES[t];
        for (var i = 0; i < WB_STYLE_FIELDS.length; i++) {
          wbState.draft.styles.types[type][WB_STYLE_FIELDS[i]] = null;
        }
      }
      // styles.global is a hidden legacy layer. Clear it explicitly so
      // "restore all" really returns to the selected theme baseline.
      for (var g = 0; g < WB_STYLE_FIELDS.length; g++) {
        wbState.draft.styles.global[WB_STYLE_FIELDS[g]] = null;
      }
      wbMarkDirty();
      wbRenderEditor();
      wbUpdateCoverage();
      wbShowToast('已清空外观与全局覆盖 · 主题、固定规则与窗口几何未动');
    });
  }
  function wbRestoreAllCurrentDomain() {
    if (wbState.styleDomain === 'motion') wbRestoreAllMotion();
    else if (wbState.styleDomain === 'typography') wbRestoreAllTypography();
    else wbRestoreAllStyles();
  }

  function wbClampDraft() {
    var geom = wbState.draft.geometry;
    geom.x = wbRound(geom.x, 60, -10000, 10000);
    geom.y = wbRound(geom.y, 120, -10000, 10000);
    geom.width = wbRound(geom.width, 520, 200, 3840);
    geom.height = wbRound(geom.height, 620, 200, 2160);
    geom.scale = clamp(wbFinite(geom.scale, 1), 0.5, 4);
    wbState.draft.showName = !!wbState.draft.showName;
    wbState.draft.nameSeparator = String(wbState.draft.nameSeparator || '：').slice(0, 4);
    wbState.draft.nameMaxLen = wbRound(wbState.draft.nameMaxLen, 12, 4, 24);
    wbState.draft.textMaxLen = wbRound(wbState.draft.textMaxLen, 100, 1, 10000);
    wbState.draft.maxLines = wbRound(wbState.draft.maxLines, 8, 0, 30);
    wbState.draft.gap = wbRound(wbState.draft.gap, 8, 0, 40);
    wbState.draft.align = ['left', 'center', 'right'].indexOf(wbState.draft.align) >= 0
      ? wbState.draft.align : 'left';
    wbState.draft.templateId = ['bubble', 'compact', 'focus'].indexOf(wbState.draft.templateId) >= 0
      ? wbState.draft.templateId : 'bubble';
    if (!wbState.draft.types) wbState.draft.types = {};
    for (var ti = 0; ti < WB_TYPES.length; ti++) {
      wbState.draft.types[WB_TYPES[ti]] = !!wbState.draft.types[WB_TYPES[ti]];
    }
    wbState.draft.pins = wbNormalizePins(wbState.draft.pins);
    wbState.draft.motion = wbNormalizeMotion(wbState.draft.motion, wbState.draft.motion && wbState.draft.motion.global
      ? null
      : 'slide');
    var typographyTheme = wbActiveTheme();
    wbState.draft.typography = wbNormalizeTypography(
      wbState.draft.typography,
      typographyTheme
    );
    for (var i = 0; i < WB_TYPES.length; i++) {
      wbState.draft.styles.types[WB_TYPES[i]] = wbNormalizeStyleOverride(wbState.draft.styles.types[WB_TYPES[i]]);
    }
  }
  function wbBuildOverlayPatch() {
    var types = {};
    for (var i = 0; i < WB_TYPES.length; i++) {
      var kind = WB_TYPES[i];
      types[kind] = wbNormalizeStyleOverride(wbState.draft.styles.types[kind]);
    }
    var motionTypes = {};
    for (var m = 0; m < WB_TYPES.length; m++) {
      var motionKind = WB_TYPES[m];
      motionTypes[motionKind] = wbNormalizeMotionOverride(wbState.draft.motion.types[motionKind]);
    }
    var typographyTypes = {};
    for (var t = 0; t < WB_TYPES.length; t++) {
      var typographyKind = WB_TYPES[t];
      typographyTypes[typographyKind] = wbNormalizeTypographyOverride(
        wbState.draft.typography.types[typographyKind]
      );
    }
    var stylesGlobal = wbState.draft.styles && typeof wbState.draft.styles.global === 'object'
      ? wbNormalizeStylePatch(wbState.draft.styles.global)
      : {};
    if (!Object.keys(stylesGlobal).length) {
      // An empty object cannot clear a previous global layer through the
      // backend's deep merge. Nulls are the explicit "follow theme" signal.
      for (var gf = 0; gf < WB_STYLE_FIELDS.length; gf++) {
        stylesGlobal[WB_STYLE_FIELDS[gf]] = null;
      }
    }
    var presetLayers = wbState.presetGlobalLayers || {};
    var motionGlobal = presetLayers.motion
      ? wbNormalizeMotionPartial(wbState.draft.motion.global)
      : null;
    var typographyGlobal = presetLayers.typography
      ? wbNormalizeTypographyPatch(wbState.draft.typography.global)
      : null;
    var geom = wbState.draft.geometry;
    return {
      enabled: !!wbState.draft.enabled,
      click_through: !!wbState.draft.clickThrough,
      always_on_top: !!wbState.draft.alwaysOnTop,
      geometry: {
        x: geom.x, y: geom.y, width: geom.width, height: geom.height,
        scale: Math.round(geom.scale * 100) / 100
      },
      styles: { theme: wbActiveTheme(), global: stylesGlobal, types: types },
      motion: motionGlobal ? { global: motionGlobal, types: motionTypes } : { types: motionTypes },
      typography: typographyGlobal
        ? { global: typographyGlobal, types: typographyTypes }
        : { types: typographyTypes },
      template_id: ['bubble', 'compact', 'focus'].indexOf(wbState.draft.templateId) >= 0
        ? wbState.draft.templateId : 'bubble',
      show_name: !!wbState.draft.showName,
      name_sep: String(wbState.draft.nameSeparator || '：').slice(0, 4),
      name_max_len: wbState.draft.nameMaxLen,
      text_max_len: wbState.draft.textMaxLen,
      max_lines: wbState.draft.maxLines,
      gap: wbState.draft.gap,
      align: wbState.draft.align,
      types: wbClone(wbState.draft.types),
      pins: wbClone(wbState.draft.pins)
    };
  }
  function wbCheckResponse(res, label) {
    if (res && typeof res === 'object' && res.ok === false) {
      throw new Error(label + '：' + (res.error || '未知原因'));
    }
    if (res && Array.isArray(res.rejected) && res.rejected.length) {
      throw new Error(label + '：参数被拒绝（' + res.rejected.join('、') +
        '）。已通过的字段可能已生效，请重新打开工作台确认。');
    }
  }
  function wbSaveSettings(options) {
    var auto = !!(options && options.auto);
    if (!wbState.open || wbState.loading || wbState.saving || !wbState.loadOk) return;
    wbClampDraft();
    wbCancelAutoSave();
    var saveSeq = wbState.editSeq;
    wbState.saving = true;
    wbSetError('');
    wbSetStatus('保存中…', 'busy');
    wbSetSync('保存中…', 'busy');
    wbSetSaveState();
    var overlayPatch = wbBuildOverlayPatch();
    overlayApi('apply_overlay', [overlayPatch]).then(function (res) {
      wbCheckResponse(res, '保存浮窗设置失败');
    }).then(function () {
      wbState.saving = false;
      var changedDuringSave = wbState.editSeq !== saveSeq;
      wbState.dirty = changedDuringSave;
      if (!changedDuringSave) {
        wbState.presetGlobalLayers = { motion: false, typography: false };
      }
      wbState.justSavedUntil = changedDuringSave ? 0 : Date.now() + 2200;
      state.config = deepMerge(state.config || defaultConfig(), {
        overlay: {
          enabled: overlayPatch.enabled,
          width: overlayPatch.geometry.width,
          height: overlayPatch.geometry.height,
          x: overlayPatch.geometry.x,
          y: overlayPatch.geometry.y,
          scale: overlayPatch.geometry.scale,
          click_through: overlayPatch.click_through,
          always_on_top: overlayPatch.always_on_top,
          styles: overlayPatch.styles,
          motion: wbClone(wbState.draft.motion),
          typography: wbClone(wbState.draft.typography),
          pins: overlayPatch.pins,
          template_id: overlayPatch.template_id
        }
      });
      setOverlayButtonActive(!!overlayPatch.enabled);
      setLog(auto ? '工作台修改已实时应用' : '弹幕工作台已保存');
      wbSetSync(auto ? '已实时应用 · 本地配置' : '已保存 · 本地配置', 'ok');
      wbSetStatus(auto ? '已实时应用 ✓' : '已保存 ✓ · 工作台保持打开', 'ok');
      wbSetError('');
      wbRenderAll();
      if (window.__MUTAI_SHELL__ && window.__MUTAI_SHELL__.state &&
        window.__MUTAI_SHELL__.state.view === 'picture' &&
        typeof window.__MUTAI_SHELL__.renderPicture === 'function') {
        window.__MUTAI_SHELL__.renderPicture();
      }
      wbSetSaveState();
      if (auto) {
        if (changedDuringSave) wbScheduleAutoSave();
      } else {
        wbShowToast('已保存 ✓ · 工作台保持打开');
      }
      if (wbState.savedTimer) clearTimeout(wbState.savedTimer);
      wbState.savedTimer = setTimeout(function () {
        wbState.savedTimer = 0;
        wbSetSaveState();
      }, 2300);
    }).catch(function (err) {
      wbState.saving = false;
      wbSetError('保存失败：' + overlayErrorText(err));
      wbSetStatus('保存失败', '');
      wbSetSync('保存失败', 'error');
      wbSetSaveState();
    });
  }

  function wbFocusableNodes(scope) {
    if (!scope) return [];
    var all = scope.querySelectorAll('button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), ' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    var list = [];
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') continue;
      if (!node.getClientRects || !node.getClientRects().length) continue;
      list.push(node);
    }
    return list;
  }
  function wbTrapFocus(e) {
    var scope = wbConfirmState.open ? wbDom.confirmCard : wbDom.card;
    var nodes = wbFocusableNodes(scope);
    if (!nodes.length) return;
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    var active = document.activeElement;
    if (nodes.indexOf(active) < 0) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    }
  }

  function wbSnapshot() {
    var coverage = {};
    for (var i = 0; i < WB_TYPES.length; i++) coverage[WB_TYPES[i]] = wbCoverageCount(WB_TYPES[i]);
    var motionCoverage = {};
    for (var mo = 0; mo < WB_TYPES.length; mo++) motionCoverage[WB_TYPES[mo]] = wbMotionCoverageCount(WB_TYPES[mo]);
    var typographyCoverage = {};
    for (var ty = 0; ty < WB_TYPES.length; ty++) typographyCoverage[WB_TYPES[ty]] = wbTypographyCoverageCount(WB_TYPES[ty]);
    var budget = wbComputeBudget();
    return {
      open: wbState.open,
      loading: wbState.loading,
      loadOk: wbState.loadOk,
      saving: wbState.saving,
      tab: wbState.tab,
      debugTab: wbState.debugTab,
      type: wbState.currentType,
      coverage: coverage,
      motionCoverage: motionCoverage,
      typographyCoverage: typographyCoverage,
      budget: budget,
      theme: wbActiveTheme(),
      enabled: wbState.draft.enabled,
      geometry: wbClone(wbState.draft.geometry),
      pins: wbClone(wbState.draft.pins),
      draft: wbClone(wbState.draft),
      calls: state.isMock && window.__mockDebug ? {
        apply_overlay: window.__mockDebug.calls.apply_overlay,
        lastOverlayPatch: wbClone(window.__mockDebug.calls.lastOverlayPatch)
      } : null
    };
  }

  ctx.modules.wbCore = {
    wbCacheDom: wbCacheDom,
    wbTypeIcon: wbTypeIcon,
    wbCoverageCount: wbCoverageCount,
    wbActiveTheme: wbActiveTheme,
    wbSetSwitch: wbSetSwitch,
    wbSetSync: wbSetSync,
    wbSetStatus: wbSetStatus,
    wbSetError: wbSetError,
    wbSetSaveState: wbSetSaveState,
    wbMarkDirty: wbMarkDirty,
    wbUpdateFootNote: wbUpdateFootNote,
    wbFetchConfig: wbFetchConfig,
    wbSetTab: wbSetTab,
    wbOnTabsKeydown: wbOnTabsKeydown,
    wbRenderAll: wbRenderAll,
    wbRenderTypeList: wbRenderTypeList,
    wbSelectType: wbSelectType,
    wbRenderBaseline: wbRenderBaseline,
    wbRenderEditor: wbRenderEditor,
    wbUpdateCoverageDisplay: wbUpdateCoverageDisplay,
    wbSetStyleDomain: wbSetStyleDomain,
    wbFieldRowHtml: wbFieldRowHtml,
    wbUpdateCoverage: wbUpdateCoverage,
    wbUpdateTypeCounts: wbUpdateTypeCounts,
    wbUpdateFieldMeta: wbUpdateFieldMeta,
    wbSyncRowControl: wbSyncRowControl,
    wbSetField: wbSetField,
    wbSetFieldToFollow: wbSetFieldToFollow,
    wbToggleFieldChip: wbToggleFieldChip,
    wbOnMatrixClick: wbOnMatrixClick,
    wbOnMatrixInput: wbOnMatrixInput,
    wbOnMatrixChange: wbOnMatrixChange,
    wbOnMatrixBlur: wbOnMatrixBlur,
    wbShowToast: wbShowToast,
    wbClearToast: wbClearToast,
    wbConfirm: wbConfirm,
    wbCloseConfirm: wbCloseConfirm,
    wbSetConfirmInert: wbSetConfirmInert,
    wbRestoreCurrentType: wbRestoreCurrentType,
    wbRestoreAllStyles: wbRestoreAllStyles,
    wbRestoreAllCurrentDomain: wbRestoreAllCurrentDomain,
    wbClampDraft: wbClampDraft,
    wbBuildOverlayPatch: wbBuildOverlayPatch,
    wbCheckResponse: wbCheckResponse,
    wbSaveSettings: wbSaveSettings,
    wbFocusableNodes: wbFocusableNodes,
    wbTrapFocus: wbTrapFocus,
    wbSnapshot: wbSnapshot
  };
})();
