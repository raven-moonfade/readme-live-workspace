'use strict';
const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');
const path = require('path');
const PROJECT_ROOT = process.env.MUTAI_PROJECT_ROOT || path.resolve(__dirname, '../..');
const fs = require('fs');

const URL = process.env.MUTAI_UI_URL || 'file:///' + path.resolve(PROJECT_ROOT, 'ui/index.html').replace(/\\/g, '/');
const OUT = process.env.MUTAI_UI_SHOTS || path.join(PROJECT_ROOT, 'qa/shots/ui');
fs.mkdirSync(OUT, { recursive: true });

async function inspect(page, view) {
  return page.evaluate((name) => {
    const panel = document.getElementById('view-' + name);
    const active = document.querySelector('[data-workspace-view="' + name + '"]');
    return {
      panelHidden: panel ? panel.hidden : null,
      panelInert: panel ? panel.hasAttribute('inert') : null,
      active: active ? active.classList.contains('is-active') : false,
      current: active ? active.getAttribute('aria-current') : null,
      body: [document.body.scrollWidth, document.body.clientWidth],
      view: window.__MUTAI_SHELL__ ? window.__MUTAI_SHELL__.state.view : null,
    };
  }, view);
}

async function probeTopbarGeometry(page) {
  await page.evaluate(() => {
    const title = document.getElementById('roomTitle');
    if (title) {
      title.hidden = false;
      title.textContent = '这是一个非常非常长的直播间名称用于顶栏几何回归测试';
    }
    const account = document.getElementById('accountText');
    if (account) account.textContent = '超长用户名测试账号名称';
    const short = document.getElementById('accountShort');
    if (short) short.textContent = '超长';
    const cancel = document.getElementById('cancelBtn');
    if (cancel) cancel.hidden = false;
    const status = document.getElementById('statusText');
    if (status) status.textContent = '正在连接直播间';
  });
  return page.evaluate(() => {
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.topbar-right > *')]
      .filter((node) => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          id: node.id || node.className,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      });
    return {
      bar: { left: bar.left, right: bar.right },
      nodes,
      clipped: nodes.filter((node) => node.left < bar.left - 0.5 || node.right > bar.right + 0.5).length,
      overlap: nodes.some((node, index) => index > 0 && node.left < nodes[index - 1].right - 0.5),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  const base = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const rail = document.querySelector('.rail').getBoundingClientRect();
    const status = document.querySelector('.statusbar').getBoundingClientRect();
    const workspace = document.querySelector('.workspace-main').getBoundingClientRect();
    return {
      navItems: [...document.querySelectorAll('[data-workspace-view]')].map((node) => node.getAttribute('data-workspace-view')),
      versionLabel: document.getElementById('appVersionLabel')?.textContent.trim(),
      railWidth: Math.round(rail.width),
      statusAboveWorkspace: status.top < workspace.top,
      heroStyle: (() => {
        const hero = document.querySelector('.live-hero');
        if (!hero) return null;
        const style = getComputedStyle(hero);
        return {
          borderTop: style.borderTopWidth,
          borderBottom: style.borderBottomWidth,
          borderLeft: style.borderLeftWidth,
          borderRight: style.borderRightWidth,
          radius: style.borderRadius,
          background: style.backgroundColor,
          backgroundImage: style.backgroundImage,
        };
      })(),
      settingsMoved: !!document.querySelector('#settingsControlsHost > .side'),
      settingsHidden: document.querySelector('#settingsControlsHost > .side')?.hidden,
      settingsNavTabs: document.querySelectorAll('.settings-nav .settings-tab').length,
      duplicateIds: [...new Set(duplicateIds)],
      peak5mShort: (() => {
        const baseTs = 1767225600;
        const short = {
          started_at: baseTs,
          ended_at: baseTs + 180,
          real_received: 10,
          real_spoken: 0,
          real_dropped: 0,
          unique_users: 0,
          types: { danmaku: 10 },
          minutes: [
            { minute: baseTs / 60, count: 3 },
            { minute: baseTs / 60 + 1, count: 4 },
            { minute: baseTs / 60 + 2, count: 3 }
          ]
        };
        return window.__MUTAI_SHELL__.historyComparisonModel(short, short).current.peak5m;
      })(),
      peak5mExact: (() => {
        const baseTs = 1767225600;
        const exact = {
          started_at: baseTs,
          ended_at: baseTs + 300,
          real_received: 15,
          real_spoken: 0,
          real_dropped: 0,
          unique_users: 0,
          types: { danmaku: 15 },
          minutes: [2, 3, 4, 1, 5].map((count, index) => ({
            minute: baseTs / 60 + index,
            count
          }))
        };
        return window.__MUTAI_SHELL__.historyComparisonModel(exact, exact).current.peak5m;
      })(),
      platformCapabilityLabel: (() => {
        const history = window.__MUTAI_SHELL__.state.snapshot?.history;
        if (!history) return null;
        const original = history.capabilities;
        history.capabilities = {
          platforms: [
            { key: 'kuaishou', label: '快手', money_comparable: false }
          ]
        };
        const label = window.__MUTAI_SHELL__.platformLabel('kuaishou');
        const money = window.__MUTAI_SHELL__.platformMoneyComparable('kuaishou');
        history.capabilities = original;
        return { label, money };
      })(),
      giftCurrency: {
        gold: window.__MUTAI_SHELL__.giftCurrency({ total_coin: 1000, price: 1000, num: 1, coin_type: 'gold' }, 'real'),
        silver: window.__MUTAI_SHELL__.giftCurrency({ total_coin: 500, price: 500, num: 1, coin_type: 'silver' }, 'real'),
        unknown: window.__MUTAI_SHELL__.giftCurrency({ total_coin: 500, price: 500, num: 1, coin_type: '' }, 'real'),
        mock: window.__MUTAI_SHELL__.giftCurrency({ total_coin: 30, price: 30, num: 1, coin_type: '' }, 'mock'),
      },
      mutaiApp: !!window.MutaiApp && !!window.MutaiApp.state && !!window.MutaiApp.els,
      overlayRef: !!window.MutaiApp && !!window.MutaiApp.overlayState,
      appModules: window.MutaiApp ? Object.keys(window.MutaiApp.modules || {}) : [],
      workbenchRef: !!(window.MutaiApp && window.MutaiApp.workbench &&
        window.__wbDebug && window.__wbDebug.state === window.MutaiApp.workbench.state),
      legacyOverlayGone: !document.getElementById('overlayModal') &&
        !document.querySelector('script[src="app-overlay-window.js"]') &&
        !document.querySelector('script[src="app-overlay-mock.js"]'),
      debugSubnavGone: !document.getElementById('wbDebugSubnav'),
      noGlobalState: typeof window.state === 'undefined' && typeof window.els === 'undefined',
      appHooks: !!(window.__wbDebug && window.__mockDebug && window.MutaiWorkspace),
      shellContract: {
        sameState: window.MutaiShell.state === window.__MUTAI_SHELL__.state,
        hookKeys: Object.keys(window.__MUTAI_SHELL__).sort(),
        ctx: !!(window.MutaiShell.state && window.MutaiShell.els &&
          window.MutaiShell.helpers && window.MutaiShell.modules),
        apiGetter: (() => {
          const original = window.MutaiWorkspace;
          const probe = { __shellApiProbe: true };
          window.MutaiWorkspace = probe;
          const same = window.MutaiShell.api === probe;
          window.MutaiWorkspace = original;
          return same;
        })(),
      },
    };
  });
  await page.screenshot({ path: path.join(OUT, 'shell-danmaku-1280x820.png') });

  const monitorTest = await page.evaluate(async () => {
    const button = document.getElementById('monitorBtn');
    const before = window.MutaiApp.state.monitorVisible;
    // Simulate the frontend snapshot being stale after the monitor was
    // hidden from its own title bar. The backend remains the source of truth.
    window.MutaiApp.state.monitorVisible = true;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = window.MutaiApp.state.monitorVisible;
    const opened = window.MutaiApp.state.monitorVisible;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      before,
      staleSnapshot: true,
      after,
      restored: window.MutaiApp.state.monitorVisible,
      opened,
      closed: window.MutaiApp.state.monitorVisible
    };
  });

  const overlayToggle = await page.evaluate(async () => {
    const api = window.MutaiWorkspace;
    if (!api || typeof api.toggleOverlay !== "function") return null;
    const before = !!api.getSnapshot().overlay.enabled;
    const first = await api.toggleOverlay();
    const on = !!api.getSnapshot().overlay.enabled;
    const second = await api.toggleOverlay();
    const off = !!api.getSnapshot().overlay.enabled;
    return {
      before,
      on,
      off,
      firstOk: !first || first.ok !== false,
      secondOk: !second || second.ok !== false,
    };
  });

  const danmakuEntries = await page.evaluate(() => {
    const visible = (selector) => Array.prototype.filter.call(
      document.querySelectorAll(selector),
      (node) => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          node.getClientRects().length > 0;
      }
    ).length;
    return {
      workbench: visible('[data-workspace-view="picture"]') +
        visible('[data-workspace-action="overlay-workbench"]') +
        visible('#overlayBtn'),
      monitor: visible('#monitorBtn') + visible('[data-workspace-action="monitor"]'),
      overlay: visible('[data-workspace-action="overlay-toggle"]'),
      appearance: visible('#appearanceBtn') + visible('[data-workspace-action="appearance"]')
    };
  });

  const removedDuplicateControls = await page.evaluate(() => {
    const ids = [
      'overlayBtn', 'wsMonitorToggle', 'wsHeroOverlayToggle', 'wsQuickMonitorToggle',
      'wsOverlayQuickToggle', 'wsWorkbenchMonitorToggle', 'wsWorkbenchOverlayToggle',
      'wsHistoryManageCancel', 'wsExportManageCancel', 'wsHistoryBaselineCancel',
      'wbGoTheme', 'wbGoDebug', 'wbMotionTry'
    ];
    return ids.filter((id) => document.getElementById(id));
  });

  await page.click('[data-workspace-view="picture"]');
  await page.waitForFunction(() => {
    const modal = document.getElementById('wbModal');
    const card = document.getElementById('wbCard');
    return modal && card && !modal.hidden && window.__wbDebug &&
      window.__wbDebug.state.loadOk === true;
  }, null, { timeout: 8000 });
  const pictureBase = await inspect(page, 'picture');
  const picture = await page.evaluate(() => {
    const view = document.getElementById('view-picture');
    const card = document.getElementById('wbCard');
    const modal = document.getElementById('wbModal');
    return {
      title: view.querySelector('.view-head h1').textContent.trim(),
      mounted: view.contains(card),
      embedded: modal.classList.contains('is-embedded'),
      hidden: modal.hidden,
      tabs: document.querySelectorAll('#wbTabs [data-wb-tab]').length,
      styleVisible: !document.getElementById('wbPanelStyle').hidden,
      oldPreview: !!document.getElementById('wsPicturePreview'),
      builtInPreview: !!document.getElementById('wbPreviewStage'),
      oldMonitor: !!document.getElementById('wsMonitorTheme'),
      monitorInfo: view.textContent.includes('副屏阅读') || view.textContent.includes('独立监看'),
      overlayState: document.getElementById('wsWorkbenchOverlayState').textContent.trim(),
      duplicateMonitorButtons: document.querySelectorAll(
        '#wsWorkbenchMonitorToggle, #wsMonitorToggle, #wsMonitorHeroLabel'
      ).length,
      duplicateOverlayButtons: document.querySelectorAll(
        '#wsWorkbenchOverlayToggle, #wsHeroOverlayToggle, #wsOverlayQuickToggle'
      ).length,
      workbenchTopbar: !!document.getElementById('overlayBtn'),
      closeEntries: Array.prototype.filter.call(
        document.querySelectorAll('#wbCloseBtn, #wbCloseAction'),
        (node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0
      ).length,
      tabSpacing: (() => {
        const tab = document.querySelector('#wbTabs .wb-tab');
        const tabs = document.getElementById('wbTabs');
        return {
          width: tab ? tab.getBoundingClientRect().width : 0,
          gap: tabs ? parseFloat(getComputedStyle(tabs).columnGap) || 0 : 0,
        };
      })(),
      activeTypeSpacing: (() => {
        const item = document.querySelector('.wb-type-item.is-active');
        const icon = item && item.querySelector('.wb-type-icon');
        if (!item || !icon) return null;
        return {
          paddingLeft: parseFloat(getComputedStyle(item).paddingLeft) || 0,
          iconOffset: icon.getBoundingClientRect().left - item.getBoundingClientRect().left,
          listPaddingTop: parseFloat(getComputedStyle(item.parentElement).paddingTop) || 0,
        };
      })(),
      overlayStateButton: (() => {
        const node = document.getElementById('wsWorkbenchOverlayState');
        return node ? {
          tag: node.tagName,
          pressed: node.getAttribute('aria-pressed'),
          text: node.textContent.trim(),
        } : null;
      })(),
    };
  });
  await page.screenshot({ path: path.join(OUT, 'shell-picture-1280x820.png') });

  const overlayButtonClick = await page.evaluate(async () => {
    const button = document.getElementById('wsWorkbenchOverlayState');
    const before = {
      text: button.textContent.trim(),
      pressed: button.getAttribute('aria-pressed'),
      draft: window.__wbDebug.state.draft.enabled,
    };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const on = {
      text: button.textContent.trim(),
      pressed: button.getAttribute('aria-pressed'),
      draft: window.__wbDebug.state.draft.enabled,
    };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const off = {
      text: button.textContent.trim(),
      pressed: button.getAttribute('aria-pressed'),
      draft: window.__wbDebug.state.draft.enabled,
    };
    return { before, on, off };
  });

  const copiedThemeGlobal = await page.evaluate(() => {
    const cfg = {
      schema_version: 3,
      overlay: {
        styles: {
          theme: 'shortvideo',
          global: {
            font_size: 22,
            font_weight: 600,
            text_color: '#FFFFFF',
            name_color: '#8FE3FF',
            bg_color: '#000000',
            bg_opacity: 22,
            opacity: 100,
            outline: true,
            outline_color: '#000000',
            outline_width: 2,
            shadow: true,
            badge_color: null,
          },
          types: {},
        },
      },
    };
    const helpers = window.MutaiApp.workbench.helpers;
    const normalized = helpers.wbNormalizeConfig(cfg, null);
    const resolved = helpers.wbResolveStyle(normalized.draft, 'danmaku');
    return {
      global: normalized.draft.styles.global,
      font: resolved.font_size,
      weight: resolved.font_weight,
    };
  });

  await page.click('[data-wb-tab="rules"]');
  await page.waitForTimeout(120);
  const rulesTable = await page.evaluate(() => {
    const wrap = document.getElementById('wbRulesTableWrap');
    const table = wrap.querySelector('table');
    const price = table.querySelector('[data-wb-pin-field="min_price"]');
    const wrapRect = wrap.getBoundingClientRect();
    const priceRect = price ? price.getBoundingClientRect() : null;
    return {
      wrap: [wrap.clientWidth, wrap.scrollWidth],
      table: [table.clientWidth, table.scrollWidth],
      priceVisible: !!priceRect && priceRect.left >= wrapRect.left - 0.5 &&
        priceRect.right <= wrapRect.right + 0.5 && priceRect.width >= 40,
      priceRect: priceRect ? [priceRect.left, priceRect.right, priceRect.width] : null,
    };
  });
  const structurePreview = await page.evaluate(() => {
    const stage = document.getElementById('wbStructureStage');
    const canvas = document.getElementById('wbStructureCanvas');
    const stageRect = stage.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      stage: [stageRect.width, stageRect.height],
      canvas: [canvasRect.width, canvasRect.height],
      font: parseFloat(getComputedStyle(document.querySelector('.wb-structure-mini')).fontSize) || 0,
    };
  });
  await page.click('[data-wb-tab="style"]');
  await page.waitForTimeout(80);

  const embeddedTab = await page.evaluate(() => {
    const card = document.getElementById('wbCard');
    const nodes = [...card.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), ' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true' &&
      node.getClientRects().length);
    const last = nodes[nodes.length - 1];
    if (last) last.focus();
    return {
      count: nodes.length,
      insideBefore: card.contains(document.activeElement),
      activeBefore: document.activeElement?.id || document.activeElement?.className || '',
    };
  });
  await page.keyboard.press('Tab');
  const embeddedTabAfter = await page.evaluate(() => {
    const card = document.getElementById('wbCard');
    return {
      insideAfter: card.contains(document.activeElement),
      activeAfter: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
    };
  });

  await page.click('[data-wb-tab="window"]');
  await page.waitForTimeout(120);
  const pictureOverlayEntries = await page.evaluate(() => Array.prototype.filter.call(
    document.querySelectorAll('#wbOverlayEnabled, [data-workspace-action="overlay-toggle"]'),
    (node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        node.getClientRects().length > 0;
    }
  ).length);
  await page.click('[data-wb-tab="style"]');
  await page.waitForTimeout(80);

  const workbenchOpened = { hidden: picture.hidden, card: picture.mounted && picture.embedded };
  await page.click('#wbCloseBtn');
  await page.waitForTimeout(120);
  const workbenchCloseFocus = await page.evaluate(() => ({
    focus: document.activeElement?.getAttribute('data-workspace-view') || '',
    view: window.__MUTAI_SHELL__.state.view,
  }));

  await page.waitForTimeout(5200);
  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(250);
  const dataBase = await inspect(page, 'data');
  const data = await page.evaluate(() => ({
    received: Number(document.getElementById('wsDataReceived').textContent),
    spoken: Number(document.getElementById('wsDataSpoken').textContent),
    dropped: Number(document.getElementById('wsDataDropped').textContent),
    typeRows: document.querySelectorAll('#wsTypeBars .type-bar-row').length,
    nonZeroTypes: [...document.querySelectorAll('#wsTypeBars .type-bar-row b')].map((n) => Number(n.textContent)).filter((n) => n > 0).length,
    activityBars: document.querySelectorAll('#wsActivityChart .activity-bar').length,
    empty: document.getElementById('wsActivityChart').classList.contains('is-empty'),
    mode: document.getElementById('wsDataMode').textContent,
    room: document.getElementById('wsDataRoom').textContent,
    users: document.getElementById('wsDataUsers').textContent,
    giftValue: document.getElementById('wsDataGiftValue').textContent,
    scValue: document.getElementById('wsDataScValue').textContent,
    pulse: !!document.querySelector('.data-kpi-band'),
    oldMetricCards: document.querySelectorAll('.data-metric-grid').length,
    recent: document.getElementById('wsDataRecent').textContent,
    peak: document.getElementById('wsDataPeak').textContent,
    rate: document.getElementById('wsDataRate').textContent,
    pulseState: document.getElementById('wsPulseState').textContent,
    notices: document.getElementById('wsDataNotices').textContent,
    typeSegments: document.querySelectorAll('#wsTypeSegments i').length,
    typeTotal: document.getElementById('wsTypeTotal').textContent,
  }));
  await page.screenshot({ path: path.join(OUT, 'shell-data-1280x820.png') });

  await page.click('[data-workspace-view="settings"]');
  await page.waitForTimeout(180);
  const settingsBase = await inspect(page, 'settings');
  const settings = await page.evaluate(() => ({
    hostCards: document.querySelectorAll('#settingsControlsHost .side > .card').length,
    voices: document.querySelectorAll('#voiceSelect').length,
    sourceVisible: !document.querySelector('#settingsControlsHost > .side').hidden,
    account: document.getElementById('settingsBiliAccountState').textContent,
    securityHidden: document.getElementById('settingsCredentialSecurity').hidden,
    railState: document.getElementById('railSessionState').textContent,
    pane: document.querySelector('.settings-layout')?.getAttribute('data-settings-pane'),
    accountVisible: getComputedStyle(document.getElementById('settingsAccountCard')).display !== 'none',
    voiceVisible: getComputedStyle(document.getElementById('settingsVoiceCard')).display !== 'none',
    appearanceEntries: Array.prototype.filter.call(
      document.querySelectorAll('#appearanceBtn, [data-workspace-action="appearance"]'),
      (node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0
    ).length,
    loginEntries: Array.prototype.filter.call(
      document.querySelectorAll('#accountBtn, [data-workspace-action="login"]'),
      (node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0
    ).length,
    hotkeyEntries: Array.prototype.filter.call(
      document.querySelectorAll('[data-workspace-action="hotkeys"]'),
      (node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0
    ).length,
  }));
  await page.screenshot({ path: path.join(OUT, 'shell-settings-1280x820.png') });

  const securityProbe = await page.evaluate(async () => {
    const shell = window.__MUTAI_SHELL__;
    const original = window.MutaiWorkspace;
    window.MutaiWorkspace = Object.assign({}, original, {
      getConfigStatus: () => Promise.resolve({
        read_only: false,
        migration: { state: 'ok' },
        security: {
          state: 'plaintext_fallback',
          warning: true,
          message: '系统安全存储不可用，登录凭证以可逆编码保存在本机。',
          dpapi_available: false,
          plaintext_fallback: true,
          decrypt_failed: false,
          read_only: false,
          token_count: 1,
          error: false
        }
      })
    });
    shell.state.securityRefreshAt = 0;
    shell.setView('settings');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const node = document.getElementById('settingsCredentialSecurity');
    const result = {
      hidden: node.hidden,
      text: node.textContent,
      className: node.className
    };
    window.MutaiWorkspace = original;
    return result;
  });
  await page.screenshot({ path: path.join(OUT, 'shell-settings-security-1280x820.png') });

  const douyinMoney = await page.evaluate(() => {
    const shell = window.__MUTAI_SHELL__;
    const previous = shell.state.snapshot;
    const snap = JSON.parse(JSON.stringify(previous));
    snap.platform = 'douyin';
    snap.connection = 'connected';
    snap.room_id = 0;
    snap.room_title = '抖音边界测试';
    snap.account = {
      logged_in: false,
      uname: null,
      mid: null,
      douyin: { logged_in: true, uname: '抖音用户A', uid: 42 }
    };
    snap.session = {
      id: 'douyin-boundary',
      started_at: Date.now() / 1000 - 60,
      open: true,
      real: { received: 3, spoken: 2, dropped: 0, filtered: 0, unique_users: 2, types: {} }
    };
    shell.state.snapshot = snap;
    shell.renderData();
    document.dispatchEvent(new CustomEvent('mutai:monitor-state'));
    if (window.MutaiApp && window.MutaiApp.helpers && window.MutaiApp.helpers.renderAccount) {
      window.MutaiApp.helpers.renderAccount(snap.account);
    }
    const result = {
      revenueLabel: document.getElementById('wsDataRevenueLabel').textContent,
      revenue: document.getElementById('wsDataRevenue').textContent,
      gift: document.getElementById('wsDataRevenueGift').textContent,
      sc: document.getElementById('wsDataRevenueSc').textContent,
      giftDetail: document.getElementById('wsDataGiftValue').textContent,
      scDetail: document.getElementById('wsDataScValue').textContent,
      typeNote: document.getElementById('wsTypeNote').textContent,
      settingsAccount: document.getElementById('settingsDouyinAccountState').textContent,
      settingsAccountTitle: document.getElementById('settingsAccountTitle').textContent
    };
    shell.state.snapshot = previous;
    shell.renderData();
    document.dispatchEvent(new CustomEvent('mutai:monitor-state'));
    if (window.MutaiApp && window.MutaiApp.helpers && window.MutaiApp.helpers.renderAccount) {
      window.MutaiApp.helpers.renderAccount((previous && previous.account) || {});
    }
    return result;
  });
  await page.click('[data-settings-pane="voice"]');
  await page.waitForTimeout(120);
  const settingsPaneSwitched = await page.evaluate(() => ({
    pane: document.querySelector('.settings-layout')?.getAttribute('data-settings-pane'),
    accountVisible: getComputedStyle(document.getElementById('settingsAccountCard')).display !== 'none',
    voiceVisible: getComputedStyle(document.getElementById('settingsVoiceCard')).display !== 'none',
    securityVisible: !document.getElementById('settingsCredentialSecurity').hidden
  }));
  await page.locator('#rateSlider').evaluate((node) => {
    node.value = '10';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(180);
  const settingsControlValue = await page.evaluate(() => document.getElementById('rateValue').textContent);

  await page.click('[data-workspace-view="settings"]');
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    const list = document.getElementById('streamList');
    const item = document.createElement('div');
    item.className = 'item';
    item.dataset.long = '1';
    item.innerHTML = '<span class="badge badge-danmaku">弹幕</span>' +
      '<div class="item-main"><div class="item-line">长消息测试用户：' +
      ('这是一条用于验证隐藏视图恢复截断行为的长消息。'.repeat(18)) +
      '</div></div><span class="item-time">00:00</span>';
    list.appendChild(item);
  });
  await page.click('[data-workspace-view="danmaku"]');
  await page.waitForTimeout(220);
  const hiddenViewClamp = await page.evaluate(() => ({
    clamped: document.querySelectorAll('#streamList .item.is-clamped').length,
    expand: document.querySelectorAll('#streamList .item-expand').length,
    pendingLong: document.querySelectorAll('#streamList .item[data-long]').length,
  }));
  const renderedView = await page.evaluate(() => window.__MUTAI_SHELL__.state.view);

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('mutai:message', {
      detail: { type: 'danmaku', uid: 900001, user: '真实测试', text: 'real', ts: Date.now() / 1000, source: 'real', meta: {} }
    }));
    document.dispatchEvent(new CustomEvent('mutai:message', {
      detail: { type: 'danmaku', uid: 900002, user: '模拟测试', text: 'mock', ts: Date.now() / 1000, source: 'mock', meta: { mock: true } }
    }));
  });
  const metricIsolation = await page.evaluate(() => ({
    realUser: window.__MUTAI_SHELL__.state.session.real.users.has('900001'),
    realMockUser: window.__MUTAI_SHELL__.state.session.real.users.has('900002'),
    mockUser: window.__MUTAI_SHELL__.state.session.mock.users.has('900002'),
    mockRealUser: window.__MUTAI_SHELL__.state.session.mock.users.has('900001'),
  }));
  const mainTopbar = await probeTopbarGeometry(page);
  const heroStress = await page.evaluate(async () => {
    window.__MUTAI_SHELL__.setView('danmaku', { focus: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const hero = document.querySelector('.live-hero');
    const list = document.getElementById('streamList');
    const module = window.MutaiApp.modules.danmaku;
    const before = Math.round(hero.getBoundingClientRect().height);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 80; i += 1) {
      fragment.appendChild(module.buildMessageItem({
        seq: 920000 + i,
        type: 'danmaku',
        uid: 920000 + i,
        user: '压力测试用户' + i,
        text: '弹幕压力测试文本 ' + i,
        ts: Date.now() / 1000,
        spoken: false,
        meta: {},
      }, 'danmaku'));
    }
    list.appendChild(fragment);
    const empty = document.getElementById('emptyState');
    if (empty) empty.classList.add('is-hidden');
    const count = document.getElementById('streamCount');
    if (count) count.textContent = '80';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    list.scrollTop = 0;
    const after = Math.round(hero.getBoundingClientRect().height);
    return {
      before,
      after,
      delta: Math.abs(after - before),
      listScrollable: list.scrollHeight > list.clientHeight,
      listClient: list.clientHeight,
      listScroll: list.scrollHeight,
    };
  });

  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(120);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  const restored = await page.evaluate(() => window.__MUTAI_SHELL__.state.view);

  const smallContext = await browser.newContext({ viewport: { width: 1024, height: 700 }, colorScheme: 'light' });
  const small = await smallContext.newPage();
  const smallErrors = [];
  small.on('console', (m) => { if (m.type() === 'error') smallErrors.push('console: ' + m.text()); });
  small.on('pageerror', (e) => smallErrors.push('pageerror: ' + e.message));
  await small.addInitScript(() => {
    localStorage.setItem('mutai-appearance-prod-v1', JSON.stringify({
      preset: 'broadcast',
      custom: false,
      themeMode: 'light',
      accent: '#FF5F3A',
      pattern: 'none',
      spacing: 24,
      dotSize: 1.5,
      radius: false,
      radiusSize: 12,
      font: 'broadcast'
    }));
  });
  await small.goto(URL, { waitUntil: 'load' });
  await small.waitForTimeout(1300);
  const smallBase = await small.evaluate(() => {
    const rail = document.querySelector('.rail').getBoundingClientRect();
    return {
      railWidth: Math.round(rail.width),
      railHeight: Math.round(rail.height),
      overflow: [document.body.scrollWidth, document.body.clientWidth],
      viewHead: document.querySelector('.view-head').getBoundingClientRect().height,
    };
  });
  for (const view of ['danmaku', 'picture', 'data', 'settings']) {
    await small.click('[data-workspace-view="' + view + '"]');
    await small.waitForTimeout(120);
    if (view === 'data') {
      await small.screenshot({ path: path.join(OUT, 'shell-data-1024x700-light.png') });
    }
  }
  const smallFinal = await small.evaluate(() => ({
    overflow: [document.body.scrollWidth, document.body.clientWidth],
    view: window.__MUTAI_SHELL__.state.view,
  }));
  await small.screenshot({ path: path.join(OUT, 'shell-settings-1024x700-light.png') });
  const smallTopbar = await probeTopbarGeometry(small);

  const wideContext = await browser.newContext({ viewport: { width: 1707, height: 960 } });
  const wide = await wideContext.newPage();
  await wide.goto(URL, { waitUntil: 'load' });
  await wide.waitForTimeout(700);
  const wideBase = await wide.evaluate(() => {
    const rail = document.querySelector('.rail').getBoundingClientRect();
    return {
      railWidth: Math.round(rail.width),
      overflow: [document.body.scrollWidth, document.body.clientWidth],
    };
  });
  await wide.screenshot({ path: path.join(OUT, 'shell-danmaku-1707x960.png') });
  await wide.click('[data-workspace-view="data"]');
  await wide.waitForTimeout(120);
  await wide.screenshot({ path: path.join(OUT, 'shell-data-1707x960.png') });
  const wideTopbar = await probeTopbarGeometry(wide);

  await small.setViewportSize({ width: 760, height: 700 });
  await small.click('[data-workspace-view="data"]');
  await small.waitForTimeout(160);
  const data760 = await small.evaluate(() => ({
    overflow: [document.body.scrollWidth, document.body.clientWidth],
    pulse: !!document.querySelector('.data-kpi-band'),
  }));
  await small.screenshot({ path: path.join(OUT, 'shell-data-760x700-light.png') });

  const dpiMatrix = [];
  for (const dpr of [1, 1.5, 2]) {
    for (const width of [1024, 1280, 1707]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: dpr,
        colorScheme: 'dark'
      });
      const matrixPage = await context.newPage();
      matrixPage.on('console', (message) => {
        if (message.type() === 'error') errors.push('dpi console: ' + message.text());
      });
      matrixPage.on('pageerror', (error) => errors.push('dpi pageerror: ' + error.message));
      await matrixPage.goto(URL, { waitUntil: 'load' });
      await matrixPage.waitForTimeout(700);
      const dimensions = await matrixPage.evaluate(() => ({
        dpr: window.devicePixelRatio,
        overflow: [document.body.scrollWidth, document.body.clientWidth],
        view: window.__MUTAI_SHELL__ && window.__MUTAI_SHELL__.state.view,
      }));
      const topbar = await probeTopbarGeometry(matrixPage);
      dpiMatrix.push({
        dpr,
        width,
        actualDpr: dimensions.dpr,
        overflow: dimensions.overflow,
        view: dimensions.view,
        topbarClipped: topbar.clipped,
        topbarOverlap: topbar.overlap,
      });
      await context.close();
    }
  }

  const liveStates = await page.evaluate(async () => {
    const shell = window.__MUTAI_SHELL__;
    const waitFor = async (predicate, timeout = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return !!predicate();
    };
    const originalSnapshot = shell.state.snapshot;
    const originalReal = shell.state.session.real;
    const originalStarted = shell.state.session.startedAt;
    const originalObserved = shell.state.session.observedAt;
    const nowSec = Date.now() / 1000;
    const snap = JSON.parse(JSON.stringify(originalSnapshot));
    snap.connection = 'connected';
    snap.is_mock = false;
    snap.session = snap.session || {};
    snap.session.id = snap.session.id || 'page-only-test';
    snap.session.open = true;
    snap.session.started_at = nowSec - 3600;
    snap.session.real = { received: 1, spoken: 0, dropped: 0 };
    snap.history = { available: true };
    shell.state.snapshot = snap;
    shell.state.session.startedAt = (nowSec - 3600) * 1000;
    shell.state.session.observedAt = Date.now();
    shell.state.session.real = {
      counts: { danmaku: 1, gift: 0, super_chat: 0, guard: 0, enter: 0 },
      values: { giftCny: 0, giftSilver: 0, giftUnknown: 0, superChatCny: 0 },
      users: new Set(['u1']),
      minuteBuckets: new Map([[Math.floor(nowSec / 60), 1]]),
      lastEventAt: nowSec
    };
    shell.renderData();
    const pageOnly = {
      peak: document.getElementById('wsDataPeak').textContent,
      peakHint: document.getElementById('wsDataPeakHint').textContent,
      recentLabel: document.getElementById('wsRecentLabel').textContent,
      typeNote: document.getElementById('wsTypeNote').textContent
    };
    snap.connection = 'connecting';
    snap.session.open = false;
    shell.renderData();
    const connecting = {
      pulse: document.getElementById('wsPulseState').textContent,
      notices: document.getElementById('wsDataNotices').textContent
    };
    snap.connection = 'connected';
    snap.session.open = true;
    snap.session.started_at = nowSec - 30;
    snap.session.real = { received: 0, spoken: 0, dropped: 0 };
    shell.state.session.startedAt = (nowSec - 30) * 1000;
    shell.state.session.observedAt = Date.now() - 30000;
    shell.state.session.real = {
      counts: { danmaku: 0, gift: 0, super_chat: 0, guard: 0, enter: 0 },
      values: { giftCny: 0, giftSilver: 0, giftUnknown: 0, superChatCny: 0 },
      users: new Set(),
      minuteBuckets: new Map(),
      lastEventAt: null
    };
    const testWorkspace = Object.assign({}, window.MutaiWorkspace, {
      getSnapshot: () => snap
    });
    shell.renderData();
    const empty = {
      bars: document.querySelectorAll('#wsActivityChart .activity-bar').length,
      note: document.getElementById('wsDataEmpty').textContent
    };
    snap.connection = 'connected';
    snap.session.open = false;
    shell.renderData();
    const closed = {
      pulse: document.getElementById('wsPulseState').textContent,
      saveState: document.getElementById('wsDataSaveState').textContent,
      notices: document.getElementById('wsDataNotices').textContent,
      recentHint: document.getElementById('wsDataRecentHint').textContent,
      rateHint: document.getElementById('wsDataRateHint').textContent,
      peakHint: document.getElementById('wsDataPeakHint').textContent,
      emptyNote: document.getElementById('wsDataEmpty').textContent,
      postlude: !document.getElementById('wsDataPostlude').hidden,
      exportButtons: document.querySelectorAll('[data-postlude-export]').length,
      compareButton: !!document.getElementById('wsDataComparePrevious')
    };
    const originalWorkspace = window.MutaiWorkspace;
    window.MutaiWorkspace = Object.assign({}, testWorkspace, {
      exportSession: (id, format) => Promise.resolve({
        ok: true,
        format,
        path: 'D:/tmp/postlude-test.' + format
      })
    });
    document.querySelector('[data-postlude-export="json"]').click();
    await waitFor(() =>
      document.getElementById('wsDataPostludeStatus').textContent.includes('已导出 JSON') &&
      ![...document.querySelectorAll('[data-postlude-export]')]
        .some((button) => button.disabled)
    );
    const postludeExport = {
      text: document.getElementById('wsDataPostludeStatus').textContent,
      hidden: document.getElementById('wsDataPostludeStatus').hidden,
      role: document.getElementById('wsDataPostludeStatus').getAttribute('role'),
      disabled: [...document.querySelectorAll('[data-postlude-export]')]
        .some((button) => button.disabled)
    };
    window.MutaiWorkspace = Object.assign({}, testWorkspace, {
      exportSession: () => Promise.resolve({ ok: false, error: '写入失败' })
    });
    document.querySelector('[data-postlude-export="csv"]').click();
    await waitFor(() =>
      document.getElementById('wsDataPostludeStatus').textContent.includes('导出失败') &&
      ![...document.querySelectorAll('[data-postlude-export]')]
        .some((button) => button.disabled)
    );
    const postludeExportError = {
      text: document.getElementById('wsDataPostludeStatus').textContent,
      role: document.getElementById('wsDataPostludeStatus').getAttribute('role'),
      live: document.getElementById('wsDataPostludeStatus').getAttribute('aria-live'),
      disabled: [...document.querySelectorAll('[data-postlude-export]')]
        .some((button) => button.disabled)
    };
    window.MutaiWorkspace = originalWorkspace;
    const deepLinkSession = {
      id: 'page-only-test',
      platform: 'bilibili',
      room_id: 777,
      room_key: '777',
      room_title: '夜航测试',
      started_at: nowSec - 3600,
      ended_at: nowSec - 300,
      end_reason: 'finished',
      real_received: 1,
      real_spoken: 0,
      real_dropped: 0,
      unique_users: 1,
      types: { danmaku: 1 },
      minutes: [{ minute: Math.floor((nowSec - 60) / 60), count: 1 }]
    };
    window.MutaiWorkspace = Object.assign({}, testWorkspace, {
      listSessions: () => Promise.resolve({
        ok: true,
        sessions: [deepLinkSession],
        total: 1,
        all_total: 1,
        platforms: [{ platform: 'bilibili', count: 1 }],
        has_more: false,
        next_cursor: null
      }),
      getSession: () => Promise.resolve({ ok: true, session: deepLinkSession })
    });
    document.getElementById('wsDataOpenHistory').click();
    await waitFor(() =>
      document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent ===
        '夜航测试'
    );
    const deepLink = {
      tab: shell.state.dataTab,
      title: document.querySelector('#wsHistoryDetail .history-detail-title h2')?.textContent
    };
    window.MutaiWorkspace = originalWorkspace;
    shell.state.snapshot = originalSnapshot;
    shell.state.session.real = originalReal;
    shell.state.session.startedAt = originalStarted;
    shell.state.session.observedAt = originalObserved;
    shell.refresh();
    return {
      pageOnly, connecting, empty, closed, postludeExport,
      postludeExportError, deepLink
    };
  });

  const backendHydration = await page.evaluate(() => {
    const shell = window.__MUTAI_SHELL__;
    const snap = JSON.parse(JSON.stringify(shell.state.snapshot));
    const nowSec = Date.now() / 1000;
    snap.connection = 'connected';
    snap.is_mock = false;
    snap.session = snap.session || {};
    snap.session.id = 'hydration-test';
    snap.session.open = true;
    snap.session.started_at = nowSec - 120;
    snap.session.real = {
      received: 10,
      spoken: 8,
      dropped: 2,
      unique_users: 4,
      gift_cny: 12.5,
      gift_silver: 0,
      gift_unknown: 0,
      super_chat_cny: 30,
      types: { danmaku: 7, gift: 2, super_chat: 1, guard: 0, enter: 0 }
    };
    shell.state.snapshot = snap;
    shell.state.session.real = {
      counts: { danmaku: 0, gift: 0, super_chat: 0, guard: 0, enter: 0 },
      values: { giftCny: 0, giftSilver: 0, giftUnknown: 0, superChatCny: 0 },
      users: new Set(),
      minuteBuckets: new Map(),
      lastEventAt: null
    };
    shell.renderData();
    return {
      users: document.getElementById('wsDataUsers').textContent,
      revenue: document.getElementById('wsDataRevenue').textContent,
      gift: document.getElementById('wsDataGiftValue').textContent,
      types: [...document.querySelectorAll('#wsTypeBars .type-bar-row b')]
        .map((node) => node.textContent)
    };
  });

  const sessionOpenForwarded = await page.evaluate(() => {
    const appState = window.MutaiApp.state;
    const previous = appState.session.open;
    appState.session.open = true;
    const forwarded = window.MutaiWorkspace.getSnapshot().session.open;
    appState.session.open = previous;
    return forwarded;
  });

  const filteredMetric = await page.evaluate(() => {
    const shell = window.__MUTAI_SHELL__;
    const previous = shell.state.snapshot;
    const snap = JSON.parse(JSON.stringify(previous));
    snap.connection = 'connected';
    snap.is_mock = false;
    snap.session = snap.session || {};
    snap.session.open = true;
    snap.session.started_at = Date.now() / 1000 - 120;
    snap.session.real = {
      received: 20,
      spoken: 8,
      dropped: 12,
      filtered: 10,
      unique_users: 4,
      types: { danmaku: 10, gift: 2, super_chat: 0, guard: 0, enter: 8 }
    };
    shell.state.snapshot = snap;
    shell.renderData();
    const result = {
      dropped: document.getElementById('wsDataDropped').textContent,
      filtered: document.getElementById('wsDataFiltered').textContent
    };
    shell.state.snapshot = previous;
    shell.renderData();
    return result;
  });

  const appearanceSave = await page.evaluate(async () => {
    const appearance = {
      schema_version: 1,
      preset: 'broadcast',
      custom: false,
      theme_mode: 'dark',
      accent: '#FF5F3A',
      pattern: { type: 'none', spacing_px: 24, dot_size_px: 1.5 },
      monitor_pattern: true,
      radius: { enabled: false, value_px: 12 },
      font: 'broadcast'
    };
    const calls = [];
    window.pywebview = {
      api: {
        get_appearance: async () => ({ ok: true, appearance }),
        set_appearance: async (value) => {
          calls.push(value);
          return { ok: true, appearance: value };
        }
      }
    };
    document.getElementById('appearanceBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    document.querySelector('[data-ap-theme="light"]').click();
    document.getElementById('apSave').click();
    await new Promise((resolve) => setTimeout(resolve, 260));
    const result = {
      status: document.getElementById('apStatus').textContent,
      calls: calls.length,
      theme: document.documentElement.dataset.theme,
    };
    document.getElementById('apClose').click();
    return result;
  });

  const pendingContext = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    colorScheme: 'dark',
  });
  const pendingPage = await pendingContext.newPage();
  await pendingPage.addInitScript(() => {
    try {
      const key = 'mutai-appearance-prod-v1';
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, JSON.stringify({
          preset: 'broadcast',
          custom: false,
          themeMode: 'light',
          accent: '#FF5F3A',
          pattern: 'none',
          spacing: 24,
          dotSize: 1.5,
          monitorPattern: true,
          radius: false,
          radiusSize: 12,
          font: 'broadcast',
          pending: true
        }));
      }
    } catch (e) {}
  });
  await pendingPage.goto(URL, { waitUntil: 'load' });
  await pendingPage.waitForTimeout(500);
  const pendingLoaded = await pendingPage.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    stored: JSON.parse(localStorage.getItem('mutai-appearance-prod-v1') || '{}').pending === true,
  }));
  await pendingPage.evaluate(() => {
    window.pywebview = {
      api: {
        get_appearance: async () => ({ ok: true, appearance: { accent: '#FF5F3A' } }),
        set_appearance: async () => ({ ok: false, error: '写入被拒绝' })
      }
    };
    document.getElementById('appearanceBtn').click();
  });
  await pendingPage.waitForTimeout(80);
  await pendingPage.click('[data-ap-theme="dark"]');
  await pendingPage.click('#apSave');
  await pendingPage.waitForTimeout(260);
  const pendingFailed = await pendingPage.evaluate(() => ({
    status: document.getElementById('apStatus').textContent,
    theme: document.documentElement.dataset.theme,
    stored: JSON.parse(localStorage.getItem('mutai-appearance-prod-v1') || '{}'),
  }));
  await pendingPage.reload({ waitUntil: 'load' });
  await pendingPage.waitForTimeout(500);
  const pendingReloaded = await pendingPage.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    stored: JSON.parse(localStorage.getItem('mutai-appearance-prod-v1') || '{}'),
  }));
  await pendingPage.close();
  await pendingContext.close();

  const checks = {
    noErrors: errors.length === 0 && smallErrors.length === 0,
    fourViews: base.navItems.join(',') === 'danmaku,picture,data,settings',
    versionIdentity: base.versionLabel === 'v1.0.0',
    railDesktop: base.railWidth === 204,
    statusStripPlaced: base.statusAboveWorkspace,
    settingsMoved: base.settingsMoved && base.settingsHidden === false,
    noDuplicateIds: base.duplicateIds.length === 0,
    shellStateIdentity: base.shellContract.sameState,
    shellHookShape: base.shellContract.hookKeys.join(',') ===
      'giftCurrency,historyComparisonModel,platformLabel,platformMoneyComparable,refresh,renderData,renderPicture,setView,state',
    shellCtxShape: base.shellContract.ctx,
    shellApiGetter: base.shellContract.apiGetter,
    overlayToggleWorks: overlayToggle && overlayToggle.before === false &&
      overlayToggle.on === true && overlayToggle.off === false &&
      overlayToggle.firstOk && overlayToggle.secondOk,
    giftCurrencySafe: base.giftCurrency.gold.cny === 1 &&
      base.giftCurrency.silver.silver === 500 &&
      base.giftCurrency.silver.cny === 0 &&
      base.giftCurrency.unknown.unknown === 500 &&
      base.giftCurrency.unknown.cny === 0 &&
      base.giftCurrency.mock.cny === 30,
    pictureVisible: !pictureBase.panelHidden && pictureBase.active && pictureBase.current === 'page',
    pictureWorkbench: picture.title === '弹幕工作台' && picture.mounted && picture.embedded &&
      !picture.hidden && picture.tabs === 5 && picture.styleVisible,
    pictureNoLegacyOutput: !picture.oldPreview && !picture.builtInPreview &&
      !picture.oldMonitor && !picture.monitorInfo,
    monitorToggleState: monitorTest.before === false && monitorTest.after === true &&
      monitorTest.restored === false && monitorTest.opened === true && monitorTest.closed === false,
    danmakuSingleEntries: danmakuEntries.workbench === 1 && danmakuEntries.monitor === 1 &&
      danmakuEntries.overlay === 1 && danmakuEntries.appearance === 1,
    removedDuplicateControls: removedDuplicateControls.length === 0,
    pictureNoDuplicateActions: picture.duplicateMonitorButtons === 0 &&
      picture.duplicateOverlayButtons === 0 && picture.workbenchTopbar === false &&
      picture.overlayState === '显示弹幕' && pictureOverlayEntries === 1 &&
      picture.closeEntries === 1,
    overlayStateButton: picture.overlayStateButton &&
      picture.overlayStateButton.tag === 'BUTTON' &&
      picture.overlayStateButton.pressed === 'false' &&
      picture.overlayStateButton.text === '显示弹幕',
    overlayStateButtonWorks: overlayButtonClick.before.text === '显示弹幕' &&
      overlayButtonClick.on.text === '隐藏弹幕' && overlayButtonClick.on.pressed === 'true' &&
      overlayButtonClick.off.text === '显示弹幕' && overlayButtonClick.off.pressed === 'false',
    overlayStateDraftSync: overlayButtonClick.before.draft === false &&
      overlayButtonClick.on.draft === true && overlayButtonClick.off.draft === false,
    copiedThemeGlobalRepaired: Object.keys(copiedThemeGlobal.global).length === 0 &&
      copiedThemeGlobal.font === 30 && copiedThemeGlobal.weight === 800,
    structurePreviewReadable: structurePreview.font >= 12 &&
      structurePreview.canvas[0] >= structurePreview.stage[0] * 0.85 &&
      structurePreview.canvas[1] >= structurePreview.stage[1] * 0.85,
    rulesTableReadable: rulesTable.table[0] === rulesTable.table[1] &&
      rulesTable.wrap[0] === rulesTable.wrap[1] && rulesTable.priceVisible,
    pictureTabSpacing: picture.tabSpacing.width >= 80 && picture.tabSpacing.gap >= 6 &&
      picture.activeTypeSpacing && picture.activeTypeSpacing.paddingLeft >= 9 &&
      picture.activeTypeSpacing.iconOffset >= 9 && picture.activeTypeSpacing.listPaddingTop >= 4,
    embeddedWorkbenchTabEscapes: embeddedTab.count > 0 && embeddedTab.insideBefore &&
      !embeddedTabAfter.insideAfter,
    workbenchOpens: workbenchOpened.hidden === false && workbenchOpened.card,
    workbenchCloseFocus: workbenchCloseFocus.view === 'danmaku' &&
      workbenchCloseFocus.focus === 'danmaku',
    dataVisible: !dataBase.panelHidden && dataBase.active,
    dataReal: data.received > 0 && data.typeRows === 7 && data.nonZeroTypes > 0 && data.activityBars === 20,
    dataNoFakeMode: data.mode.includes('模拟'),
    dataValueFields: data.giftValue.startsWith('本机字段 ¥') && data.scValue.startsWith('本机字段 ¥'),
    dataPulse: data.pulse && data.oldMetricCards === 0 &&
      data.typeSegments > 0 && data.pulseState.includes('调试预览'),
    dataDerived: data.recent !== '—' && data.peak === '—' && data.rate === '—',
    backendHydration: backendHydration.users === '4' &&
      backendHydration.revenue === '¥42.50' &&
      backendHydration.gift.includes('¥12.50') &&
      backendHydration.types.join(',') === '7,2,1,0,0,0,0',
    sessionOpenForwarded: sessionOpenForwarded === true,
    filteredMetric: filteredMetric.dropped === '2' && filteredMetric.filtered === '10',
    appearanceSavePersists: appearanceSave.calls === 1 &&
      appearanceSave.status.includes('已保存') && appearanceSave.theme === 'light',
    appearancePendingDraft: pendingLoaded.theme === 'light' && pendingLoaded.stored &&
      pendingFailed.status.includes('保存失败') && pendingFailed.theme === 'dark' &&
      pendingFailed.stored.pending === true && pendingFailed.stored.themeMode === 'dark' &&
      pendingReloaded.theme === 'dark' && pendingReloaded.stored.pending === true &&
      pendingReloaded.stored.themeMode === 'dark',
    dataNotices: data.notices.includes('调试预览'),
    douyinMoneyBoundary: douyinMoney.revenueLabel === '礼物价值' &&
      douyinMoney.revenue === '仅单条钻石' &&
      douyinMoney.gift === '钻石不汇总' &&
      douyinMoney.sc === '未提供' &&
      douyinMoney.giftDetail.includes('单条') &&
      douyinMoney.scDetail.includes('平台未提供') &&
      douyinMoney.typeNote.includes('SC/舰长') &&
      douyinMoney.settingsAccount.includes('抖音用户A') &&
      douyinMoney.settingsAccountTitle === '账号登录态' &&
      !Object.values(douyinMoney).some((value) => String(value).includes('¥0.00')),
    peak5mMatches: base.peak5mShort === null && base.peak5mExact === 15,
    platformCapabilities: base.platformCapabilityLabel?.label === '快手' &&
      base.platformCapabilityLabel?.money === false,
    settingsVisible: !settingsBase.panelHidden && settingsBase.active,
    settingsSingleControls: settings.hostCards === 2 && settings.voices === 1 && settings.sourceVisible,
    settingsNav: base.settingsNavTabs === 4,
    settingsSingleEntries: settings.appearanceEntries === 1 &&
      settings.loginEntries === 1 && settings.hotkeyEntries === 0,
    securityHidden: settings.securityHidden,
    securityWarning: !securityProbe.hidden &&
      securityProbe.text.includes('可逆编码') &&
      securityProbe.className.includes('settings-security-note'),
    securityPersistent: settingsPaneSwitched.securityVisible,
    settingsPanes: settings.pane === 'account' && settings.accountVisible && !settings.voiceVisible &&
      settingsPaneSwitched.pane === 'voice' && !settingsPaneSwitched.accountVisible &&
      settingsPaneSwitched.voiceVisible,
    settingsControlWorks: settingsControlValue === '+10%',
    hiddenViewReclamps: renderedView === 'danmaku' &&
      hiddenViewClamp.clamped > 0 &&
      hiddenViewClamp.expand > 0 &&
      hiddenViewClamp.pendingLong === 0,
    metricsIsolated: metricIsolation.realUser &&
      !metricIsolation.realMockUser &&
      metricIsolation.mockUser &&
      !metricIsolation.mockRealUser,
    mutaiAppContext: base.mutaiApp && base.overlayRef && base.noGlobalState && base.appHooks &&
      base.appModules.indexOf('danmaku') >= 0 && base.appModules.indexOf('wbCore') >= 0 &&
      base.workbenchRef && base.legacyOverlayGone && base.debugSubnavGone,
    mainTopbarSafe: mainTopbar.clipped === 0 && !mainTopbar.overlap,
    heroFlat: base.heroStyle &&
      base.heroStyle.borderTop === '1px' &&
      base.heroStyle.borderBottom === '1px' &&
      base.heroStyle.borderLeft === '0px' &&
      base.heroStyle.borderRight === '0px' &&
      base.heroStyle.radius === '0px' &&
      base.heroStyle.background === 'rgba(0, 0, 0, 0)' &&
      base.heroStyle.backgroundImage === 'none',
    heroDoesNotShrink: heroStress.delta <= 1 && heroStress.listScrollable,
    viewPersists: restored === 'data',
    smallMobileNav: smallBase.railWidth >= 900 && smallBase.railHeight <= 56,
    smallNoOverflow: smallBase.overflow[0] === smallBase.overflow[1] &&
      smallFinal.overflow[0] === smallFinal.overflow[1],
    smallViewSwitch: smallFinal.view === 'settings',
    smallTopbarSafe: smallTopbar.clipped === 0 && !smallTopbar.overlap,
    wideRail: wideBase.railWidth === 220,
    wideNoOverflow: wideBase.overflow[0] === wideBase.overflow[1],
    wideTopbarSafe: wideTopbar.clipped === 0 && !wideTopbar.overlap,
    data760NoOverflow: data760.overflow[0] === data760.overflow[1] && data760.pulse,
    dpiMatrixSafe: dpiMatrix.length === 9 &&
      dpiMatrix.every((item) => item.actualDpr === item.dpr &&
        item.overflow[0] <= item.overflow[1] &&
        item.view === 'danmaku' &&
        item.topbarClipped === 0 && !item.topbarOverlap),
    livePageOnly: liveStates.pageOnly.peak === '—' &&
      liveStates.pageOnly.peakHint.includes('本页覆盖不足') &&
      liveStates.pageOnly.recentLabel === '本页观察' &&
      liveStates.pageOnly.typeNote.includes('仅统计本页'),
    liveConnecting: liveStates.connecting.pulse.includes('正在连接') &&
      !liveStates.connecting.notices.includes('已断开'),
    liveEmpty: liveStates.empty.bars === 20 &&
      liveStates.empty.note.includes('等待首条消息'),
    liveClosed: liveStates.closed.pulse.includes('场次已结束') &&
      liveStates.closed.saveState.includes('连接仍在线') &&
      liveStates.closed.notices.includes('场次已结束') &&
      liveStates.closed.recentHint.includes('尚无消息') &&
      liveStates.closed.rateHint.includes('无观测时长') &&
      liveStates.closed.peakHint.includes('本场未收到消息') &&
      liveStates.closed.emptyNote.includes('本场未收到消息') &&
      liveStates.closed.postlude === true &&
      liveStates.closed.exportButtons === 2 &&
      liveStates.closed.compareButton === true,
    liveExport: liveStates.postludeExport.text.includes('已导出 JSON') &&
      liveStates.postludeExport.hidden === false &&
      liveStates.postludeExport.role === 'status' &&
      liveStates.postludeExport.disabled === false,
    liveExportError: liveStates.postludeExportError.text.includes('导出失败') &&
      liveStates.postludeExportError.role === 'alert' &&
      liveStates.postludeExportError.live === 'assertive' &&
      liveStates.postludeExportError.disabled === false,
    liveDeepLink: liveStates.deepLink.tab === 'history' &&
      liveStates.deepLink.title === '夜航测试',
  };

  console.log(JSON.stringify({
    errors: errors.concat(smallErrors),
    base,
    pictureBase,
    picture,
    embeddedTab,
    embeddedTabAfter,
    monitorTest,
    danmakuEntries,
    pictureOverlayEntries,
    removedDuplicateControls,
    workbenchOpened,
    dataBase,
    data,
    settingsBase, settingsPaneSwitched,
    settings,
    settingsControlValue,
    hiddenViewClamp,
    renderedView,
    douyinMoney,
    metricIsolation,
    mainTopbar,
    heroStress,
    restored,
    smallBase,
    smallFinal,
    smallTopbar,
    wideBase,
    wideTopbar,
    checks,
  }, null, 2));
  await browser.close();
  if (Object.values(checks).some((value) => !value)) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
