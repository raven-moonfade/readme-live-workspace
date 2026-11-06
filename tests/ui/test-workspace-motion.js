'use strict';
const path = require('path');
const PROJECT_ROOT = process.env.MUTAI_PROJECT_ROOT || path.resolve(__dirname, '../..');

const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');

const URL = process.env.MUTAI_UI_URL || 'file:///' + path.resolve(PROJECT_ROOT, 'ui/index.html').replace(/\\/g, '/');

function assert(condition, label, detail) {
  if (!condition) {
    throw new Error(label + (detail === undefined ? '' : '：' + JSON.stringify(detail)));
  }
  console.log('PASS  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
}

async function openWorkbench(page) {
  await page.click('[data-workspace-view="picture"]');
  await page.waitForSelector('#wbModal:not([hidden])', { timeout: 3000 });
  await page.waitForFunction(() => {
    const list = document.getElementById('wbTypeList');
    return list && list.children.length === 6;
  }, null, { timeout: 3000 });
}

async function openMotion(page) {
  await page.click('[data-wb-style-domain="motion"]');
  await page.waitForFunction(() => {
    const panel = document.getElementById('wbMotionPanel');
    return panel && !panel.hidden;
  }, null, { timeout: 2000 });
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await openWorkbench(page);
  await openMotion(page);

  const initial = await page.evaluate(() => {
    const panel = document.getElementById('wbMotionPanel');
    const rows = [...panel.querySelectorAll('[data-wb-motion-field]')];
    return {
      matrixHidden: document.getElementById('wbMatrix').hidden,
      panelHidden: panel.hidden,
      coreCards: document.querySelectorAll('#wbMotionCore .wb-motion-card').length,
      advancedCards: document.querySelectorAll('#wbMotionAdvancedGrid .wb-motion-card').length,
      rows: rows.length,
      coreRows: document.querySelectorAll('#wbMotionCore [data-wb-motion-field]').length,
      advancedRows: document.querySelectorAll('#wbMotionAdvancedGrid [data-wb-motion-field]').length,
      count: document.getElementById('wbMotionCount').textContent.trim(),
      coverage: document.getElementById('wbCoverageText').textContent.trim(),
      notes: [...panel.querySelectorAll('.wb-motion-note')].map((n) => n.textContent).join(' '),
      defaults: window.__wbDebug.resolveMotion('danmaku'),
      body: [document.body.scrollWidth, document.body.clientWidth],
    };
  });
  assert(initial.matrixHidden === true && initial.panelHidden === false, '外观/动效切换生效', initial);
  assert(initial.coreCards === 2 && initial.advancedCards === 2, '两张核心卡 + 两张高级卡', initial);
  assert(initial.rows === 12 && initial.coreRows === 6 && initial.advancedRows === 6, '12 项动效字段', initial);
  assert(/6 项核心/.test(initial.count), '动效首层提示 6 核心 + 6 高级', initial.count);
  assert(/本类动效覆盖/.test(initial.coverage), '覆盖条切换到动效域', initial.coverage);
  assert(/高密度保护/.test(initial.notes) && /≤120ms/.test(initial.notes), '动效页显示高密度与固定区说明', initial.notes);
  assert(initial.defaults.enter_anim === 'slide' && initial.defaults.exit_anim === 'fade', '默认动效与后端一致', initial.defaults);
  assert(initial.body[0] <= initial.body[1], '1280 无横向溢出', initial.body);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(80);
  assert(await page.evaluate(() => !document.getElementById('wbMotionReduced').hidden),
    '系统减少动态效果时提示实时出现');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(80);
  assert(await page.evaluate(() => document.getElementById('wbMotionReduced').hidden),
    '系统恢复动态效果后提示实时隐藏');

  const frames = await page.evaluate(() => ({
    enter: window.__wbDebug.motionFrame('enter', 0.5),
    exit: window.__wbDebug.motionFrame('exit', 0.5),
  }));
  assert(Math.abs(frames.enter.dx - 3.7125) < 0.02 && Math.abs(frames.enter.opacity - 0.875) < 0.001,
    'JS 入场采样与 Python 对齐', frames.enter);
  assert(Math.abs(frames.exit.dy + 0.5) < 0.02 && Math.abs(frames.exit.opacity - 0.875) < 0.001,
    'JS 退场采样与 Python 对齐', frames.exit);

  // 切换到礼物并覆盖入场方式/时长。
  await page.click('[data-wb-type="gift"]');
  await page.click('[data-wb-motion-set="enter_anim"][data-wb-motion-value="scale"]');
  await page.fill('[data-wb-motion-number="enter_ms"]', '400');
  await page.press('[data-wb-motion-number="enter_ms"]', 'Enter');
  await page.waitForTimeout(120);
  const gift = await page.evaluate(() => ({
    motion: window.__wbDebug.resolveMotion('gift'),
    count: document.getElementById('wbMotionCount').textContent.trim(),
    coverage: window.__wbDebug.snapshot().motionCoverage.gift,
    saveText: document.getElementById('wbSaveBtn').textContent.trim(),
  }));
  assert(gift.motion.enter_anim === 'scale' && gift.motion.enter_ms === 400, '礼物入场覆盖生效', gift.motion);
  assert(gift.coverage === 2, '动效覆盖计数更新', gift);
  assert(/保存/.test(gift.saveText), '覆盖变更后保存按钮可读', gift.saveText);

  // 高级折叠展开与单项恢复。
  await page.click('#wbMotionAdvanced summary');
  const advancedOpen = await page.evaluate(() => document.getElementById('wbMotionAdvanced').open);
  assert(advancedOpen === true, '高级折叠可展开');
  await page.click('[data-wb-motion-reset="enter_anim"]');
  const restored = await page.evaluate(() => ({
    motion: window.__wbDebug.resolveMotion('gift'),
    coverage: window.__wbDebug.snapshot().motionCoverage.gift,
  }));
  assert(restored.motion.enter_anim === 'slide' && restored.coverage === 1, '单项恢复只清一项', restored);

  // 保存补丁包含 motion.types。
  await page.click('#wbSaveBtn');
  await page.waitForTimeout(250);
  const patch = await page.evaluate(() => window.__mockDebug && window.__mockDebug.calls.lastOverlayPatch);
  assert(patch && patch.motion && patch.motion.types && patch.motion.types.gift, '保存补丁包含 motion.types', patch && patch.motion);
  assert(patch.motion.types.gift.enter_ms === 400, '保存补丁保留 gift 动效覆盖', patch.motion.types.gift);
  assert(!patch.motion.global, '工作台保存不覆盖 global 基线', patch.motion);

  // 1024 / 760：预览隐藏，动效卡片仍可用且无横向溢出。
  for (const viewport of [{ width: 1024, height: 700 }, { width: 760, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      document.getElementById('wbModal').hidden = false;
    });
    const layout = await page.evaluate(() => {
      return {
        body: [document.body.scrollWidth, document.body.clientWidth],
        cards: document.querySelectorAll('#wbMotionCore .wb-motion-card').length,
      };
    });
    assert(layout.body[0] <= layout.body[1], viewport.width + ' 无横向溢出', layout.body);
    assert(layout.cards === 2, viewport.width + ' 动效卡片仍存在', layout);
    if (viewport.width === 760) {
      const columns = await page.evaluate(() => getComputedStyle(document.getElementById('wbMotionCore')).gridTemplateColumns);
      assert(columns.split(' ').length === 1, '760 动效卡片单列', columns);
      const strip = await page.evaluate(() => ({
        visible: getComputedStyle(document.getElementById('wbTypeStrip')).display !== 'none',
        count: document.querySelectorAll('#wbTypeStrip [data-wb-type]').length,
      }));
      assert(strip.visible && strip.count === 6, '760 六类切换条可用', strip);
      await page.click('#wbTypeStrip [data-wb-type="danmaku"]');
      const type = await page.evaluate(() => window.__wbDebug.state.currentType);
      assert(type === 'danmaku', '760 可切换消息类型', type);
    }
  }

  // 关闭再打开，确认动效域和值保留（mock 内存配置）。
  await page.click('#wbCloseAction');
  await page.waitForTimeout(100);
  await openWorkbench(page);
  await openMotion(page);
  const reopened = await page.evaluate(() => ({
    count: document.getElementById('wbMotionCount').textContent.trim(),
    motion: window.__wbDebug.resolveMotion('gift'),
  }));
  assert(reopened.motion.enter_ms === 400, '重新打开后动效值保留', reopened);

  assert(errors.length === 0, '无控制台错误', errors);
  await browser.close();
  console.log('\nSUMMARY  PASS');
})().catch((err) => {
  console.error('FAIL  ' + err.stack);
  process.exit(1);
});

