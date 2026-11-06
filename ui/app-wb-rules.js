/* ============================================================
   幕台 · 工作台固定规则域（置顶 / 置底 / 预算）
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
  var wbClone = wb.helpers.wbClone;
  var wbConfirm = wb.helpers.wbConfirm;
  var wbEscape = wb.helpers.wbEscape;
  var wbFinite = wb.helpers.wbFinite;
  var wbMarkDirty = wb.helpers.wbMarkDirty;
  var wbResolveBaseStyle = wb.helpers.wbResolveBaseStyle;
  var wbRound = wb.helpers.wbRound;
  var wbScheduleStructureFit = wb.helpers.wbScheduleStructureFit;
  var wbShowToast = wb.helpers.wbShowToast;
  var WB_PIN_DEFAULTS = wb.constants.WB_PIN_DEFAULTS;

  var WB_PIN_META = {
    gift: { name: '礼物', code: 'GIFT', color: 'var(--wb-gift)', icon: '#wb-i-gift', sub: '低于门槛不展示；开启后不再进入滚动流' },
    sc: { name: '醒目留言', code: 'SC', color: 'var(--wb-sc)', icon: '#wb-i-star', sub: '付费留言；固定失败不复制进滚动流' },
    guard: { name: '舰长', code: 'GUARD', color: 'var(--wb-guard)', icon: '#wb-i-crown', sub: '大航海；与礼物 / SC 共享固定预算' },
    danmaku: { name: '弹幕', code: 'DANMAKU', color: 'var(--accent)', icon: '#wb-i-chat', sub: '普通弹幕固定展示；不设同屏上限' },
    enter: { name: '入场', code: 'ENTER', color: 'var(--ok)', icon: '#wb-i-enter', sub: '进入直播间的提示；不设同屏上限' },
    like: { name: '点赞', code: 'LIKE', color: 'var(--warn)', icon: '#wb-i-star', sub: '抖音点赞；高频互动建议只上屏' },
    social: { name: '关注', code: 'SOCIAL', color: 'var(--ok)', icon: '#wb-i-enter', sub: '关注 / 分享直播间（B站 / 抖音）' },
    fansclub: { name: '粉丝团', code: 'FANSCLUB', color: 'var(--warn)', icon: '#wb-i-star', sub: '抖音加入粉丝团 / 粉丝团升级' }
  };
  var wbPlatform = wb.helpers.wbPlatform;
  var wbPinLanesForPlatform = wb.helpers.wbPinLanesForPlatform;

  function wbLaneOrder() {
    return wbPinLanesForPlatform();
  }

  function wbLaneName(lane) {
    return WB_PIN_META[lane] ? WB_PIN_META[lane].name : lane;
  }

  function wbLaneColor(lane) {
    return WB_PIN_META[lane] ? WB_PIN_META[lane].color : '#566378';
  }

  function wbZeroBadge(field, value) {
    return value === 0
      ? '<span class="wb-zero-hint" title="0 = 不限，需手动清理或由同类消息挤出">∞</span>'
      : '';
  }

  function wbPinRowHtml(lane) {
    var pin = wbState.draft.pins[lane];
    var meta = WB_PIN_META[lane];
    var sec = Math.round(pin.duration_ms / 1000);
    var noCount = lane === 'danmaku' || lane === 'enter';
    var countCell = noCount
      ? '<td><span class="wb-not-applicable" title="不设同屏上限，仍受固定区预算约束">—</span></td>'
      : '<td><div class="wb-stepper"><button type="button" data-wb-pin-step="' + lane +
        '" data-wb-pin-field="max" data-wb-delta="-1" aria-label="减少条数">−</button>' +
        '<input type="number" data-wb-pin-number="' + lane + '" data-wb-pin-field="max" value="' + pin.max +
        '" min="0" max="6" step="1" aria-label="同屏条数（0 为不限）" title="0 = 不限条数，受窗口固定区预算约束">' +
        '<span class="suffix">条</span>' + wbZeroBadge('max', pin.max) +
        '<button type="button" data-wb-pin-step="' + lane +
        '" data-wb-pin-field="max" data-wb-delta="1" aria-label="增加条数">＋</button></div></td>';
    return '<tr data-wb-lane="' + lane + '">' +
      '<td><div class="wb-pin-type" style="--type:' + meta.color + '"><span class="wb-pin-icon">' +
      '<svg class="wb-icon" aria-hidden="true"><use href="' + meta.icon + '"></use></svg></span>' +
      '<span class="wb-pin-copy"><b>' + meta.name + ' <code>' + meta.code + '</code></b><span>' + meta.sub + '</span></span></div></td>' +
      '<td><button class="wb-switch' + (pin.enabled ? ' is-on' : '') + '" type="button" data-wb-pin-toggle="' + lane +
      '" role="switch" aria-checked="' + (pin.enabled ? 'true' : 'false') + '"><span class="track"></span><span class="wb-switch-label">' +
      (pin.enabled ? '开' : '关') + '</span></button></td>' +
      '<td><div class="wb-seg"><button type="button" data-wb-pin-position="' + lane + '" data-wb-position="top"' +
      (pin.position === 'top' ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"') + '>顶部</button><button type="button" data-wb-pin-position="' +
      lane + '" data-wb-position="bottom"' + (pin.position === 'bottom' ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"') + '>底部</button></div></td>' +
      '<td><div class="wb-stepper"><button type="button" data-wb-pin-step="' + lane + '" data-wb-pin-field="duration_ms" data-wb-delta="-1000" aria-label="减少停留时长">−</button>' +
      '<input type="number" data-wb-pin-number="' + lane + '" data-wb-pin-field="duration_ms" value="' + sec + '" min="0" max="30" step="1" aria-label="停留时长（0 为不限）" title="0 = 不限时，直到被同类消息挤出">' +
      '<span class="suffix">s</span>' + wbZeroBadge('duration_ms', sec) +
      '<button type="button" data-wb-pin-step="' + lane + '" data-wb-pin-field="duration_ms" data-wb-delta="1000" aria-label="增加停留时长">＋</button></div></td>' +
      countCell +
      '<td>' + (lane === 'gift'
        ? '<div class="wb-price-wrap"><span class="currency">¥</span><input type="number" data-wb-pin-number="' + lane +
          '" data-wb-pin-field="min_price" value="' + pin.min_price + '" min="0" max="100000" step="1" aria-label="礼物最低价值"><span class="wb-not-applicable">起</span></div>'
        : '<span class="wb-not-applicable">不适用 · 仅礼物</span>') + '</td>' +
      '</tr>';
  }

  function wbPinCardHtml(lane) {
    var pin = wbState.draft.pins[lane];
    var meta = WB_PIN_META[lane];
    var sec = Math.round(pin.duration_ms / 1000);
    var noCount = lane === 'danmaku' || lane === 'enter';
    var countField = noCount ? '' :
      '<div class="wb-rule-field"><span>条数</span><div class="wb-stepper"><button type="button" data-wb-pin-step="' + lane +
      '" data-wb-pin-field="max" data-wb-delta="-1">−</button><input type="number" data-wb-pin-number="' + lane +
      '" data-wb-pin-field="max" value="' + pin.max + '" min="0" max="6" step="1" title="0 = 不限条数"><span class="suffix">条</span>' +
      wbZeroBadge('max', pin.max) +
      '<button type="button" data-wb-pin-step="' + lane + '" data-wb-pin-field="max" data-wb-delta="1">＋</button></div></div>';
    return '<section class="wb-rule-card" data-wb-lane="' + lane + '">' +
      '<div class="wb-rule-card-head" style="--type:' + meta.color + '"><span class="wb-pin-icon">' +
      '<svg class="wb-icon" aria-hidden="true"><use href="' + meta.icon + '"></use></svg></span>' +
      '<span class="wb-pin-copy"><b>' + meta.name + ' <code>' + meta.code + '</code></b><span>' + meta.sub + '</span></span></div>' +
      '<div class="wb-rule-card-grid">' +
      '<div class="wb-rule-field"><span>启用</span><button class="wb-switch' + (pin.enabled ? ' is-on' : '') +
      '" type="button" data-wb-pin-toggle="' + lane + '" role="switch" aria-checked="' + (pin.enabled ? 'true' : 'false') +
      '"><span class="track"></span><span class="wb-switch-label">' + (pin.enabled ? '开' : '关') + '</span></button></div>' +
      '<div class="wb-rule-field"><span>位置</span><div class="wb-seg"><button type="button" data-wb-pin-position="' + lane +
      '" data-wb-position="top"' + (pin.position === 'top' ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"') + '>顶部</button>' +
      '<button type="button" data-wb-pin-position="' + lane + '" data-wb-position="bottom"' +
      (pin.position === 'bottom' ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"') + '>底部</button></div></div>' +
      '<div class="wb-rule-field"><span>时长</span><div class="wb-stepper"><button type="button" data-wb-pin-step="' + lane +
      '" data-wb-pin-field="duration_ms" data-wb-delta="-1000">−</button><input type="number" data-wb-pin-number="' + lane +
      '" data-wb-pin-field="duration_ms" value="' + sec + '" min="0" max="30" step="1" title="0 = 不限时"><span class="suffix">s</span>' + wbZeroBadge('duration_ms', sec) +
      '<button type="button" data-wb-pin-step="' + lane + '" data-wb-pin-field="duration_ms" data-wb-delta="1000">＋</button></div></div>' +
      countField +
      (lane === 'gift'
        ? '<div class="wb-rule-field"><span>最低价值</span><span class="wb-price-wrap"><span class="currency">¥</span><input type="number" data-wb-pin-number="' +
          lane + '" data-wb-pin-field="min_price" value="' + pin.min_price + '" min="0" max="100000" step="1"></span></div>'
        : '<div class="wb-rule-field"><span>最低价值</span><span class="wb-not-applicable">仅礼物适用</span></div>') +
      '</div></section>';
  }

  function wbRenderRules() {
    var lanes = wbLaneOrder();
    var tableHtml = '';
    var cardsHtml = '';
    for (var i = 0; i < lanes.length; i++) {
      tableHtml += wbPinRowHtml(lanes[i]);
      cardsHtml += wbPinCardHtml(lanes[i]);
    }
    wbDom.rulesBody.innerHTML = tableHtml;
    wbDom.rulesCards.innerHTML = cardsHtml;
    var isCards = wbState.rulesView === 'cards';
    wbDom.rulesTableWrap.hidden = isCards;
    wbDom.rulesCards.hidden = !isCards;
    var buttons = wbDom.rulesViewSwitch.querySelectorAll('[data-wb-rules-view]');
    for (var b = 0; b < buttons.length; b++) {
      var active = buttons[b].getAttribute('data-wb-rules-view') === (isCards ? 'cards' : 'table');
      buttons[b].classList.toggle('is-active', active);
      buttons[b].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    wbUpdateRulesBudget();
  }

  function wbPinLaneFrom(target) {
    var row = target.closest ? target.closest('[data-wb-lane]') : null;
    if (!row) return null;
    var lane = row.getAttribute('data-wb-lane');
    return wbLaneOrder().indexOf(lane) >= 0 ? lane : null;
  }

  function wbOnPinClick(e) {
    var target = e.target;
    var lane = wbPinLaneFrom(target);
    if (!lane) return;
    var toggle = target.closest ? target.closest('[data-wb-pin-toggle]') : null;
    if (toggle) {
      wbState.draft.pins[lane].enabled = !wbState.draft.pins[lane].enabled;
      wbMarkDirty();
      wbRenderRules();
      var toggleAfter = document.querySelector('[data-wb-pin-toggle="' + lane + '"]');
      if (toggleAfter) toggleAfter.focus();
      return;
    }
    var position = target.closest ? target.closest('[data-wb-pin-position]') : null;
    if (position) {
      var nextPosition = position.getAttribute('data-wb-position') === 'bottom' ? 'bottom' : 'top';
      wbState.draft.pins[lane].position = nextPosition;
      wbMarkDirty();
      wbRenderRules();
      var positionAfter = document.querySelector(
        '[data-wb-pin-position="' + lane + '"][data-wb-position="' + nextPosition + '"]'
      );
      if (positionAfter) positionAfter.focus();
      return;
    }
    var step = target.closest ? target.closest('[data-wb-pin-step]') : null;
    if (!step) return;
    var field = step.getAttribute('data-wb-pin-field');
    var delta = wbFinite(step.getAttribute('data-wb-delta'), 0);
    if (field === 'duration_ms') {
      wbState.draft.pins[lane].duration_ms = wbRound(wbState.draft.pins[lane].duration_ms + delta, 8000, 0, 30000);
    } else if (field === 'max') {
      wbState.draft.pins[lane].max = wbRound(wbState.draft.pins[lane].max + delta, 1, 0, 6);
    }
    wbMarkDirty();
    wbRenderRules();
    var stepAfter = document.querySelector(
      '[data-wb-pin-step="' + lane + '"][data-wb-pin-field="' + field +
      '"][data-wb-delta="' + delta + '"]'
    );
    if (stepAfter) stepAfter.focus();
  }

  function wbApplyPinNumber(lane, field, raw) {
    var pin = wbState.draft.pins[lane];
    if (!pin) return;
    if (field === 'duration_ms') {
      var sec = wbRound(raw, pin.duration_ms / 1000, 0, 30);
      pin.duration_ms = Math.round(sec) * 1000;
    } else if (field === 'max') {
      pin.max = wbRound(raw, pin.max, 0, 6);
    } else if (field === 'min_price' && lane === 'gift') {
      pin.min_price = clamp(wbFinite(raw, pin.min_price), 0, 100000);
    }
    wbMarkDirty();
    wbUpdateRulesBudget();
  }

  function wbOnPinInput(e) {
    var input = e.target;
    if (!input.matches || !input.matches('[data-wb-pin-number]')) return;
    var lane = input.getAttribute('data-wb-pin-number');
    var field = input.getAttribute('data-wb-pin-field');
    if (input.value === '') return;
    wbApplyPinNumber(lane, field, input.value);
  }

  function wbOnPinChange(e) {
    var input = e.target;
    if (!input.matches || !input.matches('[data-wb-pin-number]')) return;
    var lane = input.getAttribute('data-wb-pin-number');
    var field = input.getAttribute('data-wb-pin-field');
    wbApplyPinNumber(lane, field, input.value);
    if (field === 'duration_ms') input.value = String(Math.round(wbState.draft.pins[lane].duration_ms / 1000));
    else if (field === 'max') input.value = String(wbState.draft.pins[lane].max);
    else if (field === 'min_price') input.value = String(wbState.draft.pins[lane].min_price);
  }

  function wbComputeBudget() {
    var H = clamp(wbFinite(wbState.draft.geometry.height, 620), 200, 2160);
    var base = wbResolveBaseStyle(wbState.draft);
    var font = clamp(wbFinite(base.font_size, 22), 12, 48);
    var ITEM = Math.ceil(font * 1.35) + 2 * 8 + 2;
    var budgetCap = H * 0.5;
    var laneCap = H * 0.4;
    var scrollMin = H * 0.4;
    var laneOrder = wbLaneOrder();
    var evictOrder = wbPlatform() === 'douyin'
      ? ['danmaku', 'enter', 'like', 'social', 'fansclub', 'gift']
      : ['danmaku', 'enter', 'social', 'guard', 'gift', 'sc'];
    var fallbackCapRows = Math.max(1, Math.floor((laneCap + 8) / (ITEM + 8)));
    var baseRows = {};
    var unlimited = {};
    var positions = {};
    for (var i = 0; i < laneOrder.length; i++) {
      var lane = laneOrder[i];
      var maxRows = wbState.draft.pins[lane].max;
      unlimited[lane] = !!wbState.draft.pins[lane].enabled && maxRows === 0;
      baseRows[lane] = wbState.draft.pins[lane].enabled
        ? (maxRows > 0 ? maxRows : fallbackCapRows)
        : 0;
      positions[lane] = wbState.draft.pins[lane].position;
    }
    var demandAt = function (rows, gap) {
      var sum = 0;
      for (var k = 0; k < laneOrder.length; k++) {
        var name = laneOrder[k];
        if (rows[name] > 0) sum += rows[name] * ITEM + (rows[name] - 1) * gap;
      }
      return sum;
    };
    var rawDemand = demandAt(baseRows, 8);
    var budget = Math.min(budgetCap, rawDemand);
    var levels = [8, 6, 4];
    var chosen = null;
    for (var levelIndex = 0; levelIndex < levels.length; levelIndex++) {
      var gap = levels[levelIndex];
      var rows = {};
      for (var l = 0; l < laneOrder.length; l++) {
        var name2 = laneOrder[l];
        if (!wbState.draft.pins[name2].enabled) {
          rows[name2] = 0;
          continue;
        }
        var capRows = Math.max(0, Math.floor((laneCap + gap) / (ITEM + gap)));
        rows[name2] = Math.min(baseRows[name2], capRows);
      }
      var sum = demandAt(rows, gap);
      var evictions = 0;
      while (sum > budget) {
        var low = null;
        for (var q = 0; q < evictOrder.length; q++) {
          var candidate = evictOrder[q];
          if (rows[candidate] > 1) { low = candidate; break; }
        }
        if (!low) break;
        rows[low] -= 1;
        evictions += 1;
        sum = demandAt(rows, gap);
      }
      while (sum > budget) {
        var suppress = null;
        for (var w = 0; w < evictOrder.length; w++) {
          var candidate2 = evictOrder[w];
          if (rows[candidate2] > 0) { suppress = candidate2; break; }
        }
        if (!suppress) break;
        rows[suppress] = 0;
        evictions += 1;
        sum = demandAt(rows, gap);
      }
      var candidatePlan = { levelIndex: levelIndex, gap: gap, rows: rows, sum: sum, evictions: evictions };
      if (!chosen || candidatePlan.evictions < chosen.evictions ||
        (candidatePlan.evictions === chosen.evictions && candidatePlan.levelIndex < chosen.levelIndex) ||
        (candidatePlan.evictions === chosen.evictions && candidatePlan.levelIndex === chosen.levelIndex &&
          candidatePlan.sum > chosen.sum)) {
        chosen = candidatePlan;
      }
    }
    var lanes = {};
    var used = 0;
    var top = 0;
    var bottom = 0;
    var totalRows = 0;
    for (var z = 0; z < laneOrder.length; z++) {
      var laneName = laneOrder[z];
      var laneRows = chosen.rows[laneName];
      var px = laneRows > 0 ? laneRows * ITEM + (laneRows - 1) * chosen.gap : 0;
      var pct = px / H * 100;
      lanes[laneName] = {
        rows: laneRows, px: px, pct: pct, item: ITEM, gap: chosen.gap,
        enabled: wbState.draft.pins[laneName].enabled,
        position: wbState.draft.pins[laneName].position,
        unlimited: !!unlimited[laneName],
        demand: baseRows[laneName] * ITEM + Math.max(0, baseRows[laneName] - 1) * 8
      };
      used += px;
      totalRows += laneRows;
      if (wbState.draft.pins[laneName].position === 'top') top += px;
      else bottom += px;
    }
    var scroll = H - used;
    var evicted = [];
    for (var e = 0; e < laneOrder.length; e++) {
      var evLane = laneOrder[e];
      var diff = baseRows[evLane] - chosen.rows[evLane];
      if (diff > 0) {
        evicted.push(wbLaneName(evLane) + (unlimited[evLane] ? ' 受预算限制' : ' ' + diff + ' 行'));
      }
    }
    return {
      H: H, font: font, item: ITEM, budgetCap: budgetCap, laneCap: laneCap, scrollMin: scrollMin,
      rawDemand: rawDemand, budget: budget, used: used, scroll: scroll,
      usedPct: used / H * 100, scrollPct: scroll / H * 100,
      lanes: lanes, top: top, bottom: bottom, totalRows: totalRows,
      level: chosen.levelIndex, gap: chosen.gap,
      unlimited: unlimited,
      evictedText: evicted.length ? evicted.join(' · ') : '无淘汰',
      scrollRows: Math.floor(scroll / ITEM)
    };
  }

  function wbUpdateRulesBudget() {
    if (!wbDom.budgetUsedBig) return;
    var budget = wbComputeBudget();
    wbDom.summaryFixed.textContent = Math.round(budget.used) + 'px · ' + budget.usedPct.toFixed(1) + '%';
    wbDom.summaryScroll.textContent = Math.round(budget.scroll) + 'px · ' + budget.scrollPct.toFixed(1) + '%';
    wbDom.summaryLanes.textContent = budget.totalRows + ' 行';
    wbDom.summaryNote.textContent = 'L' + budget.level + ' 间距 ' + budget.gap + 'px · ' + budget.evictedText;
    wbDom.budgetUsedBig.textContent = Math.round(budget.used) + 'px';
    wbDom.budgetFormula.textContent = 'min(' + Math.round(budget.H) + ' × 50%, 需求 ' + Math.round(budget.rawDemand) + 'px) = ' + Math.round(budget.budget) + 'px';
    wbDom.budgetUsedLine.textContent = '采用 ' + Math.round(budget.used) + 'px · ' + budget.usedPct.toFixed(1) + '%';
    wbDom.scrollUsedLine.textContent = '滚动 ' + Math.round(budget.scroll) + 'px · ' + budget.scrollPct.toFixed(1) + '%';
    wbDom.budgetCapLine.textContent = '单 lane 上限 ' + Math.round(budget.laneCap) + 'px · 40%';
    wbDom.budgetHeadMeta.textContent = 'H=' + Math.round(budget.H) + ' · font ' + budget.font + 'px · item ' + budget.item + 'px';
    var laneOrder = wbLaneOrder();
    var segments = [];
    for (var li = 0; li < laneOrder.length; li++) {
      var segLane = laneOrder[li];
      segments.push({
        lane: segLane,
        label: wbLaneName(segLane),
        px: budget.lanes[segLane].px,
        color: wbLaneColor(segLane)
      });
    }
    segments.push({ lane: 'scroll', label: '滚动', px: budget.scroll, color: '' });
    var bar = '';
    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      if (seg.px <= 0) continue;
      var style = 'flex:' + seg.px + ' 1 0;';
      if (seg.lane !== 'scroll') style += 'background:' + seg.color + ';';
      bar += '<span class="wb-budget-seg' + (seg.lane === 'scroll' ? ' is-scroll' : '') + '" style="' + style + '">' +
        (seg.px > 42 ? seg.label + ' ' + Math.round(seg.px) : '') + '</span>';
    }
    wbDom.budgetBar.innerHTML = bar;
    if (wbDom.budgetLegend) {
      var legend = '';
      for (var lg = 0; lg < laneOrder.length; lg++) {
        var lgLane = laneOrder[lg];
        legend += '<span><i style="--c:' + wbLaneColor(lgLane) + '"></i>' + wbEscape(wbLaneName(lgLane)) + '</span>';
      }
      legend += '<span><i style="--c:#566378"></i>滚动区</span>';
      wbDom.budgetLegend.innerHTML = legend;
    }
    var rowsHtml = '';
    var names = laneOrder;
    for (var r = 0; r < names.length; r++) {
      var lane = names[r];
      var item = budget.lanes[lane];
      var name = wbLaneName(lane);
      var color = wbLaneColor(lane);
      rowsHtml += '<div class="wb-lane-row"><span class="wb-lane-name"><i style="--c:' + color + '"></i><b>' + name +
        '</b></span><span class="wb-lane-track"><span style="--c:' + color + ';width:' +
        Math.min(100, item.pct / 50 * 100).toFixed(1) + '%"></span></span><span class="wb-lane-value"><b>' +
        (item.unlimited ? '不限' : item.rows + ' 行') + '</b> · ' + Math.round(item.px) + 'px · ' +
        item.pct.toFixed(1) + '%</span></div>';
    }
    wbDom.laneRows.innerHTML = rowsHtml;
    var evictNames = (wbPlatform() === 'douyin'
      ? ['danmaku', 'enter', 'like', 'social', 'fansclub', 'gift']
      : ['danmaku', 'enter', 'social', 'guard', 'gift', 'sc']).map(wbLaneName).join(' → ');
    wbDom.capacityNote.innerHTML = '压缩顺序：间距 8→6→4px；仍超预算时按 ' + evictNames +
      ' 淘汰。0 表示不设每类上限，但仍受固定区 50% 预算约束。固定项不复制进滚动流。当前 <b>L' +
      budget.level + ' / ' + budget.gap + 'px</b> · <b>' + wbEscape(budget.evictedText) + '</b> · 滚动下限 ' +
      Math.round(budget.scrollMin) + 'px · 40%。';
    wbRenderStructure(budget);
    wbScheduleStructureFit();
  }

  function wbRenderStructure(budget) {
    if (!wbDom.structureCanvas) return;
    // The structure view is an explanatory diagram, not a 1:1 geometry
    // preview. Let it fill the available pane so its labels stay readable.
    wbDom.structureCanvas.style.width = '';
    wbDom.structureCanvas.style.height = '';
    wbDom.structureTop.style.height = (budget.top / budget.H * 100).toFixed(2) + '%';
    wbDom.structureBottom.style.height = (budget.bottom / budget.H * 100).toFixed(2) + '%';
    wbDom.structureTopMeta.textContent = Math.round(budget.top) + 'px · ' + (budget.top / budget.H * 100).toFixed(1) + '%';
    wbDom.structureBottomMeta.textContent = Math.round(budget.bottom) + 'px · ' + (budget.bottom / budget.H * 100).toFixed(1) + '%';
    wbDom.structureScrollMeta.textContent = Math.round(budget.scroll) + 'px · ' + budget.scrollRows + ' 行 · ' + budget.scrollPct.toFixed(1) + '%';
    var lanes = wbLaneOrder();
    var topLanes = '';
    var bottomLanes = '';
    var topCards = '';
    var bottomCards = '';
    for (var i = 0; i < lanes.length; i++) {
      var lane = lanes[i];
      var item = budget.lanes[lane];
      if (!item || item.rows <= 0) continue;
      var name = wbLaneName(lane);
      var color = wbLaneColor(lane);
      var chip = '<span class="wb-structure-lane" style="--c:' + color + '"><i></i>' + name + ' · ' +
        (item.unlimited ? '不限' : item.rows + ' 行') + '</span>';
      var cards = '';
      for (var row = 0; row < item.rows; row++) {
        cards += '<div class="wb-structure-mini" style="--c:' + color + '"><b>' + name + ' #' + (row + 1) +
          '</b><span>' + Math.round(item.px / item.rows) + 'px / 条 · 固定</span></div>';
      }
      if (item.position === 'top') {
        topLanes += chip;
        topCards += cards;
      } else {
        bottomLanes += chip;
        bottomCards += cards;
      }
    }
    wbDom.structureTopLanes.innerHTML = topLanes || '<span class="wb-not-applicable">无顶部固定项</span>';
    wbDom.structureBottomLanes.innerHTML = bottomLanes || '<span class="wb-not-applicable">无底部固定项</span>';
    wbDom.structureTopCards.innerHTML = topCards;
    wbDom.structureBottomCards.innerHTML = bottomCards;
    wbDom.structureNote.textContent = '固定 ' + Math.round(budget.used) + 'px / ' + budget.usedPct.toFixed(1) +
      '% · 滚动 ' + Math.round(budget.scroll) + 'px / ' + budget.scrollPct.toFixed(1) + '% · ' + budget.totalRows +
      ' 行。修改同屏条数、启用或停靠位置会立即重算。';
  }

  function wbFitStructure() {
    if (!wbState.open || wbState.tab !== 'rules' || !wbDom.structureStage) return;
    var canvas = wbDom.structureCanvas;
    if (!canvas) return;
    canvas.style.transform = 'none';
    canvas.style.left = '';
    canvas.style.top = '';
  }

  function wbRestorePinDefaults() {
    if (!wbState.loadOk) return;
    wbConfirm({
      title: '恢复当前平台固定规则默认？',
      body: '只恢复当前平台这些消息类型的启用、停靠位置、停留时长、同屏条数与礼物最低价值。样式与窗口几何不动。',
      confirmLabel: '恢复规则默认',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      wbState.draft.pins = wbClone(WB_PIN_DEFAULTS);
      wbMarkDirty();
      wbRenderRules();
      wbShowToast('已恢复当前平台固定规则默认 · 样式与窗口几何未动');
    });
  }

  ctx.modules.wbRules = {
    wbPinRowHtml: wbPinRowHtml,
    wbPinCardHtml: wbPinCardHtml,
    wbRenderRules: wbRenderRules,
    wbPinLaneFrom: wbPinLaneFrom,
    wbOnPinClick: wbOnPinClick,
    wbApplyPinNumber: wbApplyPinNumber,
    wbOnPinInput: wbOnPinInput,
    wbOnPinChange: wbOnPinChange,
    wbComputeBudget: wbComputeBudget,
    wbUpdateRulesBudget: wbUpdateRulesBudget,
    wbRenderStructure: wbRenderStructure,
    wbFitStructure: wbFitStructure,
    wbRestorePinDefaults: wbRestorePinDefaults
  };
})();
