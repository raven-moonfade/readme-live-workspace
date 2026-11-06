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
    const target = {
      id: 'target',
      platform: 'bilibili',
      room_id: 777,
      room_key: '777',
      room_title: '夜航电台',
      started_at: now - 86400,
      ended_at: now - 82800,
      end_reason: 'manual_disconnect',
      last_event_at: now - 82900,
      real_received: 120,
      real_spoken: 100,
      real_dropped: 20,
      mock_received: 2,
      mock_spoken: 0,
      mock_dropped: 0,
      unique_users: 42,
      gift_cny: 12,
      gift_silver: 0,
      gift_unknown: 0,
      super_chat_cny: 50
    };
    const candidates = [
      ['baseline-1', now - 2 * 86400, 80, 60, 20],
      ['baseline-2', now - 3 * 86400, 100, 70, 30],
      ['baseline-3', now - 4 * 86400, 60, 50, 10],
      ['baseline-4', now - 5 * 86400, 40, 30, 10]
    ].map(([id, started, received, spoken, dropped]) => ({
      id,
      platform: 'bilibili',
      room_id: 777,
      room_key: '777',
      room_title: '夜航电台 · ' + id,
      started_at: started,
      ended_at: started + 3600,
      end_reason: 'manual_disconnect',
      last_event_at: started + 3500,
      real_received: received,
      real_spoken: spoken,
      real_dropped: dropped,
      mock_received: 0,
      mock_spoken: 0,
      mock_dropped: 0,
      unique_users: 30,
      gift_cny: 8,
      gift_silver: 0,
      gift_unknown: 0,
      super_chat_cny: 20
    }));
    const pool = [target].concat(candidates);
    const detail = (session) => ({
      ...clone(session),
      types: {
        danmaku: Math.max(1, session.real_received - 20),
        gift: 10,
        super_chat: 2,
        guard: 3,
        enter: 5
      },
      minutes: [
        { minute: Math.floor(session.started_at / 60) + 35, count: 42 },
        { minute: Math.floor(session.started_at / 60) + 36, count: 20 }
      ]
    });
    const calls = [];
    const state = {
      connection: 'connected',
      room_id: 777,
      room_title: '夜航电台',
      stats: { received: 3, spoken: 2, dropped: 0 },
      session: {
        id: 'live',
        started_at: now - 300,
        stats: { received: 3, spoken: 2, dropped: 0 },
        real: { received: 3, spoken: 2, dropped: 0 },
        mock: { received: 0, spoken: 0, dropped: 0 }
      },
      mock: { running: false, sent: 0 },
      queue_len: 0,
      now_playing: null,
      account: { logged_in: false, uname: null, mid: null },
      history: {
        available: true,
        error: null,
        capabilities: {
          previous_compare: 1,
          arbitrary_compare: 1,
          multi_compare: 1,
          multi_compare_max: 3,
          trend: 1,
          insights: 0,
          analysis_export: 1,
          analysis_export_compare_multi: 1,
          export_manage: 1
        }
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
        capabilities: clone(state.history.capabilities)
      }),
      history_list_sessions: () => ({
        ok: true,
        sessions: clone([target, ...candidates]),
        total: 5,
        all_total: 5,
        platforms: [{ platform: 'bilibili', count: 5 }],
        has_more: false,
        next_cursor: null
      }),
      history_get_session: (id) => {
        const session = pool.find((item) => item.id === id);
        return session
          ? { ok: true, session: detail(session) }
          : { ok: false, error: '场次不存在', session: null };
      },
      history_get_previous_session: () => ({
        ok: true,
        status: 'no_previous',
        target: null,
        previous: null,
        has_previous: false
      }),
      history_list_baselines: () => ({
        ok: true,
        available: true,
        target: clone(target),
        scope: { platform: 'bilibili', room_key: '777' },
        candidates: clone(window.__fakeMulti.baselinePage === 'partial'
          ? [candidates[0], candidates[2]]
          : candidates),
        total: window.__fakeMulti.baselinePage === 'partial' ? 2 : candidates.length,
        has_more: false,
        next_cursor: null
      }),
      history_compare_sessions: (targetId, baselineId) => {
        if (window.__fakeMulti.deferSingle) {
          return new Promise((resolve) => {
            window.__fakeMulti.resolveSingle = () => {
              const baseline = candidates.find((item) => item.id === baselineId);
              resolve({
                ok: true,
                available: true,
                api_version: 1,
                scope: { platform: 'bilibili', room_key: '777' },
                target: detail(target),
                baseline: detail(baseline),
                stale: false,
                data_health: { flushed: true, pending_writes: 0, dropped_ops: 0, failed_ops: 0 }
              });
            };
          });
        }
        return {
          ok: false,
          available: true,
          error_code: 'internal',
          error: '测试不跑单基准',
          target: null,
          baseline: null
        };
      },
      history_compare_multi: (targetId, ids) => {
        calls.push({ targetId, ids: clone(ids) });
        const overlapPairs = [];
        if (ids.includes('baseline-1')) {
          overlapPairs.push({ left: '当前', right: 'B1' });
        }
        const b2 = ids.indexOf('baseline-2');
        const b3 = ids.indexOf('baseline-3');
        if (b2 >= 0 && b3 >= 0) {
          overlapPairs.push({
            left: 'B' + (Math.min(b2, b3) + 1),
            right: 'B' + (Math.max(b2, b3) + 1)
          });
        }
        const baselines = ids.map((id, index) => {
          const session = candidates.find((item) => item.id === id);
          return {
            index: index + 1,
            id,
            relation: session.started_at < target.started_at ? 'earlier' : 'later',
            distance_seconds: Math.abs(session.started_at - target.started_at),
            overlaps_target: id === 'baseline-1',
            overlaps_baselines: id === 'baseline-2' ? ['B3'] : [],
            session: detail(session)
          };
        });
        const payload = {
          ok: true,
          available: true,
          api_version: 1,
          scope: { platform: 'bilibili', room_key: '777' },
          target: detail(target),
          baselines,
          baseline_count: baselines.length,
          max_baselines: 3,
          ordering: 'requested',
          overlap_pairs: overlapPairs,
          stale: !!window.__fakeMulti.stale,
          data_health: window.__fakeMulti.stale
            ? { flushed: false, pending_writes: 2, dropped_ops: 0, failed_ops: 0 }
            : { flushed: true, pending_writes: 0, dropped_ops: 0, failed_ops: 0 }
        };
        if (window.__fakeMulti.deferMulti) {
          return new Promise((resolve) => {
            window.__fakeMulti.resolveMulti = () => resolve(payload);
          });
        }
        if (window.__fakeMulti.malformedMulti) {
          if (window.__fakeMulti.malformedMulti === 'fields') {
            const broken = clone(payload);
            broken.target.started_at = null;
            return broken;
          }
          return { ok: true, target: null, baselines: [] };
        }
        return payload;
      },
      history_export_compare_multi: (targetId, ids, format) => {
        window.__fakeMulti.exports.push({
          targetId,
          ids: clone(ids),
          format
        });
        if (window.__fakeMulti.exportFail) {
          return {
            ok: false,
            error_code: 'baseline_not_found',
            baseline_index: 2,
            error: 'B2 已被删除，请调整对比场后重试。'
          };
        }
        const payload = {
          ok: true,
          format,
          path: 'D:/exports/mutai-report-compare_multi.' + format,
          warnings: [{ code: 'overlap_detected', message: '存在重叠' }],
          quality_flag_count: 3
        };
        if (window.__fakeMulti.deferExport) {
          return new Promise((resolve) => {
            window.__fakeMulti.resolveExport = () => resolve(payload);
          });
        }
        return payload;
      },
      preview: () => ({ ok: true })
    };
    window.__fakeMulti = {
      calls,
      exports: [],
      stale: false,
      baselinePage: 'all',
      malformedMulti: false,
      exportFail: false,
      deferExport: false
    };
    window.pywebview = { api };
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(150);
  await page.click('[data-data-tab="history"]');
  await page.waitForTimeout(280);
  await page.click('#wsHistoryList .history-item[data-history-id="target"]');
  await page.waitForTimeout(300);

  const overview = await page.evaluate(() => ({
    multiSupport: !!document.querySelector('#wsHistoryDetail [data-history-baseline]'),
    label: document.querySelector('#wsHistoryDetail [data-history-baseline]')?.textContent
  }));
  check(overview.multiSupport && overview.label.includes('选择对比场'),
    '详情提供单/多场对比入口', overview);

  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(200);
  const mode = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('[data-baseline-mode]')].map((node) => node.textContent),
    singleActive: document.querySelector('[data-baseline-mode="single"]')
      ?.getAttribute('aria-selected'),
    radio: document.querySelectorAll('.history-baseline-item input[type=radio]').length
  }));
  check(mode.tabs.join('|') === '单场|多场' && mode.singleActive === 'true' && mode.radio === 4,
    '基准弹窗保留单场模式', mode);

  await page.click('[data-baseline-mode="multi"]');
  await page.waitForTimeout(100);
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.waitForTimeout(80);
  const one = await page.evaluate(() => ({
    disabled: document.getElementById('wsHistoryBaselineApply')?.disabled,
    text: document.getElementById('wsHistoryBaselineApply')?.textContent,
    chip: document.querySelectorAll('.history-baseline-chip').length
  }));
  check(one.disabled === true && one.text.includes('1 场') && one.chip === 1,
    '多选 1 场时禁用应用', one);

  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.check('.history-baseline-item input[value="baseline-3"]');
  await page.waitForTimeout(100);
  const three = await page.evaluate(() => ({
    disabled: document.getElementById('wsHistoryBaselineApply')?.disabled,
    text: document.getElementById('wsHistoryBaselineApply')?.textContent,
    chips: [...document.querySelectorAll('.history-baseline-chip')].map((node) => node.textContent),
    fourthDisabled: document.querySelector(
      '.history-baseline-item input[value="baseline-4"]'
    )?.disabled
  }));
  check(three.disabled === false && three.text.includes('3 场') && three.chips.length === 3 &&
      three.fourthDisabled === true,
    '多选 3 场并禁用第 4 场', three);

  await page.click('[data-remove-baseline="baseline-2"]');
  await page.waitForTimeout(80);
  const removed = await page.evaluate(() => ({
    chips: document.querySelectorAll('.history-baseline-chip').length,
    fourthDisabled: document.querySelector(
      '.history-baseline-item input[value="baseline-4"]'
    )?.disabled,
    focusChip: document.activeElement?.hasAttribute('data-remove-baseline') || false,
    b2Checked: document.querySelector(
      '.history-baseline-item input[value="baseline-2"]'
    )?.checked
  }));
  check(removed.chips === 2 && removed.fourthDisabled === false &&
      removed.focusChip === true && removed.b2Checked === false,
    '移除已选 chip 恢复可选状态', removed);

  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(320);
  const multiView = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    contextCards: document.querySelectorAll('.history-multi-context-card').length,
    current: document.querySelectorAll('.history-multi-context-card.is-current').length,
    labels: [...document.querySelectorAll('.history-multi-context-label')].map((node) => node.textContent),
    matrixRows: document.querySelectorAll('.history-multi-matrix tbody tr').length,
    typeRows: document.querySelectorAll('.history-multi-table tbody tr').length,
    warnings: document.querySelector('.history-multi-warnings')?.textContent || '',
    calls: window.__fakeMulti.calls,
    overflow: [document.body.scrollWidth, document.body.clientWidth]
  }));
  check(multiView.title === '多场对比' && multiView.contextCards === 4 &&
      multiView.current === 1 && multiView.labels.join('|') === '当前记录|B1|B2|B3',
    '多场视图显示当前与 3 个基准', multiView);
  check(multiView.matrixRows === 9 && multiView.typeRows >= 5,
    '多场矩阵与类型表完整', multiView);
  check(multiView.warnings.includes('与当前场重叠'),
    '多场视图显示重叠标记', multiView.warnings);
  check(multiView.warnings.includes('B2 与 B3 重叠'),
    '多场视图显示基准之间重叠', multiView.warnings);
  check(multiView.calls.length === 1 &&
      multiView.calls[0].ids.join(',') === 'baseline-1,baseline-3,baseline-2',
    '多场请求保持选择顺序', multiView.calls);
  await page.screenshot({ path: path.join(OUT, 'multi-compare-1280x820.png') });

  const exportUi = await page.evaluate(() => ({
    buttons: document.querySelectorAll(
      '#wsHistoryDetail [data-history-analysis-export="compare_multi"]'
    ).length,
    status: !!document.querySelector(
      '[data-analysis-export-status="compare_multi"]'
    )
  }));
  check(exportUi.buttons === 2 && exportUi.status === true,
    '多场视图头部提供 JSON/CSV 导出', exportUi);
  await page.click(
    '[data-history-analysis-export="compare_multi"][data-format="csv"]'
  );
  await page.waitForTimeout(120);
  const exportResult = await page.evaluate(() => ({
    calls: window.__fakeMulti.exports,
    text: document.querySelector(
      '[data-analysis-export-status="compare_multi"]'
    )?.textContent || '',
    role: document.querySelector(
      '[data-analysis-export-status="compare_multi"]'
    )?.getAttribute('role')
  }));
  check(exportResult.calls.length === 1 &&
      exportResult.calls[0].targetId === 'target' &&
      exportResult.calls[0].ids.join(',') === 'baseline-1,baseline-3,baseline-2' &&
      exportResult.calls[0].format === 'csv',
    '多场导出携带有序基准 ID', exportResult.calls);
  check(exportResult.text.includes('已导出 CSV') &&
      exportResult.text.includes('mutai-report-compare_multi.csv') &&
      exportResult.text.includes('3 个场次质量标记') &&
      exportResult.role === 'status',
    '多场导出展示成功状态', exportResult.text);
  await page.screenshot({ path: path.join(OUT, 'multi-export-success-1280x820.png') });

  await page.evaluate(() => { window.__fakeMulti.exportFail = true; });
  await page.click(
    '[data-history-analysis-export="compare_multi"][data-format="json"]'
  );
  await page.waitForTimeout(120);
  const exportFailure = await page.evaluate(() => ({
    text: document.querySelector(
      '[data-analysis-export-status="compare_multi"]'
    )?.textContent || '',
    role: document.querySelector(
      '[data-analysis-export-status="compare_multi"]'
    )?.getAttribute('role'),
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    disabled: [...document.querySelectorAll(
      '[data-history-analysis-export="compare_multi"]'
    )].some((button) => button.disabled)
  }));
  check(exportFailure.text.includes('B2 已被删除') &&
      exportFailure.role === 'alert' &&
      exportFailure.title === '多场对比' &&
      exportFailure.disabled === false,
    '多场导出失败可播报且不关闭视图', exportFailure);
  await page.screenshot({ path: path.join(OUT, 'multi-export-error-1280x820.png') });
  await page.evaluate(() => { window.__fakeMulti.exportFail = false; });

  check(multiView.overflow[0] <= multiView.overflow[1],
    '1280 多场视图无页面横向溢出', multiView.overflow);

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(120);
  const at1024 = await page.evaluate(() => ({
    body: [document.body.scrollWidth, document.body.clientWidth],
    pane: (() => {
      const node = document.getElementById('wsHistoryDetailPane');
      return [node.scrollWidth, node.clientWidth];
    })(),
    matrix: (() => {
      const node = document.querySelector('.history-multi-matrix-wrap');
      return [node.scrollWidth, node.clientWidth];
    })()
  }));
  check(at1024.body[0] <= at1024.body[1] && at1024.pane[0] <= at1024.pane[1] + 1,
    '1024 多场视图无页面横向溢出', at1024);
  await page.screenshot({ path: path.join(OUT, 'multi-compare-1024x700.png') });

  await page.setViewportSize({ width: 760, height: 700 });
  await page.waitForTimeout(120);
  const at760 = await page.evaluate(() => ({
    body: [document.body.scrollWidth, document.body.clientWidth],
    pane: (() => {
      const node = document.getElementById('wsHistoryDetailPane');
      return [node.scrollWidth, node.clientWidth];
    })(),
    columns: (() => {
      const node = document.querySelector('.history-multi-context');
      return getComputedStyle(node).gridTemplateColumns.split(' ').length;
    })()
  }));
  check(at760.body[0] <= at760.body[1] && at760.pane[0] <= at760.pane[1] + 1,
    '760 多场视图无页面横向溢出', at760);
  check(at760.columns === 1, '760 多场上下文卡片单列', at760);
  await page.screenshot({ path: path.join(OUT, 'multi-compare-760x700.png') });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.click('[data-history-compare-back]');
  await page.waitForTimeout(160);
  const returned = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    focus: document.activeElement?.hasAttribute('data-history-baseline') || false
  }));
  check(returned.title === '夜航电台' && returned.focus,
    '多场返回概览并恢复入口焦点', returned);

  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(120);
  await page.click('[data-baseline-mode="multi"]');
  await page.waitForTimeout(120);
  await page.click('#wsHistoryBaselineRecent');
  await page.waitForTimeout(80);
  const recent = await page.evaluate(() => ({
    chips: document.querySelectorAll('.history-baseline-chip').length,
    text: document.getElementById('wsHistoryBaselineStatus')?.textContent
  }));
  check(recent.chips === 3 && recent.text.includes('最近'),
    '多选支持最近 3 场快捷选择', recent);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  await page.evaluate(() => { window.__fakeMulti.deferSingle = true; });
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(120);
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(80);
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(120);
  await page.click('[data-baseline-mode="multi"]');
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(180);
  await page.evaluate(() => window.__fakeMulti.resolveSingle());
  await page.waitForTimeout(140);
  const race = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    multiCards: document.querySelectorAll('.history-multi-context-card').length
  }));
  check(race.title === '多场对比' && race.multiCards === 3,
    '迟到的单基准响应不覆盖多场视图', race);

  await page.evaluate(() => { window.__fakeMulti.deferMulti = true; });
  await page.click('[data-history-baseline-multi]');
  await page.waitForTimeout(160);
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(60);
  const loading = await page.evaluate(() => ({
    text: document.querySelector('.history-detail-loading')?.textContent.trim(),
    focused: document.activeElement?.classList.contains('history-detail-loading') || false
  }));
  check(loading.text === '正在载入多场对比…' && loading.focused === true,
    '多场加载态可获得焦点', loading);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(160);
  const cancelled = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    loading: !!document.querySelector('.history-detail-loading')
  }));
  check(cancelled.title === '夜航电台' && cancelled.loading === false,
    'Escape 可取消多场加载', cancelled);
  await page.evaluate(() => window.__fakeMulti.resolveMulti());
  await page.waitForTimeout(140);
  const staleMulti = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    cards: document.querySelectorAll('.history-multi-context-card').length
  }));
  check(staleMulti.title === '夜航电台' && staleMulti.cards === 0,
    '取消后迟到的多场响应不覆盖概览', staleMulti);
  await page.evaluate(() => { window.__fakeMulti.deferMulti = false; });

  await page.evaluate(() => { window.__fakeMulti.stale = true; });
  await page.evaluate(() => {
    document.querySelector('#wsHistoryDetail [data-history-baseline]').click();
  });
  await page.waitForTimeout(140);
  await page.click('[data-baseline-mode="multi"]');
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(200);
  const staleView = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    warnings: document.querySelector('.history-multi-warnings')?.textContent || '',
    role: document.querySelector('.history-multi-warnings')?.getAttribute('role')
  }));
  check(staleView.title === '多场对比' && staleView.warnings.includes('待落盘') &&
      staleView.role === 'alert',
    '多场视图披露 stale 与待落盘写入', staleView);
  await page.evaluate(() => { window.__fakeMulti.stale = false; });

  await page.evaluate(() => { window.__fakeMulti.baselinePage = 'partial'; });
  await page.click('[data-history-baseline-multi]');
  await page.waitForTimeout(180);
  const offPage = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.history-baseline-chip')].map((node) => node.textContent),
    unknown: [...document.querySelectorAll('.history-baseline-chip')]
      .some((node) => node.textContent.includes('未加载场次')),
    applyDisabled: document.getElementById('wsHistoryBaselineApply')?.disabled
  }));
  check(offPage.chips.length === 2 && offPage.unknown === true &&
      offPage.applyDisabled === false,
    '未在第一页的已选基准不会被静默丢弃', offPage);
  await page.click('#wsHistoryBaselineClose');
  await page.waitForTimeout(100);
  await page.evaluate(() => { window.__fakeMulti.baselinePage = 'all'; });

  await page.click('[data-history-baseline-multi]');
  await page.waitForTimeout(160);
  await page.click('[data-baseline-mode="multi"]');
  await page.waitForTimeout(60);
  const activeClick = await page.evaluate(() => ({
    chips: document.querySelectorAll('.history-baseline-chip').length
  }));
  check(activeClick.chips === 2, '再次点击已激活的多场 tab 不清空选择', activeClick);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(100);
  const singleTab = await page.evaluate(() => ({
    selected: document.querySelector('[data-baseline-mode="single"]')?.getAttribute('aria-selected'),
    radios: document.querySelectorAll('.history-baseline-item input[type=radio]').length,
    chipsHidden: document.getElementById('wsHistoryBaselineChips')?.hidden
  }));
  check(singleTab.selected === 'true' && singleTab.radios === 4 &&
      singleTab.chipsHidden === true,
    '多场 tab 支持方向键切回单场', singleTab);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  const multiTab = await page.evaluate(() => ({
    selected: document.querySelector('[data-baseline-mode="multi"]')?.getAttribute('aria-selected'),
    checkboxes: document.querySelectorAll('.history-baseline-item input[type=checkbox]').length,
    chips: document.querySelectorAll('.history-baseline-chip').length
  }));
  check(multiTab.selected === 'true' && multiTab.checkboxes === 4 && multiTab.chips === 0,
    '方向键切回多场并清空旧选择', multiTab);
  await page.click('#wsHistoryBaselineClose');
  await page.waitForTimeout(100);

  await page.click('[data-history-compare-back]');
  await page.waitForTimeout(140);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.waitForTimeout(100);
  const scrollBefore = await page.evaluate(() => {
    const pane = document.getElementById('wsHistoryDetailPane');
    pane.scrollTop = 240;
    return pane.scrollTop;
  });
  await page.evaluate(() => {
    document.querySelector('#wsHistoryDetail [data-history-baseline]').click();
  });
  await page.waitForTimeout(140);
  await page.click('[data-baseline-mode="multi"]');
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(200);
  await page.click('[data-history-compare-back]');
  await page.waitForTimeout(180);
  const scrollAfter = await page.evaluate(
    () => document.getElementById('wsHistoryDetailPane').scrollTop
  );
  check(scrollBefore > 0 && Math.abs(scrollAfter - scrollBefore) <= 2,
    '多场返回概览恢复进入前滚动位置', { before: scrollBefore, after: scrollAfter });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(80);

  await page.evaluate(() => { window.__fakeMulti.malformedMulti = true; });
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(140);
  await page.click('[data-baseline-mode="multi"]');
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(180);
  const malformed = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    message: document.querySelector('.history-multi-empty')?.textContent || '',
    focused: document.activeElement?.hasAttribute('data-history-focus') || false
  }));
  check(malformed.title === '多场对比' && malformed.message.includes('数据格式异常') &&
      malformed.focused === true,
    '多场响应缺字段时进入错误态而非假死', malformed);
  await page.click('[data-history-compare-back]');
  await page.waitForTimeout(120);

  await page.evaluate(() => { window.__fakeMulti.malformedMulti = 'fields'; });
  await page.evaluate(() => {
    document.querySelector('#wsHistoryDetail [data-history-baseline]').click();
  });
  await page.waitForTimeout(140);
  await page.click('[data-baseline-mode="multi"]');
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(180);
  const malformedFields = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    message: document.querySelector('.history-multi-empty')?.textContent || ''
  }));
  check(malformedFields.title === '多场对比' &&
      malformedFields.message.includes('数据格式异常'),
    '多场响应 session 字段非法时拒绝渲染', malformedFields);
  await page.evaluate(() => { window.__fakeMulti.malformedMulti = false; });
  await page.click('[data-history-compare-back]');
  await page.waitForTimeout(120);

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.waitForTimeout(100);
  const originScroll = await page.evaluate(() => {
    const pane = document.getElementById('wsHistoryDetailPane');
    pane.scrollTop = 90;
    return pane.scrollTop;
  });
  await page.evaluate(() => {
    document.querySelector('#wsHistoryDetail [data-history-baseline]').click();
  });
  await page.waitForTimeout(140);
  await page.click('[data-baseline-mode="multi"]');
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(200);
  const multiScroll = await page.evaluate(() => {
    const pane = document.getElementById('wsHistoryDetailPane');
    pane.scrollTop = 120;
    return pane.scrollTop;
  });
  await page.click('[data-history-baseline-multi]');
  await page.waitForTimeout(160);
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(200);
  await page.click('[data-history-compare-back]');
  await page.waitForTimeout(180);
  const adjustedScroll = await page.evaluate(
    () => document.getElementById('wsHistoryDetailPane').scrollTop
  );
  check(multiScroll > 0 && Math.abs(adjustedScroll - originScroll) <= 2,
    '多场内调整对比场不覆盖原始概览滚动位置',
    { origin: originScroll, multi: multiScroll, after: adjustedScroll });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(80);

  await page.evaluate(() => { window.__fakeMulti.deferExport = true; });
  await page.click('#wsHistoryDetail [data-history-baseline]');
  await page.waitForTimeout(140);
  await page.click('[data-baseline-mode="multi"]');
  await page.check('.history-baseline-item input[value="baseline-1"]');
  await page.check('.history-baseline-item input[value="baseline-2"]');
  await page.click('#wsHistoryBaselineApply');
  await page.waitForTimeout(180);
  await page.click(
    '[data-history-analysis-export="compare_multi"][data-format="json"]'
  );
  await page.waitForTimeout(80);
  const exportBusy = await page.evaluate(() => ({
    disabled: [...document.querySelectorAll(
      '[data-history-analysis-export="compare_multi"]'
    )].every((button) => button.disabled),
    busy: document.querySelector(
      '[data-analysis-export-status="compare_multi"]'
    )?.className.includes('is-busy') || false,
    text: document.querySelector(
      '[data-analysis-export-status="compare_multi"]'
    )?.textContent || ''
  }));
  check(exportBusy.disabled === true && exportBusy.busy === true &&
      exportBusy.text.includes('正在由服务端重算'),
    '多场导出中禁用按钮并显示 busy', exportBusy);
  await page.click('[data-history-compare-back]');
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__fakeMulti.resolveExport());
  await page.waitForTimeout(120);
  const exportRace = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    status: !!document.querySelector('[data-analysis-export-status="compare_multi"]')
  }));
  check(exportRace.title === '夜航电台' && exportRace.status === false,
    '导出中返回概览后旧响应不污染视图', exportRace);
  await page.evaluate(() => { window.__fakeMulti.deferExport = false; });

  check(errors.length === 0, '无页面脚本错误', errors);
  await browser.close();
  console.log('\nSUMMARY  PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
