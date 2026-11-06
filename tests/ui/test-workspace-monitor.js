'use strict';

const path = require('path');
const PROJECT_ROOT = process.env.MUTAI_PROJECT_ROOT || path.resolve(__dirname, '../..');
const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');

const MONITOR_URL = 'file:///' + path.resolve(PROJECT_ROOT, 'ui/monitor.html').replace(/\\/g, '/');
const APP_URL = 'file:///' + path.resolve(PROJECT_ROOT, 'ui/index.html').replace(/\\/g, '/');

function assert(condition, label, detail) {
  if (!condition) {
    throw new Error(label + (detail === undefined ? '' : '：' + JSON.stringify(detail)));
  }
  console.log('PASS  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
}

function appearanceCache(overrides) {
  return Object.assign({
    preset: 'cobalt',
    custom: true,
    themeMode: 'light',
    accent: '#FF5F3A',
    pattern: { type: 'dots', spacing_px: 24, dot_size_px: 3.5 },
    monitor_pattern: true,
    radius: { enabled: false, value_px: 12 },
    font: 'system'
  }, overrides || {});
}

async function monitorState(page) {
  return page.evaluate(() => window.__MONITOR_TEST__.state());
}

async function waitForMonitor(page) {
  await page.waitForFunction(
    () => window.__MONITOR_TEST__ && window.__MONITOR_TEST__.state().ready,
    null,
    { timeout: 8000 }
  );
  await page.waitForTimeout(300);
}

async function selectSize(page, size) {
  await page.click(`[data-interface-size="${size}"]`);
  await page.waitForTimeout(180);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: 'light',
      reducedMotion: 'reduce'
    });
    await context.addInitScript((value) => {
      localStorage.setItem('mutai-appearance-prod-v1', JSON.stringify(value));
    }, appearanceCache());
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });
    page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));
    await page.goto(MONITOR_URL, { waitUntil: 'load' });
    await waitForMonitor(page);

    const initial = await monitorState(page);
    assert(initial.uiSize === 'medium' && initial.fontPx === 30, '监看默认中档 30px', initial);

    await page.locator('#tableScroll').focus();
    await page.keyboard.press('j');
    await page.waitForTimeout(100);
    const kbFirst = await monitorState(page);
    await page.keyboard.press('j');
    await page.waitForTimeout(100);
    const kbSecond = await monitorState(page);
    await page.keyboard.press('k');
    await page.waitForTimeout(100);
    const kbBack = await monitorState(page);
    assert(kbFirst.selectedSeq != null && kbSecond.selectedSeq != null &&
        kbSecond.selectedSeq !== kbFirst.selectedSeq &&
        kbBack.selectedSeq === kbFirst.selectedSeq,
      '监看 J/K 可移动选中项', { first: kbFirst.selectedSeq, second: kbSecond.selectedSeq, back: kbBack.selectedSeq });
    await page.keyboard.press('Escape');

    const giftMoney = await page.evaluate(() => ({
      diamond: window.__MONITOR_TEST__.valueLabelOf({
        type: 'gift',
        meta: { gift_name: '小心心', num: 1, diamond_count: 10, coin_type: 'diamond', price: 0 }
      }),
      diamondWithPrice: window.__MONITOR_TEST__.valueLabelOf({
        type: 'gift',
        meta: { gift_name: '小心心', num: 1, diamond_count: 10, coin_type: 'diamond', price: 99 }
      }),
      cny: window.__MONITOR_TEST__.valueLabelOf({
        type: 'gift',
        meta: { gift_name: '小心心', num: 1, price: 10, total_coin: 10000, coin_type: 'gold' }
      })
    }));
    assert(giftMoney.diamond === '10钻石' && giftMoney.diamondWithPrice === '10钻石',
      '抖音礼物只显示钻石，不显示人民币', giftMoney);
    assert(giftMoney.cny === '¥10', 'B 站礼物保留人民币显示', giftMoney.cny);

    const singleEntries = await page.evaluate(() => ({
      markRead: document.querySelectorAll(
        '#markReadBtn, #markAllToolbarBtn, #unreadPill[role="button"]'
      ).length,
      unreadRole: document.getElementById('unreadPill').getAttribute('role'),
      removed: [
        'markAllToolbarBtn', 'copyMessage', 'closeInspector', 'overviewClose'
      ].filter((id) => document.getElementById(id))
    }));
    assert(singleEntries.markRead === 1 &&
        singleEntries.unreadRole === 'status' &&
        singleEntries.removed.length === 0,
      '监看每个动作只保留一个入口', singleEntries);

    const unreadFlow = await page.evaluate(async () => {
      await window.__MONITOR_TEST__.markAllRead({ silent: true });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const base = window.__MONITOR_TEST__.state();
      window.__MONITOR_TEST__.push(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterNew = window.__MONITOR_TEST__.state();
      window.__MONITOR_TEST__.setSpoken(afterNew.latestSeq, true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterRead = window.__MONITOR_TEST__.state();
      return { base, afterNew, afterRead };
    });
    assert(unreadFlow.afterNew.unread === unreadFlow.base.unread + 1,
      '新消息只增加 1 条未读，不跳变',
      { base: unreadFlow.base.unread, afterNew: unreadFlow.afterNew.unread });
    assert(unreadFlow.afterRead.lastReadSeq === unreadFlow.afterNew.latestSeq &&
        unreadFlow.afterRead.unread === unreadFlow.base.unread,
      '朗读完成后未读逐条减 1',
      unreadFlow.afterRead);

    await selectSize(page, 'small');
    const small = await page.evaluate(() => ({
      state: window.__MONITOR_TEST__.state(),
      row: Math.round(document.querySelector('.row').getBoundingClientRect().height),
      font: getComputedStyle(document.querySelector('.content-cell')).fontSize
    }));
    assert(small.state.uiSize === 'small' && small.state.fontPx === 20, '小档状态为 20px', small.state);
    assert(small.row === 44 && small.font === '20px', '小档行高 44 / 正文 20px', small);

    await selectSize(page, 'large');
    const large = await page.evaluate(() => {
      const filter = document.querySelector('#typeFilters');
      const before = getComputedStyle(document.body, '::before');
      return {
        state: window.__MONITOR_TEST__.state(),
        row: Math.round(document.querySelector('.row').getBoundingClientRect().height),
        font: getComputedStyle(document.querySelector('.content-cell')).fontSize,
        filters: {
          scroll: filter.scrollWidth,
          client: filter.clientWidth,
          overflowX: getComputedStyle(filter).overflowX
        },
        pattern: document.documentElement.dataset.apPattern,
        beforeImage: before.backgroundImage,
        beforeOpacity: before.opacity,
        panelImage: getComputedStyle(document.querySelector('.table-panel')).backgroundImage,
        topbarImage: getComputedStyle(document.querySelector('.topbar')).backgroundImage,
        body: [document.body.scrollWidth, document.body.clientWidth]
      };
    });
    assert(large.state.uiSize === 'large' && large.state.fontPx === 40, '大档状态为 40px', large.state);
    assert(large.row === 84 && large.font === '40px', '大档行高 84 / 正文 40px', large);
    assert(large.filters.scroll <= large.filters.client + 1, '1280 大档筛选项不裁切', large.filters);
    assert(large.pattern === 'dots' && /radial-gradient/.test(large.beforeImage), '监看点阵层已启用', {
      pattern: large.pattern,
      image: large.beforeImage
    });
    assert(/radial-gradient/.test(large.panelImage), '监看表格面板承载点阵，不被不透明底色挡住', {
      image: large.panelImage
    });
    assert(/radial-gradient/.test(large.topbarImage), '监看顶栏承载点阵', {
      image: large.topbarImage
    });
    assert(large.beforeOpacity === '1', '监看点阵不被 0.32 透明度削弱', large.beforeOpacity);
    assert(large.body[0] <= large.body[1], '1280 页面无横向溢出', large.body);

    await selectSize(page, 'xlarge');
    const xlarge = await page.evaluate(() => {
      const user = document.querySelector('.row.two-line .user-cell');
      const time = document.querySelector('.row.two-line .time-cell');
      const content = document.querySelector('.row.two-line .row-content');
      return {
        state: window.__MONITOR_TEST__.state(),
        row: Math.round(document.querySelector('.row').getBoundingClientRect().height),
        userFont: getComputedStyle(user).fontSize,
        userWeight: getComputedStyle(user).fontWeight,
        timeFont: time ? getComputedStyle(time).fontSize : null,
        contentFont: getComputedStyle(content).fontSize,
        body: [document.body.scrollWidth, document.body.clientWidth]
      };
    });
    assert(xlarge.state.uiSize === 'xlarge' && xlarge.state.fontPx === 50, '超大档状态为 50px', xlarge.state);
    assert(xlarge.row === 120 && xlarge.contentFont === '50px', '超大档行高 120 / 正文 50px', xlarge);
    assert(xlarge.userFont === '50px' && xlarge.userWeight === '600', '超大档用户名与正文同字号同字重', xlarge);
    assert(xlarge.timeFont === '50px', '超大档时间与正文同字号', xlarge.timeFont);
    assert(xlarge.state.layout === 'two_line', '1280 超大档使用双行布局', xlarge.state);
    assert(xlarge.body[0] <= xlarge.body[1], '1280 超大档无横向溢出', xlarge.body);

    await page.click('#inspectorToggle');
    await page.waitForTimeout(180);
    const followed = await page.evaluate(() => ({
      state: window.__MONITOR_TEST__.state(),
      open: !document.querySelector('#inspector').classList.contains('is-collapsed'),
      quoteFont: getComputedStyle(document.querySelector('#detailQuote')).fontSize,
      user: document.querySelector('#detailUser').textContent.trim(),
      body: [document.body.scrollWidth, document.body.clientWidth]
    }));
    assert(followed.open && followed.state.detailSeq != null, '打开详情时自动显示最新朗读位置', followed.state);
    assert(followed.state.detailSource === 'follow', '未手动选中时详情跟随朗读', followed.state);
    assert(followed.quoteFont === '50px', '超大档详情正文与消息正文同为 50px', followed.quoteFont);
    assert(followed.body[0] <= followed.body[1], '详情打开后仍无横向溢出', followed.body);

    const previousSeq = followed.state.detailSeq;
    await page.evaluate((seq) => {
      window.__MONITOR_TEST__.setSpoken(seq, false);
      window.__MONITOR_TEST__.setSpoken(seq - 1, true);
    }, previousSeq);
    await page.waitForTimeout(180);
    const advanced = await page.evaluate(() => ({
      state: window.__MONITOR_TEST__.state(),
      user: document.querySelector('#detailUser').textContent.trim()
    }));
    assert(advanced.state.detailSeq === previousSeq - 1, '朗读位置推进时详情同步跟随', advanced.state);
    assert(advanced.user !== followed.user, '详情切换为新的朗读者', {
      before: followed.user,
      after: advanced.user
    });
    await page.click('#inspectorToggle');

    await selectSize(page, 'large');
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForTimeout(180);
    const narrow = await page.evaluate(() => ({
      state: window.__MONITOR_TEST__.state(),
      filtersDisplay: getComputedStyle(document.querySelector('#typeFilters')).display,
      selectDisplay: getComputedStyle(document.querySelector('#filterSelectWrap')).display,
      selectOptions: document.querySelectorAll('#filterSelect option').length,
      body: [document.body.scrollWidth, document.body.clientWidth]
    }));
    assert(narrow.state.fontPx === 40 && narrow.state.layout === 'single_line', '1024 大档保持 40px 单行', narrow.state);
    assert(narrow.filtersDisplay === 'none' && narrow.selectDisplay !== 'none' && narrow.selectOptions === 6,
      '1024 大档使用完整筛选下拉', narrow);
    assert(narrow.body[0] <= narrow.body[1], '1024 页面无横向溢出', narrow.body);
    await page.selectOption('#filterSelect', 'guard');
    await page.waitForTimeout(120);
    assert((await monitorState(page)).filterType === 'guard', '窄窗筛选下拉可切换类型');

    await page.setViewportSize({ width: 760, height: 700 });
    await page.waitForTimeout(180);
    const compact = await page.evaluate(() => ({
      state: window.__MONITOR_TEST__.state(),
      filtersDisplay: getComputedStyle(document.querySelector('#typeFilters')).display,
      selectDisplay: getComputedStyle(document.querySelector('#filterSelectWrap')).display,
      body: [document.body.scrollWidth, document.body.clientWidth]
    }));
    assert(compact.state.fontPx === 40 && compact.state.layout === 'two_line', '760 大档回退双行', compact.state);
    assert(compact.filtersDisplay === 'none' && compact.selectDisplay !== 'none',
      '760 大档保留完整筛选下拉', compact);
    assert(compact.body[0] <= compact.body[1], '760 页面无横向溢出', compact.body);

    await selectSize(page, 'xlarge');
    const compactXLarge = await page.evaluate(() => ({
      state: window.__MONITOR_TEST__.state(),
      userFont: getComputedStyle(document.querySelector('.row.two-line .user-cell')).fontSize,
      body: [document.body.scrollWidth, document.body.clientWidth]
    }));
    assert(compactXLarge.state.fontPx === 50 && compactXLarge.state.layout === 'two_line', '760 超大档保持双行', compactXLarge.state);
    assert(compactXLarge.userFont === '50px', '760 超大档用户名仍为 50px', compactXLarge.userFont);
    assert(compactXLarge.body[0] <= compactXLarge.body[1], '760 超大档无横向溢出', compactXLarge.body);

    const offContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: 'light',
      reducedMotion: 'reduce'
    });
    await offContext.addInitScript((value) => {
      localStorage.setItem('mutai-appearance-prod-v1', JSON.stringify(value));
    }, appearanceCache({ monitor_pattern: false }));
    const offPage = await offContext.newPage();
    await offPage.goto(MONITOR_URL, { waitUntil: 'load' });
    await waitForMonitor(offPage);
    const disabled = await offPage.evaluate(() => ({
      pattern: document.documentElement.dataset.apPattern,
      dot: getComputedStyle(document.documentElement).getPropertyValue('--ap-dot').trim()
    }));
    assert(disabled.pattern === 'none' && disabled.dot === 'transparent', '监看点阵独立开关可关闭', disabled);
    await offContext.close();

    const appContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: 'light',
      reducedMotion: 'reduce'
    });
    await appContext.addInitScript((value) => {
      localStorage.setItem('mutai-appearance-prod-v1', JSON.stringify(value));
    }, appearanceCache());
    const app = await appContext.newPage();
    app.on('console', (message) => {
      if (message.type() === 'error') errors.push('app console: ' + message.text());
    });
    app.on('pageerror', (error) => errors.push('app pageerror: ' + error.message));
    await app.goto(APP_URL, { waitUntil: 'load' });
    await app.waitForSelector('#appearanceBtn', { timeout: 5000 });
    await app.click('#appearanceBtn');
    await app.waitForSelector('#apMask:not([hidden])', { timeout: 3000 });
    const switchBefore = await app.locator('#apMonitorDotToggle').getAttribute('aria-checked');
    assert(switchBefore === 'true', '外观设置页显示监看点阵开关（默认开）', switchBefore);
    await app.click('#apMonitorDotToggle');
    const switchAfter = await app.locator('#apMonitorDotToggle').getAttribute('aria-checked');
    assert(switchAfter === 'false', '外观设置页可单独关闭监看点阵', switchAfter);
    await app.click('#apSave');
    await app.waitForTimeout(150);
    const cached = await app.evaluate(() => JSON.parse(localStorage.getItem('mutai-appearance-prod-v1')));
    assert(cached.monitorPattern === false, '监看点阵开关写入离线草稿', cached.monitorPattern);

    assert(errors.length === 0, '页面无控制台错误', errors);
    console.log('SUMMARY monitor=pass appearance=pass');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
