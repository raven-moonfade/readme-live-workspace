/* ============================================================
   幕台 · 工作台壳层 core
   唯一 state / els / ctx、基础 helper 与注册表；业务仍留在 shell.js。
   ============================================================ */
(function () {
  "use strict";

  var TYPE_META = [
    { key: "danmaku", label: "弹幕", color: "var(--accent)" },
    { key: "gift", label: "礼物", color: "var(--warn)" },
    { key: "super_chat", label: "SC", color: "var(--err)" },
    { key: "guard", label: "舰长", color: "var(--accent-ink)" },
    { key: "enter", label: "入场", color: "var(--ok)" },
    { key: "like", label: "点赞", color: "var(--warn)" },
    { key: "social", label: "关注", color: "var(--accent)" },
    { key: "fansclub", label: "粉丝团", color: "var(--warn)" }
  ];

  function newMetrics() {
    return {
      counts: {
        danmaku: 0, gift: 0, super_chat: 0, guard: 0, enter: 0,
        like: 0, social: 0, fansclub: 0
      },
      values: { giftCny: 0, giftSilver: 0, giftUnknown: 0, superChatCny: 0 },
      users: new Set(),
      minuteBuckets: new Map(),
      lastEventAt: null
    };
  }

  var state = {
    view: "danmaku",
    dataTab: "live",
    liveQueueHighSince: 0,
    liveLastRenderAt: 0,
    liveNoticeSignature: "",
    liveTypeSignature: "",
    liveActivitySignature: "",
    liveSparkSignature: "",
    postludeExporting: false,
    postludeExportSessionId: "",
    postludeExportSeq: 0,
    configStatus: null,
    securityRefreshAt: 0,
    snapshot: null,
    historyLoaded: false,
    historyLoading: false,
    historyFailed: false,
    historyNotice: "",
    historySessions: [],
    historyTotal: 0,
    historyAllTotal: 0,
    historyHasMore: false,
    historyCursor: null,
    historySelectedId: null,
    historyPreserveDetailId: "",
    historyRestoreId: "",
    historyLoadedAt: 0,
    historyLoadedKey: "",
    historyPageSize: 30,
    historyQuery: "",
    historyRange: "all",
    historyPlatform: "",
    historyPlatforms: [],
    historyFromValue: "",
    historyToValue: "",
    historyRequestSeq: 0,
    historyReloadPending: false,
    historyListNeedsTop: false,
    historySearchTimer: 0,
    historyManageOpen: false,
    historyManageBusy: false,
    historyManageLastFocus: null,
    historyManagePreview: null,
    historyManageSeq: 0,
    historyAutoEnabled: false,
    historyAutoDays: 90,
    historyAutoBusy: false,
    historyAutoSeq: 0,
    exportManageOpen: false,
    exportManageBusy: false,
    exportManageLastFocus: null,
    exportManageSeq: 0,
    exportManageStatus: null,
    exportManagePreview: null,
    exportManageWeek: "",
    exportManageDays: 90,
    exportManageKeepLatest: 50,
    historyTrendReloadPending: false,
    historyDetailSession: null,
    historyView: "overview",
    historyMode: "detail",
    historyTrendData: null,
    historyTrendLoading: false,
    historyTrendSeq: 0,
    historyTrendMetric: "received_per_hour",
    historyTrendGranularity: "day",
    historyTrendGranularityFocusPending: false,
    historyTrendLoadedKey: "",
    historyTrendRoomKey: "",
    historyTrendRooms: [],
    historyTrendScope: null,
    historyTrendFocusPending: false,
    historyCompare: null,
    historyCompareSource: "previous",
    historyCompareEntry: "previous",
    historyCompareLoading: false,
    historyCompareRequestSeq: 0,
    historyCompareScrollTop: 0,
    historyMultiCompareData: null,
    historyMultiCompareLoading: false,
    historyMultiCompareError: "",
    historyMultiCompareSeq: 0,
    historyMultiCompareScrollTop: 0,
    historyMultiCompareFocusPending: false,
    historyInsightData: null,
    historyInsightLoading: false,
    historyInsightError: "",
    historyInsightTargetId: "",
    historyInsightSeq: 0,
    historyInsightFocusPending: false,
    historyAnalysisExportSeq: 0,
    historyBaselineOpen: false,
    historyBaselineLoading: false,
    historyBaselineLoadingMore: false,
    historyBaselineSessions: [],
    historyBaselineTotal: 0,
    historyBaselineHasMore: false,
    historyBaselineError: "",
    historyBaselineCursor: null,
    historyBaselineSelectedId: "",
    historyBaselineSelectedIds: [],
    historyBaselineMulti: false,
    historyBaselineLastFocus: null,
    historyBaselineSeq: 0,
    session: {
      roomId: null,
      backendId: null,
      startedAt: null,
      observedAt: null,
      real: newMetrics(),
      mock: newMetrics()
    }
  };

  var els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function safeText(node, value) {
    if (!node) return;
    var text = String(value == null ? "" : value);
    if (node.textContent !== text) node.textContent = text;
  }

  function clamp(value, min, max, fallback) {
    var number = Number(value);
    if (!isFinite(number)) number = fallback;
    return Math.max(min, Math.min(max, number));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char];
    });
  }

  function formatDateTime(seconds) {
    var ts = Number(seconds);
    if (!isFinite(ts) || ts <= 0) return "—";
    var date = new Date(ts * 1000);
    if (isNaN(date.getTime())) return "—";
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
      pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function formatDuration(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(hours) + ":" + pad(minutes) + ":" + pad(secs);
  }

  function typeColor(key) {
    var meta = TYPE_META.find(function (item) { return item.key === key; });
    return meta ? meta.color : "var(--muted)";
  }

  function historyEndLabel(reason) {
    if (reason === "stale" || reason === "interrupted") return "中断";
    if (reason === "connect_failed") return "连接失败";
    if (reason === "replaced") return "切换场次";
    if (reason === "shutdown") return "程序关闭";
    if (reason === "manual_disconnect") return "手动断开";
    if (!reason || reason === "finished") return "正常结束";
    return "其他结束";
  }

  function historyFormatRate(value) {
    return value == null || !isFinite(value) ? "—" : Number(value).toFixed(1);
  }

  function historyFormatPercent(value) {
    return value == null || !isFinite(value) ? "—" : Number(value).toFixed(1) + "%";
  }

  function historyRoomLabel(session) {
    if (!session) return "—";
    return session.room_title || session.room_key || session.room_id || "—";
  }

  function historyQueryKey() {
    return [
      String(state.historyQuery || "").trim().toLowerCase(),
      state.historyRange || "all",
      state.historyPlatform || "",
      state.historyFromValue || "",
      state.historyToValue || ""
    ].join("|");
  }

  function platformCapability(value) {
    var key = String(value || "").toLowerCase();
    var fallback = {
      key: key,
      label: key === "bilibili" ? "B站" : (key === "douyin" ? "抖音" : (key || "未知平台")),
      money_comparable: key === "bilibili",
      gift_value_unit: key === "douyin" ? "diamond" : "CNY",
      supports_super_chat: key !== "douyin",
      supports_guard: key !== "douyin",
      money_note: key === "douyin"
        ? "抖音礼物按单条钻石显示，不汇总人民币；平台未提供 SC/舰长等价能力"
        : "金额口径未接入"
    };
    var profiles = state.snapshot && state.snapshot.history &&
      state.snapshot.history.capabilities &&
      state.snapshot.history.capabilities.platforms;
    if (Array.isArray(profiles)) {
      var profile = profiles.find(function (item) {
        return String(item && item.key || "").toLowerCase() === key;
      });
      if (profile) return Object.assign(fallback, profile);
    }
    return fallback;
  }

  function platformLabel(value) {
    var profile = platformCapability(value);
    return String(profile.label || "未知平台");
  }

  function platformMoneyComparable(value) {
    return !!platformCapability(value).money_comparable;
  }

  var ctx = {
    state: state,
    els: els,
    constants: { TYPE_META: TYPE_META },
    factories: { newMetrics: newMetrics },
    helpers: { $: $, safeText: safeText, clamp: clamp, escapeHtml: escapeHtml, formatDateTime: formatDateTime, formatDuration: formatDuration, typeColor: typeColor },
    shared: {
      historyEndLabel: historyEndLabel,
      historyFormatRate: historyFormatRate,
      historyFormatPercent: historyFormatPercent,
      historyRoomLabel: historyRoomLabel,
      historyQueryKey: historyQueryKey,
      platformCapability: platformCapability,
      platformLabel: platformLabel,
      platformMoneyComparable: platformMoneyComparable
    },
    root: {},
    modules: {}
  };

  Object.defineProperty(ctx, "api", {
    get: function () { return window.MutaiWorkspace || {}; }
  });

  ctx.register = function (name, factory) {
    if (ctx.modules[name]) throw new Error("shell module already registered: " + name);
    ctx.modules[name] = factory(ctx);
  };

  window.MutaiShell = ctx;
})();
