'use strict';

const path = require('path');
const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');
const root = path.resolve(__dirname, '..');
const url = 'file:///' + path.join(root, 'ui/index.html').replace(/\\/g, '/');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForTimeout(1200);
  await page.click('[data-workspace-view="picture"]');
  await page.waitForTimeout(1200);
  await page.click('[data-wb-tab="rules"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(process.env.TEMP || root, 'rules-bili.png') });
  const bili = await page.$$eval('#wbRulesBody tr', (rows) =>
    rows.map((row) => row.getAttribute('data-wb-lane')));
  await page.evaluate(() => {
    const select = document.getElementById('platformSelect');
    select.disabled = false;
    select.value = 'douyin';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(800);
  const douyin = await page.$$eval('#wbRulesBody tr', (rows) =>
    rows.map((row) => row.getAttribute('data-wb-lane')));
  const zeros = await page.evaluate(() => ({
    durationMin: document.querySelector('input[data-wb-pin-field="duration_ms"]')?.getAttribute('min'),
    maxMin: document.querySelector('input[data-wb-pin-field="max"]')?.getAttribute('min'),
    hints: document.querySelectorAll('.wb-zero-hint').length,
    danmakuCountControls: document.querySelectorAll(
      'tr[data-wb-lane="danmaku"] input[data-wb-pin-field="max"]'
    ).length,
    enterCountControls: document.querySelectorAll(
      'tr[data-wb-lane="enter"] input[data-wb-pin-field="max"]'
    ).length
  }));
  await page.click('[data-wb-tab="style"]');
  await page.waitForTimeout(300);
  const styleTypes = await page.$$eval('#wbTypeList [data-wb-type]', (els) =>
    els.map((el) => el.getAttribute('data-wb-type')));
  await page.click('[data-wb-tab="debug"]');
  await page.waitForTimeout(300);
  const mockTypes = await page.$$eval('#wbMockTypes [data-wb-mock-type]', (els) =>
    els.map((el) => el.getAttribute('data-wb-mock-type')));
  const mockKinds = await page.$$eval('#wbMockKind option', (els) =>
    els.map((el) => el.value));
  await page.screenshot({ path: path.join(process.env.TEMP || root, 'rules-douyin.png') });
  console.log(JSON.stringify({ bili, douyin, zeros, styleTypes, mockTypes, mockKinds, errors }, null, 2));
  await browser.close();
  const expected = ['danmaku', 'gift', 'enter', 'like', 'social', 'fansclub'];
  if (errors.length || bili.length !== 6 || douyin.length !== 6 ||
      styleTypes.length !== 6 || mockTypes.length !== 6 ||
      JSON.stringify(styleTypes) !== JSON.stringify(expected) ||
      JSON.stringify(mockTypes) !== JSON.stringify(expected) ||
      JSON.stringify(mockKinds) !== JSON.stringify(expected) ||
      zeros.danmakuCountControls !== 0 || zeros.enterCountControls !== 0) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
