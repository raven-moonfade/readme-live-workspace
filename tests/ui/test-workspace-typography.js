'use strict';
const path = require('path');
const PROJECT_ROOT = process.env.MUTAI_PROJECT_ROOT || path.resolve(__dirname, '../..');

const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');

const URL = process.env.MUTAI_UI_URL || 'file:///' + path.resolve(PROJECT_ROOT, 'ui/index.html').replace(/\\/g, '/');

function assert(condition, label, detail) {
  if (!condition) throw new Error(label + (detail === undefined ? '' : '：' + JSON.stringify(detail)));
  console.log('PASS  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
}

async function openWorkbench(page) {
  await page.click('[data-workspace-view="picture"]');
  await page.waitForSelector('#wbModal:not([hidden])', { timeout: 3000 });
  await page.waitForFunction(() => window.__wbDebug && window.__wbDebug.state.loadOk === true, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#wbTypeList [data-wb-type]').length === 6);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.click('[data-workspace-view="picture"]');
  await page.waitForSelector('#wbModal:not([hidden])', { timeout: 3000 });
  await page.waitForFunction(() => window.__wbDebug && window.__wbDebug.state.loadOk === true, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#wbTypeList [data-wb-type]').length === 6);
  await page.click('[data-wb-style-domain="typography"]');
  await page.waitForFunction(() => !document.getElementById('wbTypographyPanel').hidden);

  const initial = await page.evaluate(() => {
    const panel = document.getElementById('wbTypographyPanel');
    return {
      matrixHidden: document.getElementById('wbMatrix').hidden,
      motionHidden: document.getElementById('wbMotionPanel').hidden,
      typographyHidden: panel.hidden,
      rows: panel.querySelectorAll('[data-wb-typography-field]').length,
      count: document.getElementById('wbTypographyCount').textContent.trim(),
      coverage: document.getElementById('wbCoverageText').textContent.trim(),
      datalist: document.querySelectorAll('#wbTypographyFontList option').length,
      defaults: window.__wbDebug.resolveTypography('danmaku'),
      previewButton: getComputedStyle(document.getElementById('wbTypographyPreview')).display !== 'none',
      body: [document.body.scrollWidth, document.body.clientWidth],
    };
  });
  assert(initial.typographyHidden === false && initial.matrixHidden && initial.motionHidden, '排版域切换生效', initial);
  assert(initial.rows === 3, '排版页 3 项字段', initial);
  assert(/排版/.test(initial.count) && /本类排版覆盖/.test(initial.coverage), '排版计数与覆盖条', initial);
  assert(initial.datalist >= 5, '字体建议列表存在', initial.datalist);
  assert(initial.defaults.font_family === 'Microsoft YaHei UI' && initial.defaults.line_height === 1.55, '默认排版解析', initial.defaults);
  assert(initial.previewButton, '1280 排版预览入口可见', initial);
  assert(initial.body[0] <= initial.body[1], '1280 无横向溢出', initial.body);

  await page.click('#wbTypographyPreview');
  await page.waitForTimeout(80);
  assert(await page.evaluate(() => !document.getElementById('wbTypographyDemo').hidden), '1280 排版预览可打开');
  await page.click('#wbTypographyDemoClose');
  await page.waitForTimeout(50);
  assert(await page.evaluate(() => document.getElementById('wbTypographyDemo').hidden), '1280 排版预览可收起');

  await page.click('[data-wb-type="gift"]');
  await page.fill('[data-wb-typography-input="font_family"]', 'Consolas');
  await page.dispatchEvent('[data-wb-typography-input="font_family"]', 'change');
  await page.waitForTimeout(80);
  await page.fill('[data-wb-typography-number="line_height"]', '1.8');
  await page.dispatchEvent('[data-wb-typography-number="line_height"]', 'change');
  await page.waitForTimeout(80);
  await page.fill('[data-wb-typography-number="letter_spacing"]', '1.25');
  await page.dispatchEvent('[data-wb-typography-number="letter_spacing"]', 'change');
  await page.waitForTimeout(160);

  const gift = await page.evaluate(() => ({
    typography: window.__wbDebug.resolveTypography('gift'),
    coverage: window.__wbDebug.snapshot().typographyCoverage.gift,
  }));
  assert(gift.typography.font_family === 'Consolas', '礼物字体覆盖', gift.typography);
  assert(gift.typography.line_height === 1.8 && gift.typography.letter_spacing === 1.25, '礼物行高/字距覆盖', gift.typography);
  assert(gift.coverage === 3, '排版覆盖计数为 3', gift.coverage);

  await page.click('#wbSaveBtn');
  await page.waitForTimeout(250);
  const patch = await page.evaluate(() => window.__mockDebug && window.__mockDebug.calls.lastOverlayPatch);
  assert(patch && patch.typography && patch.typography.types && patch.typography.types.gift, '保存补丁含 typography.types', patch && patch.typography);
  assert(!patch.typography.global, '保存补丁不发送 typography.global', patch.typography);
  assert(patch.typography.types.gift.font_family === 'Consolas', '保存补丁保留字体覆盖', patch.typography.types.gift);

  // 恢复本类排版。
  await page.click('#wbRestoreType');
  await page.waitForSelector('#wbConfirmMask:not([hidden])');
  await page.click('#wbConfirmOk');
  await page.waitForTimeout(150);
  const restored = await page.evaluate(() => ({
    typography: window.__wbDebug.resolveTypography('gift'),
    coverage: window.__wbDebug.snapshot().typographyCoverage.gift,
  }));
  assert(restored.coverage === 0 && restored.typography.font_family === 'Microsoft YaHei UI', '恢复本类排版清除 3 项', restored);

  // 1024/760 无溢出；760 五类切换条可用。
  for (const viewport of [{ width: 1024, height: 700 }, { width: 760, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => ({
      body: [document.body.scrollWidth, document.body.clientWidth],
      panelVisible: !document.getElementById('wbTypographyPanel').hidden,
      strip: getComputedStyle(document.getElementById('wbTypeStrip')).display !== 'none',
      previewButton: getComputedStyle(document.getElementById('wbTypographyPreview')).display !== 'none',
    }));
    assert(layout.body[0] <= layout.body[1] && layout.panelVisible && layout.previewButton,
      viewport.width + ' 排版页无溢出且预览入口可见', layout);
    if (viewport.width === 760) assert(layout.strip, '760 五类切换条可用', layout);
  }

  await page.click('#wbTypographyPreview');
  await page.waitForTimeout(80);
  assert(await page.evaluate(() => !document.getElementById('wbTypographyDemo').hidden), '小屏排版预览抽屉可打开');

  // Six-layer preset import: content/layout are applied to the existing overlay patch.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('[data-wb-tab="presets"]');
  const presetPack = {
    format: 'readme.danmaku-preset',
    format_version: 1,
    name: 'UI preset fixture',
    preset: { id: 'qa.ui-preset', name: 'UI preset fixture', version: '1.0.0' },
    layers: {
      content: { show_name: false, max_lines: 3, name_max_len: 7, text_max_len: 42 },
      style: {
        theme: 'shortvideo',
        global: { font_size: 31 },
        types: { gift: { text_color: '#FFAA00' } },
        typography: {
          global: { font_family: 'Consolas', line_height: 1.7 },
        },
      },
      layout: { align: 'center', gap_px: 12 },
      animation: {
        global: { enter_anim: 'scale', enter_ms: 300 },
        types: { gift: { exit_ms: 200 } },
      },
      template: { id: 'focus' },
    },
  };
  await page.fill('#wbPresetText', JSON.stringify(presetPack));
  await page.click('#wbPresetValidate');
  assert((await page.textContent('#wbPresetStatus')).includes('校验通过'), '预设包校验通过');
  assert(!(await page.isDisabled('#wbPresetApply')), '预设包可应用');
  await page.click('#wbPresetApply');
  const presetDraft = await page.evaluate(() => window.__wbPresetDebug().current.layers);
  assert(presetDraft.content.show_name === false && presetDraft.content.max_lines === 3, '预设内容层写入草稿', presetDraft.content);
  assert(presetDraft.layout.align === 'center' && presetDraft.layout.gap_px === 12, '预设布局层写入草稿', presetDraft.layout);
  assert(presetDraft.style.theme === 'shortvideo' && presetDraft.style.global.font_size === 31,
    '预设样式层写入草稿', presetDraft.style);
  assert(presetDraft.animation.global.enter_anim === 'scale' &&
    presetDraft.animation.types.gift.exit_ms === 200, '预设动画层写入草稿', presetDraft.animation);
  assert(presetDraft.style.typography.global.font_family === 'Consolas' &&
    presetDraft.style.typography.global.line_height === 1.7, '预设排版层写入草稿', presetDraft.style.typography);
  assert(presetDraft.template.id === 'focus', '预设模板层写入草稿', presetDraft.template);
  await page.click('#wbSaveBtn');
  await page.waitForTimeout(250);
  const presetPatch = await page.evaluate(() => window.__mockDebug && window.__mockDebug.calls.lastOverlayPatch);
  assert(presetPatch && presetPatch.show_name === false && presetPatch.max_lines === 3, '预设内容层进入保存补丁', presetPatch);
  assert(presetPatch.align === 'center' && presetPatch.gap === 12, '预设布局层进入保存补丁', presetPatch);
  assert(presetPatch.styles.theme === 'shortvideo' &&
    presetPatch.styles.global.font_size === 31, '预设样式层进入保存补丁', presetPatch.styles);
  assert(presetPatch.styles.types.gift.text_color === '#FFAA00', '预设分类样式进入保存补丁', presetPatch.styles.types.gift);
  assert(presetPatch.motion.global.enter_anim === 'scale' &&
    presetPatch.motion.global.enter_ms === 300, '预设动画全局层进入保存补丁', presetPatch.motion.global);
  assert(presetPatch.typography.global.font_family === 'Consolas' &&
    presetPatch.typography.global.line_height === 1.7, '预设排版全局层进入保存补丁', presetPatch.typography.global);
  assert(presetPatch.template_id === 'focus', '模板 ID 进入保存补丁', presetPatch.template_id);

  await page.click('#wbCloseBtn');
  await page.waitForTimeout(120);
  await openWorkbench(page);
  await page.click('[data-wb-tab="presets"]');
  const reopenedTemplate = await page.evaluate(() => document.getElementById('wbPresetTemplate').value);
  assert(reopenedTemplate === 'focus', '模板 ID 重新打开后保留', reopenedTemplate);

  const security = await page.evaluate(() => {
    const api = window.MutaiApp.modules.wbPresets;
    const parse = (text) => {
      try {
        const result = api.parsePack(text);
        return { ok: true, layers: result.layers };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    };
    const oversized = 'x'.repeat(1048576 + 1);
    const base = '{"format":"readme.danmaku-preset","format_version":1,"layers":';
    return {
      oversized: parse(oversized),
      badFormat: parse('{"format":"other","layers":{"content":{"show_name":true}}}'),
      missingVersion: parse('{"format":"readme.danmaku-preset","layers":{"content":{"show_name":true}}}'),
      badVersion: parse('{"format":"readme.danmaku-preset","format_version":2,"layers":{"content":{"show_name":true}}}'),
      noLayers: parse(base + '{}}'),
      arrayLayer: parse(base + '{"content":[]}}'),
      badEnum: parse(base + '{"layout":{"align":"diagonal"}}}'),
      invalidRange: parse(base + '{"content":{"name_max_len":999,"text_max_len":0,"max_lines":99},"layout":{"gap_px":-5}}}'),
      invalidStyle: parse(base + JSON.stringify({ style: { theme: 'classic', global: { font_size: 1, font_weight: 800 } } }) + '}'),
      unknown: parse(base + '{"content":{"show_name":false,"evil":"<img src=x onerror=alert(1)>"},"style":{"theme":"classic","global":{"font_size":24,"evil":true}}}}'),
      duplicate: parse(base + '{"content":{"max_lines":2,"max_lines":9}}}'),
    };
  });
  assert(security.oversized.ok === false && /1 MiB/.test(security.oversized.error), '超 1MiB 预设被拒绝', security.oversized);
  assert(security.badFormat.ok === false && /format/.test(security.badFormat.error), '非法格式被拒绝', security.badFormat);
  assert(security.missingVersion.ok === false && /format_version/.test(security.missingVersion.error),
    '缺失版本被拒绝', security.missingVersion);
  assert(security.badVersion.ok === false && /format_version/.test(security.badVersion.error),
    '不兼容版本被拒绝', security.badVersion);
  assert(security.noLayers.ok === false && /没有可应用的层/.test(security.noLayers.error), '无层预设被拒绝', security.noLayers);
  assert(security.arrayLayer.ok === false && /content/.test(security.arrayLayer.error),
    '数组层被拒绝', security.arrayLayer);
  assert(security.badEnum.ok === false && /layout.align/.test(security.badEnum.error), '非法枚举被拒绝', security.badEnum);
  assert(security.invalidRange.ok === false && /name_max_len/.test(security.invalidRange.error),
    '越界数值被拒绝', security.invalidRange);
  assert(security.invalidStyle.ok === false && /font_size|font_weight/.test(security.invalidStyle.error),
    '非法样式值被拒绝', security.invalidStyle);
  assert(security.unknown.ok === true &&
    security.unknown.layers.content.evil === undefined &&
    security.unknown.layers.style.global.evil === undefined, '未知字段不会进入应用层', security.unknown);
  assert(security.duplicate.ok === true &&
    security.duplicate.layers.content.max_lines === 9, '重复 JSON 字段按最后一值处理', security.duplicate);

  await page.fill('#wbPresetText', '{"format":"readme.danmaku-preset","format_version":1,"name":"<img src=x onerror=alert(1)>","layers":{"content":{"show_name":true}}}');
  await page.click('#wbPresetValidate');
  const xss = await page.evaluate(() => ({
    text: document.getElementById('wbPresetStatus').textContent,
    img: !!document.querySelector('#wbPresetStatus img'),
    anyInjected: !!document.querySelector('img[src="x"]'),
  }));
  assert(xss.text.includes('<img src=x onerror=alert(1)>') && !xss.img && !xss.anyInjected,
    '预设名称按纯文本显示', xss);

  // Validation must be bound to the current textarea; editing invalidates it.
  const beforeMeta = await page.evaluate(() =>
    window.__wbPresetDebug().importedMeta && window.__wbPresetDebug().importedMeta.name
  );
  await page.fill('#wbPresetText', JSON.stringify({
    format: 'readme.danmaku-preset',
    format_version: 1,
    name: 'meta-only',
    preset: { id: 'meta-only', name: 'meta-only', version: '1.0.0' },
    layers: { content: { show_name: true } },
  }));
  await page.click('#wbPresetValidate');
  const afterValidateMeta = await page.evaluate(() =>
    window.__wbPresetDebug().importedMeta && window.__wbPresetDebug().importedMeta.name
  );
  assert(afterValidateMeta === beforeMeta, '仅校验不写入预设元数据', { beforeMeta, afterValidateMeta });
  await page.fill('#wbPresetText', JSON.stringify({
    format: 'readme.danmaku-preset',
    format_version: 1,
    name: 'changed-after-validate',
    layers: { content: { max_lines: 4 } },
  }));
  const invalidatedPreset = await page.evaluate(() => ({
    disabled: document.getElementById('wbPresetApply').disabled,
    parsed: window.__wbPresetDebug().parsed,
    status: document.getElementById('wbPresetStatus').textContent,
  }));
  assert(invalidatedPreset.disabled && invalidatedPreset.parsed === null &&
    invalidatedPreset.status.includes('重新校验'), '修改 JSON 后旧解析失效', invalidatedPreset);

  // Empty layer selection must not dirty or mutate the draft.
  await page.fill('#wbPresetText', JSON.stringify({
    format: 'readme.danmaku-preset',
    format_version: 1,
    layers: { content: { show_name: true } },
  }));
  await page.click('#wbPresetValidate');
  await page.evaluate(() => {
    document.querySelectorAll('[data-wb-preset-layer]').forEach((el) => { el.checked = false; });
  });
  const beforeEmptyApply = await page.evaluate(() =>
    JSON.stringify(window.__wbPresetDebug().current.layers)
  );
  await page.click('#wbPresetApply');
  await page.waitForTimeout(80);
  const emptyApply = await page.evaluate(() => ({
    after: JSON.stringify(window.__wbPresetDebug().current.layers),
    status: document.getElementById('wbPresetStatus').textContent,
  }));
  assert(beforeEmptyApply === emptyApply.after && emptyApply.status.includes('没有勾选'),
    '未选层时不修改草稿', emptyApply);

  // Layer patches merge; a style-only package must not erase other style fields.
  await page.evaluate(() => {
    document.querySelectorAll('[data-wb-preset-layer]').forEach((el) => { el.checked = true; });
  });
  await page.fill('#wbPresetText', JSON.stringify({
    format: 'readme.danmaku-preset',
    format_version: 1,
    layers: { style: { theme: 'classic', global: { font_size: 24 } } },
  }));
  await page.click('#wbPresetValidate');
  await page.click('#wbPresetApply');
  await page.waitForTimeout(80);
  const styleBeforeMerge = await page.evaluate(() =>
    window.__wbPresetDebug().current.layers.style.global.font_size
  );
  await page.fill('#wbPresetText', JSON.stringify({
    format: 'readme.danmaku-preset',
    format_version: 1,
    layers: { style: { global: { bg_opacity: 40 } } },
  }));
  await page.click('#wbPresetValidate');
  await page.click('#wbPresetApply');
  await page.waitForTimeout(80);
  const mergedStyle = await page.evaluate(() => {
    const global = window.__wbPresetDebug().current.layers.style.global;
    return { font_size: global.font_size, bg_opacity: global.bg_opacity };
  });
  assert(styleBeforeMerge === 24 && mergedStyle.font_size === 24 && mergedStyle.bg_opacity === 40,
    '样式层按补丁合并', mergedStyle);

  // Dirty close asks first; cancel keeps the workbench open.
  await page.fill('#wbPresetMaxLines', '4');
  await page.dispatchEvent('#wbPresetMaxLines', 'change');
  const formInvalidated = await page.evaluate(() => ({
    parsed: window.__wbPresetDebug().parsed,
    disabled: document.getElementById('wbPresetApply').disabled,
    value: document.getElementById('wbPresetMaxLines').value,
  }));
  assert(formInvalidated.parsed === null && formInvalidated.disabled && formInvalidated.value === '4',
    '修改预设表单后旧解析失效', formInvalidated);
  await page.click('#wbCloseBtn');
  await page.waitForTimeout(80);
  const discardPrompt = await page.evaluate(() => ({
    open: !document.getElementById('wbConfirmMask').hidden,
    title: document.getElementById('wbConfirmTitle').textContent,
    workbenchOpen: !document.getElementById('wbModal').hidden,
  }));
  assert(discardPrompt.open && discardPrompt.title.includes('未保存') && discardPrompt.workbenchOpen,
    '未保存关闭先确认', discardPrompt);
  await page.click('#wbConfirmCancel');
  await page.waitForTimeout(60);
  assert(await page.evaluate(() => !document.getElementById('wbModal').hidden), '取消关闭后工作台仍打开');

  // A saved close clears the parsed import, so an old package cannot be applied later.
  await page.click('#wbSaveBtn');
  await page.waitForTimeout(300);
  await page.click('#wbCloseBtn');
  await page.waitForTimeout(100);
  await openWorkbench(page);
  await page.click('[data-wb-tab="presets"]');
  const reopenedImport = await page.evaluate(() => ({
    parsed: window.__wbPresetDebug().parsed,
    disabled: document.getElementById('wbPresetApply').disabled,
  }));
  assert(reopenedImport.parsed === null && reopenedImport.disabled,
    '重开后旧导入包不可应用', reopenedImport);

  assert(errors.length === 0, '无控制台错误', errors);
  await browser.close();
  console.log('\nSUMMARY  PASS');
})().catch((err) => {
  console.error('FAIL  ' + err.stack);
  process.exit(1);
});

