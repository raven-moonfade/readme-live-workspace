/* ============================================================
   弹幕朗读器 · UI 控制器
   - 生产环境：调用 window.pywebview.api.*（冻结契约）
   - 浏览器直接打开：自动进入 Mock 模式，方便预览与迭代
   零依赖、零外部请求。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var POLL_INTERVAL = 400;      // poll_events 间隔（可见时）
  var STATE_INTERVAL = 1000;    // get_state 间隔（可见时）
  var HEARTBEAT = 200;          // 调度器心跳
  var HIDDEN_FACTOR = 5;        // 页面隐藏时的降频倍数
  var MAX_ITEMS = 500;          // 弹幕流最多保留的 DOM 节点数
  var SAMPLE_TEXT = '大家好，欢迎来到直播间，这是一段试听语音。';
  var SAMPLE_TEXT_BY_LANG = {
    zh: '大家好，欢迎来到直播间，这是一段试听语音。',
    en: 'Hello, this is a sample of the selected voice.',
    ja: 'こんにちは。これは選択した音声のサンプルです。',
    ko: '안녕하세요. 선택한 음성의 샘플입니다.'
  };
  var CJK_VOICE_LANGS = ['zh', 'ja', 'ko'];
  function voiceLang(voice) {
    return String(voice || '').split('-')[0].toLowerCase();
  }
  function sampleTextForVoice(voice) {
    var lang = voiceLang(voice);
    return SAMPLE_TEXT_BY_LANG[lang] || SAMPLE_TEXT_BY_LANG.en;
  }
  var DETECT_TIMEOUT = 900;     // 等待 pywebviewready 的时间
  var CLAMP_MIN_CHARS = 100;    // 超过该长度的弹幕做 4 行截断（T2-10）
  var ERROR_HOLD_MS = 6000;     // 错误态最短存续时间（T2-02）
  var CANCEL_GRACE_MS = 1500;   // 取消连接后的防误触窗口（T2-03）
  var CANCEL_INTENT_MS = 10000; // 取消意图有效期：期间后端若迟到连上则主动收尾（N1）
  var LOG_DECAY_MS = 6000;      // 一次性日志回落到「就绪」的时间（T2-28）
  var SYNC_FOCUS_MS = 3000;     // 控件聚焦后超过该时长即接受后端回灌
  var LOG_IDLE = '就绪';

  var DEFAULT_CONFIG = {
    room_id: 0,
    platform: 'bilibili',
    tts: { enabled: true, voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%' },
    read: {
      danmaku: true, gift: true, super_chat: true, guard: true, enter: false,
      like: false, social: true, fansclub: true,
      gift_min_price: 0, include_user: true,
      templates: {
        danmaku: '{user}说：{text}',
        gift: '感谢{user}送出的{gift_name}乘以{num}',
        super_chat: '{user}的醒目留言：{message}',
        guard: '感谢{user}开通{guard_name}',
        enter: '{user}进入直播间',
        like: '{user}点了赞',
        social: '{user}{social_action}',
        fansclub: '{user}{fansclub_action}'
      }
    },
    filters: { blacklist: [], dedup_seconds: 5, max_len: 80, user_cooldown: 3, global_cooldown: 0.5 },
    queue: { max_size: 30 },
    overlay: {
      enabled: false,
      x: 60,
      y: 120,
      width: 520,
      height: 620,
      scale: 1.0,
      font_family: 'Microsoft YaHei UI',
      font_size: 22,
      font_weight: 600,
      line_height: 1.55,
      color: '#FFFFFF',
      name_color: '#8FE3FF',
      name_sep: '：',
      show_name: true,
      name_max_len: 12,
      text_max_len: 70,
      outline: true,
      outline_color: '#000000',
      outline_width: 2,
      shadow: true,
      bg_color: '#000000',
      bg_opacity: 0.22,
      opacity: 1,
      align: 'left',
      max_lines: 8,
      animation: 'slide',
      dwell_ms: 12000,
      gap: 8,
      types: {
        danmaku: true,
        gift: true,
        super_chat: true,
        guard: true,
        enter: false,
        like: true,
        social: true,
        fansclub: true
      },
      gift_pin: false,
      gift_pin_position: 'bottom',
      gift_pin_duration_ms: 15000,
      gift_pin_max: 3,
      gift_pin_min_price: 0,
      click_through: true,
      always_on_top: true,
      show_avatar: false,
      theme: 'classic'
    },
    mock: {
      interval_ms: 1500,
      per_tick: 1,
      speak: true,
      types: {
        danmaku: true,
        gift: false,
        super_chat: false,
        guard: false,
        enter: false,
        like: false,
        social: false,
        fansclub: false
      }
    }
  };

  var BADGE_LABEL = {
    danmaku: '弹幕', gift: '礼物', super_chat: 'SC', guard: '上舰',
    enter: '入场', like: '点赞', social: '关注', fansclub: '粉丝团'
  };
  var USER_COLOR_VARS = [
    '--user-c1', '--user-c2', '--user-c3', '--user-c4', '--user-c5',
    '--user-c6', '--user-c7', '--user-c8', '--user-c9', '--user-c10'
  ];

  var ICONS = {
    replay:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.6V10h-5.4"/></svg>',
    speaker:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M11 5 6.5 8.8H3.5v6.4h3L11 19V5Z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/></svg>',
    spinner:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3a9 9 0 1 0 9 9"/></svg>'
  };

  var LOCALE_LABELS = {
    zh: '中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语',
    es: '西班牙语', ru: '俄语', it: '意大利语', pt: '葡萄牙语', ar: '阿拉伯语',
    th: '泰语', vi: '越南语', id: '印尼语', tr: '土耳其语', nl: '荷兰语',
    pl: '波兰语', sv: '瑞典语', hi: '印地语'
  };
  var ZONE_ORDER = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'it', 'pt'];
  var MOCK_FILTER_LABELS = {
    global_cooldown: '冷却',
    dedup: '去重',
    user_cooldown: '用户冷却',
    blacklist: '黑名单',
    disabled: '类型未开启朗读',
    gift_min_price: '礼物门槛',
    no_text: '无有效文本',
    empty_template: '空模板',
    voice_lang_mismatch: '音色语言不匹配',
    tts_disabled: '全局朗读已关闭',
    mock_display_only: '未开启朗读',
    queue_full: '队列已满',
    unsupported: '不支持类型'
  };
  var MOCK_AUTO_TYPE_KEYS = ['danmaku', 'gift', 'super_chat', 'guard', 'enter', 'like', 'social', 'fansclub'];
  var MOCK_AUTO_TYPE_LABELS = {
    danmaku: '弹幕',
    gift: '礼物',
    super_chat: '醒目留言',
    guard: '上舰',
    enter: '入场',
    like: '点赞',
    social: '关注',
    fansclub: '粉丝团'
  };

  /* ---------------- DOM 引用 ---------------- */
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    roomTitle: $('roomTitle'),
    statusPill: $('statusPill'),
    statusText: $('statusText'),
    appVersionLabel: $('appVersionLabel'),
    platformSelect: $('platformSelect'),
    roomInput: $('roomInput'),
    connectBtn: $('connectBtn'),
    cancelBtn: $('cancelBtn'),
    roomError: $('roomError'),
    streamList: $('streamList'),
    streamTitle: $('streamTitle'),
    streamCount: $('streamCount'),
    clearBtn: $('clearBtn'),
    emptyState: $('emptyState'),
    emptyTitle: $('emptyTitle'),
    emptySub: $('emptySub'),
    toBottomBtn: $('toBottomBtn'),
    voiceSelect: $('voiceSelect'),
    voiceRefreshBtn: $('voiceRefreshBtn'),
    voiceLangHint: $('voiceLangHint'),
    accountBtn: $('accountBtn'),
    accountText: $('accountText'),
    accountShort: $('accountShort'),
    settingsBiliAccountState: $('settingsBiliAccountState'),
    settingsBiliAccountBtn: $('settingsBiliAccountBtn'),
    settingsDouyinAccountState: $('settingsDouyinAccountState'),
    settingsDouyinAccountBtn: $('settingsDouyinAccountBtn'),
    loginModal: $('loginModal'),
    qrBox: $('qrBox'),
    qrImg: $('qrImg'),
    loginStatus: $('loginStatus'),
    qrRefreshBtn: $('qrRefreshBtn'),
    logoutBtn: $('logoutBtn'),
    loginCloseBtn: $('loginCloseBtn'),
    douyinLoginModal: $('douyinLoginModal'),
    douyinLoginStatus: $('douyinLoginStatus'),
    douyinLoginStartBtn: $('douyinLoginStartBtn'),
    douyinLogoutBtn: $('douyinLogoutBtn'),
    douyinLoginCloseBtn: $('douyinLoginCloseBtn'),
    monitorBtn: $('monitorBtn'),
    rateSlider: $('rateSlider'), rateValue: $('rateValue'),
    pitchSlider: $('pitchSlider'), pitchValue: $('pitchValue'),
    volumeSlider: $('volumeSlider'), volumeValue: $('volumeValue'),
    previewText: $('previewText'),
    previewBtn: $('previewBtn'),
    giftMinInput: $('giftMinInput'),
    blacklistInput: $('blacklistInput'),
    statReceived: $('statReceived'),
    statSpoken: $('statSpoken'),
    statDropped: $('statDropped'),
    statQueue: $('statQueue'),
    barQueue: $('barQueue'),
    barNow: $('barNow'),
    barLog: $('barLog')
  };

  var SLIDER_SPECS = [
    { el: els.rateSlider, out: els.rateValue, path: 'tts.rate', min: -50, max: 50, def: 0, unit: '%' },
    { el: els.pitchSlider, out: els.pitchValue, path: 'tts.pitch', min: -20, max: 20, def: 0, unit: 'Hz' },
    { el: els.volumeSlider, out: els.volumeValue, path: 'tts.volume', min: -50, max: 50, def: 0, unit: '%' }
  ];

  /* ---------------- 运行时状态 ---------------- */
  var state = {
    api: null,
    isMock: false,
    cursor: 0,
    connection: 'disconnected',
    connDetail: '',
    platform: 'bilibili',
    roomKey: '',
    roomId: 0,
    roomTitle: '',
    stats: { received: 0, spoken: 0, dropped: 0, filtered: 0 },
    session: null,
    mock: null,
    history: null,
    queueLen: 0,
    nowPlaying: null,
    monitorVisible: false,
    config: null,
    voices: [],
    following: true,
    lastLog: '',
    lastError: '',
    errStreak: 0,
    errStreaks: {},
    lastErrLogAt: 0,
    errorTitle: '',
    dirtyUntil: 0,
    optimisticUntil: 0,
    lastEditAt: 0,
    errorHoldUntil: 0,
    cancelHoldUntil: 0,
    cancelIntentUntil: 0,
    cancelCleanup: false,
    douyinLoginOpening: false,
    douyinLoginError: '',
    connectInFlight: false,
    connectSeq: 0,
    connectDeadline: 0,
    roomErrorTimer: null,
    roomErrorHideTimer: null,
    logTimer: null
  };

  var overlayState = { visible: false };

  /* ---------------- 通用工具 ---------------- */
  function defaultConfig() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
  function defaultOverlay() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG.overlay)); }

  function wbFontStack(family) {
    var clean = String(family === null || family === undefined ? '' : family).replace(/["\\]/g, '').trim();
    if (!clean) clean = 'Microsoft YaHei UI';
    return '"' + clean + '", "Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif';
  }

  function getPath(obj, path) {
    if (!obj) return undefined;
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function setPath(path, value) {
    var parts = String(path).split('.');
    var root = {};
    var cur = root;
    for (var i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return root;
  }

  function deepMerge(target, patch) {
    var out = (target && typeof target === 'object' && !Array.isArray(target)) ? target : {};
    if (!patch || typeof patch !== 'object') return out;
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var pv = patch[key];
      if (pv === undefined) continue;
      if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
        var tv = out[key];
        out[key] = deepMerge((tv && typeof tv === 'object' && !Array.isArray(tv)) ? tv : {}, pv);
      } else {
        out[key] = Array.isArray(pv) ? pv.slice() : pv;
      }
    }
    return out;
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function numFromStr(value, def) {
    if (typeof value === 'number' && isFinite(value)) return value;
    var m = String(value === null || value === undefined ? '' : value).match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : def;
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  function fmtSigned(v, unit) { return (v >= 0 ? '+' : '') + v + unit; }

  function fmtTime(ts) {
    var d = (typeof ts === 'number' && ts > 0) ? new Date(ts * 1000) : new Date();
    if (isNaN(d.getTime())) return '--:--:--';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function userColor(seed) {
    var s = String(seed === null || seed === undefined ? '' : seed);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'var(' + USER_COLOR_VARS[h % USER_COLOR_VARS.length] + ')';
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(name, size) {
    var tpl = document.createElement('template');
    tpl.innerHTML = ICONS[name] || '';
    var svg = tpl.content.firstElementChild;
    if (svg && size) {
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
    }
    return svg;
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var ctx = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; fn.apply(ctx, args); }, wait);
    };
  }

  function shake(node) {
    if (!node) return;
    node.classList.remove('shake');
    void node.offsetWidth;
    node.classList.add('shake');
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function guardName(level) {
    var n = numFromStr(level, 0);
    if (n === 1) return '舰长';
    if (n === 2) return '提督';
    if (n === 3) return '总督';
    return '上舰';
  }

  function describeEvent(ev) {
    var meta = (ev && typeof ev.meta === 'object' && ev.meta) ? ev.meta : {};
    if (ev.type === 'gift') return '送出 ' + (meta.gift_name || '礼物');
    if (ev.type === 'guard') return '开通了' + guardName(meta.guard_level);
    if (ev.type === 'enter') return '进入直播间';
    if (ev.type === 'super_chat') return meta.message || '发送了醒目留言';
    if (ev.type === 'like') return '点赞了直播间';
    if (ev.type === 'social') return meta.social_action || '关注了直播间';
    if (ev.type === 'fansclub') return meta.fansclub_action || '加入了粉丝团';
    return '';
  }

  /* ============================================================
     后端调用（全部包 try/catch，失败不白屏）
     ============================================================ */
  function hasBridge() {
    return !!(window.pywebview && window.pywebview.api &&
      typeof window.pywebview.api.get_state === 'function');
  }

  function reportCallError(name, err) {
    var msg = (err && err.message) ? err.message : String(err);
    state.errStreak += 1;
    var streak = (state.errStreaks[name] || 0) + 1;
    state.errStreaks[name] = streak;
    state.lastError = msg;
    var now = Date.now();
    if (now - state.lastErrLogAt > 3000) {
      state.lastErrLogAt = now;
      setLog(name + ' 调用失败：' + msg, 'error');
    }
    // 只有状态查询连续失败才升级为「连接异常」，避免与其它接口互相干扰
    if (name === 'get_state' && streak >= 3 && state.connection !== 'error') {
      state.errorHoldUntil = Date.now() + ERROR_HOLD_MS;
      setConnection('error', msg, bridgeErrorHeadline(msg));
    }
  }

  function call(name, args, fallback) {
    var api = state.api;
    if (!api || typeof api[name] !== 'function') {
      reportCallError(name, new Error('后端接口不可用'));
      return Promise.resolve(fallback);
    }
    return Promise.resolve()
      .then(function () { return api[name].apply(api, args || []); })
      .then(function (res) {
        state.errStreak = 0;
        state.errStreaks[name] = 0;
        return res === undefined ? fallback : res;
      })
      .catch(function (err) {
        reportCallError(name, err);
        return fallback;
      });
  }

  function hydrateAppVersion(api) {
    if (!api || typeof api.get_app_info !== 'function') return;
    Promise.resolve(api.get_app_info()).then(function (info) {
      var version = info && info.version ? String(info.version).trim() : '';
      if (version && els.appVersionLabel) {
        els.appVersionLabel.textContent = version.charAt(0) === 'v' ? version : 'v' + version;
      }
    }).catch(function () {
      // 静态 HTML 中的版本号是离线回退，不因桥接不可用而清空。
    });
  }

  function overlayApi(name, args) {
    return new Promise(function (resolve, reject) {
      var api = state.api;
      if (!api || typeof api[name] !== 'function') {
        reject(new Error('后端接口不可用：' + name));
        return;
      }
      try {
        Promise.resolve(api[name].apply(api, args || [])).then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  function overlayErrorText(err) {
    if (err && typeof err === 'object' && err.message) return String(err.message);
    var text = String(err === null || err === undefined ? '' : err);
    return text || '未知原因';
  }

  function extractOverlayConfig(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.overlay && typeof value.overlay === 'object') return value.overlay;
    if (value.config && typeof value.config === 'object' &&
      value.config.overlay && typeof value.config.overlay === 'object') {
      return value.config.overlay;
    }
    if (value.font_size !== undefined || value.types !== undefined ||
      value.font_family !== undefined || value.bg_opacity !== undefined) {
      return value;
    }
    return null;
  }

  /* ============================================================
     轮询调度：400ms 事件 / 1s 状态，页面隐藏时降频
     ============================================================ */
  var loopTimer = null;
  var lastPollAt = 0;
  var lastStateAt = 0;
  var pollBusy = false;
  var stateBusy = false;

  function startLoop() {
    if (loopTimer) clearTimeout(loopTimer);
    var tick = function () {
      var hidden = !!document.hidden;
      var pollEvery = hidden ? POLL_INTERVAL * HIDDEN_FACTOR : POLL_INTERVAL;
      var stateEvery = hidden ? STATE_INTERVAL * HIDDEN_FACTOR : STATE_INTERVAL;
      var now = Date.now();
      if (!pollBusy && now - lastPollAt >= pollEvery) {
        lastPollAt = now;
        pollEvents();
      }
      if (!stateBusy && now - lastStateAt >= stateEvery) {
        lastStateAt = now;
        pollState(false);
      }
      loopTimer = setTimeout(tick, hidden ? 1000 : HEARTBEAT);
    };
    tick();
  }

  function pollEvents() {
    pollBusy = true;
    call('poll_events', [state.cursor], null).then(function (res) {
      pollBusy = false;
      if (!res || typeof res !== 'object') return;
      var events = Array.isArray(res.events) ? res.events : [];
      if (typeof res.cursor === 'number' && isFinite(res.cursor)) {
        state.cursor = res.cursor;
      } else if (events.length) {
        var last = events[events.length - 1];
        if (last && typeof last.seq === 'number') state.cursor = Math.max(state.cursor, last.seq);
      }
      if (events.length) handleEvents(events);
    });
  }

  function pollState(force) {
    stateBusy = true;
    call('get_state', [], null).then(function (res) {
      stateBusy = false;
      if (res && typeof res === 'object') applyState(res, !!force);
    });
  }

  /* ============================================================
     状态应用与渲染
     ============================================================ */
  function applyState(s, force) {
    var conn = String(s.connection || '');
    var valid = (conn === 'disconnected' || conn === 'connecting' ||
      conn === 'connected' || conn === 'error');
    if (valid) {
      if (conn === 'connected' || conn === 'error') state.connectInFlight = false;
      var pending = (conn === 'disconnected' && state.connectInFlight &&
        Date.now() < state.connectDeadline);
      var locked = Date.now() < state.optimisticUntil;
      var cur = state.connection;
      var suppress = locked && (
        (cur === 'connecting' && conn === 'disconnected') ||
        (cur === 'disconnected' && conn !== 'disconnected')
      );
      // T2-02：UI 侧产生的错误态在存续窗口内不被「未连接」的轮询结果冲掉
      var holding = (cur === 'error' && conn === 'disconnected' &&
        Date.now() < state.errorHoldUntil);
      // N1：用户已取消，但后端迟到的成功把会话真建起来了 → 不采纳该状态并主动收尾
      var cancelledLate = (conn === 'connected' && !state.connectInFlight &&
        Date.now() < state.cancelIntentUntil);
      if (cancelledLate) {
        if (!state.cancelCleanup) {
          state.cancelCleanup = true;
          setLog('已取消连接：后端仍建立了会话，已自动断开');
          call('disconnect', [], null).then(function () {
            state.cancelCleanup = false;
            state.cancelIntentUntil = 0;
            pollState(true);
          });
        }
        if (state.connection === 'connecting') setConnection('disconnected');
      } else if (!pending && !suppress && !holding) {
        setConnection(conn);
      }
      if (conn === 'error') {
        var le = (typeof s.last_error === 'string' && s.last_error) ? s.last_error : state.connDetail;
        state.errorTitle = errorHeadline(le);
      }
    }

    var sessionInfo = s.session && typeof s.session === 'object' ? s.session : {};
    var configInfo = s.config && typeof s.config === 'object' ? s.config : {};
    var liveConnection = conn === 'connected' || conn === 'connecting' || conn === 'error';
    var platform = String(
      (liveConnection ? sessionInfo.platform : '') ||
      configInfo.platform ||
      state.platform ||
      'bilibili'
    ).toLowerCase();
    if (platform !== 'douyin') platform = 'bilibili';
    state.platform = platform;
    state.roomKey = String(
      (sessionInfo.platform && sessionInfo.platform === platform ? sessionInfo.room_key : '') ||
      state.roomKey ||
      ''
    );

    var rid = numFromStr(s.room_id, 0);
    if (rid > 0) state.roomId = rid;
    state.roomTitle = typeof s.room_title === 'string' ? s.room_title : '';
    if (s.account && typeof s.account === 'object') state.account = s.account;

    if (s.stats && typeof s.stats === 'object') {
      state.stats = {
        received: numFromStr(s.stats.received, 0),
        spoken: numFromStr(s.stats.spoken, 0),
        dropped: numFromStr(s.stats.dropped, 0),
        filtered: numFromStr(s.stats.filtered, 0)
      };
    }
    state.session = s.session && typeof s.session === 'object' ? s.session : null;
    state.mock = s.mock && typeof s.mock === 'object' ? s.mock : null;
    state.history = s.history && typeof s.history === 'object' ? s.history : null;

    if (typeof s.queue_len === 'number') state.queueLen = Math.max(0, s.queue_len);
    else if (Array.isArray(s.queue_len)) state.queueLen = s.queue_len.length;

    if (s.now_playing !== undefined) state.nowPlaying = s.now_playing;
    if (typeof s.last_error === 'string' && s.last_error) state.lastError = s.last_error;
    if (s.config && typeof s.config === 'object') applyConfig(s.config, force);

    renderStatus();
    renderConnectButton();
    renderRoom();
    renderAccount(state.account || {});
    renderStats();
    renderNowPlaying();
  }

  function setConnection(conn, detail, headline) {
    state.connection = conn;
    if (detail) state.connDetail = detail;
    if (conn === 'error') {
      state.errorTitle = headline || errorHeadline(detail || state.lastError);
    } else {
      state.errorTitle = '';
    }
    renderStatus();
    renderConnectButton();
    renderEmptyCopy();
  }

  /* 错误文案统一格式，避免「连接异常：连接失败：…」这类双层冒号（T2-22） */
  function errorHeadline(detail) {
    var d = String(detail === null || detail === undefined ? '' : detail).trim();
    if (!d) return '连接失败';
    d = d.replace(/^连接失败\s*[:：]\s*/, '').replace(/^[:：]\s*/, '');
    return d ? '连接失败 · ' + d : '连接失败';
  }

  function bridgeErrorHeadline(detail) {
    var d = String(detail === null || detail === undefined ? '' : detail).trim();
    return d ? '接口异常 · ' + d : '接口异常';
  }

  function renderStatus() {
    var map = {
      disconnected: { cls: 'is-off', text: '未连接' },
      connecting: { cls: 'is-connecting', text: '连接中' },
      connected: { cls: 'is-on', text: '已连接' },
      error: { cls: 'is-error', text: '连接异常' }
    };
    var info = map[state.connection] || map.disconnected;
    var cls = 'pill ' + info.cls;
    if (els.statusPill.className !== cls) els.statusPill.className = cls;

    // T2-09：队列数不再拼进 aria-live 胶囊，避免读屏被高频变更打断
    var text = info.text;
    if (els.statusText.textContent !== text) els.statusText.textContent = text;

    var title;
    if (state.connection === 'error') {
      title = state.errorTitle || errorHeadline(state.connDetail || state.lastError);
    } else if (state.roomTitle) {
      title = (state.platform === 'douyin' ? '抖音 · ' : 'B站 · ') + state.roomTitle;
    } else {
      title = state.roomId > 0 ? (state.platform === 'douyin' ? '抖音房间 ' : '房间 ') + state.roomId : '未连接';
    }
    if (els.statusPill.title !== title) els.statusPill.title = title;
  }

  function renderConnectButton() {
    var conn = state.connection;
    var busy = conn === 'connecting';
    var connected = conn === 'connected';
    var label = busy ? '连接中…' : (connected ? '断开' : '连接');
    if (els.connectBtn.textContent !== label) els.connectBtn.textContent = label;
    var cls = 'btn ' + (connected ? 'btn-danger' : 'btn-primary');
    if (els.connectBtn.className !== cls) els.connectBtn.className = cls;
    if (els.connectBtn.disabled !== busy) els.connectBtn.disabled = busy;
    var lockRoom = connected || busy;
    if (els.roomInput.disabled !== lockRoom) els.roomInput.disabled = lockRoom;
    if (els.platformSelect && els.platformSelect.disabled !== lockRoom) {
      els.platformSelect.disabled = lockRoom;
    }
    // T2-03：慢连接期间给出「取消」出口（连接按钮仍禁用，防重复发起）
    if (els.cancelBtn) els.cancelBtn.hidden = !busy;
  }

  function renderRoom() {
    // T2-19：仅「已连接 + 有房间标题」时显示顶栏房间名，避免与胶囊/输入框重复
    var showTitle = (state.connection === 'connected' && !!state.roomTitle);
    els.roomTitle.hidden = !showTitle;
    var title = showTitle ? state.roomTitle : '';
    if (els.roomTitle.textContent !== title) els.roomTitle.textContent = title;
    els.roomTitle.title = showTitle ? state.roomTitle : '当前直播间';

    if (els.platformSelect) {
      var platform = state.platform === 'douyin' ? 'douyin' : 'bilibili';
      if (els.platformSelect.value !== platform) els.platformSelect.value = platform;
      els.roomInput.placeholder = platform === 'douyin'
        ? '直播间号 / 抖音链接'
        : '直播间号';
      els.roomInput.setAttribute('inputmode', platform === 'douyin' ? 'text' : 'numeric');
      els.roomInput.setAttribute('aria-label', platform === 'douyin' ? '抖音直播间号或链接' : 'B站直播间号');
    }
    if (!els.roomInput.dataset.touched) {
      var v = state.roomKey || (state.roomId > 0 ? String(state.roomId) : '');
      if (v && els.roomInput.value !== v) els.roomInput.value = v;
    }
  }

  /* 房号就地错误提示（T2-23）：aria-invalid + 输入框下方气泡，2 秒后淡出 */
  function showRoomError(msg) {
    if (!els.roomError) return;
    if (state.roomErrorHideTimer) { clearTimeout(state.roomErrorHideTimer); state.roomErrorHideTimer = null; }
    els.roomError.textContent = msg;
    els.roomError.hidden = false;
    void els.roomError.offsetWidth;
    els.roomError.classList.add('is-visible');
    els.roomInput.setAttribute('aria-invalid', 'true');
    if (state.roomErrorTimer) clearTimeout(state.roomErrorTimer);
    state.roomErrorTimer = setTimeout(clearRoomError, 2000);
  }

  function clearRoomError() {
    if (state.roomErrorTimer) { clearTimeout(state.roomErrorTimer); state.roomErrorTimer = null; }
    if (!els.roomError || els.roomError.hidden) return;
    els.roomError.classList.remove('is-visible');
    els.roomInput.removeAttribute('aria-invalid');
    state.roomErrorHideTimer = setTimeout(function () {
      if (!els.roomError.classList.contains('is-visible')) els.roomError.hidden = true;
    }, 240);
  }

  function setStat(node, value) {
    var v = String(value === null || value === undefined ? 0 : value);
    if (node.textContent === v) return;
    node.textContent = v;
    node.classList.remove('bump');
    void node.offsetWidth;
    node.classList.add('bump');
  }

  function renderStats() {
    var st = state.stats || {};
    setStat(els.statReceived, st.received || 0);
    setStat(els.statSpoken, st.spoken || 0);
    setStat(els.statDropped, Math.max(0, (st.dropped || 0) - (st.filtered || 0)));
    setStat(els.statQueue, state.queueLen || 0);
    var q = String(state.queueLen || 0);
    if (els.barQueue.textContent !== q) els.barQueue.textContent = q;
  }

  function formatNowPlaying(np) {
    if (np === null || np === undefined || np === '') return '';
    if (typeof np === 'string') return np;
    if (Array.isArray(np)) return np.length ? formatNowPlaying(np[0]) : '';
    if (typeof np !== 'object') return String(np);
    var text = np.text || np.message || '';
    var user = np.user || np.username || '';
    if (user && text) return user + '：' + text;
    return String(text || user || '');
  }

  function renderNowPlaying() {
    var text = formatNowPlaying(state.nowPlaying) || '—';
    if (els.barNow.textContent !== text) els.barNow.textContent = text;
    els.barNow.title = text;
  }

  function setLog(text, kind) {
    var t = String(text === null || text === undefined ? '' : text);
    if (t) state.lastLog = t;
    paintLog(state.lastLog || LOG_IDLE, kind);
    if (state.logTimer) { clearTimeout(state.logTimer); state.logTimer = null; }
    // T2-28：一次性提示 6 秒后回落到「就绪」，不再长期占据底栏
    if (t) {
      state.logTimer = setTimeout(function () {
        state.logTimer = null;
        paintLog(LOG_IDLE, '');
      }, LOG_DECAY_MS);
    }
  }

  function paintLog(shown, kind) {
    if (els.barLog.textContent !== shown) els.barLog.textContent = shown;
    els.barLog.title = shown;
    var wrap = els.barLog.parentElement;
    if (wrap) {
      wrap.classList.toggle('is-error', kind === 'error');
      wrap.classList.toggle('is-warn', kind === 'warn');
    }
  }

  /* ============================================================
     弹幕浮窗：草稿与显示开关
     ============================================================ */
  function setOverlayButtonActive(visible) {
    var on = !!visible;
    overlayState.visible = on;
    var stateNode = document.getElementById('wsWorkbenchOverlayState');
    if (stateNode) {
      stateNode.textContent = on ? '隐藏弹幕' : '显示弹幕';
      stateNode.classList.toggle('is-ok', on);
      stateNode.classList.toggle('is-neutral', !on);
      stateNode.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (typeof wbState !== 'undefined' && wbState.draft) {
      wbState.draft.enabled = on;
      if (wbState.open && wbDom && wbDom.overlayEnabled) {
        wbSetSwitch(wbDom.overlayEnabled, on);
      }
    }
  }

  function setOverlayMasterSwitch(visible) {
    var target = !!visible;
    var previous = !!overlayState.visible;
    setOverlayButtonActive(target);
    return overlayApi('set_overlay_visible', [target]).then(function (res) {
      if (res && res.ok === false) {
        setOverlayButtonActive(previous);
        setLog('浮窗显示失败：' + (res.error || '未知原因'), 'error');
        return res;
      }
      var actual = res && typeof res.visible === 'boolean' ? res.visible : target;
      setOverlayButtonActive(actual);
      if (state.config && state.config.overlay) state.config.overlay.enabled = actual;
      if (state.config_v2 && state.config_v2.overlay) state.config_v2.overlay.enabled = actual;
      setLog(actual ? '浮窗已显示' : '浮窗已隐藏');
      return res;
    }).catch(function (err) {
      setOverlayButtonActive(previous);
      reportCallError('set_overlay_visible', err);
      setLog('浮窗显示失败：' + overlayErrorText(err), 'error');
      return { ok: false, visible: previous, error: overlayErrorText(err) };
    });
  }

  /* ============================================================
     弹幕流渲染
     ============================================================ */
  function handleEvents() { return window.MutaiApp.modules.danmaku.handleEvents.apply(this, arguments); }
  function buildEventNode() { return window.MutaiApp.modules.danmaku.buildEventNode.apply(this, arguments); }
  function buildSysLine() { return window.MutaiApp.modules.danmaku.buildSysLine.apply(this, arguments); }
  function mainTextOf() { return window.MutaiApp.modules.danmaku.mainTextOf.apply(this, arguments); }
  function buildMeta() { return window.MutaiApp.modules.danmaku.buildMeta.apply(this, arguments); }
  function buildMessageItem() { return window.MutaiApp.modules.danmaku.buildMessageItem.apply(this, arguments); }
  function processLongItems() { return window.MutaiApp.modules.danmaku.processLongItems.apply(this, arguments); }
  function makeClampTask() { return window.MutaiApp.modules.danmaku.makeClampTask.apply(this, arguments); }
  function applyClamp() { return window.MutaiApp.modules.danmaku.applyClamp.apply(this, arguments); }
  function hasTextSelection() { return window.MutaiApp.modules.danmaku.hasTextSelection.apply(this, arguments); }
  function toggleClamp() { return window.MutaiApp.modules.danmaku.toggleClamp.apply(this, arguments); }
  function applyEventSideEffects() { return window.MutaiApp.modules.danmaku.applyEventSideEffects.apply(this, arguments); }
  function trimStream() { return window.MutaiApp.modules.danmaku.trimStream.apply(this, arguments); }
  function updateStreamMeta() { return window.MutaiApp.modules.danmaku.updateStreamMeta.apply(this, arguments); }
  function renderEmptyCopy() { return window.MutaiApp.modules.danmaku.renderEmptyCopy.apply(this, arguments); }
  function setToBottomVisible() { return window.MutaiApp.modules.danmaku.setToBottomVisible.apply(this, arguments); }
  function setFollowing() { return window.MutaiApp.modules.danmaku.setFollowing.apply(this, arguments); }
  function scrollToBottom() { return window.MutaiApp.modules.danmaku.scrollToBottom.apply(this, arguments); }
  function applyConfig() { return window.MutaiApp.modules.danmaku.applyConfig.apply(this, arguments); }
  function markDirty() { return window.MutaiApp.modules.danmaku.markDirty.apply(this, arguments); }
  function isEditing() { return window.MutaiApp.modules.danmaku.isEditing.apply(this, arguments); }
  function paintSlider() { return window.MutaiApp.modules.danmaku.paintSlider.apply(this, arguments); }
  function syncControls() { return window.MutaiApp.modules.danmaku.syncControls.apply(this, arguments); }
  function sendPatch() { return window.MutaiApp.modules.danmaku.sendPatch.apply(this, arguments); }
  function genderLabel() { return window.MutaiApp.modules.danmaku.genderLabel.apply(this, arguments); }
  function voiceLabelOf() { return window.MutaiApp.modules.danmaku.voiceLabelOf.apply(this, arguments); }
  function voiceLabel() { return window.MutaiApp.modules.danmaku.voiceLabel.apply(this, arguments); }
  function localeZone() { return window.MutaiApp.modules.danmaku.localeZone.apply(this, arguments); }
  function zoneRank() { return window.MutaiApp.modules.danmaku.zoneRank.apply(this, arguments); }
  function ensureVoiceOption() { return window.MutaiApp.modules.danmaku.ensureVoiceOption.apply(this, arguments); }
  function updateVoiceHint() { return window.MutaiApp.modules.danmaku.updateVoiceHint.apply(this, arguments); }
  function renderVoiceOptions() { return window.MutaiApp.modules.danmaku.renderVoiceOptions.apply(this, arguments); }
  function loadVoices() { return window.MutaiApp.modules.danmaku.loadVoices.apply(this, arguments); }
  function onConnectClick() { return window.MutaiApp.modules.danmaku.onConnectClick.apply(this, arguments); }
  function doDisconnect() { return window.MutaiApp.modules.danmaku.doDisconnect.apply(this, arguments); }
  function doCancelConnect() { return window.MutaiApp.modules.danmaku.doCancelConnect.apply(this, arguments); }
  function replayEntry() { return window.MutaiApp.modules.danmaku.replayEntry.apply(this, arguments); }
  function onPreview() { return window.MutaiApp.modules.danmaku.onPreview.apply(this, arguments); }
  function setPreviewBusy() { return window.MutaiApp.modules.danmaku.setPreviewBusy.apply(this, arguments); }

  function bindUI() {
    els.connectBtn.addEventListener('click', onConnectClick);
    if (els.cancelBtn) els.cancelBtn.addEventListener('click', doCancelConnect);
    if (els.platformSelect) {
      els.platformSelect.addEventListener('change', function () {
        var next = String(els.platformSelect.value || 'bilibili').toLowerCase();
        if (next !== 'douyin') next = 'bilibili';
        state.platform = next;
        state.roomKey = '';
        state.roomId = 0;
        state.roomTitle = '';
        document.dispatchEvent(new CustomEvent('mutai:platform-changed', {
          detail: { platform: next }
        }));
        var platformRows = document.querySelectorAll('[data-platform-only]');
        for (var pr = 0; pr < platformRows.length; pr++) {
          platformRows[pr].hidden = platformRows[pr].getAttribute('data-platform-only') !== next;
        }
        delete els.roomInput.dataset.touched;
        els.roomInput.value = '';
        clearRoomError();
        renderRoom();
        renderAccount(state.account || {});
        sendPatch({ platform: next });
        setLog(next === 'douyin' ? '已切换到抖音' : '已切换到 B站');
      });
    }
    els.roomInput.addEventListener('input', function () {
      els.roomInput.dataset.touched = '1';
      clearRoomError();
    });
    els.roomInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onConnectClick(); }
    });
    setToBottomVisible(false);

    els.clearBtn.addEventListener('click', function () {
      els.streamList.textContent = '';
      updateStreamMeta();
      setLog('已清空弹幕流');
    });

    els.streamList.addEventListener('scroll', function () {
      var list = els.streamList;
      var near = (list.scrollHeight - list.scrollTop - list.clientHeight) < 48;
      setFollowing(near);
    }, { passive: true });

    els.toBottomBtn.addEventListener('click', function () {
      setFollowing(true);
      var list = els.streamList;
      try {
        list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
      } catch (err) {
        list.scrollTop = list.scrollHeight;
      }
    });

    // 滑条
    SLIDER_SPECS.forEach(function (spec) {
      var send = debounce(function (patch) { sendPatch(patch); }, 180);
      var onInput = function () {
        var v = Math.round(numFromStr(spec.el.value, spec.def));
        spec.out.textContent = fmtSigned(v, spec.unit);
        paintSlider(spec.el);
        markDirty();
        send(setPath(spec.path, fmtSigned(v, spec.unit)));
      };
      spec.el.addEventListener('input', onInput);
      spec.el.addEventListener('change', onInput);
      paintSlider(spec.el);
    });

    // 开关
    var switches = document.querySelectorAll('.switch-input[data-path]');
    for (var i = 0; i < switches.length; i++) {
      (function (input) {
        input.addEventListener('change', function () {
          var on = !!input.checked;
          var row = input.closest ? input.closest('.switch-row') : null;
          var labelNode = row ? row.querySelector('.switch-text') : null;
          var label = labelNode ? labelNode.textContent : input.dataset.path;
          markDirty();
          sendPatch(setPath(input.dataset.path, on));
          if (input.dataset.path === 'tts.enabled') {
            document.dispatchEvent(new CustomEvent('mutai:tts-toggle', { detail: { enabled: on } }));
            setLog(on ? '已开启全局朗读' : '已关闭全局朗读：消息继续上屏，不再发声');
          } else {
            setLog((on ? '已开启读取：' : '已关闭读取：') + label);
          }
        });
      })(switches[i]);
    }

    // 数字输入
    var nums = document.querySelectorAll('input[data-num]');
    for (var j = 0; j < nums.length; j++) {
      (function (input) {
        var send = debounce(function (patch) { sendPatch(patch); }, 320);
        var apply = function () {
          var min = input.min === '' ? -Infinity : parseFloat(input.min);
          var v = numFromStr(input.value, 0);
          if (isFinite(min)) v = Math.max(min, v);
          if (input.dataset.num === 'filters.max_len' || input.dataset.num === 'queue.max_size') {
            v = Math.max(1, Math.round(v));
          }
          markDirty();
          send(setPath(input.dataset.num, round2(v)));
        };
        input.addEventListener('change', apply);
        input.addEventListener('input', apply);
      })(nums[j]);
    }

    // 屏蔽词
    var sendBlacklist = debounce(function (patch) { sendPatch(patch); }, 420);
    els.blacklistInput.addEventListener('input', function () {
      var lines = String(els.blacklistInput.value || '').split('\n')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      markDirty();
      sendBlacklist(setPath('filters.blacklist', lines));
    });

    // 音色
    els.voiceSelect.addEventListener('change', function () {
      var id = els.voiceSelect.value;
      if (!id) return;
      markDirty();
      sendPatch(setPath('tts.voice', id));
      setLog('音色已切换：' + voiceLabel(id));
      updateVoiceHint(id);
    });
    els.voiceRefreshBtn.addEventListener('click', function () { loadVoices(true); });

    // 平台账号登录
    if (els.accountBtn) {
      els.accountBtn.addEventListener('click', function () {
        if (state.platform === 'douyin') openDouyinLoginModal();
        else openLoginModal();
      });
    }
    if (els.loginCloseBtn) els.loginCloseBtn.addEventListener('click', closeLoginModal);
    if (els.qrRefreshBtn) els.qrRefreshBtn.addEventListener('click', refreshQrCode);
    if (els.logoutBtn) els.logoutBtn.addEventListener('click', doLogout);
    if (els.settingsBiliAccountBtn) {
      els.settingsBiliAccountBtn.addEventListener('click', openLoginModal);
    }
    if (els.settingsDouyinAccountBtn) {
      els.settingsDouyinAccountBtn.addEventListener('click', openDouyinLoginModal);
    }
    if (els.douyinLoginCloseBtn) els.douyinLoginCloseBtn.addEventListener('click', closeDouyinLoginModal);
    if (els.douyinLoginStartBtn) els.douyinLoginStartBtn.addEventListener('click', startDouyinLogin);
    if (els.douyinLogoutBtn) els.douyinLogoutBtn.addEventListener('click', doDouyinLogout);

    if (els.monitorBtn) {
      els.monitorBtn.addEventListener('click', function () {
        toggleMonitor().then(function (res) {
          if (res && res.ok === false) {
            setLog('监看窗口打开失败：' + (res.error || '未知原因'), 'error');
          } else if (res) {
            setLog(res.visible ? '监看窗口已打开' : '监看窗口已隐藏');
          }
        }).catch(function () {
          setLog('监看窗口打开失败', 'error');
        });
      });
    }

    // 试听
    els.previewBtn.addEventListener('click', onPreview);
    els.previewText.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onPreview(); }
    });

    // 页面可见性变化时立刻补一次轮询
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { lastPollAt = 0; lastStateAt = 0; }
    });
  }

  /* ============================================================
     B站账号扫码登录
     ============================================================ */
  var loginTimer = null;
  var loginKey = '';
  var douyinLoginTimer = null;

  function stopDouyinLoginPolling() {
    if (douyinLoginTimer) {
      clearInterval(douyinLoginTimer);
      douyinLoginTimer = null;
    }
  }

  function pollDouyinLoginStatus() {
    call('douyin_login_status', [], null).then(function (res) {
      if (!res || typeof res !== 'object' || res.ok === false) return;
      if (res.state === 'success') {
        stopDouyinLoginPolling();
        state.douyinLoginOpening = false;
        state.account = state.account || {};
        state.account.douyin = res.account || {
          logged_in: true,
          uname: '抖音账号',
          uid: null
        };
        renderAccount(state.account);
        renderDouyinLoginModal(state.account.douyin);
        return;
      }
      if (res.state === 'closed' || res.state === 'timeout') {
        stopDouyinLoginPolling();
        state.douyinLoginOpening = false;
        state.douyinLoginError = res.state === 'timeout'
          ? '等待登录超时，请重新打开窗口'
          : '登录窗口已关闭，请重新打开';
        renderDouyinLoginModal(state.account && state.account.douyin);
      } else if (res.state === 'error') {
        stopDouyinLoginPolling();
        state.douyinLoginOpening = false;
        state.douyinLoginError = res.error || '登录失败';
        renderDouyinLoginModal(state.account && state.account.douyin);
      }
    });
  }

  function renderAccount(acc) {
    var douyin = state.platform === 'douyin';
    acc = acc || {};
    var current = douyin
      ? (acc.douyin && typeof acc.douyin === 'object' ? acc.douyin : {})
      : acc;
    var on = !!current.logged_in;
    var uname = on ? (current.uname || (douyin ? '抖音账号' : 'B站账号')) : '';
    if (els.accountBtn) {
      els.accountBtn.hidden = false;
      els.accountBtn.classList.toggle('is-on', on);
      els.accountBtn.classList.toggle('is-off', !on);
      els.accountBtn.title = on
        ? ('已登录：' + uname + '（点击查看/退出）')
        : (douyin ? '登录抖音账号' : '登录B站账号（扫码）');
      els.accountBtn.setAttribute('aria-label', on
        ? ('账号：' + uname + '，点击管理')
        : (douyin ? '登录抖音账号' : '登录B站账号'));
    }
    if (els.accountText) {
      els.accountText.textContent = on ? uname : (douyin ? '抖音登录' : '扫码登录');
    }
    if (els.accountShort) {
      els.accountShort.textContent = on ? '账号' : (douyin ? '抖音' : '登录');
    }
    renderSettingsAccount(els.settingsBiliAccountState, els.settingsBiliAccountBtn, acc, 'B站');
    renderSettingsAccount(
      els.settingsDouyinAccountState,
      els.settingsDouyinAccountBtn,
      acc.douyin && typeof acc.douyin === 'object' ? acc.douyin : {},
      '抖音'
    );
    if (douyin) renderDouyinLoginModal(current);
    else stopDouyinLoginPolling();
  }

  function renderSettingsAccount(stateEl, buttonEl, account, label) {
    var on = !!(account && account.logged_in);
    var name = on ? (account.uname || label + '账号') : '';
    if (stateEl) stateEl.textContent = on ? ('已登录 · ' + name) : '未登录';
    if (buttonEl) buttonEl.textContent = on ? '管理' : '登录';
  }

  function stopLoginPolling() {
    if (loginTimer) {
      clearInterval(loginTimer);
      loginTimer = null;
    }
  }

  function setLoginStatus(text, isError) {
    if (!els.loginStatus) return;
    els.loginStatus.textContent = text;
    els.loginStatus.classList.toggle('is-error', !!isError);
    // 由既有状态文案派生二维码区域视觉态（loading/ready/scanned/expired/error/success），
    // 调用方与轮询逻辑保持不变
    if (els.qrBox) {
      var t = String(text || '');
      var s = 'ready';
      if (t.indexOf('正在获取') >= 0) s = 'loading';
      else if (t.indexOf('过期') >= 0) s = 'expired';
      else if (t.indexOf('失败') >= 0) s = 'error';
      else if (t.indexOf('已扫码') >= 0) s = 'scanned';
      else if (t.indexOf('登录成功') >= 0) s = 'success';
      if (els.qrBox.getAttribute('data-state') !== s) els.qrBox.setAttribute('data-state', s);
    }
  }

  function openLoginModal() {
    if (!els.loginModal) return;
    els.loginModal.hidden = false;
    var acc = state.account || {};
    if (els.logoutBtn) els.logoutBtn.hidden = !acc.logged_in;
    refreshQrCode();
  }

  function closeLoginModal() {
    if (!els.loginModal) return;
    els.loginModal.hidden = true;
    stopLoginPolling();
  }

  function refreshQrCode() {
    stopLoginPolling();
    loginKey = '';
    if (els.qrImg) {
      els.qrImg.hidden = true;
      els.qrImg.removeAttribute('src');
    }
    setLoginStatus('正在获取二维码…', false);
    call('login_qr', [], null).then(function (res) {
      if (!res || typeof res !== 'object' || res.ok === false || !res.image) {
        setLoginStatus('二维码获取失败：' + ((res && res.error) || '未知原因'), true);
        return;
      }
      loginKey = res.qrcode_key || '';
      if (els.qrImg) {
        els.qrImg.src = res.image;
        els.qrImg.hidden = false;
      }
      setLoginStatus('请用 B站 手机 App 扫码', false);
      loginTimer = setInterval(pollLogin, 1800);
    });
  }

  function pollLogin() {
    if (!loginKey) return;
    call('login_poll', [loginKey], null).then(function (res) {
      res = res || {};
      if (res.status === 'waiting') {
        setLoginStatus('请用 B站 手机 App 扫码', false);
      } else if (res.status === 'scanned') {
        setLoginStatus('已扫码，请在手机上确认登录', false);
      } else if (res.status === 'expired') {
        stopLoginPolling();
        setLoginStatus('二维码已过期，请点「刷新二维码」', true);
      } else if (res.status === 'success') {
        stopLoginPolling();
        var suffix = res.persisted === false ? '（仅本次运行，配置未写入）' : '';
        state.account = Object.assign({}, state.account || {}, {
          logged_in: true,
          uname: res.uname || (state.account && state.account.uname) || null
        });
        renderAccount(state.account);
        setLoginStatus('登录成功' + (res.uname ? '：' + res.uname : '') + suffix, false);
        setLog('登录成功' + (res.uname ? '：' + res.uname : '') +
          '，弹幕用户名不再打码' + (suffix ? '；登录态仅本次运行' : ''));
        setTimeout(closeLoginModal, 1200);
      } else {
        stopLoginPolling();
        setLoginStatus('登录失败：' + (res.error || '未知原因'), true);
      }
    });
  }

  function doLogout() {
    call('logout', [], null).then(function (res) {
      if (!res || res.ok === false) {
        setLog('退出登录失败：' + ((res && res.error) || '未知原因'), 'error');
        return;
      }
      state.account = Object.assign({}, state.account || {}, {
        logged_in: false,
        uname: null,
        mid: null
      });
      renderAccount(state.account);
      setLog(res && res.persisted === false
        ? '已清除本次登录态：配置未能写入磁盘，重启后可能恢复登录'
        : '已退出登录：弹幕用户名将再次打码');
      closeLoginModal();
    });
  }

  function renderDouyinLoginModal(account) {
    if (!els.douyinLoginModal) return;
    var current = account && typeof account === 'object' ? account : {};
    var on = !!current.logged_in;
    if (on) {
      state.douyinLoginOpening = false;
      state.douyinLoginError = '';
      stopDouyinLoginPolling();
    }
    if (els.douyinLoginStatus) {
      var text = on
        ? '已登录' + (current.uname ? '：' + current.uname : '')
        : (state.douyinLoginError
          ? state.douyinLoginError
        : (state.douyinLoginOpening
          ? '登录窗口已打开，请在窗口中扫码或登录…'
          : '登录后可读取需要账号态的抖音消息'));
      els.douyinLoginStatus.textContent = text;
      els.douyinLoginStatus.classList.toggle('is-error', !!state.douyinLoginError);
    }
    if (els.douyinLoginStartBtn) {
      els.douyinLoginStartBtn.textContent = on ? '重新登录' : '打开登录窗口';
    }
    if (els.douyinLogoutBtn) els.douyinLogoutBtn.hidden = !on;
  }

  function openDouyinLoginModal() {
    if (!els.douyinLoginModal) return;
    els.douyinLoginModal.hidden = false;
    var current = state.account && state.account.douyin && typeof state.account.douyin === 'object'
      ? state.account.douyin
      : {};
    renderDouyinLoginModal(current);
    if (!current.logged_in && !state.douyinLoginOpening) startDouyinLogin();
  }

  function closeDouyinLoginModal() {
    if (!els.douyinLoginModal) return;
    els.douyinLoginModal.hidden = true;
    stopDouyinLoginPolling();
  }

  function startDouyinLogin() {
    state.douyinLoginOpening = true;
    state.douyinLoginError = '';
    if (els.douyinLoginStatus) {
      els.douyinLoginStatus.textContent = '正在打开抖音登录窗口…';
      els.douyinLoginStatus.classList.remove('is-error');
    }
    call('douyin_login_start', [], null).then(function (res) {
      if (!res || typeof res !== 'object' || res.ok === false) {
        state.douyinLoginOpening = false;
        state.douyinLoginError = '打开登录窗口失败：' + ((res && res.error) || '未知原因');
        stopDouyinLoginPolling();
        if (els.douyinLoginStatus) {
          els.douyinLoginStatus.textContent = state.douyinLoginError;
          els.douyinLoginStatus.classList.add('is-error');
        }
        setLog('打开抖音登录窗口失败：' + ((res && res.error) || '未知原因'), 'error');
        return;
      }
      if (els.douyinLoginStatus) {
        els.douyinLoginStatus.textContent = '登录窗口已打开，请在窗口中扫码或登录…';
      }
      stopDouyinLoginPolling();
      douyinLoginTimer = setInterval(pollDouyinLoginStatus, 1200);
    });
  }

  function doDouyinLogout() {
    call('douyin_logout', [], null).then(function (res) {
      if (state.account) {
        state.account.douyin = (res && res.account) || { logged_in: false, uname: null, uid: null };
      }
      state.douyinLoginOpening = false;
      state.douyinLoginError = '';
      stopDouyinLoginPolling();
      renderAccount(state.account || {});
      renderDouyinLoginModal(state.account && state.account.douyin);
      setLog('已退出抖音账号', 'warn');
    });
  }

  /* ============================================================
     浮窗工作台 v2（B 工作台）
     只消费 get_config_v2 / apply_overlay / update_config / mock_*。
     ============================================================ */
  var WB_TYPES = ['danmaku', 'gift', 'super_chat', 'guard', 'enter', 'like', 'social', 'fansclub'];
  var WB_TYPES_BY_PLATFORM = {
    bilibili: ['danmaku', 'gift', 'super_chat', 'guard', 'enter', 'social'],
    douyin: ['danmaku', 'gift', 'enter', 'like', 'social', 'fansclub']
  };
  var WB_PIN_LANES_BY_PLATFORM = {
    bilibili: ['gift', 'sc', 'guard', 'danmaku', 'enter', 'social'],
    douyin: ['gift', 'danmaku', 'enter', 'like', 'social', 'fansclub']
  };
  function wbPlatform() {
    return state.platform === 'douyin' ? 'douyin' : 'bilibili';
  }
  function wbTypesForPlatform(platform) {
    var key = platform === 'douyin' ? 'douyin' : (platform === 'bilibili' ? 'bilibili' : wbPlatform());
    return (WB_TYPES_BY_PLATFORM[key] || WB_TYPES_BY_PLATFORM.bilibili).slice();
  }
  function wbPinLanesForPlatform(platform) {
    var key = platform === 'douyin' ? 'douyin' : (platform === 'bilibili' ? 'bilibili' : wbPlatform());
    return (WB_PIN_LANES_BY_PLATFORM[key] || WB_PIN_LANES_BY_PLATFORM.bilibili).slice();
  }
  var WB_STYLE_FIELDS = [
    'font_size', 'font_weight', 'text_color', 'name_color',
    'bg_color', 'bg_opacity', 'opacity', 'outline',
    'outline_color', 'outline_width', 'shadow', 'badge_color'
  ];
  var WB_STYLE_FIELD_COUNT = WB_STYLE_FIELDS.length;
  var WB_FIELD_META = {
    font_size: { label: '字号', type: 'stepper', min: 12, max: 48, step: 1, suffix: 'px' },
    font_weight: { label: '字重', type: 'segmented', options: [400, 500, 600, 700, 800] },
    text_color: { label: '正文色', type: 'color' },
    name_color: { label: '名色', type: 'color' },
    bg_color: { label: '背景色', type: 'color' },
    bg_opacity: { label: '背景不透明度', type: 'range', min: 10, max: 100, suffix: '%' },
    opacity: { label: '整体不透明度', type: 'range', min: 10, max: 100, suffix: '%' },
    outline: { label: '描边', type: 'switch' },
    outline_color: { label: '描边色', type: 'color' },
    outline_width: { label: '描边宽度', type: 'stepper', min: 0, max: 6, step: 1, suffix: 'px' },
    shadow: { label: '投影', type: 'switch' },
    badge_color: { label: '徽标色', type: 'color' }
  };
  var WB_MOTION_FIELDS = [
    'enter_anim', 'enter_ms', 'enter_dir', 'enter_distance', 'enter_scale', 'enter_opacity',
    'exit_anim', 'exit_ms', 'exit_dir', 'exit_distance', 'exit_scale', 'exit_opacity'
  ];
  var WB_MOTION_FIELD_COUNT = WB_MOTION_FIELDS.length;
  var WB_MOTION_DEFAULTS = {
    enter_anim: 'slide',
    enter_ms: 220,
    enter_dir: 'right',
    enter_distance: 0,
    enter_scale: 90,
    enter_opacity: 0,
    exit_anim: 'fade',
    exit_ms: 180,
    exit_dir: 'up',
    exit_distance: 4,
    exit_scale: 96,
    exit_opacity: 0
  };
  var WB_MOTION_FIELD_META = {
    enter_anim: {
      label: '入场方式', type: 'segmented', options: ['none', 'fade', 'slide', 'scale'],
      labels: { none: '无', fade: '淡入', slide: '滑入', scale: '缩放' }
    },
    enter_ms: { label: '入场时长', type: 'stepper', min: 0, max: 2000, step: 10, suffix: 'ms' },
    enter_dir: { label: '入场方向', type: 'direction', phase: 'enter' },
    enter_distance: { label: '入场位移', type: 'stepper', min: 0, max: 160, step: 1, suffix: 'px', hint: '0=自动' },
    enter_scale: { label: '入场缩放', type: 'stepper', min: 50, max: 100, step: 1, suffix: '%' },
    enter_opacity: { label: '入场透明度', type: 'stepper', min: 0, max: 100, step: 1, suffix: '%' },
    exit_anim: {
      label: '退场方式', type: 'segmented', options: ['none', 'fade', 'slide', 'scale'],
      labels: { none: '无', fade: '淡出', slide: '滑出', scale: '缩放' }
    },
    exit_ms: { label: '退场时长', type: 'stepper', min: 0, max: 1000, step: 10, suffix: 'ms' },
    exit_dir: { label: '退场方向', type: 'direction', phase: 'exit' },
    exit_distance: { label: '退场位移', type: 'stepper', min: 0, max: 160, step: 1, suffix: 'px', hint: '0=无位移' },
    exit_scale: { label: '退场缩放', type: 'stepper', min: 50, max: 100, step: 1, suffix: '%' },
    exit_opacity: { label: '退场透明度', type: 'stepper', min: 0, max: 100, step: 1, suffix: '%' }
  };
  var WB_DIRECTION_VECTORS = {
    left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1]
  };
  var WB_DIRECTION_LABELS = {
    enter: { up: '从上', down: '从下', left: '从左', right: '从右' },
    exit: { up: '向上', down: '向下', left: '向左', right: '向右' }
  };
  var WB_TYPOGRAPHY_FIELDS = ['font_family', 'line_height', 'letter_spacing'];
  var WB_TYPOGRAPHY_FIELD_COUNT = WB_TYPOGRAPHY_FIELDS.length;
  var WB_TYPOGRAPHY_THEMES = {
    classic: { font_family: 'Microsoft YaHei UI', line_height: 1.55, letter_spacing: 0 },
    shortvideo: { font_family: 'Microsoft YaHei UI', line_height: 1.45, letter_spacing: 0 },
    minimal: { font_family: 'Source Han Sans SC', line_height: 1.60, letter_spacing: 0 },
    highcontrast: { font_family: 'SimHei', line_height: 1.50, letter_spacing: 0 }
  };
  var WB_TYPOGRAPHY_FONT_SUGGESTIONS = [
    'Microsoft YaHei UI', 'Microsoft YaHei', 'Source Han Sans SC', 'PingFang SC',
    'SimHei', 'SimSun', 'Segoe UI', 'Arial', 'Consolas'
  ];
  var WB_TYPE_META = {
    danmaku: {
      name: '弹幕', code: 'DANMAKU', color: 'var(--accent)', icon: '#wb-i-chat',
      sub: '普通文字消息 · 字号与底板可单独调整'
    },
    gift: {
      name: '礼物', code: 'GIFT', color: 'var(--warn)', icon: '#wb-i-gift',
      sub: '礼物与连击提示 · 可单独强调'
    },
    super_chat: {
      name: '醒目留言', code: 'SUPER CHAT', color: 'var(--err)', icon: '#wb-i-star',
      sub: '付费留言 · 优先展示'
    },
    guard: {
      name: '舰长', code: 'GUARD', color: 'var(--accent-ink)', icon: '#wb-i-crown',
      sub: '上舰与大航海 · 独立强调'
    },
    enter: {
      name: '入场', code: 'ENTER', color: 'var(--ok)', icon: '#wb-i-enter',
      sub: '进入直播间的轻量提示'
    },
    like: {
      name: '点赞', code: 'LIKE', color: 'var(--warn)', icon: '#wb-i-star',
      sub: '抖音点赞 · 高频互动默认只上屏'
    },
    social: {
      name: '关注', code: 'SOCIAL', color: 'var(--ok)', icon: '#wb-i-enter',
      sub: '关注 / 分享直播间（B站 / 抖音）'
    },
    fansclub: {
      name: '粉丝团', code: 'FANSCLUB', color: 'var(--warn)', icon: '#wb-i-star',
      sub: '抖音加入粉丝团 / 粉丝团升级'
    }
  };
  var WB_THEME_META = {
    classic: { name: '经典夜色', code: 'classic · 深色直播场景' },
    shortvideo: { name: '短视频', code: 'shortvideo · 大字强对比' },
    minimal: { name: '极简', code: 'minimal · 轻底板细字' },
    highcontrast: { name: '高对比', code: 'highcontrast · 强描边高可读' }
  };
  var WB_TYPE_BADGE = {
    danmaku: '#4AA8FF',
    gift: '#F5C867',
    super_chat: '#FF6F91',
    guard: '#A98BFF',
    enter: '#53D6C5'
  };
  var WB_STYLE_BASE = {
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
    badge_color: '#8FE3FF'
  };
  var WB_THEME_PRESETS = {
    classic: {
      font_size: 22, font_weight: 600, text_color: '#FFFFFF', name_color: '#8FE3FF',
      bg_color: '#000000', bg_opacity: 22, opacity: 100, outline: true,
      outline_color: '#000000', outline_width: 2, shadow: true
    },
    shortvideo: {
      font_size: 30, font_weight: 800, text_color: '#FFFFFF', name_color: '#FFD86B',
      bg_color: '#000000', bg_opacity: 36, opacity: 100, outline: true,
      outline_color: '#000000', outline_width: 3, shadow: true
    },
    minimal: {
      font_size: 20, font_weight: 400, text_color: '#F2F5FA', name_color: '#A8C7FA',
      bg_color: '#000000', bg_opacity: 10, opacity: 96, outline: false,
      outline_color: '#000000', outline_width: 0, shadow: false
    },
    highcontrast: {
      font_size: 24, font_weight: 700, text_color: '#FFFFFF', name_color: '#00E5FF',
      bg_color: '#000000', bg_opacity: 85, opacity: 100, outline: true,
      outline_color: '#000000', outline_width: 2, shadow: true
    }
  };
  var WB_PIN_DEFAULTS = {
    gift: { enabled: true, position: 'top', duration_ms: 8000, max: 3, min_price: 10 },
    sc: { enabled: true, position: 'top', duration_ms: 12000, max: 2 },
    guard: { enabled: true, position: 'bottom', duration_ms: 6000, max: 2 },
    danmaku: { enabled: false, position: 'bottom', duration_ms: 8000, max: 0 },
    enter: { enabled: false, position: 'bottom', duration_ms: 6000, max: 0 },
    like: { enabled: false, position: 'bottom', duration_ms: 6000, max: 2 },
    social: { enabled: false, position: 'bottom', duration_ms: 6000, max: 2 },
    fansclub: { enabled: false, position: 'bottom', duration_ms: 6000, max: 2 }
  };
  function wbNullStyle() {
    var out = {};
    for (var i = 0; i < WB_STYLE_FIELDS.length; i++) out[WB_STYLE_FIELDS[i]] = null;
    return out;
  }
  function wbNullTypes() {
    var out = {};
    for (var i = 0; i < WB_TYPES.length; i++) out[WB_TYPES[i]] = wbNullStyle();
    return out;
  }
  function wbNullMotionStyle() {
    var out = {};
    for (var i = 0; i < WB_MOTION_FIELDS.length; i++) out[WB_MOTION_FIELDS[i]] = null;
    return out;
  }
  function wbNullMotionTypes() {
    var out = {};
    for (var i = 0; i < WB_TYPES.length; i++) out[WB_TYPES[i]] = wbNullMotionStyle();
    return out;
  }
  function wbMotionFromLegacy(animation) {
    var name = String(animation || '').trim().toLowerCase();
    if (name !== 'none' && name !== 'fade' && name !== 'slide') name = 'slide';
    var out = wbClone(WB_MOTION_DEFAULTS);
    out.enter_anim = name;
    out.exit_anim = 'fade';
    out.exit_dir = 'up';
    out.exit_distance = 4;
    return out;
  }
  function wbNormalizeMotionValue(field, value) {
    var meta = WB_MOTION_FIELD_META[field];
    if (!meta) return null;
    if (value === null || value === undefined || value === '') return null;
    if (meta.type === 'segmented' || meta.type === 'direction') {
      var text = String(value).trim().toLowerCase();
      var options = meta.type === 'direction'
        ? ['left', 'right', 'up', 'down']
        : meta.options;
      return options.indexOf(text) >= 0 ? text : null;
    }
    var number = Number(value);
    if (!isFinite(number)) return null;
    number = Math.round(number);
    if (number < meta.min || number > meta.max) return null;
    return number;
  }
  function wbNormalizeMotionOverride(src) {
    var out = wbNullMotionStyle();
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < WB_MOTION_FIELDS.length; i++) {
      var field = WB_MOTION_FIELDS[i];
      if (!wbHas(src, field)) continue;
      out[field] = wbNormalizeMotionValue(field, src[field]);
    }
    return out;
  }
  function wbNormalizeMotionPartial(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < WB_MOTION_FIELDS.length; i++) {
      var field = WB_MOTION_FIELDS[i];
      if (!wbHas(src, field)) continue;
      var value = wbNormalizeMotionValue(field, src[field]);
      if (value !== null) out[field] = value;
    }
    return out;
  }
  function wbNormalizeMotion(src, fallbackAnimation) {
    var source = src && typeof src === 'object' ? src : null;
    var global = source && source.global && typeof source.global === 'object'
      ? wbNormalizeMotionPartial(source.global)
      : null;
    var base = global ? wbClone(WB_MOTION_DEFAULTS) : wbMotionFromLegacy(fallbackAnimation);
    if (global) {
      for (var key in global) {
        if (Object.prototype.hasOwnProperty.call(global, key)) base[key] = global[key];
      }
    }
    var types = wbNullMotionTypes();
    if (source && source.types && typeof source.types === 'object') {
      for (var i = 0; i < WB_TYPES.length; i++) {
        types[WB_TYPES[i]] = wbNormalizeMotionOverride(source.types[WB_TYPES[i]]);
      }
    }
    return { schema_version: 1, global: base, types: types };
  }
  function wbResolveMotion(source, type) {
    var src = source && typeof source === 'object' ? source : {};
    var motion = src.motion;
    if (!motion && src.overlay && src.overlay.motion) motion = src.overlay.motion;
    if (!motion && src.global && src.types) motion = src;
    var animation = src.animation;
    if (!animation && src.overlay) animation = src.overlay.animation;
    var normalized = wbNormalizeMotion(motion, animation);
    var out = wbClone(normalized.global);
    var canonical = WB_TYPES.indexOf(type) >= 0 ? type : 'danmaku';
    var override = normalized.types[canonical] || {};
    for (var i = 0; i < WB_MOTION_FIELDS.length; i++) {
      var key = WB_MOTION_FIELDS[i];
      if (override[key] !== null && override[key] !== undefined) out[key] = override[key];
    }
    return out;
  }
  function wbNullTypographyStyle() {
    var out = {};
    for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) out[WB_TYPOGRAPHY_FIELDS[i]] = null;
    return out;
  }
  function wbNullTypographyTypes() {
    var out = {};
    for (var i = 0; i < WB_TYPES.length; i++) out[WB_TYPES[i]] = wbNullTypographyStyle();
    return out;
  }
  function wbTypographyTheme(theme) {
    return WB_TYPOGRAPHY_THEMES[theme] || WB_TYPOGRAPHY_THEMES.classic;
  }
  function wbNormalizeTypographyValue(key, value) {
    if (value === null || value === undefined || value === '') return null;
    if (key === 'font_family') {
      var text = String(value).trim();
      if (!text || text.length > 120 || /[\r\n,;]/.test(text)) return null;
      return text;
    }
    var number = Number(value);
    if (!isFinite(number)) return null;
    if (key === 'line_height') {
      return Math.round(clamp(number, 1, 2.5) * 100) / 100;
    }
    if (key === 'letter_spacing') {
      return Math.round(clamp(number, 0, 8) * 4) / 4;
    }
    return null;
  }
  function wbNormalizeTypographyOverride(src) {
    var out = wbNullTypographyStyle();
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) {
      var key = WB_TYPOGRAPHY_FIELDS[i];
      if (!wbHas(src, key)) continue;
      out[key] = wbNormalizeTypographyValue(key, src[key]);
    }
    return out;
  }
  function wbNormalizeTypographyPartial(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) {
      var key = WB_TYPOGRAPHY_FIELDS[i];
      if (!wbHas(src, key)) continue;
      var value = wbNormalizeTypographyValue(key, src[key]);
      if (value !== null) out[key] = value;
    }
    return out;
  }
  function wbNormalizeTypographyPatch(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) {
      var key = WB_TYPOGRAPHY_FIELDS[i];
      if (!wbHas(src, key)) continue;
      if (src[key] === null) {
        out[key] = null;
        continue;
      }
      var value = wbNormalizeTypographyValue(key, src[key]);
      if (value !== null) out[key] = value;
    }
    return out;
  }
  function wbNormalizeTypography(src, theme) {
    var source = src && typeof src === 'object' ? src : {};
    var globalSrc = source.global && typeof source.global === 'object' ? source.global : {};
    var global = wbNullTypographyStyle();
    var globalPartial = wbNormalizeTypographyPartial(globalSrc);
    for (var key in globalPartial) {
      if (Object.prototype.hasOwnProperty.call(globalPartial, key)) global[key] = globalPartial[key];
    }
    var types = wbNullTypographyTypes();
    if (source.types && typeof source.types === 'object') {
      for (var i = 0; i < WB_TYPES.length; i++) {
        types[WB_TYPES[i]] = wbNormalizeTypographyOverride(source.types[WB_TYPES[i]]);
      }
    }
    return { schema_version: 1, global: global, types: types };
  }
  function wbResolveTypography(source, type) {
    var src = source && typeof source === 'object' ? source : {};
    var typography = src.typography;
    if (!typography && src.overlay && src.overlay.typography) typography = src.overlay.typography;
    if (!typography && src.global && src.types) typography = src;
    var theme = src.styles && src.styles.theme;
    if (!theme && src.overlay && src.overlay.styles) theme = src.overlay.styles.theme;
    if (!theme) theme = src.theme || (typeof wbActiveTheme === 'function' ? wbActiveTheme() : 'classic');
    var normalized = wbNormalizeTypography(typography, theme);
    var out = wbClone(wbTypographyTheme(theme));
    for (var g = 0; g < WB_TYPOGRAPHY_FIELDS.length; g++) {
      var globalKey = WB_TYPOGRAPHY_FIELDS[g];
      if (normalized.global[globalKey] !== null && normalized.global[globalKey] !== undefined) {
        out[globalKey] = normalized.global[globalKey];
      }
    }
    var canonical = WB_TYPES.indexOf(type) >= 0 ? type : 'danmaku';
    var override = normalized.types[canonical] || {};
    for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) {
      var key = WB_TYPOGRAPHY_FIELDS[i];
      if (override[key] !== null && override[key] !== undefined) out[key] = override[key];
    }
    return out;
  }
  function wbResolveTypographyGlobal(source) {
    var src = source && typeof source === 'object' ? source : {};
    var typography = src.typography;
    if (!typography && src.overlay && src.overlay.typography) typography = src.overlay.typography;
    var theme = src.styles && src.styles.theme;
    if (!theme && src.overlay && src.overlay.styles) theme = src.overlay.styles.theme;
    if (!theme) theme = src.theme || (typeof wbActiveTheme === 'function' ? wbActiveTheme() : 'classic');
    var normalized = wbNormalizeTypography(typography, theme);
    var out = wbClone(wbTypographyTheme(theme));
    for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) {
      var key = WB_TYPOGRAPHY_FIELDS[i];
      if (normalized.global[key] !== null && normalized.global[key] !== undefined) out[key] = normalized.global[key];
    }
    return out;
  }
  function wbTypographyCoverageCount(type) {
    var source = wbState.draft && wbState.draft.typography && wbState.draft.typography.types
      ? wbState.draft.typography.types[type]
      : null;
    if (!source) return 0;
    var count = 0;
    for (var i = 0; i < WB_TYPOGRAPHY_FIELDS.length; i++) {
      if (source[WB_TYPOGRAPHY_FIELDS[i]] !== null && source[WB_TYPOGRAPHY_FIELDS[i]] !== undefined) count += 1;
    }
    return count;
  }
  function wbMotionCoverageCount(type) {
    var source = wbState.draft && wbState.draft.motion && wbState.draft.motion.types
      ? wbState.draft.motion.types[type]
      : null;
    if (!source) return 0;
    var count = 0;
    for (var i = 0; i < WB_MOTION_FIELDS.length; i++) {
      if (source[WB_MOTION_FIELDS[i]] !== null && source[WB_MOTION_FIELDS[i]] !== undefined) count += 1;
    }
    return count;
  }
  function wbTypeCoverageTotal() {
    if (wbState.styleDomain === 'motion') return WB_MOTION_FIELD_COUNT;
    if (wbState.styleDomain === 'typography') return WB_TYPOGRAPHY_FIELD_COUNT;
    return WB_STYLE_FIELD_COUNT;
  }
  function wbTypeCoverageCount(type) {
    if (wbState.styleDomain === 'motion') return wbMotionCoverageCount(type);
    if (wbState.styleDomain === 'typography') return wbTypographyCoverageCount(type);
    return wbCoverageCount(type);
  }
  var WB_DEFAULT_CONFIG = {
    // 工作台 mock 只消费 overlay/monitor；版本与生产配置保持一致。
    schema_version: 3,
    appearance: {
      schema_version: 1,
      preset: 'broadcast',
      custom: false,
      theme_mode: 'dark',
      accent: '#FF5F3A',
      pattern: { type: 'none', spacing_px: 24, dot_size_px: 1.5 },
      radius: { enabled: false, value_px: 12 },
      font: 'broadcast'
    },
    overlay: {
      enabled: false,
      geometry: { x: 60, y: 120, width: 520, height: 620, scale: 1.0 },
      show_name: true,
      name_sep: '：',
      name_max_len: 12,
      text_max_len: 100,
      max_lines: 8,
      gap: 8,
      align: 'left',
      template_id: 'bubble',
      types: { danmaku: true, gift: true, super_chat: true, guard: true, enter: true, like: true, social: true },
      styles: { theme: 'classic', global: {}, types: wbNullTypes() },
      motion: { schema_version: 1, global: wbClone(WB_MOTION_DEFAULTS), types: wbNullMotionTypes() },
      typography: { schema_version: 1, global: wbNullTypographyStyle(), types: wbNullTypographyTypes() },
      pins: WB_PIN_DEFAULTS
    },
    monitor: {
      font_px: null,
      mode: 'auto',
      columns: ['time', 'type', 'user', 'content', 'value', 'status'],
      geometry: { width: 1366, height: 768 }
    }
  };

  function wbClone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function wbHas(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }
  function wbEscape(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function wbFinite(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }
  function wbRound(value, fallback, min, max) {
    var n = wbFinite(value, fallback);
    n = Math.round(n);
    return clamp(n, min, max);
  }
  function wbNormalizeHex(value) {
    var text = String(value === null || value === undefined ? '' : value).trim().toUpperCase();
    if (!text) return null;
    if (text.charAt(0) !== '#') text = '#' + text;
    return /^#[0-9A-F]{6}$/.test(text) ? text : null;
  }
  function wbRgba(hex, percent) {
    var value = String(wbNormalizeHex(hex) || '#000000').slice(1);
    var r = parseInt(value.slice(0, 2), 16);
    var g = parseInt(value.slice(2, 4), 16);
    var b = parseInt(value.slice(4, 6), 16);
    var alpha = clamp(wbFinite(percent, 0), 0, 100) / 100;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha.toFixed(3) + ')';
  }
  function wbPercent(value, fallback) {
    var n = wbFinite(value, fallback);
    if (n >= 0 && n <= 1) n *= 100;
    return clamp(Math.round(n), 10, 100);
  }
  function wbStyleValue(field, value) {
    if (value === null || value === undefined) return null;
    var meta = WB_FIELD_META[field];
    if (!meta) return null;
    if (field === 'font_size') {
      var fs = Number(value);
      return isFinite(fs) && fs === Math.round(fs) && fs >= 12 && fs <= 48 ? fs : null;
    }
    if (field === 'font_weight') {
      var fw = Number(value);
      return fw === 400 || fw === 500 || fw === 600 || fw === 700 || fw === 800 ? fw : null;
    }
    if (field === 'bg_opacity' || field === 'opacity') {
      var p = Number(value);
      if (!isFinite(p)) return null;
      if (p >= 0 && p <= 1) p *= 100;
      p = Math.round(p);
      return p >= 10 && p <= 100 ? p : null;
    }
    if (field === 'outline_width') {
      var ow = Number(value);
      return isFinite(ow) && ow === Math.round(ow) && ow >= 0 && ow <= 6 ? ow : null;
    }
    if (field === 'outline' || field === 'shadow') {
      return typeof value === 'boolean' ? value : null;
    }
    if (field === 'text_color' || field === 'name_color' || field === 'bg_color' ||
      field === 'outline_color' || field === 'badge_color') {
      return wbNormalizeHex(value);
    }
    return null;
  }
  function wbNormalizeStyleOverride(src) {
    var out = wbNullStyle();
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < WB_STYLE_FIELDS.length; i++) {
      var field = WB_STYLE_FIELDS[i];
      if (!wbHas(src, field)) continue;
      var value = src[field];
      if (field === 'text_color' && value === null && wbHas(src, 'color')) value = src.color;
      out[field] = wbStyleValue(field, value);
    }
    return out;
  }
  function wbNormalizeStylePartial(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < WB_STYLE_FIELDS.length; i++) {
      var field = WB_STYLE_FIELDS[i];
      if (!wbHas(src, field)) continue;
      var value = src[field];
      if (field === 'text_color' && value === null && wbHas(src, 'color')) value = src.color;
      var cleaned = wbStyleValue(field, value);
      if (cleaned !== null) out[field] = cleaned;
    }
    return out;
  }
  function wbNormalizeStylePatch(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < WB_STYLE_FIELDS.length; i++) {
      var field = WB_STYLE_FIELDS[i];
      if (!wbHas(src, field)) continue;
      var value = src[field];
      if (field === 'text_color' && value === null && wbHas(src, 'color')) value = src.color;
      if (value === null) {
        out[field] = null;
        continue;
      }
      var cleaned = wbStyleValue(field, value);
      if (cleaned !== null) out[field] = cleaned;
    }
    return out;
  }
  function wbIsCopiedThemeGlobal(src) {
    var normalized = wbNormalizeStylePartial(src);
    if (src && Number(src.font_weight) === 800) normalized.font_weight = 800;
    var fields = [];
    for (var i = 0; i < WB_STYLE_FIELDS.length; i++) {
      if (WB_STYLE_FIELDS[i] !== 'badge_color') fields.push(WB_STYLE_FIELDS[i]);
    }
    for (var p = 0; p < fields.length; p++) {
      if (!wbHas(normalized, fields[p])) return false;
    }
    for (var theme in WB_THEME_PRESETS) {
      if (!Object.prototype.hasOwnProperty.call(WB_THEME_PRESETS, theme)) continue;
      var preset = WB_THEME_PRESETS[theme];
      var matches = true;
      for (var f = 0; f < fields.length; f++) {
        if (normalized[fields[f]] !== preset[fields[f]]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
    return false;
  }
  function wbApplyStyleLayer(target, src) {
    if (!src || typeof src !== 'object') return;
    for (var i = 0; i < WB_STYLE_FIELDS.length; i++) {
      var field = WB_STYLE_FIELDS[i];
      if (!wbHas(src, field)) continue;
      var value = src[field];
      if (value === null || value === undefined) continue;
      target[field] = value;
    }
  }
  function wbStylesOf(source) {
    if (!source || typeof source !== 'object') return { theme: 'classic', global: {}, types: {} };
    if (source.styles && typeof source.styles === 'object') return source.styles;
    if (source.overlay && source.overlay.styles && typeof source.overlay.styles === 'object') {
      return source.overlay.styles;
    }
    if (source.theme || source.global || source.types) return source;
    return { theme: 'classic', global: {}, types: {} };
  }
  function wbResolveBaseStyle(source) {
    var styles = wbStylesOf(source);
    var theme = styles.theme && WB_THEME_PRESETS[styles.theme] ? styles.theme : 'classic';
    var out = wbClone(WB_STYLE_BASE);
    wbApplyStyleLayer(out, WB_THEME_PRESETS[theme]);
    wbApplyStyleLayer(out, styles.global);
    return out;
  }
  function wbResolveStyle(source, type) {
    var styles = wbStylesOf(source);
    var canonical = WB_TYPES.indexOf(type) >= 0 ? type : 'danmaku';
    var out = wbClone(WB_STYLE_BASE);
    out.badge_color = WB_TYPE_BADGE[canonical] || out.badge_color;
    var theme = styles.theme && WB_THEME_PRESETS[styles.theme] ? styles.theme : 'classic';
    wbApplyStyleLayer(out, WB_THEME_PRESETS[theme]);
    if (!wbIsCopiedThemeGlobal(styles.global)) wbApplyStyleLayer(out, styles.global);
    wbApplyStyleLayer(out, styles.types && styles.types[canonical]);
    return out;
  }
  function wbNormalizePins(src) {
    var out = wbClone(WB_PIN_DEFAULTS);
    if (!src || typeof src !== 'object') return out;
    var lanes = Object.keys(WB_PIN_DEFAULTS);
    for (var i = 0; i < lanes.length; i++) {
      var lane = lanes[i];
      var raw = src[lane];
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.enabled === 'boolean') out[lane].enabled = raw.enabled;
      if (raw.position === 'top' || raw.position === 'bottom') out[lane].position = raw.position;
      out[lane].duration_ms = wbRound(raw.duration_ms, out[lane].duration_ms, 0, 30000);
      out[lane].max = wbRound(raw.max, out[lane].max, 0, 6);
      if (lane === 'danmaku' || lane === 'enter') out[lane].max = 0;
      if (lane === 'gift') {
        out[lane].min_price = clamp(wbFinite(raw.min_price, out[lane].min_price), 0, 100000);
      }
    }
    return out;
  }
  function wbDefaultDraft() {
    return {
      enabled: false,
      clickThrough: true,
      alwaysOnTop: true,
      geometry: { x: 60, y: 120, width: 520, height: 620, scale: 1.0 },
      styles: { theme: 'classic', global: {}, types: wbNullTypes() },
      motion: { schema_version: 1, global: wbClone(WB_MOTION_DEFAULTS), types: wbNullMotionTypes() },
      typography: { schema_version: 1, global: wbNullTypographyStyle(), types: wbNullTypographyTypes() },
      pins: wbClone(WB_PIN_DEFAULTS)
    };
  }
  function wbNormalizeConfig(raw, flat) {
    var root = raw && typeof raw === 'object' ? raw : {};
    if (root.config && typeof root.config === 'object') root = root.config;
    var overlay = root.overlay && typeof root.overlay === 'object' ? root.overlay : {};
    var flatOverlay = flat && typeof flat === 'object' ? flat : {};
    var stylesSrc = overlay.styles && typeof overlay.styles === 'object' ? overlay.styles : null;
    var flatTheme = flatOverlay.theme && WB_THEME_PRESETS[flatOverlay.theme] ? flatOverlay.theme : null;
    var theme = stylesSrc && stylesSrc.theme && WB_THEME_PRESETS[stylesSrc.theme]
      ? stylesSrc.theme
      : (flatTheme || 'classic');
    var global = stylesSrc ? wbNormalizeStylePartial(stylesSrc.global) : {};
    if (!stylesSrc) {
      global = wbNormalizeStylePartial({
        font_size: flatOverlay.font_size,
        font_weight: flatOverlay.font_weight,
        text_color: flatOverlay.color,
        name_color: flatOverlay.name_color,
        bg_color: flatOverlay.bg_color,
        bg_opacity: flatOverlay.bg_opacity,
        opacity: flatOverlay.opacity,
        outline: flatOverlay.outline,
        outline_color: flatOverlay.outline_color,
        outline_width: flatOverlay.outline_width,
        shadow: flatOverlay.shadow,
        badge_color: flatOverlay.badge_color
      });
    }
    if (wbIsCopiedThemeGlobal(global)) global = {};
    var types = {};
    for (var i = 0; i < WB_TYPES.length; i++) {
      var kind = WB_TYPES[i];
      types[kind] = wbNormalizeStyleOverride(stylesSrc && stylesSrc.types ? stylesSrc.types[kind] : null);
    }
    var geometry = { x: 60, y: 120, width: 520, height: 620, scale: 1.0 };
    var geomSrc = overlay.geometry && typeof overlay.geometry === 'object' ? overlay.geometry : {};
    geometry.x = wbRound(geomSrc.x, wbRound(flatOverlay.x, geometry.x, -10000, 10000), -10000, 10000);
    geometry.y = wbRound(geomSrc.y, wbRound(flatOverlay.y, geometry.y, -10000, 10000), -10000, 10000);
    geometry.width = wbRound(geomSrc.width, wbRound(flatOverlay.width, geometry.width, 200, 3840), 200, 3840);
    geometry.height = wbRound(geomSrc.height, wbRound(flatOverlay.height, geometry.height, 200, 2160), 200, 2160);
    var scaleValue = geomSrc.scale !== undefined ? geomSrc.scale : flatOverlay.scale;
    geometry.scale = clamp(wbFinite(scaleValue, 1), 0.5, 4);
    var enabled = typeof overlay.enabled === 'boolean'
      ? overlay.enabled
      : (typeof flatOverlay.enabled === 'boolean' ? flatOverlay.enabled : false);
    var clickThrough = typeof flatOverlay.click_through === 'boolean' ? flatOverlay.click_through : true;
    var alwaysOnTop = typeof flatOverlay.always_on_top === 'boolean' ? flatOverlay.always_on_top : true;
    var flatTypes = flatOverlay.types && typeof flatOverlay.types === 'object' ? flatOverlay.types :
      (overlay.types && typeof overlay.types === 'object' ? overlay.types : {});
    var visibleTypes = {};
    for (var ti = 0; ti < WB_TYPES.length; ti++) {
      visibleTypes[WB_TYPES[ti]] = typeof flatTypes[WB_TYPES[ti]] === 'boolean'
        ? flatTypes[WB_TYPES[ti]]
        : true;
    }
    var motionSrc = overlay.motion && typeof overlay.motion === 'object'
      ? overlay.motion
      : (flatOverlay.motion && typeof flatOverlay.motion === 'object' ? flatOverlay.motion : null);
    var motion = wbNormalizeMotion(motionSrc, flatOverlay.animation);
    var typographySrc = overlay.typography && typeof overlay.typography === 'object'
      ? overlay.typography
      : (flatOverlay.typography && typeof flatOverlay.typography === 'object' ? flatOverlay.typography : null);
    var typography = wbNormalizeTypography(typographySrc, theme);
    return {
      draft: {
        enabled: enabled,
        clickThrough: clickThrough,
        alwaysOnTop: alwaysOnTop,
        geometry: geometry,
        showName: typeof flatOverlay.show_name === 'boolean' ? flatOverlay.show_name :
          (typeof overlay.show_name === 'boolean' ? overlay.show_name : true),
        nameSeparator: typeof flatOverlay.name_sep === 'string' ? flatOverlay.name_sep.slice(0, 4) :
          (typeof overlay.name_sep === 'string' ? overlay.name_sep.slice(0, 4) : '：'),
        nameMaxLen: wbRound(flatOverlay.name_max_len, wbRound(overlay.name_max_len, 12, 4, 24), 4, 24),
        textMaxLen: wbRound(flatOverlay.text_max_len, wbRound(overlay.text_max_len, 100, 1, 10000), 1, 10000),
        maxLines: wbRound(flatOverlay.max_lines, wbRound(overlay.max_lines, 8, 0, 30), 0, 30),
        gap: wbRound(flatOverlay.gap, wbRound(overlay.gap, 8, 0, 40), 0, 40),
        align: flatOverlay.align === 'center' || flatOverlay.align === 'right' ? flatOverlay.align :
          (overlay.align === 'center' || overlay.align === 'right' ? overlay.align : 'left'),
        templateId: ['bubble', 'compact', 'focus'].indexOf(flatOverlay.template_id) >= 0
          ? flatOverlay.template_id
          : (['bubble', 'compact', 'focus'].indexOf(overlay.template_id) >= 0 ? overlay.template_id : 'bubble'),
        types: visibleTypes,
        styles: { theme: theme, global: global, types: types },
        motion: motion,
        typography: typography,
        pins: wbNormalizePins(overlay.pins || flatOverlay.pins)
      }
    };
  }

  var wbState = {
    inited: false,
    open: false,
    pendingOpen: false,
    loading: false,
    loadOk: false,
    saving: false,
    loadSeq: 0,
    lastFocus: null,
    tab: 'style',
    debugTab: 'mock',
    currentType: 'danmaku',
    styleDomain: 'style',
    typographyDemoOpen: false,
    motionAnimRun: 0,
    motionAnimFrame: 0,
    motionAnimEl: null,
    motionAnimBase: 1,
    draft: wbDefaultDraft(),
    presetGlobalLayers: { motion: false, typography: false },
    rulesView: 'table',
    mock: {
      kind: 'danmaku',
      user: '',
      text: '',
      speak: false,
      busy: false,
      auto: {
        running: false, sent: 0, interval: 1500, perTick: 1,
        types: {
          danmaku: true, gift: false, super_chat: false, guard: false, enter: false,
          like: false, social: false, fansclub: false
        },
        typesByPlatform: null,
        platform: '',
        speak: true
      },
      applyTimer: 0,
      pollTimer: 0,
      seq: 0,
      dirtyUntil: 0,
      visibilityBusy: false
    },
    dirty: false,
    editSeq: 0,
    autoSaveTimer: 0,
    justSavedUntil: 0,
    toastTimer: 0,
    undoTimer: 0,
    undoAction: null,
    savedTimer: 0
  };

  var wbDom = {};
  var wbConfirmState = { open: false, resolve: null, trigger: null };
  var wbResizeObserver = null;

  function wbCacheDom() { return window.MutaiApp.modules.wbCore.wbCacheDom.apply(this, arguments); }

  function wbTypeIcon() { return window.MutaiApp.modules.wbCore.wbTypeIcon.apply(this, arguments); }
  function wbCoverageCount() { return window.MutaiApp.modules.wbCore.wbCoverageCount.apply(this, arguments); }
  function wbActiveTheme() { return window.MutaiApp.modules.wbCore.wbActiveTheme.apply(this, arguments); }
  function wbSetSwitch() { return window.MutaiApp.modules.wbCore.wbSetSwitch.apply(this, arguments); }
  function wbSetSync() { return window.MutaiApp.modules.wbCore.wbSetSync.apply(this, arguments); }
  function wbSetStatus() { return window.MutaiApp.modules.wbCore.wbSetStatus.apply(this, arguments); }
  function wbSetError() { return window.MutaiApp.modules.wbCore.wbSetError.apply(this, arguments); }
  function wbSetSaveState() { return window.MutaiApp.modules.wbCore.wbSetSaveState.apply(this, arguments); }
  function wbMarkDirty() { return window.MutaiApp.modules.wbCore.wbMarkDirty.apply(this, arguments); }
  function wbUpdateFootNote() { return window.MutaiApp.modules.wbCore.wbUpdateFootNote.apply(this, arguments); }
  function wbScheduleStructureFit() {
    requestAnimationFrame(function () {
      wbFitStructure();
    });
  }

  function wbInit() {
    if (wbState.inited) return;
    wbState.inited = true;
    wbCacheDom();
    wbBindWorkbenchUI();
    wbRenderAll();
    wbSetSaveState();
    window.__wbDebug = {
      state: wbState,
      open: openWorkbench,
      close: closeWorkbench,
      resolve: function (type) { return wbResolveStyle(wbState.draft, type || wbState.currentType); },
      resolveMotion: function (type) { return wbResolveMotion(wbState.draft, type || wbState.currentType); },
      resolveTypography: function (type) { return wbResolveTypography(wbState.draft, type || wbState.currentType); },
      motionFrame: function (phase, t, spec) {
        return wbMotionFrame(spec || wbResolveMotion(wbState.draft, wbState.currentType), phase, t, 22);
      },
      budget: function () { return wbComputeBudget(); },
      snapshot: wbSnapshot
    };
  }

  function openWorkbench() {
    if (!wbDom.modal || wbState.open) return;
    if (!state.api) {
      wbState.pendingOpen = true;
      return;
    }
    wbState.pendingOpen = false;
    var embedded = wbDom.modal.classList.contains('is-embedded');
    if (els.loginModal && !els.loginModal.hidden) closeLoginModal();
    wbState.open = true;
    wbState.loading = true;
    wbState.loadOk = false;
    wbState.saving = false;
    wbState.dirty = false;
    wbState.editSeq = 0;
    if (wbState.autoSaveTimer) clearTimeout(wbState.autoSaveTimer);
    wbState.autoSaveTimer = 0;
    wbState.justSavedUntil = 0;
    wbState.lastFocus = document.activeElement;
    wbState.tab = 'style';
    wbState.debugTab = 'mock';
    wbState.currentType = 'danmaku';
    wbState.rulesView = 'table';
    wbState.draft = wbDefaultDraft();
    wbState.presetGlobalLayers = { motion: false, typography: false };
    wbState.mock.busy = false;
    wbState.mock.applyTimer = 0;
    wbClearToast();
    wbSetError('');
    wbDom.modal.hidden = false;
    var loading = document.getElementById('wsWorkbenchLoading');
    if (loading) loading.hidden = true;
    if (window.MutaiApp && window.MutaiApp.modules && window.MutaiApp.modules.wbPresets &&
      typeof window.MutaiApp.modules.wbPresets.reset === 'function') {
      window.MutaiApp.modules.wbPresets.reset();
    }
    if (!embedded) {
      document.body.classList.add('wb-open');
      if (wbDom.app) {
        wbDom.app.setAttribute('inert', '');
        wbDom.app.setAttribute('aria-hidden', 'true');
      }
    }
    wbSetSync('读取中…', 'busy');
    wbSetStatus('读取配置…', 'busy');
    wbSetTab('style', { focus: false });
    wbSetDebugTab('mock', { focus: false });
    wbRenderAll();
    wbSetSaveState();
    wbScheduleStructureFit();
    if (!embedded) {
      requestAnimationFrame(function () {
        if (wbState.open && wbDom.card) wbDom.card.focus();
      });
    }
    var seq = ++wbState.loadSeq;
    wbFetchConfig(seq, 0);
  }

  function mountWorkbenchInPage() {
    var mount = document.getElementById('wsWorkbenchMount');
    if (!mount || !wbDom.modal || !wbDom.card) return;
    wbDom.modal.classList.add('is-embedded');
    mount.appendChild(wbDom.modal);
    wbDom.card.setAttribute('role', 'region');
    wbDom.card.removeAttribute('aria-modal');
    wbDom.card.setAttribute('aria-label', '弹幕工作台');
  }

  function openWorkbenchPage() {
    var shell = window.__MUTAI_SHELL__;
    if (shell && typeof shell.setView === 'function') {
      shell.setView('picture', { focus: false });
      openWorkbench();
      return;
    }
    wbState.pendingOpen = true;
  }

  function setMonitorVisible(visible) {
    state.monitorVisible = !!visible;
    document.dispatchEvent(new CustomEvent('mutai:monitor-state', {
      detail: { visible: state.monitorVisible }
    }));
  }

  function refreshMonitorState() {
    if (!state.api || typeof state.api.monitor_visible !== 'function') return;
    call('monitor_visible', [], null).then(function (res) {
      if (res && res.ok !== false) setMonitorVisible(res.visible);
    });
  }

  function toggleMonitor() {
    // The monitor can be hidden from its own title bar, so the frontend
    // snapshot may be stale. Let the backend toggle against its live state.
    return call('toggle_monitor', [], null).then(function (res) {
      if (res && res.ok !== false) setMonitorVisible(res.visible);
      return res;
    });
  }

  function closeWorkbench(force) {
    var forced = force === true;
    if (!wbDom.modal || !wbState.open) return;
    var embedded = wbDom.modal.classList.contains('is-embedded');
    if (wbConfirmState.open) {
      wbCloseConfirm(false);
      return;
    }
    if (wbState.saving) {
      wbShowToast('正在保存，请稍候');
      return;
    }
    if (!forced && wbState.dirty) {
      wbConfirm({
        title: '放弃未保存修改？',
        body: '当前浮窗设置尚未保存。关闭后这些修改会丢失。',
        confirmLabel: '放弃修改',
        danger: true
      }).then(function (ok) {
        if (ok) closeWorkbench(true);
      });
      return;
    }
    wbCancelMotionPreview();
    if (window.MutaiApp.modules.wbWindow &&
      typeof window.MutaiApp.modules.wbWindow.wbStopGeometryPoll === 'function') {
      window.MutaiApp.modules.wbWindow.wbStopGeometryPoll();
    }
    if (wbState.autoSaveTimer) clearTimeout(wbState.autoSaveTimer);
    wbState.autoSaveTimer = 0;
    wbState.typographyDemoOpen = false;
    if (wbDom.typographyDemo) wbDom.typographyDemo.hidden = true;
    wbStopMockPoll();
    wbStopMockApply();
    wbClearToast();
    wbSetError('');
    wbState.open = false;
    wbState.loading = false;
    wbState.saving = false;
    wbState.loadSeq += 1;
    wbState.justSavedUntil = 0;
    if (window.MutaiApp && window.MutaiApp.modules && window.MutaiApp.modules.wbPresets &&
      typeof window.MutaiApp.modules.wbPresets.reset === 'function') {
      window.MutaiApp.modules.wbPresets.reset();
    }
    if (window.__MUTAI_SHELL__ && window.__MUTAI_SHELL__.state &&
      window.__MUTAI_SHELL__.state.view === 'picture' &&
      typeof window.__MUTAI_SHELL__.renderPicture === 'function') {
      window.__MUTAI_SHELL__.renderPicture();
    }
    wbDom.modal.hidden = true;
    if (!embedded) {
      document.body.classList.remove('wb-open');
      if (wbDom.app) {
        wbDom.app.removeAttribute('inert');
        wbDom.app.removeAttribute('aria-hidden');
      }
    }
    var back = wbState.lastFocus;
    wbState.lastFocus = null;
    if (embedded && window.__MUTAI_SHELL__ && typeof window.__MUTAI_SHELL__.setView === 'function') {
      window.__MUTAI_SHELL__.setView('danmaku', { focus: true });
    } else if (back && typeof back.focus === 'function' && document.contains(back)) {
      back.focus();
    } else {
      var pictureNav = document.querySelector('[data-workspace-view="picture"]');
      if (pictureNav) pictureNav.focus();
    }
  }

  function wbFetchConfig() { return window.MutaiApp.modules.wbCore.wbFetchConfig.apply(this, arguments); }
  function wbSetTab() { return window.MutaiApp.modules.wbCore.wbSetTab.apply(this, arguments); }
  function wbOnTabsKeydown() { return window.MutaiApp.modules.wbCore.wbOnTabsKeydown.apply(this, arguments); }
  function wbBindWorkbenchUI() {
    var overlayStateNode = document.getElementById('wsWorkbenchOverlayState');
    if (overlayStateNode) {
      overlayStateNode.addEventListener('click', function () {
        setOverlayMasterSwitch(!overlayState.visible);
      });
    }
    wbDom.closeBtn.addEventListener('click', closeWorkbench);
    wbDom.closeAction.addEventListener('click', closeWorkbench);
    wbDom.modal.addEventListener('click', function (e) {
      if (e.target === wbDom.modal && !wbConfirmState.open) closeWorkbench();
    });
    wbDom.tabs.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-wb-tab]') : null;
      if (btn) wbSetTab(btn.getAttribute('data-wb-tab'), { focus: true });
    });
    wbDom.tabs.addEventListener('keydown', wbOnTabsKeydown);

    wbDom.typeList.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-wb-type]') : null;
      if (!btn) return;
      wbSelectType(btn.getAttribute('data-wb-type'));
    });
    wbDom.typeStrip.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-wb-type]') : null;
      if (!btn) return;
      wbSelectType(btn.getAttribute('data-wb-type'));
    });

    wbDom.styleDomain.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-wb-style-domain]') : null;
      if (!btn) return;
      wbSetStyleDomain(btn.getAttribute('data-wb-style-domain'), { focus: true });
    });
    wbDom.matrix.addEventListener('click', wbOnMatrixClick);
    wbDom.matrix.addEventListener('input', wbOnMatrixInput);
    wbDom.matrix.addEventListener('change', wbOnMatrixChange);
    wbDom.matrix.addEventListener('focusout', wbOnMatrixBlur);
    wbDom.typographyPanel.addEventListener('click', wbOnTypographyClick);
    wbDom.typographyPanel.addEventListener('change', wbOnTypographyChange);
    wbDom.typographyPreview.addEventListener('click', function () {
      if (!wbState.typographyDemoOpen) {
        wbState.typographyDemoOpen = true;
        wbDom.typographyDemo.hidden = false;
      }
      wbPlayMotionPreview(wbDom.typographyDemoBubble, 1, { demo: true });
    });
    wbDom.typographyDemoClose.addEventListener('click', function () {
      wbState.typographyDemoOpen = false;
      wbCancelMotionPreview();
      wbDom.typographyDemo.hidden = true;
    });
    wbDom.motionPanel.addEventListener('click', wbOnMotionClick);
    wbDom.motionPanel.addEventListener('input', wbOnMotionInput);
    wbDom.motionPanel.addEventListener('change', wbOnMotionChange);
    wbDom.motionPanel.addEventListener('focusout', wbOnMotionBlur);
    wbDom.restoreType.addEventListener('click', wbRestoreCurrentType);
    wbDom.restoreAll.addEventListener('click', wbRestoreAllCurrentDomain);

    wbDom.rulesViewSwitch.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-wb-rules-view]') : null;
      if (!btn) return;
      wbState.rulesView = btn.getAttribute('data-wb-rules-view') === 'cards' ? 'cards' : 'table';
      wbRenderRules();
    });
    wbDom.rulesBody.addEventListener('click', wbOnPinClick);
    wbDom.rulesCards.addEventListener('click', wbOnPinClick);
    wbDom.rulesBody.addEventListener('input', wbOnPinInput);
    wbDom.rulesCards.addEventListener('input', wbOnPinInput);
    wbDom.rulesBody.addEventListener('change', wbOnPinChange);
    wbDom.rulesCards.addEventListener('change', wbOnPinChange);
    wbDom.restoreRules.addEventListener('click', wbRestorePinDefaults);

    wbDom.overlayEnabled.addEventListener('click', wbToggleOverlayEnabled);
    wbDom.clickThrough.addEventListener('click', function () {
      wbState.draft.clickThrough = !wbState.draft.clickThrough;
      wbSetSwitch(wbDom.clickThrough, wbState.draft.clickThrough);
      wbMarkDirty();
    });
    wbDom.alwaysOnTop.addEventListener('click', function () {
      wbState.draft.alwaysOnTop = !wbState.draft.alwaysOnTop;
      wbSetSwitch(wbDom.alwaysOnTop, wbState.draft.alwaysOnTop);
      wbMarkDirty();
    });
    var geoInputs = [
      [wbDom.geoWidth, 'width'], [wbDom.geoHeight, 'height'],
      [wbDom.geoX, 'x'], [wbDom.geoY, 'y']
    ];
    for (var gi = 0; gi < geoInputs.length; gi++) {
      (function (input, key) {
        input.addEventListener('input', function () { wbOnGeoInput(key, input.value, false); });
        input.addEventListener('change', function () { wbOnGeoInput(key, input.value, true); });
      })(geoInputs[gi][0], geoInputs[gi][1]);
    }
    wbDom.geoScale.addEventListener('input', function () {
      var pct = wbRound(wbDom.geoScale.value, 100, 50, 400);
      wbState.draft.geometry.scale = Math.round(pct) / 100;
      wbDom.geoScaleValue.textContent = pct + '%';
      wbMarkDirty();
      wbUpdateCapture();
    });
    wbDom.centerBtn.addEventListener('click', wbQuickCenter);
    wbDom.fillRightBtn.addEventListener('click', wbQuickFillRight);
    wbDom.themeGrid.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-wb-theme]') : null;
      if (btn) wbApplyTheme(btn.getAttribute('data-wb-theme'));
    });

    wbDom.mockKind.addEventListener('change', function () { wbState.mock.kind = wbDom.mockKind.value; });
    wbDom.mockUser.addEventListener('input', function () { wbState.mock.user = wbDom.mockUser.value; });
    wbDom.mockText.addEventListener('input', function () { wbState.mock.text = wbDom.mockText.value; });
    wbDom.mockSpeak.addEventListener('click', function () {
      wbState.mock.speak = !wbState.mock.speak;
      wbSetSwitch(wbDom.mockSpeak, wbState.mock.speak);
      wbDom.mockSpeakFlag.hidden = !wbState.mock.speak;
    });
    wbDom.mockSend.addEventListener('click', function () { wbInjectMock(1, false); });
    wbDom.mockBurst10.addEventListener('click', function () { wbInjectMock(10, false); });
    wbDom.mockStorm30.addEventListener('click', function () { wbInjectMock(30, true); });
    wbDom.mockAutoEnabled.addEventListener('click', wbToggleMockAuto);
    wbDom.mockInterval.addEventListener('input', function () {
      var value = wbRound(wbDom.mockInterval.value, 1500, 200, 10000);
      wbState.mock.auto.interval = value;
      wbDom.mockIntervalValue.textContent = '每 ' + (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1) + ' 秒';
      wbUpdateMockAutoUi();
      wbScheduleMockAutoApply();
    });
    wbDom.mockPerTick.addEventListener('input', function () {
      var value = wbRound(wbDom.mockPerTick.value, 1, 1, 10);
      wbState.mock.auto.perTick = value;
      wbUpdateMockAutoUi();
      wbScheduleMockAutoApply();
    });
    wbDom.mockPerTick.addEventListener('change', function () {
      wbDom.mockPerTick.value = String(wbState.mock.auto.perTick);
    });
    wbDom.mockTypes.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-wb-mock-type]') : null;
      if (!btn) return;
      var type = btn.getAttribute('data-wb-mock-type');
      var auto = wbState.mock.auto;
      var enabledCount = 0;
      for (var k in auto.types) {
        if (Object.prototype.hasOwnProperty.call(auto.types, k) && auto.types[k]) enabledCount += 1;
      }
      if (auto.types[type] && enabledCount <= 1) {
        wbSetMockFeedback('至少保留一种自动发送类型', 'error');
        return;
      }
      auto.types[type] = !auto.types[type];
      wbRenderMockTypeChips();
      wbUpdateMockAutoUi();
      wbScheduleMockAutoApply();
    });
    wbDom.mockAutoSpeak.addEventListener('click', function () {
      wbState.mock.auto.speak = !wbState.mock.auto.speak;
      wbSetSwitch(wbDom.mockAutoSpeak, wbState.mock.auto.speak);
      wbDom.mockAutoSpeakFlag.hidden = !wbState.mock.auto.speak;
      wbScheduleMockAutoApply();
    });

    wbDom.saveBtn.addEventListener('click', wbSaveSettings);
    wbDom.confirmCancel.addEventListener('click', function () { wbCloseConfirm(false); });
    wbDom.confirmOk.addEventListener('click', function () { wbCloseConfirm(true); });
    wbDom.confirmMask.addEventListener('click', function (e) {
      if (e.target === wbDom.confirmMask) wbCloseConfirm(false);
    });
    wbDom.undoBtn.addEventListener('click', function () {
      var action = wbState.undoAction;
      wbClearToast();
      if (typeof action === 'function') action();
    });

    document.addEventListener('keydown', wbOnDocumentKeydown, true);
    document.addEventListener('mutai:platform-changed', function (e) {
      var platform = e && e.detail && e.detail.platform === 'douyin' ? 'douyin' : 'bilibili';
      // 平台切换后，消息类型/固定 lane/模拟数据类型都换成对应平台的一套。
      var platformTypes = wbTypesForPlatform(platform);
      if (platformTypes.indexOf(wbState.currentType) < 0) wbState.currentType = platformTypes[0];
      wbState.mock.kind = platformTypes.indexOf(wbState.mock.kind) >= 0 ? wbState.mock.kind : platformTypes[0];
      if (wbState.loadOk) {
        wbRenderAll();
        wbRenderMockControls();
      }
    });
    window.addEventListener('resize', function () {
      wbFitStructure();
    });
    if (window.ResizeObserver) {
      wbResizeObserver = new ResizeObserver(function () {
        wbFitStructure();
      });
      wbResizeObserver.observe(wbDom.structureStage);
    }
  }

  function wbRenderAll() { return window.MutaiApp.modules.wbCore.wbRenderAll.apply(this, arguments); }
  function wbRenderTypeList() { return window.MutaiApp.modules.wbCore.wbRenderTypeList.apply(this, arguments); }
  function wbSelectType() { return window.MutaiApp.modules.wbCore.wbSelectType.apply(this, arguments); }
  function wbRenderBaseline() { return window.MutaiApp.modules.wbCore.wbRenderBaseline.apply(this, arguments); }
  function wbRenderEditor() { return window.MutaiApp.modules.wbCore.wbRenderEditor.apply(this, arguments); }
  function wbRenderTypographyEditor() { return window.MutaiApp.modules.wbTypography.wbRenderTypographyEditor.apply(this, arguments); }
  function wbTypographyRowHtml() { return window.MutaiApp.modules.wbTypography.wbTypographyRowHtml.apply(this, arguments); }
  function wbUpdateTypographyCoverage() { return window.MutaiApp.modules.wbTypography.wbUpdateTypographyCoverage.apply(this, arguments); }
  function wbSetTypographyField() { return window.MutaiApp.modules.wbTypography.wbSetTypographyField.apply(this, arguments); }
  function wbOnTypographyClick() { return window.MutaiApp.modules.wbTypography.wbOnTypographyClick.apply(this, arguments); }
  function wbOnTypographyChange() { return window.MutaiApp.modules.wbTypography.wbOnTypographyChange.apply(this, arguments); }

  function wbRenderMotionEditor() { return window.MutaiApp.modules.wbMotion.wbRenderMotionEditor.apply(this, arguments); }
  function wbMotionCardHtml() { return window.MutaiApp.modules.wbMotion.wbMotionCardHtml.apply(this, arguments); }
  function wbMotionDisabled() { return window.MutaiApp.modules.wbMotion.wbMotionDisabled.apply(this, arguments); }
  function wbMotionRowHtml() { return window.MutaiApp.modules.wbMotion.wbMotionRowHtml.apply(this, arguments); }
  function wbUpdateMotionCoverage() { return window.MutaiApp.modules.wbMotion.wbUpdateMotionCoverage.apply(this, arguments); }
  function wbOnMotionClick() { return window.MutaiApp.modules.wbMotion.wbOnMotionClick.apply(this, arguments); }
  function wbSetMotionField() { return window.MutaiApp.modules.wbMotion.wbSetMotionField.apply(this, arguments); }
  function wbOnMotionInput() { return window.MutaiApp.modules.wbMotion.wbOnMotionInput.apply(this, arguments); }
  function wbOnMotionChange() { return window.MutaiApp.modules.wbMotion.wbOnMotionChange.apply(this, arguments); }
  function wbOnMotionBlur() { return window.MutaiApp.modules.wbMotion.wbOnMotionBlur.apply(this, arguments); }
  function wbPrefersReducedMotion() { return window.MutaiApp.modules.wbMotion.wbPrefersReducedMotion.apply(this, arguments); }
  function wbEaseOutCubic() { return window.MutaiApp.modules.wbMotion.wbEaseOutCubic.apply(this, arguments); }
  function wbEaseInCubic() { return window.MutaiApp.modules.wbMotion.wbEaseInCubic.apply(this, arguments); }
  function wbMotionFrame() { return window.MutaiApp.modules.wbMotion.wbMotionFrame.apply(this, arguments); }
  function wbResetMotionElement() { return window.MutaiApp.modules.wbMotion.wbResetMotionElement.apply(this, arguments); }
  function wbCancelMotionPreview() { return window.MutaiApp.modules.wbMotion.wbCancelMotionPreview.apply(this, arguments); }
  function wbPlayMotionPreview() { return window.MutaiApp.modules.wbMotion.wbPlayMotionPreview.apply(this, arguments); }
  function wbRestoreCurrentMotion() { return window.MutaiApp.modules.wbMotion.wbRestoreCurrentMotion.apply(this, arguments); }
  function wbRestoreAllMotion() { return window.MutaiApp.modules.wbMotion.wbRestoreAllMotion.apply(this, arguments); }

  function wbUpdateCoverageDisplay() { return window.MutaiApp.modules.wbCore.wbUpdateCoverageDisplay.apply(this, arguments); }
  function wbSetStyleDomain() { return window.MutaiApp.modules.wbCore.wbSetStyleDomain.apply(this, arguments); }
  function wbFieldRowHtml() { return window.MutaiApp.modules.wbCore.wbFieldRowHtml.apply(this, arguments); }
  function wbUpdateCoverage() { return window.MutaiApp.modules.wbCore.wbUpdateCoverage.apply(this, arguments); }
  function wbUpdateTypeCounts() { return window.MutaiApp.modules.wbCore.wbUpdateTypeCounts.apply(this, arguments); }
  function wbUpdateFieldMeta() { return window.MutaiApp.modules.wbCore.wbUpdateFieldMeta.apply(this, arguments); }
  function wbSyncRowControl() { return window.MutaiApp.modules.wbCore.wbSyncRowControl.apply(this, arguments); }
  function wbSetField() { return window.MutaiApp.modules.wbCore.wbSetField.apply(this, arguments); }
  function wbSetFieldToFollow() { return window.MutaiApp.modules.wbCore.wbSetFieldToFollow.apply(this, arguments); }
  function wbToggleFieldChip() { return window.MutaiApp.modules.wbCore.wbToggleFieldChip.apply(this, arguments); }
  function wbOnMatrixClick() { return window.MutaiApp.modules.wbCore.wbOnMatrixClick.apply(this, arguments); }
  function wbOnMatrixInput() { return window.MutaiApp.modules.wbCore.wbOnMatrixInput.apply(this, arguments); }
  function wbOnMatrixChange() { return window.MutaiApp.modules.wbCore.wbOnMatrixChange.apply(this, arguments); }
  function wbOnMatrixBlur() { return window.MutaiApp.modules.wbCore.wbOnMatrixBlur.apply(this, arguments); }
  function wbShowToast() { return window.MutaiApp.modules.wbCore.wbShowToast.apply(this, arguments); }
  function wbClearToast() { return window.MutaiApp.modules.wbCore.wbClearToast.apply(this, arguments); }
  function wbConfirm() { return window.MutaiApp.modules.wbCore.wbConfirm.apply(this, arguments); }
  function wbCloseConfirm() { return window.MutaiApp.modules.wbCore.wbCloseConfirm.apply(this, arguments); }
  function wbSetConfirmInert() { return window.MutaiApp.modules.wbCore.wbSetConfirmInert.apply(this, arguments); }
  function wbRestoreCurrentType() { return window.MutaiApp.modules.wbCore.wbRestoreCurrentType.apply(this, arguments); }
  function wbRestoreCurrentTypography() { return window.MutaiApp.modules.wbTypography.wbRestoreCurrentTypography.apply(this, arguments); }
  function wbRestoreAllStyles() { return window.MutaiApp.modules.wbCore.wbRestoreAllStyles.apply(this, arguments); }
  function wbRestoreAllTypography() { return window.MutaiApp.modules.wbTypography.wbRestoreAllTypography.apply(this, arguments); }
  function wbRestoreAllCurrentDomain() { return window.MutaiApp.modules.wbCore.wbRestoreAllCurrentDomain.apply(this, arguments); }
  function wbPinRowHtml() { return window.MutaiApp.modules.wbRules.wbPinRowHtml.apply(this, arguments); }
  function wbPinCardHtml() { return window.MutaiApp.modules.wbRules.wbPinCardHtml.apply(this, arguments); }
  function wbRenderRules() { return window.MutaiApp.modules.wbRules.wbRenderRules.apply(this, arguments); }
  function wbPinLaneFrom() { return window.MutaiApp.modules.wbRules.wbPinLaneFrom.apply(this, arguments); }
  function wbOnPinClick() { return window.MutaiApp.modules.wbRules.wbOnPinClick.apply(this, arguments); }
  function wbApplyPinNumber() { return window.MutaiApp.modules.wbRules.wbApplyPinNumber.apply(this, arguments); }
  function wbOnPinInput() { return window.MutaiApp.modules.wbRules.wbOnPinInput.apply(this, arguments); }
  function wbOnPinChange() { return window.MutaiApp.modules.wbRules.wbOnPinChange.apply(this, arguments); }
  function wbComputeBudget() { return window.MutaiApp.modules.wbRules.wbComputeBudget.apply(this, arguments); }
  function wbUpdateRulesBudget() { return window.MutaiApp.modules.wbRules.wbUpdateRulesBudget.apply(this, arguments); }
  function wbRenderStructure() { return window.MutaiApp.modules.wbRules.wbRenderStructure.apply(this, arguments); }
  function wbFitStructure() { return window.MutaiApp.modules.wbRules.wbFitStructure.apply(this, arguments); }
  function wbRestorePinDefaults() { return window.MutaiApp.modules.wbRules.wbRestorePinDefaults.apply(this, arguments); }
  function wbRenderWindow() { return window.MutaiApp.modules.wbWindow.wbRenderWindow.apply(this, arguments); }
  function wbRenderThemeGrid() { return window.MutaiApp.modules.wbWindow.wbRenderThemeGrid.apply(this, arguments); }
  function wbApplyTheme() { return window.MutaiApp.modules.wbWindow.wbApplyTheme.apply(this, arguments); }
  function wbOnGeoInput() { return window.MutaiApp.modules.wbWindow.wbOnGeoInput.apply(this, arguments); }
  function wbQuickCenter() { return window.MutaiApp.modules.wbWindow.wbQuickCenter.apply(this, arguments); }
  function wbQuickFillRight() { return window.MutaiApp.modules.wbWindow.wbQuickFillRight.apply(this, arguments); }
  function wbToggleOverlayEnabled() { return window.MutaiApp.modules.wbWindow.wbToggleOverlayEnabled.apply(this, arguments); }
  function wbUpdateCapture() { return window.MutaiApp.modules.wbWindow.wbUpdateCapture.apply(this, arguments); }
  function wbMockTypeLabels() { return window.MutaiApp.modules.wbDebug.wbMockTypeLabels.apply(this, arguments); }
  function wbMockActiveTypeNames() { return window.MutaiApp.modules.wbDebug.wbMockActiveTypeNames.apply(this, arguments); }
  function wbRenderMockTypeChips() { return window.MutaiApp.modules.wbDebug.wbRenderMockTypeChips.apply(this, arguments); }
  function wbUpdateMockAutoUi() { return window.MutaiApp.modules.wbDebug.wbUpdateMockAutoUi.apply(this, arguments); }
  function wbRenderMockControls() { return window.MutaiApp.modules.wbDebug.wbRenderMockControls.apply(this, arguments); }
  function wbSetMockFeedback() { return window.MutaiApp.modules.wbDebug.wbSetMockFeedback.apply(this, arguments); }
  function wbSetMockBusy() { return window.MutaiApp.modules.wbDebug.wbSetMockBusy.apply(this, arguments); }
  function wbInjectMock() { return window.MutaiApp.modules.wbDebug.wbInjectMock.apply(this, arguments); }
  function wbDoInjectMock() { return window.MutaiApp.modules.wbDebug.wbDoInjectMock.apply(this, arguments); }
  function wbMockPayload() { return window.MutaiApp.modules.wbDebug.wbMockPayload.apply(this, arguments); }
  function wbApplyMockAuto() { return window.MutaiApp.modules.wbDebug.wbApplyMockAuto.apply(this, arguments); }
  function wbScheduleMockAutoApply() { return window.MutaiApp.modules.wbDebug.wbScheduleMockAutoApply.apply(this, arguments); }
  function wbStopMockApply() { return window.MutaiApp.modules.wbDebug.wbStopMockApply.apply(this, arguments); }
  function wbToggleMockAuto() { return window.MutaiApp.modules.wbDebug.wbToggleMockAuto.apply(this, arguments); }
  function wbFetchMockStatus() { return window.MutaiApp.modules.wbDebug.wbFetchMockStatus.apply(this, arguments); }
  function wbStartMockPoll() { return window.MutaiApp.modules.wbDebug.wbStartMockPoll.apply(this, arguments); }
  function wbStopMockPoll() { return window.MutaiApp.modules.wbDebug.wbStopMockPoll.apply(this, arguments); }
  function wbSetDebugTab() { return window.MutaiApp.modules.wbDebug.wbSetDebugTab.apply(this, arguments); }
  function wbClampDraft() { return window.MutaiApp.modules.wbCore.wbClampDraft.apply(this, arguments); }
  function wbBuildOverlayPatch() { return window.MutaiApp.modules.wbCore.wbBuildOverlayPatch.apply(this, arguments); }
  function wbCheckResponse() { return window.MutaiApp.modules.wbCore.wbCheckResponse.apply(this, arguments); }
  function wbSaveSettings() { return window.MutaiApp.modules.wbCore.wbSaveSettings.apply(this, arguments); }
  function wbFocusableNodes() { return window.MutaiApp.modules.wbCore.wbFocusableNodes.apply(this, arguments); }
  function wbTrapFocus() { return window.MutaiApp.modules.wbCore.wbTrapFocus.apply(this, arguments); }
  function wbOnDocumentKeydown(e) {
    if (!wbState.open) return;
    var embedded = !!(wbDom.modal && wbDom.modal.classList.contains('is-embedded'));
    if (embedded && state.view !== 'picture') return;
    if (wbConfirmState.open) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        wbCloseConfirm(false);
      } else if (e.key === 'Tab') {
        wbTrapFocus(e);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeWorkbench();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      wbSaveSettings();
      return;
    }
    // 内嵌工作台是页面区域，不是模态框；Tab 必须能离开它。
    if (e.key === 'Tab' && !embedded) wbTrapFocus(e);
  }

  function wbSnapshot() { return window.MutaiApp.modules.wbCore.wbSnapshot.apply(this, arguments); }

  /* ============================================================
     Mock 模式（无 pywebview 时自动启用）
     ============================================================ */
  function createMockAPI() {
    var users = ['咸鱼想翻身', '夜色微凉', '阿澈不熬夜', '柠檬气泡水', '三月的风', '洛河',
      '小满', '爱吃鱼的猫', '听风者', '半糖去冰', '雷丘丘', '月见草', '呆呆鸟',
      '清风入怀', '甜筒不加冰', '一只柯基', '橘子汽水', '阿哲', '暮色四合', '星河入梦'];
    var danmakuTexts = ['主播这波操作太秀了', '声音好好听，求歌单', '今天几点下播呀？',
      '刚进来，错过了什么？', '哈哈哈笑死我了', '这个 BGM 叫什么名字', '666666',
      '刷一波弹幕支持一下', '主播记得喝水', '已经关注啦，每天蹲直播', '画面好清晰啊',
      '求抱抱~', '这游戏我也想玩', '前方高能预警', '别慌，这波稳的', '主播能读一下我的弹幕吗',
      '来了来了', '芜湖起飞', '我赌五毛钱这波能赢', '今晚是唱歌还是聊天呀'];
    var giftPool = [
      { name: '小心心', price: 1 }, { name: '辣条', price: 1 }, { name: '棒棒糖', price: 4 },
      { name: '桃花花', price: 5 }, { name: '干杯', price: 10 }, { name: '打call', price: 30 },
      { name: '牛哇', price: 20 }, { name: '星星点点', price: 50 }, { name: '礼物小水枪', price: 99 }
    ];
    var giftPoolDouyin = [
      { name: '小心心', diamonds: 1 }, { name: '玫瑰', diamonds: 1 }, { name: '大啤酒', diamonds: 2 },
      { name: '抖音1号', diamonds: 10 }, { name: '跑车', diamonds: 66 }, { name: '嘉年华', diamonds: 3000 }
    ];
    var scPool = ['这条弹幕一定要读啊！', '主播唱歌吧，求求了', '加油，一直支持你',
      '刚下班，来听会儿声音', '今天心情不好，听主播声音治愈一下'];
    var roomTitles = ['深夜摸鱼中', '点歌环节', '练歌房', '周末杂谈', '游戏日常'];
    var voicePool = [
      { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', locale: 'zh-CN', gender: 'Female', tags: ['通用'] },
      { id: 'zh-CN-YunxiNeural', name: '云希', locale: 'zh-CN', gender: 'Male', tags: ['活泼'] },
      { id: 'zh-CN-YunyangNeural', name: '云扬', locale: 'zh-CN', gender: 'Male', tags: ['新闻'] },
      { id: 'zh-CN-XiaoyiNeural', name: '晓伊', locale: 'zh-CN', gender: 'Female', tags: ['甜美'] },
      { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', locale: 'zh-CN-liaoning', gender: 'Female', tags: ['东北'] },
      { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', locale: 'zh-CN-shaanxi', gender: 'Female', tags: ['陕西'] },
      { id: 'zh-TW-HsiaoChenNeural', name: '曉臻', locale: 'zh-TW', gender: 'Female', tags: [] },
      { id: 'zh-HK-HiuMaanNeural', name: '曉曼', locale: 'zh-HK', gender: 'Female', tags: [] },
      { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female', tags: [] },
      { id: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male', tags: [] },
      { id: 'ja-JP-NanamiNeural', name: 'Nanami', locale: 'ja-JP', gender: 'Female', tags: [] },
      { id: 'ja-JP-KeitaNeural', name: 'Keita', locale: 'ja-JP', gender: 'Male', tags: [] }
    ];

    var m = {
      connection: 'disconnected',
      platform: 'bilibili',
      room_key: '',
      room_id: 0,
      room_title: '',
      stats: { received: 0, spoken: 0, dropped: 0 },
      session_id: null,
      session_started_at: null,
      queue_len: 0,
      now_playing: null,
      config: defaultConfig(),
      config_v2: JSON.parse(JSON.stringify(WB_DEFAULT_CONFIG)),
      last_error: '',
      account: {
        logged_in: false,
        uname: null,
        mid: null,
        douyin: { logged_in: false, uname: null, uid: null }
      },
      overlay_visible: false,
      monitor_visible: false,
      loginScanAfter: 0,
      events: [],
      seq: 0,
      timers: { gen: null, read: null, connect: null, boot: null, mockAuto: null, douyinLogin: null },
      reading: { current: null, queue: [] },
      dedup: {},
      lastUserAt: {},
      lastGlobalAt: 0,
      calls: {
        inject_mock: 0,
        inject_mock_burst: 0,
        mock_auto: 0,
        mock_status: 0,
        lastInject: null,
        apply_overlay: 0,
        lastOverlayPatch: null
      },
      mock_sent: 0,
      mock_auto_enabled: false
    };

    function clone(v) { return JSON.parse(JSON.stringify(v)); }

    function syncFlatOverlay() {
      var ov = m.config_v2.overlay;
      m.config.overlay = m.config.overlay || defaultOverlay();
      m.config.overlay.enabled = !!ov.enabled;
      m.config.overlay.x = ov.geometry.x;
      m.config.overlay.y = ov.geometry.y;
      m.config.overlay.width = ov.geometry.width;
      m.config.overlay.height = ov.geometry.height;
      m.config.overlay.scale = ov.geometry.scale;
      m.config.overlay.show_name = ov.show_name;
      m.config.overlay.name_sep = ov.name_sep;
      m.config.overlay.name_max_len = ov.name_max_len;
      m.config.overlay.text_max_len = ov.text_max_len;
      m.config.overlay.max_lines = ov.max_lines;
      m.config.overlay.gap = ov.gap;
      m.config.overlay.align = ov.align;
      m.config.overlay.template_id = ov.template_id;
      m.config.overlay.types = clone(ov.types);
      m.config.overlay.theme = ov.styles.theme;
      m.config.overlay.styles = clone(ov.styles);
      m.config.overlay.motion = clone(ov.motion);
      m.config.overlay.typography = clone(ov.typography);
      m.config.overlay.pins = clone(ov.pins);
      m.overlay_visible = !!ov.enabled;
    }

    function applyOverlayPatchV2(patch) {
      var p = patch && typeof patch === 'object' ? patch : {};
      var ov = m.config_v2.overlay;
      if (typeof p.enabled === 'boolean') ov.enabled = p.enabled;
      if (typeof p.show_name === 'boolean') ov.show_name = p.show_name;
      if (typeof p.name_sep === 'string') ov.name_sep = p.name_sep.slice(0, 4);
      if (typeof p.name_max_len === 'number' && isFinite(p.name_max_len)) {
        ov.name_max_len = clamp(Math.round(p.name_max_len), 4, 24);
      }
      if (typeof p.text_max_len === 'number' && isFinite(p.text_max_len)) {
        ov.text_max_len = clamp(Math.round(p.text_max_len), 1, 10000);
      }
      if (typeof p.max_lines === 'number' && isFinite(p.max_lines)) {
        ov.max_lines = clamp(Math.round(p.max_lines), 0, 30);
      }
      if (typeof p.gap === 'number' && isFinite(p.gap)) {
        ov.gap = clamp(Math.round(p.gap), 0, 40);
      }
      if (p.align === 'left' || p.align === 'center' || p.align === 'right') ov.align = p.align;
      if (p.template_id === 'bubble' || p.template_id === 'compact' || p.template_id === 'focus') {
        ov.template_id = p.template_id;
      }
      if (p.types && typeof p.types === 'object') {
        for (var typeIndex = 0; typeIndex < WB_TYPES.length; typeIndex++) {
          var typeKey = WB_TYPES[typeIndex];
          if (typeof p.types[typeKey] === 'boolean') ov.types[typeKey] = p.types[typeKey];
        }
      }
      var geom = p.geometry && typeof p.geometry === 'object' ? p.geometry : {};
      var geomKeys = ['x', 'y', 'width', 'height', 'scale'];
      for (var i = 0; i < geomKeys.length; i++) {
        var key = geomKeys[i];
        var value = p[key] !== undefined ? p[key] : geom[key];
        if (value === undefined || value === null || value === '') continue;
        var number = Number(value);
        if (!isFinite(number)) continue;
        if (key === 'scale') ov.geometry.scale = clamp(number, 0.5, 4);
        else ov.geometry[key] = Math.round(number);
      }
      if (p.styles && typeof p.styles === 'object') {
        if (typeof p.styles.theme === 'string' && WB_THEME_PRESETS[p.styles.theme]) {
          ov.styles.theme = p.styles.theme;
        }
        if (p.styles.global && typeof p.styles.global === 'object') {
          ov.styles.global = wbNormalizeStylePatch(deepMerge(ov.styles.global || {}, p.styles.global));
        }
        if (p.styles.types && typeof p.styles.types === 'object') {
          for (var t = 0; t < WB_TYPES.length; t++) {
            var kind = WB_TYPES[t];
            if (!p.styles.types[kind] || typeof p.styles.types[kind] !== 'object') continue;
            ov.styles.types[kind] = wbNormalizeStyleOverride(deepMerge(ov.styles.types[kind] || {}, p.styles.types[kind]));
          }
        }
      }
      if (p.pins && typeof p.pins === 'object') {
        ov.pins = wbNormalizePins(deepMerge(ov.pins || {}, p.pins));
      }
      if (p.motion && typeof p.motion === 'object') {
        var motion = wbNormalizeMotion(ov.motion, m.config.overlay.animation);
        if (p.motion.global && typeof p.motion.global === 'object') {
          var globalMotion = wbNormalizeMotionPartial(deepMerge(motion.global, p.motion.global));
          for (var gk in globalMotion) {
            if (Object.prototype.hasOwnProperty.call(globalMotion, gk)) motion.global[gk] = globalMotion[gk];
          }
        }
        if (p.motion.types && typeof p.motion.types === 'object') {
          for (var mt = 0; mt < WB_TYPES.length; mt++) {
            var mkind = WB_TYPES[mt];
            if (!p.motion.types[mkind] || typeof p.motion.types[mkind] !== 'object') continue;
            var mergedOverride = deepMerge(motion.types[mkind] || {}, p.motion.types[mkind]);
            motion.types[mkind] = wbNormalizeMotionOverride(mergedOverride);
          }
        }
        ov.motion = motion;
      }
      if (p.typography && typeof p.typography === 'object') {
        var typography = wbNormalizeTypography(ov.typography, ov.styles.theme);
        if (p.typography.global && typeof p.typography.global === 'object') {
          var globalTypography = wbNormalizeTypographyPatch(
            deepMerge(typography.global, p.typography.global)
          );
          for (var tg in globalTypography) {
            if (Object.prototype.hasOwnProperty.call(globalTypography, tg)) typography.global[tg] = globalTypography[tg];
          }
        }
        if (p.typography.types && typeof p.typography.types === 'object') {
          for (var tt = 0; tt < WB_TYPES.length; tt++) {
            var tkind = WB_TYPES[tt];
            if (!p.typography.types[tkind] || typeof p.typography.types[tkind] !== 'object') continue;
            typography.types[tkind] = wbNormalizeTypographyOverride(
              deepMerge(typography.types[tkind] || {}, p.typography.types[tkind])
            );
          }
        }
        ov.typography = typography;
      }
      syncFlatOverlay();
    }

    m.config_v2.overlay.enabled = !!m.config.overlay.enabled;
    m.config_v2.overlay.geometry = {
      x: m.config.overlay.x,
      y: m.config.overlay.y,
      width: m.config.overlay.width,
      height: m.config.overlay.height,
      scale: m.config.overlay.scale
    };
    syncFlatOverlay();

    function emit(ev) {
      m.seq += 1;
      var full = {
        seq: m.seq,
        type: ev.type || 'danmaku',
        id: ev.id || ('mock-' + m.seq),
        ts: Math.floor(Date.now() / 1000),
        user: ev.user || '',
        uid: ev.uid || 0,
        text: ev.text || '',
        spoken: ev.spoken === undefined ? null : ev.spoken,
        meta: ev.meta || {},
        error: ev.error || null
      };
      m.events.push(full);
      if (m.events.length > 400) m.events.splice(0, m.events.length - 400);
      return full;
    }

    function mockReadFilterReason(type, text, meta, uid) {
      var c = m.config || {};
      var read = c.read || {};
      var filters = c.filters || {};
      if (!read[type]) return 'disabled';
      if (type === 'gift') {
        if (String(meta.coin_type || '').toLowerCase() !== 'diamond') {
          var price = numFromStr(meta.price, 0);
          if (price < numFromStr(read.gift_min_price, 0)) return 'gift_min_price';
        }
      }
      var body = String(text || '');
      if ((type === 'danmaku' || type === 'super_chat') && !body.trim()) return 'no_text';
      var blacklist = Array.isArray(filters.blacklist) ? filters.blacklist : [];
      for (var i = 0; i < blacklist.length; i++) {
        var kw = String(blacklist[i] || '');
        if (!kw) continue;
        try {
          if (new RegExp(kw, 'i').test(body)) return 'blacklist';
        } catch (err) {
          if (body.toLowerCase().indexOf(kw.toLowerCase()) >= 0) return 'blacklist';
        }
      }

      var now = Date.now() / 1000;
      var dedup = numFromStr(filters.dedup_seconds, 0);
      if (dedup > 0 && body) {
        var last = m.dedup[body];
        if (last && now - last < dedup) return 'dedup';
      }
      var userKey = Number(uid) > 0 ? String(uid) : '';
      var uc = numFromStr(filters.user_cooldown, 0);
      if (uc > 0 && userKey) {
        var lastUser = m.lastUserAt[userKey];
        if (lastUser && now - lastUser < uc) return 'user_cooldown';
      }
      var gc = numFromStr(filters.global_cooldown, 0);
      if (gc > 0 && m.lastGlobalAt && now - m.lastGlobalAt < gc) {
        return 'global_cooldown';
      }

      if (dedup > 0 && body) m.dedup[body] = now;
      if (uc > 0 && userKey) m.lastUserAt[userKey] = now;
      m.lastGlobalAt = now;
      return null;
    }

    function decideSpoken(type, text, meta, uid) {
      return mockReadFilterReason(type, text, meta, uid) === null;
    }

    function readingTextOf(ev) {
      var meta = ev.meta || {};
      if (ev.text) return ev.text;
      if (ev.type === 'gift') return '感谢' + ev.user + '送出的' + (meta.gift_name || '礼物');
      if (ev.type === 'guard') return '感谢' + ev.user + '开通' + guardName(meta.guard_level);
      if (ev.type === 'enter') return ev.user + '进入直播间';
      if (ev.type === 'like') return ev.user + '点赞了直播间';
      if (ev.type === 'social') return ev.user + (meta.social_action || '关注了直播间');
      if (ev.type === 'fansclub') return ev.user + (meta.fansclub_action || '加入了粉丝团');
      return ev.user;
    }

    function injectMockEvent(payload) {
      var p = payload && typeof payload === 'object' ? payload : {};
      var kind = String(p.kind || 'danmaku');
      var platform = String((m.config && m.config.platform) || 'bilibili').toLowerCase() === 'douyin'
        ? 'douyin' : 'bilibili';
      var allowed = platform === 'douyin'
        ? ['danmaku', 'gift', 'enter', 'like', 'social', 'fansclub']
        : ['danmaku', 'gift', 'super_chat', 'guard', 'enter', 'social'];
      if (allowed.indexOf(kind) < 0) {
        return { ok: false, error: '不支持的消息类型：' + kind };
      }
      var hint = m.seq + 1;
      var user = String(p.user || '').trim() || users[hint % users.length];
      var body = String(p.text || '').trim();
      var meta = p.meta && typeof p.meta === 'object' ? clone(p.meta) : {};
      var speak = !!p.speak;
      var uid = 900000 + hint;

      if (kind === 'gift') {
        if (platform === 'douyin') {
          var dyGift = giftPoolDouyin[hint % giftPoolDouyin.length];
          if (!meta.gift_name) meta.gift_name = dyGift.name;
          if (meta.num === undefined) meta.num = 1;
          meta.combo_count = meta.num;
          meta.diamond_count = meta.diamond_count === undefined ? dyGift.diamonds : meta.diamond_count;
          meta.coin_type = 'diamond';
          meta.price = 0;
          meta.total_coin = 0;
          if (!body) body = '送出 ' + meta.gift_name + ' ×' + meta.num;
        } else {
          var gift = giftPool[hint % giftPool.length];
          if (!meta.gift_name) meta.gift_name = gift.name;
          if (meta.price === undefined) meta.price = gift.price;
          if (meta.num === undefined) meta.num = 1;
          if (!body) body = '送出 ' + meta.gift_name + ' ×' + meta.num;
          if (meta.total_coin === undefined) meta.total_coin = numFromStr(meta.price, 0) * numFromStr(meta.num, 1);
        }
      } else if (kind === 'super_chat') {
        if (!body) body = scPool[hint % scPool.length];
        if (meta.message === undefined) meta.message = body;
        if (meta.price === undefined) meta.price = 30;
      } else if (kind === 'guard') {
        if (meta.guard_level === undefined) meta.guard_level = (hint % 3) + 1;
        if (meta.guard_name === undefined) meta.guard_name = guardName(meta.guard_level);
        if (!body) body = '开通了' + meta.guard_name;
      } else if (kind === 'enter') {
        if (!body) body = '进入直播间';
      } else if (kind === 'like') {
        if (!body) body = '点赞了直播间';
        if (meta.like_count === undefined) meta.like_count = 1 + (hint % 20);
      } else if (kind === 'social') {
        if (!body) {
          body = platform === 'douyin' && hint % 3 === 0 ? '分享了直播间' : '关注了直播间';
        }
        if (meta.social_action === undefined) meta.social_action = body;
      } else if (kind === 'fansclub') {
        if (!body) body = hint % 2 === 0 ? '粉丝团升级' : '加入了粉丝团';
        if (meta.fansclub_action === undefined) meta.fansclub_action = body;
      } else if (!body) {
        body = danmakuTexts[hint % danmakuTexts.length];
      }
      meta.mock = true;
      meta.platform = platform;

      var filterReason = speak ? mockReadFilterReason(kind, body, meta, uid) : 'mock_display_only';
      var spoken = !!speak && !filterReason;
      var ev = emit({
        type: kind,
        user: user,
        uid: uid,
        text: body,
        meta: meta,
        spoken: spoken
      });
      m.stats.received += 1;
      if (spoken) {
        if (enqueueReading(ev)) {
          m.stats.spoken += 1;
        } else {
          ev.spoken = false;
          ev.meta.filter = 'queue_full';
          filterReason = 'queue_full';
          spoken = false;
          m.stats.dropped += 1;
        }
      } else {
        if (filterReason) ev.meta.filter = filterReason;
        m.stats.dropped += 1;
      }
      return {
        ok: true,
        kind: kind,
        user: user,
        text: body,
        spoken: spoken,
        filter: filterReason || null
      };
    }

    function ensureMockConfig() {
      var defaults = clone(DEFAULT_CONFIG.mock);
      var current = m.config && m.config.mock && typeof m.config.mock === 'object'
        ? m.config.mock
        : {};
      m.config.mock = deepMerge(defaults, current);
      return m.config.mock;
    }

    function mockAutoStatusSnapshot() {
      var cfg = ensureMockConfig();
      return {
        running: !!m.mock_auto_enabled,
        sent: Math.max(0, Math.round(numFromStr(m.mock_sent, 0))),
        interval_ms: clamp(Math.round(numFromStr(cfg.interval_ms, 1500)), 200, 60000),
        per_tick: clamp(Math.round(numFromStr(cfg.per_tick, 1)), 1, 20),
        speak: !!cfg.speak,
        types: clone(cfg.types)
      };
    }

    function scheduleMockAutoTick() {
      if (m.timers.mockAuto) clearTimeout(m.timers.mockAuto);
      m.timers.mockAuto = null;
      if (!m.mock_auto_enabled) return;
      var cfg = ensureMockConfig();
      var interval = clamp(Math.round(numFromStr(cfg.interval_ms, 1500)), 200, 60000);
      m.timers.mockAuto = setTimeout(function () {
        m.timers.mockAuto = null;
        if (!m.mock_auto_enabled) return;
        var current = ensureMockConfig();
        var types = current.types || {};
        var kinds = [];
        for (var i = 0; i < MOCK_AUTO_TYPE_KEYS.length; i++) {
          var key = MOCK_AUTO_TYPE_KEYS[i];
          if (types[key]) kinds.push(key);
        }
        var perTick = clamp(Math.round(numFromStr(current.per_tick, 1)), 1, 20);
        for (var j = 0; j < perTick; j++) {
          if (kinds.length) {
            injectMockEvent({
              kind: pick(kinds),
              speak: !!current.speak
            });
          }
          m.mock_sent += 1;
        }
        scheduleMockAutoTick();
      }, interval);
    }

    function setMockAutoRunning(enabled) {
      var next = !!enabled;
      var wasRunning = !!m.mock_auto_enabled;
      if (next && !wasRunning) m.mock_sent = 0;
      m.mock_auto_enabled = next;
      if (m.timers.mockAuto) clearTimeout(m.timers.mockAuto);
      m.timers.mockAuto = null;
      if (next) scheduleMockAutoTick();
    }

    function updateMockAutoConfig(payload) {
      var p = payload && typeof payload === 'object' ? payload : {};
      var cfg = ensureMockConfig();
      if (Object.prototype.hasOwnProperty.call(p, 'interval_ms')) {
        cfg.interval_ms = clamp(Math.round(numFromStr(p.interval_ms, cfg.interval_ms)), 200, 60000);
      }
      if (Object.prototype.hasOwnProperty.call(p, 'per_tick')) {
        cfg.per_tick = clamp(Math.round(numFromStr(p.per_tick, cfg.per_tick)), 1, 20);
      }
      if (Object.prototype.hasOwnProperty.call(p, 'speak')) {
        cfg.speak = !!p.speak;
      }
      if (p.types && typeof p.types === 'object') {
        cfg.types = cfg.types || {};
        for (var i = 0; i < MOCK_AUTO_TYPE_KEYS.length; i++) {
          var key = MOCK_AUTO_TYPE_KEYS[i];
          if (Object.prototype.hasOwnProperty.call(p.types, key)) {
            cfg.types[key] = !!p.types[key];
          }
        }
      }
      return cfg;
    }

    function startReading(ev, dur) {
      m.reading.current = { ev: ev, until: Date.now() + dur };
      m.now_playing = { user: ev.user, text: readingTextOf(ev), id: ev.id };
      m.queue_len = m.reading.queue.length;
      if (m.timers.read) clearTimeout(m.timers.read);
      m.timers.read = setTimeout(finishReading, dur);
    }

    function finishReading() {
      m.reading.current = null;
      m.now_playing = null;
      var next = m.reading.queue.shift();
      m.queue_len = m.reading.queue.length;
      if (next) startReading(next.ev, next.dur);
    }

    function enqueueReading(ev) {
      var body = readingTextOf(ev);
      var dur = clamp(1400 + String(body).length * 150, 1600, 8000);
      if (m.reading.current) {
        var maxQ = numFromStr((m.config.queue || {}).max_size, 30) || 30;
        if (m.reading.queue.length >= maxQ) return false;
        m.reading.queue.push({ ev: ev, dur: dur });
        m.queue_len = m.reading.queue.length;
        return true;
      }
      startReading(ev, dur);
      return true;
    }

    function generate() {
      var r = Math.random();
      var type = 'danmaku';
      var platform = String((m.config && m.config.platform) || 'bilibili').toLowerCase() === 'douyin'
        ? 'douyin' : 'bilibili';
      if (platform === 'douyin') {
        if (r < 0.08) type = 'gift';
        else if (r < 0.20) type = 'enter';
        else if (r < 0.26) type = 'like';
        else if (r < 0.31) type = 'social';
        else if (r < 0.36) type = 'fansclub';
      } else {
        if (r < 0.08) type = 'gift';
        else if (r < 0.13) type = 'super_chat';
        else if (r < 0.17) type = 'guard';
        else if (r < 0.20) type = 'social';
        else if (r < 0.36) type = 'enter';
      }

      var user = pick(users);
      var uid = 100000 + Math.floor(Math.random() * 899999);
      var text = '';
      var meta = {};

      if (type === 'danmaku') {
        text = pick(danmakuTexts);
      } else if (type === 'gift') {
        if (platform === 'douyin') {
          var dg = pick(giftPoolDouyin);
          meta.gift_name = dg.name;
          meta.diamond_count = dg.diamonds;
          meta.coin_type = 'diamond';
          meta.price = 0;
          meta.total_coin = 0;
          meta.num = pick([1, 1, 1, 2, 5, 10]);
        } else {
          var g = pick(giftPool);
          meta.gift_name = g.name;
          meta.price = g.price;
          meta.num = pick([1, 1, 1, 2, 5, 10]);
        }
      } else if (type === 'super_chat') {
        text = pick(scPool);
        meta.message = text;
        meta.price = pick([30, 30, 50, 100, 500]);
      } else if (type === 'guard') {
        meta.guard_level = pick([1, 1, 2, 3]);
        meta.guard_name = guardName(meta.guard_level);
      } else if (type === 'like') {
        text = '点赞了直播间';
        meta.like_count = pick([1, 2, 5, 10, 20]);
      } else if (type === 'social') {
        text = platform === 'douyin' && Math.random() < 0.35 ? '分享了直播间' : '关注了直播间';
        meta.social_action = text;
      } else if (type === 'fansclub') {
        text = pick(['加入了粉丝团', '粉丝团升级']);
        meta.fansclub_action = text;
      }

      meta.mock = true;
      meta.platform = platform;
      var spoken = decideSpoken(type, text, meta, uid);
      var ev = emit({ type: type, user: user, uid: uid, text: text, meta: meta, spoken: spoken });
      m.stats.received += 1;

      if (spoken) {
        if (enqueueReading(ev)) m.stats.spoken += 1;
        else { ev.spoken = false; m.stats.dropped += 1; }
      } else {
        m.stats.dropped += 1;
      }
    }

    function scheduleGenerate() {
      m.timers.gen = setTimeout(function () {
        if (m.connection === 'connected') generate();
        scheduleGenerate();
      }, 700 + Math.random() * 2100);
    }

    var api = {
      get_state: function () {
        return {
          connection: m.connection,
          room_id: m.room_id,
          room_title: m.room_title,
          stats: { received: m.stats.received, spoken: m.stats.spoken, dropped: m.stats.dropped },
          session: {
            id: m.session_id,
            started_at: m.session_started_at,
            platform: m.platform,
            room_key: m.room_key,
            stats: { received: m.stats.received, spoken: m.stats.spoken, dropped: m.stats.dropped },
            real: { received: 0, spoken: 0, dropped: 0 },
            mock: { received: m.stats.received, spoken: m.stats.spoken, dropped: m.stats.dropped }
          },
          mock: { running: !!m.mock_auto_enabled, sent: m.mock_sent },
          queue_len: m.queue_len,
          now_playing: m.now_playing ? clone(m.now_playing) : null,
          config: clone(m.config),
          last_error: m.last_error || null,
          account: clone(m.account)
        };
      },

      get_app_info: function () {
        return { name: 'ReadMe', version: '1.0.0', base_dir: '' };
      },

      login_qr: function () {
        m.loginScanAfter = Date.now() + 2500;
        var svg = 'data:image/svg+xml;utf8,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192">' +
          '<rect width="192" height="192" fill="#10141d"/>' +
          '<text x="96" y="92" fill="#8B94A7" font-size="14" text-anchor="middle">演示二维码</text>' +
          '<text x="96" y="114" fill="#5F6879" font-size="11" text-anchor="middle">Mock 模式</text></svg>');
        return { ok: true, qrcode_key: 'mock-key', image: svg, url: 'https://example.invalid/login' };
      },

      login_poll: function () {
        if (!m.loginScanAfter || Date.now() < m.loginScanAfter) return { status: 'waiting' };
        if (Date.now() < m.loginScanAfter + 2000) return { status: 'scanned' };
        m.account = { logged_in: true, uname: '演示用户', mid: 12345 };
        return { status: 'success', uname: '演示用户', mid: 12345 };
      },

      logout: function () {
        m.account = {
          logged_in: false,
          uname: null,
          mid: null,
          douyin: { logged_in: false, uname: null, uid: null }
        };
        return { ok: true, account: clone(m.account) };
      },

      douyin_login_start: function () {
        if (m.timers.douyinLogin) clearTimeout(m.timers.douyinLogin);
        m.timers.douyinLogin = setTimeout(function () {
          m.account.douyin = { logged_in: true, uname: '抖音演示账号', uid: 'demo' };
          emit({ type: 'log', text: '抖音账号登录成功：抖音演示账号' });
        }, 1400);
        return { ok: true, state: 'opening' };
      },

      douyin_login_status: function () {
        return {
          ok: true,
          window_open: true,
          state: m.account.douyin && m.account.douyin.logged_in ? 'success' : 'opening',
          account: clone(m.account.douyin)
        };
      },

      douyin_logout: function () {
        if (m.timers.douyinLogin) clearTimeout(m.timers.douyinLogin);
        m.account.douyin = { logged_in: false, uname: null, uid: null };
        return { ok: true, account: clone(m.account.douyin) };
      },

      poll_events: function (cursor) {
        var c = parseInt(cursor, 10);
        if (!isFinite(c)) c = 0;
        var out = [];
        for (var i = 0; i < m.events.length; i++) {
          if (m.events[i].seq > c) out.push(clone(m.events[i]));
        }
        var cursorOut = out.length ? out[out.length - 1].seq : c;
        return { cursor: cursorOut, events: out };
      },

      connect: function (roomId, platform) {
        var selected = String(platform || 'bilibili').toLowerCase() === 'douyin' ? 'douyin' : 'bilibili';
        var raw = String(roomId || '').trim();
        var id = selected === 'bilibili' ? parseInt(raw, 10) : 0;
        if (selected === 'bilibili' && (!isFinite(id) || id <= 0)) {
          return { ok: false, error: '房间号必须是数字' };
        }
        if (selected === 'douyin' && !raw) return { ok: false, error: '请输入抖音直播间号或链接' };
        m.platform = selected;
        m.room_key = raw;
        m.connection = 'connecting';
        m.room_id = id;
        m.room_title = '';
        m.last_error = '';
        m.session_id = 'mock-' + Date.now().toString(36);
        m.session_started_at = Date.now() / 1000;
        m.stats = { received: 0, spoken: 0, dropped: 0 };
        emit({ type: 'status', text: '正在连接直播间 ' + raw + ' …' });
        if (m.timers.connect) clearTimeout(m.timers.connect);
        m.timers.connect = setTimeout(function () {
          if (m.room_key !== raw || m.connection !== 'connecting') return;
          m.connection = 'connected';
          m.room_title = pick(roomTitles) + '（演示）';
          emit({ type: 'status', text: '已连接：' + m.room_title });
          emit({ type: 'log', text: '弹幕连接已建立，开始监听' });
        }, 600 + Math.random() * 500);
        return { ok: true };
      },

      disconnect: function () {
        if (m.timers.connect) clearTimeout(m.timers.connect);
        if (m.timers.read) clearTimeout(m.timers.read);
        m.connection = 'disconnected';
        m.room_title = '';
        m.reading.current = null;
        m.reading.queue = [];
        m.now_playing = null;
        m.queue_len = 0;
        emit({ type: 'status', text: '已断开连接' });
        return { ok: true };
      },

      update_config: function (patch) {
        if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch 必须是对象' };
        var rest = clone(patch);
        var overlay = rest.overlay;
        delete rest.overlay;
        m.config = deepMerge(m.config, rest);
        if (overlay && typeof overlay === 'object') {
          m.config.overlay = deepMerge(m.config.overlay || defaultOverlay(), overlay);
          applyOverlayPatchV2(overlay);
        }
        return { ok: true, config: clone(m.config) };
      },

      get_config_v2: function () {
        syncFlatOverlay();
        return clone(m.config_v2);
      },

      config_status: function () {
        return {
          read_only: false,
          migration: { state: 'ok' },
          security: {
            state: 'ok',
            warning: false,
            message: '',
            dpapi_available: true,
            plaintext_fallback: false,
            decrypt_failed: false,
            read_only: false,
            token_count: 0,
            error: false
          }
        };
      },

      get_overlay_config: function () {
        syncFlatOverlay();
        var flat = clone(m.config.overlay);
        var ov = m.config_v2.overlay;
        flat.enabled = ov.enabled;
        flat.x = ov.geometry.x;
        flat.y = ov.geometry.y;
        flat.width = ov.geometry.width;
        flat.height = ov.geometry.height;
        flat.scale = ov.geometry.scale;
        flat.theme = ov.styles.theme;
        flat.styles = clone(ov.styles);
        flat.motion = clone(ov.motion);
        flat.typography = clone(ov.typography);
        flat.pins = clone(ov.pins);
        var resolved = {};
        for (var i = 0; i < WB_TYPES.length; i++) {
          resolved[WB_TYPES[i]] = wbResolveStyle({ overlay: ov }, WB_TYPES[i]);
        }
        flat.resolved = resolved;
        var resolvedMotion = {};
        for (var mi = 0; mi < WB_TYPES.length; mi++) {
          resolvedMotion[WB_TYPES[mi]] = wbResolveMotion({ overlay: ov }, WB_TYPES[mi]);
        }
        flat.resolved_motion = resolvedMotion;
        var resolvedTypography = {};
        for (var ty = 0; ty < WB_TYPES.length; ty++) {
          resolvedTypography[WB_TYPES[ty]] = wbResolveTypography({ overlay: ov }, WB_TYPES[ty]);
        }
        flat.resolved_typography = resolvedTypography;
        return { overlay: flat };
      },

      apply_overlay: function (patch) {
        if (!patch || typeof patch !== 'object') {
          return { ok: false, error: 'overlay 必须是对象' };
        }
        m.calls.apply_overlay += 1;
        m.calls.lastOverlayPatch = clone(patch);
        applyOverlayPatchV2(patch);
        m.config.overlay = deepMerge(m.config.overlay || defaultOverlay(), patch);
        syncFlatOverlay();
        return {
          ok: true,
          config: clone(m.config),
          config_v2: clone(m.config_v2),
          rejected: []
        };
      },

      set_overlay_visible: function (visible) {
        var on = !!visible;
        m.config_v2.overlay.enabled = on;
        syncFlatOverlay();
        emit({ type: 'log', text: '（Mock）浮窗已' + (on ? '显示' : '隐藏') });
        return { ok: true, visible: on };
      },

      monitor_visible: function () {
        return { ok: true, visible: !!m.monitor_visible };
      },

      toggle_monitor: function (show) {
        m.monitor_visible = typeof show === 'boolean' ? show : !m.monitor_visible;
        emit({ type: 'log', text: '（Mock）监看窗口已' + (m.monitor_visible ? '打开' : '隐藏') });
        return { ok: true, visible: m.monitor_visible };
      },

      inject_mock: function (payload) {
        var p = payload && typeof payload === 'object' ? payload : {};
        m.calls.inject_mock += 1;
        m.calls.lastInject = {
          mode: 'single',
          kind: String(p.kind || 'danmaku'),
          user: String(p.user || ''),
          text: String(p.text || ''),
          speak: !!p.speak
        };
        return injectMockEvent(p);
      },

      inject_mock_burst: function (payload) {
        var p = payload && typeof payload === 'object' ? payload : {};
        var count = parseInt(p.count, 10);
        if (!isFinite(count)) count = 10;
        count = clamp(count, 1, 200);
        var requestedKind = String(p.kind || 'mixed');
        var speak = !!p.speak;
        var kinds = ['danmaku', 'gift', 'super_chat', 'guard', 'enter', 'like', 'social', 'fansclub'];
        var injected = 0;
        var spoken = 0;
        var filters = {};
        m.calls.inject_mock_burst += 1;
        m.calls.lastInject = {
          mode: 'burst',
          count: count,
          kind: requestedKind,
          speak: speak
        };
        for (var i = 0; i < count; i++) {
          var kind = requestedKind === 'mixed' ? kinds[i % kinds.length] : requestedKind;
          var res = injectMockEvent({ kind: kind, speak: speak });
          if (res.ok) {
            injected += 1;
            if (res.spoken) spoken += 1;
            else if (res.filter) filters[res.filter] = (filters[res.filter] || 0) + 1;
          }
        }
        return {
          ok: true,
          count: injected,
          kind: requestedKind,
          speak: speak,
          spoken_count: spoken,
          filtered: filters
        };
      },

      mock_auto: function (payload) {
        var p = payload && typeof payload === 'object' ? payload : {};
        m.calls.mock_auto += 1;
        m.calls.lastMockAuto = clone(p);
        updateMockAutoConfig(p);
        setMockAutoRunning(!!p.enabled);
        var status = mockAutoStatusSnapshot();
        status.ok = true;
        return status;
      },

      mock_status: function () {
        m.calls.mock_status += 1;
        return mockAutoStatusSnapshot();
      },

      list_voices: function () { return clone(voicePool); },

      preview: function (text, voice, rate, pitch, volume) {
        var t = String(text || '').slice(0, 48);
        emit({
          type: 'log',
          text: '（Mock）试听：' + t + ' · ' + (voice || m.config.tts.voice) +
            ' · ' + (rate || '+0%') + ' / ' + (pitch || '+0Hz') + ' / ' + (volume || '+0%')
        });
        return new Promise(function (resolve) { setTimeout(function () { resolve({ ok: true }); }, 160); });
      },

      replay: function (entryId) {
        var found = null;
        for (var i = 0; i < m.events.length; i++) {
          if (String(m.events[i].id) === String(entryId)) { found = m.events[i]; break; }
        }
        if (!found) return { ok: false, error: '未找到该条目' };
        emit({ type: 'log', text: '（Mock）重播：' + (found.text || readingTextOf(found)) });
        return { ok: true };
      },

      __autostart: function () {
        emit({ type: 'log', text: 'Mock 预览模式：未检测到 pywebview 后端' });
        m.timers.boot = setTimeout(function () {
          if (m.connection === 'disconnected' && m.room_id === 0) api.connect(9527);
        }, 520);
        scheduleGenerate();
      },

      __destroy: function () {
        Object.keys(m.timers).forEach(function (k) {
          if (m.timers[k]) clearTimeout(m.timers[k]);
          m.timers[k] = null;
        });
      }
    };

    window.__mockDebug = m;
    return api;
  }

  /* ============================================================
     启动
     ============================================================ */
  function startBackend(api, isMock) {
    state.api = api;
    state.isMock = !!isMock;
    state.cursor = 0;
    state.errStreak = 0;
    state.errStreaks = {};
    state.optimisticUntil = 0;
    state.errorHoldUntil = 0;
    state.errorTitle = '';
    state.cancelHoldUntil = 0;
    state.cancelIntentUntil = 0;
    state.cancelCleanup = false;
    state.lastEditAt = 0;
    state.connectInFlight = false;
    state.connectSeq = 0;
    state.connectDeadline = 0;
    state.platform = 'bilibili';
    state.roomKey = '';
    state.roomId = 0;
    state.roomTitle = '';
    state.config = null;
    state.stats = { received: 0, spoken: 0, dropped: 0, filtered: 0 };
    state.session = null;
    state.mock = null;
    state.history = null;
    state.queueLen = 0;
    state.nowPlaying = null;
    state.voices = [];
    hydrateAppVersion(api);

    els.streamList.textContent = '';
    updateStreamMeta();
    setToBottomVisible(false);
    setConnection('disconnected');
    renderStats();
    renderNowPlaying();
    renderEmptyCopy();
    setLog(isMock ? 'Mock 预览模式：未检测到 pywebview 后端' : '本地后端已就绪');

    loadVoices(false);
    lastPollAt = 0;
    lastStateAt = 0;
    startLoop();
    refreshMonitorState();
    if (wbState.pendingOpen && window.__MUTAI_SHELL__ &&
      window.__MUTAI_SHELL__.state && window.__MUTAI_SHELL__.state.view === 'picture') {
      wbState.pendingOpen = false;
      openWorkbench();
    }
  }

  /* ============================================================
     工作台壳层只读快照与动作桥
     仅暴露壳层需要的稳定字段，不复用内部可变对象
     ============================================================ */
  function workspaceOverlaySnapshot() {
    var overlay = state.config && state.config.overlay && typeof state.config.overlay === 'object'
      ? state.config.overlay
      : {};
    return {
      enabled: !!overlay.enabled,
      x: Math.round(numFromStr(overlay.x, 60)),
      y: Math.round(numFromStr(overlay.y, 120)),
      width: Math.round(numFromStr(overlay.width, 520)),
      height: Math.round(numFromStr(overlay.height, 620)),
      scale: numFromStr(overlay.scale, 1),
      click_through: !!overlay.click_through,
      always_on_top: !!overlay.always_on_top,
      opacity: numFromStr(overlay.opacity, 1)
    };
  }

  function workspaceSnapshot() {
    return {
      version: 1,
      connection: state.connection,
      platform: state.platform,
      room_key: state.roomKey || '',
      room_id: state.roomId || 0,
      room_title: state.roomTitle || '',
      monitor_visible: !!state.monitorVisible,
      stats: {
        received: state.stats.received || 0,
        spoken: state.stats.spoken || 0,
        dropped: state.stats.dropped || 0,
        filtered: state.stats.filtered || 0
      },
      session: state.session ? {
        id: state.session.id || null,
        open: !!state.session.open,
        started_at: state.session.started_at || null,
        last_event_at: state.session.last_event_at || null,
        minutes: Array.isArray(state.session.minutes) ? state.session.minutes : [],
        stats: state.session.stats || {},
        real: state.session.real || {},
        mock: state.session.mock || {}
      } : null,
      mock: state.mock ? {
        running: !!state.mock.running,
        sent: Math.max(0, Math.round(numFromStr(state.mock.sent, 0)))
      } : { running: false, sent: 0 },
      history: state.history ? {
        available: !!state.history.available,
        error: state.history.error || null,
        capabilities: state.history.capabilities || null
      } : { available: false, error: "场次存储不可用" },
      queue_len: state.queueLen || 0,
      now_playing: state.nowPlaying ? {
        user: state.nowPlaying.user || '',
        text: state.nowPlaying.text || '',
        id: state.nowPlaying.id || ''
      } : null,
      account: state.account ? {
        logged_in: !!state.account.logged_in,
        uname: state.account.uname || null,
        mid: state.account.mid || null,
        douyin: state.account.douyin && typeof state.account.douyin === 'object' ? {
          logged_in: !!state.account.douyin.logged_in,
          uname: state.account.douyin.uname || null,
          uid: state.account.douyin.uid || null
        } : { logged_in: false, uname: null, uid: null }
      } : { logged_in: false, uname: null, mid: null },
      is_mock: !!state.isMock,
      overlay: workspaceOverlaySnapshot()
    };
  }

  function handleWorkspaceViewChange(event) {
    var detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
    if (detail.view === 'picture') {
      openWorkbench();
      refreshMonitorState();
      return;
    }
    if (window.MutaiApp.modules.wbWindow &&
      typeof window.MutaiApp.modules.wbWindow.wbStopGeometryPoll === 'function') {
      window.MutaiApp.modules.wbWindow.wbStopGeometryPoll();
    }
    if (detail.view !== 'danmaku') return;
    refreshMonitorState();
    requestAnimationFrame(function () {
      processLongItems();
      if (state.following) scrollToBottom();
    });
  }

  function installWorkspaceApi() {
    window.MutaiWorkspace = Object.freeze({
      getSnapshot: workspaceSnapshot,
      toggleOverlay: function () {
        var enabled = !!(overlayState.visible || getPath(state.config || {}, 'overlay.enabled'));
        return setOverlayMasterSwitch(!enabled);
      },
      openOverlayWorkbench: openWorkbenchPage,
      openAppearance: function () {
        var button = document.getElementById('appearanceBtn');
        if (button) button.click();
      },
      openLogin: function () {
        if (els.accountBtn) els.accountBtn.click();
      },
      historyStatus: function () {
        return call('history_status', [], null);
      },
      getConfigStatus: function () {
        if (!state.api || typeof state.api.config_status !== 'function') {
          return Promise.resolve(null);
        }
        return call('config_status', [], null);
      },
      listSessions: function (limit, offset, filters) {
        var f = filters && typeof filters === 'object' ? filters : {};
        return call('history_list_sessions', [
          limit || 30,
          offset || 0,
          f.query || '',
          f.started_from == null ? null : f.started_from,
          f.started_to == null ? null : f.started_to,
          f.platform || null,
          f.before_started_at == null ? null : f.before_started_at,
          f.before_id || null
        ], null);
      },
      getSession: function (sessionId) {
        return call('history_get_session', [sessionId], null);
      },
      previousSession: function (sessionId) {
        return call('history_get_previous_session', [sessionId], null);
      },
      listBaselines: function (targetId, limit, cursor) {
        var c = cursor && typeof cursor === 'object' ? cursor : {};
        if (!state.api || typeof state.api.history_list_baselines !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供任意基准场对比',
            candidates: []
          });
        }
        return call('history_list_baselines', [
          targetId,
          limit == null ? 30 : limit,
          c.distance_seconds == null ? null : c.distance_seconds,
          c.started_at == null ? null : c.started_at,
          c.id || null,
          c.target_id || null
        ], null);
      },
      compareSessions: function (targetId, baselineId) {
        if (!state.api || typeof state.api.history_compare_sessions !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供任意基准场对比',
            target: null,
            baseline: null
          });
        }
        return call('history_compare_sessions', [targetId, baselineId], null);
      },
      compareMultiSessions: function (targetId, baselineIds) {
        if (!state.api || typeof state.api.history_compare_multi !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供多基准场对比',
            target: null,
            baselines: []
          });
        }
        return call('history_compare_multi', [
          targetId,
          Array.isArray(baselineIds) ? baselineIds : []
        ], null);
      },
      sessionInsights: function (targetId) {
        if (!state.api || typeof state.api.history_session_insights !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供场次复盘'
          });
        }
        return call('history_session_insights', [targetId], null);
      },
      prunePreview: function (cutoffTs, keepLatest) {
        return call('history_prune_preview', [cutoffTs, keepLatest || 1], null);
      },
      pruneHistory: function (cutoffTs, keepLatest) {
        return call('history_prune', [cutoffTs, keepLatest || 1], null);
      },
      historySettings: function () {
        return call('history_settings', [], null);
      },
      updateHistorySettings: function (patch) {
        return call('history_update_settings', [patch], null);
      },
      trendSessions: function (startedFrom, startedTo, query, platform, granularity, roomKey) {
        return call('history_trend', [
          startedFrom,
          startedTo,
          query || '',
          platform || null,
          granularity || 'day',
          roomKey || null
        ], null);
      },
      exportSession: function (sessionId, format) {
        return call('history_export_session', [sessionId, format || 'json'], null);
      },
      exportTrendReport: function (startedFrom, startedTo, query, platform, granularity, roomKey, format) {
        if (!state.api || typeof state.api.history_export_trend !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供趋势报告导出'
          });
        }
        return call('history_export_trend', [
          startedFrom,
          startedTo,
          query || '',
          platform || null,
          granularity || 'day',
          roomKey || null,
          format || 'json'
        ], null);
      },
      exportCompareReport: function (targetId, baselineId, format) {
        if (!state.api || typeof state.api.history_export_compare !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供对比报告导出'
          });
        }
        return call('history_export_compare', [
          targetId,
          baselineId,
          format || 'json'
        ], null);
      },
      exportCompareMultiReport: function (targetId, baselineIds, format) {
        if (!state.api || typeof state.api.history_export_compare_multi !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供多场对比报告导出'
          });
        }
        return call('history_export_compare_multi', [
          targetId,
          Array.isArray(baselineIds) ? baselineIds : [],
          format || 'json'
        ], null);
      },
      exportInsightsReport: function (targetId, format) {
        if (!state.api || typeof state.api.history_export_insights !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供复盘报告导出'
          });
        }
        return call('history_export_insights', [
          targetId,
          format || 'json'
        ], null);
      },
      exportStorageStatus: function (week) {
        if (!state.api || typeof state.api.history_export_storage_status !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供导出目录管理'
          });
        }
        return call('history_export_storage_status', [week || null], null);
      },
      exportStoragePreview: function (days, keepLatest, week) {
        if (!state.api || typeof state.api.history_export_storage_preview !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供导出目录管理'
          });
        }
        return call('history_export_storage_preview', [
          days == null ? 90 : days,
          keepLatest == null ? 50 : keepLatest,
          week || null
        ], null);
      },
      exportStoragePrune: function (previewId, days, keepLatest, week) {
        if (!state.api || typeof state.api.history_export_storage_prune !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供导出目录管理'
          });
        }
        return call('history_export_storage_prune', [
          previewId,
          days == null ? 90 : days,
          keepLatest == null ? 50 : keepLatest,
          week || null
        ], null);
      },
      openExportDir: function () {
        if (!state.api || typeof state.api.history_export_storage_open_dir !== 'function') {
          return Promise.resolve({
            ok: false,
            available: false,
            error_code: 'unsupported',
            error: '后端未提供导出目录管理'
          });
        }
        return call('history_export_storage_open_dir', [], null);
      },
      deleteSession: function (sessionId) {
        return call('history_delete_session', [sessionId], null);
      }
    });
    document.addEventListener('mutai:viewchange', handleWorkspaceViewChange);
  }

  function boot() {
    if (hasBridge()) {
      startBackend(window.pywebview.api, false);
      return;
    }

    var settled = false;

    var useBridge = function () {
      if (settled || !hasBridge()) return false;
      settled = true;
      if (state.api && typeof state.api.__destroy === 'function') state.api.__destroy();
      startBackend(window.pywebview.api, false);
      return true;
    };

    window.addEventListener('pywebviewready', useBridge);

    setTimeout(function () {
      if (settled || useBridge()) return;
      settled = true;
      var mock = createMockAPI();
      startBackend(mock, true);
      if (typeof mock.__autostart === 'function') mock.__autostart();
    }, DETECT_TIMEOUT);
  }

  function init() {
    wbInit();
    mountWorkbenchInPage();
    bindUI();
    installWorkspaceApi();
    updateStreamMeta();
    renderStatus();
    renderConnectButton();
    setLog('初始化中…');
    boot();
  }

  window.MutaiApp = {
    version: 1,
    state: state,
    els: els,
    overlayState: overlayState,
    helpers: {
      call: call,
      clamp: clamp,
      closeLoginModal: closeLoginModal,
      clearRoomError: clearRoomError,
      deepMerge: deepMerge,
      defaultConfig: defaultConfig,
      defaultOverlay: defaultOverlay,
      describeEvent: describeEvent,
      el: el,
      errorHeadline: errorHeadline,
      extractOverlayConfig: extractOverlayConfig,
      fmtSigned: fmtSigned,
      fmtTime: fmtTime,
      getPath: getPath,
      guardName: guardName,
      icon: icon,
      numFromStr: numFromStr,
      overlayApi: overlayApi,
      overlayErrorText: overlayErrorText,
      pollState: pollState,
      renderAccount: renderAccount,
      round2: round2,
      sampleTextForVoice: sampleTextForVoice,
      setConnection: setConnection,
      setLog: setLog,
      setOverlayButtonActive: setOverlayButtonActive,
      shake: shake,
      showRoomError: showRoomError,
      userColor: userColor,
      voiceLang: voiceLang
    },
    constants: {
      BADGE_LABEL: BADGE_LABEL,
      CANCEL_GRACE_MS: CANCEL_GRACE_MS,
      CANCEL_INTENT_MS: CANCEL_INTENT_MS,
      CJK_VOICE_LANGS: CJK_VOICE_LANGS,
      CLAMP_MIN_CHARS: CLAMP_MIN_CHARS,
      ERROR_HOLD_MS: ERROR_HOLD_MS,
      LOCALE_LABELS: LOCALE_LABELS,
      MAX_ITEMS: MAX_ITEMS,
      MOCK_AUTO_TYPE_KEYS: MOCK_AUTO_TYPE_KEYS,
      MOCK_AUTO_TYPE_LABELS: MOCK_AUTO_TYPE_LABELS,
      MOCK_FILTER_LABELS: MOCK_FILTER_LABELS,
      SLIDER_SPECS: SLIDER_SPECS,
      SYNC_FOCUS_MS: SYNC_FOCUS_MS,
      ZONE_ORDER: ZONE_ORDER
    },
    modules: {}
  };
  window.MutaiApp.workbench = {
    state: wbState,
    dom: wbDom,
    confirm: wbConfirmState,
    constants: {
      WB_DIRECTION_LABELS: WB_DIRECTION_LABELS,
      WB_DIRECTION_VECTORS: WB_DIRECTION_VECTORS,
      WB_FIELD_META: WB_FIELD_META,
      WB_MOTION_FIELD_COUNT: WB_MOTION_FIELD_COUNT,
      WB_MOTION_FIELD_META: WB_MOTION_FIELD_META,
      WB_STYLE_FIELD_COUNT: WB_STYLE_FIELD_COUNT,
      WB_STYLE_FIELDS: WB_STYLE_FIELDS,
      WB_TYPE_BADGE: WB_TYPE_BADGE,
      WB_TYPES: WB_TYPES,
      WB_MOTION_FIELDS: WB_MOTION_FIELDS,
      WB_TYPOGRAPHY_FIELD_COUNT: WB_TYPOGRAPHY_FIELD_COUNT,
      WB_TYPOGRAPHY_FIELDS: WB_TYPOGRAPHY_FIELDS,
      WB_TYPOGRAPHY_FONT_SUGGESTIONS: WB_TYPOGRAPHY_FONT_SUGGESTIONS,
      WB_PIN_DEFAULTS: WB_PIN_DEFAULTS,
      WB_TYPES_BY_PLATFORM: WB_TYPES_BY_PLATFORM,
      WB_PIN_LANES_BY_PLATFORM: WB_PIN_LANES_BY_PLATFORM,
      WB_THEME_META: WB_THEME_META,
      WB_TYPE_META: WB_TYPE_META
    },
    helpers: {
      clamp: clamp,
      wbActiveTheme: wbActiveTheme,
      wbCancelMotionPreview: wbCancelMotionPreview,
      wbClone: wbClone,
      wbComputeBudget: wbComputeBudget,
      wbConfirm: wbConfirm,
      wbEscape: wbEscape,
      wbFinite: wbFinite,
      wbFieldRowHtml: wbFieldRowHtml,
      wbFontStack: wbFontStack,
      wbMarkDirty: wbMarkDirty,
      wbMotionCoverageCount: wbMotionCoverageCount,
      wbNormalizeMotionValue: wbNormalizeMotionValue,
      wbNormalizeConfig: wbNormalizeConfig,
      wbNormalizeHex: wbNormalizeHex,
      wbNormalizeMotion: wbNormalizeMotion,
      wbNormalizeMotionOverride: wbNormalizeMotionOverride,
      wbNormalizeMotionPartial: wbNormalizeMotionPartial,
      wbNormalizePins: wbNormalizePins,
      wbNormalizeStylePatch: wbNormalizeStylePatch,
      wbNormalizeStyleOverride: wbNormalizeStyleOverride,
      wbNormalizeTypography: wbNormalizeTypography,
      wbNormalizeTypographyOverride: wbNormalizeTypographyOverride,
      wbNormalizeTypographyPatch: wbNormalizeTypographyPatch,
      wbNormalizeTypographyValue: wbNormalizeTypographyValue,
      wbPinLanesForPlatform: wbPinLanesForPlatform,
      wbPlatform: wbPlatform,
      wbTypesForPlatform: wbTypesForPlatform,
      wbRenderEditor: wbRenderEditor,
      wbRenderMockControls: wbRenderMockControls,
      wbRenderMotionEditor: wbRenderMotionEditor,
      wbRenderRules: wbRenderRules,
      wbRenderBaseline: wbRenderBaseline,
      wbRenderTypographyEditor: wbRenderTypographyEditor,
      wbRenderWindow: wbRenderWindow,
      wbRestoreAllMotion: wbRestoreAllMotion,
      wbRestoreAllTypography: wbRestoreAllTypography,
      wbRestoreCurrentMotion: wbRestoreCurrentMotion,
      wbRestoreCurrentTypography: wbRestoreCurrentTypography,
      wbResolveBaseStyle: wbResolveBaseStyle,
      wbResolveMotion: wbResolveMotion,
      wbResolveStyle: wbResolveStyle,
      wbResolveTypography: wbResolveTypography,
      wbResolveTypographyGlobal: wbResolveTypographyGlobal,
      wbRgba: wbRgba,
      wbRound: wbRound,
      wbScheduleStructureFit: wbScheduleStructureFit,
      wbSetDebugTab: wbSetDebugTab,
      wbSetError: wbSetError,
      wbSetStatus: wbSetStatus,
      wbSetStyleDomain: wbSetStyleDomain,
      wbSetSwitch: wbSetSwitch,
      wbShowToast: wbShowToast,
      wbStyleValue: wbStyleValue,
      wbTypographyCoverageCount: wbTypographyCoverageCount,
      wbUpdateCapture: wbUpdateCapture,
      wbUpdateCoverageDisplay: wbUpdateCoverageDisplay,
      wbUpdateRulesBudget: wbUpdateRulesBudget,
      wbUpdateTypeCounts: wbUpdateTypeCounts,
      wbTypeCoverageCount: wbTypeCoverageCount,
      wbTypeCoverageTotal: wbTypeCoverageTotal
    },
    modules: {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

