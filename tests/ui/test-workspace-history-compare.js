'use strict';

const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');
const path = require('path');
const PROJECT_ROOT = process.env.MUTAI_PROJECT_ROOT || path.resolve(__dirname, '../..');
const fs = require('fs');

const URL = process.env.MUTAI_UI_URL || 'file:///' + path.resolve(PROJECT_ROOT, 'ui/index.html').replace(/\\/g, '/');
const OUT = process.env.MUTAI_UI_SHOTS || path.join(PROJECT_ROOT, 'qa/shots/ui');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
function check(condition, label, detail) {
  if (condition) {
    pass += 1;
    console.log('PASS  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  } else {
    fail += 1;
    console.log('FAIL  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console: ' + message.text());
  });
  page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));

  await page.addInitScript(() => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const now = Date.now() / 1000;
    const base = now - 4 * 86400;
    const current = {
      id: 'current',
      platform: 'bilibili',
      room_id: 777,
      room_key: '777',
      room_title: '夜航电台',
      started_at: base,
      ended_at: base + 3600,
      end_reason: 'manual_disconnect',
      last_event_at: base + 3550,
      real_received: 120,
      real_spoken: 100,
      real_dropped: 20,
      mock_received: 3,
      mock_spoken: 0,
      mock_dropped: 0,
      unique_users: 42,
      gift_cny: 12.3,
      gift_silver: 100,
      gift_unknown: 0,
      super_chat_cny: 50
    };
    const earlier = {
      ...current,
      id: 'earlier-near',
      room_title: '夜航电台 · 上一场',
      started_at: base - 3600,
      ended_at: base,
      last_event_at: base - 50,
      real_received: 80,
      real_spoken: 60,
      real_dropped: 20,
      mock_received: 0,
      unique_users: 30,
      gift_cny: 8,
      gift_silver: 40,
      super_chat_cny: 20
    };
    const later = {
      ...current,
      id: 'later-near',
      room_title: '夜航电台 · 后一场',
      started_at: base + 3600,
      ended_at: base + 7200,
      last_event_at: base + 7150,
      real_received: 150,
      real_spoken: 110,
      real_dropped: 40,
      unique_users: 55,
      gift_cny: 18.5,
      super_chat_cny: 100
    };
    const far = {
      ...current,
      id: 'far-earlier',
      room_title: '夜航电台 · 很早一场',
      started_at: base - 2 * 86400,
      ended_at: base - 2 * 86400 + 3600,
      real_received: 60,
      real_spoken: 50,
      real_dropped: 10,
      unique_users: 22
    };
    const otherRoom = {
      ...current,
      id: 'other-room',
      room_id: 888,
      room_key: '888',
      room_title: '别的房间',
      started_at: base - 7200
    };
    const otherPlatform = {
      ...current,
      id: 'other-platform',
      platform: 'douyin',
      room_key: '777',
      room_title: '抖音同号',
      started_at: base - 7200
    };
    const baselinePool = [current, later, earlier, far, otherRoom, otherPlatform];
    const listSessions = [current, earlier, later, far];
    const detail = (session) => ({
      ...clone(session),
      types: {
        danmaku: Math.max(0, session.real_received - 20),
        gift: 10,
        super_chat: 2,
        guard: 3,
        enter: 5
      },
      minutes: [
        { minute: Math.floor(session.started_at / 60), count: 20 },
        { minute: Math.floor(session.started_at / 60) + 2, count: 30 }
      ]
    });
    const state = {
      connection: 'connected',
      room_id: 777,
      room_title: '夜航电台',
      stats: { received: 5, spoken: 3, dropped: 1 },
      session: {
        id: 'live',
        started_at: now - 600,
        stats: { received: 5, spoken: 3, dropped: 1 },
        real: { received: 5, spoken: 3, dropped: 1 },
        mock: { received: 0, spoken: 0, dropped: 0 }
      },
      mock: { running: false, sent: 0 },
      queue_len: 0,
      now_playing: null,
      account: { logged_in: false, uname: null, mid: null },
      history: {
        available: true,
        error: null,
        capabilities: { arbitrary_compare: 1, previous_compare: 1, trend: 1 }
      },
      last_error: null,
      config: {
        overlay: {
          enabled: false, x: 60, y: 120, width: 520, height: 620, scale: 1,
          click_through: true, always_on_top: true,
          types: { danmaku: true, gift: true, super_chat: true, guard: true, enter: true }
        }
      }
    };
    const appearance = {
      schema_version: 1,
      preset: 'broadcast',
      custom: false,
      theme_mode: 'dark',
      accent: '#FF5F3A',
      pattern: { type: 'none', spacing_px: 24, dot_size_px: 1.5 },
      radius: { enabled: false, value_px: 12 },
      font: 'broadcast'
    };
    let emptyBaselines = false;
    let baselineError = false;
    let compareFailure = false;
    let targetDeleted = false;
    let baselineTargetGone = false;
    let compareDelay = 0;
    let previousDelay = 0;
    let previousMode = 'found';
    const calls = { baselines: [], compares: [] };
    const delayed = (value, ms) => ms > 0
      ? new Promise((resolve) => setTimeout(() => resolve(value), ms))
      : value;

    const api = {
      get_state: () => clone(state),
      poll_events: () => ({ cursor: 0, events: [] }),
      list_voices: () => [],
      get_appearance: () => ({ ok: true, appearance: clone(appearance), read_only: false, migration: {} }),
      set_appearance: (value) => ({ ok: true, appearance: clone(value), rejected: [] }),
      get_overlay_config: () => ({ enabled: false, width: 520, height: 620 }),
      get_config_v2: () => ({ monitor: { font_px: null }, overlay: {} }),
      monitor_visible: () => ({ visible: false }),
      toggle_monitor: () => ({ ok: true, visible: true }),
      set_overlay_visible: () => ({ ok: true, visible: false }),
      mock_status: () => ({ running: false, sent: 0 }),
      history_status: () => ({
        ok: true,
        available: true,
        gap_events: 0,
        capabilities: { arbitrary_compare: 1, previous_compare: 1, trend: 1 }
      }),
      history_list_sessions: () => ({
        ok: true,
        sessions: clone(listSessions),
        total: listSessions.length,
        all_total: listSessions.length,
        platforms: [{ platform: 'bilibili', count: listSessions.length }],
        has_more: false,
        next_cursor: null,
        gap_events: 0,
        stale: false
      }),
      history_get_session: (id) => {
        const session = baselinePool.find((item) => item.id === id);
        return session
          ? { ok: true, session: detail(session) }
          : { ok: false, error: '场次不存在', session: null };
      },
      history_get_previous_session: () => delayed(
        previousMode === 'empty'
          ? {
              ok: true,
              status: 'no_previous',
              target: detail(current),
              previous: null,
              session: null,
              has_previous: false
            }
          : {
              ok: true,
              status: 'found',
              target: detail(current),
              previous: detail(earlier),
              session: detail(earlier),
              has_previous: true
            },
        previousDelay
      ),
      history_list_baselines: (
        targetId,
        limit,
        beforeDistance,
        beforeStartedAt,
        beforeId,
        beforeTargetId
      ) => {
        const cursor = beforeDistance == null ? null : {
          distance_seconds: beforeDistance,
          started_at: beforeStartedAt,
          id: beforeId,
          target_id: beforeTargetId
        };
        calls.baselines.push({ targetId, limit, cursor: clone(cursor) });
        if (baselineTargetGone || targetId !== 'current') {
          return {
            ok: false,
            available: true,
            error_code: 'target_not_found',
            error: '当前场次不存在',
            candidates: []
          };
        }
        if (baselineError) {
          return {
            ok: false,
            available: true,
            error_code: 'internal',
            error: '模拟候选故障',
            candidates: []
          };
        }
        if (emptyBaselines) {
          return {
            ok: true,
            available: true,
            target: clone(current),
            scope: { platform: 'bilibili', room_key: '777' },
            candidates: [],
            total: 0,
            scope_total: 0,
            has_more: false,
            next_cursor: null,
            stale: false
          };
        }
        if (cursor && cursor.id === 'earlier-near') {
          return {
            ok: true,
            available: true,
            target: clone(current),
            scope: { platform: 'bilibili', room_key: '777' },
            candidates: [clone(far)],
            total: 3,
            scope_total: 3,
            has_more: false,
            next_cursor: null,
            stale: false
          };
        }
        return {
          ok: true,
          available: true,
          target: clone(current),
          scope: { platform: 'bilibili', room_key: '777' },
          candidates: [clone(current), clone(otherRoom), clone(later), clone(earlier)],
          total: 3,
          scope_total: 3,
          has_more: true,
          next_cursor: {
            target_id: 'current',
            distance_seconds: 3600,
            started_at: earlier.started_at,
            id: 'earlier-near'
          },
          stale: false
        };
      },
      history_compare_sessions: (targetId, baselineId) => {
        calls.compares.push({ targetId, baselineId });
        if (targetDeleted) {
          return delayed({
            ok: false,
            available: true,
            error_code: 'target_not_found',
            error: '当前场次不存在',
            target: null,
            baseline: null
          }, compareDelay);
        }
        if (compareFailure) {
          return delayed({
            ok: false,
            available: true,
            error_code: 'baseline_not_found',
            error: '基准场不存在',
            target: null,
            baseline: null
          }, compareDelay);
        }
        const baseline = baselinePool.find((item) => item.id === baselineId);
        if (!baseline) {
          return delayed({
            ok: false,
            available: true,
            error_code: 'baseline_not_found',
            error: '基准场不存在',
            target: detail(current),
            baseline: null
          }, compareDelay);
        }
        return delayed({
          ok: true,
          available: true,
          scope: { platform: 'bilibili', room_key: '777' },
          target: detail(current),
          baseline: detail(baseline),
          stale: false
        }, compareDelay);
      },
      preview: () => ({ ok: true })
    };
    window.__fakeCompare = {
      calls,
      setEmpty(value) { emptyBaselines = !!value; },
      setError(value) { baselineError = !!value; },
      setCompareFailure(value) { compareFailure = !!value; },
      setTargetDeleted(value) { targetDeleted = !!value; },
      setBaselineTargetGone(value) { baselineTargetGone = !!value; },
      setCompareDelay(value) { compareDelay = Number(value) || 0; },
      setPreviousDelay(value) { previousDelay = Number(value) || 0; },
      setPreviousMode(value) { previousMode = String(value || 'found'); },
      setLongRoomKey() { current.room_key = 'x'.repeat(256); }
    };
    window.pywebview = { api };
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  const overlapCases = await page.evaluate(() => {
    const base = {
      id: 'base', started_at: 0, ended_at: 100,
      real_received: 30, real_spoken: 20, real_dropped: 10,
      types: { danmaku: 30 }, minutes: [{ minute: 0, count: 30 }]
    };
    const make = (id, start, end) => ({
      ...base, id, started_at: start, ended_at: end
    });
    const hasOverlap = (left, right) => window.__MUTAI_SHELL__
      .historyComparisonModel(left, right).flags.includes('两场时间重叠');
    return {
      boundary: hasOverlap(make('a', 0, 100), make('b', 100, 200)),
      later: hasOverlap(make('a', 0, 100), make('b', 120, 220)),
      overlap: hasOverlap(make('a', 0, 100), make('b', 50, 150)),
      contained: hasOverlap(make('a', 0, 100), make('b', 20, 40)),
      zero: hasOverlap(make('a', 0, 100), make('b', 100, 100))
    };
  });
  check(!overlapCases.boundary && !overlapCases.later && !overlapCases.zero,
    '对称重叠判断不误报边界相接和零时长', overlapCases);
  check(overlapCases.overlap && overlapCases.contained,
    '对称重叠判断覆盖交叠与包含', overlapCases);

  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(150);
  await page.click('[data-data-tab="history"]');
  await page.waitForTimeout(300);
  await page.click('#wsHistoryList .history-item');
  await page.waitForTimeout(240);

  const overview = await page.evaluate(() => ({
    hasCompare: !!document.querySelector('#wsHistoryDetail [data-history-compare]'),
    hasBaseline: !!document.querySelector('#wsHistoryDetail [data-history-baseline]'),
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent
  }));
  check(overview.hasCompare && overview.hasBaseline, '详情页同时提供上一场和选择基准场入口');

  await page.evaluate(() => window.__fakeCompare.setCompareDelay(350));
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(160);
  await page.check('.history-baseline-item input[value="later-near"]');
  await page.click('#wsHistoryBaselineApply');
  await page.click('#wsHistoryList .history-item[data-history-id="earlier-near"]');
  await page.waitForTimeout(500);
  const switchedDuringCompare = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    compareVisible: !!document.querySelector('#wsHistoryDetail [data-history-focus]') &&
      document.querySelector('#wsHistoryDetail [data-history-focus]')?.textContent === '场次对比',
    status: document.querySelector('[data-history-compare-status]')?.textContent || ''
  }));
  check(switchedDuringCompare.title === '夜航电台 · 上一场' &&
      !switchedDuringCompare.compareVisible,
    '对比未完成时切换场次，旧结果不会覆盖新详情', switchedDuringCompare);
  await page.evaluate(() => window.__fakeCompare.setCompareDelay(0));
  await page.click('#wsHistoryList .history-item[data-history-id="current"]');
  await page.waitForTimeout(220);

  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(220);
  const picker = await page.evaluate(() => ({
    hidden: document.getElementById('historyBaselineModal').hidden,
    appInert: document.querySelector('.app').hasAttribute('inert'),
    activeClose: document.activeElement === document.getElementById('wsHistoryBaselineClose'),
    current: document.getElementById('wsHistoryBaselineCurrent').textContent,
    scope: document.getElementById('wsHistoryBaselineScope').textContent,
    rows: [...document.querySelectorAll('.history-baseline-item')].map((row) => ({
      id: row.querySelector('input')?.value,
      selected: row.classList.contains('is-selected')
    })),
    count: document.getElementById('wsHistoryBaselineCount').textContent,
    moreVisible: !document.getElementById('wsHistoryBaselineMore').hidden,
    applyDisabled: document.getElementById('wsHistoryBaselineApply').disabled,
    bodyOverflow: [document.body.scrollWidth, document.body.clientWidth],
    modalOverflow: (() => {
      const card = document.querySelector('.history-baseline-card');
      return [card.scrollWidth, card.clientWidth];
    })()
  }));
  check(!picker.hidden && picker.appInert, '基准场弹层打开并隔离背景');
  check(picker.activeClose, '弹层打开后焦点落在关闭按钮');
  check(picker.current.includes('当前场') && picker.current.includes('不可作为基准'),
    '弹层明确展示当前场不可选', picker.current);
  check(picker.scope.includes('同平台') && picker.scope.includes('同房间'),
    '弹层展示只读范围');
  check(picker.rows.length === 2 &&
      !picker.rows.some((row) => row.id === 'current' || row.id === 'other-room'),
    '当前场和跨房间候选被排除', picker.rows);
  check(picker.moreVisible, '第一页候选可继续加载');
  check(picker.applyDisabled, '未选择时确认按钮禁用');
  check(picker.bodyOverflow[0] <= picker.bodyOverflow[1], '1280 基准弹层无页面横向溢出');
  check(picker.modalOverflow[0] <= picker.modalOverflow[1] + 1,
    '1280 基准弹层自身无横向溢出', picker.modalOverflow);
  await page.screenshot({ path: path.join(OUT, 'history-compare-picker-1280x820.png') });

  await page.keyboard.press('Tab');
  const tabFocus = await page.evaluate(() => {
    const active = document.activeElement;
    const item = active && active.closest
      ? active.closest('.history-baseline-item')
      : null;
    return {
      radio: active?.name === 'history-baseline',
      outline: item ? getComputedStyle(item).outlineStyle : ''
    };
  });
  check(tabFocus.radio, '弹层 Tab 顺序进入候选单选组');
  check(tabFocus.outline !== 'none', '候选行有可见焦点环', tabFocus);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  const pickerClosed = await page.evaluate(() => ({
    hidden: document.getElementById('historyBaselineModal').hidden,
    appInert: document.querySelector('.app').hasAttribute('inert'),
    focusBaseline: document.activeElement?.hasAttribute('data-history-baseline') || false
  }));
  check(pickerClosed.hidden && !pickerClosed.appInert, 'Escape 关闭基准弹层并恢复背景');
  check(pickerClosed.focusBaseline, '关闭弹层后焦点回到选择基准场按钮');

  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(220);
  await page.click('#wsHistoryBaselineMore');
  await page.waitForTimeout(160);
  const paginated = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.history-baseline-item input')].map((input) => input.value),
    count: document.getElementById('wsHistoryBaselineCount').textContent,
    moreHidden: document.getElementById('wsHistoryBaselineMore').hidden,
    activeId: document.activeElement?.value || '',
    calls: window.__fakeCompare.calls.baselines.slice()
  }));
  check(paginated.rows.join(',') === 'later-near,earlier-near,far-earlier',
    '加载更多去重并追加候选', paginated.rows);
  check(paginated.count.includes('共 3 场') && paginated.count.includes('已加载 3 场'),
    '候选计数随加载更新', paginated.count);
  check(paginated.moreHidden, '候选加载完后隐藏加载更多');
  check(paginated.activeId === 'far-earlier', '加载更多后焦点移到新增末项',
    paginated.activeId);
  check(paginated.calls.length >= 2 &&
      paginated.calls[paginated.calls.length - 1].cursor?.id === 'earlier-near',
    '加载更多携带 keyset cursor', paginated.calls);

  await page.check('.history-baseline-item input[value="later-near"]');
  await page.waitForTimeout(80);
  const selected = await page.evaluate(() => ({
    selected: document.querySelector('.history-baseline-item.is-selected input')?.value,
    applyDisabled: document.getElementById('wsHistoryBaselineApply').disabled
  }));
  check(selected.selected === 'later-near' && !selected.applyDisabled,
    '选择候选后确认按钮可用', selected);

  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(250);
  const manualCompare = await page.evaluate(() => ({
    modalHidden: document.getElementById('historyBaselineModal').hidden,
    title: document.querySelector('#wsHistoryDetail [data-history-focus]')?.textContent,
    contexts: [...document.querySelectorAll('.history-compare-session')].map((node) => ({
      side: node.getAttribute('data-side'),
      label: node.querySelector('span')?.textContent,
      title: node.querySelector('b')?.textContent
    })),
    headers: [...document.querySelectorAll('.history-compare-section:first-child thead th')]
      .map((node) => node.textContent),
    flags: [...document.querySelectorAll('.history-compare-flags span')]
      .map((node) => node.textContent),
    focusTitle: document.activeElement?.hasAttribute('data-history-focus') || false,
    hasChangeBaseline: !!document.querySelector('#wsHistoryDetail [data-history-baseline]'),
    hasPreviousSwitch: !!document.querySelector('#wsHistoryDetail [data-history-compare]'),
    calls: window.__fakeCompare.calls.compares.slice()
  }));
  check(manualCompare.modalHidden, '应用基准后关闭弹层');
  check(manualCompare.title === '场次对比', '手动基准进入统一对比视图', manualCompare.title);
  check(manualCompare.contexts.some((item) => item.side === 'baseline' &&
      item.label.includes('手动选择') && item.title.includes('后一场')),
    '基准卡片标出来源和时间关系', manualCompare.contexts);
  check(manualCompare.headers.join('|') === '指标|当前记录|基准场|变化',
    '对比表列头统一为当前记录/基准场', manualCompare.headers);
  check(manualCompare.flags.some((flag) => flag.includes('基准场晚于当前记录')),
    '更晚基准场有明确关系提示', manualCompare.flags);
  check(!manualCompare.flags.some((flag) => flag.includes('重叠')),
    '边界相接的基准场不误报重叠', manualCompare.flags);
  check(manualCompare.focusTitle, '手动对比完成后焦点落到对比标题');
  check(manualCompare.hasChangeBaseline && manualCompare.hasPreviousSwitch,
    '手动对比页保留更换基准和改用上一场入口');
  check(manualCompare.calls.length >= 1 &&
      manualCompare.calls[manualCompare.calls.length - 1].targetId === 'current' &&
      manualCompare.calls[manualCompare.calls.length - 1].baselineId === 'later-near',
    '显式对比按 target/baseline id 请求', manualCompare.calls);
  await page.screenshot({ path: path.join(OUT, 'history-compare-manual-1280x820.png') });
  await page.setViewportSize({ width: 1707, height: 960 });
  await page.waitForTimeout(120);
  const wideManual = await page.evaluate(() => {
    const pane = document.querySelector('.history-detail-pane');
    return {
      columns: getComputedStyle(document.querySelector('.history-compare-grid')).gridTemplateColumns.split(' ').length,
      overflow: [pane.scrollWidth, pane.clientWidth]
    };
  });
  check(wideManual.columns >= 2 && wideManual.overflow[0] <= wideManual.overflow[1] + 1,
    '1707 手动对比双列且无横向溢出', wideManual);
  await page.screenshot({ path: path.join(OUT, 'history-compare-manual-1707x960.png') });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(100);
  const smallManual = await page.evaluate(() => {
    const pane = document.getElementById('wsHistoryDetailPane');
    return {
      body: [document.body.scrollWidth, document.body.clientWidth],
      pane: [pane.scrollWidth, pane.clientWidth],
      actions: document.querySelectorAll('#wsHistoryDetail .history-detail-actions button').length
    };
  });
  check(smallManual.body[0] <= smallManual.body[1] &&
      smallManual.pane[0] <= smallManual.pane[1] + 1 &&
      smallManual.actions === 2,
    '1024 手动对比保留两个基准操作且无横向溢出', smallManual);
  await page.screenshot({ path: path.join(OUT, 'history-compare-manual-1024x700.png') });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(100);

  await page.click('#wsHistoryDetail [data-history-compare-back]');
  await page.waitForTimeout(120);
  const manualBack = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    focusBaseline: document.activeElement?.hasAttribute('data-history-baseline') || false
  }));
  check(manualBack.title === '夜航电台', '对比返回当前场概览');
  check(manualBack.focusBaseline, '手动路径返回后焦点回到选择基准场入口');

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.waitForTimeout(100);
  const returnScrollBefore = await page.evaluate(() => {
    const pane = document.getElementById('wsHistoryDetailPane');
    pane.scrollTop = 240;
    return pane.scrollTop;
  });
  await page.evaluate(() => {
    document.querySelector('#wsHistoryDetail [data-history-compare]').click();
  });
  await page.waitForTimeout(180);
  await page.click('#wsHistoryDetail [data-history-compare-back]');
  await page.waitForTimeout(120);
  const returnScrollAfter = await page.evaluate(() =>
    document.getElementById('wsHistoryDetailPane').scrollTop
  );
  check(returnScrollBefore > 0 && returnScrollAfter >= returnScrollBefore - 2,
    '对比返回概览保留进入前滚动位置',
    { before: returnScrollBefore, after: returnScrollAfter });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(80);

  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(180);
  await page.check('.history-baseline-item input[value="earlier-near"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(220);
  await page.click('#wsHistoryDetail [data-history-compare]');
  await page.waitForTimeout(220);
  const previousCompare = await page.evaluate(() => ({
    baselineLabel: document.querySelector('.history-compare-session[data-side="baseline"] span')?.textContent,
    hasPreviousSwitch: !!document.querySelector('#wsHistoryDetail [data-history-compare]')
  }));
  check(previousCompare.baselineLabel.includes('上一场 · 自动'),
    '改用上一场后标出来源', previousCompare.baselineLabel);
  check(!previousCompare.hasPreviousSwitch, '自动上一场模式不重复显示改用按钮');

  await page.click('#wsHistoryDetail [data-history-compare-back]');
  await page.waitForTimeout(120);
  const previousBack = await page.evaluate(() => ({
    focusCompare: document.activeElement?.hasAttribute('data-history-compare') || false
  }));
  check(previousBack.focusCompare, '上一场路径返回后焦点回到对比上一场入口');

  await page.evaluate(() => window.__fakeCompare.setPreviousMode('empty'));
  await page.click('#wsHistoryDetail [data-history-compare]');
  await page.waitForTimeout(160);
  const noPrevious = await page.evaluate(() => ({
    status: document.querySelector('[data-history-compare-status]')?.textContent || '',
    focused: document.activeElement?.hasAttribute('data-history-compare-status') || false,
    buttonDisabled: document.querySelector('[data-history-compare]')?.disabled
  }));
  check(noPrevious.status.includes('没有更早') && noPrevious.focused,
    '没有上一场时焦点落到状态提示', noPrevious);
  check(noPrevious.buttonDisabled === false, '没有上一场后快捷按钮恢复可用');
  await page.evaluate(() => window.__fakeCompare.setPreviousMode('found'));

  await page.evaluate(() => window.__fakeCompare.setEmpty(true));
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(180);
  const empty = await page.evaluate(() => ({
    text: document.querySelector('.history-baseline-empty')?.textContent || '',
    status: document.getElementById('wsHistoryBaselineStatus').textContent,
    applyDisabled: document.getElementById('wsHistoryBaselineApply').disabled
  }));
  check(empty.text.includes('还没有其他已结束场次') && empty.applyDisabled,
    '房间无候选时有明确空态并禁用确认', empty);
  await page.click('#wsHistoryBaselineClose');
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    window.__fakeCompare.setEmpty(false);
    window.__fakeCompare.setError(true);
  });
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(180);
  const failed = await page.evaluate(() => ({
    role: document.getElementById('wsHistoryBaselineStatus').getAttribute('role'),
    text: document.getElementById('wsHistoryBaselineStatus').textContent,
    retry: !!document.querySelector('[data-history-baseline-retry]'),
    listText: document.querySelector('.history-baseline-empty')?.textContent || ''
  }));
  check(failed.role === 'alert' && failed.text.includes('无法读取同房间历史'),
    '候选失败态使用 alert', failed);
  check(failed.retry, '候选失败提供重试入口');
  check(failed.listText.includes('无法读取'), '失败时不伪装成无历史', failed.listText);
  await page.evaluate(() => window.__fakeCompare.setError(false));
  await page.click('[data-history-baseline-retry]');
  await page.waitForTimeout(220);
  const recovered = await page.evaluate(() => ({
    rows: document.querySelectorAll('.history-baseline-item').length,
    status: document.getElementById('wsHistoryBaselineStatus').textContent,
    focusedStatus: document.activeElement?.id === 'wsHistoryBaselineStatus'
  }));
  check(recovered.rows > 0 && !recovered.status.includes('无法读取'),
    '候选失败可重试恢复', recovered);
  check(recovered.focusedStatus, '重试后焦点留在状态区而不是掉到 body');

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(120);
  const smallPicker = await page.evaluate(() => {
    const card = document.querySelector('.history-baseline-card');
    const list = document.getElementById('wsHistoryBaselineList');
    return {
      body: [document.body.scrollWidth, document.body.clientWidth],
      card: [card.scrollWidth, card.clientWidth],
      list: [list.scrollWidth, list.clientWidth],
      modalHeight: card.getBoundingClientRect().height,
      viewport: window.innerHeight
    };
  });
  check(smallPicker.body[0] <= smallPicker.body[1], '1024 基准弹层无页面横向溢出',
    smallPicker.body);
  check(smallPicker.card[0] <= smallPicker.card[1] + 1, '1024 弹层自身不横向溢出',
    smallPicker.card);
  check(smallPicker.list[0] <= smallPicker.list[1] + 1, '1024 候选列表不横向滚动',
    smallPicker.list);
  check(smallPicker.modalHeight <= smallPicker.viewport, '1024 弹层高度不超出视口',
    smallPicker);
  await page.screenshot({ path: path.join(OUT, 'history-compare-picker-1024x700.png') });

  await page.setViewportSize({ width: 760, height: 700 });
  await page.waitForTimeout(120);
  const sheetPicker = await page.evaluate(() => {
    const card = document.querySelector('.history-baseline-card');
    const rect = card.getBoundingClientRect();
    return {
      body: [document.body.scrollWidth, document.body.clientWidth],
      card: [rect.width, rect.height],
      viewport: [window.innerWidth, window.innerHeight]
    };
  });
  check(sheetPicker.body[0] <= sheetPicker.body[1], '760 弹层无页面横向溢出',
    sheetPicker.body);
  check(sheetPicker.card[0] <= sheetPicker.viewport[0] + 1 &&
      sheetPicker.card[1] <= sheetPicker.viewport[1] + 1,
    '760 以下弹层使用全屏 sheet', sheetPicker);
  await page.screenshot({ path: path.join(OUT, 'history-compare-picker-760x700.png') });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(100);
  await page.click('#wsHistoryBaselineClose');
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__fakeCompare.setCompareFailure(true));
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(160);
  await page.check('.history-baseline-item input[value="later-near"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(180);
  const compareFailure = await page.evaluate(() => ({
    status: document.querySelector('[data-history-compare-status]')?.textContent || '',
    role: document.querySelector('[data-history-compare-status]')?.getAttribute('role'),
    focusStatus: document.activeElement?.hasAttribute('data-history-compare-status') || false,
    detailTitle: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent || ''
  }));
  check(compareFailure.status.includes('基准场已被删除') ||
      compareFailure.status.includes('不可用'),
    '基准场删除竞态有清晰错误', compareFailure.status);
  check(compareFailure.role === 'alert' && compareFailure.focusStatus,
    '对比失败状态可聚焦并播报', compareFailure);
  check(compareFailure.detailTitle === '夜航电台', '对比失败保留当前场概览',
    compareFailure.detailTitle);

  await page.evaluate(() => {
    window.__fakeCompare.setCompareFailure(false);
    window.__fakeCompare.setTargetDeleted(true);
  });
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(160);
  await page.check('.history-baseline-item input[value="later-near"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(220);
  const targetDeleted = await page.evaluate(() => ({
    detailHidden: document.getElementById('wsHistoryDetail').hidden,
    noSelectionVisible: !document.getElementById('wsHistoryNoSelection').hidden,
    listCount: document.querySelectorAll('#wsHistoryList .history-item').length,
    notice: document.getElementById('wsHistorySummary').textContent
  }));
  check(targetDeleted.detailHidden && targetDeleted.noSelectionVisible,
    '目标场删除后关闭详情并返回列表', targetDeleted);
  check(targetDeleted.listCount > 0 && targetDeleted.notice.includes('不存在'),
    '目标场删除后刷新历史列表并提示', targetDeleted);

  await page.evaluate(() => {
    window.__fakeCompare.setTargetDeleted(false);
    window.__fakeCompare.setPreviousDelay(350);
  });
  await page.click('#wsHistoryList .history-item[data-history-id="current"]');
  await page.waitForTimeout(180);
  await page.click('#wsHistoryDetail [data-history-compare]');
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(160);
  await page.evaluate(() => window.__fakeCompare.setPreviousDelay(0));
  await page.check('.history-baseline-item input[value="later-near"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(500);
  const preemptedPrevious = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail [data-history-focus]')?.textContent,
    source: document.querySelector('.history-compare-session[data-side="baseline"] span')?.textContent,
    hasPreviousSwitch: !!document.querySelector('#wsHistoryDetail [data-history-compare]')
  }));
  check(preemptedPrevious.title === '场次对比' &&
      preemptedPrevious.source.includes('手动选择') &&
      preemptedPrevious.hasPreviousSwitch,
    '显式基准选择可抢占仍在加载的上一场请求', preemptedPrevious);

  await page.click('#wsHistoryDetail [data-history-compare-back]');
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__fakeCompare.setLongRoomKey());
  await page.click('#wsHistoryList .history-item[data-history-id="current"]');
  await page.waitForTimeout(180);
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(140);
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(100);
  const longKey = await page.evaluate(() => {
    const scope = document.getElementById('wsHistoryBaselineScope');
    const card = document.querySelector('.history-baseline-card');
    return {
      scope: [scope.scrollWidth, scope.clientWidth],
      card: [card.scrollWidth, card.clientWidth],
      body: [document.body.scrollWidth, document.body.clientWidth]
    };
  });
  check(longKey.scope[0] <= longKey.scope[1] + 1 &&
      longKey.card[0] <= longKey.card[1] + 1 &&
      longKey.body[0] <= longKey.body[1],
    '256 字符 room_key 不撑破 1024 弹层', longKey);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.click('#wsHistoryBaselineClose');
  await page.waitForTimeout(80);

  await page.evaluate(() => window.__fakeCompare.setBaselineTargetGone(true));
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(180);
  const pickerTargetGone = await page.evaluate(() => ({
    modalHidden: document.getElementById('historyBaselineModal').hidden,
    detailHidden: document.getElementById('wsHistoryDetail').hidden,
    noSelectionVisible: !document.getElementById('wsHistoryNoSelection').hidden,
    notice: document.getElementById('wsHistorySummary').textContent
  }));
  check(pickerTargetGone.modalHidden && pickerTargetGone.detailHidden &&
      pickerTargetGone.noSelectionVisible,
    '候选请求发现目标场删除时关闭弹层和详情', pickerTargetGone);
  check(pickerTargetGone.notice.includes('不存在'),
    '候选目标删除后刷新列表并提示', pickerTargetGone.notice);

  check(errors.length === 0, '无页面脚本错误', errors);
  console.log('\nSUMMARY  PASS=' + pass + '  FAIL=' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
