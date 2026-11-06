/* ============================================================
   弹幕朗读器 · 浮窗内容层
   - pywebview 桥接 / 500ms 配置热更新 / 增量弹幕拉取
   - 无桥自动进入 Mock 模式，双击 HTML 即可预览
   - 零外部资源，所有内容使用 textContent 渲染
   ============================================================ */
(function () {
  'use strict';

  var root = document.documentElement;
  var body = document.body;
  var stage = document.getElementById('stage');
  var feed = document.getElementById('feed');
  var controls = document.getElementById('controls');
  var dragBar = document.getElementById('dragBar');
  var resizeHandle = document.getElementById('resizeHandle');

  var OVERLAY_TYPES = ['danmaku', 'gift', 'super_chat', 'guard', 'enter'];
  var THEMES = ['classic', 'shortvideo', 'minimal', 'highcontrast'];
  var CONFIG_POLL_MS = 500;
  var ITEM_POLL_MS = 260;
  var ITEM_RETRY_MS = 900;
  var API_TIMEOUT_MS = 2400;
  var OUTRO_MS = 220;
  var MIN_WINDOW_W = 220;
  var MIN_WINDOW_H = 140;
  var MAX_WINDOW_W = 12000;
  var MAX_WINDOW_H = 12000;
  var MAX_SEEN = 1800;

  var BASE_CONFIG = {
    enabled: true,
    x: 80,
    y: 80,
    width: 520,
    height: 620,
    font_family: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif',
    font_size: 28,
    font_weight: 600,
    line_height: 1.45,
    color: '#ffffff',
    name_color: '#8ed8ff',
    name_sep: '：',
    show_name: true,
    name_max_len: 14,
    text_max_len: 120,
    outline: true,
    outline_color: '#000000',
    outline_width: 2,
    shadow: true,
    bg_color: '#05080e',
    bg_opacity: 0.48,
    opacity: 1,
    align: 'left',
    max_lines: 8,
    animation: 'fade',
    dwell_ms: 12000,
    gap: 10,
    types: {
      danmaku: true,
      gift: true,
      super_chat: true,
      guard: true,
      enter: true
    },
    click_through: false,
    always_on_top: true,
    show_avatar: true,
    theme: 'classic'
  };

  var THEME_PRESETS = {
    classic: {
      font_size: 27,
      font_weight: 600,
      line_height: 1.44,
      color: '#ffffff',
      name_color: '#8ed8ff',
      outline: true,
      outline_color: '#000000',
      outline_width: 2,
      shadow: true,
      bg_color: '#05080e',
      bg_opacity: 0.48
    },
    shortvideo: {
      font_size: 38,
      font_weight: 800,
      line_height: 1.32,
      color: '#ffffff',
      name_color: '#ffe08a',
      outline: true,
      outline_color: '#000000',
      outline_width: 3.4,
      shadow: true,
      bg_color: '#000000',
      bg_opacity: 0
    },
    minimal: {
      font_size: 27,
      font_weight: 400,
      line_height: 1.5,
      color: '#f7f9ff',
      name_color: '#b5c3d9',
      outline: false,
      outline_color: '#000000',
      outline_width: 0,
      shadow: false,
      bg_color: '#08101d',
      bg_opacity: 0.13
    },
    highcontrast: {
      font_size: 31,
      font_weight: 700,
      line_height: 1.42,
      color: '#ffffff',
      name_color: '#ffffff',
      outline: true,
      outline_color: '#000000',
      outline_width: 2.6,
      shadow: false,
      bg_color: '#000000',
      bg_opacity: 0.85
    }
  };

  var THEME_FIELDS = [
    'font_size', 'font_weight', 'line_height', 'color', 'name_color',
    'outline', 'outline_color', 'outline_width', 'shadow',
    'bg_color', 'bg_opacity'
  ];

  /* 后端返回的是合并后的完整配置。为避免默认值永久压住主题预设：
   * 首轮把仍处于中性默认区间的视觉字段视为“未显式覆盖”，
   * 运行时真正变化过的字段才进入 explicit，并在后续换主题时继续优先。
   */

  var MOCK_CONFIG = Object.assign({}, BASE_CONFIG, {
    x: 64,
    y: 56,
    width: 520,
    height: 620,
    font_size: 28,
    font_weight: 600,
    line_height: 1.45,
    color: '#ffffff',
    name_color: '#8ed8ff',
    name_sep: '：',
    show_name: true,
    name_max_len: 14,
    text_max_len: 160,
    outline: true,
    outline_color: '#000000',
    outline_width: 2,
    shadow: true,
    bg_color: '#05080e',
    bg_opacity: 0.48,
    opacity: 1,
    align: 'left',
    max_lines: 8,
    animation: 'fade',
    dwell_ms: 14000,
    gap: 9,
    click_through: false,
    always_on_top: true,
    show_avatar: true,
    theme: 'classic',
    types: {
      danmaku: true,
      gift: true,
      super_chat: true,
      guard: true,
      enter: true
    }
  });

  var MOCK_ITEMS = [
    {
      type: 'danmaku',
      user: '夜色微凉',
      uid: 10021,
      text: '这个转场也太丝滑了吧，主播今晚状态拉满。'
    },
    {
      type: 'gift',
      user: '柠檬气泡水',
      uid: 10022,
      meta: { gift_name: '星河飞船', num: 6, price: 66 }
    },
    {
      type: 'super_chat',
      user: '三月的风',
      uid: 10023,
      text: '求唱《晴天》！耳机已经戴好，等一个开口即跪。',
      meta: { message: '求唱《晴天》！耳机已经戴好，等一个开口即跪。', price: 30 }
    },
    {
      type: 'guard',
      user: '阿澈不熬夜',
      uid: 10024,
      meta: { guard_level: 2, guard_name: '提督' }
    },
    {
      type: 'enter',
      user: '一只柯基',
      uid: 10025,
      meta: {}
    },
    {
      type: 'danmaku',
      user: '听风者',
      uid: 10026,
      text: '声音好稳，混响也调得刚刚好，戴上耳机更明显。'
    },
    {
      type: 'gift',
      user: '半糖去冰',
      uid: 10027,
      meta: { gift_name: '小心心', num: 10, price: 1 }
    },
    {
      type: 'danmaku',
      user: '橘子汽水',
      uid: 10028,
      text: '刚下班赶来，今晚能多聊一会儿吗？明早还要早起。'
    },
    {
      type: 'super_chat',
      user: '暮色四合',
      uid: 10029,
      text: '第一次来就听到这首歌，今天运气真好。',
      meta: { message: '第一次来就听到这首歌，今天运气真好。', price: 50 }
    },
    {
      type: 'guard',
      user: '星河入梦',
      uid: 10030,
      meta: { guard_level: 3, guard_name: '舰长' }
    },
    {
      type: 'enter',
      user: '月见草',
      uid: 10031,
      meta: {}
    }
  ];

  var ICONS = {
    gift:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<rect x="4" y="9" width="16" height="11" rx="1.8"/>' +
      '<path d="M3.4 9h17.2M12 9v11"/>' +
      '<path d="M12 9C9.2 9 7.2 7.8 7.2 6.1c0-1.1.9-1.9 2-1.9 1.8 0 2.8 2.3 2.8 4.8Z"/>' +
      '<path d="M12 9c2.8 0 4.8-1.2 4.8-2.9 0-1.1-.9-1.9-2-1.9-1.8 0-2.8 2.3-2.8 4.8Z"/></svg>',
    sc:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M20.2 11.5a7.9 7.9 0 0 1-8.2 7.7 8.8 8.8 0 0 1-2.7-.4l-4.7 1.3 1.2-4.2a7.5 7.5 0 1 1 14.4-4.4Z"/>' +
      '<path d="M9.3 10.3v4.2M12 8.6v5.9M14.7 10.3v4.2"/></svg>',
    enter:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M4 12h11M11.5 8.5 15 12l-3.5 3.5"/>' +
      '<path d="M15 5h3.5A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5H15"/></svg>'
  };

  var state = {
    mode: 'boot',
    raw: null,
    effective: null,
    explicit: new Set(),
    signature: '',
    geometry: {
      x: BASE_CONFIG.x,
      y: BASE_CONFIG.y,
      width: BASE_CONFIG.width,
      height: BASE_CONFIG.height
    },
    cursor: 0,
    active: [],
    pending: [],
    seen: new Set(),
    seenOrder: [],
    pumping: false,
    configTimer: 0,
    itemTimer: 0,
    itemLoopStarted: false,
    bootTimer: 0,
    bootSettled: false,
    configOk: false,
    drag: null,
    resize: null,
    mock: {
      seq: 0,
      next: 0,
      paused: false,
      tickTimer: 0,
      seedTimers: []
    }
  };

  var colorCanvas = null;
  var colorContext = null;
  var colorCache = new Map();

  /* ---------------- 基础工具 ---------------- */

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function clampNumber(value, min, max, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function intClamp(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
  }

  function boolValue(value, fallback) {
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    var text = String(value).trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') {
      return true;
    }
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') {
      return false;
    }
    return fallback;
  }

  function stringValue(value, fallback, maxLength) {
    if (value === undefined || value === null) {
      return fallback;
    }
    var text = String(value);
    if (!text && fallback) {
      return fallback;
    }
    return text.slice(0, maxLength || 4000);
  }

  function fontWeight(value, fallback) {
    if (typeof value === 'string') {
      var word = value.trim().toLowerCase();
      if (word === 'normal') {
        return 400;
      }
      if (word === 'bold') {
        return 700;
      }
      if (word === 'bolder') {
        return 800;
      }
      if (word === 'lighter') {
        return 300;
      }
    }
    return Math.round(clampNumber(value, 100, 900, fallback));
  }

  function valueEqual(a, b) {
    return a === b;
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function firstGlyph(text) {
    var chars = Array.from(String(text || '').trim());
    return chars.length ? chars[0] : '观';
  }

  function clipCodePoints(text, limit) {
    var chars = Array.from(String(text || ''));
    if (!limit || chars.length <= limit) {
      return String(text || '');
    }
    return chars.slice(0, limit).join('') + '…';
  }

  function positiveInt(value, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      return fallback;
    }
    return Math.max(1, Math.round(number));
  }

  function finiteNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatPrice(value) {
    var number = finiteNumber(value);
    if (number === null || number <= 0) {
      return '';
    }
    if (Math.abs(number - Math.round(number)) < 0.001) {
      return String(Math.round(number));
    }
    return number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function colorInfo(value) {
    var text = String(value || '').trim();
    if (!text) {
      return null;
    }
    if (colorCache.has(text)) {
      return colorCache.get(text);
    }
    try {
      if (window.CSS && typeof window.CSS.supports === 'function' && !window.CSS.supports('color', text)) {
        return null;
      }
      if (!colorContext) {
        colorCanvas = document.createElement('canvas');
        colorCanvas.width = 1;
        colorCanvas.height = 1;
        colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!colorContext) {
        return null;
      }
      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = text;
      colorContext.fillRect(0, 0, 1, 1);
      var data = colorContext.getImageData(0, 0, 1, 1).data;
      var info = {
        r: data[0],
        g: data[1],
        b: data[2],
        a: data[3] / 255
      };
      if (colorCache.size > 160) {
        colorCache.clear();
      }
      colorCache.set(text, info);
      return info;
    } catch (error) {
      return null;
    }
  }

  function safeColor(value, fallback) {
    var text = String(value || '').trim();
    if (!text) {
      return fallback;
    }
    if (window.CSS && typeof window.CSS.supports === 'function' && window.CSS.supports('color', text)) {
      return text;
    }
    return fallback;
  }

  function rgbaColor(value, opacity) {
    var info = colorInfo(value);
    var alpha = clampNumber(opacity, 0, 1, 0) * (info ? info.a : 1);
    if (!info || alpha <= 0) {
      return 'rgba(0, 0, 0, 0)';
    }
    return 'rgba(' + info.r + ', ' + info.g + ', ' + info.b + ', ' + alpha.toFixed(3) + ')';
  }

  function safeFontFamily(value) {
    var text = String(value || '').trim();
    if (!text) {
      return BASE_CONFIG.font_family;
    }
    if (window.CSS && typeof window.CSS.supports === 'function' && window.CSS.supports('font-family', text)) {
      return text;
    }
    return BASE_CONFIG.font_family;
  }

  function isNearColor(value, predicate) {
    var info = colorInfo(value);
    return !!info && info.a > 0.2 && predicate(info);
  }

  function isNeutralThemeValue(field, value) {
    if (field === 'font_size') {
      var size = Number(value);
      return Number.isFinite(size) && size >= 24 && size <= 34;
    }
    if (field === 'font_weight') {
      var weight = fontWeight(value, 600);
      return weight === 400 || weight === 500 || weight === 600;
    }
    if (field === 'line_height') {
      var height = Number(value);
      return Number.isFinite(height) && height >= 1.3 && height <= 1.55;
    }
    if (field === 'color') {
      return isNearColor(value, function (color) {
        return color.r >= 230 && color.g >= 230 && color.b >= 230;
      });
    }
    if (field === 'name_color') {
      return isNearColor(value, function (color) {
        return color.b >= 205 && color.b - color.r >= 22 && color.g >= 135;
      });
    }
    if (field === 'bg_color' || field === 'outline_color') {
      return isNearColor(value, function (color) {
        return color.r <= 42 && color.g <= 42 && color.b <= 42;
      });
    }
    if (field === 'bg_opacity') {
      var opacity = Number(value);
      return Number.isFinite(opacity) && opacity >= 0.2 && opacity <= 0.62;
    }
    if (field === 'outline') {
      return boolValue(value, true) === true;
    }
    if (field === 'outline_width') {
      var width = Number(value);
      return Number.isFinite(width) && width > 0 && width <= 2.6;
    }
    if (field === 'shadow') {
      return boolValue(value, true) === true;
    }
    return false;
  }

  function declaredExplicitFields(source) {
    var fields = new Set();
    var candidates = [
      source && source._explicit,
      source && source.theme_overrides,
      source && source._theme_overrides
    ];
    candidates.forEach(function (candidate) {
      if (Array.isArray(candidate)) {
        candidate.forEach(function (field) {
          if (THEME_FIELDS.indexOf(field) !== -1) {
            fields.add(field);
          }
        });
      } else if (isObject(candidate)) {
        Object.keys(candidate).forEach(function (field) {
          if (THEME_FIELDS.indexOf(field) !== -1 && candidate[field]) {
            fields.add(field);
          }
        });
      }
    });
    return fields;
  }

  /* ---------------- 配置归一化与主题 ---------------- */

  function unwrapOverlayConfig(value) {
    var source = value;
    if (typeof source === 'string') {
      try {
        source = JSON.parse(source);
      } catch (error) {
        return {};
      }
    }
    if (!isObject(source)) {
      return {};
    }
    if (isObject(source.overlay)) {
      return source.overlay;
    }
    if (isObject(source.config) && isObject(source.config.overlay)) {
      return source.config.overlay;
    }
    return source;
  }

  function normalizeConfig(value) {
    var source = isObject(value) ? value : {};
    var typeSource = isObject(source.types) ? source.types : {};
    var types = {};
    OVERLAY_TYPES.forEach(function (type) {
      types[type] = boolValue(typeSource[type], BASE_CONFIG.types[type]);
    });

    var themeName = String(source.theme || BASE_CONFIG.theme).trim().toLowerCase();
    if (THEMES.indexOf(themeName) === -1) {
      themeName = 'classic';
    }

    var align = String(source.align || BASE_CONFIG.align).trim().toLowerCase();
    if (align !== 'left' && align !== 'center' && align !== 'right') {
      align = 'left';
    }

    var animation = String(source.animation || BASE_CONFIG.animation).trim().toLowerCase();
    if (animation !== 'none' && animation !== 'fade' && animation !== 'slide') {
      animation = 'fade';
    }

    return {
      enabled: boolValue(source.enabled, BASE_CONFIG.enabled),
      x: clampNumber(source.x, -100000, 100000, BASE_CONFIG.x),
      y: clampNumber(source.y, -100000, 100000, BASE_CONFIG.y),
      width: clampNumber(source.width, 80, MAX_WINDOW_W, BASE_CONFIG.width),
      height: clampNumber(source.height, 80, MAX_WINDOW_H, BASE_CONFIG.height),
      font_family: stringValue(source.font_family, BASE_CONFIG.font_family, 500),
      font_size: clampNumber(source.font_size, 10, 96, BASE_CONFIG.font_size),
      font_weight: fontWeight(source.font_weight, BASE_CONFIG.font_weight),
      line_height: clampNumber(source.line_height, 1, 2.6, BASE_CONFIG.line_height),
      color: stringValue(source.color, BASE_CONFIG.color, 80),
      name_color: stringValue(source.name_color, BASE_CONFIG.name_color, 80),
      name_sep: stringValue(source.name_sep, BASE_CONFIG.name_sep, 12),
      show_name: boolValue(source.show_name, BASE_CONFIG.show_name),
      name_max_len: intClamp(source.name_max_len, 0, 64, BASE_CONFIG.name_max_len),
      text_max_len: intClamp(source.text_max_len, 1, 2000, BASE_CONFIG.text_max_len),
      outline: boolValue(source.outline, BASE_CONFIG.outline),
      outline_color: stringValue(source.outline_color, BASE_CONFIG.outline_color, 80),
      outline_width: clampNumber(source.outline_width, 0, 8, BASE_CONFIG.outline_width),
      shadow: boolValue(source.shadow, BASE_CONFIG.shadow),
      bg_color: stringValue(source.bg_color, BASE_CONFIG.bg_color, 80),
      bg_opacity: clampNumber(source.bg_opacity, 0, 1, BASE_CONFIG.bg_opacity),
      opacity: clampNumber(source.opacity, 0, 1, BASE_CONFIG.opacity),
      align: align,
      max_lines: intClamp(source.max_lines, 1, 30, BASE_CONFIG.max_lines),
      animation: animation,
      dwell_ms: clampNumber(source.dwell_ms, 0, 3600000, BASE_CONFIG.dwell_ms),
      gap: clampNumber(source.gap, 0, 48, BASE_CONFIG.gap),
      types: types,
      click_through: boolValue(source.click_through, BASE_CONFIG.click_through),
      always_on_top: boolValue(source.always_on_top, BASE_CONFIG.always_on_top),
      show_avatar: boolValue(source.show_avatar, BASE_CONFIG.show_avatar),
      theme: themeName
    };
  }

  function resolveEffective(raw, explicit) {
    var resolved = Object.assign({}, raw);
    var preset = THEME_PRESETS[raw.theme] || THEME_PRESETS.classic;
    THEME_FIELDS.forEach(function (field) {
      if (own(preset, field) && !explicit.has(field)) {
        resolved[field] = preset[field];
      }
    });
    return resolved;
  }

  function explicitSignature() {
    return Array.from(state.explicit).sort().join('|');
  }

  function updateExplicitFields(source, next, previous, first, themeChanged) {
    var before = explicitSignature();
    var fields = first ? new Set() : new Set(state.explicit);

    if (first) {
      THEME_FIELDS.forEach(function (field) {
        if (own(source, field) && !isNeutralThemeValue(field, source[field])) {
          fields.add(field);
        }
      });
    } else if (themeChanged) {
      THEME_FIELDS.forEach(function (field) {
        if (!own(source, field) || !previous) {
          return;
        }
        var changed = !valueEqual(next[field], previous[field]);
        var preset = THEME_PRESETS[next.theme] || {};
        if (changed && !valueEqual(next[field], preset[field])) {
          fields.add(field);
        }
      });
    } else {
      THEME_FIELDS.forEach(function (field) {
        if (!own(source, field) || !previous) {
          return;
        }
        if (!valueEqual(next[field], previous[field])) {
          fields.add(field);
        }
      });
    }

    declaredExplicitFields(source).forEach(function (field) {
      fields.add(field);
    });
    state.explicit = fields;
    return before !== explicitSignature();
  }

  function buildTextShadow(config) {
    var shadows = [];
    var width = config.outline ? clampNumber(config.outline_width, 0, 8, 0) : 0;
    if (width > 0) {
      var outlineColor = safeColor(config.outline_color, '#000000');
      var radius = width * 0.82;
      for (var index = 0; index < 8; index += 1) {
        var angle = Math.PI * 2 * index / 8;
        var x = Math.round(Math.cos(angle) * radius * 100) / 100;
        var y = Math.round(Math.sin(angle) * radius * 100) / 100;
        shadows.push(x + 'px ' + y + 'px 0 ' + outlineColor);
      }
    }
    if (config.shadow) {
      var dropY = Math.max(1, config.font_size * 0.055).toFixed(1);
      var blur = Math.max(2.5, config.font_size * 0.16).toFixed(1);
      shadows.push('0 ' + dropY + 'px ' + blur + 'px rgba(0, 0, 0, .78)');
    }
    return shadows.length ? shadows.join(', ') : 'none';
  }

  function itemBorderColor(config) {
    if (config.bg_opacity <= 0.015) {
      return 'transparent';
    }
    if (config.theme === 'minimal') {
      return 'rgba(255, 255, 255, .065)';
    }
    if (config.theme === 'highcontrast') {
      return 'rgba(255, 255, 255, .18)';
    }
    return 'rgba(255, 255, 255, .115)';
  }

  function applyEffectiveStyles(config) {
    var outlineWidth = config.outline ? clampNumber(config.outline_width, 0, 8, 0) : 0;
    var strokeWidth = outlineWidth * 0.45;

    root.style.setProperty('--ob-font-family', safeFontFamily(config.font_family));
    root.style.setProperty('--ob-font-size', config.font_size.toFixed(2).replace(/\.00$/, '') + 'px');
    root.style.setProperty('--ob-font-weight', String(config.font_weight));
    root.style.setProperty('--ob-line-height', String(config.line_height));
    root.style.setProperty('--ob-text-color', safeColor(config.color, '#ffffff'));
    root.style.setProperty('--ob-name-color', safeColor(config.name_color, '#8ed8ff'));
    root.style.setProperty('--ob-name-weight', String(Math.max(600, config.font_weight)));
    root.style.setProperty('--ob-outline-color', safeColor(config.outline_color, '#000000'));
    root.style.setProperty('--ob-stroke-width', strokeWidth.toFixed(2) + 'px');
    root.style.setProperty('--ob-text-shadow', buildTextShadow(config));
    root.style.setProperty('--ob-bg', rgbaColor(config.bg_color, config.bg_opacity));
    root.style.setProperty('--ob-border', itemBorderColor(config));
    root.style.setProperty('--ob-gap', config.gap.toFixed(2).replace(/\.00$/, '') + 'px');
    root.style.setProperty('--ob-opacity', String(config.opacity));

    stage.dataset.theme = config.theme;
    stage.dataset.align = config.align;
    stage.dataset.animation = config.animation;
    stage.dataset.bg = config.bg_opacity > 0.015 ? 'true' : 'false';
    stage.setAttribute('aria-hidden', config.enabled ? 'false' : 'true');
    body.dataset.theme = config.theme;
    body.dataset.enabled = config.enabled ? 'true' : 'false';
    body.dataset.clickThrough = config.click_through ? 'true' : 'false';
    body.dataset.alwaysOnTop = config.always_on_top ? 'true' : 'false';
    feed.setAttribute('aria-live', config.enabled ? 'polite' : 'off');

    var controlsAvailable = config.enabled && !config.click_through;
    controls.hidden = !controlsAvailable;
    controls.setAttribute('aria-hidden', controlsAvailable ? 'false' : 'true');

    if ((!controlsAvailable) && (state.drag || state.resize)) {
      cancelInteractions();
    }
  }

  function applyConfig(value, options) {
    options = options || {};
    var source = unwrapOverlayConfig(value);
    var next = normalizeConfig(source);
    var previous = state.raw;
    var first = !previous;
    var themeChanged = !!previous && previous.theme !== next.theme;
    var explicitChanged = updateExplicitFields(source, next, previous, first, themeChanged);
    var signature = JSON.stringify(next);
    var changed = first || options.force || themeChanged || explicitChanged || signature !== state.signature;

    if (!changed) {
      state.raw = next;
      return false;
    }

    var previousEffective = state.effective;
    var effective = resolveEffective(next, state.explicit);
    state.raw = next;
    state.effective = effective;
    state.signature = signature;

    if (!state.drag && !state.resize) {
      state.geometry = {
        x: next.x,
        y: next.y,
        width: next.width,
        height: next.height
      };
    }

    applyEffectiveStyles(effective);

    if (!effective.enabled) {
      clearAll(false);
      return true;
    }

    state.pending = state.pending.filter(function (item) {
      return effective.types[item.type] !== false;
    });
    state.active.slice().forEach(function (record) {
      if (effective.types[record.item.type] === false) {
        removeRecordNow(record, true);
      }
    });

    while (state.active.length > effective.max_lines) {
      removeRecordNow(state.active[0], true);
    }
    if (state.pending.length > effective.max_lines) {
      state.pending.splice(0, state.pending.length - effective.max_lines);
    }

    var rebuild = !previousEffective ||
      previousEffective.show_name !== effective.show_name ||
      previousEffective.name_sep !== effective.name_sep ||
      previousEffective.name_max_len !== effective.name_max_len ||
      previousEffective.show_avatar !== effective.show_avatar;

    if (rebuild) {
      state.active.forEach(function (record) {
        if (!record.leaving && record.el) {
          renderRecord(record);
        }
      });
    }

    if (!previousEffective || previousEffective.dwell_ms !== effective.dwell_ms) {
      state.active.forEach(function (record) {
        if (!record.leaving) {
          armDwell(record);
        }
      });
    }

    pump();
    return true;
  }

  /* ---------------- 弹幕条目 ---------------- */

  function normalizeItem(value) {
    if (!isObject(value)) {
      return null;
    }
    if (value.seq === undefined || value.seq === null || value.seq === '') {
      return null;
    }
    var type = OVERLAY_TYPES.indexOf(value.type) !== -1 ? value.type : 'danmaku';
    var user = stringValue(value.user, '观众', 200).trim() || '观众';
    return {
      seq: value.seq,
      seqKey: String(value.seq),
      type: type,
      user: user,
      uid: value.uid,
      text: stringValue(value.text, '', 4000),
      ts: value.ts,
      meta: isObject(value.meta) ? value.meta : {}
    };
  }

  function markSeen(key) {
    if (state.seen.has(key)) {
      return false;
    }
    state.seen.add(key);
    state.seenOrder.push(key);
    if (state.seenOrder.length > MAX_SEEN) {
      var oldest = state.seenOrder.shift();
      state.seen.delete(oldest);
    }
    return true;
  }

  function typeEnabled(type) {
    return !!state.effective && state.effective.enabled && state.effective.types[type] !== false;
  }

  function normalizeMetaText(value, fallback) {
    var text = stringValue(value, '', 600).trim();
    return text || fallback;
  }

  function guardName(meta) {
    var name = normalizeMetaText(meta.guard_name, '');
    if (name) {
      return name;
    }
    var level = Number(meta.guard_level);
    if (level === 1) {
      return '总督';
    }
    if (level === 2) {
      return '提督';
    }
    if (level === 3) {
      return '舰长';
    }
    return '大航海';
  }

  function itemDisplay(item) {
    var meta = item.meta || {};
    var result = {
      tags: [],
      body: '',
      multiplier: ''
    };

    if (item.type === 'gift') {
      var giftName = normalizeMetaText(meta.gift_name, '礼物');
      var count = positiveInt(meta.num, 1);
      result.tags.push({ kind: 'gift', label: '礼物', icon: 'gift' });
      result.body = item.text && !normalizeMetaText(meta.gift_name, '')
        ? item.text
        : '送出 ' + giftName;
      result.multiplier = '×' + count;
      return result;
    }

    if (item.type === 'super_chat') {
      var price = formatPrice(meta.price);
      result.tags.push({ kind: 'sc', label: '醒目留言', icon: 'sc' });
      result.body = normalizeMetaText(meta.message, '') || item.text || '发来一条醒目留言';
      result.price = price;
      return result;
    }

    if (item.type === 'guard') {
      var title = guardName(meta);
      result.tags.push({ kind: 'guard', label: title, guard: true });
      result.body = item.text || ('开通了 ' + title);
      return result;
    }

    if (item.type === 'enter') {
      result.tags.push({ kind: 'enter', label: '进入', icon: 'enter' });
      result.body = item.text || '进入直播间';
      return result;
    }

    result.body = item.text || '';
    return result;
  }

  function avatarStyle(user, uid) {
    var key = String(uid === undefined || uid === null ? '' : uid) + '|' + user;
    var hash = 2166136261;
    for (var index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    var hue = Math.abs(hash) % 360;
    var hueB = (hue + 42) % 360;
    return 'radial-gradient(circle at 30% 20%, rgba(255, 255, 255, .24), transparent 46%), ' +
      'linear-gradient(135deg, hsl(' + hue + ', 62%, 49%), hsl(' + hueB + ', 70%, 35%))';
  }

  function appendBadge(tags, tag) {
    var badge = make('span', 'om-badge om-badge--' + tag.kind);
    if (tag.guard) {
      badge.appendChild(make('span', 'om-guard-glyph', '舰'));
      badge.appendChild(make('span', '', tag.label));
    } else {
      if (tag.icon && ICONS[tag.icon]) {
        badge.insertAdjacentHTML('beforeend', ICONS[tag.icon]);
      }
      badge.appendChild(document.createTextNode(tag.label));
    }
    tags.appendChild(badge);
  }

  function renderRecord(record) {
    var item = record.item;
    var config = state.effective;
    var node = record.el;
    if (!node || !config) {
      return;
    }

    node.className = 'overlay-item type-' + item.type;
    node.dataset.seq = String(item.seq);
    node.dataset.type = item.type;
    node.replaceChildren();

    if (config.show_avatar) {
      var avatar = make('span', 'om-avatar', firstGlyph(item.user));
      avatar.setAttribute('aria-hidden', 'true');
      avatar.style.backgroundImage = avatarStyle(item.user, item.uid);
      node.appendChild(avatar);
    }

    var display = itemDisplay(item);
    var bodyNode = make('div', 'om-body');
    var tags = null;

    if (display.tags.length || display.price) {
      tags = make('div', 'om-tags');
      display.tags.forEach(function (tag) {
        appendBadge(tags, tag);
      });
      if (display.price) {
        tags.appendChild(make('span', 'om-price', '¥ ' + display.price));
      }
      bodyNode.appendChild(tags);
    }

    var copy = make('div', 'om-copy');
    if (config.show_name && item.user) {
      copy.appendChild(make('span', 'om-name', clipCodePoints(item.user, config.name_max_len)));
      if (config.name_sep) {
        copy.appendChild(make('span', 'om-sep', config.name_sep));
      }
    }

    var text = make('span', 'om-text', display.body);
    if (display.multiplier) {
      text.appendChild(make('span', 'om-mult', display.multiplier));
    }
    copy.appendChild(text);
    bodyNode.appendChild(copy);
    node.appendChild(bodyNode);
  }

  function armDwell(record) {
    if (!record || !state.effective) {
      return;
    }
    clearTimeout(record.dwellTimer);
    var dwell = Math.max(0, Number(state.effective.dwell_ms) || 0);
    record.dwellTimer = window.setTimeout(function () {
      record.dwellTimer = 0;
      retireRecord(record);
    }, dwell);
  }

  function addRecord(item) {
    if (!state.effective || !typeEnabled(item.type)) {
      return false;
    }
    if (state.active.length >= state.effective.max_lines) {
      return false;
    }

    var record = {
      item: item,
      el: document.createElement('div'),
      dwellTimer: 0,
      outTimer: 0,
      leaving: false,
      removed: false
    };
    record.el.setAttribute('role', 'article');
    renderRecord(record);
    feed.appendChild(record.el);
    state.active.push(record);
    armDwell(record);
    return true;
  }

  function removeRecordNow(record, deferPump) {
    if (!record || record.removed) {
      return;
    }
    record.removed = true;
    record.leaving = true;
    clearTimeout(record.dwellTimer);
    clearTimeout(record.outTimer);
    if (record.el && record.el.parentNode) {
      record.el.parentNode.removeChild(record.el);
    }
    record.el = null;
    var index = state.active.indexOf(record);
    if (index !== -1) {
      state.active.splice(index, 1);
    }
    if (!deferPump) {
      pump();
    }
  }

  function retireRecord(record) {
    if (!record || record.removed || record.leaving || !record.el) {
      return;
    }
    record.leaving = true;
    clearTimeout(record.dwellTimer);
    record.dwellTimer = 0;
    record.el.classList.add('is-leaving');
    record.outTimer = window.setTimeout(function () {
      record.outTimer = 0;
      if (!record.removed) {
        record.removed = true;
        if (record.el && record.el.parentNode) {
          record.el.parentNode.removeChild(record.el);
        }
        record.el = null;
        var index = state.active.indexOf(record);
        if (index !== -1) {
          state.active.splice(index, 1);
        }
        pump();
      }
    }, OUTRO_MS);
  }

  function pump() {
    if (state.pumping || !state.effective || !state.effective.enabled) {
      return;
    }
    state.pumping = true;
    try {
      var maxLines = state.effective.max_lines;
      while (state.active.length < maxLines && state.pending.length) {
        var next = state.pending.shift();
        if (!typeEnabled(next.type)) {
          continue;
        }
        if (!addRecord(next)) {
          state.pending.unshift(next);
          break;
        }
      }

      if (state.active.length >= maxLines && state.pending.length) {
        var alreadyLeaving = state.active.some(function (record) {
          return record.leaving;
        });
        if (alreadyLeaving) {
          return;
        }

        if (state.pending.length >= maxLines) {
          state.active.slice().forEach(function (record) {
            retireRecord(record);
          });
        } else {
          var victim = state.active.find(function (record) {
            return !record.leaving;
          });
          if (victim) {
            retireRecord(victim);
          }
        }
      }
    } finally {
      state.pumping = false;
    }
  }

  function ingestBatch(items) {
    if (!Array.isArray(items) || !items.length || !state.effective || !state.effective.enabled) {
      return;
    }

    var accepted = [];
    items.forEach(function (raw) {
      var item = normalizeItem(raw);
      if (!item) {
        return;
      }
      if (state.seen.has(item.seqKey)) {
        return;
      }
      markSeen(item.seqKey);
      if (!typeEnabled(item.type)) {
        return;
      }
      accepted.push(item);
    });

    if (!accepted.length) {
      return;
    }
    state.pending.push.apply(state.pending, accepted);
    if (state.pending.length > state.effective.max_lines) {
      state.pending.splice(0, state.pending.length - state.effective.max_lines);
    }
    pump();
  }

  function clearAll(resetSeen) {
    state.active.forEach(function (record) {
      record.removed = true;
      clearTimeout(record.dwellTimer);
      clearTimeout(record.outTimer);
      record.el = null;
    });
    state.active = [];
    state.pending = [];
    feed.replaceChildren();
    if (resetSeen) {
      state.seen.clear();
      state.seenOrder = [];
    }
  }

  /* ---------------- Python / pywebview 桥 ---------------- */

  function bridgeApi() {
    try {
      if (window.pywebview && window.pywebview.api) {
        return window.pywebview.api;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function callApi(name, args, timeout) {
    return new Promise(function (resolve, reject) {
      var api = bridgeApi();
      if (!api || typeof api[name] !== 'function') {
        reject(new Error('bridge unavailable'));
        return;
      }

      var timer = window.setTimeout(function () {
        reject(new Error('bridge timeout'));
      }, timeout || API_TIMEOUT_MS);

      var result;
      try {
        result = api[name].apply(api, args || []);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }

      Promise.resolve(result).then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function callQuiet(name, args) {
    if (state.mode !== 'real') {
      return;
    }
    callApi(name, args, 1500).catch(function () {
      /* 浮窗交互不能因后端暂时繁忙而阻塞 */
    });
  }

  async function refreshConfig() {
    try {
      var response = await callApi('get_overlay_config', [], API_TIMEOUT_MS);
      applyConfig(response);
      state.configOk = true;
      startItemPollLoop();
      return true;
    } catch (error) {
      return false;
    }
  }

  function scheduleConfigPoll(delay) {
    if (state.mode !== 'real') {
      return;
    }
    clearTimeout(state.configTimer);
    state.configTimer = window.setTimeout(function () {
      state.configTimer = 0;
      if (state.mode !== 'real') {
        return;
      }
      refreshConfig().finally(function () {
        if (state.mode === 'real') {
          scheduleConfigPoll(CONFIG_POLL_MS);
        }
      });
    }, delay);
  }

  function parseCursor(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function handleItemsResponse(response) {
    var payload = response;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (error) {
        return false;
      }
    }
    if (Array.isArray(payload)) {
      ingestBatch(payload);
      if (payload.length) {
        var last = normalizeItem(payload[payload.length - 1]);
        if (last) {
          state.cursor = Math.max(state.cursor, parseCursor(last.seq, state.cursor));
        }
      }
      return true;
    }
    if (!isObject(payload)) {
      return false;
    }

    state.cursor = parseCursor(payload.cursor, state.cursor);
    if (Array.isArray(payload.items)) {
      ingestBatch(payload.items);
      if (!own(payload, 'cursor') && payload.items.length) {
        var finalItem = normalizeItem(payload.items[payload.items.length - 1]);
        if (finalItem) {
          state.cursor = Math.max(state.cursor, parseCursor(finalItem.seq, state.cursor));
        }
      }
    }
    return true;
  }

  async function pollItems() {
    if (state.mode !== 'real' || !state.configOk) {
      return false;
    }
    try {
      var response = await callApi('overlay_items', [state.cursor], API_TIMEOUT_MS);
      return handleItemsResponse(response);
    } catch (error) {
      return false;
    }
  }

  function scheduleItemPoll(delay) {
    if (state.mode !== 'real' || !state.itemLoopStarted) {
      return;
    }
    clearTimeout(state.itemTimer);
    state.itemTimer = window.setTimeout(function () {
      state.itemTimer = 0;
      if (state.mode !== 'real' || !state.itemLoopStarted) {
        return;
      }
      var started = Date.now();
      pollItems().then(function (ok) {
        if (state.mode !== 'real' || !state.itemLoopStarted) {
          return;
        }
        var minimum = document.hidden ? 1200 : ITEM_POLL_MS;
        var elapsed = Date.now() - started;
        var wait = ok ? Math.max(40, minimum - elapsed) : ITEM_RETRY_MS;
        scheduleItemPoll(wait);
      });
    }, delay);
  }

  function startItemPollLoop() {
    if (state.mode !== 'real' || state.itemLoopStarted) {
      return;
    }
    state.itemLoopStarted = true;
    scheduleItemPoll(30);
  }

  function startRealBridge() {
    if (state.mode === 'real') {
      return;
    }
    if (state.mode === 'mock') {
      stopMock();
    }
    if (!bridgeApi()) {
      return;
    }

    state.mode = 'real';
    state.bootSettled = true;
    state.configOk = false;
    clearTimeout(state.bootTimer);
    state.bootTimer = 0;

    refreshConfig().finally(function () {
      if (state.mode === 'real') {
        scheduleConfigPoll(CONFIG_POLL_MS);
      }
    });
  }

  /* ---------------- 拖拽 / 缩放 ---------------- */

  function canManipulate() {
    return !!(state.effective && state.effective.enabled && !state.effective.click_through);
  }

  function pointerScreenPoint(event) {
    var x = Number(event.screenX);
    var y = Number(event.screenY);
    if (!Number.isFinite(x)) {
      x = Number(event.clientX) || 0;
    }
    if (!Number.isFinite(y)) {
      y = Number(event.clientY) || 0;
    }
    return { x: x, y: y };
  }

  function flushDragFrame() {
    var drag = state.drag;
    if (!drag) {
      return;
    }
    drag.frame = 0;
    var dx = Math.round(drag.pendingX);
    var dy = Math.round(drag.pendingY);
    if (!dx && !dy) {
      return;
    }
    drag.pendingX -= dx;
    drag.pendingY -= dy;
    drag.sentX += dx;
    drag.sentY += dy;
    state.geometry.x += dx;
    state.geometry.y += dy;
    callQuiet('overlay_drag', [dx, dy]);
  }

  function queueDragFrame() {
    var drag = state.drag;
    if (!drag || drag.frame) {
      return;
    }
    drag.frame = window.requestAnimationFrame(flushDragFrame);
  }

  function flushResizeFrame() {
    var resize = state.resize;
    if (!resize) {
      return;
    }
    resize.frame = 0;
    var width = Math.round(resize.targetW);
    var height = Math.round(resize.targetH);
    if (width === resize.sentW && height === resize.sentH) {
      return;
    }
    resize.sentW = width;
    resize.sentH = height;
    state.geometry.width = width;
    state.geometry.height = height;
    callQuiet('overlay_resize', [width, height]);
  }

  function queueResizeFrame() {
    var resize = state.resize;
    if (!resize || resize.frame) {
      return;
    }
    resize.frame = window.requestAnimationFrame(flushResizeFrame);
  }

  function persistGeometry() {
    if (state.mode !== 'real') {
      return;
    }
    callQuiet('overlay_geometry', [{
      x: Math.round(state.geometry.x),
      y: Math.round(state.geometry.y),
      width: Math.round(state.geometry.width),
      height: Math.round(state.geometry.height)
    }]);
  }

  function beginDrag(event) {
    if (!canManipulate() || state.drag || state.resize) {
      return;
    }
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    var point = pointerScreenPoint(event);
    event.preventDefault();
    state.drag = {
      pointerId: event.pointerId,
      lastX: point.x,
      lastY: point.y,
      pendingX: 0,
      pendingY: 0,
      sentX: 0,
      sentY: 0,
      frame: 0,
      captureNode: event.currentTarget
    };
    if (event.currentTarget && event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 部分 WebView 版本不支持捕获，窗口级监听仍可完成拖拽 */
      }
    }
    body.classList.add('is-dragging');
  }

  function beginResize(event) {
    if (!canManipulate() || state.drag || state.resize) {
      return;
    }
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    var point = pointerScreenPoint(event);
    event.preventDefault();
    var startW = Math.max(MIN_WINDOW_W, Math.round(window.innerWidth || state.geometry.width));
    var startH = Math.max(MIN_WINDOW_H, Math.round(window.innerHeight || state.geometry.height));
    state.resize = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      startW: startW,
      startH: startH,
      targetW: startW,
      targetH: startH,
      sentW: startW,
      sentH: startH,
      frame: 0,
      captureNode: event.currentTarget
    };
    if (event.currentTarget && event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 同上：无捕获模式下依靠 document 事件 */
      }
    }
    body.classList.add('is-resizing');
  }

  function onPointerMove(event) {
    if (state.drag) {
      if (event.pointerId !== state.drag.pointerId) {
        return;
      }
      var dragPoint = pointerScreenPoint(event);
      var dx = dragPoint.x - state.drag.lastX;
      var dy = dragPoint.y - state.drag.lastY;
      if (!dx && !dy) {
        return;
      }
      state.drag.lastX = dragPoint.x;
      state.drag.lastY = dragPoint.y;
      state.drag.pendingX += dx;
      state.drag.pendingY += dy;
      queueDragFrame();
      if (event.cancelable) {
        event.preventDefault();
      }
      return;
    }

    if (state.resize) {
      if (event.pointerId !== state.resize.pointerId) {
        return;
      }
      var resizePoint = pointerScreenPoint(event);
      state.resize.targetW = Math.min(
        MAX_WINDOW_W,
        Math.max(MIN_WINDOW_W, state.resize.startW + resizePoint.x - state.resize.startX)
      );
      state.resize.targetH = Math.min(
        MAX_WINDOW_H,
        Math.max(MIN_WINDOW_H, state.resize.startH + resizePoint.y - state.resize.startY)
      );
      queueResizeFrame();
      if (event.cancelable) {
        event.preventDefault();
      }
    }
  }

  function releaseCapture(node, pointerId) {
    if (!node || !node.releasePointerCapture) {
      return;
    }
    try {
      node.releasePointerCapture(pointerId);
    } catch (error) {
      /* 捕获已由系统释放时忽略 */
    }
  }

  function onPointerUp(event) {
    if (state.drag && event.pointerId === state.drag.pointerId) {
      var drag = state.drag;
      if (drag.frame) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = 0;
      }
      flushDragFrame();
      releaseCapture(drag.captureNode, drag.pointerId);
      body.classList.remove('is-dragging');
      state.drag = null;
      if (drag.sentX || drag.sentY) {
        persistGeometry();
      }
      return;
    }

    if (state.resize && event.pointerId === state.resize.pointerId) {
      var resize = state.resize;
      if (resize.frame) {
        window.cancelAnimationFrame(resize.frame);
        resize.frame = 0;
      }
      flushResizeFrame();
      releaseCapture(resize.captureNode, resize.pointerId);
      body.classList.remove('is-resizing');
      state.resize = null;
      persistGeometry();
    }
  }

  function cancelInteractions() {
    if (state.drag) {
      if (state.drag.frame) {
        window.cancelAnimationFrame(state.drag.frame);
      }
      releaseCapture(state.drag.captureNode, state.drag.pointerId);
      state.drag = null;
    }
    if (state.resize) {
      if (state.resize.frame) {
        window.cancelAnimationFrame(state.resize.frame);
      }
      releaseCapture(state.resize.captureNode, state.resize.pointerId);
      state.resize = null;
    }
    body.classList.remove('is-dragging');
    body.classList.remove('is-resizing');
  }

  /* ---------------- Mock 模式 ---------------- */

  function installMockBackdrop() {
    if (document.getElementById('mockBg')) {
      return;
    }
    var backdrop = document.createElement('div');
    backdrop.id = 'mockBg';
    backdrop.setAttribute('aria-hidden', 'true');
    var close = make('button', 'mock-close', '× 预览底图');
    close.type = 'button';
    close.title = '关闭预览背景（Esc）';
    close.setAttribute('aria-label', '关闭预览背景');
    close.addEventListener('click', function (event) {
      event.stopPropagation();
      hideMockBackdrop();
    });
    backdrop.appendChild(close);
    document.body.insertBefore(backdrop, stage);
  }

  function hideMockBackdrop() {
    var backdrop = document.getElementById('mockBg');
    if (backdrop && backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
  }

  function showMockBackdrop() {
    if (state.mode === 'mock') {
      installMockBackdrop();
    }
  }

  function emitMock(template) {
    if (state.mode !== 'mock') {
      return;
    }
    state.mock.seq += 1;
    ingestBatch([Object.assign({}, template, {
      seq: state.mock.seq,
      uid: template.uid,
      ts: Math.floor(Date.now() / 1000),
      meta: Object.assign({}, template.meta || {})
    })]);
  }

  function clearMockSeedTimers() {
    state.mock.seedTimers.forEach(function (timer) {
      clearTimeout(timer);
    });
    state.mock.seedTimers = [];
  }

  function scheduleMockTick(delay) {
    clearTimeout(state.mock.tickTimer);
    state.mock.tickTimer = 0;
    if (state.mode !== 'mock' || state.mock.paused) {
      return;
    }
    state.mock.tickTimer = window.setTimeout(function () {
      state.mock.tickTimer = 0;
      if (state.mode !== 'mock' || state.mock.paused) {
        return;
      }
      var template = MOCK_ITEMS[state.mock.next % MOCK_ITEMS.length];
      state.mock.next += 1;
      emitMock(template);
      scheduleMockTick(2700);
    }, delay);
  }

  function seedMock(options) {
    options = options || {};
    clearMockSeedTimers();
    clearTimeout(state.mock.tickTimer);
    state.mock.tickTimer = 0;
    clearAll(true);
    state.mock.seq = 0;
    state.mock.next = MOCK_ITEMS.length;
    var items = MOCK_ITEMS.slice(0, 6);
    if (options.immediate) {
      items.forEach(function (template) {
        emitMock(template);
      });
    } else {
      items.forEach(function (template, index) {
        var timer = window.setTimeout(function () {
          emitMock(template);
        }, index * 120);
        state.mock.seedTimers.push(timer);
      });
    }
  }

  function startMock() {
    if (state.mode === 'real' || state.mode === 'mock') {
      return;
    }
    state.mode = 'mock';
    state.bootSettled = true;
    clearTimeout(state.bootTimer);
    state.bootTimer = 0;
    installMockBackdrop();
    applyConfig(MOCK_CONFIG, { force: true });
    state.mock.paused = false;
    seedMock();
    scheduleMockTick(2100);
    exposeMockDebug();
  }

  function stopMock() {
    clearMockSeedTimers();
    clearTimeout(state.mock.tickTimer);
    state.mock.tickTimer = 0;
    hideMockBackdrop();
    clearAll(true);
    state.raw = null;
    state.effective = null;
    state.explicit = new Set();
    state.signature = '';
    state.cursor = 0;
    state.configOk = false;
    state.mode = 'boot';
    window.__overlayPreview = undefined;
  }

  function mergeConfigPatch(patch) {
    var next = Object.assign({}, state.raw || BASE_CONFIG, patch || {});
    var typePatch = patch && isObject(patch.types) ? patch.types : null;
    next.types = Object.assign(
      {},
      (state.raw && state.raw.types) || BASE_CONFIG.types,
      typePatch || {}
    );
    return next;
  }

  function exposeMockDebug() {
    window.__overlayPreview = {
      setConfig: function (patch) {
        if (state.mode !== 'mock') {
          return false;
        }
        return applyConfig(mergeConfigPatch(patch), { force: true });
      },
      setTheme: function (theme) {
        return this.setConfig({ theme: theme });
      },
      seedDemo: function () {
        if (state.mode !== 'mock') {
          return;
        }
        seedMock({ immediate: true });
      },
      emit: function (item) {
        if (state.mode !== 'mock' || !isObject(item)) {
          return;
        }
        state.mock.seq += 1;
        ingestBatch([Object.assign({}, item, {
          seq: item.seq === undefined ? state.mock.seq : item.seq,
          meta: Object.assign({}, item.meta || {})
        })]);
      },
      clear: function () {
        if (state.mode === 'mock') {
          clearAll(true);
        }
      },
      setPaused: function (paused) {
        if (state.mode !== 'mock') {
          return;
        }
        state.mock.paused = !!paused;
        if (state.mock.paused) {
          clearTimeout(state.mock.tickTimer);
          state.mock.tickTimer = 0;
        } else {
          scheduleMockTick(1000);
        }
      },
      hideBackdrop: hideMockBackdrop,
      showBackdrop: showMockBackdrop,
      getConfig: function () {
        return state.raw ? JSON.parse(JSON.stringify(state.raw)) : null;
      },
      getEffectiveConfig: function () {
        return state.effective ? JSON.parse(JSON.stringify(state.effective)) : null;
      },
      getState: function () {
        return {
          mode: state.mode,
          active: state.active.length,
          pending: state.pending.length,
          paused: state.mock.paused
        };
      }
    };
  }

  /* ---------------- 启动与事件 ---------------- */

  function bindInteractions() {
    dragBar.addEventListener('pointerdown', beginDrag);
    resizeHandle.addEventListener('pointerdown', beginResize);
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', cancelInteractions);
    document.addEventListener('dragstart', function (event) {
      event.preventDefault();
    });
  }

  function bindGlobalEvents() {
    window.addEventListener('pywebviewready', function () {
      if (bridgeApi()) {
        startRealBridge();
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.mode === 'mock') {
        hideMockBackdrop();
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (state.mode === 'real' && !document.hidden) {
        if (!state.configTimer) {
          refreshConfig().finally(function () {
            if (state.mode === 'real' && !state.configTimer) {
              scheduleConfigPoll(CONFIG_POLL_MS);
            }
          });
        }
        if (state.itemLoopStarted && !state.itemTimer) {
          scheduleItemPoll(20);
        }
      }
    });
    window.addEventListener('beforeunload', function () {
      clearTimeout(state.configTimer);
      clearTimeout(state.itemTimer);
      clearTimeout(state.bootTimer);
      clearTimeout(state.mock.tickTimer);
      clearMockSeedTimers();
      cancelInteractions();
    });
  }

  function bootBridgeOrMock() {
    if (bridgeApi()) {
      startRealBridge();
      return;
    }

    window.addEventListener('pywebviewready', function () {
      if (bridgeApi()) {
        startRealBridge();
      }
    });

    state.bootTimer = window.setTimeout(function () {
      state.bootTimer = 0;
      if (state.bootSettled) {
        return;
      }
      if (bridgeApi()) {
        startRealBridge();
        return;
      }
      if (!window.pywebview) {
        startMock();
        return;
      }

      var attempts = 0;
      var waitForApi = function () {
        attempts += 1;
        if (bridgeApi()) {
          startRealBridge();
          return;
        }
        if (state.mode === 'boot' && attempts < 45) {
          state.bootTimer = window.setTimeout(waitForApi, 100);
        }
      };
      waitForApi();
    }, 600);
  }

  bindInteractions();
  bindGlobalEvents();
  bootBridgeOrMock();
}());
