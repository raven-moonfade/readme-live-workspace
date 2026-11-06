/* ============================================================
   幕台 · 弹幕流 / 配置同步 / 音色 / 连接 / 试听
   依赖 app-core 的 MutaiApp context；由 index.html 在 app-core 之后加载。
   ============================================================ */
(function () {
  "use strict";
  var ctx = window.MutaiApp;
  if (!ctx) throw new Error("MutaiApp context missing");
  var state = ctx.state;
  var els = ctx.els;
  var call = ctx.helpers.call;
  var clamp = ctx.helpers.clamp;
  var clearRoomError = ctx.helpers.clearRoomError;
  var deepMerge = ctx.helpers.deepMerge;
  var defaultConfig = ctx.helpers.defaultConfig;
  var describeEvent = ctx.helpers.describeEvent;
  var el = ctx.helpers.el;
  var errorHeadline = ctx.helpers.errorHeadline;
  var fmtSigned = ctx.helpers.fmtSigned;
  var fmtTime = ctx.helpers.fmtTime;
  var getPath = ctx.helpers.getPath;
  var guardName = ctx.helpers.guardName;
  var icon = ctx.helpers.icon;
  var numFromStr = ctx.helpers.numFromStr;
  var pollState = ctx.helpers.pollState;
  var renderAccount = ctx.helpers.renderAccount;
  var round2 = ctx.helpers.round2;
  var sampleTextForVoice = ctx.helpers.sampleTextForVoice;
  var setConnection = ctx.helpers.setConnection;
  var setLog = ctx.helpers.setLog;
  var setOverlayButtonActive = ctx.helpers.setOverlayButtonActive;
  var shake = ctx.helpers.shake;
  var showRoomError = ctx.helpers.showRoomError;
  var userColor = ctx.helpers.userColor;
  var voiceLang = ctx.helpers.voiceLang;
  var BADGE_LABEL = ctx.constants.BADGE_LABEL;
  var CANCEL_GRACE_MS = ctx.constants.CANCEL_GRACE_MS;
  var CANCEL_INTENT_MS = ctx.constants.CANCEL_INTENT_MS;
  var CJK_VOICE_LANGS = ctx.constants.CJK_VOICE_LANGS;
  var CLAMP_MIN_CHARS = ctx.constants.CLAMP_MIN_CHARS;
  var ERROR_HOLD_MS = ctx.constants.ERROR_HOLD_MS;
  var LOCALE_LABELS = ctx.constants.LOCALE_LABELS;
  var MAX_ITEMS = ctx.constants.MAX_ITEMS;
  var SLIDER_SPECS = ctx.constants.SLIDER_SPECS;
  var SYNC_FOCUS_MS = ctx.constants.SYNC_FOCUS_MS;
  var ZONE_ORDER = ctx.constants.ZONE_ORDER;

  function handleEvents(events) {
    var frag = document.createDocumentFragment();
    var appended = 0;
    var hasLong = false;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var node = buildEventNode(ev);
      if (node) {
        frag.appendChild(node);
        appended += 1;
        if (node.dataset && node.dataset.long === '1') hasLong = true;
      }
      applyEventSideEffects(ev);
    }
    if (!appended) return;
    els.streamList.appendChild(frag);
    trimStream();
    updateStreamMeta();
    if (hasLong) processLongItems();
    if (state.following) scrollToBottom();
  }

  function buildEventNode(ev) {
    if (!ev || typeof ev !== 'object') return null;
    var type = ev.type || 'danmaku';
    if (type === 'log') return null;                       // 日志只进底部状态条
    if (type === 'status' || type === 'error') return buildSysLine(ev, type);
    return buildMessageItem(ev, type);
  }

  function buildSysLine(ev, kind) {
    var text = ev.error || ev.text || (kind === 'error' ? '发生错误' : '');
    if (!text) return null;
    var node = el('div', 'sys-line ' + (kind === 'error' ? 'is-error' : 'is-info'));
    node.appendChild(el('span', 'sys-dot'));
    node.appendChild(el('span', 'sys-text', text));
    return node;
  }

  function mainTextOf(ev, type) {
    var meta = (ev.meta && typeof ev.meta === 'object') ? ev.meta : {};
    var raw = ev.text || '';
    if (raw) return raw;
    if (type === 'gift') {
      var name = meta.gift_name || '礼物';
      var num = numFromStr(meta.num, 1) || 1;
      return '送出 ' + name + (num > 1 ? ' ×' + num : '');
    }
    if (type === 'guard') return '开通了' + guardName(meta.guard_level);
    if (type === 'enter') return '进入直播间';
    if (type === 'super_chat') return meta.message || '发送了一条醒目留言';
    if (type === 'like') return '点赞了直播间';
    if (type === 'social') return meta.social_action || '关注了直播间';
    return '';
  }

  function buildMeta(ev, type) {
    var meta = (ev.meta && typeof ev.meta === 'object') ? ev.meta : {};
    if (type === 'gift') {
      var parts = [];
      var price = numFromStr(meta.price, NaN);
      var num = numFromStr(meta.num, 0);
      if (isFinite(price) && price > 0) parts.push('¥' + round2(price));
      var diamonds = numFromStr(meta.diamond_count, 0);
      if (meta.coin_type === 'diamond' && diamonds > 0) parts.push(diamonds + '钻石');
      // T2-21/R3：正文（mainTextOf 合成态）已含「×N」时 chip 只显示价格；
      // 正文是后端原文（不含数量）时才把数量补进 chip，保证数量只出现一次。
      if (ev.text && num > 1) parts.push('×' + num);
      return parts.length ? el('span', 'item-meta', parts.join(' ')) : null;
    }
    if (type === 'super_chat') {
      var p = numFromStr(meta.price, NaN);
      return (isFinite(p) && p > 0) ? el('span', 'item-meta', '¥' + round2(p)) : null;
    }
    if (type === 'guard') {
      if (!ev.text) return null;   // 正文已含舰长名称，避免重复展示
      return el('span', 'item-meta', guardName(meta.guard_level));
    }
    return null;
  }

  function buildMessageItem(ev, type) {
    var item = el('div', 'item');
    item.dataset.type = type;

    var badgeCls = BADGE_LABEL[type] ? type : 'danmaku';
    item.appendChild(el('span', 'badge badge-' + badgeCls, BADGE_LABEL[type] || type));

    var main = el('div', 'item-main');
    var line = el('div', 'item-line');

    var user = el('span', 'item-user', ev.user || '匿名');
    user.style.color = userColor(ev.uid || ev.user);
    line.appendChild(user);
    if (type !== 'enter') line.appendChild(el('span', 'item-sep', '：'));
    var bodyText = mainTextOf(ev, type);
    line.appendChild(el('span', 'item-text', bodyText));

    var meta = buildMeta(ev, type);
    if (meta) line.appendChild(meta);

    // D-102 / T2-02：消息类事件凡不是 spoken===true 都按「未朗读」渲染
    if (ev.spoken !== true) {
      line.appendChild(el('span', 'chip-unread', '未朗读'));
      item.classList.add('is-unspoken');
    }
    if (ev.error) line.appendChild(el('span', 'chip-error', '朗读失败'));

    main.appendChild(line);
    item.appendChild(main);

    item.appendChild(el('span', 'item-time', fmtTime(ev.ts)));

    var actions = el('div', 'item-actions');
    var btn = el('button', 'icon-btn item-replay');
    btn.type = 'button';
    btn.tabIndex = -1;                       // T2-06：重播按钮不再占用 Tab 序列
    btn.title = '重播这条';
    btn.setAttribute('aria-label', '重播这条');
    var svg = icon('replay', 14);
    if (svg) {
      svg.setAttribute('aria-hidden', 'true');
      btn.appendChild(svg);
    }
    btn.addEventListener('click', function () { replayEntry(ev, btn); });
    actions.appendChild(btn);
    item.appendChild(actions);

    if (String(bodyText).length > CLAMP_MIN_CHARS) item.dataset.long = '1';
    return item;
  }

  /* 超长弹幕：4 行截断 + 「展开 / 收起」（T2-10） */
  function processLongItems() {
    // 隐藏视图的测量结果为 0；保留 data-long，切回弹幕页时再处理。
    if (!els.streamList || els.streamList.clientHeight <= 0) return;
    var nodes = els.streamList.querySelectorAll('.item[data-long]');
    var budget = 30;                       // 单帧最多同步处理 30 条，其余下一帧再量
    for (var i = 0; i < nodes.length; i++) {
      if (i < budget) applyClamp(nodes[i]);
      else requestAnimationFrame(makeClampTask(nodes[i]));
    }
  }

  function makeClampTask(node) {
    return function () { applyClamp(node); };
  }

  function applyClamp(item) {
    if (!item || !item.dataset || item.dataset.long !== '1') return;
    if (item.clientHeight <= 0) return;
    delete item.dataset.long;
    item.classList.add('is-clamped');
    var line = item.querySelector('.item-line');
    if (!line) return;
    // 实际没有被截断（列宽足够）时撤销 clamp，避免无谓的交互
    if (line.scrollHeight <= line.clientHeight + 2) {
      item.classList.remove('is-clamped');
      return;
    }
    // 状态 chip 与展开按钮移到正文下方，保证截断时依然可见
    var tags = el('div', 'item-tags');
    var chips = item.querySelectorAll('.item-meta, .chip-unread, .chip-error');
    for (var i = 0; i < chips.length; i++) tags.appendChild(chips[i]);
    var toggle = el('button', 'item-expand', '展开');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    // N2：拖选文字后不响应点击，避免"想复制却展开/收起"
    toggle.addEventListener('click', function () {
      if (hasTextSelection()) return;
      toggleClamp(item, toggle);
    });
    tags.appendChild(toggle);
    var main = item.querySelector('.item-main');
    if (main) main.appendChild(tags);
  }

  function hasTextSelection() {
    try {
      var sel = window.getSelection ? window.getSelection() : null;
      return !!(sel && String(sel.toString() || '').trim());
    } catch (e) {
      return false;
    }
  }

  function toggleClamp(item, toggle) {
    if (!item || !toggle) return;
    var expanded = item.classList.toggle('is-expanded');
    toggle.textContent = expanded ? '收起' : '展开';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (!expanded && state.following) scrollToBottom();
  }

  function applyEventSideEffects(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'log') setLog(ev.text || '', 'info');
    else if (ev.type === 'status') setLog(ev.text || '');
    else if (ev.type === 'error') setLog(ev.error || ev.text || '发生错误', 'error');
    else if (Object.prototype.hasOwnProperty.call(BADGE_LABEL, ev.type)) {
      var eventMeta = ev.meta && typeof ev.meta === 'object' ? ev.meta : {};
      document.dispatchEvent(new CustomEvent('mutai:message', {
        detail: {
          type: ev.type,
          user: ev.user || '',
          uid: ev.uid || 0,
          text: ev.text || '',
          ts: ev.ts || 0,
          seq: ev.seq || 0,
          spoken: ev.spoken,
          meta: eventMeta,
          source: ev.source === 'mock' || state.isMock || eventMeta.mock ? 'mock' : 'real',
          session_id: ev.session_id || null
        }
      }));
    }
  }

  function trimStream() {
    var list = els.streamList;
    while (list.childElementCount > MAX_ITEMS) list.removeChild(list.firstElementChild);
  }

  function updateStreamMeta() {
    var n = els.streamList.childElementCount;
    var v = String(n);
    if (els.streamCount.textContent !== v) els.streamCount.textContent = v;
    els.emptyState.classList.toggle('is-hidden', n > 0);
    // T2-24：计数 chip 对读屏隐藏，标题用 aria-label 表达数量
    var label = '弹幕流，共 ' + n + ' 条';
    if (els.streamTitle.getAttribute('aria-label') !== label) {
      els.streamTitle.setAttribute('aria-label', label);
    }
  }

  /* 空状态文案随连接态变化（T2-20） */
  function renderEmptyCopy() {
    var connected = state.connection === 'connected';
    var title = connected ? '已连接，等待弹幕…' : '还没有弹幕';
    var sub = connected ? '弹幕到达后会立即朗读' : '输入直播间号并点击「连接」开始朗读';
    if (els.emptyTitle.textContent !== title) els.emptyTitle.textContent = title;
    if (els.emptySub.textContent !== sub) els.emptySub.textContent = sub;
  }

  /* 「回到底部」浮层的显隐：同步列表底部留白与 Tab 可达性（T2-04 / T2-05） */
  function setToBottomVisible(visible) {
    els.toBottomBtn.classList.toggle('is-hidden', !visible);
    els.toBottomBtn.tabIndex = visible ? 0 : -1;
    if (visible) els.toBottomBtn.removeAttribute('aria-hidden');
    else els.toBottomBtn.setAttribute('aria-hidden', 'true');
  }

  function setFollowing(following) {
    state.following = following;
    setToBottomVisible(!following);
  }

  function scrollToBottom() {
    requestAnimationFrame(function () {
      var list = els.streamList;
      list.scrollTop = list.scrollHeight;
    });
  }

  /* ============================================================
     配置同步（后端 → 控件）
     ============================================================ */
  function applyConfig(cfg, force) {
    state.config = deepMerge(state.config || defaultConfig(), cfg);
    var platform = String((state.config && state.config.platform) || state.platform || 'bilibili').toLowerCase();
    state.platform = platform === 'douyin' ? 'douyin' : 'bilibili';
    syncControls(!!force);
  }

  function markDirty() {
    state.dirtyUntil = Date.now() + 1200;
    state.lastEditAt = Date.now();
  }

  /* 仅当控件正处于「用户刚操作过」的聚焦状态时才拒绝后端回灌；
     聚焦超过 3 秒视为用户已停手，允许远端配置同步进来（见 T2 报告 §4） */
  function isEditing(node) {
    return document.activeElement === node && (Date.now() - state.lastEditAt < SYNC_FOCUS_MS);
  }

  function paintSlider(input) {
    var min = parseFloat(input.min);
    var max = parseFloat(input.max);
    var val = parseFloat(input.value);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 100;
    if (!isFinite(val)) val = min;
    var pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', clamp(pct, 0, 100).toFixed(2) + '%');
  }

  function syncControls(force) {
    if (!force && Date.now() < state.dirtyUntil) return;
    var c = state.config || defaultConfig();
    var i;

    // 滑条
    for (i = 0; i < SLIDER_SPECS.length; i++) {
      var spec = SLIDER_SPECS[i];
      var focused = isEditing(spec.el);
      var v = focused
        ? Math.round(numFromStr(spec.el.value, spec.def))
        : Math.round(numFromStr(getPath(c, spec.path), spec.def));
      v = clamp(v, spec.min, spec.max);
      if (!focused) {
        var sv = String(v);
        if (spec.el.value !== sv) spec.el.value = sv;
      }
      paintSlider(spec.el);
      var label = fmtSigned(v, spec.unit);
      if (spec.out.textContent !== label) spec.out.textContent = label;
    }

    // 开关
    var switches = document.querySelectorAll('.switch-input[data-path]');
    for (i = 0; i < switches.length; i++) {
      var input = switches[i];
      var want = !!getPath(c, input.dataset.path);
      if (!isEditing(input) && input.checked !== want) input.checked = want;
    }
    var platformRows = document.querySelectorAll('[data-platform-only]');
    for (i = 0; i < platformRows.length; i++) {
      var row = platformRows[i];
      row.hidden = row.getAttribute('data-platform-only') !== (state.platform === 'douyin' ? 'douyin' : 'bilibili');
    }

    // 数字输入
    var nums = document.querySelectorAll('input[data-num]');
    for (i = 0; i < nums.length; i++) {
      var numInput = nums[i];
      if (isEditing(numInput)) continue;
      var cur = numFromStr(numInput.value, 0);
      var val = round2(numFromStr(getPath(c, numInput.dataset.num), cur));
      var out = String(val);
      if (numInput.value !== out) numInput.value = out;
    }

    // 屏蔽词
    if (!isEditing(els.blacklistInput)) {
      var arr = getPath(c, 'filters.blacklist');
      var text = Array.isArray(arr) ? arr.join('\n') : '';
      if (els.blacklistInput.value !== text) els.blacklistInput.value = text;
    }

    // 音色
    var voice = getPath(c, 'tts.voice');
    if (typeof voice === 'string' && voice) {
      ensureVoiceOption(voice);
      if (!isEditing(els.voiceSelect) && els.voiceSelect.value !== voice) {
        els.voiceSelect.value = voice;
      }
      updateVoiceHint(els.voiceSelect.value);
    }

    // 账号登录态
    renderAccount(state.account || {});

    // 浮窗入口初始激活态
    var overlayEnabled = getPath(c, 'overlay.enabled');
    if (typeof overlayEnabled === 'boolean') {
      setOverlayButtonActive(overlayEnabled);
    }
  }

  function sendPatch(patch) {
    state.config = deepMerge(state.config || defaultConfig(), patch);
    markDirty();
    call('update_config', [patch], null).then(function (res) {
      if (res && typeof res === 'object' && res.ok === false) {
        setLog('设置保存失败：' + (res.error || '未知原因'), 'error');
      }
    });
  }

  /* ============================================================
     音色列表
     ============================================================ */
  function genderLabel(g) {
    var s = String(g || '').toLowerCase();
    if (s.indexOf('female') >= 0 || s === 'f' || s === '女') return '女';
    if (s.indexOf('male') >= 0 || s === 'm' || s === '男') return '男';
    return '';
  }

  function voiceLabelOf(v) {
    var name = v.name || v.id || '未知音色';
    var g = genderLabel(v.gender);
    return g ? String(name) + ' · ' + g : String(name);
  }

  function voiceLabel(id) {
    for (var i = 0; i < state.voices.length; i++) {
      if (String(state.voices[i].id) === String(id)) return voiceLabelOf(state.voices[i]);
    }
    return String(id);
  }

  function localeZone(locale) {
    var s = String(locale || '').replace(/_/g, '-');
    var parts = s.split('-');
    return (parts[0] || 'other').toLowerCase();
  }

  function zoneRank(zone) {
    var i = ZONE_ORDER.indexOf(zone);
    return i < 0 ? 90 : i;
  }

  function ensureVoiceOption(id) {
    var sel = els.voiceSelect;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === id) return;
    }
    var opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  }

  function updateVoiceHint(voice) {
    var hint = els.voiceLangHint;
    if (!hint) return;
    var lang = voiceLang(voice);
    if (!voice || CJK_VOICE_LANGS.indexOf(lang) >= 0) {
      hint.hidden = true;
      hint.textContent = '';
      return;
    }
    hint.hidden = false;
    hint.textContent = '仅支持对应语言，中文弹幕将跳过';
  }

  function renderVoiceOptions() {
    var sel = els.voiceSelect;
    var current = sel.value || getPath(state.config || defaultConfig(), 'tts.voice') || '';
    var groups = {};
    var i;

    for (i = 0; i < state.voices.length; i++) {
      var v = state.voices[i];
      var zone = localeZone(v.locale);
      if (!groups[zone]) groups[zone] = [];
      groups[zone].push(v);
    }

    var zones = Object.keys(groups);
    zones.sort(function (a, b) {
      var d = zoneRank(a) - zoneRank(b);
      return d !== 0 ? d : a.localeCompare(b);
    });

    while (sel.firstChild) sel.removeChild(sel.firstChild);

    var frag = document.createDocumentFragment();
    for (i = 0; i < zones.length; i++) {
      var zoneName = zones[i];
      var items = groups[zoneName].slice();
      items.sort(function (a, b) {
        var d = String(a.locale || '').localeCompare(String(b.locale || ''));
        return d !== 0 ? d : String(a.name || '').localeCompare(String(b.name || ''));
      });
      var og = document.createElement('optgroup');
      og.label = (LOCALE_LABELS[zoneName] || zoneName.toUpperCase()) + ' · ' + items.length;
      for (var t = 0; t < items.length; t++) {
        var opt = document.createElement('option');
        opt.value = String(items[t].id || items[t].name || '');
        opt.textContent = voiceLabelOf(items[t]);
        if (items[t].locale) opt.title = String(items[t].locale);
        og.appendChild(opt);
      }
      frag.appendChild(og);
    }
    sel.appendChild(frag);

    if (current) {
      ensureVoiceOption(current);
      sel.value = current;
    } else if (sel.options.length) {
      sel.selectedIndex = 0;
    }
    updateVoiceHint(sel.value);
  }

  function loadVoices(manual) {
    els.voiceRefreshBtn.classList.add('is-busy');
    return call('list_voices', [], null).then(function (list) {
      if (Array.isArray(list) && list.length) {
        state.voices = list.filter(function (v) { return v && typeof v === 'object'; });
        renderVoiceOptions();
        if (manual) setLog('音色列表已更新（' + state.voices.length + ' 个）');
      } else if (manual) {
        setLog('未能获取音色列表', 'warn');
      }
      setTimeout(function () { els.voiceRefreshBtn.classList.remove('is-busy'); }, 240);
    });
  }

  /* ============================================================
     交互动作
     ============================================================ */
  function onConnectClick() {
    if (state.connection === 'connecting') return;
    if (state.connection === 'connected') { doDisconnect(); return; }
    if (Date.now() < state.cancelHoldUntil) return;      // T2-03：取消后短暂防误触

    var raw = String(els.roomInput.value || '').trim();
    var platform = state.platform === 'douyin' ? 'douyin' : 'bilibili';
    var id = /^\d{1,18}$/.test(raw) ? parseInt(raw, 10) : NaN;
    var douyinInput = platform === 'douyin' && (
      /^\d{6,20}$/.test(raw) ||
      /^https?:\/\/(?:live|v|www)\.douyin\.com\//i.test(raw)
    );
    if (platform === 'bilibili' && (!isFinite(id) || id <= 0)) {
      var msg = (/^\d+$/.test(raw) && !(parseInt(raw, 10) > 0))
        ? '直播间号需为大于 0 的数字'
        : '请输入正确的 B站直播间号（纯数字）';
      shake(els.roomInput);
      showRoomError(msg);
      setLog(msg, 'warn');
      els.roomInput.focus();
      return;
    }
    if (platform === 'douyin' && !douyinInput) {
      var dyMsg = '请输入抖音直播间号或 live.douyin.com 链接';
      shake(els.roomInput);
      showRoomError(dyMsg);
      setLog(dyMsg, 'warn');
      els.roomInput.focus();
      return;
    }
    clearRoomError();
    state.errorHoldUntil = 0;
    state.errorTitle = '';
    state.cancelIntentUntil = 0;             // 新一次连接 = 新的意图
    state.cancelCleanup = false;
    state.roomKey = raw;
    state.roomId = platform === 'bilibili' ? id : 0;
    state.optimisticUntil = Date.now() + 3000;
    state.connectInFlight = true;
    state.connectDeadline = Date.now() + 15000;
    var seq = ++state.connectSeq;            // N1：本次连接的世代号
    setConnection('connecting');
    setLog((platform === 'douyin' ? '正在连接抖音直播间 ' : '正在连接直播间 ') + raw + ' …');
    document.dispatchEvent(new CustomEvent('mutai:session-intent', {
      detail: { room_id: state.roomId, room_key: raw, platform: platform }
    }));

    call('connect', [raw, platform], null).then(function (res) {
      if (seq !== state.connectSeq) return;  // N1：已取消/已断开/已换房号的过期回调直接丢弃
      if (res && typeof res === 'object' && res.ok === false) {
        state.optimisticUntil = 0;
        state.connectInFlight = false;
        if (res.cancelled) {                 // N1：后端确认「被取消打断」→ 中性态，不报错
          state.errorHoldUntil = 0;
          state.errorTitle = '';
          setConnection('disconnected');
          setLog('已取消连接');
          return;
        }
        var detail = res.error || '未知原因';
        state.errorHoldUntil = Date.now() + ERROR_HOLD_MS;   // T2-02
        setConnection('error', detail, errorHeadline(detail));
        setLog('连接失败：' + detail, 'error');
        return;
      }
      delete els.roomInput.dataset.touched;
      if (res && typeof res === 'object' && res.room_key) state.roomKey = String(res.room_key);
      pollState(true);
    });
  }

  function doDisconnect() {
    var seq = ++state.connectSeq;            // N1：作废在途 connect 回调
    state.optimisticUntil = Date.now() + 2500;
    state.connectInFlight = false;
    state.errorHoldUntil = 0;
    state.cancelIntentUntil = 0;
    state.cancelCleanup = false;
    setConnection('disconnected');
    setLog('正在断开连接…');
    call('disconnect', [], null).then(function (res) {
      if (seq !== state.connectSeq) return;
      if (res && typeof res === 'object' && res.ok === false) {
        setLog('断开失败：' + (res.error || '未知原因'), 'error');
      }
      pollState(true);
    });
  }

  /* 慢连接期间点「取消」：立刻回到断开态，并给一个短暂的防误触窗口（T2-03） */
  function doCancelConnect() {
    state.connectSeq += 1;                   // N1：让迟到的 connect 结果失效（成功/失败都丢弃）
    state.cancelHoldUntil = Date.now() + CANCEL_GRACE_MS;
    state.cancelIntentUntil = Date.now() + CANCEL_INTENT_MS;
    state.cancelCleanup = false;
    state.connectInFlight = false;
    state.optimisticUntil = Date.now() + 2500;
    setConnection('disconnected');
    setLog('已取消连接');
    call('disconnect', [], null);
  }

  function replayEntry(ev, btn) {
    var id = (ev && ev.id !== undefined && ev.id !== null && ev.id !== '') ? ev.id : (ev ? ev.seq : null);
    if (id === null || id === undefined || id === '') {
      setLog('这条消息无法重播', 'warn');
      return;
    }
    if (btn) btn.classList.add('is-busy');
    call('replay', [id], null).then(function (res) {
      if (res && typeof res === 'object' && res.ok === false) {
        setLog('重播失败：' + (res.error || '未知原因'), 'error');
      } else {
        var who = (ev && ev.user) ? ev.user + '：' : '';
        var body = String((ev && ev.text) ? ev.text : describeEvent(ev || {}));
        setLog('已重播：' + who + body.slice(0, 28) + (body.length > 28 ? '…' : ''));
      }
      if (btn) setTimeout(function () { btn.classList.remove('is-busy'); }, 260);
    });
  }

  function onPreview() {
    var voice = els.voiceSelect.value || getPath(state.config || defaultConfig(), 'tts.voice') || null;
    var text = String(els.previewText.value || '').trim() || sampleTextForVoice(voice);
    var rate = fmtSigned(Math.round(numFromStr(els.rateSlider.value, 0)), '%');
    var pitch = fmtSigned(Math.round(numFromStr(els.pitchSlider.value, 0)), 'Hz');
    var volume = fmtSigned(Math.round(numFromStr(els.volumeSlider.value, 0)), '%');

    setPreviewBusy(true);
    call('preview', [text, voice, rate, pitch, volume], null).then(function (res) {
      if (res && typeof res === 'object' && res.ok === false) {
        setLog('试听失败：' + (res.error || '未知原因'), 'error');
      } else {
        setLog('试听已发送：' + text.slice(0, 24) + (text.length > 24 ? '…' : ''));
      }
      setPreviewBusy(false);
    });
  }

  /* 试听加载反馈（T2-08）：图标换成旋转指示器 + 变色，而不只是「变暗」 */
  function setPreviewBusy(busy) {
    var btn = els.previewBtn;
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle('is-busy', !!busy);
    var host = btn.querySelector('.icon');
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    var svg = icon(busy ? 'spinner' : 'speaker', 14);
    if (svg) {
      svg.setAttribute('aria-hidden', 'true');
      host.appendChild(svg);
    }
  }


  ctx.modules.danmaku = {
    handleEvents: handleEvents,
    buildEventNode: buildEventNode,
    buildSysLine: buildSysLine,
    mainTextOf: mainTextOf,
    buildMeta: buildMeta,
    buildMessageItem: buildMessageItem,
    processLongItems: processLongItems,
    makeClampTask: makeClampTask,
    applyClamp: applyClamp,
    hasTextSelection: hasTextSelection,
    toggleClamp: toggleClamp,
    applyEventSideEffects: applyEventSideEffects,
    trimStream: trimStream,
    updateStreamMeta: updateStreamMeta,
    renderEmptyCopy: renderEmptyCopy,
    setToBottomVisible: setToBottomVisible,
    setFollowing: setFollowing,
    scrollToBottom: scrollToBottom,
    applyConfig: applyConfig,
    markDirty: markDirty,
    isEditing: isEditing,
    paintSlider: paintSlider,
    syncControls: syncControls,
    sendPatch: sendPatch,
    genderLabel: genderLabel,
    voiceLabelOf: voiceLabelOf,
    voiceLabel: voiceLabel,
    localeZone: localeZone,
    zoneRank: zoneRank,
    ensureVoiceOption: ensureVoiceOption,
    updateVoiceHint: updateVoiceHint,
    renderVoiceOptions: renderVoiceOptions,
    loadVoices: loadVoices,
    onConnectClick: onConnectClick,
    doDisconnect: doDisconnect,
    doCancelConnect: doCancelConnect,
    replayEntry: replayEntry,
    onPreview: onPreview,
    setPreviewBusy: setPreviewBusy
  };
})();
