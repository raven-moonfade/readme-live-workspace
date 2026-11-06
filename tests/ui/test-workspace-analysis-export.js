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
    const mode = {
      failInsightsExport: false,
      failTrendExport: false,
      failCompareExport: false,
      insightsDelay: 0
    };
    const calls = [];
    const room = {
      platform: 'bilibili',
      room_key: '777',
      room_id: 777,
      room_title: '夜航电台',
      sessions: 2,
      last_started_at: target.started_at
    };
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
          trend_granularities: ['hour', 'day', 'week'],
          insights: 1,
          analysis_export: 1,
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

    function insights() {
      return {
        ok: true,
        available: true,
        insights_available: true,
        reason: null,
        target: detail(target),
        target_metrics: {
          received_per_hour: 100,
          spoken_rate: 0.8,
          drop_rate: 0.2,
          duration_seconds: 3600
        },
        target_facts: { spoken_rate: 0.8, drop_rate: 0.2 },
        metric_cohort: {
          candidate_count: 20,
          valid_count: 20,
          excluded: { invalid: 0, incomplete: 0, short: 0, overlap: 0 },
          limited: false,
          iqr_available: true,
          minimum_sample: 8,
          minimum_iqr_sample: 12
        },
        metrics: [{
          key: 'received_per_hour',
          domain: 'rate_per_hour',
          available: true,
          reason: null,
          current: 100,
          sample_count: 20,
          median: 39,
          p25: 29.5,
          p75: 48.5,
          higher_count: 0,
          tied_count: 0,
          lower_count: 20
        }],
        peak: {
          available: true,
          minute_complete: true,
          count: 42,
          offset_start_min: 35,
          offset_end_min: 40,
          start_local: '21:35',
          end_local: '21:40',
          day: '2026-10-25',
          end_day: '2026-10-25',
          crosses_day: false,
          hour: 21
        },
        peak_cohort: {
          valid_count: 16,
          sample_threshold: 12,
          available: true,
          total_samples: 20,
          hours: [{ hour: 21, count: 5 }, { hour: 22, count: 4 }, { hour: 23, count: 3 }]
        },
        target_quality: { qualified: true, flags: [], minute_complete: true },
        quality: { flags: [], degraded: false },
        definitions_version: 1,
        data_health: { flushed: true, pending_writes: 0, dropped_ops: 0, failed_ops: 0 }
      };
    }

    function trend(startedFrom, startedTo, query, platform, granularity, roomKey) {
      const isHour = granularity === 'hour';
      const isWeek = granularity === 'week';
      const dayBuckets = [
        {
          day: '2026-10-25', day_start: startedFrom, sessions: 1,
          sessions_with_data: 1, empty_sessions: 0, real_received: 100,
          real_spoken: 80, real_dropped: 20, duration_seconds: 3600,
          unique_users_sum: 40, unique_users_max: 40, gift_cny: 10,
          gift_silver: 0, gift_unknown: 0, super_chat_cny: 30,
          mock_received: 2, mock_spoken: 0, mock_dropped: 0,
          short_sessions: 0, incomplete_sessions: 0, replaced_sessions: 0,
          unknown_end_sessions: 0, inconsistent_sessions: 0, mock_sessions: 1,
          spoken_rate: 0.8, drop_rate: 0.2, has_data: true
        },
        {
          day: '2026-10-26', day_start: startedFrom + 86400, sessions: 1,
          sessions_with_data: 1, empty_sessions: 0, real_received: 80,
          real_spoken: 60, real_dropped: 20, duration_seconds: 3600,
          unique_users_sum: 30, unique_users_max: 30, gift_cny: 8,
          gift_silver: 0, gift_unknown: 0, super_chat_cny: 20,
          mock_received: 0, mock_spoken: 0, mock_dropped: 0,
          short_sessions: 0, incomplete_sessions: 0, replaced_sessions: 0,
          unknown_end_sessions: 0, inconsistent_sessions: 0, mock_sessions: 0,
          spoken_rate: 0.75, drop_rate: 0.25, has_data: true
        }
      ];
      const weekBucket = {
        bucket_key: '2026-W43',
        bucket_label: '2026-W43',
        bucket_start: startedFrom,
        bucket_end: startedFrom + 7 * 86400,
        iso_week: '2026-W43',
        week_start: startedFrom,
        week_end: startedFrom + 7 * 86400,
        week_start_date: '2026-10-19',
        week_last_date: '2026-10-25',
        week_label: '2026-10-19 ~ 2026-10-25',
        effective_start: startedFrom,
        effective_end: startedTo,
        partial: true,
        sessions: 2,
        sessions_with_data: 2,
        empty_sessions: 0,
        real_received: 180,
        real_spoken: 140,
        real_dropped: 40,
        duration_seconds: 7200,
        unique_users_sum: 70,
        unique_users_max: 40,
        gift_cny: 18,
        gift_silver: 0,
        gift_unknown: 0,
        super_chat_cny: 50,
        mock_received: 2,
        mock_spoken: 0,
        mock_dropped: 0,
        short_sessions: 0,
        incomplete_sessions: 0,
        replaced_sessions: 0,
        unknown_end_sessions: 0,
        inconsistent_sessions: 0,
        mock_sessions: 1,
        spoken_rate: 140 / 180,
        drop_rate: 40 / 180,
        has_data: true
      };
      const hourBucket = {
        bucket_key: '2026-10-25 20:00',
        bucket_label: '2026-10-25 20:00',
        bucket_start: startedFrom,
        bucket_end: startedFrom + 3600,
        hour: '2026-10-25 20:00',
        hour_start: startedFrom,
        hour_end: startedFrom + 3600,
        effective_start: startedFrom,
        effective_end: startedTo,
        partial: true,
        sessions: 2,
        sessions_with_data: 2,
        empty_sessions: 0,
        real_received: 180,
        real_spoken: 140,
        real_dropped: 40,
        duration_seconds: 7200,
        unique_users_sum: 70,
        unique_users_max: 40,
        gift_cny: 18,
        gift_silver: 0,
        gift_unknown: 0,
        super_chat_cny: 50,
        mock_received: 2,
        mock_spoken: 0,
        mock_dropped: 0,
        short_sessions: 0,
        incomplete_sessions: 0,
        replaced_sessions: 0,
        unknown_end_sessions: 0,
        inconsistent_sessions: 0,
        mock_sessions: 1,
        spoken_rate: 140 / 180,
        drop_rate: 40 / 180,
        has_data: true
      };
      return {
        ok: true,
        available: true,
        api_version: 1,
        as_of: now,
        granularity: isHour ? 'hour' : (isWeek ? 'week' : 'day'),
        date_basis: 'started_at',
        timezone: '中国标准时间',
        utc_offset_seconds: 28800,
        range: {
          started_from: startedFrom,
          started_to: startedTo,
          days: isHour ? 1 : 2,
          ...(isHour ? { hours: 2 } : {}),
          bucket_count: isWeek || isHour ? 1 : 2,
          first_bucket_partial: isWeek || isHour,
          last_bucket_partial: isWeek || isHour
        },
        filters: { query: query || '', platform: platform || 'bilibili', room_key: roomKey || '777' },
        scope: room,
        rooms: [room],
        counts: {
          matched_sessions: 2,
          all_sessions: 2,
          sessions_with_data: 2,
          empty_sessions: 0,
          active_sessions: 0,
          platform_count: 1,
          room_count: 1,
          unscoped_sessions: 0,
          bucket_count: isWeek || isHour ? 1 : 2,
          non_empty_buckets: isWeek || isHour ? 1 : 2,
          empty_buckets: 0,
          partial_buckets: isWeek || isHour ? 1 : 0
        },
        totals: {
          real_received: 180,
          real_spoken: 140,
          real_dropped: 40,
          duration_seconds: 7200,
          unique_users_max: 40,
          gift_cny: 18,
          gift_silver: 0,
          gift_unknown: 0,
          super_chat_cny: 50,
          mock_received: 2
        },
        buckets: isHour ? [hourBucket] : (isWeek ? [weekBucket] : dayBuckets),
        quality: {
          short_sessions: 0, incomplete_sessions: 0, replaced_sessions: 0,
          unknown_end_sessions: 0, inconsistent_sessions: 0, mock_sessions: 1,
          low_sample: true, unscoped_sessions: 0
        },
        coverage: { data_starts_at: startedFrom, data_ends_at: startedTo, partial: false },
        money: { comparable: true, note: '本机聚合字段' },
        data_health: { flushed: true, pending_writes: 0, dropped_ops: 0, failed_ops: 0 },
        hour_basis: isHour
          ? { boundary: 'local_civil', end_exclusive: true, max_hours: 168 }
          : null,
        week_basis: isWeek
          ? { start_weekday: 'monday', label: 'iso8601', boundary: 'local_civil', end_exclusive: true }
          : null,
        max_buckets: isHour ? 168 : 366
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
        capabilities: {
          arbitrary_compare: 1,
          previous_compare: 1,
          trend: 1,
          trend_granularities: ['hour', 'day', 'week'],
          insights: 1,
          analysis_export: 1,
          export_manage: 1
        }
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
        status: 'found',
        target: detail(target),
        previous: detail(earlier),
        session: detail(earlier),
        has_previous: true
      }),
      history_list_baselines: () => ({
        ok: true,
        available: true,
        target: clone(target),
        scope: { platform: 'bilibili', room_key: '777' },
        candidates: [clone(earlier)],
        total: 1,
        has_more: false,
        next_cursor: null
      }),
      history_compare_sessions: (targetId, baselineId) => ({
        ok: true,
        available: true,
        api_version: 1,
        scope: { platform: 'bilibili', room_key: '777' },
        target: detail(target),
        baseline: detail(earlier),
        stale: false,
        data_health: { flushed: true, pending_writes: 0, dropped_ops: 0, failed_ops: 0 }
      }),
      history_session_insights: () => insights(),
      history_trend: (startedFrom, startedTo, query, platform, granularity, roomKey) => {
        calls.push({ type: 'trend', startedFrom, startedTo, query, platform, granularity, roomKey });
        return trend(startedFrom, startedTo, query, platform, granularity, roomKey);
      },
      history_export_trend: (startedFrom, startedTo, query, platform, granularity, roomKey, format) => {
        calls.push({
          type: 'export-trend', startedFrom, startedTo, query, platform, granularity, roomKey, format
        });
        if (mode.failTrendExport) {
          return { ok: false, error_code: 'data_stale', error: '趋势报告写入尚未完成' };
        }
        return {
          ok: true,
          format: format,
          path: 'D:/exports/mutai-report-trend.' + format,
          report_schema_version: 1,
          kind: 'trend',
          warnings: [{ code: 'low_sample' }]
        };
      },
      history_export_compare: (targetId, baselineId, format) => {
        calls.push({ type: 'export-compare', targetId, baselineId, format });
        if (mode.failCompareExport) {
          return { ok: false, error_code: 'data_stale', error: '对比报告写入尚未完成' };
        }
        return {
          ok: true,
          format,
          path: 'D:/exports/mutai-report-compare.' + format,
          report_schema_version: 1,
          kind: 'compare',
          warnings: []
        };
      },
      history_export_insights: (targetId, format) => {
        calls.push({ type: 'export-insights', targetId, format });
        if (mode.failInsightsExport) {
          return { ok: false, error_code: 'data_stale', error: '历史写入尚未完成，暂不导出' };
        }
        const result = {
          ok: true,
          format,
          path: 'D:/exports/mutai-report-insights.' + format,
          report_schema_version: 1,
          kind: 'insights',
          warnings: [{ code: 'degraded' }]
        };
        return mode.insightsDelay > 0
          ? new Promise((resolve) => setTimeout(() => resolve(result), mode.insightsDelay))
          : result;
      },
      history_export_storage_status: () => ({ ok: true, files: 0 }),
      history_export_storage_preview: () => ({ ok: true, totals: { total_count: 0 } }),
      history_export_storage_prune: () => ({ ok: true, deleted_count: 0 }),
      history_export_storage_open_dir: () => ({ ok: true, directory: 'D:/exports' }),
      preview: () => ({ ok: true })
    };
    window.__analysisExport = {
      calls,
      mode,
      setFailInsightsExport(value) { mode.failInsightsExport = Boolean(value); },
      setFailTrendExport(value) { mode.failTrendExport = Boolean(value); },
      setFailCompareExport(value) { mode.failCompareExport = Boolean(value); },
      setInsightsDelay(value) { mode.insightsDelay = Number(value) || 0; }
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
  await page.waitForTimeout(320);

  const insight = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('.history-insight-card [data-history-analysis-export]')]
      .map((node) => node.getAttribute('data-format')),
    mainHeadButtons: document.querySelectorAll(
      '.history-detail-head [data-history-analysis-export]'
    ).length,
    card: !!document.querySelector('.history-insight-card'),
    status: !!document.querySelector('[data-analysis-export-status="insights"]')
  }));
  check(insight.card && insight.buttons.length === 2 && insight.status,
    '复盘卡提供 JSON/CSV 导出入口', insight);
  check(insight.mainHeadButtons === 0, '分析导出未挤占历史详情主操作行');
  await page.screenshot({ path: path.join(OUT, 'analysis-export-1280x820.png') });

  await page.click('.history-insight-card [data-history-analysis-export="insights"][data-format="json"]');
  await page.waitForTimeout(180);
  const insightExport = await page.evaluate(() => ({
    calls: window.__analysisExport.calls.filter((item) => item.type === 'export-insights'),
    text: document.querySelector('[data-analysis-export-status="insights"]')?.textContent || '',
    tone: document.querySelector('[data-analysis-export-status="insights"]')?.className || '',
    manageLink: !!document.querySelector(
      '[data-analysis-export-status="insights"] [data-open-export-manage]'
    )
  }));
  check(insightExport.calls.length === 1 &&
      insightExport.calls[0].targetId === 'target' &&
      insightExport.calls[0].format === 'json',
    '复盘导出按目标场次请求服务端', insightExport.calls);
  check(insightExport.text.includes('已导出 JSON') &&
      insightExport.text.includes('mutai-report-insights.json') &&
      insightExport.text.includes('1 条质量提示') &&
      insightExport.tone.includes('is-ok'),
    '复盘导出展示文件路径与质量提示', insightExport);
  check(insightExport.manageLink, '导出成功提供导出文件管理入口', insightExport);

  await page.click('[data-history-compare]');
  await page.waitForTimeout(260);
  const compare = await page.evaluate(() => ({
    buttons: document.querySelectorAll(
      '.history-detail-head [data-history-analysis-export="compare"]'
    ).length,
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    status: !!document.querySelector('[data-analysis-export-status="compare"]')
  }));
  check(compare.title === '场次对比' && compare.buttons === 2 && compare.status,
    '对比视图区块头提供 JSON/CSV 导出', compare);

  await page.click('.history-detail-head [data-history-analysis-export="compare"][data-format="csv"]');
  await page.waitForTimeout(180);
  const compareExport = await page.evaluate(() => ({
    calls: window.__analysisExport.calls.filter((item) => item.type === 'export-compare'),
    text: document.querySelector('[data-analysis-export-status="compare"]')?.textContent || ''
  }));
  check(compareExport.calls.length === 1 &&
      compareExport.calls[0].targetId === 'target' &&
      compareExport.calls[0].baselineId === 'earlier' &&
      compareExport.calls[0].format === 'csv',
    '对比导出携带当前与基准场 ID', compareExport.calls);
  check(compareExport.text.includes('已导出 CSV') &&
      compareExport.text.includes('mutai-report-compare.csv'),
    '对比导出展示成功状态', compareExport.text);

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(100);
  const compactCompare = await page.evaluate(() => ({
    body: [document.body.scrollWidth, document.body.clientWidth],
    pane: (() => {
      const node = document.getElementById('wsHistoryDetailPane');
      return [node.scrollWidth, node.clientWidth];
    })(),
    header: (() => {
      const node = document.querySelector('.history-detail-head');
      return [node.scrollWidth, node.clientWidth];
    })(),
    buttons: document.querySelectorAll(
      '.history-detail-head [data-history-analysis-export="compare"]'
    ).length
  }));
  check(compactCompare.body[0] <= compactCompare.body[1] &&
      compactCompare.pane[0] <= compactCompare.pane[1] + 1 &&
      compactCompare.header[0] <= compactCompare.header[1] + 1 &&
      compactCompare.buttons === 2,
    '1024 对比导出入口不横向溢出', compactCompare);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(100);

  await page.evaluate(() => window.__analysisExport.setFailCompareExport(true));
  await page.click('.history-detail-head [data-history-analysis-export="compare"][data-format="json"]');
  await page.waitForTimeout(180);
  const compareFailed = await page.evaluate(() => {
    const node = document.querySelector('[data-analysis-export-status="compare"]');
    return {
      role: node?.getAttribute('role'),
      text: node?.textContent || '',
      tone: node?.className || ''
    };
  });
  check(compareFailed.role === 'alert' &&
      compareFailed.text.includes('对比报告写入尚未完成') &&
      compareFailed.tone.includes('is-error'),
    '对比导出失败提供可播报错误', compareFailed);
  await page.evaluate(() => window.__analysisExport.setFailCompareExport(false));

  await page.click('[data-history-compare-back]');
  await page.waitForTimeout(160);
  await page.click('#wsHistoryTrendBtn');
  await page.waitForTimeout(300);
  const trend = await page.evaluate(() => ({
    buttons: document.querySelectorAll(
      '.history-detail-head [data-history-analysis-export="trend"]'
    ).length,
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    status: !!document.querySelector('[data-analysis-export-status="trend"]')
  }));
  check(trend.title === '历史趋势' && trend.buttons === 2 && trend.status,
    '趋势区块头提供 JSON/CSV 导出', trend);

  await page.click('.history-detail-head [data-history-analysis-export="trend"][data-format="json"]');
  await page.waitForTimeout(180);
  const trendExport = await page.evaluate(() => ({
    calls: window.__analysisExport.calls.filter((item) => item.type === 'export-trend'),
    text: document.querySelector('[data-analysis-export-status="trend"]')?.textContent || ''
  }));
  check(trendExport.calls.length === 1 &&
      trendExport.calls[0].roomKey === '777' &&
      trendExport.calls[0].format === 'json' &&
      trendExport.calls[0].granularity === 'day',
    '趋势导出携带同一房间与日期参数', trendExport.calls);
  check(trendExport.text.includes('已导出 JSON') &&
      trendExport.text.includes('mutai-report-trend.json'),
    '趋势导出展示成功状态', trendExport.text);
  check(!trendExport.text.includes('管理导出文件'),
    '趋势成功状态不重复管理入口', trendExport.text);

  await page.click('[data-trend-granularity="hour"]');
  await page.waitForTimeout(220);
  const hourTrend = await page.evaluate(() => ({
    header: document.querySelector('.history-trend-card-head h3')?.textContent,
    active: document.querySelector('[data-trend-granularity].is-active')
      ?.getAttribute('data-trend-granularity'),
    range: document.getElementById('wsHistoryRange')?.value,
    exportButtons: document.querySelectorAll(
      '.history-detail-head [data-history-analysis-export="trend"]'
    ).length
  }));
  check(hourTrend.header === '按开播小时' && hourTrend.active === 'hour' &&
      hourTrend.range === '7d' && hourTrend.exportButtons === 2,
    '趋势导出入口跟随当前小时粒度', hourTrend);
  await page.click('.history-detail-head [data-history-analysis-export="trend"][data-format="csv"]');
  await page.waitForTimeout(180);
  const hourTrendExport = await page.evaluate(() => ({
    calls: window.__analysisExport.calls.filter((item) => item.type === 'export-trend'),
    text: document.querySelector('[data-analysis-export-status="trend"]')?.textContent || ''
  }));
  check(hourTrendExport.calls.length === 2 &&
      hourTrendExport.calls[1].granularity === 'hour' &&
      hourTrendExport.calls[1].format === 'csv',
    '小时趋势导出携带 hour 粒度', hourTrendExport.calls);
  check(hourTrendExport.text.includes('已导出 CSV') &&
      hourTrendExport.text.includes('mutai-report-trend.csv'),
    '小时趋势导出展示成功状态', hourTrendExport.text);

  await page.click('[data-trend-granularity="week"]');
  await page.waitForTimeout(220);
  const weekTrend = await page.evaluate(() => ({
    header: document.querySelector('.history-trend-card-head h3')?.textContent,
    active: document.querySelector('[data-trend-granularity].is-active')
      ?.getAttribute('data-trend-granularity'),
    exportButtons: document.querySelectorAll(
      '.history-detail-head [data-history-analysis-export="trend"]'
    ).length
  }));
  check(weekTrend.header === '按开播周' && weekTrend.active === 'week' &&
      weekTrend.exportButtons === 2,
    '趋势导出入口跟随当前周粒度', weekTrend);
  await page.click('.history-detail-head [data-history-analysis-export="trend"][data-format="csv"]');
  await page.waitForTimeout(180);
  const weekTrendExport = await page.evaluate(() => ({
    calls: window.__analysisExport.calls.filter((item) => item.type === 'export-trend'),
    text: document.querySelector('[data-analysis-export-status="trend"]')?.textContent || ''
  }));
  check(weekTrendExport.calls.length === 3 &&
      weekTrendExport.calls[2].granularity === 'week' &&
      weekTrendExport.calls[2].format === 'csv',
    '周趋势导出携带 week 粒度', weekTrendExport.calls);
  check(weekTrendExport.text.includes('已导出 CSV') &&
      weekTrendExport.text.includes('mutai-report-trend.csv'),
    '周趋势导出展示成功状态', weekTrendExport.text);

  await page.evaluate(() => window.__analysisExport.setFailTrendExport(true));
  await page.click('.history-detail-head [data-history-analysis-export="trend"][data-format="csv"]');
  await page.waitForTimeout(180);
  const trendFailed = await page.evaluate(() => {
    const node = document.querySelector('[data-analysis-export-status="trend"]');
    return {
      role: node?.getAttribute('role'),
      text: node?.textContent || '',
      tone: node?.className || ''
    };
  });
  check(trendFailed.role === 'alert' &&
      trendFailed.text.includes('趋势报告写入尚未完成') &&
      !trendFailed.text.includes('对比') &&
      trendFailed.tone.includes('is-error'),
    '趋势导出失败提供可播报错误', trendFailed);
  await page.evaluate(() => window.__analysisExport.setFailTrendExport(false));

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(100);
  const compactTrend = await page.evaluate(() => ({
    body: [document.body.scrollWidth, document.body.clientWidth],
    pane: (() => {
      const node = document.getElementById('wsHistoryDetailPane');
      return [node.scrollWidth, node.clientWidth];
    })(),
    header: (() => {
      const node = document.querySelector('.history-detail-head');
      return [node.scrollWidth, node.clientWidth];
    })()
  }));
  check(compactTrend.body[0] <= compactTrend.body[1] &&
      compactTrend.pane[0] <= compactTrend.pane[1] + 1 &&
      compactTrend.header[0] <= compactTrend.header[1] + 1,
    '1024 趋势导出入口不横向溢出', compactTrend);

  await page.click('[data-history-trend-back]');
  await page.waitForTimeout(200);
  await page.click('#wsHistoryList .history-item[data-history-id="target"]');
  await page.waitForTimeout(320);
  const compactInsight = await page.evaluate(() => ({
    body: [document.body.scrollWidth, document.body.clientWidth],
    card: (() => {
      const node = document.querySelector('.history-insight-card');
      return [node.scrollWidth, node.clientWidth];
    })(),
    tools: (() => {
      const node = document.querySelector('.history-insight-tools');
      return [node.scrollWidth, node.clientWidth];
    })()
  }));
  check(compactInsight.body[0] <= compactInsight.body[1] &&
      compactInsight.card[0] <= compactInsight.card[1] + 1 &&
      compactInsight.tools[0] <= compactInsight.tools[1] + 1,
    '1024 复盘导出工具不横向溢出', compactInsight);
  await page.screenshot({ path: path.join(OUT, 'analysis-export-1024x700.png') });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => window.__analysisExport.setFailInsightsExport(true));
  await page.click('.history-insight-card [data-history-analysis-export="insights"][data-format="csv"]');
  await page.waitForTimeout(180);
  const failed = await page.evaluate(() => {
    const node = document.querySelector('[data-analysis-export-status="insights"]');
    return {
      role: node?.getAttribute('role'),
      text: node?.textContent || '',
      tone: node?.className || ''
    };
  });
  check(failed.role === 'alert' &&
      failed.text.includes('导出失败') &&
      failed.text.includes('尚未完成') &&
      !failed.text.includes('对比') &&
      failed.tone.includes('is-error'),
    '分析导出失败提供可播报错误', failed);

  await page.evaluate(() => {
    window.__analysisExport.setFailInsightsExport(false);
    window.__analysisExport.setInsightsDelay(500);
  });
  await page.click('.history-insight-card [data-history-analysis-export="insights"][data-format="json"]');
  await page.click('#wsHistoryList .history-item[data-history-id="earlier"]');
  await page.waitForTimeout(700);
  const exportRace = await page.evaluate(() => {
    const node = document.querySelector('[data-analysis-export-status="insights"]');
    return {
      title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
      hidden: !node || node.hidden === true,
      text: node?.textContent || '',
      path: window.__analysisExport.calls.filter((item) =>
        item.type === 'export-insights' && item.targetId === 'target'
      ).length
    };
  });
  check(exportRace.title === '夜航电台 · 上一场' &&
      exportRace.hidden === true &&
      !exportRace.text.includes('mutai-report-insights') &&
      exportRace.path === 3,
    '切换场次后旧导出结果不会污染新场次状态', exportRace);
  await page.evaluate(() => window.__analysisExport.setInsightsDelay(0));

  check(errors.length === 0, '无页面脚本错误', errors);
  await browser.close();
  console.log('\nSUMMARY  PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
