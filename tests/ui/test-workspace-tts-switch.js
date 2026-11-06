'use strict';

const path = require('path');
const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');
const PROJECT_ROOT = process.env.MUTAI_PROJECT_ROOT || path.resolve(__dirname, '../..');
const URL = 'file:///' + path.resolve(PROJECT_ROOT, 'ui/index.html').replace(/\\/g, '/');

function assert(condition, label, detail) {
  if (!condition) {
    throw new Error(label + (detail === undefined ? '' : '：' + JSON.stringify(detail)));
  }
  console.log('PASS  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
}

async function readState(page) {
  return page.evaluate(() => {
    const input = document.querySelector('.switch-input[data-path="tts.enabled"]');
    return {
      exists: Boolean(input),
      checked: Boolean(input && input.checked),
      voiceDisabled: Boolean(document.getElementById('voiceSelect')?.disabled),
      previewDisabled: Boolean(document.getElementById('previewBtn')?.disabled),
      hint: document.getElementById('ttsMasterHint')?.textContent || '',
      config: window.MutaiApp?.state?.config?.tts?.enabled,
      voiceCardOff: document.getElementById('settingsVoiceCard')?.classList.contains('is-tts-off')
    };
  });
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(URL);
  await page.waitForFunction(
    () => window.MutaiApp && window.MutaiApp.state && window.MutaiApp.state.config,
    null,
    { timeout: 8000 }
  );
  await page.click('[data-workspace-view="settings"]');
  await page.waitForTimeout(250);

  const initial = await readState(page);
  assert(initial.exists && initial.checked === true && initial.config === true,
    '全局朗读开关默认开启', initial);
  assert(initial.voiceDisabled === false && initial.previewDisabled === false,
    '默认开启时语音控件可用', initial);

  await page.evaluate(() => {
    document.querySelector('.switch-input[data-path="tts.enabled"]').click();
  });
  await page.waitForTimeout(500);
  const off = await readState(page);
  assert(off.checked === false && off.config === false,
    '关闭开关写入配置', off);
  assert(off.voiceDisabled === true && off.previewDisabled === true,
    '关闭后音色与试听控件禁用', off);
  assert(off.voiceCardOff === true && off.hint.includes('朗读已关闭'),
    '关闭后朗读卡片显示明确状态', off);

  await page.evaluate(() => {
    document.querySelector('.switch-input[data-path="tts.enabled"]').click();
  });
  await page.waitForTimeout(500);
  const on = await readState(page);
  assert(on.checked === true && on.config === true && on.voiceDisabled === false,
    '重新开启后控件恢复', on);
  assert(errors.length === 0, '页面无控制台错误', errors);

  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
