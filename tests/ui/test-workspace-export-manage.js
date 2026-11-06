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

  await page.addInitScript(({ projectRoot }) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const now = Date.now() / 1000;
    const calls = [];
    const mode = { stale: false };
    const state = {
      connection: 'connected',
      room_id: 100,
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
          insights: 1,
          analysis_export: 1,
          export_manage: 1,
          export_manage_week: 1
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
    const weeks = [
      { key: '2026-W45', label: '2026-W45 · 2026-11-02 ~ 2026-11-08', app_files: 3, app_bytes: 240000 },
      { key: '2026-W44', label: '2026-W44 · 2026-10-26 ~ 2026-11-01', app_files: 2, app_bytes: 120000 }
    ];
    const status = (after, week) => ({
      ok: true,
      available: true,
      directory: projectRoot + '/exports/history',
      exists: true,
      scan_truncated: false,
      files: after ? 10 : 12,
      bytes: after ? 640000 : 920000,
      app_files: after ? 8 : 10,
      app_bytes: after ? 500000 : 780000,
      unknown_files: 2,
      unknown_bytes: 140000,
      subdirs: 1,
      symlinks: 0,
      protected_files: 0,
      temp_files: after ? 0 : 2,
      temp_bytes: after ? 0 : 8000,
      stale_temp_files: after ? 0 : 1,
      stale_temp_bytes: after ? 0 : 4000,
      oldest_mtime: now - 180 * 86400,
      newest_mtime: now - 3600,
      app_oldest_mtime: now - 180 * 86400,
      app_newest_mtime: now - 3600,
      week: week || null,
      week_label: week ? (weeks.find((item) => item.key === week) || {}).label : '全部时间',
      weeks
    });

    function preview(week) {
      return {
        ok: true,
        available: true,
        preview_id: 'preview-1',
        expires_at: now + 300,
        policy: { days: 90, keep_latest: 50, week: week || null },
        week: week || null,
        week_label: week ? (weeks.find((item) => item.key === week) || {}).label : '全部时间',
        totals: {
          app_count: 1,
          app_bytes: 120000,
          temp_count: 1,
          temp_bytes: 4000,
          total_count: 2,
          total_bytes: 124000,
          oldest_mtime: now - 180 * 86400,
          newest_mtime: now - 100 * 86400
        },
        protected: {
          recent_keep_latest: 9,
          not_expired: 1,
          unsafe: 0,
          unknown_files: 2,
          subdirs: 1,
          symlinks: 0,
          temp_alive_or_fresh: 1
        },
        sample: [
          { name: 'mutai-report-old.json', bytes: 120000, mtime: now - 180 * 86400, kind: 'app' },
          { name: 'mutai-report-old.json.tmp-999999-1', bytes: 4000, mtime: now - 100 * 86400, kind: 'temp' }
        ],
        sample_truncated: false,
        warnings: ['存在未被识别的文件，不会删除']
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
          insights: 1,
          analysis_export: 1,
          export_manage: 1,
          export_manage_week: 1
        }
      }),
      history_list_sessions: () => ({
        ok: true,
        sessions: [],
        total: 0,
        all_total: 0,
        platforms: [],
        has_more: false,
        next_cursor: null
      }),
      history_export_storage_status: (week = null) => {
        calls.push({ type: 'status', week });
        return status(false, week);
      },
      history_export_storage_preview: (days, keepLatest, week = null) => {
        calls.push({ type: 'preview', days, keepLatest, week });
        return preview(week);
      },
      history_export_storage_prune: (previewId, days, keepLatest, week = null) => {
        calls.push({ type: 'prune', previewId, days, keepLatest, week });
        if (mode.stale) {
          return { ok: false, available: true, error_code: 'stale_preview', error: '文件已变化，请重新预览' };
        }
        return {
          ok: true,
          available: true,
          deleted_count: 2,
          deleted_bytes: 124000,
          failed_count: 0,
          failed: [],
          failed_truncated: false,
          skipped: {},
          partial: false,
          status: status(true)
        };
      },
      history_export_storage_open_dir: () => {
        calls.push({ type: 'open' });
        return { ok: true, available: true, directory: projectRoot + '/exports/history' };
      },
      preview: () => ({ ok: true })
    };
    window.__fakeExportManage = {
      calls,
      mode,
      setStale(value) { mode.stale = Boolean(value); }
    };
    window.pywebview = { api };
  }, { projectRoot: MOCK_PROJECT_ROOT });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  await page.click('[data-workspace-view="settings"]');
  await page.waitForTimeout(180);
  await page.click('.settings-tab[data-settings-pane="privacy"]');
  await page.waitForTimeout(120);

  const entry = await page.evaluate(() => ({
    hidden: document.getElementById('wsExportManageBtn')?.hidden,
    text: document.getElementById('wsExportManageBtn')?.textContent
  }));
  check(entry.hidden === false && entry.text === '管理导出文件',
    '设置页显示导出文件入口', entry);

  await page.click('#wsExportManageBtn');
  await page.waitForTimeout(350);
  const opened = await page.evaluate(() => ({
    hidden: document.getElementById('exportManageModal')?.hidden,
    closeFocused: document.activeElement === document.getElementById('wsExportManageClose'),
    text: document.getElementById('exportManageModal')?.textContent || '',
    stats: document.querySelectorAll('#wsExportStats .export-manage-stat').length,
    samples: document.querySelectorAll('.export-manage-sample').length,
    path: document.getElementById('wsExportManageDirectory')?.textContent,
    confirmDisabled: document.getElementById('wsExportPruneBtn')?.disabled
  }));
  check(opened.hidden === false && opened.closeFocused, '打开导出管理并聚焦关闭按钮', opened);
  check(opened.stats === 9 && opened.text.includes('12') && opened.text.includes('898.4 KB'),
    '导出统计渲染', opened);
  check(opened.path.includes('exports/history') && opened.samples === 2 &&
      opened.text.includes('将删除 2 个文件') && opened.confirmDisabled,
    '导出预览与目录渲染', opened);
  await page.screenshot({ path: path.join(OUT, 'export-manage-1280x820.png') });

  await page.selectOption('#wsExportWeek', '2026-W45');
  await page.waitForTimeout(280);
  const weekly = await page.evaluate(() => ({
    value: document.getElementById('wsExportWeek')?.value,
    options: document.querySelectorAll('#wsExportWeek option').length,
    text: document.getElementById('wsExportPreview')?.textContent,
    calls: window.__fakeExportManage.calls
  }));
  check(weekly.value === '2026-W45' && weekly.options === 3,
    '导出管理显示全部时间与自然周选项', weekly);
  check(weekly.calls.some((item) => item.type === 'status' && item.week === '2026-W45') &&
      weekly.calls.some((item) => item.type === 'preview' && item.week === '2026-W45') &&
      weekly.text.includes('2026-W45'),
    '切换自然周重载统计并生成周内预览', weekly);

  await page.selectOption('#wsExportWeek', '');
  await page.waitForTimeout(220);

  await page.selectOption('#wsExportKeepDays', '30');
  await page.waitForTimeout(80);
  const changed = await page.evaluate(() => ({
    text: document.getElementById('wsExportPreview')?.textContent,
    samples: document.querySelectorAll('.export-manage-sample').length,
    disabled: document.getElementById('wsExportPruneBtn')?.disabled
  }));
  check(changed.text.includes('请重新预览') && changed.samples === 0 && changed.disabled,
    '修改策略会清空旧预览', changed);

  await page.click('#wsExportPreviewBtn');
  await page.waitForTimeout(180);
  await page.fill('#wsExportPruneConfirm', '删除导出');
  const ready = await page.evaluate(() => ({
    disabled: document.getElementById('wsExportPruneBtn')?.disabled,
    calls: window.__fakeExportManage.calls
  }));
  check(ready.disabled === false, '确认词启用删除按钮');
  check(ready.calls.some((item) => item.type === 'preview' && item.days === 30),
    '预览使用当前策略', ready.calls);

  await page.click('#wsExportPruneBtn');
  await page.waitForTimeout(220);
  const pruned = await page.evaluate(() => ({
    hidden: document.getElementById('exportManageModal')?.hidden,
    text: document.getElementById('wsExportPreview')?.textContent,
    statText: document.getElementById('wsExportStats')?.textContent,
    calls: window.__fakeExportManage.calls
  }));
  check(pruned.hidden === false, '删除后保持 modal 打开');
  check(pruned.text.includes('已删除 2 个文件') && pruned.text.includes('121.1 KB'),
    '删除结果展示数量与空间', pruned.text);
  check(pruned.statText.includes('10') && pruned.statText.includes('625.0 KB'),
    '删除后刷新统计', pruned.statText);
  check(pruned.calls.some((item) => item.type === 'prune' &&
    item.previewId === 'preview-1' && item.days === 30 && item.keepLatest === 50),
    '删除使用预览令牌与策略', pruned.calls);

  await page.evaluate(() => window.__fakeExportManage.setStale(true));
  await page.click('#wsExportPreviewBtn');
  await page.waitForTimeout(160);
  await page.fill('#wsExportPruneConfirm', '删除导出');
  await page.click('#wsExportPruneBtn');
  await page.waitForTimeout(180);
  const stale = await page.evaluate(() => ({
    text: document.getElementById('wsExportPreview')?.textContent,
    tone: document.getElementById('wsExportPreview')?.className
  }));
  check(stale.text.includes('文件已变化') && stale.tone.includes('is-error'),
    'stale 预览显示错误而非成功', stale);

  await page.evaluate(() => window.__fakeExportManage.setStale(false));
  await page.click('#wsExportOpenDir');
  await page.waitForTimeout(80);
  const openCall = await page.evaluate(() =>
    window.__fakeExportManage.calls.some((item) => item.type === 'open')
  );
  check(openCall, '打开目录调用固定 API');

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(120);
  const at1024 = await page.evaluate(() => {
    const card = document.querySelector('.export-manage-card');
    const body = document.querySelector('.export-manage-body');
    const actions = document.querySelector('.export-manage-actions');
    return {
      viewport: [document.body.scrollWidth, document.body.clientWidth],
      card: [card.scrollWidth, card.clientWidth],
      body: [body.scrollWidth, body.clientWidth],
      actions: [actions.scrollWidth, actions.clientWidth],
      statsColumns: getComputedStyle(document.getElementById('wsExportStats')).gridTemplateColumns
    };
  });
  check(at1024.viewport[0] <= at1024.viewport[1] &&
      at1024.card[0] <= at1024.card[1] + 1 &&
      at1024.body[0] <= at1024.body[1] + 1 &&
      at1024.actions[0] <= at1024.actions[1] + 1 &&
      at1024.statsColumns.split(' ').length === 2,
    '1024 导出管理无横向溢出', at1024);
  await page.screenshot({ path: path.join(OUT, 'export-manage-1024x700.png') });

  await page.setViewportSize({ width: 760, height: 700 });
  await page.waitForTimeout(120);
  const at760 = await page.evaluate(() => {
    const card = document.querySelector('.export-manage-card');
    return {
      viewport: [document.body.scrollWidth, document.body.clientWidth],
      card: [card.scrollWidth, card.clientWidth],
      statsColumns: getComputedStyle(document.getElementById('wsExportStats')).gridTemplateColumns
    };
  });
  check(at760.viewport[0] <= at760.viewport[1] &&
      at760.card[0] <= at760.card[1] + 1 &&
      at760.statsColumns.split(' ').length === 1,
    '760 导出管理单列不溢出', at760);

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.click('#wsExportManageClose');
  await page.waitForTimeout(120);
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById('exportManageModal')?.hidden,
    focus: document.activeElement?.id,
    appInert: document.querySelector('.app')?.hasAttribute('inert')
  }));
  check(closed.hidden === true && closed.focus === 'wsExportManageBtn' && !closed.appInert,
    '关闭后恢复入口焦点', closed);

  check(errors.length === 0, '无页面脚本错误', errors);
  await browser.close();
  console.log('\nSUMMARY  PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
