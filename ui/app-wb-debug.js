/* ============================================================
   幕台 · 工作台调试域（模拟数据）
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
  var wbMarkDirty = wb.helpers.wbMarkDirty;
  var wbSetError = wb.helpers.wbSetError;
  var wbSetSwitch = wb.helpers.wbSetSwitch;
  var wbShowToast = wb.helpers.wbShowToast;
  var overlayApi = ctx.helpers.overlayApi;
  var overlayErrorText = ctx.helpers.overlayErrorText;
  var WB_TYPES = wb.constants.WB_TYPES;
  var wbTypesForPlatform = wb.helpers.wbTypesForPlatform;

  function wbMockTypeLabels() {
    return {
      danmaku: '弹幕', gift: '礼物', super_chat: '醒目留言', guard: '上舰',
      enter: '入场', like: '点赞', social: '关注'
    };
  }
  function wbMockActiveTypeNames() {
    var labels = wbMockTypeLabels();
    var names = [];
    var types = wbTypesForPlatform();
    for (var i = 0; i < types.length; i++) {
      if (wbState.mock.auto.types[types[i]]) names.push(labels[types[i]]);
    }
    return names;
  }
  function wbRenderMockTypeChips() {
    var labels = wbMockTypeLabels();
    var types = wbTypesForPlatform();
    var html = '';
    for (var t = 0; t < types.length; t++) {
      var type = types[t];
      var on = !!wbState.mock.auto.types[type];
      html += '<button class="wb-type-chip' + (on ? ' is-active' : '') + '" type="button" data-wb-mock-type="' +
        type + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + wbEscape(labels[type] || type) + '</button>';
    }
    if (wbDom.mockTypes) wbDom.mockTypes.innerHTML = html;
    var chips = wbDom.mockTypes.querySelectorAll('[data-wb-mock-type]');
    for (var i = 0; i < chips.length; i++) {
      var type = chips[i].getAttribute('data-wb-mock-type');
      var on = !!wbState.mock.auto.types[type];
      chips[i].classList.toggle('is-active', on);
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var names = wbMockActiveTypeNames();
    wbDom.mockTypesHint.textContent = names.length ? '当前：' + names.join(' / ') : '至少选择一种类型';
    wbDom.mockTypesHint.style.color = names.length ? '' : 'var(--wb-danger)';
  }
  function wbUpdateMockAutoUi() {
    var auto = wbState.mock.auto;
    wbDom.mockAutoState.textContent = auto.running ? '运行中' : '已停止';
    wbDom.mockAutoState.classList.toggle('is-running', auto.running);
    wbSetSwitch(wbDom.mockAutoEnabled, auto.running);
    wbDom.mockAutoSpeakFlag.hidden = !auto.speak;
    var status = wbDom.mockAutoStatus.parentElement;
    if (status) status.classList.toggle('is-running', auto.running);
    wbDom.mockAutoStatus.textContent = auto.running ? '运行中 · 已发送 ' + auto.sent + ' 条' : '已停止';
    var names = wbMockActiveTypeNames();
    wbDom.mockAutoStatusDetail.textContent = '每 ' + (auto.interval / 1000).toFixed(auto.interval % 1000 === 0 ? 0 : 1) +
      ' 秒 · 每次 ' + auto.perTick + ' 条 · ' + (names.length ? names.join(' / ') : '未选择类型') +
      (auto.speak ? ' · 真实朗读' : ' · ⚠ 仅上屏，不会朗读');
    wbDom.mockAutoNote.textContent = auto.running ? '按设定频率持续注入；关闭工作台后仍会继续运行' : '按设定频率持续注入模拟消息';
    wbDom.mockIntervalValue.textContent = '每 ' + (auto.interval / 1000).toFixed(auto.interval % 1000 === 0 ? 0 : 1) + ' 秒';
    wbRenderMockTypeChips();
  }
  function wbRenderMockControls() {
    var mock = wbState.mock;
    var labels = wbMockTypeLabels();
    var types = wbTypesForPlatform();
    if (types.indexOf(mock.kind) < 0) mock.kind = types[0];
    if (wbDom.mockKind) {
      var options = '';
      for (var i = 0; i < types.length; i++) {
        options += '<option value="' + types[i] + '">' + wbEscape(labels[types[i]] || types[i]) + '</option>';
      }
      wbDom.mockKind.innerHTML = options;
    }
    if (document.activeElement !== wbDom.mockKind) wbDom.mockKind.value = mock.kind;
    if (document.activeElement !== wbDom.mockUser) wbDom.mockUser.value = mock.user;
    if (document.activeElement !== wbDom.mockText) wbDom.mockText.value = mock.text;
    wbSetSwitch(wbDom.mockSpeak, mock.speak);
    wbDom.mockSpeakFlag.hidden = !mock.speak;
    wbSetSwitch(wbDom.mockAutoSpeak, mock.auto.speak);
    if (document.activeElement !== wbDom.mockInterval) wbDom.mockInterval.value = String(mock.auto.interval);
    if (document.activeElement !== wbDom.mockPerTick) wbDom.mockPerTick.value = String(mock.auto.perTick);
    wbSetSwitch(wbDom.mockAutoEnabled, mock.auto.running);
    wbUpdateMockAutoUi();
  }
  function wbSetMockFeedback(text, tone) {
    if (!wbDom.mockFeedback) return;
    wbDom.mockFeedback.textContent = String(text || '');
    wbDom.mockFeedback.classList.toggle('is-success', tone === 'success');
    wbDom.mockFeedback.classList.toggle('is-error', tone === 'error');
  }
  function wbSetMockBusy(busy) {
    wbState.mock.busy = !!busy;
    var buttons = [wbDom.mockSend, wbDom.mockBurst10, wbDom.mockStorm30];
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i]) buttons[i].disabled = wbState.mock.busy;
    }
  }
  function wbInjectMock(count, storm) {
    if (wbState.mock.busy) return;
    if (wbState.mock.speak && count > 1) {
      wbConfirm({
        title: '确认真实朗读？',
        body: '将注入 ' + count + ' 条模拟消息，并进入真实 TTS 管线；受冷却、去重与队列上限影响，实际朗读条数可能更少。',
        confirmLabel: '确认发送'
      }).then(function (ok) {
        if (ok) wbDoInjectMock(count, storm);
      });
      return;
    }
    wbDoInjectMock(count, storm);
  }
  function wbDoInjectMock(count, storm) {
    var kind = storm ? 'mixed' : wbState.mock.kind;
    var speak = !!wbState.mock.speak;
    wbSetMockBusy(true);
    wbSetMockFeedback(storm ? '正在注入 30 条混合消息…' : count > 1 ? '正在连发 ' + count + ' 条…' : '正在注入…', '');
    var request;
    if (count <= 1 && kind !== 'mixed') {
      request = overlayApi('inject_mock', [{
        kind: kind,
        user: wbState.mock.user,
        text: wbState.mock.text,
        speak: speak
      }]);
    } else {
      request = overlayApi('inject_mock_burst', [{
        count: count,
        kind: kind,
        speak: speak
      }]);
    }
    request.then(function (res) {
      if (res && typeof res === 'object' && res.ok === false) throw new Error(res.error || '未知原因');
      if (count > 1 || kind === 'mixed') {
        var injected = res && typeof res.count === 'number' ? res.count : count;
        var spoken = res && typeof res.spoken_count === 'number' ? res.spoken_count : 0;
        var filtered = res && res.filtered && typeof res.filtered === 'object' ? res.filtered : {};
        var filterNames = Object.keys(filtered).map(function (key) { return key + ' ' + filtered[key]; }).join('、');
        wbSetMockFeedback('已注入 ' + injected + ' 条 · 朗读 ' + spoken + ' 条' + (filterNames ? ' · 过滤：' + filterNames : ''), 'success');
      } else {
        wbSetMockFeedback('已注入 ' + (res.kind || kind) + ' · ' + (res.user || '自动填充') + (res.spoken ? ' · 已进入朗读' : ' · 仅上屏'), 'success');
      }
    }).catch(function (err) {
      wbSetMockFeedback('注入失败：' + overlayErrorText(err), 'error');
    }).then(function () {
      wbSetMockBusy(false);
    });
  }
  function wbMockPayload(enabled) {
    var auto = wbState.mock.auto;
    return {
      enabled: !!enabled,
      interval_ms: auto.interval,
      per_tick: auto.perTick,
      speak: !!auto.speak,
      types: wbClone(auto.types)
    };
  }
  function wbApplyMockAuto(enabled, immediate) {
    var auto = wbState.mock.auto;
    if (enabled && wbMockActiveTypeNames().length === 0) {
      wbSetMockFeedback('至少选择一种自动发送类型', 'error');
      auto.running = false;
      wbUpdateMockAutoUi();
      return;
    }
    if (wbState.mock.applyTimer) {
      clearTimeout(wbState.mock.applyTimer);
      wbState.mock.applyTimer = 0;
    }
    var seq = ++wbState.mock.seq;
    var previous = !!auto.running;
    auto.running = !!enabled;
    wbState.mock.dirtyUntil = Date.now() + 1600;
    wbUpdateMockAutoUi();
    overlayApi('mock_auto', [wbMockPayload(enabled)]).then(function (res) {
      if (seq !== wbState.mock.seq) return;
      if (res && typeof res === 'object' && res.ok === false) throw new Error(res.error || '未知原因');
      if (res && typeof res === 'object') {
        if (typeof res.running === 'boolean') auto.running = res.running;
        if (typeof res.sent === 'number') auto.sent = res.sent;
        if (typeof res.interval_ms === 'number') auto.interval = clamp(Math.round(res.interval_ms), 200, 10000);
        if (typeof res.per_tick === 'number') auto.perTick = clamp(Math.round(res.per_tick), 1, 10);
        if (typeof res.speak === 'boolean') auto.speak = res.speak;
        if (res.types && typeof res.types === 'object') {
          for (var i = 0; i < WB_TYPES.length; i++) {
            if (typeof res.types[WB_TYPES[i]] === 'boolean') auto.types[WB_TYPES[i]] = res.types[WB_TYPES[i]];
          }
        }
      }
      if (document.activeElement !== wbDom.mockInterval) wbDom.mockInterval.value = String(auto.interval);
      if (document.activeElement !== wbDom.mockPerTick) wbDom.mockPerTick.value = String(auto.perTick);
      wbSetSwitch(wbDom.mockAutoSpeak, auto.speak);
      wbUpdateMockAutoUi();
    }).catch(function (err) {
      if (seq !== wbState.mock.seq) return;
      auto.running = previous;
      wbSetMockFeedback('自动发送设置失败：' + overlayErrorText(err), 'error');
      wbUpdateMockAutoUi();
    });
  }
  function wbScheduleMockAutoApply() {
    if (wbState.mock.applyTimer) clearTimeout(wbState.mock.applyTimer);
    wbState.mock.applyTimer = setTimeout(function () {
      wbState.mock.applyTimer = 0;
      wbApplyMockAuto(wbState.mock.auto.running, false);
    }, 260);
  }
  function wbStopMockApply() {
    if (wbState.mock.applyTimer) {
      clearTimeout(wbState.mock.applyTimer);
      wbState.mock.applyTimer = 0;
    }
  }
  function wbToggleMockAuto() {
    var next = !wbState.mock.auto.running;
    if (next && wbMockActiveTypeNames().length === 0) {
      wbSetMockFeedback('至少选择一种自动发送类型', 'error');
      return;
    }
    wbApplyMockAuto(next, true);
  }
  function wbFetchMockStatus() {
    if (!wbState.open || wbState.tab !== 'debug' || wbState.debugTab !== 'mock') return;
    overlayApi('mock_status', []).then(function (res) {
      if (!res || typeof res !== 'object') return;
      var auto = wbState.mock.auto;
      if (typeof res.running === 'boolean') auto.running = res.running;
      if (typeof res.sent === 'number') auto.sent = res.sent;
      if (Date.now() >= wbState.mock.dirtyUntil) {
        if (typeof res.interval_ms === 'number') auto.interval = clamp(Math.round(res.interval_ms), 200, 10000);
        if (typeof res.per_tick === 'number') auto.perTick = clamp(Math.round(res.per_tick), 1, 10);
        if (typeof res.speak === 'boolean') auto.speak = res.speak;
        if (res.types && typeof res.types === 'object') {
          for (var i = 0; i < WB_TYPES.length; i++) {
            if (typeof res.types[WB_TYPES[i]] === 'boolean') auto.types[WB_TYPES[i]] = res.types[WB_TYPES[i]];
          }
        }
        if (document.activeElement !== wbDom.mockInterval) wbDom.mockInterval.value = String(auto.interval);
        if (document.activeElement !== wbDom.mockPerTick) wbDom.mockPerTick.value = String(auto.perTick);
        wbSetSwitch(wbDom.mockAutoSpeak, auto.speak);
      }
      wbUpdateMockAutoUi();
    }).catch(function () {});
  }
  function wbStartMockPoll() {
    if (wbState.mock.pollTimer) return;
    wbFetchMockStatus();
    wbState.mock.pollTimer = setInterval(wbFetchMockStatus, 1000);
  }
  function wbStopMockPoll() {
    if (wbState.mock.pollTimer) {
      clearInterval(wbState.mock.pollTimer);
      wbState.mock.pollTimer = 0;
    }
  }

  function wbSetDebugTab(name, options) {
    wbState.debugTab = 'mock';
    wbRenderMockControls();
    if (wbState.open && wbState.tab === 'debug') wbStartMockPoll();
  }

  ctx.modules.wbDebug = {
    wbSetDebugTab: wbSetDebugTab,
    wbMockTypeLabels: wbMockTypeLabels,
    wbMockActiveTypeNames: wbMockActiveTypeNames,
    wbRenderMockTypeChips: wbRenderMockTypeChips,
    wbUpdateMockAutoUi: wbUpdateMockAutoUi,
    wbRenderMockControls: wbRenderMockControls,
    wbSetMockFeedback: wbSetMockFeedback,
    wbSetMockBusy: wbSetMockBusy,
    wbInjectMock: wbInjectMock,
    wbDoInjectMock: wbDoInjectMock,
    wbMockPayload: wbMockPayload,
    wbApplyMockAuto: wbApplyMockAuto,
    wbScheduleMockAutoApply: wbScheduleMockAutoApply,
    wbStopMockApply: wbStopMockApply,
    wbToggleMockAuto: wbToggleMockAuto,
    wbFetchMockStatus: wbFetchMockStatus,
    wbStartMockPoll: wbStartMockPoll,
    wbStopMockPoll: wbStopMockPoll
  };
})();
