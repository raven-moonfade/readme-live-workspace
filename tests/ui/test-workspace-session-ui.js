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
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.addInitScript(({ projectRoot }) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const fixtureNow = Date.now();
    const session = {
      id: 'real-session-1',
      started_at: (fixtureNow - 180000) / 1000,
      stats: { received: 7, spoken: 4, dropped: 1 },
      real: { received: 2, spoken: 1, dropped: 0 },
      mock: { received: 5, spoken: 3, dropped: 1 },
    };
    const state = {
      connection: 'connected',
      room_id: 888666,
      room_title: '真实会话测试直播间',
      stats: { received: 99, spoken: 80, dropped: 19 },
      session,
      mock: { running: false, sent: 5 },
      queue_len: 1,
      now_playing: { user: '测试主播', text: '正在朗读', id: 'now-1' },
      account: { logged_in: false, uname: null, mid: null },
      history: { available: true, error: null },
      last_error: null,
      config: {
        room_id: 888666,
        tts: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%' },
        read: {
          danmaku: true, gift: true, super_chat: true, guard: true, enter: false,
          gift_min_price: 0, include_user: true,
          templates: {
            danmaku: '{user}说：{text}', gift: '感谢{user}送出的{gift_name}乘以{num}',
            super_chat: '{user}的醒目留言：{message}', guard: '感谢{user}开通{guard_name}',
            enter: '{user}进入直播间'
          }
        },
        filters: { blacklist: [], dedup_seconds: 5, max_len: 80, user_cooldown: 3, global_cooldown: 0.5 },
        queue: { max_size: 30 },
        mock: { interval_ms: 1500, per_tick: 1, speak: false, types: { danmaku: true, gift: true, super_chat: true, guard: true, enter: true } },
        overlay: {
          enabled: false, x: 60, y: 120, width: 520, height: 620, scale: 1,
          click_through: true, always_on_top: true, opacity: 1,
          types: { danmaku: true, gift: true, super_chat: true, guard: true, enter: true }
        }
      }
    };
    let seq = 0;
    let previousMode = 'found';
    const events = [];
    const exportCalls = [];
    const pruneCalls = { preview: 0, prune: 0 };
    let autoSettings = { auto_prune_enabled: false, auto_prune_days: 90 };
    const appearance = {
      schema_version: 1, preset: 'broadcast', custom: false, theme_mode: 'dark',
      accent: '#FF5F3A', pattern: { type: 'none', spacing_px: 24, dot_size_px: 1.5 },
      radius: { enabled: false, value_px: 12 }, font: 'broadcast'
    };
    const historySessions = [{
      id: 'history-1',
      platform: 'bilibili',
      room_id: 888666,
      room_title: '历史夜航电台',
      started_at: (fixtureNow - 7200000) / 1000,
      ended_at: (fixtureNow - 3600000) / 1000,
      end_reason: 'manual_disconnect',
      last_event_at: (fixtureNow - 3650000) / 1000,
      real_received: 120,
      real_spoken: 100,
      real_dropped: 20,
      mock_received: 5,
      mock_spoken: 3,
      mock_dropped: 1,
      unique_users: 42,
      gift_cny: 12.3,
      gift_silver: 100,
      gift_unknown: 0,
      super_chat_cny: 50
    }, {
      id: 'history-2',
      platform: 'bilibili',
      room_id: 888666,
      room_title: '更早的夜航电台',
      started_at: (fixtureNow - 14400000) / 1000,
      ended_at: (fixtureNow - 10800000) / 1000,
      end_reason: 'manual_disconnect',
      last_event_at: (fixtureNow - 10900000) / 1000,
      real_received: 80,
      real_spoken: 60,
      real_dropped: 20,
      mock_received: 0,
      mock_spoken: 0,
      mock_dropped: 0,
      unique_users: 30,
      gift_cny: 8,
      gift_silver: 40,
      gift_unknown: 0,
      super_chat_cny: 20
    }];
    const historyDetail = {
      ...historySessions[0],
      types: { danmaku: 100, gift: 10, super_chat: 2, guard: 3, enter: 5 },
      minutes: [
        { minute: Math.floor((fixtureNow - 7000000) / 60000), count: 12 },
        { minute: Math.floor((fixtureNow - 6000000) / 60000), count: 30 },
        { minute: Math.floor((fixtureNow - 5000000) / 60000), count: 48 },
        { minute: Math.floor((fixtureNow - 4000000) / 60000), count: 30 }
      ]
    };
    const previousDetail = {
      ...historyDetail,
      id: 'history-0',
      room_title: '上一场夜航电台',
      started_at: (fixtureNow - 10800000) / 1000,
      ended_at: (fixtureNow - 9000000) / 1000,
      last_event_at: (fixtureNow - 9100000) / 1000,
      real_received: 80,
      real_spoken: 60,
      real_dropped: 20,
      mock_received: 0,
      unique_users: 30,
      gift_cny: 8,
      gift_silver: 40,
      super_chat_cny: 20,
      types: { danmaku: 60, gift: 8, super_chat: 2, guard: 5, enter: 5 },
      minutes: [
        { minute: Math.floor((fixtureNow - 10700000) / 60000), count: 80 }
      ]
    };

    function bump(scope, key) {
      state.stats[key] = (state.stats[key] || 0) + 1;
      session.stats[key] = (session.stats[key] || 0) + 1;
      session[scope][key] = (session[scope][key] || 0) + 1;
    }

    window.__fakeBackend = {
      state,
      exportCalls,
      pruneCalls,
      setLongHistoryTitle() {
        historyDetail.room_title = 'LONG-TITLE-'.repeat(24);
        historySessions[0].room_title = historyDetail.room_title;
      },
      setPreviousMode(mode) {
        previousMode = mode;
      },
      push(payload) {
        seq += 1;
        const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
        const scope = meta.mock ? 'mock' : 'real';
        const event = {
          seq,
          id: 'fake-' + seq,
          ts: Date.now() / 1000,
          type: payload.type || 'danmaku',
          user: payload.user || '',
          uid: payload.uid || 0,
          text: payload.text || '',
          spoken: payload.spoken !== false,
          meta,
          error: null,
        };
        events.push(event);
        if (events.length > 200) events.shift();
        bump(scope, 'received');
        if (event.spoken) bump(scope, 'spoken');
        return clone(event);
      },
    };

    const api = {
      get_state: () => clone(state),
      poll_events: (cursor) => {
        const c = Number(cursor) || 0;
        const next = events.filter((event) => event.seq > c);
        return { cursor: next.length ? next[next.length - 1].seq : c, events: clone(next) };
      },
      list_voices: () => [
        { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', locale: 'zh-CN', gender: 'Female' },
      ],
      get_appearance: () => ({ ok: true, appearance: clone(appearance), read_only: false, migration: {} }),
      set_appearance: (value) => ({ ok: true, appearance: clone(value), rejected: [] }),
      get_overlay_config: () => ({ enabled: false, width: 520, height: 620 }),
      get_config_v2: () => ({ monitor: { font_px: null }, overlay: {} }),
      monitor_visible: () => ({ visible: false }),
      toggle_monitor: () => ({ ok: true, visible: true }),
      set_overlay_visible: (visible) => {
        state.config.overlay.enabled = !!visible;
        return { ok: true, visible: !!visible };
      },
      mock_status: () => ({ running: false, sent: 5 }),
      history_status: () => ({ ok: true, available: true, gap_events: 0 }),
      history_list_sessions: () => ({
        ok: true,
        sessions: clone(historySessions),
        total: historySessions.length,
        all_total: historySessions.length,
        has_more: false,
        next_cursor: null,
        gap_events: 0
      }),
      history_get_session: (sessionId) => sessionId === 'history-1'
        ? { ok: true, session: clone(historyDetail) }
        : { ok: false, error: '场次不存在', session: null },
      history_get_previous_session: (sessionId) => {
        if (sessionId !== 'history-1') {
          return { ok: false, status: 'target_not_found', error: '场次不存在', target: null, previous: null, has_previous: false };
        }
        if (previousMode === 'empty') {
          return { ok: true, status: 'no_previous', target: clone(historyDetail), previous: null, has_previous: false };
        }
        if (previousMode === 'error') {
          return { ok: false, status: 'ambiguous_tie', error: '同开播时间无法确定基准', target: clone(historyDetail), previous: null, has_previous: false };
        }
        return {
          ok: true,
          status: 'found',
          target: clone(historyDetail),
          previous: clone(previousDetail),
          has_previous: true
        };
      },
      history_prune_preview: () => {
        pruneCalls.preview += 1;
        return {
          ok: true,
          dry_run: true,
          total: 2,
          protected: 1,
          matched: 1,
          deleted: 0,
          cutoff_ts: (Date.now() - 90 * 86400000) / 1000,
          oldest_candidate: (Date.now() - 10800000) / 1000,
          newest_candidate: (Date.now() - 10800000) / 1000,
          backup_path: null
        };
      },
      history_prune: () => {
        pruneCalls.prune += 1;
        const olderIndex = historySessions.findIndex((session) => session.id === 'history-2');
        if (olderIndex >= 0) historySessions.splice(olderIndex, 1);
        return {
          ok: true,
          dry_run: false,
          total: 2,
          protected: 1,
          matched: 1,
          deleted: 1,
          backup_path: projectRoot + '/data/backups/history-before-prune-test.sqlite3'
        };
      },
      history_settings: () => ({ ok: true, available: true, settings: clone(autoSettings) }),
      history_update_settings: (patch) => {
        autoSettings = { ...autoSettings, ...(patch || {}) };
        return { ok: true, available: true, settings: clone(autoSettings) };
      },
      history_export_session: (sessionId, format) => {
        exportCalls.push({ sessionId, format });
        return {
          ok: true,
          format,
          path: projectRoot + '/exports/history/mutai-session-' + format,
          size: 512
        };
      },
      history_delete_session: () => {
        historySessions.length = 0;
        return { ok: true };
      },
      preview: () => ({ ok: true }),
    };
    window.pywebview = { api };
  }, { projectRoot: MOCK_PROJECT_ROOT });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__fakeBackend.push({
      type: 'gift',
      user: '真实礼物用户',
      uid: 501,
      text: '送出 测试礼物',
      spoken: true,
      meta: { gift_name: '测试礼物', num: 1, price: 1000, total_coin: 1000, coin_type: 'gold' }
    });
    window.__fakeBackend.push({
      type: 'danmaku',
      user: '模拟注入用户',
      uid: 502,
      text: '这条是模拟事件',
      spoken: false,
      meta: { mock: true }
    });
  });
  await page.waitForTimeout(700);
  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(250);
  await page.waitForFunction(() =>
    document.getElementById('wsDataReceived').textContent === '3', null, { timeout: 3000 });
  const data = await page.evaluate(() => ({
    received: document.getElementById('wsDataReceived').textContent,
    mode: document.getElementById('wsDataMode').textContent,
    giftValue: document.getElementById('wsDataGiftValue').textContent,
    realDanmaku: window.__MUTAI_SHELL__.state.session.real.counts.danmaku,
    realGift: window.__MUTAI_SHELL__.state.session.real.counts.gift,
    mockDanmaku: window.__MUTAI_SHELL__.state.session.mock.counts.danmaku,
    realHasMockUser: window.__MUTAI_SHELL__.state.session.real.users.has('502'),
    mockHasMockUser: window.__MUTAI_SHELL__.state.session.mock.users.has('502'),
  }));
  await page.screenshot({ path: path.join(OUT, 'session-real-data-1280x820.png') });

  await page.evaluate(() => {
    window.__fakeBackend.push({
      type: 'danmaku',
      user: '长消息用户',
      uid: 503,
      text: '这是一条在数据页停留期间通过正常事件管线到达的长消息。'.repeat(20),
      spoken: true,
      meta: {}
    });
  });
  await page.waitForTimeout(700);
  await page.click('[data-workspace-view="danmaku"]');
  await page.waitForTimeout(250);
  const clamp = await page.evaluate(() => ({
    clamped: document.querySelectorAll('#streamList .item.is-clamped').length,
    expand: document.querySelectorAll('#streamList .item-expand').length,
    pending: document.querySelectorAll('#streamList .item[data-long]').length,
  }));

  await page.evaluate(() => {
    window.__fakeBackend.push({
      type: 'enter',
      user: '入场用户',
      uid: 504,
      text: '',
      spoken: true,
      meta: {}
    });
  });
  await page.waitForTimeout(800);
  const enterItem = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#streamList .item[data-type="enter"]')];
    const item = items[items.length - 1];
    return item ? {
      text: item.querySelector('.item-line')?.textContent.trim(),
      separators: item.querySelectorAll('.item-sep').length,
      user: item.querySelector('.item-user')?.textContent.trim()
    } : null;
  });

  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(120);
  await page.click('[data-data-tab="history"]');
  await page.waitForTimeout(250);
  const history = await page.evaluate(() => ({
    listCount: document.querySelectorAll('#wsHistoryList .history-item').length,
    countBadge: document.getElementById('wsHistoryCount').textContent,
    summary: document.getElementById('wsHistorySummary').textContent,
    error: !document.getElementById('wsHistoryError').hidden,
  }));
  await page.click('#wsHistoryManage');
  await page.waitForTimeout(180);
  const manageOpen = await page.evaluate(() => ({
    hidden: document.getElementById('historyManageModal').hidden,
    appInert: document.querySelector('.app').hasAttribute('inert'),
    focusClose: document.activeElement?.id === 'wsHistoryManageClose',
    facts: document.getElementById('wsHistoryManageFacts').textContent,
    preview: document.getElementById('wsHistoryPrunePreview').textContent,
    pruneDisabled: document.getElementById('wsHistoryPruneBtn').disabled,
    autoStatus: document.getElementById('wsHistoryAutoStatus').textContent,
    autoChecked: document.getElementById('wsHistoryAutoToggle').getAttribute('aria-checked'),
    autoDays: document.getElementById('wsHistoryAutoDays').value,
    calls: { ...window.__fakeBackend.pruneCalls }
  }));
  await page.screenshot({ path: path.join(OUT, 'session-history-manage-1280x820.png') });
  await page.click('#wsHistoryAutoToggle');
  await page.selectOption('#wsHistoryAutoDays', '30');
  await page.click('#wsHistoryAutoSave');
  await page.waitForTimeout(160);
  const manageAuto = await page.evaluate(() => ({
    status: document.getElementById('wsHistoryAutoStatus').textContent,
    checked: document.getElementById('wsHistoryAutoToggle').getAttribute('aria-checked'),
    days: document.getElementById('wsHistoryAutoDays').value
  }));
  await page.fill('#wsHistoryPruneConfirm', '清理');
  const pruneEnabled = await page.evaluate(() =>
    !document.getElementById('wsHistoryPruneBtn').disabled
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#wsHistoryPruneBtn');
  await page.waitForTimeout(250);
  const manageAfter = await page.evaluate(() => ({
    status: document.getElementById('wsHistoryPrunePreview').textContent,
    confirmValue: document.getElementById('wsHistoryPruneConfirm').value,
    pruneDisabled: document.getElementById('wsHistoryPruneBtn').disabled,
    calls: { ...window.__fakeBackend.pruneCalls }
  }));
  await page.click('#wsHistoryManageClose');
  await page.waitForTimeout(100);
  const manageClosed = await page.evaluate(() => ({
    hidden: document.getElementById('historyManageModal').hidden,
    appInert: document.querySelector('.app').hasAttribute('inert'),
    focusManage: document.activeElement?.id === 'wsHistoryManage'
  }));
  await page.click('#wsHistoryList .history-item');
  await page.waitForTimeout(180);
  const historyDetailView = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    metrics: [...document.querySelectorAll('#wsHistoryDetail .history-detail-metrics b')].map((n) => n.textContent),
    typeRows: document.querySelectorAll('#wsHistoryDetail .type-bar-row').length,
    activityBars: document.querySelectorAll('#wsHistoryDetail .activity-bar').length,
    quality: [...document.querySelectorAll('#wsHistoryDetail .history-quality-grid b')].map((n) => n.textContent),
    exportButtons: [...document.querySelectorAll('#wsHistoryDetail [data-history-export]')].map((n) => n.textContent),
    deleteButton: !!document.querySelector('#wsHistoryDetail [data-history-delete]'),
  }));
  await page.screenshot({ path: path.join(OUT, 'session-history-detail-1280x820.png') });
  await page.click('#wsHistoryDetail [data-history-compare]');
  await page.waitForTimeout(220);
  const compareView = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail [data-history-focus]')?.textContent,
    contexts: [...document.querySelectorAll('.history-compare-session b')].map((node) => node.textContent),
    metricRows: document.querySelectorAll('.history-compare-section')[0]?.querySelectorAll('tbody tr').length || 0,
    typeRows: document.querySelectorAll('.history-compare-section')[1]?.querySelectorAll('tbody tr').length || 0,
    metricCells: [...document.querySelectorAll('.history-compare-section')[0].querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) => cell.textContent.trim())
    ),
    typeCells: [...document.querySelectorAll('.history-compare-section')[1].querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) => cell.textContent.trim())
    ),
    flags: [...document.querySelectorAll('.history-compare-flags span')].map((node) => node.textContent),
    exportButtons: document.querySelectorAll('#wsHistoryDetail [data-history-export]').length,
    deleteButton: !!document.querySelector('#wsHistoryDetail [data-history-delete]'),
    focus: document.activeElement?.hasAttribute('data-history-focus') || false
  }));
  await page.screenshot({ path: path.join(OUT, 'session-history-compare-1280x820.png') });
  await page.click('#wsHistoryDetail [data-history-compare-back]');
  await page.waitForTimeout(160);
  const compareBack = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    exportButtons: document.querySelectorAll('#wsHistoryDetail [data-history-export]').length,
    deleteButton: !!document.querySelector('#wsHistoryDetail [data-history-delete]'),
    focusCompare: !!document.activeElement?.hasAttribute('data-history-compare')
  }));
  await page.setViewportSize({ width: 1707, height: 960 });
  await page.click('#wsHistoryDetail [data-history-compare]');
  await page.waitForTimeout(220);
  const wideCompare = await page.evaluate(() => {
    const pane = document.querySelector('.history-detail-pane');
    return {
      columns: getComputedStyle(document.querySelector('.history-compare-grid')).gridTemplateColumns.split(' ').length,
      overflow: [pane.scrollWidth, pane.clientWidth]
    };
  });
  await page.screenshot({ path: path.join(OUT, 'session-history-compare-1707x960.png') });
  await page.click('#wsHistoryDetail [data-history-compare-back]');
  await page.waitForTimeout(160);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__fakeBackend.setPreviousMode('empty'));
  await page.click('#wsHistoryDetail [data-history-compare]');
  await page.waitForTimeout(120);
  const compareEmpty = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    status: document.querySelector('#wsHistoryDetail [data-history-compare-status]')?.textContent,
    compareButton: document.querySelector('#wsHistoryDetail [data-history-compare]')?.textContent
  }));
  await page.evaluate(() => window.__fakeBackend.setPreviousMode('error'));
  await page.click('#wsHistoryDetail [data-history-compare]');
  await page.waitForTimeout(120);
  const compareError = await page.evaluate(() => ({
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    status: document.querySelector('#wsHistoryDetail [data-history-compare-status]')?.textContent,
    role: document.querySelector('#wsHistoryDetail [data-history-compare-status]')?.getAttribute('role')
  }));
  await page.evaluate(() => window.__fakeBackend.setPreviousMode('found'));
  await page.click('#wsHistoryDetail [data-history-export="json"]');
  await page.waitForTimeout(120);
  const jsonExport = await page.evaluate(() => ({
    text: document.querySelector('#wsHistoryDetail [data-history-export-status]')?.textContent || '',
    error: document.querySelector('#wsHistoryDetail [data-history-export-status]')?.classList.contains('is-error') || false,
  }));
  await page.click('#wsHistoryDetail [data-history-export="csv"]');
  await page.waitForTimeout(120);
  const csvExport = await page.evaluate(() => ({
    text: document.querySelector('#wsHistoryDetail [data-history-export-status]')?.textContent || '',
    error: document.querySelector('#wsHistoryDetail [data-history-export-status]')?.classList.contains('is-error') || false,
    calls: window.__fakeBackend.exportCalls.slice(),
  }));
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#wsHistoryDetail [data-history-delete]');
  await page.waitForTimeout(300);
  const historyAfterDelete = await page.evaluate(() => ({
    listCount: document.querySelectorAll('#wsHistoryList .history-item').length,
    emptyVisible: !document.getElementById('wsHistoryEmpty').hidden,
  }));

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(120);
  await page.click('[data-data-tab="history"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__fakeBackend.setLongHistoryTitle());
  await page.click('#wsHistoryList .history-item');
  await page.waitForTimeout(250);
  const smallHistory = await page.evaluate(() => ({
    listVisible: getComputedStyle(document.querySelector('.history-list-pane')).display !== 'none',
    detailVisible: getComputedStyle(document.querySelector('.history-detail-pane')).display !== 'none',
    backVisible: getComputedStyle(document.querySelector('[data-history-back]')).display !== 'none',
    focusOnTitle: document.activeElement?.hasAttribute('data-history-focus') || false,
    detailOverflow: (() => {
      const pane = document.querySelector('.history-detail-pane');
      return [pane.scrollWidth, pane.clientWidth];
    })(),
    overflow: [document.body.scrollWidth, document.body.clientWidth],
  }));
  await page.screenshot({ path: path.join(OUT, 'session-history-detail-1024x700.png') });
  await page.click('#wsHistoryDetail [data-history-compare]');
  await page.waitForTimeout(220);
  const smallCompare = await page.evaluate(() => {
    const pane = document.querySelector('.history-detail-pane');
    return {
      title: document.querySelector('#wsHistoryDetail [data-history-focus]')?.textContent,
      contexts: document.querySelectorAll('.history-compare-session').length,
      exportButtons: document.querySelectorAll('#wsHistoryDetail [data-history-export]').length,
      overflow: [pane.scrollWidth, pane.clientWidth]
    };
  });
  await page.screenshot({ path: path.join(OUT, 'session-history-compare-1024x700.png') });
  await page.click('#wsHistoryDetail [data-history-compare-back]');
  await page.waitForTimeout(160);
  await page.click('#wsHistoryDetail [data-history-export="json"]');
  await page.waitForTimeout(140);
  const smallExport = await page.evaluate(() => {
    const pane = document.querySelector('.history-detail-pane').getBoundingClientRect();
    const status = document.querySelector('[data-history-export-status]').getBoundingClientRect();
    return {
      visible: status.height > 0 && status.top >= pane.top && status.bottom <= pane.bottom,
      text: document.querySelector('[data-history-export-status]').textContent
    };
  });
  await page.screenshot({ path: path.join(OUT, 'session-history-detail-1024-export.png') });
  await page.click('[data-history-back]');
  await page.waitForTimeout(160);
  const smallHistoryBack = await page.evaluate(() => ({
    listVisible: getComputedStyle(document.querySelector('.history-list-pane')).display !== 'none',
    detailVisible: getComputedStyle(document.querySelector('.history-detail-pane')).display !== 'none',
    focusOnItem: !!document.activeElement?.getAttribute('data-history-id')
  }));
  await page.click('#wsHistoryList .history-item');
  await page.waitForTimeout(220);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1100);
  const historyRestoredContext = await page.evaluate(() => ({
    view: window.__MUTAI_SHELL__.state.view,
    tab: window.__MUTAI_SHELL__.state.dataTab,
    selected: window.__MUTAI_SHELL__.state.historySelectedId,
    detailVisible: !document.getElementById('wsHistoryDetail').hidden,
    title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent,
    focusStolen: document.activeElement?.hasAttribute('data-history-focus') || false,
  }));
  await page.focus('#wsDataTabHistory');
  const tabBefore = await page.evaluate(() => ({
    historySelected: document.getElementById('wsDataTabHistory').getAttribute('aria-selected'),
    historyTabIndex: document.getElementById('wsDataTabHistory').tabIndex,
    liveTabIndex: document.getElementById('wsDataTabLive').tabIndex,
  }));
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(80);
  const tabAfter = await page.evaluate(() => ({
    liveSelected: document.getElementById('wsDataTabLive').getAttribute('aria-selected'),
    historyTabIndex: document.getElementById('wsDataTabHistory').tabIndex,
  }));

  const checks = {
    noErrors: errors.length === 0,
    sessionNotLifetime: data.received === '3',
    mockIsolated: data.realDanmaku === 0 &&
      data.realGift === 1 &&
      data.mockDanmaku === 1 &&
      !data.realHasMockUser &&
      data.mockHasMockUser,
    mockNotice: data.mode.includes('已隔离模拟'),
    goldCoinCorrect: data.giftValue.includes('¥1.00'),
    hiddenPipelineClamp: clamp.clamped > 0 && clamp.expand > 0 && clamp.pending === 0,
    enterText: enterItem && enterItem.text === '入场用户进入直播间' && enterItem.separators === 0,
    historyUi: history.listCount === 2 && history.countBadge === '2' && !history.error &&
      historyDetailView.title === '历史夜航电台' &&
      historyDetailView.metrics.join(',') === '120,100,20,42' &&
      historyDetailView.typeRows === 8 &&
      historyDetailView.activityBars > 0 &&
      historyDetailView.exportButtons.join(',') === '导出 JSON,导出 CSV' &&
      historyDetailView.deleteButton,
    historyManage: !manageOpen.hidden &&
      manageOpen.appInert &&
      manageOpen.focusClose &&
      manageOpen.facts.includes('已结束历史') &&
      manageOpen.preview.includes('将清理 1 场') &&
      manageOpen.pruneDisabled &&
      manageOpen.autoStatus.includes('已关闭') &&
      manageOpen.autoChecked === 'false' &&
      manageOpen.autoDays === '90' &&
      manageOpen.calls.preview === 1 &&
      manageAuto.status.includes('设置已保存') &&
      manageAuto.checked === 'true' &&
      manageAuto.days === '30' &&
      pruneEnabled &&
      manageAfter.status.includes('已清理 1 场') &&
      manageAfter.status.includes('history-before-prune-test.sqlite3') &&
      manageAfter.confirmValue === '' &&
      manageAfter.pruneDisabled &&
      manageAfter.calls.prune === 1 &&
      manageClosed.hidden &&
      !manageClosed.appInert &&
      manageClosed.focusManage,
    historyCompare: compareView.title === '场次对比' &&
      compareView.contexts.join(',') === '历史夜航电台,上一场夜航电台' &&
      compareView.metricRows >= 10 &&
      compareView.typeRows === 8 &&
      compareView.metricCells[0].join('|') === '时长|01:00:00|00:30:00|' &&
      compareView.metricCells[1].join('|') === '收到|120|80|+40 条' &&
      compareView.metricCells[4].join('|') === '收到 / 小时|120.0|160.0|-40.0/时' &&
      compareView.typeCells[0].join('|') === '弹幕|83.3%|75.0%|+8.3pp' &&
      compareView.flags.some((flag) => flag.includes('模拟已排除 5 条')) &&
      compareView.exportButtons === 0 &&
      !compareView.deleteButton &&
      compareView.focus &&
      compareBack.title === '历史夜航电台' &&
      compareBack.exportButtons === 2 &&
      compareBack.deleteButton &&
      compareBack.focusCompare &&
      wideCompare.columns >= 2 &&
      wideCompare.overflow[0] <= wideCompare.overflow[1] + 1 &&
      compareEmpty.title === '历史夜航电台' &&
      compareEmpty.status.includes('没有更早') &&
      compareEmpty.compareButton === '对比上一场' &&
      compareError.title === '历史夜航电台' &&
      compareError.status.includes('无法确定基准') &&
      compareError.role === 'alert',
    historyExport: !jsonExport.error && jsonExport.text.includes('已导出 JSON') &&
      !csvExport.error && csvExport.text.includes('已导出 CSV') &&
      csvExport.calls.length === 2 &&
      csvExport.calls[0].format === 'json' &&
      csvExport.calls[1].format === 'csv',
    historyDelete: historyAfterDelete.listCount === 0 && historyAfterDelete.emptyVisible,
    historySmallFlow: !smallHistory.listVisible && smallHistory.detailVisible &&
      smallHistory.backVisible &&
      smallHistory.focusOnTitle &&
      smallHistory.detailOverflow[0] <= smallHistory.detailOverflow[1] + 1 &&
      smallHistory.overflow[0] === smallHistory.overflow[1] &&
      smallCompare.title === '场次对比' &&
      smallCompare.contexts === 2 &&
      smallCompare.exportButtons === 0 &&
      smallCompare.overflow[0] <= smallCompare.overflow[1] + 1 &&
      smallExport.visible && smallExport.text.includes('已导出 JSON') &&
      smallHistoryBack.listVisible && !smallHistoryBack.detailVisible &&
      smallHistoryBack.focusOnItem,
    historyRestoredContext: historyRestoredContext.view === 'data' &&
      historyRestoredContext.tab === 'history' &&
      historyRestoredContext.selected === 'history-1' &&
      historyRestoredContext.detailVisible &&
      historyRestoredContext.title === '历史夜航电台' &&
      !historyRestoredContext.focusStolen,
    tabKeyboard: tabBefore.historySelected === 'true' &&
      tabBefore.historyTabIndex === 0 && tabBefore.liveTabIndex === -1 &&
      tabAfter.liveSelected === 'true' && tabAfter.historyTabIndex === -1,
  };
  console.log(JSON.stringify({
    errors, data, clamp, enterItem, history, manageOpen, manageAuto, pruneEnabled, manageAfter, manageClosed,
    historyDetailView, compareView, compareBack, wideCompare, compareEmpty, compareError,
    jsonExport, csvExport, historyAfterDelete,
    smallHistory, smallCompare, smallExport, smallHistoryBack, historyRestoredContext, tabBefore, tabAfter, checks
  }, null, 2));
  await browser.close();
  if (Object.values(checks).some((value) => !value)) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
