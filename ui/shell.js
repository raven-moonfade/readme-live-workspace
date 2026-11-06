/* ============================================================
   ReadMe · 工作台壳层
   只负责视图切换、实时摘要与真实动作；业务节点仍由 app-core.js 持有
   ============================================================ */
(function () {
  "use strict";
  var ctx = window.MutaiShell;
  var state = ctx.state;
  var els = ctx.els;
  var newMetrics = ctx.factories.newMetrics;
  var TYPE_META = ctx.constants.TYPE_META;
  var $ = ctx.helpers.$;
  var safeText = ctx.helpers.safeText;
  var clamp = ctx.helpers.clamp;
  var escapeHtml = ctx.helpers.escapeHtml;
  var formatDateTime = ctx.helpers.formatDateTime;
  var formatDuration = ctx.helpers.formatDuration;
  var typeColor = ctx.helpers.typeColor;
  var historyEndLabel = ctx.shared.historyEndLabel;
  var historyFormatRate = ctx.shared.historyFormatRate;
  var historyFormatPercent = ctx.shared.historyFormatPercent;
  var historyRoomLabel = ctx.shared.historyRoomLabel;
  var historyQueryKey = ctx.shared.historyQueryKey;
  var platformCapability = ctx.shared.platformCapability;
  var platformLabel = ctx.shared.platformLabel;
  var platformMoneyComparable = ctx.shared.platformMoneyComparable;


  var VIEW_KEY = "mutai-workspace-view-v1";
  var DATA_TAB_KEY = "mutai-data-tab-v1";
  var VIEWS = ["danmaku", "picture", "data", "settings"];
  var VIEW_TITLE = {
    danmaku: "弹幕",
    picture: "弹幕工作台",
    data: "数据",
    settings: "设置"
  };







  var pollTimer = 0;
  var toastTimer = 0;
  var dataRenderTimer = 0;







  function saveView(name) {
    try {
      localStorage.setItem(VIEW_KEY, name);
    } catch (e) {}
  }

  function loadView() {
    try {
      var saved = localStorage.getItem(VIEW_KEY);
      return VIEWS.indexOf(saved) >= 0 ? saved : "danmaku";
    } catch (e) {
      return "danmaku";
    }
  }

  function saveDataTab(name) {
    try {
      localStorage.setItem(DATA_TAB_KEY, name);
    } catch (e) {}
  }

  function loadDataTab() {
    try {
      return localStorage.getItem(DATA_TAB_KEY) === "history" ? "history" : "live";
    } catch (e) {
      return "live";
    }
  }

  function cache() {
    els.rail = document.querySelector(".rail");
    els.railSession = document.querySelector(".rail-session");
    els.railState = $("railSessionState");
    els.railQueue = $("railQueueText");

    els.wsLiveState = $("wsLiveState");
    els.wsRoomTitle = $("wsRoomTitle");
    els.wsRoomMeta = $("wsRoomMeta");
    els.wsReceived = $("wsReceived");
    els.wsSpoken = $("wsSpoken");
    els.wsDropped = $("wsDropped");
    els.wsQueue = $("wsQueue");
    els.wsHeroClock = $("wsHeroClock");
    els.wsHeroHint = $("wsHeroHint");
    els.liveHero = document.querySelector(".live-hero");
    els.wsNowState = $("wsNowState");
    els.wsNowUser = $("wsNowUser");
    els.wsNowText = $("wsNowText");
    els.wsTopOverlayToggle = $("wsTopOverlayToggle");
    els.wsWorkbenchOverlayState = $("wsWorkbenchOverlayState");

    els.overlayBadge = $("wsOverlayBadge");
    els.overlaySize = $("wsOverlaySize");
    els.overlayPosition = $("wsOverlayPosition");
    els.overlayScale = $("wsOverlayScale");
    els.overlayInteraction = $("wsOverlayInteraction");
    els.overlayToggle = $("wsOverlayToggle");
    els.monitorTheme = $("wsMonitorTheme");

    els.dataMode = $("wsDataMode");
    els.dataReceived = $("wsDataReceived");
    els.dataSpoken = $("wsDataSpoken");
    els.dataDropped = $("wsDataDropped");
    els.dataFiltered = $("wsDataFiltered");
    els.dataQueue = $("wsDataQueue");
    els.pulseState = $("wsPulseState");
    els.dataRecent = $("wsDataRecent");
    els.dataRecentLabel = $("wsRecentLabel");
    els.dataRecentHint = $("wsDataRecentHint");
    els.pulseSpark = $("wsPulseSpark");
    els.dataDropRate = $("wsDataDropRate");
    els.dataDropRateHint = $("wsDropRateHint");
    els.dataLastAge = $("wsDataLastAge");
    els.dataLastAgeHint = $("wsLastAgeHint");
    els.dataRate = $("wsDataRate");
    els.dataRateHint = $("wsDataRateHint");
    els.dataPeak = $("wsDataPeak");
    els.dataPeakHint = $("wsDataPeakHint");
    els.dataCoverage = $("wsDataCoverage");
    els.dataCoverageHint = $("wsDataCoverageHint");
    els.dataAvgRate = $("wsDataAvgRate");
    els.dataSpokenRate = $("wsDataSpokenRate");
    els.dataUsersAvg = $("wsDataUsersAvg");
    els.dataRevenueLabel = $("wsDataRevenueLabel");
    els.dataRevenue = $("wsDataRevenue");
    els.dataRevenueGiftLabel = $("wsDataRevenueGiftLabel");
    els.dataRevenueGift = $("wsDataRevenueGift");
    els.dataRevenueScLabel = $("wsDataRevenueScLabel");
    els.dataRevenueSc = $("wsDataRevenueSc");
    els.dataDurationHint = $("wsDataDurationHint");
    els.dataNotices = $("wsDataNotices");
    els.dataPostlude = $("wsDataPostlude");
    els.dataPostludeText = $("wsDataPostludeText");
    els.dataPostludeStatus = $("wsDataPostludeStatus");
    els.dataOpenHistory = $("wsDataOpenHistory");
    els.dataComparePrevious = $("wsDataComparePrevious");
    els.dataDuration = $("wsDataDuration");
    els.activityRecent = $("wsActivityRecent");
    els.activityAverage = $("wsActivityAverage");
    els.activityPeak = $("wsActivityPeak");
    els.typeSegments = $("wsTypeSegments");
    els.typeTotal = $("wsTypeTotal");
    els.typeNote = $("wsTypeNote");
    els.typeBars = $("wsTypeBars");
    els.activityChart = $("wsActivityChart");
    els.activityTotal = $("wsActivityTotal");
    els.dataEmpty = $("wsDataEmpty");
    els.dataRoom = $("wsDataRoom");
    els.dataStarted = $("wsDataStarted");
    els.dataLastEvent = $("wsDataLastEvent");
    els.dataConnection = $("wsDataConnection");
    els.dataUsers = $("wsDataUsers");
    els.dataGiftValue = $("wsDataGiftValue");
    els.dataScValue = $("wsDataScValue");
    els.dataSaveState = $("wsDataSaveState");
    els.sourceSummary = $("wsSourceSummary");
    els.sourceRoomTime = $("wsSourceRoomTime");
    els.sourceRoomState = $("wsSourceRoomState");
    els.sourceStreamTime = $("wsSourceStreamTime");
    els.sourceStreamState = $("wsSourceStreamState");
    els.sourceProcessTime = $("wsSourceProcessTime");
    els.sourceProcessState = $("wsSourceProcessState");
    els.sourceHistoryTime = $("wsSourceHistoryTime");
    els.sourceHistoryState = $("wsSourceHistoryState");
    els.dataLivePanel = $("dataLivePanel");
    els.dataHistoryPanel = $("dataHistoryPanel");
    els.dataTabs = Array.prototype.slice.call(document.querySelectorAll("[data-data-tab]"));
    els.historyCount = $("wsHistoryCount");
    els.historyReload = $("wsHistoryReload");
    els.historySearch = $("wsHistorySearch");
    els.historyRange = $("wsHistoryRange");
    els.historyPlatform = $("wsHistoryPlatform");
    els.historyFilterReset = $("wsHistoryFilterReset");
    els.historyCustomRange = $("wsHistoryCustomRange");
    els.historyFrom = $("wsHistoryFrom");
    els.historyTo = $("wsHistoryTo");
    els.historyCustomApply = $("wsHistoryCustomApply");
    els.historyManage = $("wsHistoryManage");
    els.historyManageModal = $("historyManageModal");
    els.historyManageFacts = $("wsHistoryManageFacts");
    els.historyKeepDays = $("wsHistoryKeepDays");
    els.historyPrunePreview = $("wsHistoryPrunePreview");
    els.historyPruneConfirm = $("wsHistoryPruneConfirm");
    els.historyPrunePreviewBtn = $("wsHistoryPrunePreviewBtn");
    els.historyPruneBtn = $("wsHistoryPruneBtn");
    els.historyManageClose = $("wsHistoryManageClose");
    els.historyAutoToggle = $("wsHistoryAutoToggle");
    els.historyAutoDays = $("wsHistoryAutoDays");
    els.historyAutoSave = $("wsHistoryAutoSave");
    els.historyAutoStatus = $("wsHistoryAutoStatus");
    els.exportManage = $("wsExportManageBtn");
    els.exportManageModal = $("exportManageModal");
    els.exportManageClose = $("wsExportManageClose");
    els.exportManageDirectory = $("wsExportManageDirectory");
    els.exportOpenDir = $("wsExportOpenDir");
    els.exportStats = $("wsExportStats");
    els.exportKeepDays = $("wsExportKeepDays");
    els.exportWeek = $("wsExportWeek");
    els.exportKeepLatest = $("wsExportKeepLatest");
    els.exportPreview = $("wsExportPreview");
    els.exportSamples = $("wsExportSamples");
    els.exportPreviewBtn = $("wsExportPreviewBtn");
    els.exportPruneConfirm = $("wsExportPruneConfirm");
    els.exportPruneBtn = $("wsExportPruneBtn");
    els.historyList = $("wsHistoryList");
    els.historyMore = $("wsHistoryMore");
    els.historyTrendBtn = $("wsHistoryTrendBtn");
    els.historySummary = $("wsHistorySummary");
    els.historyEmpty = $("wsHistoryEmpty");
    els.historyError = $("wsHistoryError");
    els.historyErrorText = $("wsHistoryErrorText");
    els.historyLayout = $("wsHistoryLayout");
    els.historyNoSelection = $("wsHistoryNoSelection");
    els.historyDetail = $("wsHistoryDetail");
    els.historyDetailPane = $("wsHistoryDetailPane");
    els.historyBaselineModal = $("historyBaselineModal");
    els.historyBaselineTitle = $("historyBaselineTitle");
    els.historyBaselineClose = $("wsHistoryBaselineClose");
    els.historyBaselineApply = $("wsHistoryBaselineApply");
    els.historyBaselineScope = $("wsHistoryBaselineScope");
    els.historyBaselineCurrent = $("wsHistoryBaselineCurrent");
    els.historyBaselineModeTabs = $("historyBaselineModeTabs");
    els.historyBaselineChips = $("wsHistoryBaselineChips");
    els.historyBaselineRecent = $("wsHistoryBaselineRecent");
    els.historyBaselineCount = $("wsHistoryBaselineCount");
    els.historyBaselineList = $("wsHistoryBaselineList");
    els.historyBaselineMore = $("wsHistoryBaselineMore");
    els.historyBaselineStatus = $("wsHistoryBaselineStatus");
    els.settingsAccount = $("settingsAccountState");
    els.settingsAccountTitle = $("settingsAccountTitle");
    els.settingsCredentialSecurity = $("settingsCredentialSecurity");
    els.settingsHost = $("settingsControlsHost");
    els.settingsNav = document.querySelector(".settings-nav");
    els.settingsLayout = document.querySelector(".settings-layout");
  }

  function moveSettingsSource() {
    var source = document.querySelector("[data-settings-source]");
    if (!source || !els.settingsHost || source.parentNode === els.settingsHost) return;
    els.settingsHost.appendChild(source);
    source.hidden = false;
    source.removeAttribute("data-settings-source");
  }

  function setView(name, options) {
    var next = VIEWS.indexOf(name) >= 0 ? name : "danmaku";
    if (next !== "data") invalidateHistoryComparison();
    var opts = options && typeof options === "object" ? options : {};
    state.view = next;
    saveView(next);

    document.querySelectorAll("[data-workspace-view]").forEach(function (button) {
      var active = button.getAttribute("data-workspace-view") === next;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });

    document.querySelectorAll("[data-workspace-panel]").forEach(function (panel) {
      var active = panel.getAttribute("data-workspace-panel") === next;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
      if (active) panel.removeAttribute("inert");
      else panel.setAttribute("inert", "");
    });

    document.title = "ReadMe · " + (VIEW_TITLE[next] || "工作台");
    document.dispatchEvent(new CustomEvent("mutai:viewchange", {
      detail: { view: next }
    }));

    if (next === "data") {
      renderData();
      setDataTab(state.dataTab, { load: true });
    }
    if (next === "picture") renderPicture();
    if (next === "settings") {
      renderCredentialSecurity();
      refreshCredentialSecurity(false);
    }
    if (!opts.focus) return;
    var activeButton = document.querySelector('[data-workspace-view="' + next + '"]');
    if (activeButton && typeof activeButton.focus === "function") activeButton.focus();
  }









  function historyNumber(value) {
    var number = Number(value);
    return isFinite(number) ? number : 0;
  }

  function historyDurationOf(session) {
    return Math.max(0, historyNumber(session && session.ended_at) - historyNumber(session && session.started_at));
  }

  function historyPerHour(value, duration) {
    var hours = Number(duration) / 3600;
    return hours > 0 ? historyNumber(value) / hours : null;
  }

  function historyRatio(value, total) {
    var base = historyNumber(total);
    return base > 0 ? historyNumber(value) / base : null;
  }





  function historyFormatDelta(value, digits, suffix) {
    if (value == null || !isFinite(value)) return "—";
    var rounded = Number(value).toFixed(digits);
    return (value > 0 ? "+" : "") + rounded + (suffix || "");
  }

  function historyTypeTotal(session) {
    var types = session && session.types && typeof session.types === "object" ? session.types : {};
    return TYPE_META.reduce(function (sum, meta) {
      return sum + historyNumber(types[meta.key]);
    }, 0);
  }

  function historyMinutesTotal(session) {
    var minutes = session && Array.isArray(session.minutes) ? session.minutes : [];
    return minutes.reduce(function (sum, item) {
      return sum + historyNumber(item.count);
    }, 0);
  }

  function historyPeakFiveMinute(session) {
    var minutes = session && Array.isArray(session.minutes) ? session.minutes : [];
    var started = historyNumber(session && session.started_at);
    var ended = historyNumber(session && (session.ended_at || session.started_at));
    if (!minutes.length || started <= 0 || ended <= started || ended - started < 300) {
      return null;
    }
    var startMinute = Math.floor(started / 60);
    var endMinute = Math.max(startMinute + 1, Math.ceil(ended / 60));
    var durationMinutes = endMinute - startMinute;
    if (durationMinutes < 5) return null;
    var values = new Map();
    minutes.forEach(function (item) {
      values.set(historyNumber(item.minute), historyNumber(item.count));
    });
    var peak = 0;
    for (var offset = 0; offset <= durationMinutes - 5; offset += 1) {
      var sum = 0;
      for (var index = 0; index < 5; index += 1) {
        sum += values.get(startMinute + offset + index) || 0;
      }
      peak = Math.max(peak, sum);
    }
    return peak;
  }

  function historyGiftText(session) {
    var profile = platformCapability(session && session.platform);
    if (!profile.money_comparable) {
      return profile.gift_value_unit === "diamond"
        ? "仅单条钻石 · 不汇总"
        : "口径未接入";
    }
    var parts = [];
    if (historyNumber(session && session.gift_cny) > 0) parts.push(formatMoney(session.gift_cny));
    if (historyNumber(session && session.gift_silver) > 0) parts.push("银瓜子 " + historyNumber(session.gift_silver));
    if (historyNumber(session && session.gift_unknown) > 0) parts.push("瓜子 " + historyNumber(session.gift_unknown));
    return parts.length ? parts.join(" · ") : "¥0.00";
  }

  function historyMoneyView(session) {
    var profile = platformCapability(session && session.platform);
    var moneyComparable = !!profile.money_comparable;
    return {
      giftLabel: profile.gift_value_unit === "diamond" ? "礼物价值" : "礼物金额",
      giftText: historyGiftText(session),
      scLabel: profile.supports_super_chat ? "SC 金额" : "SC / 舰长",
      scText: moneyComparable
        ? formatMoney(session && session.super_chat_cny)
        : (profile.supports_super_chat ? "未接入" : "平台未提供"),
      note: moneyComparable ? "" : (profile.money_note || "该平台金额口径不可比。")
    };
  }

  function historySessionMetrics(session) {
    var duration = historyDurationOf(session);
    var received = historyNumber(session && session.real_received);
    var spoken = historyNumber(session && session.real_spoken);
    var dropped = historyNumber(session && session.real_dropped);
    return {
      session: session,
      duration: duration,
      received: received,
      spoken: spoken,
      dropped: dropped,
      users: historyNumber(session && session.unique_users),
      receivedPerHour: historyPerHour(received, duration),
      spokenPerHour: historyPerHour(spoken, duration),
      usersPerHour: historyPerHour(historyNumber(session && session.unique_users), duration),
      spokenRate: historyRatio(spoken, received),
      droppedRate: historyRatio(dropped, received),
      peak5m: historyPeakFiveMinute(session),
      typedTotal: historyTypeTotal(session),
      minutesTotal: historyMinutesTotal(session)
    };
  }

  function historyComparisonModel() { return ctx.modules.compare.historyComparisonModel.apply(this, arguments); }



  function historyRangeLabel(value) {
    return ({
      today: "今天",
      "7d": "近 7 天",
      "30d": "近 30 天",
      "90d": "近 90 天",
      "365d": "近 365 天",
      custom: "自定义日期"
    })[value] || "全部时间";
  }







  function historyArbitraryCompareSupported() {
    var caps = state.snapshot && state.snapshot.history &&
      state.snapshot.history.capabilities;
    var api = ctx.api;
    return !!(caps && Number(caps.arbitrary_compare || 0) >= 1 &&
      els.historyBaselineModal && els.historyBaselineList &&
      els.historyBaselineClose && els.historyBaselineApply &&
      typeof api.listBaselines === "function" &&
      typeof api.compareSessions === "function");
  }

  function historyMultiCompareSupported() {
    var caps = state.snapshot && state.snapshot.history &&
      state.snapshot.history.capabilities;
    var api = ctx.api;
    return !!(caps && Number(caps.multi_compare || 0) >= 1 &&
      historyArbitraryCompareSupported() &&
      els.historyBaselineModeTabs &&
      typeof api.compareMultiSessions === "function");
  }

  function invalidateHistoryComparison() {
    state.historyCompareRequestSeq += 1;
    state.historyCompareLoading = false;
    state.historyCompare = null;
    state.historyCompareSource = "previous";
    state.historyCompareEntry = "previous";
    state.historyMultiCompareSeq += 1;
    state.historyMultiCompareLoading = false;
    state.historyMultiCompareData = null;
    state.historyMultiCompareError = "";
    if (state.historyBaselineOpen) {
      closeHistoryBaselinePicker({ restoreFocus: false });
    }
    invalidateHistoryInsights();
  }

  function historyInsightsSupported() {
    var caps = state.snapshot && state.snapshot.history &&
      state.snapshot.history.capabilities;
    var api = ctx.api;
    return !!(caps && Number(caps.insights || 0) >= 1 &&
      typeof api.sessionInsights === "function");
  }

  function invalidateHistoryInsights() {
    state.historyInsightSeq += 1;
    state.historyInsightData = null;
    state.historyInsightLoading = false;
    state.historyInsightError = "";
    state.historyInsightTargetId = "";
    state.historyInsightFocusPending = false;
  }

  function historyLocalMidnight(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000;
  }

  function historyParseDate(value) {
    var text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    var parts = text.split("-").map(Number);
    var date = new Date(parts[0], parts[1] - 1, parts[2]);
    if (isNaN(date.getTime()) ||
        date.getFullYear() !== parts[0] ||
        date.getMonth() !== parts[1] - 1 ||
        date.getDate() !== parts[2]) {
      return null;
    }
    return date;
  }

  function historyRangeBounds() {
    var range = state.historyRange || "all";
    if (range === "all") return { from: null, to: null };
    var now = new Date();
    var days = { today: 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365 }[range];
    if (days) {
      return {
        from: historyLocalMidnight(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))),
        to: historyLocalMidnight(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
      };
    }
    if (range === "custom") {
      var fromDate = historyParseDate(state.historyFromValue);
      var toDate = historyParseDate(state.historyToValue);
      if (!fromDate && !toDate) {
        return { error: "请选择至少一个日期" };
      }
      var from = fromDate ? historyLocalMidnight(fromDate) : null;
      var to = toDate
        ? historyLocalMidnight(new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1))
        : null;
      if (from != null && to != null && from >= to) {
        return { error: "开始日期必须早于结束日期" };
      }
      return { from: from, to: to };
    }
    return { from: null, to: null };
  }





  function historyFilterActive() {
    var rangeActive = state.historyRange !== "all" &&
      !(state.historyMode === "trend" && state.historyRange === "365d");
    return !!String(state.historyQuery || "").trim() ||
      rangeActive ||
      !!state.historyPlatform;
  }

  function syncHistoryFilterUi() { return ctx.modules.history.syncHistoryFilterUi.apply(this, arguments); }

  function syncHistoryPlatformOptions() {
    if (!els.historyPlatform) return;
    var platforms = Array.isArray(state.historyPlatforms) ? state.historyPlatforms : [];
    var options = ['<option value="">全部平台</option>'];
    platforms.forEach(function (item) {
      var key = String(item.platform || "");
      if (!key) return;
      options.push('<option value="' + escapeHtml(key) + '">' +
        escapeHtml(platformLabel(key)) + ' · ' + escapeHtml(item.count || 0) + '</option>');
    });
    els.historyPlatform.innerHTML = options.join("");
    if (platforms.length < 2) {
      var selectedPlatformKnown = !platforms.length || platforms.some(function (item) {
        return String(item.platform || "") === String(state.historyPlatform || "");
      });
      if (!selectedPlatformKnown) state.historyPlatform = "";
      els.historyPlatform.hidden = true;
    } else {
      els.historyPlatform.hidden = false;
    }
    els.historyPlatform.value = state.historyPlatform;
  }

  function historyRequestOptions() {
    var bounds = historyRangeBounds();
    if (bounds.error) return { error: bounds.error };
    return {
      query: String(state.historyQuery || "").trim(),
      started_from: bounds.from,
      started_to: bounds.to,
      platform: state.historyPlatform || null
    };
  }

  function applyHistoryFilters() { return ctx.modules.history.applyHistoryFilters.apply(this, arguments); }

  function clearHistoryFilters() { return ctx.modules.history.clearHistoryFilters.apply(this, arguments); }

  function setHistoryPrunePreview() { return ctx.modules.history.setHistoryPrunePreview.apply(this, arguments); }

  function historyManagePruneReady() { return ctx.modules.history.historyManagePruneReady.apply(this, arguments); }

  function updateHistoryManageButtons() { return ctx.modules.history.updateHistoryManageButtons.apply(this, arguments); }

  function openHistoryManage() { return ctx.modules.history.openHistoryManage.apply(this, arguments); }

  function closeHistoryManage() { return ctx.modules.history.closeHistoryManage.apply(this, arguments); }

  function setHistoryAutoStatus() { return ctx.modules.history.setHistoryAutoStatus.apply(this, arguments); }

  function updateHistoryAutoUi() { return ctx.modules.history.updateHistoryAutoUi.apply(this, arguments); }

  function loadHistoryAutoSettings() { return ctx.modules.history.loadHistoryAutoSettings.apply(this, arguments); }

  function saveHistoryAutoSettings() { return ctx.modules.history.saveHistoryAutoSettings.apply(this, arguments); }

  function exportManageSupported() { return ctx.modules.compare.exportManageSupported.apply(this, arguments); }

  function exportManageLinkHtml() { return ctx.modules.compare.exportManageLinkHtml.apply(this, arguments); }

  function syncExportManageEntry() { return ctx.modules.compare.syncExportManageEntry.apply(this, arguments); }

  function setExportStatus() { return ctx.modules.compare.setExportStatus.apply(this, arguments); }

  function renderExportStats() { return ctx.modules.compare.renderExportStats.apply(this, arguments); }

  function renderExportPreview() { return ctx.modules.compare.renderExportPreview.apply(this, arguments); }

  function updateExportManageButtons() { return ctx.modules.compare.updateExportManageButtons.apply(this, arguments); }

  function loadExportStatus() { return ctx.modules.compare.loadExportStatus.apply(this, arguments); }

  function previewExportFiles() { return ctx.modules.compare.previewExportFiles.apply(this, arguments); }

  function openExportManage() { return ctx.modules.compare.openExportManage.apply(this, arguments); }

  function closeExportManage() { return ctx.modules.compare.closeExportManage.apply(this, arguments); }

  function executeExportPrune() { return ctx.modules.compare.executeExportPrune.apply(this, arguments); }

  function openExportDirectory() { return ctx.modules.compare.openExportDirectory.apply(this, arguments); }

  function previewHistoryPrune() { return ctx.modules.history.previewHistoryPrune.apply(this, arguments); }

  function executeHistoryPrune() { return ctx.modules.history.executeHistoryPrune.apply(this, arguments); }

  function historyTrendBounds() { return ctx.modules.history.historyTrendBounds.apply(this, arguments); }

  function historyTrendMetricLabel() { return ctx.modules.history.historyTrendMetricLabel.apply(this, arguments); }

  function historyTrendGranularityLabel() { return ctx.modules.history.historyTrendGranularityLabel.apply(this, arguments); }

  function historyTrendGranularitySupported() { return ctx.modules.history.historyTrendGranularitySupported.apply(this, arguments); }

  function renderHistoryTrendGranularityToggle() { return ctx.modules.history.renderHistoryTrendGranularityToggle.apply(this, arguments); }

  function historyTrendBucketLabel() { return ctx.modules.history.historyTrendBucketLabel.apply(this, arguments); }

  function historyTrendBucketShortLabel() { return ctx.modules.history.historyTrendBucketShortLabel.apply(this, arguments); }

  function historyTrendBucketTooltip() { return ctx.modules.history.historyTrendBucketTooltip.apply(this, arguments); }

  function historyTrendMetricValue() { return ctx.modules.history.historyTrendMetricValue.apply(this, arguments); }

  function historyTrendValueText() { return ctx.modules.history.historyTrendValueText.apply(this, arguments); }

  function renderHistoryTrendChart() { return ctx.modules.history.renderHistoryTrendChart.apply(this, arguments); }

  function renderHistoryTrendRoomPicker() { return ctx.modules.history.renderHistoryTrendRoomPicker.apply(this, arguments); }

  function renderHistoryTrendScopeRequired() { return ctx.modules.history.renderHistoryTrendScopeRequired.apply(this, arguments); }

  function renderHistoryTrend() { return ctx.modules.history.renderHistoryTrend.apply(this, arguments); }

  function renderHistoryTrendMessage() { return ctx.modules.history.renderHistoryTrendMessage.apply(this, arguments); }

  function focusHistoryTrendTarget() { return ctx.modules.history.focusHistoryTrendTarget.apply(this, arguments); }

  function setHistoryTrendGranularity() { return ctx.modules.history.setHistoryTrendGranularity.apply(this, arguments); }

  function loadHistoryTrend() { return ctx.modules.history.loadHistoryTrend.apply(this, arguments); }

  function openHistoryTrend() { return ctx.modules.history.openHistoryTrend.apply(this, arguments); }

  function selectHistoryTrendRoom() { return ctx.modules.history.selectHistoryTrendRoom.apply(this, arguments); }

  function selectHistoryTrendRoomByIndex() { return ctx.modules.history.selectHistoryTrendRoomByIndex.apply(this, arguments); }

  function closeHistoryTrend() { return ctx.modules.history.closeHistoryTrend.apply(this, arguments); }

  function setDataTab(name, options) {
    var next = name === "history" ? "history" : "live";
    var previousTab = state.dataTab;
    if (previousTab === "history" && next !== "history") {
      invalidateHistoryComparison();
    }
    var opts = options && typeof options === "object" ? options : {};
    state.dataTab = next;
    if (next !== "history") {
      state.historyPreserveDetailId = "";
      state.historyRestoreId = "";
    }
    saveDataTab(next);
    if (els.dataTabs) {
      els.dataTabs.forEach(function (button) {
        var active = button.getAttribute("data-data-tab") === next;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
      });
    }
    if (els.dataLivePanel) els.dataLivePanel.hidden = next !== "live";
    if (els.dataHistoryPanel) els.dataHistoryPanel.hidden = next !== "history";
    if (els.dataMode) els.dataMode.hidden = next === "history";
    if (next === "history" && opts.load &&
        (!state.historyLoaded ||
         state.historyLoadedKey !== historyQueryKey() ||
         Date.now() - state.historyLoadedAt > 3000)) {
      loadHistory(false);
    }
  }

  function showHistoryEmpty() { return ctx.modules.history.showHistoryEmpty.apply(this, arguments); }

  function showHistoryError() { return ctx.modules.history.showHistoryError.apply(this, arguments); }

  function renderHistoryList() { return ctx.modules.history.renderHistoryList.apply(this, arguments); }

  function loadHistory() { return ctx.modules.history.loadHistory.apply(this, arguments); }

  function selectHistorySession() { return ctx.modules.history.selectHistorySession.apply(this, arguments); }

  function openHistorySession() { return ctx.modules.history.openHistorySession.apply(this, arguments); }

  function setPostludeStatus() { return ctx.modules.history.setPostludeStatus.apply(this, arguments); }

  function resetPostludeExportButtons() { return ctx.modules.history.resetPostludeExportButtons.apply(this, arguments); }

  function exportPostludeSession() { return ctx.modules.history.exportPostludeSession.apply(this, arguments); }

  function showHistoryDetailError() { return ctx.modules.history.showHistoryDetailError.apply(this, arguments); }

  function focusHistoryDetail() { return ctx.modules.history.focusHistoryDetail.apply(this, arguments); }

  function resetHistoryDetail() { return ctx.modules.history.resetHistoryDetail.apply(this, arguments); }

  function renderHistoryDetail() { return ctx.modules.history.renderHistoryDetail.apply(this, arguments); }

  function historyInsightFlagLabel() { return ctx.modules.history.historyInsightFlagLabel.apply(this, arguments); }

  function historyInsightReasonText() { return ctx.modules.history.historyInsightReasonText.apply(this, arguments); }

  function historyInsightPeakReason() { return ctx.modules.history.historyInsightPeakReason.apply(this, arguments); }

  function renderHistoryInsight() { return ctx.modules.history.renderHistoryInsight.apply(this, arguments); }

  function loadHistoryInsights() { return ctx.modules.history.loadHistoryInsights.apply(this, arguments); }

  function setHistoryCompareStatus() { return ctx.modules.compare.setHistoryCompareStatus.apply(this, arguments); }

  function historyCompareErrorMessage() { return ctx.modules.compare.historyCompareErrorMessage.apply(this, arguments); }

  function historyCompareHealthWarning() { return ctx.modules.compare.historyCompareHealthWarning.apply(this, arguments); }

  function historyBaselineRelationLabel() { return ctx.modules.compare.historyBaselineRelationLabel.apply(this, arguments); }

  function setHistoryBaselineStatus() { return ctx.modules.compare.setHistoryBaselineStatus.apply(this, arguments); }

  function renderHistoryBaselineCurrent() { return ctx.modules.compare.renderHistoryBaselineCurrent.apply(this, arguments); }

  function renderHistoryBaselineChips() { return ctx.modules.compare.renderHistoryBaselineChips.apply(this, arguments); }

  function updateHistoryBaselineModeUi() { return ctx.modules.compare.updateHistoryBaselineModeUi.apply(this, arguments); }

  function setHistoryBaselineMode() { return ctx.modules.compare.setHistoryBaselineMode.apply(this, arguments); }

  function updateHistoryBaselineApply() { return ctx.modules.compare.updateHistoryBaselineApply.apply(this, arguments); }

  function renderHistoryBaselineList() { return ctx.modules.compare.renderHistoryBaselineList.apply(this, arguments); }

  function syncHistoryBaselineOptions() { return ctx.modules.compare.syncHistoryBaselineOptions.apply(this, arguments); }

  function selectHistoryBaseline() { return ctx.modules.compare.selectHistoryBaseline.apply(this, arguments); }

  function selectRecentHistoryBaselines() { return ctx.modules.compare.selectRecentHistoryBaselines.apply(this, arguments); }

  function loadHistoryBaselines() { return ctx.modules.compare.loadHistoryBaselines.apply(this, arguments); }

  function openHistoryBaselinePicker() { return ctx.modules.compare.openHistoryBaselinePicker.apply(this, arguments); }

  function closeHistoryBaselinePicker() { return ctx.modules.compare.closeHistoryBaselinePicker.apply(this, arguments); }

  function openHistoryComparisonWithBaseline() { return ctx.modules.compare.openHistoryComparisonWithBaseline.apply(this, arguments); }

  function applyHistoryBaselineSelection() { return ctx.modules.compare.applyHistoryBaselineSelection.apply(this, arguments); }

  function openHistoryCompare() { return ctx.modules.compare.openHistoryCompare.apply(this, arguments); }

  function historyCompareRow() { return ctx.modules.compare.historyCompareRow.apply(this, arguments); }

  function renderHistoryCompare() { return ctx.modules.compare.renderHistoryCompare.apply(this, arguments); }

  function historyMultiValue() { return ctx.modules.compare.historyMultiValue.apply(this, arguments); }

  function historyMultiDelta() { return ctx.modules.compare.historyMultiDelta.apply(this, arguments); }

  function historyMultiSampleFlags() { return ctx.modules.compare.historyMultiSampleFlags.apply(this, arguments); }

  function historyMultiQualityFlags() { return ctx.modules.compare.historyMultiQualityFlags.apply(this, arguments); }

  function historyMultiContextCard() { return ctx.modules.compare.historyMultiContextCard.apply(this, arguments); }

  function historyMultiResponseValid() { return ctx.modules.compare.historyMultiResponseValid.apply(this, arguments); }

  function historyMultiEmpty() { return ctx.modules.compare.historyMultiEmpty.apply(this, arguments); }

  function renderHistoryMultiCompare() { return ctx.modules.compare.renderHistoryMultiCompare.apply(this, arguments); }

  function openHistoryMultiComparison() { return ctx.modules.compare.openHistoryMultiComparison.apply(this, arguments); }

  function returnHistoryOverview() { return ctx.modules.history.returnHistoryOverview.apply(this, arguments); }

  function exportHistorySession() { return ctx.modules.history.exportHistorySession.apply(this, arguments); }

  function historyAnalysisExportSupported() { return ctx.modules.compare.historyAnalysisExportSupported.apply(this, arguments); }

  function renderHistoryAnalysisExportActions() { return ctx.modules.compare.renderHistoryAnalysisExportActions.apply(this, arguments); }

  function historyAnalysisExportStatusNode() { return ctx.modules.compare.historyAnalysisExportStatusNode.apply(this, arguments); }

  function setHistoryAnalysisExportStatus() { return ctx.modules.compare.setHistoryAnalysisExportStatus.apply(this, arguments); }

  function historyAnalysisExportViewKey() { return ctx.modules.compare.historyAnalysisExportViewKey.apply(this, arguments); }

  function exportHistoryAnalysis() { return ctx.modules.compare.exportHistoryAnalysis.apply(this, arguments); }

  function closeHistoryDetail() { return ctx.modules.history.closeHistoryDetail.apply(this, arguments); }

  function bindDataUi() {
    if (!els.dataTabs.length) return;
    els.dataTabs.forEach(function (button) {
      button.addEventListener("click", function () {
        setDataTab(button.getAttribute("data-data-tab"), { load: true });
      });
      button.addEventListener("keydown", function (event) {
        var index = els.dataTabs.indexOf(button);
        var next = null;
        if (event.key === "ArrowRight") next = (index + 1) % els.dataTabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + els.dataTabs.length) % els.dataTabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = els.dataTabs.length - 1;
        if (next == null) return;
        event.preventDefault();
        var target = els.dataTabs[next];
        target.focus();
        setDataTab(target.getAttribute("data-data-tab"), { load: true });
      });
    });
    if (els.historyReload) {
      els.historyReload.addEventListener("click", function () {
        state.historyPreserveDetailId = "";
        loadHistory(true);
      });
    }
    if (els.dataOpenHistory) {
      els.dataOpenHistory.addEventListener("click", function () {
        openHistorySession(this.getAttribute("data-session-id") || "");
      });
    }
    if (els.dataComparePrevious) {
      els.dataComparePrevious.addEventListener("click", function () {
        openHistorySession(
          this.getAttribute("data-session-id") ||
            state.postludeExportSessionId,
          { compare: true }
        );
      });
    }
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-postlude-export]"),
      function (button) {
        button.addEventListener("click", function () {
          exportPostludeSession(
            button.getAttribute("data-postlude-export") || "json",
            button
          );
        });
      }
    );
    if (els.historyTrendBtn) {
      els.historyTrendBtn.addEventListener("click", function () {
        if (state.historyMode === "trend") {
          loadHistoryTrend(true);
          return;
        }
        openHistoryTrend();
      });
    }
    if (els.historyBaselineClose) {
      els.historyBaselineClose.addEventListener("click", function () {
        closeHistoryBaselinePicker();
      });
    }
    if (els.historyBaselineModeTabs) {
      els.historyBaselineModeTabs.addEventListener("click", function (event) {
        var button = event.target.closest
          ? event.target.closest("[data-baseline-mode]")
          : null;
        if (!button) return;
        var mode = button.getAttribute("data-baseline-mode");
        var alreadyActive = mode === "multi"
          ? state.historyBaselineMulti
          : !state.historyBaselineMulti;
        if (alreadyActive) {
          button.focus();
          return;
        }
        setHistoryBaselineMode(mode);
        requestAnimationFrame(function () {
          var active = els.historyBaselineModeTabs
            ? els.historyBaselineModeTabs.querySelector("[data-baseline-mode].is-active")
            : null;
          if (active) active.focus();
        });
      });
      els.historyBaselineModeTabs.addEventListener("keydown", function (event) {
        if (["ArrowRight", "ArrowLeft", "Home", "End"].indexOf(event.key) < 0) {
          return;
        }
        var buttons = Array.prototype.slice.call(
          els.historyBaselineModeTabs.querySelectorAll("[data-baseline-mode]")
        );
        if (!buttons.length) return;
        var currentIndex = buttons.indexOf(document.activeElement);
        var nextIndex = event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : event.key === "ArrowRight"
              ? (currentIndex + 1 + buttons.length) % buttons.length
              : (currentIndex - 1 + buttons.length) % buttons.length;
        var next = buttons[nextIndex];
        if (!next) return;
        event.preventDefault();
        next.focus();
        var mode = next.getAttribute("data-baseline-mode");
        var alreadyActive = mode === "multi"
          ? state.historyBaselineMulti
          : !state.historyBaselineMulti;
        if (!alreadyActive) setHistoryBaselineMode(mode);
        var active = els.historyBaselineModeTabs
          .querySelector("[data-baseline-mode].is-active");
        if (active) active.focus();
      });
    }
    if (els.historyBaselineChips) {
      els.historyBaselineChips.addEventListener("click", function (event) {
        var chip = event.target.closest
          ? event.target.closest("[data-remove-baseline]")
          : null;
        if (!chip) return;
        var chips = Array.prototype.slice.call(
          els.historyBaselineChips.querySelectorAll(".history-baseline-chip")
        );
        var chipIndex = chips.indexOf(chip);
        selectHistoryBaseline(chip.getAttribute("data-remove-baseline"));
        var remaining = Array.prototype.slice.call(
          els.historyBaselineChips.querySelectorAll(".history-baseline-chip")
        );
        var focusTarget = remaining.length
          ? remaining[Math.min(Math.max(chipIndex, 0), remaining.length - 1)]
          : (els.historyBaselineList
            ? els.historyBaselineList.querySelector("input:not([disabled])")
            : null);
        if (focusTarget && typeof focusTarget.focus === "function") {
          focusTarget.focus();
        }
      });
    }
    if (els.historyBaselineRecent) {
      els.historyBaselineRecent.addEventListener("click", function () {
        selectRecentHistoryBaselines();
      });
    }
    if (els.historyBaselineApply) {
      els.historyBaselineApply.addEventListener("click", applyHistoryBaselineSelection);
    }
    if (els.historyBaselineMore) {
      els.historyBaselineMore.addEventListener("click", function () {
        loadHistoryBaselines(true);
      });
    }
    if (els.historyBaselineList) {
      els.historyBaselineList.addEventListener("change", function (event) {
        var input = event.target;
        if (!input || (input.name !== "history-baseline" &&
            input.name !== "history-baseline-multi")) return;
        selectHistoryBaseline(input.value);
      });
    }
    if (els.historyBaselineModal) {
      els.historyBaselineModal.addEventListener("click", function (event) {
        if (event.target === els.historyBaselineModal) {
          closeHistoryBaselinePicker();
          return;
        }
        var retry = event.target.closest
          ? event.target.closest("[data-history-baseline-retry]")
          : null;
        if (retry) loadHistoryBaselines((state.historyBaselineSessions || []).length > 0);
      });
      els.historyBaselineModal.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeHistoryBaselinePicker();
          return;
        }
        if (event.key !== "Tab") return;
        var focusable = Array.prototype.slice.call(
          els.historyBaselineModal.querySelectorAll(
            "button:not([disabled]), input:not([disabled]), select:not([disabled])"
          )
        );
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }
    if (els.historyManage) {
      els.historyManage.addEventListener("click", openHistoryManage);
    }
    if (els.historyManageClose) {
      els.historyManageClose.addEventListener("click", closeHistoryManage);
    }
    if (els.exportManage) {
      els.exportManage.addEventListener("click", openExportManage);
    }
    if (els.exportManageClose) {
      els.exportManageClose.addEventListener("click", closeExportManage);
    }
    if (els.exportOpenDir) {
      els.exportOpenDir.addEventListener("click", openExportDirectory);
    }
    if (els.exportPreviewBtn) {
      els.exportPreviewBtn.addEventListener("click", previewExportFiles);
    }
    if (els.exportPruneBtn) {
      els.exportPruneBtn.addEventListener("click", executeExportPrune);
    }
    if (els.exportPruneConfirm) {
      els.exportPruneConfirm.addEventListener("input", updateExportManageButtons);
    }
    [els.exportKeepDays, els.exportKeepLatest].forEach(function (select) {
      if (!select) return;
      select.addEventListener("change", function () {
        state.exportManagePreview = null;
        if (els.exportPruneConfirm) els.exportPruneConfirm.value = "";
        renderExportPreview(null);
        setExportStatus("清理参数已变更，请重新预览。", "");
        updateExportManageButtons();
      });
    });
    if (els.exportWeek) {
      els.exportWeek.addEventListener("change", function () {
        state.exportManageWeek = String(els.exportWeek.value || "");
        state.exportManagePreview = null;
        if (els.exportPruneConfirm) els.exportPruneConfirm.value = "";
        renderExportPreview(null);
        setExportStatus("时间范围已变更，请重新预览。", "");
        updateExportManageButtons();
        loadExportStatus().then(function () {
          if (state.exportManageOpen) previewExportFiles();
        });
      });
    }
    if (els.exportManageModal) {
      els.exportManageModal.addEventListener("click", function (event) {
        if (event.target === els.exportManageModal) closeExportManage();
      });
      els.exportManageModal.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeExportManage();
          return;
        }
        if (event.key !== "Tab") return;
        var focusable = Array.prototype.slice.call(
          els.exportManageModal.querySelectorAll(
            "button:not([disabled]), select:not([disabled]), input:not([disabled])"
          )
        );
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }
    if (els.historyAutoToggle) {
      els.historyAutoToggle.addEventListener("click", function () {
        if (state.historyAutoBusy) return;
        state.historyAutoEnabled = !state.historyAutoEnabled;
        updateHistoryAutoUi();
        setHistoryAutoStatus(
          state.historyAutoEnabled
            ? "已切换为开启；点击保存设置后生效。"
            : "已切换为关闭；点击保存设置后生效。",
          false
        );
      });
    }
    if (els.historyAutoDays) {
      els.historyAutoDays.addEventListener("change", function () {
        state.historyAutoDays = Number(els.historyAutoDays.value) || 90;
        setHistoryAutoStatus("自动保留天数已变更；点击保存设置后生效。", false);
      });
    }
    if (els.historyAutoSave) {
      els.historyAutoSave.addEventListener("click", saveHistoryAutoSettings);
    }
    if (els.historyPrunePreviewBtn) {
      els.historyPrunePreviewBtn.addEventListener("click", previewHistoryPrune);
    }
    if (els.historyPruneBtn) {
      els.historyPruneBtn.addEventListener("click", executeHistoryPrune);
    }
    if (els.historyPruneConfirm) {
      els.historyPruneConfirm.addEventListener("input", updateHistoryManageButtons);
    }
    if (els.historyKeepDays) {
      els.historyKeepDays.addEventListener("change", function () {
        state.historyManagePreview = null;
        if (els.historyPruneConfirm) els.historyPruneConfirm.value = "";
        setHistoryPrunePreview("保留范围已变更，请点击预览。", "");
        updateHistoryManageButtons();
      });
    }
    if (els.historyManageModal) {
      els.historyManageModal.addEventListener("click", function (event) {
        if (event.target === els.historyManageModal) closeHistoryManage();
      });
      els.historyManageModal.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeHistoryManage();
          return;
        }
        if (event.key !== "Tab") return;
        var focusable = Array.prototype.slice.call(
          els.historyManageModal.querySelectorAll(
            "button:not([disabled]), select:not([disabled]), input:not([disabled])"
          )
        );
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }
    if (els.historyMore) {
      els.historyMore.addEventListener("click", function () {
        loadHistory(true, { append: true });
      });
    }
    if (els.historySearch) {
      var commitSearch = function () {
        if (state.historySearchTimer) {
          clearTimeout(state.historySearchTimer);
          state.historySearchTimer = 0;
        }
        state.historyQuery = els.historySearch.value || "";
        applyHistoryFilters();
      };
      els.historySearch.addEventListener("input", function () {
        state.historyQuery = els.historySearch.value || "";
        if (state.historySearchTimer) clearTimeout(state.historySearchTimer);
        state.historySearchTimer = setTimeout(commitSearch, 280);
      });
      els.historySearch.addEventListener("search", commitSearch);
      els.historySearch.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          commitSearch();
        } else if (event.key === "Escape" && els.historySearch.value) {
          event.preventDefault();
          els.historySearch.value = "";
          commitSearch();
        }
      });
    }
    if (els.historyRange) {
      els.historyRange.addEventListener("change", function () {
        state.historyRange = els.historyRange.value || "all";
        syncHistoryFilterUi();
        if (state.historyRange === "custom") return;
        applyHistoryFilters();
      });
    }
    if (els.historyPlatform) {
      els.historyPlatform.addEventListener("change", function () {
        state.historyPlatform = els.historyPlatform.value || "";
        applyHistoryFilters();
        try {
          els.historyPlatform.focus({ preventScroll: true });
        } catch (e) {
          els.historyPlatform.focus();
        }
      });
    }
    if (els.historyFrom) {
      els.historyFrom.addEventListener("input", function () {
        state.historyFromValue = els.historyFrom.value || "";
      });
      els.historyFrom.addEventListener("change", function () {
        state.historyFromValue = els.historyFrom.value || "";
      });
    }
    if (els.historyTo) {
      els.historyTo.addEventListener("input", function () {
        state.historyToValue = els.historyTo.value || "";
      });
      els.historyTo.addEventListener("change", function () {
        state.historyToValue = els.historyTo.value || "";
      });
    }
    if (els.historyCustomApply) {
      els.historyCustomApply.addEventListener("click", applyHistoryFilters);
    }
    if (els.historyFilterReset) {
      els.historyFilterReset.addEventListener("click", clearHistoryFilters);
    }
    if (els.historyList) {
      els.historyList.addEventListener("click", function (event) {
        var target = event.target.closest ? event.target.closest("[data-history-id]") : null;
        if (target) {
          state.historyPreserveDetailId = "";
          selectHistorySession(target.getAttribute("data-history-id"));
        }
      });
    }
    document.addEventListener("keydown", function (event) {
        if (event.defaultPrevented || event.key !== "Escape" ||
            state.historyMode !== "trend" || state.view !== "data" ||
            state.dataTab !== "history") return;
        event.preventDefault();
        closeHistoryTrend();
    });
    document.addEventListener("click", function (event) {
      if (event.defaultPrevented) return;
      var link = event.target.closest
        ? event.target.closest("[data-open-export-manage]")
        : null;
      if (!link) return;
      event.preventDefault();
      openExportManage();
    });
    document.addEventListener("keydown", function (event) {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (state.historyBaselineOpen) {
        event.preventDefault();
        closeHistoryBaselinePicker();
        return;
      }
      if (state.view === "data" && state.dataTab === "history" &&
          state.historyMode === "detail" && state.historySelectedId &&
          state.historyMultiCompareLoading) {
        event.preventDefault();
        returnHistoryOverview();
      }
    });
    if (els.historyDetail) {
      els.historyDetail.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && state.historyMode === "trend") {
          event.preventDefault();
          closeHistoryTrend();
          return;
        }
        if (event.key === "Escape" && state.historySelectedId) {
          event.preventDefault();
          if (state.historyView === "compare" ||
              state.historyView === "multi_compare") returnHistoryOverview();
          else closeHistoryDetail();
        }
      });
      els.historyDetail.addEventListener("change", function (event) {
        var roomSelect = event.target.closest
          ? event.target.closest("[data-trend-room-select]")
          : null;
        if (!roomSelect) return;
        selectHistoryTrendRoomByIndex(roomSelect.value);
      });
      els.historyDetail.addEventListener("click", function (event) {
        var exportManageLink = event.target.closest
          ? event.target.closest("[data-open-export-manage]")
          : null;
        if (exportManageLink) {
          event.preventDefault();
          openExportManage();
          return;
        }
        var insightRetry = event.target.closest
          ? event.target.closest("[data-history-insight-retry]")
          : null;
        if (insightRetry) {
          state.historyInsightFocusPending = true;
          loadHistoryInsights(state.historySelectedId, true);
          requestAnimationFrame(function () {
            var status = els.historyDetail
              ? els.historyDetail.querySelector(".history-insight-loading")
              : null;
            if (status) {
              status.setAttribute("tabindex", "-1");
              status.focus();
            }
          });
          return;
        }
        var analysisExport = event.target.closest
          ? event.target.closest("[data-history-analysis-export]")
          : null;
        if (analysisExport) {
          var exportKind = analysisExport.getAttribute("data-history-analysis-export");
          if (exportKind !== "trend" &&
              exportKind !== "compare" &&
              exportKind !== "compare_multi" &&
              exportKind !== "insights") return;
          exportHistoryAnalysis(
            exportKind,
            analysisExport.getAttribute("data-format") || "json",
            analysisExport
          );
          return;
        }
        var baseline = event.target.closest
          ? event.target.closest("[data-history-baseline]")
          : null;
        if (baseline) {
          state.historyCompareEntry = "baseline";
          openHistoryBaselinePicker({ multi: false });
          return;
        }
        var multiBaseline = event.target.closest
          ? event.target.closest("[data-history-baseline-multi]")
          : null;
        if (multiBaseline) {
          state.historyCompareEntry = "multi";
          openHistoryBaselinePicker({ multi: true });
          return;
        }
        var trendBack = event.target.closest
          ? event.target.closest("[data-history-trend-back]")
          : null;
        if (trendBack) {
          closeHistoryTrend();
          return;
        }
        var trendRefresh = event.target.closest
          ? event.target.closest("[data-history-trend-refresh]")
          : null;
        if (trendRefresh) {
          state.historyTrendFocusPending = true;
          loadHistoryTrend(true);
          return;
        }
        var granularityButton = event.target.closest
          ? event.target.closest("[data-trend-granularity]")
          : null;
        if (granularityButton) {
          var granularityValue = granularityButton.getAttribute("data-trend-granularity");
          if (granularityValue === "hour" ||
              granularityValue === "day" ||
              granularityValue === "week") {
            setHistoryTrendGranularity(granularityValue, granularityButton);
          }
          return;
        }
        var metricButton = event.target.closest
          ? event.target.closest("[data-trend-metric]")
          : null;
        if (metricButton) {
          var metric = metricButton.getAttribute("data-trend-metric");
          if (metric !== "received_per_hour" &&
              metric !== "spoken_rate" &&
              metric !== "drop_rate") return;
          state.historyTrendMetric = metric;
          if (!state.historyTrendData) return;
          renderHistoryTrend(state.historyTrendData);
          var activeMetric = els.historyDetail.querySelector(
            '[data-trend-metric="' + metric + '"]'
          );
          if (activeMetric) activeMetric.focus();
          return;
        }
        var compareBack = event.target.closest ? event.target.closest("[data-history-compare-back]") : null;
        if (compareBack) {
          returnHistoryOverview();
          return;
        }
        var compare = event.target.closest ? event.target.closest("[data-history-compare]") : null;
        if (compare) {
          openHistoryCompare();
          return;
        }
        var back = event.target.closest ? event.target.closest("[data-history-back]") : null;
        if (back) {
          closeHistoryDetail();
          return;
        }
        var remove = event.target.closest ? event.target.closest("[data-history-delete]") : null;
        if (!remove) {
          var exportButton = event.target.closest ? event.target.closest("[data-history-export]") : null;
          if (!exportButton) return;
          var exportId = exportButton.getAttribute("data-history-id");
          var format = exportButton.getAttribute("data-history-export");
          if (exportId) exportHistorySession(exportId, format, exportButton);
          return;
        }
        var id = remove.getAttribute("data-history-delete");
        if (!id || remove.disabled) return;
        var titleNode = els.historyDetail.querySelector(".history-detail-title h2");
        var title = titleNode ? titleNode.textContent : "这场记录";
        if (!window.confirm("确定从 ReadMe 历史中删除「" + title + "」？此操作无法撤销。")) return;
        var api = ctx.api;
        if (typeof api.deleteSession !== "function") {
          var missingStatus = els.historyDetail.querySelector("[data-history-export-status]");
          if (missingStatus) {
            missingStatus.hidden = false;
            missingStatus.className = "history-export-status is-error";
            missingStatus.textContent = "后端未提供历史场次删除接口。";
          }
          return;
        }
        remove.disabled = true;
        remove.setAttribute("aria-busy", "true");
        remove.textContent = "删除中…";
        Promise.resolve(api.deleteSession(id)).then(function (result) {
          if (!result || result.ok === false) {
            throw new Error(result && result.error ? result.error : "删除失败");
          }
          closeHistoryDetail();
          state.historyLoaded = false;
          return loadHistory(true);
        }).catch(function (error) {
          var status = els.historyDetail.querySelector("[data-history-export-status]");
          if (status) {
            status.hidden = false;
            status.className = "history-export-status is-error";
            status.textContent = "删除失败：" +
              (error && error.message ? error.message : "未知错误");
          }
          remove.disabled = false;
          remove.removeAttribute("aria-busy");
          remove.textContent = "删除本场";
        });
      });
    }
  }

  function bindNavigation() {
    document.querySelectorAll("[data-workspace-view]").forEach(function (button) {
      button.addEventListener("click", function () {
        setView(button.getAttribute("data-workspace-view"), { focus: false });
      });
    });
  }

  function bindActions() {
    document.addEventListener("click", function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest("[data-workspace-action]")
        : null;
      if (!target) return;
      event.preventDefault();
      runAction(target.getAttribute("data-workspace-action"), target);
    });
  }

  function bindSettingsNav() {
    if (!els.settingsNav) return;
    var applyPane = function (pane, button, focus) {
      if (!pane || !els.settingsLayout) return;
      els.settingsLayout.setAttribute("data-settings-pane", pane);
      els.settingsNav.querySelectorAll("[data-settings-pane]").forEach(function (item) {
        item.classList.toggle("is-active", item.getAttribute("data-settings-pane") === pane);
      });
      if (!focus || !button) return;
      var target = document.getElementById(button.getAttribute("data-settings-jump"));
      var focusable = target && target.querySelector(
        "button, input, select, textarea, [tabindex]"
      );
      if (focusable && typeof focusable.focus === "function") {
        focusable.focus({ preventScroll: true });
      }
    };
    els.settingsNav.addEventListener("click", function (event) {
      var button = event.target && event.target.closest
        ? event.target.closest("[data-settings-jump]")
        : null;
      if (!button) return;
      var pane = button.getAttribute("data-settings-pane");
      if (pane) {
        applyPane(pane, button, true);
        return;
      }
      var target = document.getElementById(button.getAttribute("data-settings-jump"));
      if (!target) return;
      els.settingsNav.querySelectorAll("[data-settings-jump]").forEach(function (item) {
        item.classList.toggle("is-active", item === button);
      });
      if (target.scrollIntoView) {
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      var focusable = target.querySelector("button, input, select, textarea, [tabindex]");
      if (focusable && typeof focusable.focus === "function") {
        focusable.focus({ preventScroll: true });
      }
    });
    var initial = els.settingsNav.querySelector("[data-settings-pane].is-active");
    applyPane(initial ? initial.getAttribute("data-settings-pane") : "account", initial, false);
  }

  function runAction(action, trigger) {
    var api = ctx.api;
    if (action === "monitor") {
      var monitorBtn = $("monitorBtn");
      if (monitorBtn) monitorBtn.click();
      return;
    }
    if (action === "overlay-workbench") {
      if (typeof api.openOverlayWorkbench === "function") {
        api.openOverlayWorkbench();
      } else {
        var pictureNav = document.querySelector('[data-workspace-view="picture"]');
        if (pictureNav) pictureNav.click();
      }
      return;
    }
    if (action === "overlay-toggle") {
      if (typeof api.toggleOverlay === "function") {
        Promise.resolve(api.toggleOverlay()).then(function () {
          refreshSnapshot();
        });
      }
      return;
    }
    if (action === "appearance") {
      var appearanceBtn = $("appearanceBtn");
      if (appearanceBtn) appearanceBtn.click();
      return;
    }
    if (action === "login") {
      var accountBtn = $("accountBtn");
      if (accountBtn) accountBtn.click();
      return;
    }
    if (action === "export-manage") {
      openExportManage();
      return;
    }
    if (action === "copy-capture") {
      copyCaptureTitle(trigger);
    }
  }

  function copyCaptureTitle(trigger) {
    var text = "ReadMe 浮窗";
    var done = function () {
      if (!trigger) return;
      var before = trigger.textContent;
      trigger.textContent = "已复制";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        trigger.textContent = before;
      }, 1400);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallbackCopy(text, done);
      });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      done();
    } catch (e) {}
  }

  function connectionLabel(connection) {
    if (connection === "connected") return "已连接";
    if (connection === "connecting") return "连接中";
    if (connection === "error") return "连接异常";
    return "未连接";
  }

  function metricsForSnapshot(snapshot) {
    return snapshot && snapshot.is_mock ? state.session.mock : state.session.real;
  }

  function statsForSnapshot(snapshot) {
    var snap = snapshot || {};
    if (snap.session && typeof snap.session === "object") {
      var scope = snap.is_mock ? "mock" : "real";
      var stats = snap.session[scope];
      if (stats && typeof stats === "object") return stats;
    }
    return snap.stats && typeof snap.stats === "object" ? snap.stats : {};
  }

  function metricTotal(metrics) {
    if (!metrics || !metrics.counts) return 0;
    return TYPE_META.reduce(function (sum, meta) {
      return sum + (metrics.counts[meta.key] || 0);
    }, 0);
  }

  function formatMoney(value) {
    var number = Number(value) || 0;
    return "¥" + (Math.round(number * 100) / 100).toFixed(2);
  }



  function giftValueText(metrics) {
    var values = metrics && metrics.values ? metrics.values : {};
    var parts = [];
    if (values.giftCny || (!values.giftSilver && !values.giftUnknown)) {
      parts.push(formatMoney(values.giftCny));
    }
    if (values.giftSilver) parts.push("银瓜子 " + values.giftSilver);
    if (values.giftUnknown) parts.push("瓜子 " + values.giftUnknown);
    return "本机字段 " + (parts.length ? parts.join(" · ") : "¥0.00");
  }

  function resetSession(roomId, backendId, startedAtSeconds) {
    state.session.roomId = roomId;
    state.session.backendId = backendId || null;
    state.session.startedAt = startedAtSeconds
      ? Math.round(Number(startedAtSeconds) * 1000)
      : Date.now();
    state.session.observedAt = Date.now();
    state.session.real = newMetrics();
    state.session.mock = newMetrics();
    state.liveQueueHighSince = 0;
    state.liveLastRenderAt = 0;
    state.liveNoticeSignature = "";
    state.liveTypeSignature = "";
    state.liveActivitySignature = "";
    state.liveSparkSignature = "";
    state.postludeExporting = false;
    state.postludeExportSessionId = "";
    state.postludeExportSeq += 1;
    if (els.dataNotices) els.dataNotices.innerHTML = "";
  }

  function hydrateSessionMinutes(backendSession) {
    if (!backendSession || !Array.isArray(backendSession.minutes)) return;
    var metrics = state.session.real;
    var minutes = backendSession.minutes;
    if (!minutes.length) return;
    minutes.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      var minute = Number(item.minute);
      var count = Number(item.count);
      if (!isFinite(minute) || !isFinite(count) || !metrics.minuteBuckets) return;
      var current = metrics.minuteBuckets.get(minute) || 0;
      metrics.minuteBuckets.set(minute, Math.max(current, count));
    });
    var lastEventAt = Number(backendSession.last_event_at);
    if (isFinite(lastEventAt) && lastEventAt > 0) {
      metrics.lastEventAt = Math.max(Number(metrics.lastEventAt) || 0, lastEventAt);
    }
    if (state.session.startedAt) {
      // 后端分钟桶从场次开始累计；刷新页面后不再按“本页打开时间”降级。
      state.session.observedAt = state.session.startedAt;
    }
  }

  function renderCredentialSecurity() {
    var el = els.settingsCredentialSecurity;
    if (!el) return;
    var status = state.configStatus || {};
    var security = status.security && typeof status.security === "object"
      ? status.security
      : {};
    var message = security.warning ? String(security.message || "") : "";
    if (!message && status.read_only) {
      message = "配置处于只读安全模式，登录凭证不会写入或覆盖。";
    }
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.className = "settings-security-note";
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.className = "settings-security-note" +
      (security.state === "decrypt_failed" ? " is-error" : "");
  }

  function refreshCredentialSecurity(force) {
    var now = Date.now();
    if (!force && state.securityRefreshAt && now - state.securityRefreshAt < 5000) {
      return Promise.resolve();
    }
    state.securityRefreshAt = now;
    var api = ctx.api;
    if (!api || typeof api.getConfigStatus !== "function") {
      state.configStatus = null;
      renderCredentialSecurity();
      return Promise.resolve();
    }
    return Promise.resolve(api.getConfigStatus()).then(function (status) {
      state.configStatus = status && typeof status === "object" ? status : null;
      renderCredentialSecurity();
    }).catch(function () {
      state.configStatus = null;
      renderCredentialSecurity();
    });
  }

  function refreshSnapshot() {
    var api = ctx.api;
    if (!api || typeof api.getSnapshot !== "function") return;
    var snapshot = api.getSnapshot();
    if (!snapshot || typeof snapshot !== "object") return;
    state.snapshot = snapshot;
    var backendSession = snapshot.session && typeof snapshot.session === "object"
      ? snapshot.session
      : null;
    if (backendSession && backendSession.id &&
        state.session.backendId !== backendSession.id) {
      if (state.session.roomId === snapshot.room_id && state.session.startedAt) {
        state.session.backendId = backendSession.id;
      } else {
        resetSession(snapshot.room_id || 0, backendSession.id, backendSession.started_at);
      }
    }
    if (backendSession && backendSession.id &&
        state.session.backendId === backendSession.id &&
        backendSession.started_at) {
      state.session.startedAt = Math.round(Number(backendSession.started_at) * 1000);
    }
    if (backendSession && backendSession.id &&
        state.session.backendId === backendSession.id) {
      hydrateSessionMinutes(backendSession);
    }
    if (!backendSession && snapshot.connection === "connected" &&
        (state.session.roomId !== snapshot.room_id || !state.session.startedAt)) {
      resetSession(snapshot.room_id || 0, null, null);
    }
    renderChrome();
    renderSession();
    renderPicture();
    if (state.view === "data") renderData();
    if (state.view === "settings") refreshCredentialSecurity(false);
  }

  function renderChrome() {
    var snap = state.snapshot || {};
    var connected = snap.connection === "connected";
    if (els.railSession) {
      els.railSession.classList.toggle("is-connected", connected);
      els.railSession.classList.toggle("is-error", snap.connection === "error");
    }
    safeText(els.railState, connectionLabel(snap.connection));
    safeText(els.railQueue, "队列 " + (snap.queue_len || 0));
    var platformAccount = snap.platform === "douyin" && snap.account && snap.account.douyin
      ? snap.account.douyin
      : (snap.account || {});
    var platformName = snap.platform === "douyin" ? "抖音" : "B站";
    safeText(els.settingsAccountTitle, platformName + "登录态");
    safeText(els.settingsAccount, platformAccount.logged_in
      ? "已登录 · " + (platformAccount.uname || platformName + "账号")
      : "未登录 · 用户名可能显示为星号");
    var monitorVisible = !!(window.MutaiApp && window.MutaiApp.state &&
      window.MutaiApp.state.monitorVisible);
    if (els.monitorBtn) {
      els.monitorBtn.title = monitorVisible ? "关闭弹幕监看窗口" : "打开弹幕监看窗口";
      els.monitorBtn.setAttribute("aria-label", els.monitorBtn.title);
      els.monitorBtn.setAttribute("aria-pressed", monitorVisible ? "true" : "false");
    }
    safeText(els.monitorTheme, document.documentElement.dataset.theme === "light" ? "晨光" : "夜航");
    syncExportManageEntry();
  }

  function renderSession() {
    var snap = state.snapshot || {};
    var stats = statsForSnapshot(snap);
    var connected = snap.connection === "connected";
    safeText(els.wsLiveState, connectionLabel(snap.connection));
    if (els.wsLiveState) {
      els.wsLiveState.classList.toggle("is-connected", connected);
    }
    var platformLabel = snap.platform === "douyin" ? "抖音" : "B站";
    var roomKey = snap.room_key || snap.room_id || "";
    safeText(els.wsRoomTitle, snap.room_title
      ? platformLabel + " · " + snap.room_title
      : (roomKey ? "直播间 " + roomKey : "等待连接"));
    safeText(els.wsRoomMeta, connected
      ? platformLabel + " · 房间号 " + (roomKey || "—") + " · 本机观测"
      : "选择平台并输入直播间号，开始接收弹幕。");
    safeText(els.wsReceived, stats.received || 0);
    safeText(els.wsSpoken, stats.spoken || 0);
    safeText(els.wsDropped, stats.dropped || 0);
    safeText(els.wsQueue, snap.queue_len || 0);
    var startedMs = state.session.startedAt ||
      (snap.session && Number(snap.session.started_at) > 0 ? Number(snap.session.started_at) * 1000 : 0);
    var elapsed = connected && startedMs ? Math.max(0, (Date.now() - startedMs) / 1000) : null;
    safeText(els.wsHeroClock, elapsed == null ? "—" : formatDuration(elapsed));
    if (elapsed == null) {
      safeText(els.wsHeroHint, "连接后开始计时");
    } else {
      var startedAt = new Date(startedMs);
      var startedLabel = ("0" + startedAt.getHours()).slice(-2) + ":" + ("0" + startedAt.getMinutes()).slice(-2);
      safeText(els.wsHeroHint, "已开播\n" + startedLabel + " 开始");
    }
    if (els.liveHero) els.liveHero.classList.toggle("is-live", connected);
    var now = snap.now_playing;
    safeText(els.wsNowState, now ? "播放中" : "空闲");
    safeText(els.wsNowUser, now && now.user ? now.user : "—");
    safeText(els.wsNowText, now && (now.text || now.user)
      ? (now.text || "")
      : "连接直播间后，最新一条待朗读消息会显示在这里。");
  }

  function overlayDetail(snap) {
    var overlay = snap && snap.overlay && typeof snap.overlay === "object" ? snap.overlay : {};
    return {
      enabled: !!overlay.enabled,
      width: Math.round(clamp(overlay.width, 1, 10000, 520)),
      height: Math.round(clamp(overlay.height, 1, 10000, 620)),
      x: Math.round(clamp(overlay.x, -20000, 20000, 0)),
      y: Math.round(clamp(overlay.y, -20000, 20000, 0)),
      scale: clamp(overlay.scale, 0.1, 4, 1),
      clickThrough: !!overlay.click_through,
      alwaysOnTop: !!overlay.always_on_top
    };
  }

  function renderPicture() {
    var detail = overlayDetail(state.snapshot);
    safeText(els.overlayBadge, detail.enabled ? "显示中" : "已隐藏");
    if (els.overlayBadge) {
      els.overlayBadge.classList.toggle("is-live", detail.enabled);
    }
    safeText(els.overlaySize, detail.width + " × " + detail.height + "px");
    safeText(els.overlayPosition, detail.x + ", " + detail.y);
    safeText(els.overlayScale, Math.round(detail.scale * 100) + "%");
    safeText(els.overlayInteraction, (detail.clickThrough ? "鼠标穿透" : "可交互") +
      " · " + (detail.alwaysOnTop ? "置顶" : "普通"));
    var actionText = detail.enabled ? "隐藏弹幕" : "显示弹幕";
    safeText(els.wsTopOverlayToggle, actionText);
    if (els.wsTopOverlayToggle) {
      els.wsTopOverlayToggle.setAttribute("aria-pressed", detail.enabled ? "true" : "false");
    }
    if (els.wsWorkbenchOverlayState) {
      els.wsWorkbenchOverlayState.textContent = actionText;
      els.wsWorkbenchOverlayState.classList.toggle("is-ok", detail.enabled);
      els.wsWorkbenchOverlayState.classList.toggle("is-neutral", !detail.enabled);
      els.wsWorkbenchOverlayState.setAttribute("aria-pressed", detail.enabled ? "true" : "false");
    }
    safeText(els.monitorTheme, document.documentElement.dataset.theme === "light" ? "晨光" : "夜航");
  }

  function giftCurrency(meta, source) {
    var value = meta && typeof meta === "object" ? meta : {};
    var totalCoin = Number(value.total_coin);
    var price = Number(value.price);
    var amount = Number(value.num) > 0 ? Number(value.num) : 1;
    if (!isFinite(totalCoin) || totalCoin <= 0) {
      totalCoin = (isFinite(price) ? price : 0) * amount;
    }
    var coinType = String(value.coin_type || "").toLowerCase();
    if (coinType === "gold") {
      return { cny: totalCoin / 1000, silver: 0, unknown: 0 };
    }
    if (coinType === "mock_cny" || value.mock || (source === "mock" && !coinType)) {
      return { cny: totalCoin, silver: 0, unknown: 0 };
    }
    if (coinType === "silver") {
      return { cny: 0, silver: totalCoin, unknown: 0 };
    }
    return { cny: 0, silver: 0, unknown: totalCoin };
  }

  function receiveMessage(event) {
    var detail = event && event.detail && typeof event.detail === "object" ? event.detail : null;
    if (!detail) return;
    var type = detail.type || "danmaku";
    var meta = detail.meta && typeof detail.meta === "object" ? detail.meta : {};
    var source = detail.source === "mock" || meta.mock ? "mock" : "real";
    var metrics = source === "mock" ? state.session.mock : state.session.real;
    if (Object.prototype.hasOwnProperty.call(metrics.counts, type)) {
      metrics.counts[type] += 1;
    }
    var ts = Number(detail.ts);
    if (!isFinite(ts) || ts <= 0) ts = Date.now() / 1000;
    metrics.lastEventAt = ts;
    var minute = Math.floor(ts / 60);
    metrics.minuteBuckets.set(minute, (metrics.minuteBuckets.get(minute) || 0) + 1);
    var uidText = detail.uid == null ? "" : String(detail.uid).trim();
    if (uidText && uidText !== "0") metrics.users.add(uidText);
    if (type === "gift") {
      var gift = giftCurrency(meta, source);
      metrics.values.giftCny += gift.cny;
      metrics.values.giftSilver += gift.silver;
      metrics.values.giftUnknown += gift.unknown;
    } else if (type === "super_chat") {
      var sc = Number(meta.price);
      if (isFinite(sc) && sc > 0) metrics.values.superChatCny += sc;
    }
    if (state.view === "data") scheduleDataRender();
  }

  function handleSessionIntent(event) {
    var detail = event && event.detail && typeof event.detail === "object" ? event.detail : {};
    var roomId = Number(detail.room_id);
    if (!isFinite(roomId) || roomId <= 0) return;
    resetSession(roomId);
    renderSession();
    if (state.view === "data") renderData();
  }

  function scheduleDataRender() {
    if (state.view !== "data" || dataRenderTimer) return;
    dataRenderTimer = setTimeout(function () {
      dataRenderTimer = 0;
      renderData();
    }, 120);
  }

  function formatClock(ts) {
    if (!ts) return "—";
    var date = new Date(ts < 10 ** 12 ? ts * 1000 : ts);
    if (isNaN(date.getTime())) return "—";
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  function formatStarted(ts) {
    if (!ts) return "尚未开始";
    var date = new Date(ts);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
      pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function formatLiveNumber(value) {
    var number = Math.round(historyNumber(value));
    return number.toLocaleString("zh-CN");
  }

  function formatLivePercent(value) {
    if (value == null || !isFinite(value)) return "—";
    return (Math.round(Number(value) * 10) / 10).toFixed(1) + "%";
  }

  function formatLiveSpan(seconds) {
    if (seconds == null || !isFinite(seconds)) return "—";
    var total = Math.max(0, Math.floor(Number(seconds)));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(secs);
    return pad(minutes) + ":" + pad(secs);
  }

  function formatLiveAge(seconds) {
    if (seconds == null || !isFinite(seconds)) return "—";
    var total = Math.max(0, Math.floor(Number(seconds)));
    if (total < 5) return "刚刚";
    if (total < 60) return total + " 秒";
    var minutes = Math.floor(total / 60);
    var secs = total % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    if (minutes < 60) return pad(minutes) + ":" + pad(secs);
    return Math.floor(minutes / 60) + ":" + pad(minutes % 60) + ":" + pad(secs);
  }

  function liveRecentCount(metrics, anchorSeconds) {
    if (!metrics || !metrics.minuteBuckets || !isFinite(anchorSeconds)) return 0;
    var anchorMinute = Math.floor(anchorSeconds / 60);
    var total = 0;
    for (var i = 4; i >= 0; i -= 1) {
      total += metrics.minuteBuckets.get(anchorMinute - i) || 0;
    }
    return total;
  }

  function livePeakFiveMinute(metrics, startedAt, endedAt) {
    if (!metrics || !metrics.minuteBuckets || !metrics.minuteBuckets.size) return null;
    var minutes = [];
    metrics.minuteBuckets.forEach(function (count, minute) {
      minutes.push({ minute: minute, count: count });
    });
    return historyPeakFiveMinute({
      started_at: startedAt,
      ended_at: endedAt,
      minutes: minutes
    });
  }

  function renderLiveNotices(notices) {
    if (!els.dataNotices) return;
    var signature = notices.map(function (item) { return item.code; }).join("|");
    if (signature === state.liveNoticeSignature) return;
    state.liveNoticeSignature = signature;
    els.dataNotices.innerHTML = notices.map(function (item) {
      return '<span class="data-notice is-' + escapeHtml(item.tone) + '">' +
        escapeHtml(item.text) + '</span>';
    }).join("");
  }

  function buildLiveNotices(snap, values) {
    var now = Date.now();
    if (state.liveLastRenderAt && now - state.liveLastRenderAt > 5000) {
      state.liveQueueHighSince = 0;
    }
    state.liveLastRenderAt = now;
    if (values.queue >= 10) {
      if (!state.liveQueueHighSince) state.liveQueueHighSince = now;
    } else {
      state.liveQueueHighSince = 0;
    }

    var notices = [];
    if (snap.connection === "error" && values.startedAt) {
      notices.push({
        code: "connection_error",
        tone: "err",
        text: "连接异常 · 读数停在最后消息"
      });
    } else if (snap.connection === "connecting") {
      notices.push({
        code: "connecting",
        tone: "info",
        text: "正在连接 · 等待首条数据"
      });
    } else if (values.startedAt && !values.connected && !snap.is_mock) {
      notices.push({
        code: "connection_closed",
        tone: "neutral",
        text: "已断开 · 显示最后读数"
      });
    }
    if (values.connected && !values.sessionOpen && !snap.is_mock) {
      notices.push({
        code: "session_closed",
        tone: "neutral",
        text: "场次已结束 · 连接仍在线"
      });
    }
    if (!snap.is_mock && snap.history && snap.history.available === false) {
      notices.push({
        code: "history_unavailable",
        tone: "warn",
        text: "历史存储不可用 · 本场不会写入历史"
      });
    }
    if (state.liveQueueHighSince && now - state.liveQueueHighSince >= 30000) {
      notices.push({
        code: "queue_backlog",
        tone: "warn",
        text: "队列持续积压 · 30 秒未回落"
      });
    }
    if (values.received >= 50 && values.dropRate != null && values.dropRate >= 20) {
      notices.push({
        code: "drop_high",
        tone: "warn",
        text: "硬丢弃偏高 · 可检查队列与合成"
      });
    }
    if (snap.is_mock) {
      notices.push({
        code: "mock_preview",
        tone: "info",
        text: "调试预览 · 不计入历史"
      });
    } else if (values.mockEvents > 0) {
      notices.push({
        code: "mock_isolated",
        tone: "info",
        text: "模拟事件已隔离 · 不计入本场"
      });
    }
    if (!values.startedAt) {
      notices.push({
        code: "waiting",
        tone: "neutral",
        text: "连接直播间后开始记录"
      });
    } else if (values.connected && values.sessionOpen &&
        values.received === 0) {
      notices.push({
        code: "waiting_first",
        tone: "neutral",
        text: "已连接，等待首条消息"
      });
    }
    if (!notices.length && values.startedAt && values.connected &&
        values.sessionOpen && !snap.is_mock && values.received > 0) {
      notices.push({
        code: "healthy",
        tone: "ok",
        text: "运行正常 · 本场记录中"
      });
    }
    return notices.slice(0, 3);
  }

  function renderTypeBars(metrics, providedCounts) {
    if (!els.typeBars) return;
    var counts = providedCounts || (metrics && metrics.counts
      ? metrics.counts
      : newMetrics().counts);
    var total = TYPE_META.reduce(function (sum, meta) {
      return sum + (Number(counts[meta.key]) || 0);
    }, 0);
    var signature = total + ":" + TYPE_META.map(function (meta) {
      return Number(counts[meta.key]) || 0;
    }).join(",");
    if (signature === state.liveTypeSignature) return;
    state.liveTypeSignature = signature;
    if (els.typeTotal) safeText(els.typeTotal, formatLiveNumber(total) + " 条");
    if (els.typeSegments) {
      if (total > 0) {
        els.typeSegments.innerHTML = TYPE_META.map(function (meta) {
          var count = Number(counts[meta.key]) || 0;
          var width = count ? Math.max(0.5, count / total * 100) : 0;
          return '<i style="--seg-w:' + width + '%;--seg-c:' + meta.color + '"></i>';
        }).join("");
        els.typeSegments.setAttribute("aria-label", "消息类型占比：" + TYPE_META.map(function (meta) {
          var count = Number(counts[meta.key]) || 0;
          return meta.label + " " + (total ? Math.round(count / total * 100) : 0) + "%";
        }).join("，"));
      } else {
        els.typeSegments.innerHTML = '<span class="type-segments-empty">暂无类型数据</span>';
        els.typeSegments.setAttribute("aria-label", "暂无类型数据");
      }
    }
    els.typeBars.innerHTML = TYPE_META.map(function (meta) {
      var count = Number(counts[meta.key]) || 0;
      var share = total ? count / total : 0;
      return '<div class="type-bar-row">' +
        '<span><i class="type-dot" style="--bar-c:' + meta.color + '"></i>' + meta.label + '</span>' +
        '<b>' + count + '</b>' +
        '<span class="type-bar-pct">' + Math.round(share * 100) + '%</span>' +
      '</div>';
    }).join("");
  }

  function renderActivity(metrics, context) {
    if (!els.activityChart) return;
    var anchorSec = context && isFinite(context.anchorSeconds)
      ? context.anchorSeconds
      : Date.now() / 1000;
    var anchorMinute = Math.floor(anchorSec / 60);
    var points = [];
    var total = 0;
    var max = 1;
    var peakPoint = null;
    for (var i = 19; i >= 0; i -= 1) {
      var minute = anchorMinute - i;
      var value = metrics && metrics.minuteBuckets
        ? (metrics.minuteBuckets.get(minute) || 0)
        : 0;
      points.push({ minute: minute, value: value, current: i === 0 });
      total += value;
      if (!peakPoint || value > peakPoint.value) peakPoint = points[points.length - 1];
      max = Math.max(max, value);
    }
    safeText(els.activityTotal, formatLiveNumber(total) + " 条");
    if (els.activityRecent) {
      safeText(els.activityRecent, context && context.recent != null
        ? formatLiveNumber(context.recent) : formatLiveNumber(liveRecentCount(metrics, anchorSec)));
    }
    if (els.activityAverage) {
      safeText(els.activityAverage, context && context.average != null
        ? (Math.round(context.average * 10) / 10).toFixed(1) + " 条/分" : "—");
    }
    if (els.activityPeak) {
      safeText(els.activityPeak, context && context.peak != null
        ? formatLiveNumber(context.peak) : "—");
    }
    if (context && !context.sessionOpen && context.received === 0) {
      safeText(els.dataEmpty, "本场未收到消息；无分钟数据。");
    } else if (context && context.pageOnly) {
      safeText(els.dataEmpty, "仅统计本页打开后到达的消息；刷新前的分钟桶不重建。");
    } else if (context && context.minuteDataAvailable === false && context.received > 0) {
      safeText(els.dataEmpty, "分钟数据仅从本页打开后记录；刷新前的分钟桶不重建。");
    } else if (total) {
      safeText(els.dataEmpty, "按本机消息到达时间分桶；空分钟不补数据。");
    } else if (context && context.startedAt) {
      safeText(els.dataEmpty, "等待首条消息；按本机消息到达时间分桶。");
    } else {
      safeText(els.dataEmpty, "连接直播间后开始记录；按本机消息到达时间分桶。");
    }
    var chartSignature = anchorMinute + ":" + points.map(function (point) {
      return point.value;
    }).join(",");
    if (chartSignature !== state.liveActivitySignature) {
      state.liveActivitySignature = chartSignature;
      els.activityChart.innerHTML = points.map(function (point) {
        var height = point.value ? Math.max(4, Math.round(point.value / max * 112)) : 2;
        return '<i class="activity-bar' + (point.current ? ' is-current' : '') +
          '" style="--h:' + height + 'px" title="' +
          formatClock(point.minute * 60) + ' · ' + point.value + ' 条"></i>';
      }).join("");
    }
    els.activityChart.setAttribute(
      "aria-label",
      "最近 20 分钟消息量，共 " + total + " 条" +
        (peakPoint && peakPoint.value
          ? "，峰值 " + peakPoint.value + " 条，出现在 " + formatClock(peakPoint.minute * 60)
          : "")
    );
  }

  function setSourceState(el, text, tone) {
    if (!el) return;
    safeText(el, text);
    el.className = tone ? "is-" + tone : "";
  }

  function renderData() {
    var snap = state.snapshot || {};
    var platformProfile = platformCapability(snap.platform);
    var moneyComparable = !!platformProfile.money_comparable;
    var stats = statsForSnapshot(snap);
    var metrics = metricsForSnapshot(snap);
    var connected = snap.connection === "connected";
    var sessionOpen = snap.is_mock
      ? true
      : (snap.session && snap.session.id
        ? !!snap.session.open
        : connected && !!state.session.startedAt);
    var startedMs = state.session.startedAt ||
      (snap.session && snap.session.started_at
        ? Number(snap.session.started_at) * 1000 : 0);
    var nowMs = Date.now();
    var lastEventAt = Number(metrics.lastEventAt) || 0;
    var endedMs = sessionOpen ? nowMs : (lastEventAt ? lastEventAt * 1000 : 0);
    var durationSec = startedMs > 0 && endedMs >= startedMs
      ? Math.max(0, (endedMs - startedMs) / 1000)
      : null;
    var observedAt = Number(state.session.observedAt) || 0;
    var fullCoverage = !!(startedMs && observedAt &&
      observedAt <= startedMs + 1500);
    var pageOnly = !!(startedMs && !fullCoverage);
    var coverageStartSec = observedAt
      ? Math.ceil(observedAt / 1000 / 60) * 60
      : startedMs / 1000;
    var received = Math.max(Number(stats.received) || 0, metricTotal(metrics));
    var spoken = Number(stats.spoken) || 0;
    var dropped = Number(stats.dropped) || 0;
    var filtered = Number(stats.filtered) || 0;
    var hardDropped = Math.max(0, dropped - filtered);
    var queue = Number(snap.queue_len) || 0;
    var hasMinuteData = !!(metrics.minuteBuckets && metrics.minuteBuckets.size);
    var anchorSec = sessionOpen
      ? nowMs / 1000
      : (lastEventAt || (startedMs ? startedMs / 1000 : nowMs / 1000));
    var recent = startedMs > 0
      ? (hasMinuteData ? liveRecentCount(metrics, anchorSec) : (received === 0 ? 0 : null))
      : null;
    var peak = startedMs > 0 && hasMinuteData && !pageOnly
      ? livePeakFiveMinute(metrics, coverageStartSec, endedMs / 1000)
      : null;
    var average = durationSec != null && durationSec >= 60
      ? received / (durationSec / 60) : null;
    var receivedPerHour = durationSec != null && durationSec >= 600
      ? received / (durationSec / 3600) : null;
    var dropRate = received > 0 ? Math.min(100, hardDropped / received * 100) : null;
    var coverage = received > 0 ? Math.min(100, spoken / received * 100) : null;
    var age = sessionOpen && lastEventAt
      ? Math.max(0, nowMs / 1000 - lastEventAt) : null;
    var backendMock = Number(
      snap.session && snap.session.mock && snap.session.mock.received
    ) || 0;
    var mockEvents = Math.max(metricTotal(state.session.mock), backendMock);
    var modeText = connectionLabel(snap.connection);
    if (snap.is_mock) modeText = "模拟数据 · 调试预览";
    else if (snap.mock && snap.mock.running) modeText = "实时数据 · 模拟发送中";
    else if (mockEvents > 0) modeText = "实时数据 · 已隔离模拟 " + mockEvents + " 条";
    safeText(els.dataReceived, formatLiveNumber(received));
    safeText(els.dataSpoken, formatLiveNumber(spoken));
    safeText(els.dataDropped, formatLiveNumber(hardDropped));
    if (els.dataFiltered) safeText(els.dataFiltered, formatLiveNumber(filtered));
    safeText(els.dataQueue, formatLiveNumber(queue));
    safeText(els.dataAvgRate, average == null
      ? "— 条/分"
      : (Math.round(average * 10) / 10).toFixed(1) + " 条/分");
    safeText(els.dataMode, modeText);
    if (els.dataMode) {
      els.dataMode.classList.toggle("is-live", connected && !snap.is_mock);
      els.dataMode.title = mockEvents > 0 && !snap.is_mock
        ? "模拟事件 " + mockEvents + " 条已隔离，不计入本场真实类型分布"
        : "";
    }

    var pulseText = snap.is_mock
      ? "调试预览"
      : snap.connection === "connecting"
        ? "正在连接 · 等待首条数据"
        : connected
          ? (sessionOpen ? "记录中" : "场次已结束 · 连接仍在线")
          : (startedMs ? "已断开 · 最后读数" : "等待连接");
    if (startedMs && durationSec != null) {
      pulseText += " · " + formatLiveSpan(durationSec);
    }
    safeText(els.pulseState, pulseText);
    if (els.pulseState) els.pulseState.classList.toggle("is-live", connected);

    if (els.dataRecentLabel) {
      if (!startedMs) safeText(els.dataRecentLabel, "近 5 分钟");
      else if (pageOnly) safeText(els.dataRecentLabel, "本页观察");
      else if (durationSec != null && durationSec < 300) {
        safeText(els.dataRecentLabel, durationSec < 60
          ? "本场不足 1 分钟" : "本场 " + Math.floor(durationSec / 60) + " 分钟");
      } else if (!sessionOpen) safeText(els.dataRecentLabel, "最后 5 分钟");
      else safeText(els.dataRecentLabel, "近 5 分钟");
    }
    safeText(els.dataRecent, recent == null ? "—" : formatLiveNumber(recent));
    if (els.dataRecentHint) {
      if (!startedMs) safeText(els.dataRecentHint, "连接后开始记录");
      else if (!sessionOpen && received === 0) safeText(els.dataRecentHint, "条 · 尚无消息");
      else if (pageOnly) safeText(els.dataRecentHint, "条 · 仅本页打开后");
      else if (!sessionOpen) safeText(els.dataRecentHint, "条 · 读数停在最后消息");
      else if (!hasMinuteData && received > 0) safeText(els.dataRecentHint, "条 · 分钟数据不可用");
      else if (durationSec != null && durationSec < 300) {
        safeText(els.dataRecentHint, "条 · 未满 5 分钟");
      } else safeText(els.dataRecentHint, "条 · 本机消息到达");
    }
    if (els.pulseSpark) {
      var sparkValues = [];
      var sparkMinute = Math.floor(anchorSec / 60);
      for (var sparkIndex = 4; sparkIndex >= 0; sparkIndex -= 1) {
        sparkValues.push(metrics.minuteBuckets
          ? (metrics.minuteBuckets.get(sparkMinute - sparkIndex) || 0) : 0);
      }
      var sparkMax = Math.max(1, Math.max.apply(null, sparkValues));
      var sparkSignature = sparkValues.join(",");
      if (sparkSignature !== state.liveSparkSignature) {
        state.liveSparkSignature = sparkSignature;
        els.pulseSpark.innerHTML = sparkValues.map(function (value, index) {
          var height = value ? Math.max(4, Math.round(value / sparkMax * 26)) : 2;
          return '<i class="' + (index === sparkValues.length - 1 ? 'is-current' : '') +
            '" style="--h:' + height + 'px"></i>';
        }).join("");
      }
    }

    safeText(els.dataDropRate, formatLivePercent(dropRate));
    if (els.dataDropRateHint) {
      safeText(els.dataDropRateHint, received > 0
        ? (filtered > 0
          ? "过滤 " + formatLiveNumber(filtered) + " 条 · 只计队列/失败"
          : (received < 20 ? "样本不足 · 只计队列/失败" : "样本 " + formatLiveNumber(received) + " · 只计队列/失败"))
        : "只计队列/失败");
    }
    if (els.dataLastAge) {
      safeText(els.dataLastAge, lastEventAt
        ? (sessionOpen ? formatLiveAge(age) : formatClock(lastEventAt))
        : "—");
    }
    if (els.dataLastAgeHint) {
      safeText(els.dataLastAgeHint, lastEventAt
        ? (sessionOpen ? "已连接" : "最后一条")
        : (startedMs ? (received > 0 ? "等待本页新消息" : "尚无消息") : "等待首条"));
    }
    safeText(els.dataRate, receivedPerHour == null ? "—" : formatLiveNumber(receivedPerHour));
    if (els.dataRateHint) {
      safeText(els.dataRateHint, !startedMs
        ? "记录满 10 分钟后计算"
        : (!sessionOpen && durationSec == null
          ? "无观测时长"
          : (!sessionOpen && durationSec < 600
          ? "本场不足 10 分钟"
          : (sessionOpen && durationSec != null && durationSec < 600
            ? "采样中" : "按已观测时长"))));
    }
    safeText(els.dataPeak, peak == null ? "—" : formatLiveNumber(peak));
    if (els.dataPeakHint) {
      safeText(els.dataPeakHint, pageOnly
        ? "本页覆盖不足"
        : (!startedMs
          ? "满 5 分钟后计算"
          : (!sessionOpen && received === 0
            ? "本场未收到消息"
            : (!sessionOpen && durationSec != null && durationSec < 300
            ? "本场不足 5 分钟"
            : (sessionOpen && durationSec != null && durationSec < 300
              ? "满 5 分钟后计算"
              : (peak == null ? "暂无完整窗口" : "条 · 完整窗口"))))));
    }
    safeText(els.dataCoverage, formatLivePercent(coverage));
    safeText(els.dataCoverageHint, "已朗读 " + formatLiveNumber(spoken) + " 条");
    safeText(els.dataSpokenRate, formatLivePercent(coverage));

    safeText(els.dataRoom, snap.room_title || (snap.room_id ? "直播间 " + snap.room_id : "—"));
    safeText(els.dataStarted, formatStarted(state.session.startedAt));
    if (els.dataDuration) {
      safeText(els.dataDuration, durationSec == null ? "—" : formatLiveSpan(durationSec));
    }
    if (els.dataDurationHint) {
      safeText(els.dataDurationHint, durationSec == null
        ? "本场观测"
        : (sessionOpen ? formatClock(startedMs / 1000) + " 开播" : "截至最后消息"));
    }
    safeText(els.dataLastEvent, lastEventAt
      ? formatClock(lastEventAt) + (sessionOpen && age != null
        ? " · " + formatLiveAge(age)
        : (!sessionOpen ? " · 最后一条" : ""))
      : "—");
    safeText(els.dataConnection, connectionLabel(snap.connection));
    var usersCount = Math.max(
      Number(stats && stats.unique_users) || 0,
      metrics.users.size
    );
    var perUser = usersCount > 0 ? received / usersCount : null;
    safeText(els.dataUsers, formatLiveNumber(usersCount));
    safeText(els.dataUsersAvg, perUser == null
      ? "人均 — 条"
      : "人均 " + (Math.round(perUser * 10) / 10).toFixed(1) + " 条");
    var mergedValues = {
      giftCny: Math.max(Number(stats && stats.gift_cny) || 0, Number(metrics.values.giftCny) || 0),
      giftSilver: Math.max(
        Number(stats && stats.gift_silver) || 0,
        Number(metrics.values.giftSilver) || 0
      ),
      giftUnknown: Math.max(
        Number(stats && stats.gift_unknown) || 0,
        Number(metrics.values.giftUnknown) || 0
      ),
      superChatCny: Math.max(
        Number(stats && stats.super_chat_cny) || 0,
        Number(metrics.values.superChatCny) || 0
      )
    };
    if (moneyComparable) {
      safeText(els.dataRevenueLabel, "本机流水");
      safeText(els.dataRevenueGiftLabel, "礼物");
      safeText(els.dataRevenueScLabel, "SC");
      safeText(els.dataGiftValue, giftValueText({ values: mergedValues }));
      safeText(els.dataScValue, "本机字段 " + formatMoney(mergedValues.superChatCny));
      safeText(els.dataRevenue, formatMoney(mergedValues.giftCny + mergedValues.superChatCny));
      safeText(els.dataRevenueGift, formatMoney(mergedValues.giftCny));
      safeText(els.dataRevenueSc, formatMoney(mergedValues.superChatCny));
    } else {
      safeText(els.dataRevenueLabel, platformProfile.gift_value_unit === "diamond"
        ? "礼物价值" : "金额口径");
      safeText(els.dataRevenueGiftLabel, "礼物");
      safeText(els.dataRevenueScLabel, platformProfile.supports_super_chat ? "SC" : "SC/舰长");
      safeText(els.dataGiftValue, platformProfile.gift_value_unit === "diamond"
        ? "钻石不汇总 · 单条消息显示" : "金额口径未接入");
      safeText(els.dataScValue, platformProfile.supports_super_chat
        ? "本机字段未接入" : "平台未提供 SC/舰长");
      safeText(els.dataRevenue, platformProfile.gift_value_unit === "diamond"
        ? "仅单条钻石" : "不可比");
      safeText(els.dataRevenueGift, platformProfile.gift_value_unit === "diamond"
        ? "钻石不汇总" : "未接入");
      safeText(els.dataRevenueSc, platformProfile.supports_super_chat
        ? "未接入" : "未提供");
    }
    var saveState = "未开始";
    if (snap.is_mock) saveState = "调试预览不写入";
    else if (snap.history && snap.history.available === false) saveState = "历史存储不可用";
    else if (snap.session && snap.session.id) {
      saveState = connected && sessionOpen
        ? "记录中 · 结束后保存"
        : connected && !sessionOpen
          ? "场次已结束 · 连接仍在线"
          : (snap.connection === "connecting"
            ? "连接中 · 未开始记录"
            : "已结束 · 可在历史场次查看");
    }
    safeText(els.dataSaveState, saveState);

    var historyAvailable = !(snap.history && snap.history.available === false);
    var sourceText = "本机来源正常";
    var sourceTone = "is-ok";
    if (snap.connection === "error") {
      sourceText = "本机来源异常";
      sourceTone = "is-warn";
    } else if (!connected) {
      sourceText = "本机来源待连接";
      sourceTone = "is-info";
    } else if (!snap.is_mock && !historyAvailable) {
      sourceText = "历史存储异常";
      sourceTone = "is-warn";
    }
    if (els.sourceSummary) {
      safeText(els.sourceSummary, sourceText);
      els.sourceSummary.className = "data-source-summary " + sourceTone;
    }
    setSourceState(els.sourceRoomTime, startedMs ? formatClock(startedMs / 1000) : "—", "");
    setSourceState(els.sourceRoomState, connected ? "正常" : "未连接", connected ? "ok" : "warn");
    setSourceState(
      els.sourceStreamTime,
      lastEventAt
        ? (sessionOpen && age != null ? formatLiveAge(age) : formatClock(lastEventAt))
        : "—",
      ""
    );
    setSourceState(
      els.sourceStreamState,
      snap.is_mock ? "调试预览" : (connected ? "已连接" : "未连接"),
      snap.is_mock ? "info" : (connected ? "ok" : "warn")
    );
    setSourceState(els.sourceProcessTime, "刚刚", "");
    setSourceState(els.sourceProcessState, "正常", "ok");
    setSourceState(
      els.sourceHistoryTime,
      snap.session && snap.session.id && !sessionOpen && lastEventAt
        ? formatClock(lastEventAt)
        : "—",
      ""
    );
    var historyText = snap.is_mock
      ? "调试预览不写入"
      : (!historyAvailable
        ? "不可用"
        : (snap.session && snap.session.id
          ? (sessionOpen ? "记录中" : "已写入")
          : "未开始"));
    var historyTone = snap.is_mock
      ? "info"
      : (!historyAvailable
        ? "warn"
        : (snap.session && snap.session.id ? (sessionOpen ? "info" : "ok") : ""));
    setSourceState(els.sourceHistoryState, historyText, historyTone);

    if (els.typeNote) {
      var platformNote = !platformProfile.supports_super_chat
        ? "抖音未提供 SC/舰长等价能力。"
        : "";
      safeText(els.typeNote, (pageOnly
        ? "仅统计本页打开后到达的消息；模拟事件不计入。"
        : "按本机已识别类型统计；模拟事件不计入。") + platformNote);
    }
    if (els.dataPostlude) {
      var closedSessionId = snap.session && snap.session.id && !sessionOpen && !snap.is_mock
        ? String(snap.session.id) : "";
      var canOpenHistory = !!closedSessionId &&
        (!snap.history || snap.history.available !== false);
      els.dataPostlude.hidden = !canOpenHistory;
      if (canOpenHistory) {
        if (state.postludeExportSessionId !== closedSessionId) {
          state.postludeExportSessionId = closedSessionId;
          state.postludeExporting = false;
          state.postludeExportSeq += 1;
          resetPostludeExportButtons();
          if (els.dataPostludeStatus) {
            els.dataPostludeStatus.hidden = true;
            els.dataPostludeStatus.className = "data-postlude-status";
            els.dataPostludeStatus.textContent = "";
          }
        }
        safeText(els.dataPostludeText, "本场已结束 · 可在历史场次查看");
        if (els.dataOpenHistory) {
          els.dataOpenHistory.setAttribute("data-session-id", closedSessionId);
        }
        if (els.dataComparePrevious) {
          els.dataComparePrevious.setAttribute("data-session-id", closedSessionId);
        }
      } else if (els.dataOpenHistory) {
        els.dataOpenHistory.removeAttribute("data-session-id");
        if (els.dataComparePrevious) {
          els.dataComparePrevious.removeAttribute("data-session-id");
        }
        state.postludeExporting = false;
        resetPostludeExportButtons();
        if (els.dataPostludeStatus) {
          els.dataPostludeStatus.hidden = true;
          els.dataPostludeStatus.className = "data-postlude-status";
          els.dataPostludeStatus.textContent = "";
        }
      }
    }
    var backendTypes = stats && stats.types && typeof stats.types === "object"
      ? stats.types
      : {};
    var typeCounts = {};
    TYPE_META.forEach(function (meta) {
      typeCounts[meta.key] = Math.max(
        Number(backendTypes[meta.key]) || 0,
        Number(metrics.counts[meta.key]) || 0
      );
    });
    renderTypeBars(metrics, typeCounts);
    renderActivity(metrics, {
      anchorSeconds: anchorSec,
      recent: recent,
      average: average,
      peak: peak,
      startedAt: startedMs,
      minuteDataAvailable: hasMinuteData,
      received: received,
      pageOnly: pageOnly,
      sessionOpen: sessionOpen
    });
    renderLiveNotices(buildLiveNotices(snap, {
      connected: connected,
      sessionOpen: sessionOpen,
      startedAt: startedMs,
      durationSec: durationSec,
      received: received,
      queue: queue,
      dropRate: dropRate,
      mockEvents: mockEvents,
      lastEventAt: lastEventAt
    }));
  }

  function init() {
    cache();
    if (!els.rail) return;
    ctx.shared.historyFilterActive = historyFilterActive;
    ctx.shared.historyRequestOptions = historyRequestOptions;
    ctx.shared.historyRangeBounds = historyRangeBounds;
    ctx.shared.syncHistoryPlatformOptions = syncHistoryPlatformOptions;
    ctx.shared.historyNumber = historyNumber;
    ctx.shared.historyDurationOf = historyDurationOf;
    ctx.shared.historyPerHour = historyPerHour;
    ctx.shared.historyRatio = historyRatio;
    ctx.shared.historyFormatDelta = historyFormatDelta;
    ctx.shared.historyTypeTotal = historyTypeTotal;
    ctx.shared.historyMinutesTotal = historyMinutesTotal;
    ctx.shared.historyPeakFiveMinute = historyPeakFiveMinute;
    ctx.shared.historyGiftText = historyGiftText;
    ctx.shared.historyMoneyView = historyMoneyView;
    ctx.shared.platformCapability = platformCapability;
    ctx.shared.historySessionMetrics = historySessionMetrics;
    ctx.root = {
      setView: setView,
      setDataTab: setDataTab,
      refreshSnapshot: refreshSnapshot,
      renderData: renderData,
      renderPicture: renderPicture,
      giftCurrency: giftCurrency,
      historyMoneyView: historyMoneyView,
      formatMoney: formatMoney,
      connectionLabel: connectionLabel,
      buildLiveNotices: buildLiveNotices,
      renderLiveNotices: renderLiveNotices,
      renderTypeBars: renderTypeBars,
      renderActivity: renderActivity,
      historyArbitraryCompareSupported: historyArbitraryCompareSupported,
      historyMultiCompareSupported: historyMultiCompareSupported,
      historyInsightsSupported: historyInsightsSupported,
      invalidateHistoryComparison: invalidateHistoryComparison,
      invalidateHistoryInsights: invalidateHistoryInsights,
      loadHistoryTrend: loadHistoryTrend,
      closeHistoryTrend: closeHistoryTrend,
      loadHistoryInsights: loadHistoryInsights,
      renderHistoryInsight: renderHistoryInsight,
      renderHistoryAnalysisExportActions: renderHistoryAnalysisExportActions,
      closeHistoryBaselinePicker: closeHistoryBaselinePicker,
      openHistoryMultiComparison: openHistoryMultiComparison,
      openHistoryCompare: openHistoryCompare,
      openHistorySession: openHistorySession,
      historyComparisonModel: historyComparisonModel,
      exportManageLinkHtml: exportManageLinkHtml
    };
    moveSettingsSource();
    bindNavigation();
    bindActions();
    bindSettingsNav();
    bindDataUi();
    syncHistoryFilterUi();
    document.addEventListener("mutai:message", receiveMessage);
    document.addEventListener("mutai:monitor-state", renderChrome);
    document.addEventListener("mutai:session-intent", handleSessionIntent);
    refreshCredentialSecurity(true);
    state.dataTab = loadDataTab();
    var initialView = loadView();
    state.historyRestoreId = initialView === "data" && state.dataTab === "history"
      ? ctx.modules.history.readHistorySelection()
      : "";
    setView(initialView, { focus: false });
    refreshSnapshot();
    pollTimer = setInterval(refreshSnapshot, 1000);
    window.__MUTAI_SHELL__ = {
      setView: setView,
      state: state,
      refresh: refreshSnapshot,
      renderData: renderData,
      renderPicture: renderPicture,
      giftCurrency: giftCurrency,
      platformLabel: platformLabel,
      platformMoneyComparable: platformMoneyComparable,
      historyComparisonModel: historyComparisonModel
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
