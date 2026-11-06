/*
 * 弹幕朗读器 v2 · 独立监看窗口
 * 数据契约：docs/design/ipc-v2.md
 * 字号/行高/未读语义：docs/design/DECISION-v2.md
 */
(function () {
  "use strict";

  const TYPE_ORDER = ["danmaku", "gift", "super_chat", "guard", "enter", "like", "social"];
  const TYPE_META = Object.freeze({
    danmaku: Object.freeze({
      label: "弹幕",
      short: "弹",
      code: "DANMAKU",
      color: "#6DD2FA",
      bg: "rgba(109, 210, 250, .085)",
      border: "rgba(109, 210, 250, .27)",
    }),
    gift: Object.freeze({
      label: "礼物",
      short: "礼",
      code: "GIFT",
      color: "#F5CA70",
      bg: "rgba(245, 202, 112, .085)",
      border: "rgba(245, 202, 112, .27)",
    }),
    super_chat: Object.freeze({
      label: "SC",
      short: "S",
      code: "SUPER CHAT",
      color: "#FF93A8",
      bg: "rgba(255, 147, 168, .09)",
      border: "rgba(255, 147, 168, .28)",
    }),
    guard: Object.freeze({
      label: "舰长",
      short: "舰",
      code: "GUARD",
      color: "#B8A7FF",
      bg: "rgba(184, 167, 255, .09)",
      border: "rgba(184, 167, 255, .28)",
    }),
    enter: Object.freeze({
      label: "入场",
      short: "入",
      code: "ENTER",
      color: "#72DFB7",
      bg: "rgba(114, 223, 183, .085)",
      border: "rgba(114, 223, 183, .26)",
    }),
    like: Object.freeze({
      label: "点赞",
      short: "赞",
      code: "LIKE",
      color: "#FF9DB8",
      bg: "rgba(255, 157, 184, .085)",
      border: "rgba(255, 157, 184, .26)",
    }),
    social: Object.freeze({
      label: "关注",
      short: "关",
      code: "SOCIAL",
      color: "#7DDCFF",
      bg: "rgba(125, 220, 255, .085)",
      border: "rgba(125, 220, 255, .26)",
    }),
  });

  const INTERFACE_SIZES = Object.freeze([
    Object.freeze({
      key: "small",
      label: "小",
      longLabel: "小号界面",
      fontPx: 20,
      lineHeightPx: 44,
      layoutLabel: "紧凑列表",
    }),
    Object.freeze({
      key: "medium",
      label: "中",
      longLabel: "中号界面",
      fontPx: 30,
      lineHeightPx: 64,
      layoutLabel: "标准列表",
    }),
    Object.freeze({
      key: "large",
      label: "大",
      longLabel: "大号界面",
      fontPx: 40,
      lineHeightPx: 84,
      layoutLabel: "宽松列表",
    }),
    Object.freeze({
      key: "xlarge",
      label: "超大",
      longLabel: "超大界面",
      fontPx: 50,
      lineHeightPx: 120,
      layoutLabel: "影院列表",
    }),
  ]);
  const SIZE_BY_KEY = Object.freeze(
    INTERFACE_SIZES.reduce(function (out, size) {
      out[size.key] = size;
      return out;
    }, {})
  );
  const SIZE_BY_PX = Object.freeze({
    13: SIZE_BY_KEY.small,
    15: SIZE_BY_KEY.small,
    17: SIZE_BY_KEY.small,
    19: SIZE_BY_KEY.medium,
    20: SIZE_BY_KEY.small,
    25: SIZE_BY_KEY.medium,
    30: SIZE_BY_KEY.medium,
    40: SIZE_BY_KEY.large,
    50: SIZE_BY_KEY.xlarge,
  });

  const COLUMN_ORDER = ["time", "type", "user", "content", "value", "status"];
  const COLUMN_LABELS = Object.freeze({
    time: "时间",
    type: "类型",
    user: "用户",
    content: "内容",
    value: "价值 / 身份",
    status: "朗读状态",
  });
  const COLUMN_WIDTH_SMALL = Object.freeze({
    time: 90,
    type: 86,
    user: 160,
    value: 105,
    status: 115,
  });
  const COLUMN_WIDTH_MEDIUM = Object.freeze({
    time: 160,
    type: 110,
    user: 200,
    value: 140,
    status: 145,
  });
  const COLUMN_WIDTH_LARGE = Object.freeze({
    time: 210,
    type: 130,
    user: 240,
    value: 170,
    status: 180,
  });
  const COLUMN_WIDTH_XLARGE = Object.freeze({
    time: 300,
    type: 150,
    user: 320,
    value: 210,
    status: 220,
  });
  const COLUMN_WIDTH_TWO_MEDIUM = Object.freeze({ time: 160, type: 95, status: 130 });
  const COLUMN_WIDTH_TWO_LARGE = Object.freeze({ time: 210, type: 115, status: 160 });
  const COLUMN_WIDTH_TWO_XLARGE = Object.freeze({ time: 300, type: 140, status: 195 });

  const STORAGE = Object.freeze({
    columns: "danmaku-monitor-v2-columns",
    overview: "danmaku-monitor-v2-overview",
  });

  const numberFormatter = new Intl.NumberFormat("zh-CN");
  const state = {
    api: null,
    apiMode: "pending",
    loading: false,
    ready: false,
    initialLoaded: false,
    items: [],
    renderedItems: [],
    latestSeq: 0,
    snapshotSeq: 0,
    snapshotSignature: "",
    lastReadSeq: 0,
    frozen: false,
    frozenAtSeq: 0,
    pendingSnapshot: null,
    selectedSeq: null,
    inspectorOpen: false,
    focusOpen: false,
    filterType: "all",
    query: "",
    unreadOnly: false,
    columns: COLUMN_ORDER.slice(),
    storedColumns: false,
    uiSize: "medium",
    fontPx: 30,
    twoLine: false,
    twoLineReason: "",
    modeReason: "",
    truncationRate: 0,
    truncationHighStreak: 0,
    truncationLowStreak: 0,
    layoutSignature: "",
    connection: "connecting",
    platform: "bilibili",
    roomTitle: "",
    stats: { received: 0, spoken: 0, dropped: 0 },
    nowPlaying: null,
    queueLen: 0,
    lastError: "",
    overviewOpen: false,
    hasSnapshotError: false,
    lastReadSource: "initial",
    lastAutoReadAt: 0,
  };

  const el = {};
  const timers = {
    snapshot: 0,
    serverState: 0,
    autoRead: 0,
    toast: 0,
    search: 0,
    geometry: 0,
    mode: 0,
    fontWheel: 0,
  };
  let bootFallbackTimer = 0;
  let pollGeneration = 0;
  let lastFontWheelAt = 0;
  let suppressScrollUntil = 0;
  let scrollIntentUntil = 0;
  let mockRuntime = null;

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      "monitor", "roomLine", "liveDot", "liveLabel", "roomName",
      "topReceived", "topSpoken", "topQueue", "mockBadge",
      "unreadPill", "unreadCount", "pausePill", "pauseText",
      "connectionState", "connectionText",
      "freezeBtn", "freezeLabel", "typeFilters", "filterSelectWrap", "filterSelect", "monitorSearch",
      "columnsBtn", "interfaceSizeControl", "unreadOnlyBtn",
      "inspectorToggle", "focusToggle", "latestBtn",
      "overviewToggle", "overview", "overviewNow", "overviewQueue",
      "overviewReceived", "overviewSpoken", "overviewDropped",
      "tableHead", "tableScroll", "messageRows", "scrollSpacer", "emptyState", "clearFiltersBtn",
      "inspector", "inspectorEmpty", "detailCard",
      "detailBadge", "detailTypeName", "detailAvatar", "detailUser", "detailUid",
      "detailPrice", "detailQuote", "metaSeq", "metaTime", "metaTts", "metaReadState",
      "copyDetailBtn", "markReadDetailBtn", "locateBtn", "ttsCard", "ttsState",
      "ttsEngine", "ttsDuration", "ttsSource",
      "statusDot", "followState", "sizeStatus", "visibleStatus",
      "modeStatus", "markReadBtn", "columnsMenu", "columnsList",
      "focusPanel", "focusList", "toast", "toastText",
    ].forEach(function (id) {
      el[id] = $(id);
    });
    el.sizeButtons = Array.prototype.slice.call(
      document.querySelectorAll("[data-interface-size]")
    );
    el.freezeIconUse = el.freezeBtn ? el.freezeBtn.querySelector("use") : null;
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function asInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  }

  function asText(value) {
    return value == null ? "" : String(value);
  }

  function escapeHTML(value) {
    return asText(value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char];
    });
  }

  function formatNumber(value) {
    const number = Number(value);
    return numberFormatter.format(Number.isFinite(number) ? number : 0);
  }

  function toEpoch(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? value / 1000 : value;
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric > 1e12 ? numeric / 1000 : numeric;
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed / 1000;
    }
    return Date.now() / 1000;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatClock(epoch, includeMillis) {
    const date = new Date(Number(epoch) * 1000);
    const base = pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
    if (!includeMillis) return base;
    return base + "." + String(date.getMilliseconds()).padStart(3, "0");
  }

  function formatFullTime(epoch) {
    const date = new Date(Number(epoch) * 1000);
    return (
      date.getFullYear() +
      "-" + pad2(date.getMonth() + 1) +
      "-" + pad2(date.getDate()) +
      " " + formatClock(epoch, false)
    );
  }

  function firstFinite() {
    for (let i = 0; i < arguments.length; i += 1) {
      const number = Number(arguments[i]);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function sizeForKey(key) {
    return SIZE_BY_KEY[key] || SIZE_BY_KEY.medium;
  }

  function sizeForPx(px) {
    return SIZE_BY_PX[Number(px)] || SIZE_BY_KEY.medium;
  }

  function sizeFromConfig(monitor) {
    const key = monitor && monitor.ui_size;
    return SIZE_BY_KEY[key] || sizeForPx(asInt(monitor && monitor.font_px, NaN));
  }

  function normalizeType(type) {
    return TYPE_ORDER.indexOf(type) >= 0 ? type : "danmaku";
  }

  function normalizeUser(raw) {
    const source = raw && raw.user;
    if (source && typeof source === "object") {
      return {
        name: asText(source.name || source.uname || source.username || "未知用户") || "未知用户",
        uid: asText(source.uid || raw.uid || ""),
      };
    }
    return {
      name: asText(source || (raw && raw.uname) || "未知用户") || "未知用户",
      uid: asText((raw && raw.uid) || ""),
    };
  }

  function ttsStateOf(raw, spoken, meta) {
    const tts = raw && raw.tts && typeof raw.tts === "object" ? raw.tts : {};
    const rawState = asText(tts.state).toLowerCase();
    if (rawState === "queued") return { key: "queued", label: "排队中", tone: "warn" };
    if (rawState === "speaking") return { key: "speaking", label: "朗读中", tone: "live" };
    if (rawState === "done") return { key: "done", label: "已朗读", tone: "ok" };
    if (rawState === "failed") return { key: "failed", label: "失败", tone: "err" };
    if (rawState === "skipped") return { key: "skipped", label: "已跳过", tone: "muted" };

    if (spoken === true) return { key: "done", label: "已朗读", tone: "ok" };
    if (spoken === null || spoken === undefined) return { key: "queued", label: "待朗读", tone: "warn" };

    const reason = asText(meta && meta.filter).toLowerCase();
    if (reason === "synth_failed" || reason === "play_failed" || reason.indexOf("failed") >= 0) {
      return { key: "failed", label: "失败", tone: "err" };
    }
    if (reason === "mock_display_only") return { key: "skipped", label: "仅上屏", tone: "muted" };
    if (reason === "tts_disabled") return { key: "skipped", label: "朗读已关闭", tone: "muted" };
    if (reason) return { key: "skipped", label: "已跳过", tone: "muted" };
    return { key: "not_read", label: "未朗读", tone: "muted" };
  }

  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return "—";
    if (value < 1000) return Math.round(value) + "ms";
    return (value / 1000).toFixed(value >= 10000 ? 1 : 2) + "s";
  }

  function guardName(level, explicit) {
    if (explicit) return asText(explicit);
    const value = asInt(level, 0);
    if (value === 1) return "总督";
    if (value === 2) return "提督";
    if (value === 3) return "舰长";
    return value > 0 ? "舰长 Lv." + value : "舰长";
  }

  function normalizeItem(raw, index) {
    const source = raw && typeof raw === "object" ? raw : {};
    const type = normalizeType(source.type);
    const meta = source.meta && typeof source.meta === "object" ? source.meta : {};
    const user = normalizeUser(source);
    const seq = asInt(source.seq, index + 1);
    const ts = toEpoch(source.ts == null ? source.received_at : source.ts);
    const tts = source.tts && typeof source.tts === "object" ? source.tts : {};
    const spoken =
      typeof source.spoken === "boolean"
        ? source.spoken
        : source.spoken === null
          ? null
          : tts.state === "done"
            ? true
            : null;
    const speech = ttsStateOf(source, spoken, meta);

    let text = source.text == null ? source.content : source.text;
    if (text == null) text = meta.message;
    if (text == null && type === "gift") text = "送出 " + asText(meta.gift_name || "礼物") + (asInt(meta.num, 1) > 1 ? " ×" + asInt(meta.num, 1) : "");
    if (text == null && type === "super_chat") text = asText(meta.message || "醒目留言");
    if (text == null && type === "guard") text = "开通 " + guardName(meta.guard_level, meta.guard_name);
    if (text == null && type === "enter") text = "进入直播间";
    if (text == null && type === "like") text = "点赞了直播间";
    if (text == null && type === "social") text = asText(meta.social_action || "关注了直播间");
    if (type === "enter") text = asText(text).replace(/^进入了?直播间$/, "进入直播间");
    text = asText(text == null ? "" : text);

    const amount = firstFinite(
      meta.price,
      meta.total_coin,
      meta.amount,
      source.value && source.value.amount,
      source.value && source.value.price
    );
    const diamonds = firstFinite(meta.diamond_count, source.value && source.value.diamond_count);
    const giftCount = firstFinite(meta.num, meta.count, source.value && source.value.count);
    const guardLevel = firstFinite(source.guard_level, meta.guard_level);
    let valueLabel = "—";
    const diamondGift = type === "gift" && String(meta.coin_type || "").toLowerCase() === "diamond";
    if (type === "super_chat" && amount != null) {
      valueLabel = "¥" + (amount % 1 === 0 ? String(amount) : amount.toFixed(2));
    } else if (type === "gift") {
      if (diamondGift && diamonds != null && diamonds > 0) {
        valueLabel = diamonds + "钻石";
      } else if (!diamondGift && amount != null && amount > 0) {
        valueLabel = "¥" + (amount % 1 === 0 ? String(amount) : amount.toFixed(2));
      } else if (diamonds != null && diamonds > 0) {
        valueLabel = diamonds + "钻石";
      } else if (giftCount != null && giftCount > 1) {
        valueLabel = "×" + giftCount;
      }
    } else if (type === "guard") {
      valueLabel = guardName(guardLevel, meta.guard_name);
    } else if (type === "enter" && meta.medal_level != null) {
      valueLabel = "LV." + asText(meta.medal_level);
    }

    const contentLength = firstFinite(source.content_length, text.length);
    return {
      seq: seq,
      type: type,
      typeMeta: TYPE_META[type],
      user: user.name,
      uid: user.uid,
      text: text,
      contentLength: contentLength == null ? text.length : contentLength,
      contentTruncated: Boolean(source.content_truncated),
      ts: ts,
      spoken: spoken,
      speech: speech,
      meta: meta,
      tts: tts,
      amount: amount,
      giftCount: giftCount,
      valueLabel: valueLabel,
      source: asText(source.source || (meta.mock ? "mock" : "bilibili")),
      messageId: asText(source.message_id || source.id || ""),
    };
  }

  function normalizeItems(items) {
    if (!Array.isArray(items)) return [];
    const normalized = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = normalizeItem(items[i], i);
      if (!Number.isFinite(item.seq)) continue;
      normalized.push(item);
    }
    normalized.sort(function (a, b) {
      return a.seq - b.seq;
    });
    return normalized;
  }

  function itemSignature(items) {
    let hash = 2166136261;
    function add(value) {
      const text = asText(value);
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 31;
      hash = Math.imul(hash, 16777619);
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      add(item.seq);
      add(item.type);
      add(item.user);
      add(item.text);
      add(item.spoken);
      add(item.tts.state);
      add(item.tts.finished_at);
      add(item.meta.filter);
    }
    return items.length + ":" + String(hash >>> 0);
  }

  function isUnread(item) {
    return Boolean(item && item.seq > state.lastReadSeq);
  }

  function unreadCount() {
    let count = 0;
    for (let i = 0; i < state.items.length; i += 1) {
      if (state.items[i].seq > state.lastReadSeq) count += 1;
    }
    return count;
  }

  function hasActiveFilter() {
    return state.filterType !== "all" || Boolean(state.query) || state.unreadOnly;
  }

  function backlogCount() {
    if (!state.frozen) return 0;
    return Math.max(0, state.latestSeq - state.frozenAtSeq);
  }

  function validColumns(candidate) {
    if (!Array.isArray(candidate)) return null;
    const seen = {};
    const output = [];
    candidate.forEach(function (column) {
      if (COLUMN_ORDER.indexOf(column) >= 0 && !seen[column]) {
        seen[column] = true;
        output.push(column);
      }
    });
    if (output.indexOf("content") < 0) output.push("content");
    output.sort(function (a, b) {
      return COLUMN_ORDER.indexOf(a) - COLUMN_ORDER.indexOf(b);
    });
    return output;
  }

  function loadStoredColumns() {
    try {
      const raw = window.localStorage.getItem(STORAGE.columns);
      if (!raw) return null;
      const columns = validColumns(JSON.parse(raw));
      state.storedColumns = Boolean(columns && columns.length);
      return columns;
    } catch (_) {
      return null;
    }
  }

  function persistColumns() {
    try {
      window.localStorage.setItem(STORAGE.columns, JSON.stringify(state.columns));
    } catch (_) {
      // 运行时窗口 profile 不可用时只保留当前会话。
    }
  }

  function loadOverviewPreference() {
    try {
      return window.localStorage.getItem(STORAGE.overview) === "1";
    } catch (_) {
      return false;
    }
  }

  function persistOverview() {
    try {
      window.localStorage.setItem(STORAGE.overview, state.overviewOpen ? "1" : "0");
    } catch (_) {
      // ignore
    }
  }

  function applyInterfaceVars() {
    const size = sizeForPx(state.fontPx);
    state.uiSize = size.key;
    state.fontPx = size.fontPx;
    document.documentElement.dataset.uiSize = size.key;
    document.documentElement.style.setProperty("--reader-size", size.fontPx + "px");
    document.documentElement.style.setProperty("--row-h", size.lineHeightPx + "px");
    updateSizeButtons();
  }

  function updateSizeButtons() {
    el.sizeButtons.forEach(function (button) {
      const active = button.dataset.interfaceSize === state.uiSize;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (el.interfaceSizeControl) {
      el.interfaceSizeControl.setAttribute(
        "aria-label",
        "界面大小：" + sizeForKey(state.uiSize).longLabel
      );
    }
  }

  function selectedItem() {
    if (state.selectedSeq == null) return null;
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      if (state.items[i].seq === state.selectedSeq) return state.items[i];
    }
    return null;
  }

  function latestReadItem() {
    const items = state.items;
    if (!items.length) return null;
    const now = state.nowPlaying;
    if (now && typeof now === "object") {
      const id = asText(now.id || now.message_id);
      if (id) {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (items[i].messageId === id || String(items[i].seq) === id) return items[i];
        }
      }
      const user = asText(now.user || now.username || now.uid || "");
      const text = asText(now.text || now.title || now.message || now.name || "");
      if (user || text) {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const item = items[i];
          if ((!user || item.user === user) && (!text || item.text === text)) return item;
        }
      }
    }
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].speech && items[i].speech.key === "speaking") return items[i];
    }
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].spoken === true || (items[i].speech && items[i].speech.key === "done")) return items[i];
    }
    return items[items.length - 1];
  }

  function detailItem() {
    return selectedItem() || latestReadItem();
  }

  function visibleItems() {
    const query = state.query.toLowerCase();
    return state.items.filter(function (item) {
      if (state.filterType !== "all" && item.type !== state.filterType) return false;
      if (state.unreadOnly && item.seq <= state.lastReadSeq) return false;
      if (!query) return true;
      const haystack = [
        item.user,
        item.uid,
        item.text,
        item.meta && item.meta.message,
        item.meta && item.meta.gift_name,
        item.meta && item.meta.guard_name,
      ].join(" ").toLowerCase();
      return haystack.indexOf(query) >= 0;
    });
  }

  function buildFilters() {
    if (!el.typeFilters) return;
    const order = platformTypeOrder();
    const chips = [{ key: "all", label: "全部", color: "" }].concat(
      order.map(function (type) {
        return { key: type, label: TYPE_META[type].label, color: TYPE_META[type].color };
      })
    );
    el.typeFilters.innerHTML = chips
      .map(function (chip) {
        return (
          '<button class="filter-chip' + (chip.key === state.filterType ? " is-active" : "") +
          '" type="button" data-filter="' + chip.key +
          '" aria-pressed="' + String(chip.key === state.filterType) +
          '"' + (chip.color ? ' style="--type-color:' + chip.color + '"' : "") + ">" +
          (chip.color ? '<span class="dot" aria-hidden="true"></span>' : "") +
          "<span>" + escapeHTML(chip.label) + "</span>" +
          '<b data-count-for="' + chip.key + '">0</b>' +
          "</button>"
        );
      })
      .join("");
    if (el.filterSelect) {
      el.filterSelect.innerHTML = chips.map(function (chip) {
        return '<option value="' + chip.key + '">' + escapeHTML(chip.label) + "</option>";
      }).join("");
      el.filterSelect.value = state.filterType;
    }
  }

  function platformTypeOrder() {
    return state.platform === "douyin"
      ? ["danmaku", "gift", "enter", "like", "social"]
      : ["danmaku", "gift", "super_chat", "guard", "enter"];
  }

  function updateFilterCounts() {
    if (!el.typeFilters) return;
    const counts = {
      all: state.items.length, danmaku: 0, gift: 0, super_chat: 0,
      guard: 0, enter: 0, like: 0, social: 0,
    };
    state.items.forEach(function (item) {
      counts[item.type] += 1;
    });
    Object.keys(counts).forEach(function (key) {
      const node = el.typeFilters.querySelector('[data-count-for="' + key + '"]');
      if (node) node.textContent = formatNumber(counts[key]);
      const option = el.filterSelect
        ? el.filterSelect.querySelector('option[value="' + key + '"]')
        : null;
      if (option) {
        const label = key === "all" ? "全部" : TYPE_META[key].label;
        option.textContent = label + " (" + formatNumber(counts[key]) + ")";
      }
    });
  }

  function updateFilterSelection() {
    if (!el.typeFilters) return;
    Array.prototype.forEach.call(el.typeFilters.querySelectorAll("[data-filter]"), function (chip) {
      const active = chip.dataset.filter === state.filterType;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", String(active));
    });
    if (el.filterSelect) el.filterSelect.value = state.filterType;
  }

  function singleColumnsForWidth(width, compact) {
    const selected = {};
    state.columns.forEach(function (column) {
      selected[column] = true;
    });
    const output = [];
    if (compact) {
      if (selected.type) output.push("type");
      if (selected.user && width >= 900) output.push("user");
      output.push("content");
      if (selected.status) output.push("status");
      return output;
    }
    COLUMN_ORDER.forEach(function (column) {
      if (column === "content") {
        output.push(column);
        return;
      }
      if (!selected[column]) return;
      if (column === "status" && width < 1280) return;
      if (column === "value" && width < 840) return;
      if (column === "time" && width < 840) return;
      if (column === "user" && width < 840) return;
      output.push(column);
    });
    return output;
  }

  function twoLineMetaForWidth(width) {
    const selected = {};
    state.columns.forEach(function (column) {
      selected[column] = true;
    });
    const output = [];
    if (width >= 1000 && selected.time) output.push("time");
    if (selected.type) output.push("type");
    if (selected.user) output.push("user");
    if (width >= 1280 && selected.status) output.push("status");
    if (!output.length) output.push("type");
    return output;
  }

  function makeGridTemplate(columns, twoLine) {
    let flexUsed = false;
    return columns
      .map(function (column, index) {
        if (column === "content") {
          flexUsed = true;
          return "minmax(0, 1fr)";
        }
        if (twoLine && column === "user") {
          flexUsed = true;
          return "minmax(0, 1fr)";
        }
        if (
          twoLine &&
          !flexUsed &&
          index === columns.length - 1 &&
          column !== "status" &&
          columns.indexOf("user") < 0
        ) {
          flexUsed = true;
          return "minmax(0, 1fr)";
        }
        const widths = twoLine
          ? state.uiSize === "xlarge"
            ? COLUMN_WIDTH_TWO_XLARGE
            : state.uiSize === "large"
              ? COLUMN_WIDTH_TWO_LARGE
              : COLUMN_WIDTH_TWO_MEDIUM
          : state.uiSize === "xlarge"
            ? COLUMN_WIDTH_XLARGE
            : state.uiSize === "large"
              ? COLUMN_WIDTH_LARGE
              : state.uiSize === "medium"
                ? COLUMN_WIDTH_MEDIUM
                : COLUMN_WIDTH_SMALL;
        return (widths[column] || (twoLine && column === "type" && window.innerWidth < 840 ? 40 : 72)) + "px";
      })
      .join(" ");
  }

  function currentLayout() {
    const width = window.innerWidth;
    const compact = state.uiSize === "small";
    const spacious = state.uiSize === "large";
    const extraSpacious = state.uiSize === "xlarge";
    const useTwoLine = compact
      ? false
      : extraSpacious
        ? width < 1500
        : spacious
          ? width < 900
          : state.twoLine;
    if (useTwoLine) {
      const meta = twoLineMetaForWidth(width);
      return {
        twoLine: true,
        meta: meta,
        columns: ["content"],
        template: makeGridTemplate(meta, true),
        contentTemplate: "minmax(0, 1fr)",
        compactType: width < 840,
        mergeUser: false,
      };
    }
    const columns = singleColumnsForWidth(width, compact);
    return {
      twoLine: false,
      meta: [],
      columns: columns,
      template: makeGridTemplate(columns, false),
      contentTemplate: "",
      compactType: compact,
      mergeUser: false,
    };
  }

  function layoutSignature(layout) {
    return state.uiSize + ":" + (layout.twoLine ? "two:" : "one:") + layout.template + ":" + layout.columns.join(",") + ":" + layout.meta.join(",") + ":" + String(layout.mergeUser);
  }

  function headerCell(key, layout) {
    let label = COLUMN_LABELS[key] || key;
    let classes = "th";
    if (key === "content") classes += " th-content";
    if (key === "user") classes += " th-user";
    if (key === "value" || key === "status") classes += " is-right";
    if (layout.twoLine && key === "user") classes += " two-line-head";
    if (layout.twoLine && !layout.meta.includes("user") && key === layout.meta[layout.meta.length - 1]) {
      label += " · 用户 / 内容";
    }
    let hint = "";
    if (key === "content") hint = '<span class="th-hint">单行省略</span>';
    return (
      '<span class="' + classes + '">' + escapeHTML(label) +
      (key === "content" ? " " + hint : "") +
      "</span>"
    );
  }

  function renderHeader(layout) {
    if (!el.tableHead) return;
    const columns = layout.twoLine ? layout.meta : layout.columns;
    el.tableHead.style.gridTemplateColumns = layout.template;
    el.tableHead.innerHTML = columns.map(function (key) {
      return headerCell(key, layout);
    }).join("");
  }

  function typeBadge(item, compact) {
    const meta = item.typeMeta;
    return (
      '<span class="type-badge' + (compact ? " is-compact" : "") +
      '" style="--type-color:' + meta.color + ";--type-bg:" + meta.bg + ";--type-border:" + meta.border + '">' +
      escapeHTML(compact ? meta.short : meta.label) +
      "</span>"
    );
  }

  function statusMarkup(item) {
    return (
      '<span class="status-cell"><i class="status-dot ' + item.speech.tone + '" aria-hidden="true"></i>' +
      '<span class="status-text">' + escapeHTML(item.speech.label) + "</span></span>"
    );
  }

  function cellMarkup(item, key, layout) {
    if (key === "time") {
      return '<span class="cell time-cell">' + escapeHTML(formatClock(item.ts, false)) + "</span>";
    }
    if (key === "type") {
      return '<span class="cell type-cell">' + typeBadge(item, layout.compactType) + "</span>";
    }
    if (key === "user") {
      return '<span class="cell user-cell" title="' + escapeHTML(item.user) + '">' + escapeHTML(item.user) + "</span>";
    }
    if (key === "content") {
      return (
        '<span class="cell content-cell" title="' + escapeHTML(item.text) + '">' +
        '<span class="content-text">' + escapeHTML(item.text) + "</span></span>"
      );
    }
    if (key === "value") {
      return '<span class="cell value-cell" title="' + escapeHTML(item.valueLabel) + '">' + escapeHTML(item.valueLabel) + "</span>";
    }
    if (key === "status") {
      return statusMarkup(item);
    }
    return "";
  }

  function rowMarkup(item, layout) {
    const classes = [
      "row",
      layout.twoLine ? "two-line" : "",
      isUnread(item) ? "is-unread" : "",
      item.seq === state.selectedSeq ? "is-selected" : "",
    ].filter(Boolean).join(" ");
    const commonAttrs =
      'class="' + classes + '" data-seq="' + item.seq + '" data-type="' + item.type +
      '" role="row" tabindex="-1" aria-selected="' + String(item.seq === state.selectedSeq) + '"';

    if (layout.twoLine) {
      const metaCells = layout.meta.map(function (key) {
        return cellMarkup(item, key, layout);
      }).join("");
      const prefix =
        layout.mergeUser && state.columns.indexOf("user") >= 0
          ? '<span class="prefix" title="' + escapeHTML(item.user) + '">' + escapeHTML(item.user) + "：</span>"
          : "";
      return (
        "<div " + commonAttrs + ' aria-label="' + escapeHTML(item.user + "：" + item.text) + '">' +
        '<div class="row-meta" style="grid-template-columns:' + layout.template + '">' + metaCells + "</div>" +
        '<div class="row-content" title="' + escapeHTML(item.text) + '">' +
        prefix +
        '<span class="body">' + escapeHTML(item.text) + "</span>" +
        "</div></div>"
      );
    }

    return (
      "<div " + commonAttrs + ' style="grid-template-columns:' + layout.template +
      '" aria-label="' + escapeHTML(item.user + "：" + item.text) + '">' +
      layout.columns.map(function (key) {
        return cellMarkup(item, key, layout);
      }).join("") +
      "</div>"
    );
  }

  function renderTable(options) {
    if (!el.messageRows || !el.tableScroll) return;
    const opts = options || {};
    const previousTop = el.tableScroll.scrollTop;
    const previousAtBottom = isAtBottom(4);
    const layout = currentLayout();
    const items = visibleItems();
    state.renderedItems = items;
    state.layoutSignature = layoutSignature(layout);

    renderHeader(layout);
    el.messageRows.innerHTML = items
      .map(function (item) {
        return rowMarkup(item, layout);
      })
      .join("");
    el.emptyState.hidden = items.length > 0;
    el.tableScroll.setAttribute("aria-rowcount", String(items.length));
    el.messageRows.setAttribute("aria-label", items.length + " 条消息");
    syncScrollSpacer();

    let align = opts.align || "";
    if (!align && opts.preserveScroll === false) {
      align = "bottom";
    }
    const maxScroll = Math.max(0, el.tableScroll.scrollHeight - el.tableScroll.clientHeight);
    if (align === "top") {
      el.tableScroll.scrollTop = 0;
    } else if (align === "bottom") {
      el.tableScroll.scrollTop = maxScroll;
    } else if (opts.preserveScroll) {
      el.tableScroll.scrollTop = Math.min(previousTop, maxScroll);
    } else if (previousAtBottom) {
      el.tableScroll.scrollTop = maxScroll;
    } else {
      el.tableScroll.scrollTop = Math.min(previousTop, maxScroll);
    }
    suppressScrollUntil = performance.now() + 180;

    if (state.selectedSeq != null && !selectedItem()) {
      state.selectedSeq = null;
      closeInspector();
    }
    updateInspector();
    updateChrome();
    updateVisibleMetrics();
    if (state.focusOpen) renderFocus();
  }

  function updateVisibleMetrics() {
    if (!el.tableScroll) return;
    const size = sizeForPx(state.fontPx);
    const layout = currentLayout();
    const wasAtBottom = isAtBottom(4);
    syncScrollSpacer();
    if (wasAtBottom) {
      const maxScroll = Math.max(0, el.tableScroll.scrollHeight - el.tableScroll.clientHeight);
      if (Math.abs(el.tableScroll.scrollTop - maxScroll) > 0.5) {
        suppressScrollUntil = performance.now() + 120;
        el.tableScroll.scrollTop = maxScroll;
      }
    }
    const rows = Math.max(0, Math.floor(el.tableScroll.clientHeight / size.lineHeightPx));
    if (el.sizeStatus) el.sizeStatus.textContent = size.longLabel;
    if (el.visibleStatus) el.visibleStatus.textContent = rows + " 行";
    if (el.modeStatus) {
      const modeLabel = layout.twoLine
        ? "双行布局"
        : size.key === "small"
          ? "紧凑单行"
          : size.key === "xlarge"
            ? "影院单行"
          : size.key === "large"
            ? "宽松单行"
            : "标准单行";
      el.modeStatus.textContent = modeLabel;
      el.modeStatus.title = layout.twoLine
        ? "当前界面使用双行消息布局"
        : "当前界面使用单行消息布局";
    }
    updateAudit(rows);
  }

  function syncScrollSpacer() {
    if (!el.scrollSpacer || !el.tableScroll) return;
    const size = sizeForPx(state.fontPx);
    const remainder = el.tableScroll.clientHeight % size.lineHeightPx;
    el.scrollSpacer.style.height = remainder + "px";
  }

  function updateAudit(visibleRows) {
    if (!window.requestAnimationFrame) {
      publishAudit(visibleRows);
      return;
    }
    window.requestAnimationFrame(function () {
      publishAudit(visibleRows);
    });
  }

  function publishAudit(visibleRows) {
    if (!el.tableScroll) return;
    const size = sizeForPx(state.fontPx);
    const layout = currentLayout();
    const unread = unreadCount();
    const highlighted = el.messageRows ? el.messageRows.querySelectorAll(".row.is-unread").length : 0;
    const tableOverflow = el.tableScroll.scrollWidth > el.tableScroll.clientWidth + 1;
    window.__MONITOR_AUDIT__ = {
      version: 2,
      apiMode: state.apiMode,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyFontSize: getComputedStyle(document.body).fontSize,
      contentHeight: el.tableScroll.clientHeight,
      uiSize: state.uiSize,
      fontPx: size.fontPx,
      rowHeight: size.lineHeightPx,
      visibleRows: typeof visibleRows === "number" ? visibleRows : Math.floor(el.tableScroll.clientHeight / size.lineHeightPx),
      mode: layout.twoLine ? "two_line" : "single_line",
      modeReason: state.modeReason,
      twoLine: layout.twoLine,
      truncationRate: state.truncationRate,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      tableHorizontalOverflow: tableOverflow,
      documentScrollWidth: document.documentElement.scrollWidth,
      tableScrollWidth: el.tableScroll.scrollWidth,
      tableClientWidth: el.tableScroll.clientWidth,
      innerWidth: window.innerWidth,
      unreadCount: unread,
      highlightedUnreadCount: highlighted,
      unreadMatchesHighlight: unread === highlighted,
      lastReadSeq: state.lastReadSeq,
      latestSeq: state.latestSeq,
      frozen: state.frozen,
      backlog: backlogCount(),
      frozenText: state.frozen ? "已冻结（后台继续接收） · 冻结期间新增 " + backlogCount() + " 条" : "",
      following: !state.frozen && isAtBottom(4),
      scrollTop: el.tableScroll.scrollTop,
      scrollMax: Math.max(0, el.tableScroll.scrollHeight - el.tableScroll.clientHeight),
      inspectorOpen: state.inspectorOpen,
      selectedSeq: state.selectedSeq,
      rowCount: el.messageRows ? el.messageRows.querySelectorAll(".row").length : 0,
      visibleItemCount: state.renderedItems.length,
      columns: state.columns.slice(),
      viewportMode: window.innerWidth < 1100 ? "width-two-line" : "wide",
      overviewOpen: state.overviewOpen,
      focusOpen: state.focusOpen,
      generatedAt: new Date().toISOString(),
    };
  }

  function isAtBottom(tolerance) {
    if (!el.tableScroll) return true;
    const allow = Number.isFinite(tolerance) ? tolerance : 4;
    return el.tableScroll.scrollHeight - el.tableScroll.scrollTop - el.tableScroll.clientHeight <= allow;
  }

  function setFollowStatus() {
    if (!el.followState) return;
    if (!state.ready) {
      el.followState.textContent = "正在加载监看数据…";
    } else if (state.hasSnapshotError) {
      el.followState.textContent = "监看数据暂不可用，正在重试";
    } else if (state.frozen) {
      el.followState.textContent = "已冻结（后台继续接收） · 冻结期间新增 " + formatNumber(backlogCount()) + " 条";
    } else if (isAtBottom(4)) {
      el.followState.textContent = "已到最新 · 正在跟随";
    } else {
      el.followState.textContent = "浏览历史 · 自动跟随已暂停";
    }
    el.statusDot.classList.toggle("is-frozen", state.frozen);
    el.statusDot.classList.toggle("is-browsing", !state.frozen && !isAtBottom(4));
  }

  function updateConnectionChrome() {
    const connection = asText(state.connection || "connecting").toLowerCase();
    let label = "连接中";
    let live = "连接中";
    let tone = "warn";
    if (connection === "connected" || connection === "live" || connection === "ok") {
      label = "已连接";
      live = "直播中";
      tone = "ok";
    } else if (connection === "disconnected" || connection === "idle") {
      label = "已断开";
      live = "未连接";
      tone = "muted";
    } else if (connection === "error" || connection === "failed") {
      label = "连接失败";
      live = "连接失败";
      tone = "error";
    }
    el.connectionText.textContent = label;
    el.connectionState.classList.toggle("is-connected", tone === "ok");
    el.connectionState.classList.toggle("is-error", tone === "error");
    el.liveLabel.textContent = live;
    el.liveLabel.classList.toggle("is-muted", tone === "muted");
    el.liveLabel.classList.toggle("is-error", tone === "error");
    el.liveDot.classList.toggle("is-live", tone === "ok");
    el.liveDot.classList.toggle("is-warn", tone === "warn");
    el.liveDot.classList.toggle("is-error", tone === "error");
    el.roomName.textContent = state.roomTitle || "尚未连接直播间";
  }

  function nowPlayingText() {
    const value = state.nowPlaying;
    if (!value) return "待机";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      const user = asText(value.user || value.username || value.uid || "");
      const text = asText(value.text || value.title || value.message || value.name || "");
      if (user && text) return user + " · " + text;
      return text || user || "朗读中";
    }
    return asText(value) || "朗读中";
  }

  function updateChrome() {
    const unread = unreadCount();
    if (el.unreadCount) el.unreadCount.textContent = formatNumber(unread);
    if (el.unreadPill) {
      el.unreadPill.classList.toggle("is-zero", unread === 0);
      el.unreadPill.title = unread
        ? "未读 " + unread + " 条"
        : "没有未读消息";
      el.unreadPill.setAttribute("aria-label", "未读 " + unread + " 条");
    }

    const backlog = backlogCount();
    if (el.pausePill) el.pausePill.classList.toggle("is-frozen", state.frozen);
    if (el.pauseText) {
      el.pauseText.textContent = state.frozen
        ? "已冻结（后台继续接收） · 冻结期间新增 " + formatNumber(backlog) + " 条"
        : isAtBottom(4)
          ? "正在跟随最新"
          : "浏览历史中";
    }
    if (el.pausePill) {
      el.pausePill.title = state.frozen
        ? "已冻结（后台继续接收） · 冻结期间新增 " + formatNumber(backlog) + " 条"
        : "列表随新消息自动跟随";
    }

    if (el.freezeLabel) el.freezeLabel.textContent = state.frozen ? "继续" : "冻结";
    if (el.freezeIconUse) el.freezeIconUse.setAttribute("href", state.frozen ? "#i-play" : "#i-pause");
    if (el.freezeBtn) {
      el.freezeBtn.classList.toggle("is-frozen", state.frozen);
      el.freezeBtn.setAttribute("aria-pressed", String(state.frozen));
      el.freezeBtn.title = state.frozen
        ? "继续并回到最新；冻结期间已新增 " + backlog + " 条"
        : "冻结列表；后台继续接收";
    }

    setFollowStatus();
    updateConnectionChrome();

    if (el.topReceived) el.topReceived.textContent = formatNumber(state.stats.received);
    if (el.topSpoken) el.topSpoken.textContent = formatNumber(state.stats.spoken);
    if (el.topQueue) el.topQueue.textContent = formatNumber(state.queueLen);
    if (el.overviewNow) el.overviewNow.textContent = nowPlayingText();
    if (el.overviewQueue) el.overviewQueue.textContent = formatNumber(state.queueLen);
    if (el.overviewReceived) el.overviewReceived.textContent = formatNumber(state.stats.received);
    if (el.overviewSpoken) el.overviewSpoken.textContent = formatNumber(state.stats.spoken);
    if (el.overviewDropped) el.overviewDropped.textContent = formatNumber(state.stats.dropped);

    if (el.mockBadge) {
      el.mockBadge.hidden = state.apiMode !== "mock";
      el.mockBadge.title = "Mock 预览：无 pywebview 时使用 80 条示例数据";
    }
    if (el.unreadOnlyBtn) {
      el.unreadOnlyBtn.classList.toggle("is-active", state.unreadOnly);
      el.unreadOnlyBtn.setAttribute("aria-pressed", String(state.unreadOnly));
    }
    if (el.inspectorToggle) {
      el.inspectorToggle.classList.toggle("is-active", state.inspectorOpen);
      el.inspectorToggle.setAttribute("aria-pressed", String(state.inspectorOpen));
    }
    if (el.focusToggle) {
      el.focusToggle.classList.toggle("is-active", state.focusOpen);
      el.focusToggle.setAttribute("aria-pressed", String(state.focusOpen));
    }
    if (el.overviewToggle) el.overviewToggle.setAttribute("aria-expanded", String(state.overviewOpen));
    if (el.overview) el.overview.hidden = !state.overviewOpen;
    updateSizeButtons();
    updateFilterSelection();
    updateFilterCounts();
    updateVisibleMetrics();
  }

  function updateInspector() {
    if (!el.inspector) return;
    const item = detailItem();
    const hasItem = Boolean(item);
    el.inspectorEmpty.hidden = hasItem;
    el.detailCard.hidden = !hasItem;
    el.ttsCard.hidden = !hasItem;
    if (!hasItem) {
      el.detailCard.style.removeProperty("--type-color");
      el.detailCard.style.removeProperty("--type-bg");
      el.detailCard.style.removeProperty("--type-border");
      return;
    }

    const meta = item.typeMeta;
    el.detailCard.style.setProperty("--type-color", meta.color);
    el.detailCard.style.setProperty("--type-bg", meta.bg);
    el.detailCard.style.setProperty("--type-border", meta.border);
    el.detailBadge.textContent = meta.label;
    el.detailTypeName.textContent = meta.code + " · #msg_" + String(item.seq).padStart(4, "0");
    el.detailAvatar.textContent = Array.from(item.user)[0] || "?";
    el.detailUser.textContent = item.user;
    el.detailUid.textContent = "UID " + (item.uid || "—") + " · " + (item.source || "unknown");
    el.detailPrice.textContent = item.valueLabel;
    el.detailQuote.textContent = item.text + (item.contentTruncated ? "\n\n[内容已截断]" : "");
    el.metaSeq.textContent = "seq " + item.seq;
    el.metaTime.textContent = formatFullTime(item.ts);
    el.metaTts.textContent = item.speech.label;
    el.metaReadState.textContent = isUnread(item) ? "未读" : "已读";

    const tts = item.tts || {};
    const stateLabel = item.speech.label + (tts.error ? " · " + asText(tts.error) : "");
    el.ttsState.textContent = stateLabel;
    const engine = asText(tts.engine || (item.meta && (item.meta.tts_engine || item.meta.engine)) || "");
    const voice = asText(tts.voice || (item.meta && (item.meta.tts_voice || item.meta.voice)) || "");
    el.ttsEngine.textContent = engine || voice
      ? [engine ? engine.toUpperCase() : "", voice].filter(Boolean).join(" · ")
      : "未提供";
    el.ttsDuration.textContent = formatDuration(
      tts.duration_ms == null ? item.meta && (item.meta.tts_duration_ms || item.meta.duration_ms) : tts.duration_ms
    );
    const filter = item.meta && item.meta.filter ? String(item.meta.filter) : "";
    el.ttsSource.textContent = item.source + (filter ? " · " + filter : "");
  }

  function setInspectorOpen(open) {
    state.inspectorOpen = Boolean(open);
    if (el.inspector) {
      el.inspector.classList.toggle("is-collapsed", !state.inspectorOpen);
      el.inspector.setAttribute("aria-hidden", String(!state.inspectorOpen));
    }
    updateInspector();
    updateChrome();
  }

  function openInspector() {
    setInspectorOpen(true);
  }

  function closeInspector() {
    setInspectorOpen(false);
  }

  function toggleInspector() {
    setInspectorOpen(!state.inspectorOpen);
  }

  function applySelectionClasses() {
    if (!el.messageRows) return;
    Array.prototype.forEach.call(el.messageRows.querySelectorAll(".row"), function (row) {
      const selected = Number(row.dataset.seq) === state.selectedSeq;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", String(selected));
    });
  }

  function syncReadClasses() {
    if (!el.messageRows) return;
    Array.prototype.forEach.call(el.messageRows.querySelectorAll(".row"), function (row) {
      row.classList.toggle("is-unread", Number(row.dataset.seq) > state.lastReadSeq);
    });
  }

  function updateReadPresentation() {
    syncReadClasses();
    updateInspector();
    updateChrome();
  }

  function selectItem(seq, options) {
    const opts = options || {};
    const numeric = Number(seq);
    const item = state.items.find(function (entry) {
      return entry.seq === numeric;
    });
    if (!item) {
      toast("消息已不在当前快照中", true);
      return;
    }
    state.selectedSeq = numeric;
    if (opts.openInspector !== false) openInspector();
    applySelectionClasses();
    updateInspector();
    if (opts.markRead !== false) {
      markReadTo(numeric, { source: opts.source || "row", silent: true, renderIfUnreadFilter: true });
    }
    updateChrome();
    if (state.focusOpen) renderFocus();
    if (opts.scrollIntoView !== false) scrollRowIntoView(numeric);
  }

  function scrollRowIntoView(seq) {
    if (!el.messageRows) return;
    const row = el.messageRows.querySelector('.row[data-seq="' + Number(seq) + '"]');
    if (!row) return;
    suppressScrollUntil = performance.now() + 180;
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateChrome();
  }

  function clearSelection(options) {
    const opts = options || {};
    state.selectedSeq = null;
    applySelectionClasses();
    if (opts.closeInspector !== false) setInspectorOpen(false);
    updateInspector();
    updateChrome();
  }

  async function markReadTo(seq, options) {
    const opts = options || {};
    const maxSeq = Math.max(
      state.latestSeq,
      state.items.length ? state.items[state.items.length - 1].seq : 0
    );
    const target = clamp(asInt(seq, state.lastReadSeq), 0, Math.max(0, maxSeq));
    if (target <= state.lastReadSeq) {
      updateReadPresentation();
      return state.lastReadSeq;
    }

    state.lastReadSeq = target;
    state.lastReadSource = opts.source || "manual";
    updateReadPresentation();

    let response = null;
    try {
      if (state.api && typeof state.api.mark_read === "function") {
        response = await state.api.mark_read(target);
        if (typeof response === "string") {
          try {
            response = JSON.parse(response);
          } catch (_) {
            response = null;
          }
        }
        const acknowledged = response && firstFinite(response.last_read, response.lastRead);
        if (acknowledged != null) {
          state.lastReadSeq = Math.max(state.lastReadSeq, acknowledged);
        }
        if (response && typeof response === "object" && response.ok === false) {
          state.lastError = "mark_read: " + asText(response.error || "写入失败");
          toast("已读游标写入失败，界面已先本地推进", true);
        }
      }
    } catch (error) {
      state.lastError = "mark_read: " + asText(error && error.message ? error.message : error);
      toast("已读游标写入失败，界面已先本地推进", true);
    }

    updateReadPresentation();
    if (state.unreadOnly && opts.renderIfUnreadFilter !== false) {
      renderTable({ preserveScroll: true });
    }
    if (opts.toast) {
      toast(opts.toast.replace("{seq}", String(target)));
    }
    return state.lastReadSeq;
  }

  function markAllRead(options) {
    const opts = options || {};
    const latest = Math.max(
      state.latestSeq,
      state.items.length ? state.items[state.items.length - 1].seq : 0
    );
    return markReadTo(latest, {
      source: opts.source || "all",
      toast: opts.silent ? "" : "已全部标为已读 · lastReadSeq 推进到 {seq}",
      renderIfUnreadFilter: true,
    });
  }

  function scheduleAutoRead(delay) {
    window.clearTimeout(timers.autoRead);
    timers.autoRead = window.setTimeout(function () {
      if (!state.ready) return;
      // 未读只跟“真正读完”走：连续完成（或确定不会朗读）的消息才推进游标。
      // 滚动到底部、切筛选、取消冻结都不再一次性清空未读。
      const candidate = settledReadSeq();
      if (candidate <= state.lastReadSeq) return;
      state.lastAutoReadAt = Date.now();
      markReadTo(candidate, { source: "tts", silent: true });
    }, Number.isFinite(delay) ? delay : 500);
  }

  function cancelAutoRead() {
    window.clearTimeout(timers.autoRead);
  }

  function settledReadSeq() {
    let candidate = state.lastReadSeq;
    for (let i = 0; i < state.items.length; i += 1) {
      const item = state.items[i];
      if (!item || item.seq <= candidate) continue;
      const key = item.speech && item.speech.key;
      // done=已朗读；skipped/failed=已处理且不会再播放，不能永远挂着未读。
      if (key === "done" || key === "skipped" || key === "failed") {
        candidate = item.seq;
      } else {
        break;
      }
    }
    return candidate;
  }

  function renderFocus() {
    if (!el.focusList) return;
    const recent = state.items.slice(-10).reverse();
    if (!recent.length) {
      el.focusList.innerHTML = '<div class="inspector-empty"><b>暂无消息</b><span>消息到达后会出现在这里。</span></div>';
      return;
    }
    el.focusList.innerHTML = recent
      .map(function (item) {
        const meta = item.typeMeta;
        return (
          '<div class="focus-item' + (item.seq === state.selectedSeq ? " is-selected" : "") +
          '" data-seq="' + item.seq + '">' +
          '<span class="time-cell">' + escapeHTML(formatClock(item.ts, false)) + "</span>" +
          '<span class="type-badge" style="--type-color:' + meta.color + ";--type-bg:" + meta.bg + ";--type-border:" + meta.border + '">' + escapeHTML(meta.label) + "</span>" +
          '<span class="user-cell">' + escapeHTML(item.user) + "</span>" +
          '<span class="focus-text" title="' + escapeHTML(item.text) + '">' + escapeHTML(item.text) + "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function setFocusOpen(open) {
    state.focusOpen = Boolean(open);
    if (el.focusPanel) el.focusPanel.hidden = !state.focusOpen;
    if (state.focusOpen) renderFocus();
    updateChrome();
  }

  function toggleFocus() {
    setFocusOpen(!state.focusOpen);
  }

  function changeInterfaceSizeByStep(delta) {
    const index = INTERFACE_SIZES.findIndex(function (size) {
      return size.key === state.uiSize;
    });
    const next = INTERFACE_SIZES[clamp(index + delta, 0, INTERFACE_SIZES.length - 1)];
    if (!next || next.key === state.uiSize) return;
    setInterfaceSize(next.key, true);
  }

  function setInterfaceSize(key, persist) {
    const size = SIZE_BY_KEY[key];
    if (!size) return;
    const wasAtBottom = isAtBottom(4);
    state.uiSize = size.key;
    state.fontPx = size.fontPx;
    applyInterfaceVars();
    refreshResponsiveLayout();
    updateChrome();
    window.requestAnimationFrame(function () {
      syncScrollSpacer();
      if (wasAtBottom) {
        suppressScrollUntil = performance.now() + 120;
        el.tableScroll.scrollTop = Math.max(0, el.tableScroll.scrollHeight - el.tableScroll.clientHeight);
      }
      updateChrome();
    });
    scheduleTruncationCheck();
    if (persist && state.api && typeof state.api.set_font === "function") {
      Promise.resolve()
        .then(function () {
          return state.api.set_font(size.fontPx, size.key);
        })
        .then(function (result) {
          if (result && typeof result === "object" && result.ok === false) {
            toast("界面已在本窗口切换，写入配置失败：" + asText(result.error || "未知错误"), true);
          }
        })
        .catch(function (error) {
          state.lastError = "set_font: " + asText(error && error.message ? error.message : error);
          toast("界面已在本窗口切换，写入配置失败", true);
        });
    }
    if (persist) {
      toast(size.longLabel + " · " + size.layoutLabel);
    }
  }

  function setUnreadOnly(value) {
    state.unreadOnly = Boolean(value);
    updateChrome();
    renderTable({ align: "top" });
  }

  function setFilterType(type) {
    state.filterType = type === "all" || TYPE_META[type] ? type : "all";
    updateChrome();
    renderTable({ align: "top" });
  }

  function applySearch(value) {
    state.query = asText(value).trim();
    renderTable({ align: state.query ? "top" : "bottom" });
  }

  function clearFilters() {
    state.query = "";
    state.filterType = "all";
    state.unreadOnly = false;
    if (el.monitorSearch) el.monitorSearch.value = "";
    updateChrome();
    renderTable({ align: "bottom" });
  }

  function toggleFreeze() {
    setFrozen(!state.frozen);
  }

  function setFrozen(value, options) {
    const opts = options || {};
    const next = Boolean(value);
    if (next === state.frozen) return;
    if (next) {
      state.frozen = true;
      state.frozenAtSeq = state.latestSeq;
      state.pendingSnapshot = null;
      cancelAutoRead();
    } else {
      state.frozen = false;
      state.frozenAtSeq = 0;
      const pending = state.pendingSnapshot;
      state.pendingSnapshot = null;
      if (pending) {
        ingestSnapshot(pending, { initial: false, force: true, align: "bottom" });
      } else {
        renderTable({ align: "bottom" });
        refreshSnapshot({ forceRender: true, align: "bottom" });
      }
      cancelAutoRead();
      scheduleAutoRead(120);
    }
    updateChrome();
    if (!opts.silent) {
      toast(
        state.frozen
          ? "已冻结列表（后台继续接收）"
          : "已恢复并回到最新"
      );
    }
  }

  function goLatest() {
    if (state.frozen) {
      setFrozen(false, { silent: true });
      toast("已回到最新并继续跟随");
      return;
    }
    suppressScrollUntil = performance.now() + 180;
    el.tableScroll.scrollTop = Math.max(0, el.tableScroll.scrollHeight - el.tableScroll.clientHeight);
    updateChrome();
    scheduleAutoRead(100);
    toast("已回到最新");
  }

  function toggleOverview(force) {
    const wasAtBottom = isAtBottom(4);
    state.overviewOpen = typeof force === "boolean" ? force : !state.overviewOpen;
    persistOverview();
    if (el.overview) el.overview.hidden = !state.overviewOpen;
    if (el.overviewToggle) el.overviewToggle.setAttribute("aria-expanded", String(state.overviewOpen));
    updateChrome();
    window.requestAnimationFrame(function () {
      syncScrollSpacer();
      if (wasAtBottom) {
        suppressScrollUntil = performance.now() + 120;
        el.tableScroll.scrollTop = Math.max(0, el.tableScroll.scrollHeight - el.tableScroll.clientHeight);
      }
      updateVisibleMetrics();
      updateChrome();
    });
  }

  function buildColumnMenu() {
    if (!el.columnsList) return;
    el.columnsList.innerHTML = COLUMN_ORDER
      .map(function (column) {
        const locked = column === "content";
        const checked = state.columns.indexOf(column) >= 0 || locked;
        return (
          '<label class="column-option' + (locked ? " is-locked" : "") + '">' +
          '<input type="checkbox" data-column="' + column + '"' + (checked ? " checked" : "") + (locked ? " disabled" : "") + ">" +
          "<span>" + escapeHTML(COLUMN_LABELS[column]) + "</span>" +
          (locked ? "<small>固定</small>" : "") +
          "</label>"
        );
      })
      .join("");
  }

  function openColumnsMenu() {
    if (!el.columnsMenu || !el.columnsBtn) return;
    buildColumnMenu();
    el.columnsMenu.hidden = false;
    el.columnsBtn.setAttribute("aria-expanded", "true");
    const rect = el.columnsBtn.getBoundingClientRect();
    const menuWidth = 232;
    let left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
    left = Math.max(8, left);
    let top = rect.bottom + 6;
    const menuHeight = el.columnsMenu.offsetHeight;
    if (top + menuHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - menuHeight - 6);
    }
    el.columnsMenu.style.left = left + "px";
    el.columnsMenu.style.top = top + "px";
  }

  function closeColumnsMenu() {
    if (!el.columnsMenu || el.columnsMenu.hidden) return;
    el.columnsMenu.hidden = true;
    if (el.columnsBtn) el.columnsBtn.setAttribute("aria-expanded", "false");
  }

  function toast(message, warn) {
    if (!el.toast || !el.toastText) return;
    el.toastText.textContent = asText(message);
    el.toast.classList.toggle("is-warn", Boolean(warn));
    el.toast.classList.add("is-visible");
    window.clearTimeout(timers.toast);
    timers.toast = window.setTimeout(function () {
      el.toast.classList.remove("is-visible");
    }, 2300);
  }

  function copyText(text) {
    const value = asText(text);
    if (!value) {
      toast("没有可复制的正文", true);
      return Promise.resolve(false);
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(value)
        .then(function () {
          toast("已复制完整正文");
          return true;
        })
        .catch(function () {
          return fallbackCopy(value);
        });
    }
    return Promise.resolve(fallbackCopy(value));
  }

  function fallbackCopy(value) {
    try {
      const input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.style.top = "0";
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(input);
      toast(ok ? "已复制完整正文" : "复制失败，请手动选择文本", !ok);
      return ok;
    } catch (_) {
      toast("复制失败，请手动选择文本", true);
      return false;
    }
  }

  function copyCurrentMessage() {
    const item = selectedItem();
    if (!item) {
      toast("请先选择一条消息", true);
      return;
    }
    copyText(item.text);
  }

  function markSelectedRead() {
    const item = selectedItem();
    if (!item) {
      toast("请先选择一条消息", true);
      return;
    }
    markReadTo(item.seq, { source: "inspector", toast: "已标为已读 · seq {seq}" });
  }

  function locateSelected() {
    const item = selectedItem();
    if (!item) {
      toast("请先选择一条消息", true);
      return;
    }
    const row = el.messageRows.querySelector('.row[data-seq="' + item.seq + '"]');
    if (!row) {
      toast("当前筛选下不可见", true);
      return;
    }
    suppressScrollUntil = performance.now() + 220;
    row.scrollIntoView({ block: "center", inline: "nearest" });
    row.classList.remove("is-flash");
    void row.offsetWidth;
    row.classList.add("is-flash");
    window.setTimeout(function () {
      row.classList.remove("is-flash");
    }, 1000);
    updateChrome();
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = asText(target.tagName).toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
  }

  function handleKeydown(event) {
    if (event.defaultPrevented) return;

    if (event.key === "Escape") {
      if (el.columnsMenu && !el.columnsMenu.hidden) {
        event.preventDefault();
        closeColumnsMenu();
        return;
      }
      if (state.focusOpen) {
        event.preventDefault();
        setFocusOpen(false);
        return;
      }
      if (isTypingTarget(event.target) && event.target === el.monitorSearch) {
        event.target.value = "";
        applySearch("");
        event.target.blur();
        return;
      }
      if (state.selectedSeq != null || state.inspectorOpen) {
        event.preventDefault();
        clearSelection({ closeInspector: true });
      }
      return;
    }

    if (el.columnsMenu && !el.columnsMenu.hidden) return;
    if (isTypingTarget(event.target)) return;

    if (["PageDown", "PageUp", "Home", "End"].indexOf(event.key) >= 0) {
      markScrollIntent();
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const key = String(event.key || "").toLowerCase();
    if (key === "j" || key === "arrowdown" || key === "k" || key === "arrowup") {
      const rows = Array.prototype.slice.call(el.messageRows.querySelectorAll(".row"));
      if (!rows.length) return;
      event.preventDefault();
      let index = rows.findIndex(function (row) {
        return Number(row.dataset.seq) === state.selectedSeq;
      });
      if (index < 0) index = key === "k" || key === "arrowup" ? rows.length - 1 : 0;
      else index = clamp(index + (key === "k" || key === "arrowup" ? -1 : 1), 0, rows.length - 1);
      selectItem(Number(rows[index].dataset.seq), {
        source: "keyboard",
        openInspector: true,
        markRead: true,
        scrollIntoView: true,
      });
      return;
    }

    if (event.key === "Enter" && state.selectedSeq != null) {
      event.preventDefault();
      openInspector();
      return;
    }
  }

  function scheduleTruncationCheck() {
    window.clearTimeout(timers.mode);
    timers.mode = window.setTimeout(runTruncationCheck, 1000);
  }

  function measureTruncationRate(layout) {
    const rows = Array.prototype.slice.call(el.messageRows.querySelectorAll(".row")).slice(-50);
    if (!rows.length) return 0;
    let checked = 0;
    let truncated = 0;
    const availableSingleWidth = (function () {
      const singleColumns = singleColumnsForWidth(window.innerWidth, state.uiSize === "small");
      const singleWidths = state.uiSize === "large"
        ? COLUMN_WIDTH_LARGE
        : state.uiSize === "medium"
          ? COLUMN_WIDTH_MEDIUM
          : COLUMN_WIDTH_SMALL;
      const fixed = singleColumns.reduce(function (total, column) {
        return total + (column === "content" ? 0 : singleWidths[column] || 0);
      }, 0);
      return Math.max(0, el.tableScroll.clientWidth - 24 - fixed);
    })();

    rows.forEach(function (row) {
      const target = layout.twoLine
        ? row.querySelector(".row-content .body")
        : row.querySelector(".content-cell .content-text");
      if (!target) return;
      checked += 1;
      const available = layout.twoLine ? availableSingleWidth : target.clientWidth;
      if (target.scrollWidth > available + 2) truncated += 1;
    });
    return checked ? truncated / checked : 0;
  }

  function setTwoLine(value, reason, rate) {
    const next = Boolean(value);
    const nextReason = next ? (reason || "truncation") : "";
    if (state.twoLine === next && state.twoLineReason === nextReason) {
      if (rate != null) state.truncationRate = rate;
      state.modeReason = next
        ? reason === "width"
          ? "窗口宽 < 1100px"
          : "正文截断率 " + (Number(rate || 0) * 100).toFixed(1) + "% > 20%"
        : "";
      updateChrome();
      return;
    }
    const wasAtBottom = isAtBottom(4);
    state.twoLine = next;
    state.twoLineReason = nextReason;
    state.truncationHighStreak = 0;
    state.truncationLowStreak = 0;
    if (rate != null) state.truncationRate = rate;
    state.modeReason = next
      ? reason === "width"
        ? "窗口宽 < 1100px"
        : "正文截断率 " + (Number(rate || 0) * 100).toFixed(1) + "% > 20%"
      : "";
    renderTable({
      preserveScroll: true,
      align: wasAtBottom ? "bottom" : undefined,
    });
    scheduleTruncationCheck();
  }

  function runTruncationCheck() {
    window.clearTimeout(timers.mode);
    if (!state.ready || !el.messageRows) {
      scheduleTruncationCheck();
      return;
    }
    if (document.hidden || state.frozen || state.focusOpen) {
      scheduleTruncationCheck();
      return;
    }

    const width = window.innerWidth;
    if (width < 1100) {
      if (!state.twoLine || state.twoLineReason !== "width") {
        setTwoLine(true, "width", 0);
      } else {
        state.modeReason = "窗口宽 < 1100px";
      }
      scheduleTruncationCheck();
      return;
    }

    if (state.twoLine && state.twoLineReason === "width") {
      if (width >= 1140) {
        setTwoLine(false, "", 0);
      }
      scheduleTruncationCheck();
      return;
    }

    const layout = currentLayout();
    if (!state.twoLine && !isAtBottom(8)) {
      scheduleTruncationCheck();
      return;
    }

    const rate = measureTruncationRate(layout);
    state.truncationRate = rate;

    if (!state.twoLine) {
      if (rate > 0.20) {
        state.truncationHighStreak += 1;
      } else {
        state.truncationHighStreak = 0;
      }
      if (state.truncationHighStreak >= 3) {
        setTwoLine(true, "truncation", rate);
      } else {
        updateChrome();
      }
    } else if (state.twoLineReason === "truncation") {
      if (rate <= 0.10) {
        state.truncationLowStreak += 1;
      } else {
        state.truncationLowStreak = 0;
      }
      if (state.truncationLowStreak >= 15) {
        setTwoLine(false, "", 0);
      } else {
        updateChrome();
      }
    }
    scheduleTruncationCheck();
  }

  function refreshResponsiveLayout() {
    const width = window.innerWidth;
    if (width < 1100) {
      if (!state.twoLine || state.twoLineReason !== "width") {
        setTwoLine(true, "width", 0);
        return;
      }
    } else if (state.twoLine && state.twoLineReason === "width" && width >= 1140) {
      setTwoLine(false, "", 0);
      return;
    }
    const layout = currentLayout();
    const signature = layoutSignature(layout);
    if (signature !== state.layoutSignature) {
      const wasAtBottom = isAtBottom(4);
      renderTable({ preserveScroll: true, align: wasAtBottom ? "bottom" : undefined });
    } else {
      updateChrome();
    }
    scheduleTruncationCheck();
  }

  function handleResize() {
    closeColumnsMenu();
    refreshResponsiveLayout();
    scheduleGeometrySave();
  }

  function handleScroll(event) {
    if (!event || !event.isTrusted) return;
    if (performance.now() < suppressScrollUntil) return;
    updateChrome();
    if (
      performance.now() <= scrollIntentUntil &&
      !state.frozen &&
      isAtBottom(4) &&
      !state.unreadOnly
    ) {
      scheduleAutoRead(500);
    }
  }

  function markScrollIntent() {
    scrollIntentUntil = performance.now() + 1400;
  }

  function handleCtrlWheel(event) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastFontWheelAt < 120) return;
    lastFontWheelAt = now;
    changeInterfaceSizeByStep(event.deltaY < 0 ? 1 : -1);
  }

  function resolveApi() {
    if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.snapshot === "function") {
      return window.pywebview.api;
    }
    if (window.api && typeof window.api.snapshot === "function") {
      return window.api;
    }
    return null;
  }

  function startWithApi(api, mode) {
    if (!api) return false;
    if (state.api === api && (state.ready || state.loading)) return true;
    window.clearTimeout(bootFallbackTimer);
    pollGeneration += 1;
    window.clearTimeout(timers.snapshot);
    window.clearTimeout(timers.serverState);
    state.loading = true;
    state.ready = false;
    state.api = api;
    state.apiMode = mode;
    document.body.dataset.apiMode = mode;
    loadInitialData()
      .catch(function (error) {
        state.lastError = "boot: " + asText(error && error.message ? error.message : error);
        state.hasSnapshotError = true;
        state.ready = true;
        state.initialLoaded = true;
        updateChrome();
        window.__MONITOR_READY__ = true;
        startPolling();
      })
      .finally(function () {
        state.loading = false;
      });
    return true;
  }

  function startMock(reason) {
    if (state.ready) return;
    if (resolveApi()) {
      startWithApi(resolveApi(), "real");
      return;
    }
    mockRuntime = createMockRuntime();
    const api = createMockApi(mockRuntime);
    state.api = api;
    state.apiMode = "mock";
    document.body.dataset.apiMode = "mock";
    document.body.dataset.mockReason = reason || "no-pywebview";
    loadInitialData();
  }

  async function callApi(method) {
    if (!state.api || typeof state.api[method] !== "function") {
      throw new Error("API 缺少方法：" + method);
    }
    const args = Array.prototype.slice.call(arguments, 1);
    let result = await state.api[method].apply(state.api, args);
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch (_) {
        // 保留原始字符串给调用方诊断。
      }
    }
    return result;
  }

  function applyConfig(config) {
    if (!config || typeof config !== "object") return;
    const monitor = config.monitor && typeof config.monitor === "object" ? config.monitor : config;
    const size = sizeFromConfig(monitor);
    state.uiSize = size.key;
    state.fontPx = size.fontPx;
    if (!state.storedColumns) {
      const columns = validColumns(monitor.columns);
      if (columns) state.columns = columns;
    }
    applyInterfaceVars();
    refreshResponsiveLayout();
  }

  async function loadInitialData() {
    state.ready = false;
    const storedColumns = loadStoredColumns();
    if (storedColumns) state.columns = storedColumns;
    state.overviewOpen = loadOverviewPreference();
    if (el.overview) el.overview.hidden = !state.overviewOpen;

    applyInterfaceVars();
    buildColumnMenu();
    updateChrome();

    const configTask = callApi("config").catch(function () {
      return null;
    });
    const lastReadTask =
      state.api && typeof state.api.last_read === "function"
        ? callApi("last_read").catch(function () {
            return null;
          })
        : Promise.resolve(null);

    const results = await Promise.all([configTask, lastReadTask]);
    applyConfig(results[0]);
    const lastReadResponse = results[1];
    if (lastReadResponse && typeof lastReadResponse === "object") {
      state.lastReadSeq = Math.max(
        0,
        asInt(
          lastReadResponse.last_read == null ? lastReadResponse.lastRead : lastReadResponse.last_read,
          0
        )
      );
    }

    let snapshot = null;
    try {
      snapshot = await callApi("snapshot", 300);
      const snapshotError = snapshotErrorMessage(snapshot);
      if (snapshotError) {
        state.hasSnapshotError = true;
        state.lastError = "snapshot: " + snapshotError;
        snapshot = null;
      } else {
        state.hasSnapshotError = false;
      }
    } catch (error) {
      state.hasSnapshotError = true;
      state.lastError = "snapshot: " + asText(error && error.message ? error.message : error);
    }
    if (snapshot) {
      ingestSnapshot(snapshot, { initial: true, force: true, align: "bottom" });
    } else {
      state.initialLoaded = true;
      state.ready = true;
      renderTable({ align: "bottom" });
    }

    try {
      const serverState = await callApi("state");
      applyServerState(serverState);
    } catch (error) {
      state.lastError = "state: " + asText(error && error.message ? error.message : error);
    }

    state.ready = true;
    state.initialLoaded = true;
    if (window.innerWidth < 1100 && !state.twoLine) {
      state.twoLine = true;
      state.twoLineReason = "width";
      state.modeReason = "窗口宽 < 1100px";
      renderTable({ preserveScroll: true, align: "bottom" });
    }
    updateChrome();
    updateVisibleMetrics();
    window.__MONITOR_READY__ = true;
    startPolling();
    scheduleTruncationCheck();
  }

  function applyServerState(raw) {
    if (!raw || typeof raw !== "object") return;
    const source = raw.state && raw.state.connection ? raw.state : raw;
    if (source.connection != null) state.connection = asText(source.connection);
    if (source.platform != null) {
      const platform = asText(source.platform).toLowerCase() === "douyin" ? "douyin" : "bilibili";
      if (platform !== state.platform) {
        state.platform = platform;
        if (platformTypeOrder().indexOf(state.filterType) < 0) state.filterType = "all";
        buildFilters();
      }
    }
    if (source.room_title != null) state.roomTitle = asText(source.room_title);
    if (source.stats && typeof source.stats === "object") {
      state.stats = {
        received: asInt(source.stats.received, 0),
        spoken: asInt(source.stats.spoken, 0),
        dropped: asInt(source.stats.dropped, 0),
      };
    }
    state.nowPlaying = source.now_playing == null ? null : source.now_playing;
    state.queueLen = asInt(source.queue_len, 0);
    if (state.inspectorOpen) updateInspector();
    updateChrome();
  }

  function snapshotSeqOf(snapshot, items) {
    let seq = asInt(snapshot && snapshot.seq, 0);
    if (!seq && items.length) seq = items[items.length - 1].seq;
    return Math.max(seq, items.length ? items[items.length - 1].seq : 0);
  }

  function snapshotErrorMessage(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || !snapshot.error) return "";
    return asText(snapshot.error);
  }

  function ingestSnapshot(snapshot, options) {
    if (!snapshot || typeof snapshot !== "object") return false;
    const opts = options || {};
    const items = normalizeItems(snapshot.items);
    const seq = snapshotSeqOf(snapshot, items);
    const signature = itemSignature(items);
    const previousLatest = state.latestSeq;

    if (state.frozen && !opts.initial) {
      state.pendingSnapshot = { seq: seq, items: snapshot.items, snapshot: snapshot };
      state.latestSeq = Math.max(state.latestSeq, seq);
      updateChrome();
      return true;
    }

    if (!opts.force && signature === state.snapshotSignature && seq === state.latestSeq) {
      updateChrome();
      return false;
    }

    const wasAtBottom = opts.align === "bottom" || isAtBottom(4) || !state.initialLoaded;
    state.items = items;
    state.latestSeq = seq;
    state.snapshotSeq = seq;
    state.snapshotSignature = signature;
    state.pendingSnapshot = null;
    state.hasSnapshotError = false;
    if (state.selectedSeq != null && !selectedItem()) {
      state.selectedSeq = null;
      setInspectorOpen(false);
    }
    renderTable({
      align: opts.align || (wasAtBottom ? "bottom" : undefined),
      preserveScroll: true,
    });
    if (opts.initial) {
      state.initialLoaded = true;
    } else {
      // TTS 完成状态可能原地更新（seq 不变），所以每次快照变化都尝试推进未读。
      scheduleAutoRead(seq > previousLatest ? 500 : 200);
    }
    return true;
  }

  async function refreshSnapshot(options) {
    const opts = options || {};
    if (!state.api || !state.ready && !state.initialLoaded) return;
    try {
      const snapshot = await callApi("snapshot", 300);
      const snapshotError = snapshotErrorMessage(snapshot);
      if (snapshotError) {
        state.hasSnapshotError = true;
        state.lastError = "snapshot: " + snapshotError;
        updateChrome();
        return;
      }
      if (opts.forceRender) {
        if (snapshot) ingestSnapshot(snapshot, {
          initial: false,
          force: true,
          align: opts.align || undefined,
        });
      } else if (snapshot) {
        ingestSnapshot(snapshot, { initial: false });
      }
      state.hasSnapshotError = false;
    } catch (error) {
      state.hasSnapshotError = true;
      state.lastError = "snapshot: " + asText(error && error.message ? error.message : error);
      updateChrome();
    }
  }

  async function refreshServerState() {
    if (!state.api) return;
    try {
      const value = await callApi("state");
      applyServerState(value);
    } catch (error) {
      state.lastError = "state: " + asText(error && error.message ? error.message : error);
    }
  }

  function startPolling() {
    pollGeneration += 1;
    const generation = pollGeneration;
    window.clearTimeout(timers.snapshot);
    window.clearTimeout(timers.serverState);

    async function snapshotLoop() {
      if (generation !== pollGeneration) return;
      await refreshSnapshot();
      if (generation !== pollGeneration) return;
      timers.snapshot = window.setTimeout(snapshotLoop, document.hidden ? 2000 : 500);
    }

    async function stateLoop() {
      if (generation !== pollGeneration) return;
      await refreshServerState();
      if (generation !== pollGeneration) return;
      timers.serverState = window.setTimeout(stateLoop, document.hidden ? 8000 : 2000);
    }

    timers.snapshot = window.setTimeout(snapshotLoop, document.hidden ? 2000 : 500);
    timers.serverState = window.setTimeout(stateLoop, document.hidden ? 8000 : 2000);
  }

  function handleVisibilityChange() {
    if (!state.ready) return;
    startPolling();
    if (!document.hidden) {
      refreshSnapshot();
      refreshServerState();
      updateVisibleMetrics();
    }
  }

  function scheduleGeometrySave() {
    if (state.apiMode !== "real" || !state.api) return;
    window.clearTimeout(timers.geometry);
    timers.geometry = window.setTimeout(saveGeometry, 650);
  }

  function saveGeometry() {
    if (state.apiMode !== "real" || !state.api || typeof state.api.save_geometry !== "function") return;
    const geometry = {
      x: Math.round(Number(window.screenX) || 0),
      y: Math.round(Number(window.screenY) || 0),
      width: Math.round(Number(window.outerWidth) || window.innerWidth),
      height: Math.round(Number(window.outerHeight) || window.innerHeight),
    };
    Promise.resolve()
      .then(function () {
        return state.api.save_geometry(geometry);
      })
      .then(function (response) {
        if (response && response.ok === false) {
          state.lastError = "save_geometry: " + asText(response.error || "写入失败");
        }
        return response;
      })
      .catch(function (error) {
        state.lastError = "save_geometry: " + asText(error && error.message ? error.message : error);
      });
  }

  function pushMockMessages(count) {
    if (!mockRuntime) return false;
    mockRuntime.push(Math.max(1, Math.min(20, asInt(count, 1))));
    refreshSnapshot({ forceRender: false });
    return true;
  }

  function setMockSpoken(seq, spoken) {
    if (!mockRuntime) return false;
    const target = mockRuntime.items.find(function (item) {
      return item.seq === Number(seq);
    });
    if (!target) return false;
    target.spoken = Boolean(spoken);
    target.tts.state = spoken ? "done" : "failed";
    if (spoken) {
      target.tts.finished_at = new Date().toISOString();
      target.tts.duration_ms = target.tts.duration_ms || 1200;
      target.meta = Object.assign({}, target.meta);
      delete target.meta.filter;
    } else {
      target.tts.finished_at = null;
      target.meta = Object.assign({}, target.meta, { filter: "synth_failed" });
    }
    refreshSnapshot({ forceRender: true });
    return true;
  }

  function createMockRuntime() {
    const runtime = {
      items: [],
      latest: 2418,
      lastRead: 2406,
      config: {
        font_px: 30,
        ui_size: "medium",
        font_mode: "manual",
        mode: "auto",
        columns: COLUMN_ORDER.slice(),
        geometry: { width: 1366, height: 768 },
      },
      state: {
        connection: "connected",
        room_title: "小马的夜航电台",
        stats: { received: 2418, spoken: 2381, dropped: 34 },
        now_playing: { user: "南风", text: "谢谢今晚的陪伴。下周考试，考完再回来听现场。" },
        queue_len: 3,
      },
      push: function (count) {
        const n = Math.max(1, Math.min(20, asInt(count, 1)));
        const base = runtime.latest;
        for (let i = 0; i < n; i += 1) {
          runtime.latest += 1;
          const item = makeMockItem(runtime.latest, runtime.latest - 2339, Date.now() / 1000);
          runtime.items.push(item);
        }
        runtime.state.stats.received += n;
        runtime.state.stats.spoken += Math.max(0, n - 1);
        runtime.state.queue_len = Math.min(9, runtime.state.queue_len + 1);
        runtime.state.now_playing = { user: "系统模拟", text: "冻结期间收到 " + n + " 条新消息" };
        if (runtime.latest <= base) runtime.latest = base + n;
      },
    };
    runtime.items = buildMockItems();
    return runtime;
  }

  function createMockApi(runtime) {
    return {
      snapshot: function () {
        return {
          seq: runtime.latest,
          items: runtime.items.map(function (item) {
            return Object.assign({}, item, {
              meta: Object.assign({}, item.meta),
              tts: Object.assign({}, item.tts),
            });
          }),
        };
      },
      state: function () {
        return JSON.parse(JSON.stringify(runtime.state));
      },
      config: function () {
        return JSON.parse(JSON.stringify(runtime.config));
      },
      set_font: function (px, key) {
        const size = SIZE_BY_PX[Number(px)];
        if (!size) return { ok: false, error: "font_px 非法" };
        runtime.config.font_px = size.fontPx;
        runtime.config.ui_size = SIZE_BY_KEY[key] ? key : size.key;
        runtime.config.font_mode = "manual";
        return { ok: true, font_px: size.fontPx, ui_size: runtime.config.ui_size };
      },
      mark_read: function (seq) {
        runtime.lastRead = Math.max(runtime.lastRead, asInt(seq, 0));
        return { ok: true, last_read: runtime.lastRead };
      },
      last_read: function () {
        return { last_read: runtime.lastRead };
      },
      save_geometry: function (geometry) {
        runtime.config.geometry = Object.assign({}, runtime.config.geometry, geometry || {});
        return { ok: true, geometry: runtime.config.geometry };
      },
    };
  }

  function makeMockItem(seq, index, epoch) {
    const users = [
      "纸飞机", "长夜", "未眠", "小岛", "七号公路", "白露", "南枝", "海盐",
      "迟到的人", "鹿鸣", "一颗蓝莓", "沿江", "星屑", "迟到的雨", "远山",
      "白噪声", "半杯茶", "南风", "灯下", "小满", "路过的猫", "三月七日",
      "一杯温水", "夜行列车", "云层之上", "桃桃乌龙", "清晨六点", "风停在窗边",
      "不打烊", "日落之前",
    ];
    const danmaku = [
      "主播今天嗓子状态很好，高音很稳。",
      "刚进来，请问前面唱的是哪一首？",
      "想听一首适合夜里走路的歌，随便什么都行。",
      "这段和声是自己叠的吗，层次好清楚。",
      "耳机党表示这个左右声道太舒服了。",
      "刚刚那句尾音是不是升了半个调？",
      "今晚会唱到几点？明天还要早起但舍不得走。",
      "这个麦的底噪控制得很好，求设备清单。",
      "刚才那段即兴能不能单独发一版？",
      "这句“晚风”处理得好轻，像真的在耳边。",
      "第一次来，这个直播间氛围好舒服。",
      "已经关注啦，每天蹲直播。",
      "前方高能预警，副歌要来了。",
      "这首歌的鼓点一进去就起鸡皮疙瘩。",
      "能不能把灯关小一点，听感会更沉浸。",
      "今天的歌单很适合写作业，谢谢主播。",
      "刚才那一小段清唱比伴奏版更好听。",
      "声音再靠近一点会不会更温柔？",
      "主播今天状态像开挂，连续三首都稳。",
      "路过听到，先留下来听一会儿。",
      "这句歌词咬字好细，情绪一下上来了。",
      "外面在下雨，配这首歌刚刚好。",
      "听完就去睡，明早还要赶地铁。",
      "这段旋律让我想起很久以前的夏天。",
      "可以再来一首慢歌吗，今晚想安静一点。",
      "尾音收得好干净，混响比例也舒服。",
      "耳机左右声道的空间感做得真细，像坐在小剧场第二排。",
      "刚才切歌的空拍处理得很巧，情绪没有断。",
      "今晚这场的选曲比上周更克制，反而更耐听。",
    ];
    const gifts = [
      ["心动话筒", 15, 1],
      ["荧光棒", 20, 10],
      ["小电视飞船", 168, 1],
      ["干杯", 10, 2],
      ["星愿", 45, 1],
      ["打call", 30, 3],
      ["星星点点", 50, 1],
    ];
    const scs = [
      "谢谢今晚的陪伴。下周考试，考完再回来听现场。",
      "想点一首《晴天》，今晚的风很适合。",
      "这段钢琴前奏能不能多弹一会儿？",
      "工作第一天有点累，听到这首歌好多了。",
      "祝主播今晚嗓子顺顺利利，不用勉强高音。",
      "把这首歌送给正在加班的朋友们。",
    ];
    const guardNames = ["舰长", "提督", "总督"];
    const type = mockTypeForIndex(index);
    const user = users[index % users.length];
    const meta = {};
    let text = "";
    let value = null;
    let spoken = index < 68 ? true : index % 4 !== 0 ? true : null;

    if (type === "gift") {
      const gift = gifts[index % gifts.length];
      meta.gift_name = gift[0];
      meta.price = gift[1];
      meta.num = gift[2];
      meta.total_coin = gift[1];
      text = "送出 " + gift[0] + (gift[2] > 1 ? " ×" + gift[2] : " ×1");
      value = { amount: gift[1], count: gift[2], gift_name: gift[0] };
    } else if (type === "super_chat") {
      text = scs[index % scs.length];
      meta.message = text;
      meta.price = [30, 50, 88, 128][index % 4];
      value = { amount: meta.price, currency: "CNY" };
    } else if (type === "guard") {
      const level = (index % 3) + 1;
      meta.guard_level = level;
      meta.guard_name = guardNames[level - 1];
      text = "开通 " + guardNames[level - 1] + (index % 7 === 0 ? " · 连续 3 个月" : "");
      value = { amount: [198, 1998, 19998][level - 1], currency: "CNY" };
    } else if (type === "enter") {
      text = "进入直播间";
      meta.medal_level = 3 + (index % 21);
      spoken = false;
      meta.filter = "disabled";
    } else {
      text = danmaku[index % danmaku.length];
      if (index % 17 === 0) {
        text = text + " 这段真的值得反复听，尤其是第二遍副歌之后那个突然放轻的尾音，情绪一下就落下来了。";
      }
    }

    const filter = spoken === false ? meta.filter || "mock_display_only" : meta.filter;
    if (filter) meta.filter = filter;
    return {
      seq: seq,
      type: type,
      user: user,
      uid: String(10700000 + ((index * 7919) % 900000)),
      text: text,
      ts: epoch - (79 - index) * 8,
      spoken: spoken,
      meta: Object.assign({ mock: true }, meta),
      value: value,
      source: "mock",
      tts: {
        state: spoken === true ? "done" : spoken === false ? "skipped" : "queued",
        engine: "edge",
        voice: index % 8 === 0 ? "zh-CN-YunxiNeural" : "zh-CN-XiaoyiNeural",
        duration_ms: spoken === true ? 900 + (index * 137) % 1800 : null,
        started_at: spoken === true ? new Date((epoch - 1) * 1000).toISOString() : null,
        finished_at: spoken === true ? new Date(epoch * 1000).toISOString() : null,
        error: null,
      },
    };
  }

  function mockTypeForIndex(index) {
    if (index % 13 === 0) return "super_chat";
    if (index % 11 === 0) return "enter";
    if (index % 7 === 0) return "gift";
    if (index % 19 === 0) return "guard";
    return "danmaku";
  }

  function buildMockItems() {
    const now = Date.now() / 1000;
    const items = [];
    for (let i = 0; i < 80; i += 1) {
      items.push(makeMockItem(2339 + i, i, now));
    }
    // 保证末 12 条一定覆盖 SC / 舰长 / 礼物，便于首屏检查未读。
    items[70].type = "gift";
    items[70].text = "送出 心动话筒 ×1";
    items[70].meta = { mock: true, gift_name: "心动话筒", price: 15, num: 1, total_coin: 15 };
    items[70].value = { amount: 15, count: 1, gift_name: "心动话筒" };
    items[74].type = "guard";
    items[74].text = "开通 舰长 · 首次上舰";
    items[74].meta = { mock: true, guard_level: 3, guard_name: "舰长" };
    items[74].value = { amount: 198, currency: "CNY" };
    items[78].type = "super_chat";
    items[78].text = "谢谢今晚的陪伴。下周考试，考完再回来听现场。";
    items[78].meta = { mock: true, message: items[78].text, price: 88 };
    items[78].value = { amount: 88, currency: "CNY" };
    return items;
  }

  function bindEvents() {
    el.freezeBtn.addEventListener("click", toggleFreeze);
    el.typeFilters.addEventListener("click", function (event) {
      const chip = event.target.closest("[data-filter]");
      if (!chip) return;
      setFilterType(chip.dataset.filter);
    });
    if (el.filterSelect) {
      el.filterSelect.addEventListener("change", function () {
        setFilterType(el.filterSelect.value);
      });
    }
    el.monitorSearch.addEventListener("input", function (event) {
      const value = event.target.value;
      window.clearTimeout(timers.search);
      timers.search = window.setTimeout(function () {
        applySearch(value);
      }, 90);
    });
    el.monitorSearch.addEventListener("search", function (event) {
      applySearch(event.target.value);
    });
    el.interfaceSizeControl.addEventListener("click", function (event) {
      const button = event.target.closest("[data-interface-size]");
      if (!button) return;
      setInterfaceSize(button.dataset.interfaceSize, true);
    });
    el.unreadOnlyBtn.addEventListener("click", function () {
      setUnreadOnly(!state.unreadOnly);
    });
    el.markReadBtn.addEventListener("click", function () {
      markAllRead();
    });
    el.inspectorToggle.addEventListener("click", toggleInspector);
    el.focusToggle.addEventListener("click", toggleFocus);
    el.latestBtn.addEventListener("click", goLatest);
    el.overviewToggle.addEventListener("click", function () {
      toggleOverview();
    });
    el.columnsBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      if (el.columnsMenu.hidden) openColumnsMenu();
      else closeColumnsMenu();
    });
    el.columnsList.addEventListener("change", function (event) {
      const checkbox = event.target.closest('[data-column]');
      if (!checkbox || checkbox.dataset.column === "content") return;
      const selected = new Set(state.columns);
      if (checkbox.checked) selected.add(checkbox.dataset.column);
      else selected.delete(checkbox.dataset.column);
      state.columns = COLUMN_ORDER.filter(function (column) {
        return selected.has(column) || column === "content";
      });
      state.storedColumns = true;
      persistColumns();
      const wasAtBottom = isAtBottom(4);
      renderTable({ preserveScroll: true, align: wasAtBottom ? "bottom" : undefined });
    });
    el.clearFiltersBtn.addEventListener("click", clearFilters);
    el.messageRows.addEventListener("click", function (event) {
      const row = event.target.closest(".row");
      if (!row) return;
      selectItem(Number(row.dataset.seq), {
        source: "row",
        openInspector: true,
        markRead: true,
        scrollIntoView: false,
      });
    });
    el.messageRows.addEventListener("dblclick", function (event) {
      const row = event.target.closest(".row");
      if (!row) return;
      selectItem(Number(row.dataset.seq), {
        source: "row-preview",
        openInspector: true,
        markRead: true,
        scrollIntoView: false,
      });
      toast("检查器已打开");
    });
    el.tableScroll.addEventListener("scroll", handleScroll, { passive: true });
    el.tableScroll.addEventListener("pointerdown", markScrollIntent, { passive: true });
    el.copyDetailBtn.addEventListener("click", copyCurrentMessage);
    el.markReadDetailBtn.addEventListener("click", markSelectedRead);
    el.locateBtn.addEventListener("click", locateSelected);
    el.focusList.addEventListener("click", function (event) {
      const row = event.target.closest(".focus-item");
      if (!row) return;
      setFocusOpen(false);
      selectItem(Number(row.dataset.seq), {
        source: "focus",
        openInspector: true,
        markRead: true,
        scrollIntoView: true,
      });
    });
    el.mockBadge.addEventListener("click", function () {
      if (state.apiMode === "mock") {
        pushMockMessages(1);
        toast(state.frozen ? "Mock：后台新到 1 条消息" : "Mock：已模拟 1 条新消息");
      }
    });
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("click", function (event) {
      if (
        el.columnsMenu && !el.columnsMenu.hidden &&
        !el.columnsMenu.contains(event.target) &&
        !el.columnsBtn.contains(event.target)
      ) {
        closeColumnsMenu();
      }
    });
    window.addEventListener("resize", handleResize);
    window.addEventListener("wheel", handleCtrlWheel, { passive: false });
    window.addEventListener("wheel", markScrollIntent, { passive: true });
    document.addEventListener("touchstart", markScrollIntent, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", function () {
      if (state.apiMode === "real" && state.api) saveGeometry();
    });
  }

  function boot() {
    cacheElements();
    bindEvents();
    buildFilters();
    buildColumnMenu();
    state.uiSize = "medium";
    state.fontPx = SIZE_BY_KEY.medium.fontPx;
    state.overviewOpen = loadOverviewPreference();
    applyInterfaceVars();
    updateChrome();
    window.__MONITOR_TEST__ = {
      push: pushMockMessages,
      setSpoken: setMockSpoken,
      markAllRead: markAllRead,
      state: function () {
        const detail = detailItem();
        return {
          ready: state.ready,
          apiMode: state.apiMode,
          frozen: state.frozen,
          lastReadSeq: state.lastReadSeq,
          latestSeq: state.latestSeq,
          unread: unreadCount(),
          backlog: backlogCount(),
          uiSize: state.uiSize,
          layout: currentLayout().twoLine ? "two_line" : "single_line",
          twoLine: currentLayout().twoLine,
          fontPx: state.fontPx,
          detailSeq: detail ? detail.seq : null,
          detailSource: state.selectedSeq != null ? "selected" : detail ? "follow" : null,
          filterType: state.filterType,
          columns: state.columns.slice(),
          selectedSeq: state.selectedSeq,
        };
      },
      audit: function () {
        return window.__MONITOR_AUDIT__ || null;
      },
      valueLabelOf: function (raw) {
        return normalizeItem(raw, 0).valueLabel;
      },
    };

    const direct = resolveApi();
    if (direct) {
      startWithApi(direct, "real");
      return;
    }

    window.addEventListener("pywebviewready", function () {
      const api = resolveApi();
      if (api) {
        if (state.apiMode === "mock") {
          state.apiMode = "pending";
          state.ready = false;
        }
        startWithApi(api, "real");
      }
    });

    const wait = window.pywebview ? 2500 : 650;
    bootFallbackTimer = window.setTimeout(function () {
      startMock(window.pywebview ? "bridge-timeout" : "no-pywebview");
    }, wait);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
