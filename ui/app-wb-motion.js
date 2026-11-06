/* ============================================================
   幕台 · 工作台动效域（编辑 / 试跑 / 恢复）
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
  var wbNormalizeMotionValue = wb.helpers.wbNormalizeMotionValue;
  var wbRenderEditor = wb.helpers.wbRenderEditor;
  var wbResolveMotion = wb.helpers.wbResolveMotion;
  var wbResolveStyle = wb.helpers.wbResolveStyle;
  var wbResolveTypography = wb.helpers.wbResolveTypography;
  var wbRgba = wb.helpers.wbRgba;
  var wbShowToast = wb.helpers.wbShowToast;
  var wbUpdateCoverageDisplay = wb.helpers.wbUpdateCoverageDisplay;
  var wbUpdateTypeCounts = wb.helpers.wbUpdateTypeCounts;
  var WB_DIRECTION_LABELS = wb.constants.WB_DIRECTION_LABELS;
  var WB_DIRECTION_VECTORS = wb.constants.WB_DIRECTION_VECTORS;
  var WB_MOTION_FIELDS = wb.constants.WB_MOTION_FIELDS;
  var WB_MOTION_FIELD_COUNT = wb.constants.WB_MOTION_FIELD_COUNT;
  var WB_MOTION_FIELD_META = wb.constants.WB_MOTION_FIELD_META;
  var WB_TYPES = wb.constants.WB_TYPES;
  var WB_TYPE_META = wb.constants.WB_TYPE_META;
  var reducedMotionMedia = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

  function syncReducedMotionHint() {
    if (!wbDom.motionReduced) return;
    wbDom.motionReduced.hidden = !wbPrefersReducedMotion();
  }

  if (reducedMotionMedia) {
    if (typeof reducedMotionMedia.addEventListener === "function") {
      reducedMotionMedia.addEventListener("change", syncReducedMotionHint);
    } else if (typeof reducedMotionMedia.addListener === "function") {
      reducedMotionMedia.addListener(syncReducedMotionHint);
    }
  }

  function wbRenderMotionEditor() {
    var type = wbState.currentType;
    var resolved = wbResolveMotion(wbState.draft, type);
    var core = {
      enter: ['enter_anim', 'enter_ms', 'enter_dir'],
      exit: ['exit_anim', 'exit_ms', 'exit_dir']
    };
    var advanced = {
      enter: ['enter_distance', 'enter_scale', 'enter_opacity'],
      exit: ['exit_distance', 'exit_scale', 'exit_opacity']
    };
    wbDom.motionCore.innerHTML =
      wbMotionCardHtml('入场', '新消息出现', core.enter, resolved) +
      wbMotionCardHtml('退场', '旧消息离开', core.exit, resolved);
    wbDom.motionAdvancedGrid.innerHTML =
      wbMotionCardHtml('入场 · 高级', '滑入位移 / 缩放 / 透明度', advanced.enter, resolved, true) +
      wbMotionCardHtml('退场 · 高级', '退场偏移 / 缩放 / 透明度', advanced.exit, resolved, true);
    syncReducedMotionHint();
    wbUpdateMotionCoverage();
  }

  function wbMotionCardHtml(title, sub, fields, resolved, advanced) {
    var html = '<section class="wb-motion-card' + (advanced ? ' is-advanced' : '') + '">' +
      '<div class="wb-motion-card-head"><b>' + wbEscape(title) + '</b><span>' + wbEscape(sub) + '</span></div>';
    for (var i = 0; i < fields.length; i++) {
      html += wbMotionRowHtml(fields[i], resolved);
    }
    return html + '</section>';
  }

  function wbMotionDisabled(key, resolved) {
    if (key === 'enter_dir' || key === 'enter_distance') return resolved.enter_anim !== 'slide';
    if (key === 'enter_scale') return resolved.enter_anim !== 'scale';
    if (key === 'enter_opacity') return resolved.enter_anim === 'none';
    if (key === 'exit_dir' || key === 'exit_distance') return resolved.exit_anim === 'none';
    if (key === 'exit_scale') return resolved.exit_anim !== 'scale';
    if (key === 'exit_opacity') return resolved.exit_anim === 'none';
    return false;
  }

  function wbMotionRowHtml(key, resolved) {
    var meta = WB_MOTION_FIELD_META[key];
    var source = wbState.draft.motion.types[wbState.currentType] || {};
    var override = source[key];
    var overridden = override !== null && override !== undefined;
    var value = overridden ? override : resolved[key];
    var disabled = wbMotionDisabled(key, resolved);
    var control = '';
    if (meta.type === 'segmented' || meta.type === 'direction') {
      var options = meta.type === 'direction'
        ? ['up', 'down', 'left', 'right']
        : meta.options;
      control = '<div class="wb-seg" role="group" aria-label="' + wbEscape(meta.label) + '">';
      for (var i = 0; i < options.length; i++) {
        var opt = options[i];
        var label = meta.type === 'direction'
          ? WB_DIRECTION_LABELS[meta.phase][opt]
          : meta.labels[opt];
        control += '<button type="button" data-wb-motion-set="' + key + '" data-wb-motion-value="' + opt +
          '" data-wb-motion-label="' + wbEscape(meta.label + ' ' + label) +
          '" aria-pressed="' + (String(value) === String(opt) ? 'true' : 'false') + '"' +
          (disabled ? ' disabled' : '') +
          (String(value) === String(opt) ? ' class="is-active"' : '') + '>' + label + '</button>';
      }
      control += '</div>';
    } else {
      control = '<div class="wb-stepper">' +
        '<button type="button" data-wb-motion-step="' + key + '" data-wb-motion-delta="-' + meta.step + '" aria-label="减少' + meta.label + '"' +
        (disabled ? ' disabled' : '') + '>−</button>' +
        '<input type="number" data-wb-motion-number="' + key + '" min="' + meta.min + '" max="' + meta.max +
        '" step="' + meta.step + '" value="' + value + '" aria-label="' + meta.label + '"' +
        (disabled ? ' disabled' : '') + '>' +
        '<span class="suffix">' + meta.suffix + '</span>' +
        '<button type="button" data-wb-motion-step="' + key + '" data-wb-motion-delta="' + meta.step + '" aria-label="增加' + meta.label + '"' +
        (disabled ? ' disabled' : '') + '>＋</button>' +
        '</div>';
    }
    var hint = meta.hint ? '<small>' + wbEscape(meta.hint) + '</small>' : '';
    return '<div class="wb-motion-row" data-wb-motion-field="' + key + '">' +
      '<span class="wb-motion-label">' + wbEscape(meta.label) + hint + '</span>' +
      '<span class="wb-motion-control' + (disabled ? ' is-disabled' : '') + '">' + control + '</span>' +
      '<span class="wb-motion-state">' +
      (overridden
        ? '<button class="wb-motion-reset" type="button" data-wb-motion-reset="' + key + '" aria-label="' + wbEscape(meta.label + '恢复继承') + '">恢复</button>'
        : '<span class="wb-motion-inherit" title="继承全局" aria-label="' + wbEscape(meta.label + '继承全局') + '"></span>') +
      '</span></div>';
  }

  function wbUpdateMotionCoverage() {
    if (wbDom.motionCount) {
      wbDom.motionCount.textContent = '动效 · 6 项核心 + 6 项高级';
    }
  }


  function wbOnMotionClick(e) {
    var target = e.target;
    var reset = target.closest ? target.closest('[data-wb-motion-reset]') : null;
    if (reset) {
      var resetKey = reset.getAttribute('data-wb-motion-reset');
      wbSetMotionField(resetKey, null, '[data-wb-motion-set="' + resetKey + '"]');
      return;
    }
    var step = target.closest ? target.closest('[data-wb-motion-step]') : null;
    if (step) {
      var stepKey = step.getAttribute('data-wb-motion-step');
      var meta = WB_MOTION_FIELD_META[stepKey];
      var source = wbState.draft.motion.types[wbState.currentType];
      var resolved = wbResolveMotion(wbState.draft, wbState.currentType);
      var base = source[stepKey] !== null && source[stepKey] !== undefined ? source[stepKey] : resolved[stepKey];
      var next = clamp(Number(base) + Number(step.getAttribute('data-wb-motion-delta')), meta.min, meta.max);
      wbSetMotionField(stepKey, Math.round(next),
        '[data-wb-motion-step="' + stepKey + '"][data-wb-motion-delta="' + step.getAttribute('data-wb-motion-delta') + '"]');
      return;
    }
    var set = target.closest ? target.closest('[data-wb-motion-set]') : null;
    if (set) {
      var setKey = set.getAttribute('data-wb-motion-set');
      var raw = set.getAttribute('data-wb-motion-value');
      var numeric = Number(raw);
      wbSetMotionField(setKey, isFinite(numeric) && String(numeric) === raw ? numeric : raw,
        '[data-wb-motion-set="' + setKey + '"][data-wb-motion-value="' + raw + '"]');
    }
  }

  function wbSetMotionField(key, value, focusSelector) {
    if (!WB_MOTION_FIELD_META[key]) return;
    var cleaned = value === null || value === undefined || value === ''
      ? null
      : wbNormalizeMotionValue(key, value);
    if (value !== null && value !== undefined && value !== '' && cleaned === null) return;
    wbState.draft.motion.types[wbState.currentType][key] = cleaned;
    wbMarkDirty();
    wbRenderMotionEditor();
    wbUpdateCoverageDisplay();
    wbUpdateTypeCounts();
    if (focusSelector) {
      var node = wbDom.motionPanel.querySelector(focusSelector);
      if (!node) node = wbDom.motionPanel.querySelector('[data-wb-motion-number="' + key + '"]');
      if (node) node.focus();
    }
  }

  function wbOnMotionInput(e) {
    var number = e.target.closest ? e.target.closest('[data-wb-motion-number]') : null;
    if (!number) return;
    var key = number.getAttribute('data-wb-motion-number');
    var meta = WB_MOTION_FIELD_META[key];
    var value = Number(number.value);
    if (!isFinite(value)) {
      number.classList.add('is-invalid');
      return;
    }
    number.classList.remove('is-invalid');
    var clamped = clamp(Math.round(value), meta.min, meta.max);
    var resolved = wbResolveMotion(wbState.draft, wbState.currentType);
    var source = wbState.draft.motion.types[wbState.currentType];
    var before = source[key];
    source[key] = clamped;
    if (before !== clamped) wbMarkDirty();
    wbUpdateMotionCoverage();
    wbUpdateCoverageDisplay();
    wbUpdateTypeCounts();
  }

  function wbOnMotionChange(e) {
    var number = e.target.closest ? e.target.closest('[data-wb-motion-number]') : null;
    if (!number) return;
    var key = number.getAttribute('data-wb-motion-number');
    var meta = WB_MOTION_FIELD_META[key];
    if (number.value === '') {
      wbSetMotionField(key, null, '[data-wb-motion-number="' + key + '"]');
      return;
    }
    var value = clamp(Math.round(Number(number.value)), meta.min, meta.max);
    wbSetMotionField(key, value, '[data-wb-motion-number="' + key + '"]');
  }

  function wbOnMotionBlur(e) {
    var number = e.target.closest ? e.target.closest('[data-wb-motion-number]') : null;
    if (!number) return;
    var key = number.getAttribute('data-wb-motion-number');
    var meta = WB_MOTION_FIELD_META[key];
    var resolved = wbResolveMotion(wbState.draft, wbState.currentType);
    var source = wbState.draft.motion.types[wbState.currentType];
    var current = Number(number.value);
    if (!isFinite(current)) {
      var value = source[key] !== null && source[key] !== undefined ? source[key] : resolved[key];
      number.value = String(value);
      number.classList.remove('is-invalid');
      return;
    }
    var clamped = clamp(Math.round(current), meta.min, meta.max);
    if (clamped !== current) number.value = String(clamped);
  }

  function wbPrefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function wbEaseOutCubic(t) {
    t = clamp(t, 0, 1);
    return 1 - Math.pow(1 - t, 3);
  }

  function wbEaseInCubic(t) {
    t = clamp(t, 0, 1);
    return Math.pow(t, 3);
  }

  function wbMotionFrame(spec, phase, t, fontPx) {
    var anim = String(spec[phase + '_anim'] || 'none');
    var duration = Number(spec[phase + '_ms'] || 0);
    if (anim === 'none' || duration <= 0) {
      return { dx: 0, dy: 0, scale: 1, opacity: phase === 'enter' ? 1 : 0 };
    }
    var eased = phase === 'enter' ? wbEaseOutCubic(t) : wbEaseInCubic(t);
    var opacity = 1;
    var scale = 1;
    var dx = 0;
    var dy = 0;
    if (phase === 'enter') {
      var startOpacity = clamp(Number(spec.enter_opacity) / 100, 0, 1);
      opacity = startOpacity + (1 - startOpacity) * eased;
      if (anim === 'scale') {
        var startScale = clamp(Number(spec.enter_scale) / 100, 0.5, 1);
        scale = startScale + (1 - startScale) * eased;
      }
      if (anim === 'slide') {
        var enterVec = WB_DIRECTION_VECTORS[spec.enter_dir] || [0, 0];
        var enterDistance = Number(spec.enter_distance);
        if (!(enterDistance > 0)) enterDistance = Math.max(24, fontPx * 1.35);
        dx = enterVec[0] * enterDistance * (1 - eased);
        dy = enterVec[1] * enterDistance * (1 - eased);
      }
    } else {
      var endOpacity = clamp(Number(spec.exit_opacity) / 100, 0, 1);
      opacity = 1 - (1 - endOpacity) * eased;
      if (anim === 'scale') {
        var endScale = clamp(Number(spec.exit_scale) / 100, 0.5, 1);
        scale = 1 + (endScale - 1) * eased;
      }
      var exitVec = WB_DIRECTION_VECTORS[spec.exit_dir] || [0, 0];
      var exitDistance = Math.max(0, Number(spec.exit_distance) || 0);
      dx = exitVec[0] * exitDistance * eased;
      dy = exitVec[1] * exitDistance * eased;
    }
    return { dx: dx, dy: dy, scale: scale, opacity: opacity };
  }

  function wbResetMotionElement(element, baseOpacity) {
    if (!element) return;
    element.style.transform = '';
    element.style.opacity = String(baseOpacity);
    element.style.transformOrigin = '';
    element.style.willChange = '';
  }

  function wbCancelMotionPreview() {
    wbState.motionAnimRun += 1;
    if (wbState.motionAnimFrame) {
      cancelAnimationFrame(wbState.motionAnimFrame);
      wbState.motionAnimFrame = 0;
    }
    if (wbState.motionAnimEl) {
      wbResetMotionElement(wbState.motionAnimEl, wbState.motionAnimBase);
      wbState.motionAnimEl = null;
    }
  }

  function wbPlayMotionPreview(element, baseOpacity, options) {
    if (!element) return;
    wbCancelMotionPreview();
    var spec = wbResolveMotion(wbState.draft, wbState.currentType);
    var token = ++wbState.motionAnimRun;
    wbState.motionAnimEl = element;
    wbState.motionAnimBase = baseOpacity;
    element.style.transformOrigin = 'center';
    element.style.willChange = 'transform, opacity';
    if (spec.enter_anim === 'none' && spec.exit_anim === 'none') {
      wbResetMotionElement(element, baseOpacity);
      wbShowToast('当前类型没有入场/退场动画');
      return;
    }
    if (wbPrefersReducedMotion()) {
      wbResetMotionElement(element, baseOpacity);
      return;
    }
    var fontPx = Number(wbResolveStyle(wbState.draft, wbState.currentType).font_size) || 22;
    var enterMs = spec.enter_anim !== 'none' ? Math.max(0, Number(spec.enter_ms) || 0) : 0;
    var exitMs = spec.exit_anim !== 'none' ? Math.max(0, Number(spec.exit_ms) || 0) : 0;
    var started = performance.now();
    var holdMs = 500;
    var enterEnd = started + enterMs;
    var holdEnd = enterEnd + holdMs;
    var exitEnd = holdEnd + exitMs;
    function apply(frame) {
      element.style.transform = 'translate(' + frame.dx.toFixed(2) + 'px,' + frame.dy.toFixed(2) + 'px) scale(' +
        frame.scale.toFixed(4) + ')';
      element.style.opacity = String(Math.max(0, Math.min(1, baseOpacity * frame.opacity)));
    }
    function tick(now) {
      if (token !== wbState.motionAnimRun) return;
      if (enterMs > 0 && now < enterEnd) {
        var tEnter = (now - started) / enterMs;
        apply(wbMotionFrame(spec, 'enter', tEnter, fontPx));
      } else if (now < holdEnd) {
        apply(wbMotionFrame(spec, 'enter', 1, fontPx));
      } else if (exitMs > 0 && now < exitEnd) {
        var tExit = (now - holdEnd) / exitMs;
        apply(wbMotionFrame(spec, 'exit', tExit, fontPx));
      } else {
        wbResetMotionElement(element, baseOpacity);
        wbState.motionAnimEl = null;
        wbState.motionAnimFrame = 0;
        return;
      }
      wbState.motionAnimFrame = requestAnimationFrame(tick);
    }
    wbState.motionAnimFrame = requestAnimationFrame(tick);
  }


  function wbRestoreCurrentMotion() {
    if (!wbState.loadOk) return;
    var type = wbState.currentType;
    var meta = WB_TYPE_META[type];
    wbConfirm({
      title: '恢复「' + meta.name + '」本类动效？',
      body: '将清空本类 ' + WB_MOTION_FIELD_COUNT + ' 项动效覆盖。外观、主题、固定规则与窗口几何不动。',
      confirmLabel: '恢复本类动效',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      for (var i = 0; i < WB_MOTION_FIELDS.length; i++) {
        wbState.draft.motion.types[type][WB_MOTION_FIELDS[i]] = null;
      }
      wbMarkDirty();
      wbRenderEditor();
      wbUpdateMotionCoverage();
      wbShowToast('已恢复本类动效 · 只清空 ' + WB_MOTION_FIELD_COUNT + ' 项覆盖');
    });
  }

  function wbRestoreAllMotion() {
    if (!wbState.loadOk) return;
    wbConfirm({
      title: '全部动效恢复默认？',
      body: '将清空五类消息共 ' + (WB_TYPES.length * WB_MOTION_FIELD_COUNT) +
        ' 个动效覆盖。外观、排版、主题、固定规则与窗口几何不动。',
      confirmLabel: '全部恢复动效',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      for (var t = 0; t < WB_TYPES.length; t++) {
        var type = WB_TYPES[t];
        for (var i = 0; i < WB_MOTION_FIELDS.length; i++) {
          wbState.draft.motion.types[type][WB_MOTION_FIELDS[i]] = null;
        }
      }
      wbMarkDirty();
      wbRenderEditor();
      wbUpdateCoverageDisplay();
      wbShowToast('已清空五类动效覆盖 · 外观、排版、规则与几何未动');
    });
  }

  ctx.modules.wbMotion = {
    wbRenderMotionEditor: wbRenderMotionEditor,
    wbMotionCardHtml: wbMotionCardHtml,
    wbMotionDisabled: wbMotionDisabled,
    wbMotionRowHtml: wbMotionRowHtml,
    wbUpdateMotionCoverage: wbUpdateMotionCoverage,
    wbOnMotionClick: wbOnMotionClick,
    wbSetMotionField: wbSetMotionField,
    wbOnMotionInput: wbOnMotionInput,
    wbOnMotionChange: wbOnMotionChange,
    wbOnMotionBlur: wbOnMotionBlur,
    wbPrefersReducedMotion: wbPrefersReducedMotion,
    wbEaseOutCubic: wbEaseOutCubic,
    wbEaseInCubic: wbEaseInCubic,
    wbMotionFrame: wbMotionFrame,
    wbResetMotionElement: wbResetMotionElement,
    wbCancelMotionPreview: wbCancelMotionPreview,
    wbPlayMotionPreview: wbPlayMotionPreview,
    wbRestoreCurrentMotion: wbRestoreCurrentMotion,
    wbRestoreAllMotion: wbRestoreAllMotion
  };
})();
