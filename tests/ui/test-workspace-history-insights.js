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
      real_received: 100,
      real_spoken: 80,
      real_dropped: 20,
      mock_received: 2,
      mock_spoken: 0,
      mock_dropped: 0,
      unique_users: 40,
      gift_cny: 10,
      gift_silver: 0,
      gift_unknown: 0,
      super_chat_cny: 30
    };
    const earlier = {
      ...target,
      id: 'earlier',
      room_title: '夜航电台 · 上一场',
      started_at: now - 2 * 86400,
      ended_at: now - 2 * 86400 + 3600,
      real_received: 80,
      real_spoken: 60,
      real_dropped: 20,
      unique_users: 30
    };
    const detail = (session) => ({
      ...clone(session),
      types: { danmaku: 70, gift: 10, super_chat: 2, guard: 3, enter: 5 },
      minutes: [
        { minute: Math.floor(session.started_at / 60) + 35, count: 42 },
        { minute: Math.floor(session.started_at / 60) + 36, count: 20 }
      ]
    });
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
          arbitrary_compare: 1,
          previous_compare: 1,
          trend: 1,
          insights: 1
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
    let mode = 'ready';
    let delayTarget = 0;
    const calls = [];

    function insightResponse(targetId) {
      if (mode === 'error') {
        return {
          ok: false,
          available: true,
          error_code: 'data_stale',
          error: '历史写入尚未落盘'
        };
      }
      const isTarget = targetId === 'target';
      const current = isTarget ? 100 : 80;
      const insufficient = mode === 'insufficient';
      const unqualified = mode === 'unqualified';
      const available = !insufficient && !unqualified;
      return {
        ok: true,
        available: true,
        insights_available: available,
        reason: insufficient ? 'insufficient_sample' :
          unqualified ? 'target_unqualified' : null,
        target: {
          id: targetId,
          started_at: isTarget ? target.started_at : earlier.started_at,
          ended_at: isTarget ? target.ended_at : earlier.ended_at
        },
        target_metrics: {
          received_per_hour: current,
          spoken_rate: isTarget ? 0.8 : 0.75,
          drop_rate: isTarget ? 0.2 : 0.25,
          duration_seconds: 3600
        },
        metric_cohort: {
          candidate_count: insufficient ? 3 : 20,
          valid_count: insufficient ? 3 : 20,
          excluded: { invalid: 0, incomplete: insufficient ? 2 : 0, short: insufficient ? 1 : 0, overlap: 0 },
          limited: false,
          iqr_available: !insufficient,
          minimum_sample: 8,
          minimum_iqr_sample: 12
        },
        metrics: [{
          key: 'received_per_hour',
          domain: 'rate_per_hour',
          available: available,
          reason: available ? null : (insufficient ? 'insufficient_sample' : 'target_unqualified'),
          current: current,
          sample_count: insufficient ? 3 : 20,
          median: available ? 39 : null,
          p25: available ? 29.5 : null,
          p75: available ? 48.5 : null,
          higher_count: available ? (isTarget ? 0 : 18) : 0,
          tied_count: available ? 0 : 0,
          lower_count: available ? (isTarget ? 20 : 2) : 0
        }],
        target_facts: {
          spoken_rate: isTarget ? 0.8 : 0.75,
          drop_rate: isTarget ? 0.2 : 0.25
        },
        peak: {
          available: true,
          minute_complete: true,
          count: isTarget ? 42 : 35,
          offset_start_min: 35,
          offset_end_min: 40,
          start_local: '21:35',
          end_local: '21:40'
        },
        peak_cohort: {
          valid_count: 16,
          sample_threshold: 12,
          available: true,
          total_samples: 20,
          hours: [
            { hour: 21, count: 5 },
            { hour: 22, count: 4 },
            { hour: 23, count: 3 },
            { hour: 0, count: 2 },
            { hour: 1, count: 1 }
          ]
        },
        target_quality: {
          qualified: !unqualified,
          flags: unqualified ? ['target_short'] : []
        },
        quality: {
          flags: unqualified ? ['target_short'] : [],
          degraded: false
        }
      };
    }

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
        capabilities: { arbitrary_compare: 1, previous_compare: 1, trend: 1, insights: 1 }
      }),
      history_list_sessions: () => ({
        ok: true,
        sessions: clone([target, earlier]),
        total: 2,
        all_total: 2,
        platforms: [{ platform: 'bilibili', count: 2 }],
        has_more: false,
        next_cursor: null,
        gap_events: 0
      }),
      history_get_session: (id) => {
        const session = id === 'target' ? target : id === 'earlier' ? earlier : null;
        return session
          ? { ok: true, session: detail(session) }
          : { ok: false, error: '场次不存在', session: null };
      },
      history_get_previous_session: () => ({
        ok: true,
        status: 'no_previous',
        target: detail(target),
        previous: null,
        has_previous: false
      }),
      history_list_baselines: () => ({
        ok: true,
        available: true,
        target: clone(target),
        scope: { platform: 'bilibili', room_key: '777' },
        candidates: [],
        total: 0,
        has_more: false,
        next_cursor: null
      }),
      history_compare_sessions: () => ({
        ok: false,
        available: true,
        error_code: 'baseline_not_found',
        error: '基准场不存在',
        target: null,
        baseline: null
      }),
      history_session_insights: (targetId) => {
        calls.push(targetId);
        const response = insightResponse(targetId);
        if (targetId === 'target' && delayTarget > 0) {
          return new Promise((resolve) => setTimeout(() => resolve(response), delayTarget));
        }
        return response;
      },
      preview: () => ({ ok: true })
    };
    window.__fakeInsight = {
      calls,
      setMode(value) { mode = String(value || 'ready'); },
      setDelayTarget(value) { delayTarget = Number(value) || 0; }
    };
    window.pywebview = { api };
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(150);
  await page.click('[data-data-tab="history"]');
  await page.waitForTimeout(300);
  await page.click('#wsHistoryList .history-item[data-history-id="target"]');
  await page.waitForTimeout(280);

  const ready = await page.evaluate(() => {
    const card = document.querySelector('.history-insight-card');
    const host = document.querySelector('[data-history-insight-host]');
    return {
      exists: !!card,
      target: card?.getAttribute('data-insight-target'),
      text: card?.textContent || '',
      range: !!document.querySelector('.history-insight-range'),
      peakHours: [...document.querySelectorAll('.history-insight-hour')].map((node) => node.textContent),
      detailStillHasMetrics: !!document.querySelector('.history-detail-metrics'),
      focusTitle: document.activeElement?.hasAttribute('data-history-focus') || false,
      body: [document.body.scrollWidth, document.body.clientWidth]
    };
  });
  check(ready.exists && ready.target === 'target', '详情加载后异步生成复盘卡');
  check(ready.text.includes('有 0 场高于本场') && ready.text.includes('20 场低于本场') &&
      ready.text.includes('有效 20 场'),
    '展示精确名次和有效样本', ready.text.slice(0, 240));
  check(ready.text.includes('P25–P75') && ready.text.includes('39.0'),
    '展示中位数和四分位区间');
  check(ready.range, '收到/小时使用范围条');
  check(ready.text.includes('21:35–21:40') && ready.text.includes('42 条'),
    '展示本场滚动 5 分钟峰值');
  check(ready.peakHours.length === 3 && ready.peakHours.join(',').includes('21 点档') &&
      ready.text.includes('峰值最集中的 3 个时段') &&
      ready.text.includes('20 个完整样本'),
    '展示近场峰值小时分布', ready.peakHours);
  check(ready.detailStillHasMetrics, '洞察增量更新不破坏详情主体');
  check(ready.focusTitle, '异步洞察不抢走详情标题焦点');
  check(!/更好|更差|导致|建议|最佳|人气峰值/.test(ready.text) &&
      ready.text.includes('不是平台观众或平台营收口径'),
    '复盘文案不使用因果或平台口径', ready.text);
  check(ready.body[0] <= ready.body[1], '1280 复盘卡无横向溢出', ready.body);
  await page.screenshot({ path: path.join(OUT, 'history-insights-1280x820.png') });

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(100);
  const at1024 = await page.evaluate(() => ({
    body: [document.body.scrollWidth, document.body.clientWidth],
    grid: getComputedStyle(document.querySelector('.history-insight-grid')).gridTemplateColumns,
    card: (() => {
      const node = document.querySelector('.history-insight-card');
      return [node.scrollWidth, node.clientWidth];
    })(),
    pane: (() => {
      const node = document.getElementById('wsHistoryDetailPane');
      return [node.scrollWidth, node.clientWidth];
    })()
  }));
  check(at1024.body[0] <= at1024.body[1] && at1024.grid.split(' ').length === 1 &&
      at1024.card[0] <= at1024.card[1] + 1 &&
      at1024.pane[0] <= at1024.pane[1] + 1,
    '1024 复盘卡单列且无横向溢出', at1024);
  await page.screenshot({ path: path.join(OUT, 'history-insights-1024x700.png') });

  await page.setViewportSize({ width: 1707, height: 960 });
  await page.waitForTimeout(100);
  const at1707 = await page.evaluate(() => ({
    body: [document.body.scrollWidth, document.body.clientWidth],
    grid: getComputedStyle(document.querySelector('.history-insight-grid')).gridTemplateColumns
  }));
  check(at1707.body[0] <= at1707.body[1] && at1707.grid.split(' ').length >= 2,
    '1707 复盘卡使用双列', at1707);
  await page.screenshot({ path: path.join(OUT, 'history-insights-1707x960.png') });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    window.__fakeInsight.setDelayTarget(400);
  });
  await page.click('#wsHistoryList .history-item[data-history-id="target"]');
  await page.click('#wsHistoryList .history-item[data-history-id="earlier"]');
  await page.waitForTimeout(520);
  const race = await page.evaluate(() => ({
    targetId: window.__MUTAI_SHELL__.state.historyInsightTargetId,
    cardTarget: document.querySelector('.history-insight-card')?.getAttribute('data-insight-target'),
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent
  }));
  check(race.title === '夜航电台 · 上一场' && race.targetId === 'earlier' &&
      race.cardTarget === 'earlier',
    '切换场次后旧洞察结果不会覆盖新场次', race);
  await page.evaluate(() => window.__fakeInsight.setDelayTarget(0));

  await page.evaluate(() => window.__fakeInsight.setMode('insufficient'));
  await page.click('#wsHistoryList .history-item[data-history-id="target"]');
  await page.waitForTimeout(180);
  const insufficient = await page.evaluate(() => ({
    text: document.querySelector('.history-insight-card')?.textContent || '',
    range: !!document.querySelector('.history-insight-range')
  }));
  check(insufficient.text.includes('不足 8 场') && !insufficient.range,
    '样本不足显示降级，不伪造范围条', insufficient);

  await page.evaluate(() => window.__fakeInsight.setMode('unqualified'));
  await page.click('#wsHistoryList .history-item[data-history-id="target"]');
  await page.waitForTimeout(180);
  const unqualified = await page.evaluate(() =>
    document.querySelector('.history-insight-card')?.textContent || ''
  );
  check(unqualified.includes('不满足基线门槛') && unqualified.includes('本场样本偏短'),
    '目标不合格保留事实并显示原因', unqualified.slice(0, 260));

  await page.evaluate(() => window.__fakeInsight.setMode('error'));
  await page.click('#wsHistoryList .history-item[data-history-id="target"]');
  await page.waitForTimeout(180);
  const failed = await page.evaluate(() => ({
    role: document.querySelector('.history-insight-error')?.getAttribute('role'),
    text: document.querySelector('.history-insight-error')?.textContent || '',
    retry: !!document.querySelector('[data-history-insight-retry]')
  }));
  check(failed.role === 'alert' && failed.text.includes('尚未完成') && failed.retry,
    '洞察硬失败使用可重试 alert', failed);
  await page.click('[data-history-insight-retry]');
  await page.waitForTimeout(180);
  const retryFailed = await page.evaluate(() => ({
    role: document.querySelector('.history-insight-error')?.getAttribute('role'),
    focusedError: document.activeElement?.classList.contains('history-insight-error') || false
  }));
  check(retryFailed.role === 'alert' && retryFailed.focusedError,
    '重试再次失败时焦点留在错误区域', retryFailed);
  await page.evaluate(() => window.__fakeInsight.setMode('ready'));
  await page.click('[data-history-insight-retry]');
  await page.waitForTimeout(220);
  const recovered = await page.evaluate(() => ({
    hasCard: !!document.querySelector('.history-insight-range'),
    focusTitle: document.activeElement?.id === 'historyInsightTitle'
  }));
  check(recovered.hasCard && recovered.focusTitle,
    '重试成功后恢复复盘并把焦点放回复盘标题', recovered);

  check(errors.length === 0, '无页面脚本错误', errors);
  console.log('\nSUMMARY  PASS=' + pass + '  FAIL=' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
