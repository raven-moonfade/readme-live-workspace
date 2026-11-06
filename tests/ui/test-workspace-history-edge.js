'use strict';

const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');
const path = require('path');
const PROJECT_ROOT = process.env.MUTAI_PROJECT_ROOT || path.resolve(__dirname, '../..');
const MOCK_PROJECT_ROOT = PROJECT_ROOT.replace(/\\/g, '/');
const fs = require('fs');

const URL = process.env.MUTAI_UI_URL || 'file:///' + path.resolve(PROJECT_ROOT, 'ui/index.html').replace(/\\/g, '/');
const OUT = process.env.MUTAI_UI_SHOTS || path.join(PROJECT_ROOT, 'qa/shots/ui');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1707, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.addInitScript(({ projectRoot }) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const now = Date.now() / 1000;
    const sessions = Array.from({ length: 35 }, (_, index) => ({
      id: 'history-' + (index + 1),
      platform: 'bilibili',
      room_id: 888666,
      room_key: '888666',
      room_title: '历史场次 ' + (index + 1),
      started_at: now - (index + 1) * 3600,
      ended_at: now - (index + 1) * 3600 + 1800,
      end_reason: index === 0 ? 'manual_disconnect' : 'disconnected',
      last_event_at: now - (index + 1) * 3600 + 1700,
      real_received: 100 + index,
      real_spoken: 80 + index,
      real_dropped: 20,
      mock_received: index % 2,
      mock_spoken: 0,
      mock_dropped: 0,
      unique_users: 30 + index,
      gift_cny: 12.3,
      gift_silver: 0,
      gift_unknown: 0,
      super_chat_cny: 50
    }));
    sessions.push({
      id: 'dy-1',
      platform: 'douyin',
      room_id: 0,
      room_key: 'dy:demo',
      room_title: '抖音演示场',
      started_at: now - 40 * 3600,
      ended_at: now - 40 * 3600 + 1800,
      end_reason: 'manual_disconnect',
      last_event_at: now - 40 * 3600 + 1700,
      real_received: 12,
      real_spoken: 10,
      real_dropped: 2,
      mock_received: 0,
      mock_spoken: 0,
      mock_dropped: 0,
      unique_users: 8,
      gift_cny: 0,
      gift_silver: 0,
      gift_unknown: 0,
      super_chat_cny: 0
    });
    const state = {
      connection: 'connected',
      room_id: 888666,
      room_title: '历史边界测试直播间',
      stats: { received: 7, spoken: 4, dropped: 1 },
      session: {
        id: 'live-session',
        started_at: now - 600,
        stats: { received: 7, spoken: 4, dropped: 1 },
        real: { received: 7, spoken: 4, dropped: 1 },
        mock: { received: 0, spoken: 0, dropped: 0 }
      },
      mock: { running: false, sent: 0 },
      queue_len: 0,
      now_playing: null,
      account: { logged_in: false, uname: null, mid: null },
      history: { available: true, error: null },
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
      theme_mode: 'light',
      accent: '#FF5F3A',
      pattern: { type: 'none', spacing_px: 24, dot_size_px: 1.5 },
      radius: { enabled: false, value_px: 12 },
      font: 'broadcast'
    };
    const calls = [];
    let fail = false;
    const detailFor = (id) => {
      const base = sessions.find((session) => session.id === id);
      return base ? {
        ...base,
        types: { danmaku: 80, gift: 10, super_chat: 2, guard: 3, enter: 5 },
        minutes: [{ minute: Math.floor(base.started_at / 60), count: 20 }]
      } : null;
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
      history_status: () => ({ ok: true, available: true, gap_events: 0 }),
      history_list_sessions: (limit, offset, query, startedFrom, startedTo, platform, beforeStarted, beforeId) => {
        calls.push({ limit, offset, query, startedFrom, startedTo, platform, beforeStarted, beforeId });
        if (fail) return { ok: false, error: '模拟历史存储故障', sessions: [], total: 0 };
        let filtered = sessions.filter((session) => {
          const text = String(query || '').trim().toLowerCase();
          if (text && !String(session.room_title).toLowerCase().includes(text) &&
              !String(session.room_id).includes(text)) return false;
          if (startedFrom != null && Number(session.started_at) < Number(startedFrom)) return false;
          if (startedTo != null && Number(session.started_at) >= Number(startedTo)) return false;
          if (platform && session.platform !== platform) return false;
          return true;
        });
        const total = filtered.length;
        if (beforeStarted != null && beforeId) {
          filtered = filtered.filter((session) =>
            Number(session.started_at) < Number(beforeStarted) ||
            (Number(session.started_at) === Number(beforeStarted) && String(session.id) < String(beforeId))
          );
        }
        const page = filtered.slice(0, limit);
        const last = page[page.length - 1];
        const platformCounts = {};
        sessions.forEach((session) => {
          const key = String(session.platform || '');
          if (key) platformCounts[key] = (platformCounts[key] || 0) + 1;
        });
        return {
          ok: true,
          sessions: clone(page),
          total,
          all_total: sessions.length,
          platforms: Object.keys(platformCounts).sort().map((key) => ({
            platform: key,
            count: platformCounts[key]
          })),
          has_more: page.length < filtered.length,
          next_cursor: last ? { started_at: last.started_at, id: last.id } : null,
          gap_events: 0
        };
      },
      history_get_session: (id) => {
        const session = detailFor(id);
        return session
          ? { ok: true, session: clone(session) }
          : { ok: false, error: '场次不存在', session: null };
      },
      history_export_session: (id, format) => ({
        ok: true,
        format,
        path: projectRoot + '/exports/history/' + id + '.' + format,
        size: 100
      }),
      history_delete_session: () => ({ ok: true }),
      preview: () => ({ ok: true })
    };
    window.__fakeHistory = {
      sessions,
      calls,
      setFail(value) { fail = !!value; },
      setEmpty() { sessions.length = 0; }
    };
    window.pywebview = { api };
  }, { projectRoot: MOCK_PROJECT_ROOT });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(120);
  await page.click('[data-data-tab="history"]');
  await page.waitForTimeout(300);

  const firstPage = await page.evaluate(() => ({
    count: document.querySelectorAll('#wsHistoryList .history-item').length,
    total: document.getElementById('wsHistoryCount').textContent,
    moreHidden: document.getElementById('wsHistoryMore').hidden,
    moreText: document.getElementById('wsHistoryMore').textContent,
    moreRect: (() => {
      const rect = document.getElementById('wsHistoryMore').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
    })(),
    platformHidden: document.getElementById('wsHistoryPlatform').hidden,
    platformOptions: [...document.querySelectorAll('#wsHistoryPlatform option')].map((node) => node.value),
    themeBg: getComputedStyle(document.body).backgroundColor,
    overflow: [document.body.scrollWidth, document.body.clientWidth]
  }));
  await page.screenshot({ path: path.join(OUT, 'session-history-paged-1707x960.png') });

  await page.evaluate(() => {
    document.getElementById('wsHistoryList').scrollTop = 640;
  });
  await page.click('#wsHistoryMore');
  await page.waitForTimeout(250);
  const afterMore = await page.evaluate(() => ({
    count: document.querySelectorAll('#wsHistoryList .history-item').length,
    moreHidden: document.getElementById('wsHistoryMore').hidden,
    summary: document.getElementById('wsHistorySummary').textContent,
    scrollTop: document.getElementById('wsHistoryList').scrollTop,
    calls: window.__fakeHistory.calls.slice()
  }));

  await page.selectOption('#wsHistoryPlatform', 'douyin');
  await page.waitForTimeout(250);
  const platformFiltered = await page.evaluate(() => ({
    count: document.querySelectorAll('#wsHistoryList .history-item').length,
    title: document.querySelector('#wsHistoryList .history-item-title')?.textContent,
    meta: document.querySelector('#wsHistoryList .history-item-meta')?.textContent || '',
    summary: document.getElementById('wsHistorySummary').textContent,
    resetVisible: !document.getElementById('wsHistoryFilterReset').hidden,
    lastCall: window.__fakeHistory.calls[window.__fakeHistory.calls.length - 1]
  }));
  const douyinBoundary = await page.evaluate(() => {
    const view = window.MutaiShell.root.historyMoneyView({
      platform: 'douyin',
      gift_cny: 0,
      gift_diamond: 4321,
      super_chat_cny: 0
    });
    return {
      gift: view.giftText.includes('4,321 钻石'),
      sc: view.scText === '平台未提供',
      note: view.note.includes('平台未提供 SC/舰长等价能力'),
      noFakeZero: !String(view.giftText + view.scText).includes('¥0.00')
    };
  });
  await page.click('#wsHistoryFilterReset');
  await page.waitForTimeout(250);

  await page.fill('#wsHistorySearch', '历史场次 31');
  await page.press('#wsHistorySearch', 'Enter');
  await page.waitForTimeout(250);
  const filtered = await page.evaluate(() => ({
    count: document.querySelectorAll('#wsHistoryList .history-item').length,
    title: document.querySelector('#wsHistoryList .history-item-title')?.textContent,
    badge: document.getElementById('wsHistoryCount').textContent,
    summary: document.getElementById('wsHistorySummary').textContent,
    resetVisible: !document.getElementById('wsHistoryFilterReset').hidden,
    lastCall: window.__fakeHistory.calls[window.__fakeHistory.calls.length - 1]
  }));

  await page.click('#wsHistoryFilterReset');
  await page.waitForTimeout(250);
  const filterReset = await page.evaluate(() => ({
    count: document.querySelectorAll('#wsHistoryList .history-item').length,
    resetHidden: document.getElementById('wsHistoryFilterReset').hidden,
    searchValue: document.getElementById('wsHistorySearch').value,
    rangeValue: document.getElementById('wsHistoryRange').value,
    platformValue: document.getElementById('wsHistoryPlatform').value
  }));

  await page.selectOption('#wsHistoryRange', '7d');
  await page.waitForTimeout(250);
  const dateFiltered = await page.evaluate(() => ({
    lastCall: window.__fakeHistory.calls[window.__fakeHistory.calls.length - 1],
    summary: document.getElementById('wsHistorySummary').textContent
  }));

  await page.selectOption('#wsHistoryRange', 'custom');
  await page.fill('#wsHistoryFrom', '2020-01-01');
  await page.fill('#wsHistoryTo', '2099-12-31');
  await page.click('#wsHistoryCustomApply');
  await page.waitForTimeout(250);
  const customDateFiltered = await page.evaluate(() => ({
    lastCall: window.__fakeHistory.calls[window.__fakeHistory.calls.length - 1],
    count: document.querySelectorAll('#wsHistoryList .history-item').length,
    customVisible: !document.getElementById('wsHistoryCustomRange').hidden
  }));

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(120);
  const smallList = await page.evaluate(() => {
    const bar = document.querySelector('.history-filter-bar');
    return {
      visible: getComputedStyle(document.querySelector('.history-list-pane')).display !== 'none',
      barOverflow: [bar.scrollWidth, bar.clientWidth],
      bodyOverflow: [document.body.scrollWidth, document.body.clientWidth]
    };
  });
  await page.screenshot({ path: path.join(OUT, 'session-history-filtered-1024x700.png') });
  await page.setViewportSize({ width: 1707, height: 960 });
  await page.waitForTimeout(120);

  await page.click('#wsHistoryList .history-item');
  await page.waitForTimeout(180);
  const detail = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    exportButtons: document.querySelectorAll('#wsHistoryDetail [data-history-export]').length
  }));
  await page.evaluate(() => {
    window.pywebview.api.history_export_session = () => ({
      ok: false,
      error: '导出目录不可写'
    });
  });
  await page.click('#wsHistoryDetail [data-history-export="json"]');
  await page.waitForTimeout(120);
  const exportError = await page.evaluate(() => ({
    visible: !document.querySelector('#wsHistoryDetail [data-history-export-status]')?.hidden,
    isError: document.querySelector('#wsHistoryDetail [data-history-export-status]')?.classList.contains('is-error') || false,
    text: document.querySelector('#wsHistoryDetail [data-history-export-status]')?.textContent || ''
  }));

  await page.evaluate(() => window.__fakeHistory.setFail(true));
  await page.click('#wsHistoryReload');
  await page.waitForTimeout(220);
  const refreshError = await page.evaluate(() => ({
    count: document.querySelectorAll('#wsHistoryList .history-item').length,
    summary: document.getElementById('wsHistorySummary').textContent,
    moreHidden: document.getElementById('wsHistoryMore').hidden
  }));
  await page.evaluate(() => window.__fakeHistory.setFail(false));
  await page.click('#wsHistoryReload');
  await page.waitForTimeout(220);

  await page.evaluate(() => window.__fakeHistory.setEmpty());
  await page.click('#wsHistoryReload');
  await page.waitForTimeout(220);
  const empty = await page.evaluate(() => ({
    emptyVisible: !document.getElementById('wsHistoryEmpty').hidden,
    moreHidden: document.getElementById('wsHistoryMore').hidden,
    countHidden: document.getElementById('wsHistoryCount').hidden,
    detailHidden: document.getElementById('wsHistoryDetail').hidden
  }));

  await page.evaluate(() => window.__fakeHistory.setFail(true));
  await page.click('#wsHistoryReload');
  await page.waitForTimeout(220);
  const failed = await page.evaluate(() => ({
    errorVisible: !document.getElementById('wsHistoryError').hidden,
    errorText: document.getElementById('wsHistoryErrorText').textContent,
    summary: document.getElementById('wsHistorySummary').textContent
  }));
  const terminology = await page.evaluate(() => ({
    hasObsProductName: document.documentElement.textContent.includes('OBS浮窗') ||
      document.documentElement.textContent.includes('OBS 浮窗'),
    hasGenericCapture: document.documentElement.textContent.includes('窗口捕获')
  }));
  await page.click('[data-data-tab="live"]');
  await page.waitForTimeout(80);
  const liveStillWorks = await page.evaluate(() =>
    document.getElementById('wsDataReceived').textContent === '7'
  );

  const checks = {
    noErrors: errors.length === 0,
    firstPage: firstPage.count === 30 &&
      firstPage.total === '36' &&
      !firstPage.moreHidden &&
      firstPage.moreText.includes('30 / 共 36') &&
      firstPage.moreRect.top > 0 &&
      firstPage.moreRect.bottom <= firstPage.moreRect.viewport &&
      !firstPage.platformHidden &&
      firstPage.platformOptions.join(',') === ',bilibili,douyin' &&
      firstPage.themeBg === 'rgb(239, 240, 235)' &&
      firstPage.overflow[0] === firstPage.overflow[1],
    loadMore: afterMore.count === 36 &&
      afterMore.moreHidden &&
      afterMore.summary.includes('共 36 场') &&
      afterMore.scrollTop > 0 &&
      afterMore.calls.some((call) => call.beforeId === 'history-30'),
    platformFilter: platformFiltered.count === 1 &&
      platformFiltered.title.includes('抖音演示场') &&
      platformFiltered.meta.includes('dy:demo') &&
      !platformFiltered.meta.includes('房间 0') &&
      platformFiltered.summary.includes('匹配 1 场') &&
      platformFiltered.resetVisible &&
      platformFiltered.lastCall.platform === 'douyin',
    douyinBoundary: douyinBoundary.gift && douyinBoundary.sc &&
      douyinBoundary.note && douyinBoundary.noFakeZero,
    filterSearch: filtered.count === 1 &&
      filtered.title.includes('历史场次 31') &&
      filtered.badge === '36' &&
      filtered.summary.includes('匹配 1 场') &&
      filtered.resetVisible &&
      filtered.lastCall.query === '历史场次 31',
    filterReset: filterReset.count === 30 &&
      filterReset.resetHidden &&
      filterReset.searchValue === '' &&
      filterReset.rangeValue === 'all' &&
      filterReset.platformValue === '',
    filterDate: dateFiltered.lastCall.startedFrom != null &&
      dateFiltered.lastCall.startedTo != null &&
      dateFiltered.summary.includes('匹配'),
    filterCustomDate: customDateFiltered.lastCall.startedFrom != null &&
      customDateFiltered.lastCall.startedTo != null &&
      customDateFiltered.count === 30 &&
      customDateFiltered.customVisible,
    filterSmallLayout: smallList.visible &&
      smallList.barOverflow[0] <= smallList.barOverflow[1] + 1 &&
      smallList.bodyOverflow[0] === smallList.bodyOverflow[1],
    refreshFailure: refreshError.count === 30 &&
      refreshError.summary.includes('刷新失败') &&
      !refreshError.moreHidden,
    detail: detail.title === '历史场次 1' && detail.exportButtons === 2,
    exportError: exportError.visible && exportError.isError && exportError.text.includes('导出目录不可写'),
    empty: empty.emptyVisible && empty.moreHidden && empty.countHidden && empty.detailHidden,
    failure: failed.errorVisible && failed.errorText.includes('模拟历史存储故障') &&
      failed.summary.includes('暂不可用') && liveStillWorks,
    terminology: !terminology.hasObsProductName && terminology.hasGenericCapture
  };

  console.log(JSON.stringify({
    errors, firstPage, afterMore, platformFiltered, filtered, filterReset, dateFiltered,
    detail, exportError, refreshError, customDateFiltered, smallList, empty, failed, liveStillWorks, terminology, checks
  }, null, 2));
  await browser.close();
  if (Object.values(checks).some((value) => !value)) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
