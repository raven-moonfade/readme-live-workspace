/* ============================================================
   ReadMe · 历史列表 / 详情 / 筛选域（2B-H1）
   依赖 shell-core 的 ctx；趋势/对比/导出暂通过 ctx.root 过渡。
   ============================================================ */
(function () {
  "use strict";
  var ctx = window.MutaiShell;
  if (!ctx) throw new Error("shell context missing");
  var state = ctx.state;
  var els = ctx.els;
  var TYPE_META = ctx.constants.TYPE_META;
  var HISTORY_SELECTION_KEY = "mutai-history-selection-v1";

  function readHistorySelection() {
    try {
      return String(localStorage.getItem(HISTORY_SELECTION_KEY) || "");
    } catch (e) {
      return "";
    }
  }

  function writeHistorySelection(id) {
    try {
      if (id) localStorage.setItem(HISTORY_SELECTION_KEY, String(id));
      else localStorage.removeItem(HISTORY_SELECTION_KEY);
    } catch (e) {}
  }

  function clearHistorySelection() {
    state.historyRestoreId = "";
    writeHistorySelection("");
  }
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
  var platformLabel = ctx.shared.platformLabel;
  var platformMoneyComparable = ctx.shared.platformMoneyComparable;
  var historyQueryKey = ctx.shared.historyQueryKey;

  function historyFilterActive() { return ctx.shared.historyFilterActive.apply(this, arguments); }
  function historyRequestOptions() { return ctx.shared.historyRequestOptions.apply(this, arguments); }
  function historyRangeBounds() { return ctx.shared.historyRangeBounds.apply(this, arguments); }
  function syncHistoryPlatformOptions() { return ctx.shared.syncHistoryPlatformOptions.apply(this, arguments); }

  function showHistoryEmpty(title, message) {
    if (els.historyList) els.historyList.innerHTML = "";
    if (els.historyMore) els.historyMore.hidden = true;
    if (els.historyEmpty) {
      els.historyEmpty.hidden = false;
      els.historyEmpty.innerHTML = "<b>" + escapeHtml(title) + "</b><span>" +
        escapeHtml(message) + "</span>";
    }
    if (els.historyError) els.historyError.hidden = true;
  }

  function showHistoryError(message) {
    if (els.historyList) els.historyList.innerHTML = "";
    if (els.historyMore) els.historyMore.hidden = true;
    if (els.historyEmpty) els.historyEmpty.hidden = true;
    if (els.historyError) els.historyError.hidden = false;
    safeText(els.historySummary, "历史记录暂不可用。");
    safeText(els.historyErrorText, message || "本场实时数据仍可用。");
  }

  function renderHistoryList() {
    if (state.historyMode === "trend") return;
    if (!els.historyList) return;
    var sessions = state.historySessions || [];
    if (els.historyManage) {
      els.historyManage.disabled = !!(state.snapshot && state.snapshot.is_mock);
    }
    if (els.historyCount) {
      var allTotal = Number(state.historyAllTotal) || 0;
      els.historyCount.hidden = allTotal <= 0;
      els.historyCount.textContent = String(allTotal);
    }
    if (state.historyFailed) {
      if (els.historyMore) els.historyMore.hidden = true;
      return;
    }
    if (!sessions.length && state.historyLoading) {
      if (els.historyMore) els.historyMore.hidden = true;
      if (els.historyEmpty) els.historyEmpty.hidden = true;
      if (els.historyError) els.historyError.hidden = true;
      safeText(els.historySummary, state.historyNotice || "正在读取本机历史…");
      return;
    }
    var hasMore = !!state.historyHasMore;
    var filtered = historyFilterActive();
    var summary = filtered
      ? (state.historyTotal
        ? "匹配 " + state.historyTotal + " 场；已显示 " + sessions.length + " 场。"
        : "没有匹配的历史场次。")
      : (state.historyTotal
        ? (hasMore
          ? "共 " + state.historyTotal + " 场已结束直播；已显示 " + sessions.length + " 场。"
          : "共 " + state.historyTotal + " 场已结束直播；点击查看聚合详情。")
        : "仅显示已结束场次。");
    safeText(els.historySummary, state.historyNotice || summary);
    if (els.historyMore) {
      els.historyMore.hidden = !hasMore;
      els.historyMore.disabled = state.historyLoading;
      els.historyMore.textContent = hasMore
        ? "加载更多（已显示 " + sessions.length + " / " +
          (filtered ? "匹配 " : "共 ") + state.historyTotal + " 场）"
        : "加载更多";
    }
    if (!sessions.length) {
      var preserve = state.historyPreserveDetailId &&
        String(state.historySelectedId || "") === String(state.historyPreserveDetailId);
      if (!preserve) resetHistoryDetail();
      showHistoryEmpty(
        filtered ? "没有匹配的场次" : "还没有历史场次",
        filtered ? "换个关键词或时间范围试试。" : "结束一场直播后，会在这里看到本机聚合记录。"
      );
      return;
    }
    var previousScrollTop = els.historyList.scrollTop;
    if (els.historyEmpty) els.historyEmpty.hidden = true;
    if (els.historyError) els.historyError.hidden = true;
    els.historyList.innerHTML = sessions.map(function (session) {
      var duration = Math.max(0, Number(session.ended_at || 0) - Number(session.started_at || 0));
      var active = state.historySelectedId === session.id;
      var platformBadge = state.historyPlatforms.length > 1
        ? '<span class="history-item-platform">' + escapeHtml(platformLabel(session.platform)) + '</span>'
        : "";
      return '<button class="history-item' + (active ? " is-active" : "") +
        '" type="button" data-history-id="' + escapeHtml(session.id) + '">' +
        '<span class="history-item-time">' + escapeHtml(formatDateTime(session.started_at)) + '</span>' +
        '<span class="history-item-title">' + escapeHtml(historyRoomLabel(session)) + platformBadge + '</span>' +
        '<span class="history-item-meta">房间 ' +
          escapeHtml(session.room_key || session.room_id || "—") +
          ' · ' + escapeHtml(formatDuration(duration)) + '</span>' +
        '<span class="history-item-stats">收到 ' + escapeHtml(session.real_received || 0) +
          ' · 朗读 ' + escapeHtml(session.real_spoken || 0) + '</span>' +
        '<span class="history-item-state">' + escapeHtml(historyEndLabel(session.end_reason)) +
          (Number(session.mock_received || 0) > 0
            ? ' · 模拟排除 ' + escapeHtml(session.mock_received)
            : '') +
        '</span>' +
      '</button>';
    }).join("");
    if (previousScrollTop > 0) els.historyList.scrollTop = previousScrollTop;
  }

  function loadHistory(force, options) {
    var opts = options && typeof options === "object" ? options : {};
    var append = !!opts.append;
    if (state.historyMode === "trend") return Promise.resolve();
    if (!els.historyList || state.historyLoading) return Promise.resolve();
    var requestKey = historyQueryKey();
    if (!force && !append && state.historyLoaded &&
        state.historyLoadedKey === requestKey &&
        Date.now() - state.historyLoadedAt < 3000) {
      renderHistoryList();
      return Promise.resolve();
    }
    var beforeSessions = (state.historySessions || []).slice();
    var snap = state.snapshot || {};
    if (snap.is_mock) {
      state.historyLoaded = true;
      state.historyLoadedAt = Date.now();
      state.historyFailed = false;
      state.historySessions = [];
      state.historyTotal = 0;
      state.historyAllTotal = 0;
      state.historyHasMore = false;
      state.historyCursor = null;
      state.historyLoadedKey = requestKey;
      if (els.historyCount) els.historyCount.hidden = true;
      safeText(els.historySummary, "调试预览不写入历史。");
      resetHistoryDetail();
      showHistoryEmpty("调试预览不写入历史", "连接真实直播间后，已结束场次会保存到这台电脑。");
      return Promise.resolve();
    }
    var api = ctx.api;
    if (typeof api.listSessions !== "function") {
      state.historyFailed = true;
      showHistoryError("后端未提供历史场次接口。");
      return Promise.resolve();
    }
    var filters = historyRequestOptions();
    if (filters.error) {
      state.historyNotice = filters.error;
      renderHistoryList();
      return Promise.resolve();
    }
    if (append && (!state.historyHasMore || !state.historyCursor)) {
      renderHistoryList();
      return Promise.resolve();
    }
    if (append) {
      filters.before_started_at = state.historyCursor.started_at;
      filters.before_id = state.historyCursor.id;
    }
    var requestSeq = ++state.historyRequestSeq;
    state.historyLoading = true;
    state.historyFailed = false;
    state.historyNotice = append ? "正在读取更多历史…" : "正在读取本机历史…";
    renderHistoryList();
    if (els.historyError) els.historyError.hidden = true;
    var previous = append ? state.historySessions.slice() : [];
    return Promise.resolve(api.listSessions(state.historyPageSize, 0, filters)).then(function (result) {
      if (requestSeq !== state.historyRequestSeq || requestKey !== historyQueryKey()) {
        state.historyReloadPending = true;
        return;
      }
      if (state.historyMode === "trend") return;
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : "历史场次接口不可用");
      }
      var incoming = Array.isArray(result.sessions) ? result.sessions : [];
      var known = new Set(previous.map(function (session) { return String(session.id); }));
      var merged = append ? previous.slice() : [];
      incoming.forEach(function (session) {
        var id = String(session && session.id || "");
        if (!id || known.has(id)) return;
        known.add(id);
        merged.push(session);
      });
      var total = Number(result.total);
      if (!isFinite(total) || total < 0) total = merged.length;
      var allTotal = Number(result.all_total);
      if (!isFinite(allTotal) || allTotal < 0) {
        allTotal = state.historyRange === "all" && !String(state.historyQuery || "").trim()
          ? total
          : (Number(state.historyAllTotal) || total);
      }
      state.historySessions = merged;
      state.historyTotal = total;
      state.historyAllTotal = allTotal;
      if (Array.isArray(result.platforms)) {
        state.historyPlatforms = result.platforms;
        syncHistoryPlatformOptions();
      }
      var nextCursor = result.next_cursor && result.next_cursor.id
        ? {
            started_at: Number(result.next_cursor.started_at),
            id: String(result.next_cursor.id)
          }
        : null;
      if (!nextCursor && merged.length) {
        var last = merged[merged.length - 1];
        nextCursor = { started_at: Number(last.started_at), id: String(last.id) };
      }
      state.historyCursor = nextCursor;
      state.historyHasMore = !!result.has_more && !!nextCursor;
      state.historyLoaded = true;
      state.historyLoadedAt = Date.now();
      state.historyLoadedKey = requestKey;
      state.historyFailed = false;
      state.historyNotice = "";
      if (Number(result.gap_events || 0) > 0) {
        state.historyNotice = (append ? "已加载更多；" : "") +
          (historyFilterActive()
            ? "匹配 " + state.historyTotal + " 场"
            : "共 " + state.historyTotal + " 场已结束直播") +
          "；本次运行有 " + result.gap_events + " 个写入缺口。";
      } else if (result.stale) {
        state.historyNotice = (append ? "已加载更多；" : "") +
          "历史写入仍在落盘，列表可能暂时不包含最新场次。";
      }
      renderHistoryList();
      if (!append) restoreHistorySelection();
    }).catch(function (error) {
      if (requestSeq !== state.historyRequestSeq || requestKey !== historyQueryKey()) {
        state.historyReloadPending = true;
        return;
      }
      if (append && previous.length) {
        state.historySessions = previous;
        state.historyNotice = "加载更多失败，已保留当前列表：" +
          (error && error.message ? error.message : "未知错误");
        renderHistoryList();
      } else {
        if (beforeSessions.length) {
          state.historySessions = beforeSessions;
          state.historyFailed = false;
          state.historyNotice = "刷新失败，已保留当前列表：" +
            (error && error.message ? error.message : "未知错误");
          renderHistoryList();
        } else {
          state.historyLoaded = false;
          state.historyFailed = true;
          state.historyNotice = "";
          if (!state.historySelectedId) resetHistoryDetail();
          showHistoryError("历史记录暂不可用：" +
            (error && error.message ? error.message : "未知错误") + "。本场实时数据仍可用。");
        }
      }
    }).then(function () {
      state.historyLoading = false;
      if (state.historyMode === "trend") {
        state.historyReloadPending = false;
        return;
      }
      if (state.historyReloadPending || requestKey !== historyQueryKey()) {
        state.historyReloadPending = false;
        loadHistory(true);
        return;
      }
      if (!state.historyFailed) renderHistoryList();
    });
  }

  function selectHistorySession(sessionId, options) {
    var id = String(sessionId || "");
    var opts = options && typeof options === "object" ? options : {};
    if (!id) return;
    state.historyRestoreId = "";
    writeHistorySelection(id);
    ctx.root.invalidateHistoryComparison();
    state.historyDetailSession = null;
    state.historyCompareScrollTop = 0;
    state.historyCompareSource = "previous";
    state.historyCompareEntry = "previous";
    if (state.historyMode === "trend") {
      state.historyMode = "detail";
      state.historyTrendSeq += 1;
      state.historyTrendLoading = false;
      state.historyTrendReloadPending = false;
      state.historyTrendFocusPending = false;
      if (els.historyLayout) els.historyLayout.classList.remove("is-trend-mode");
      if (els.historyTrendBtn) {
        els.historyTrendBtn.classList.remove("is-active");
        els.historyTrendBtn.setAttribute("aria-pressed", "false");
      }
    }
    state.historySelectedId = id;
    if (els.historyLayout) els.historyLayout.classList.add("is-detail-open");
    if (els.historyNoSelection) els.historyNoSelection.hidden = true;
    if (els.historyDetail) {
      els.historyDetail.hidden = false;
      els.historyDetail.innerHTML = '<div class="history-detail-loading">正在读取场次详情…</div>';
    }
    renderHistoryList();
    var api = ctx.api;
    if (typeof api.getSession !== "function") {
      showHistoryDetailError("后端未提供场次详情接口。");
      return;
    }
    return Promise.resolve(api.getSession(id)).then(function (result) {
      if (state.historySelectedId !== id) return;
      if (!result || result.ok === false || !result.session) {
        throw new Error(result && result.error ? result.error : "场次不存在");
      }
      renderHistoryDetail(result.session);
      ctx.root.loadHistoryInsights(id);
      if (opts.focus !== false) focusHistoryDetail();
    }).catch(function (error) {
      if (state.historySelectedId !== id) return;
      showHistoryDetailError("读取场次详情失败：" +
        (error && error.message ? error.message : "未知错误"));
    });
  }

  function restoreHistorySelection() {
    var id = String(state.historyRestoreId || "");
    if (!id || state.dataTab !== "history" || state.view !== "data") return;
    state.historyRestoreId = "";
    if (state.historySelectedId) return;
    var present = (state.historySessions || []).some(function (session) {
      return String(session && session.id) === id;
    });
    if (!present) {
      clearHistorySelection();
      return;
    }
    selectHistorySession(id, { focus: false });
  }

  function openHistorySession(sessionId, options) {
    var id = String(sessionId || "");
    if (!id) return;
    var opts = options && typeof options === "object" ? options : {};
    ctx.root.setView("data");
    if (state.historyMode === "trend") ctx.root.closeHistoryTrend();
    ctx.root.setDataTab("history", {});
    state.historyPreserveDetailId = id;
    loadHistory(true).then(function () {
      var present = (state.historySessions || []).some(function (session) {
        return String(session && session.id) === id;
      });
      if (present) return;
      state.historyQuery = "";
      state.historyRange = "all";
      state.historyPlatform = "";
      state.historyFromValue = "";
      state.historyToValue = "";
      syncHistoryFilterUi();
      return loadHistory(true);
    }).then(function () {
      return selectHistorySession(id);
    }).then(function () {
      if (opts.compare &&
          String(state.historySelectedId || "") === id &&
          state.historyDetailSession &&
          String(state.historyDetailSession.id || "") === id &&
          state.historyMode === "detail") {
        ctx.root.openHistoryCompare();
      }
    }).catch(function (error) {
      showHistoryDetailError("读取本场历史失败：" +
        (error && error.message ? error.message : "未知错误"));
    });
  }

  function setPostludeStatus(text, tone) {
    if (!els.dataPostludeStatus) return;
    if (!text) {
      els.dataPostludeStatus.hidden = true;
      els.dataPostludeStatus.className = "data-postlude-status";
      els.dataPostludeStatus.setAttribute("aria-live", "polite");
      els.dataPostludeStatus.textContent = "";
      return;
    }
    els.dataPostludeStatus.hidden = false;
    els.dataPostludeStatus.className = "data-postlude-status is-" + (tone || "busy");
    els.dataPostludeStatus.setAttribute(
      "role",
      tone === "error" ? "alert" : "status"
    );
    els.dataPostludeStatus.setAttribute(
      "aria-live",
      tone === "error" ? "assertive" : "polite"
    );
    if (tone === "ok") {
      els.dataPostludeStatus.innerHTML = text;
    } else {
      els.dataPostludeStatus.textContent = text;
    }
  }

  function resetPostludeExportButtons() {
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-postlude-export]"),
      function (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    );
  }

  function exportPostludeSession(format, trigger) {
    var id = String(state.postludeExportSessionId || "");
    var normalized = String(format || "json").toLowerCase() === "csv" ? "csv" : "json";
    if (!id || state.postludeExporting) return;
    var api = ctx.api;
    if (typeof api.exportSession !== "function") {
      setPostludeStatus("当前后端未提供单场导出。", "error");
      return;
    }
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll("[data-postlude-export]")
    );
    var seq = ++state.postludeExportSeq;
    state.postludeExporting = true;
    buttons.forEach(function (button) { button.disabled = true; });
    if (trigger) trigger.setAttribute("aria-busy", "true");
    setPostludeStatus("正在导出 " + normalized.toUpperCase() + "…", "busy");
    Promise.resolve(api.exportSession(id, normalized)).then(function (result) {
      if (seq !== state.postludeExportSeq ||
          state.postludeExportSessionId !== id) return;
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : "导出失败");
      }
      setPostludeStatus(
        "已导出 " + escapeHtml(String(result.format || normalized).toUpperCase()) +
          " · <code>" + escapeHtml(result.path || "文件已写入") + "</code>" +
          ctx.root.exportManageLinkHtml(),
        "ok"
      );
    }).catch(function (error) {
      if (seq !== state.postludeExportSeq ||
          state.postludeExportSessionId !== id) return;
      setPostludeStatus(
        "导出失败：" + (error && error.message ? error.message : "未知错误"),
        "error"
      );
    }).then(function () {
      if (seq !== state.postludeExportSeq) return;
      state.postludeExporting = false;
      resetPostludeExportButtons();
      if (trigger && document.contains(trigger)) trigger.removeAttribute("aria-busy");
      if (els.dataPostludeStatus && document.contains(els.dataPostludeStatus)) {
        try { els.dataPostludeStatus.focus({ preventScroll: true }); }
        catch (e) { els.dataPostludeStatus.focus(); }
      }
    });
  }

  function showHistoryDetailError(message) {
    if (!els.historyDetail) return;
    els.historyDetail.hidden = false;
    els.historyDetail.innerHTML = '<div class="history-detail-empty" role="alert"><b>无法读取详情</b><span>' +
      escapeHtml(message) + '</span><button class="btn btn-ghost btn-sm" type="button" data-history-back>返回历史场次</button></div>';
    focusHistoryDetail();
  }

  function focusHistoryDetail() {
    if (!els.historyDetail) return;
    var target = els.historyDetail.querySelector("[data-history-focus]") ||
      els.historyDetail.querySelector("[data-history-back]");
    if (target) {
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    }
  }

  function resetHistoryDetail() {
    state.historySelectedId = null;
    state.historyPreserveDetailId = "";
    state.historyDetailSession = null;
    state.historyView = "overview";
    state.historyCompare = null;
    state.historyCompareSource = "previous";
    state.historyCompareEntry = "previous";
    state.historyCompareLoading = false;
    state.historyCompareRequestSeq += 1;
    state.historyCompareScrollTop = 0;
    state.historyMultiCompareSeq += 1;
    state.historyMultiCompareLoading = false;
    state.historyMultiCompareData = null;
    state.historyMultiCompareError = "";
    ctx.root.invalidateHistoryInsights();
    if (state.historyBaselineOpen) {
      ctx.root.closeHistoryBaselinePicker({ restoreFocus: false });
    }
    if (state.historyMode !== "trend") {
      if (els.historyLayout) els.historyLayout.classList.remove("is-detail-open");
      if (els.historyDetail) {
        els.historyDetail.hidden = true;
        els.historyDetail.innerHTML = "";
      }
      if (els.historyNoSelection) els.historyNoSelection.hidden = false;
    }
  }

  function renderHistoryDetail(session) {
    if (!els.historyDetail) return;
    state.historyDetailSession = session;
    state.historyView = "overview";
    state.historyCompare = null;
    state.historyCompareLoading = false;
    state.historyCompareRequestSeq += 1;
    state.historyMultiCompareSeq += 1;
    state.historyMultiCompareLoading = false;
    state.historyMultiCompareData = null;
    state.historyMultiCompareError = "";
    var duration = Math.max(0, Number(session.ended_at || 0) - Number(session.started_at || 0));
    var realReceived = Number(session.real_received) || 0;
    var realSpoken = Number(session.real_spoken) || 0;
    var realDropped = Number(session.real_dropped) || 0;
    var droppedBasis = session.real_dropped_known === false ? " · 旧口径" : "";
    var mockReceived = Number(session.mock_received) || 0;
    var uniqueUsers = Number(session.unique_users) || 0;
    var types = session.types && typeof session.types === "object" ? session.types : {};
    var maxType = Math.max(1, ...TYPE_META.map(function (meta) {
      return Number(types[meta.key]) || 0;
    }));
    var typeRows = TYPE_META.map(function (meta) {
      var count = Number(types[meta.key]) || 0;
      var width = count ? Math.max(4, Math.round(count / maxType * 100)) : 0;
      return '<div class="type-bar-row"><span>' + meta.label +
        '</span><span class="type-bar-track"><i style="--bar-w:' + width +
        '%;--bar-c:' + meta.color + '"></i></span><b>' + count + '</b></div>';
    }).join("");

    var minuteSource = Array.isArray(session.minutes) ? session.minutes : [];
    var minuteMap = new Map();
    minuteSource.forEach(function (item) {
      minuteMap.set(Number(item.minute), Number(item.count) || 0);
    });
    var startBucket = Math.floor(Number(session.started_at || 0) / 300);
    var endBucket = Math.max(startBucket, Math.floor(Number(session.ended_at || session.started_at || 0) / 300));
    var bucketCount = endBucket - startBucket + 1;
    var stride = Math.max(1, Math.ceil(bucketCount / 96));
    var points = [];
    var totalActivity = 0;
    for (var bucket = startBucket; bucket <= endBucket; bucket += stride) {
      var count = 0;
      for (var sub = 0; sub < stride; sub += 1) {
        for (var m = 0; m < 5; m += 1) {
          count += minuteMap.get((bucket + sub) * 5 + m) || 0;
        }
      }
      points.push(count);
      totalActivity += count;
    }
    var maxActivity = Math.max(1, ...points);
    var activityHtml = totalActivity
      ? points.map(function (count, index) {
          var height = count ? Math.max(4, Math.round(count / maxActivity * 112)) : 2;
          return '<i class="activity-bar' + (index === points.length - 1 ? " is-current" : "") +
            '" style="--h:' + height + 'px"></i>';
        }).join("")
      : "";
    var intervalMinutes = stride * 5;
    var moneyView = ctx.shared.historyMoneyView(session);

    els.historyDetail.hidden = false;
    els.historyDetail.innerHTML =
      '<div class="history-detail-head">' +
        '<button class="btn btn-ghost btn-sm history-back-btn" type="button" data-history-back>返回历史场次</button>' +
        '<div class="history-detail-title"><span class="workspace-eyebrow">' +
          escapeHtml(historyEndLabel(session.end_reason)) + '</span><h2 tabindex="-1" data-history-focus>' +
          escapeHtml(historyRoomLabel(session)) + '</h2><p>' +
          escapeHtml(platformLabel(session.platform)) + ' · ' + escapeHtml(session.room_key || session.room_id) +
          ' · ' + escapeHtml(formatDateTime(session.started_at)) +
          ' → ' + escapeHtml(formatDateTime(session.ended_at)) + '</p></div>' +
        '<div class="history-detail-actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-history-compare aria-label="对比同平台同房间的上一场已结束直播">对比上一场</button>' +
          (ctx.root.historyArbitraryCompareSupported()
            ? '<button class="btn btn-ghost btn-sm" type="button" data-history-baseline aria-haspopup="dialog" aria-controls="historyBaselineModal" aria-label="选择同平台同房间的对比场，可单选或多选">' +
              (ctx.root.historyMultiCompareSupported() ? "选择对比场…" : "选择基准场…") + '</button>'
            : '') +
          '<button class="btn btn-ghost btn-sm" type="button" data-history-export="json" data-history-id="' +
            escapeHtml(session.id) + '">导出 JSON</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-history-export="csv" data-history-id="' +
            escapeHtml(session.id) + '">导出 CSV</button>' +
          '<button class="btn btn-danger btn-sm history-delete-btn" type="button" data-history-delete="' +
            escapeHtml(session.id) + '">删除本场</button>' +
        '</div>' +
      '</div>' +
      '<p class="history-compare-status" data-history-compare-status role="status" aria-live="polite" tabindex="-1" hidden></p>' +
      '<p class="history-export-status" data-history-export-status role="status" aria-live="polite" hidden></p>' +
      '<div class="history-detail-metrics">' +
        '<div><span>收到</span><b>' + realReceived + '</b></div>' +
        '<div><span>开始朗读</span><b>' + realSpoken + '</b></div>' +
        '<div><span>硬丢弃' + escapeHtml(droppedBasis) + '</span><b>' + realDropped + '</b></div>' +
        '<div><span>UID 去重</span><b>' + uniqueUsers + '</b></div>' +
      '</div>' +
      '<div class="history-insight-host" data-history-insight-host></div>' +
      '<div class="history-detail-grid">' +
        '<section class="history-detail-section"><div class="workspace-card-head"><div>' +
          '<span class="workspace-eyebrow">结构</span><h3>类型分布</h3></div></div>' +
          '<div class="type-bars">' + typeRows + '</div></section>' +
        '<section class="history-detail-section"><div class="workspace-card-head"><div>' +
          '<span class="workspace-eyebrow">节奏</span><h3>每 ' + intervalMinutes +
          ' 分钟</h3></div><span class="workspace-state is-neutral">' + totalActivity +
          ' 条</span></div><div class="activity-chart' + (activityHtml ? "" : " is-empty") +
          '">' + (activityHtml || "暂无分钟数据") + '</div></section>' +
      '</div>' +
      '<div class="history-quality-grid">' +
        '<div><span>时长</span><b>' + escapeHtml(formatDuration(duration)) + '</b></div>' +
        '<div><span>最后写入</span><b>' + escapeHtml(formatDateTime(session.last_event_at)) + '</b></div>' +
        '<div><span>' + escapeHtml(moneyView.giftLabel) + '</span><b>' + escapeHtml(moneyView.giftText) + '</b></div>' +
        '<div><span>' + escapeHtml(moneyView.scLabel) + '</span><b>' + escapeHtml(moneyView.scText) + '</b></div>' +
        '<div><span>模拟隔离</span><b>' + mockReceived + ' 条</b></div>' +
        '<div><span>结束方式</span><b>' + escapeHtml(historyEndLabel(session.end_reason)) + '</b></div>' +
      '</div>' +
      '<p class="workspace-note">仅本机聚合数据；历史不包含弹幕正文、用户名与原始 UID。' +
        escapeHtml(moneyView.note) +
      '</p>';
    ctx.root.renderHistoryInsight();
  }

  function closeHistoryDetail() {
    var returnId = state.historySelectedId;
    clearHistorySelection();
    resetHistoryDetail();
    renderHistoryList();
    if (returnId && els.historyList) {
      requestAnimationFrame(function () {
        var items = els.historyList.querySelectorAll("[data-history-id]");
        var item = null;
        for (var i = 0; i < items.length; i += 1) {
          if (items[i].getAttribute("data-history-id") === returnId) {
            item = items[i];
            break;
          }
        }
        if (item) item.focus();
        else if (els.dataTabs && els.dataTabs[1]) els.dataTabs[1].focus();
      });
    }
  }

  function syncHistoryFilterUi() {
    syncHistoryPlatformOptions();
    if (els.historySearch && els.historySearch.value !== state.historyQuery) {
      els.historySearch.value = state.historyQuery;
    }
    if (els.historyRange) els.historyRange.value = state.historyRange;
    if (els.historyRange) {
      var allRangeOption = els.historyRange.querySelector('option[value="all"]');
      if (allRangeOption) {
        allRangeOption.disabled = state.historyMode === "trend";
        allRangeOption.textContent = state.historyMode === "trend"
          ? (state.historyTrendGranularity === "hour"
            ? "全部时间（小时趋势使用近 7 天）"
            : "全部时间（趋势使用近 365 天）")
          : "全部时间";
      }
    }
    if (els.historyPlatform) els.historyPlatform.value = state.historyPlatform;
    if (els.historyCustomRange) {
      els.historyCustomRange.hidden = state.historyRange !== "custom";
    }
    if (els.historyFilterReset) {
      els.historyFilterReset.hidden = !historyFilterActive();
    }
  }

  function applyHistoryFilters() {
    state.historyPreserveDetailId = "";
    clearHistorySelection();
    if (state.historyMode === "trend" && state.historyRange === "all") {
      state.historyRange = state.historyTrendGranularity === "hour" ? "7d" : "365d";
    }
    var bounds = historyRangeBounds();
    syncHistoryFilterUi();
    if (state.historyMode === "trend") {
      if (state.historySearchTimer) {
        clearTimeout(state.historySearchTimer);
        state.historySearchTimer = 0;
      }
      state.historyTrendSeq += 1;
      state.historyTrendLoading = false;
      state.historyTrendReloadPending = false;
      state.historyTrendRoomKey = "";
      state.historyTrendRooms = [];
      state.historyTrendScope = null;
      state.historyTrendData = null;
      state.historyTrendLoadedKey = "";
      state.historyListNeedsTop = true;
      ctx.root.loadHistoryTrend(true);
      return;
    }
    if (bounds.error) {
      state.historyNotice = bounds.error;
      renderHistoryList();
      return;
    }
    state.historyLoaded = false;
    state.historyLoadedKey = "";
    if (els.historyList) els.historyList.scrollTop = 0;
    state.historyListNeedsTop = false;
    state.historyReloadPending = false;
    resetHistoryDetail();
    if (state.historyLoading) {
      state.historyReloadPending = true;
      return;
    }
    state.historySessions = [];
    state.historyTotal = 0;
    state.historyHasMore = false;
    state.historyCursor = null;
    loadHistory(true);
  }

  function clearHistoryFilters() {
    if (state.historySearchTimer) {
      clearTimeout(state.historySearchTimer);
      state.historySearchTimer = 0;
    }
    state.historyQuery = "";
    state.historyRange = "all";
    state.historyPlatform = "";
    state.historyFromValue = "";
    state.historyToValue = "";
    if (els.historyFrom) els.historyFrom.value = "";
    if (els.historyTo) els.historyTo.value = "";
    applyHistoryFilters();
  }

  function historyTrendKey() {
    return historyQueryKey() + "|" + String(state.historyTrendRoomKey || "") +
      "|" + String(state.historyTrendGranularity || "day");
  }

  function historyTrendBounds() {
    if (state.historyRange === "all") {
      state.historyRange = state.historyTrendGranularity === "hour" ? "7d" : "365d";
      syncHistoryFilterUi();
    }
    return historyRangeBounds();
  }

  function normalizeHistoryTrendRangeForGranularity() {
    if (state.historyTrendGranularity === "hour" &&
        state.historyRange !== "today" &&
        state.historyRange !== "7d") {
      state.historyRange = "7d";
      syncHistoryFilterUi();
    }
  }

  function historyTrendMetricLabel(metric) {
    if (metric === "spoken_rate") return "开始朗读率";
    if (metric === "drop_rate") return "硬丢弃率";
    return "收到 / 小时";
  }

  function historyTrendNormalizeGranularity(value) {
    return value === "hour" || value === "week" ? value : "day";
  }

  function historyTrendGranularityUnit(granularity) {
    return granularity === "hour" ? "小时" : (granularity === "week" ? "周" : "日");
  }

  function historyTrendGranularityButton(granularity) {
    return granularity === "hour" ? "时" : (granularity === "week" ? "周" : "日");
  }

  function historyTrendGranularityLabel(granularity) {
    if (granularity === "hour") return "按开播小时";
    return granularity === "week" ? "按开播周" : "按开播日";
  }

  function historyTrendGranularitySupported(granularity) {
    if (granularity === "day") return true;
    var caps = state.snapshot && state.snapshot.history &&
      state.snapshot.history.capabilities;
    var supported = caps && Array.isArray(caps.trend_granularities)
      ? caps.trend_granularities
      : ["day"];
    return supported.indexOf(granularity) >= 0;
  }

  function historyTrendGranularityOptions() {
    return ["hour", "day", "week"].filter(historyTrendGranularitySupported);
  }

  function renderHistoryTrendGranularityToggle(activeGranularity) {
    var options = historyTrendGranularityOptions();
    if (options.length <= 1) return "";
    var selected = activeGranularity == null
      ? historyTrendNormalizeGranularity(state.historyTrendGranularity)
      : historyTrendNormalizeGranularity(activeGranularity);
    if (options.indexOf(selected) < 0) {
      selected = options.indexOf(state.historyTrendGranularity) >= 0
        ? state.historyTrendGranularity
        : "day";
    }
    return '<div class="history-trend-granularity" role="group" aria-label="趋势聚合粒度">' +
      options.map(function (value) {
        return '<button type="button" data-trend-granularity="' + value +
          '" class="' + (selected === value ? "is-active" : "") +
          '" aria-pressed="' + (selected === value ? "true" : "false") +
          '" aria-label="' + historyTrendGranularityLabel(value) + '">' +
          historyTrendGranularityButton(value) + '</button>';
      }).join("") + '</div>';
  }

  function historyTrendBucketLabel(bucket, granularity) {
    if (!bucket) return "—";
    if (granularity === "hour") {
      return bucket.hour || bucket.bucket_label || "—";
    }
    if (granularity === "week") {
      return bucket.week_label || bucket.iso_week || bucket.bucket_label || "—";
    }
    return bucket.day || bucket.bucket_label || "—";
  }

  function historyTrendBucketShortLabel(bucket, granularity) {
    if (!bucket) return "";
    if (granularity === "hour") {
      return String(bucket.hour || bucket.bucket_label || "").slice(5);
    }
    if (granularity === "week") {
      return String(bucket.week_start_date || "").slice(5);
    }
    return String(bucket.day || "").slice(5);
  }

  function historyTrendBucketTooltip(bucket, granularity) {
    if (!bucket) return "";
    if (granularity === "hour") {
      return String(bucket.hour || bucket.bucket_label || "");
    }
    if (granularity === "week") {
      return [bucket.iso_week, bucket.week_label].filter(Boolean).join(" · ");
    }
    return String(bucket.day || "");
  }

  function historyTrendMetricValue(bucket, metric) {
    if (!bucket) return null;
    var duration = Number(bucket.duration_seconds) || 0;
    var received = Number(bucket.real_received) || 0;
    if (metric === "received_per_hour") {
      return duration > 0 ? received / (duration / 3600) : null;
    }
    if (metric === "spoken_rate") {
      return received > 0 ? (Number(bucket.real_spoken) || 0) / received : null;
    }
    return received > 0 ? (Number(bucket.real_dropped) || 0) / received : null;
  }

  function historyTrendValueText(value, metric) {
    if (value == null || !isFinite(value)) return "—";
    if (metric === "received_per_hour") return value.toFixed(1);
    return (value * 100).toFixed(1) + "%";
  }

  function renderHistoryTrendChart(data) {
    var buckets = Array.isArray(data.buckets) ? data.buckets : [];
    var metric = state.historyTrendMetric;
    var granularity = historyTrendNormalizeGranularity(data && data.granularity);
    var granularityText = historyTrendGranularityUnit(granularity);
    var values = buckets.map(function (bucket) {
      return historyTrendMetricValue(bucket, metric);
    });
    var valid = values.filter(function (value) { return value != null && isFinite(value); });
    if (valid.length < 4) {
      return '<div class="history-trend-empty">不足 4 个可计算' +
        granularityText + '，暂不判断趋势。</div>';
    }
    var width = 760;
    var height = 238;
    var left = 44;
    var right = 14;
    var top = 18;
    var bottom = 30;
    var plotW = width - left - right;
    var plotH = height - top - bottom;
    var maxValue = Math.max.apply(null, valid);
    if (metric !== "received_per_hour") maxValue = 1;
    if (!isFinite(maxValue) || maxValue <= 0) maxValue = 1;
    var x = function (index) {
      return left + (buckets.length <= 1 ? plotW / 2 : (plotW * index / (buckets.length - 1)));
    };
    var y = function (value) {
      return top + plotH * (1 - value / maxValue);
    };
    var paths = [];
    var current = [];
    values.forEach(function (value, index) {
      if (value == null || !isFinite(value)) {
        if (current.length > 1) paths.push(current.slice());
        current = [];
        return;
      }
      current.push([x(index), y(value)]);
    });
    if (current.length > 1) paths.push(current);
    var pathHtml = paths.map(function (points) {
      return '<path d="' + points.map(function (point, index) {
        return (index ? "L" : "M") + point[0].toFixed(1) + " " + point[1].toFixed(1);
      }).join(" ") + '"></path>';
    }).join("");
    var pointsHtml = values.map(function (value, index) {
      if (value == null || !isFinite(value)) return "";
      var bucket = buckets[index];
      return '<circle cx="' + x(index).toFixed(1) + '" cy="' + y(value).toFixed(1) +
        '" r="3" class="' + (bucket.partial ? "is-partial" : "") +
        '"><title>' + escapeHtml(historyTrendBucketTooltip(bucket, granularity) + " · " +
        historyTrendValueText(value, metric) + " · " + bucket.sessions + " 场") + '</title></circle>';
    }).join("");
    var gridHtml = [0, 0.25, 0.5, 0.75, 1].map(function (ratio) {
      var gy = top + plotH * ratio;
      var label = metric === "received_per_hour"
        ? (maxValue * (1 - ratio)).toFixed(0)
        : Math.round((1 - ratio) * 100) + "%";
      return '<line x1="' + left + '" y1="' + gy.toFixed(1) + '" x2="' +
        (width - right) + '" y2="' + gy.toFixed(1) + '" class="trend-grid-line"></line>' +
        '<text x="' + (left - 10) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end">' +
        escapeHtml(label) + '</text>';
    }).join("");
    var labelIndexes = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1];
    var labels = labelIndexes.filter(function (value, index, all) {
      return value >= 0 && all.indexOf(value) === index;
    }).map(function (index) {
      return '<text x="' + x(index).toFixed(1) + '" y="' + (height - 9) +
        '" text-anchor="middle">' + escapeHtml(historyTrendBucketShortLabel(
          buckets[index], granularity
        )) + '</text>';
    }).join("");
    return '<svg class="history-trend-svg" viewBox="0 0 ' + width + ' ' + height +
      '" role="img" aria-label="' + escapeHtml(historyTrendMetricLabel(metric) +
      '趋势，共 ' + valid.length + ' 个可计算' +
      granularityText) + '">' +
      gridHtml + '<g class="trend-labels">' + labels + '</g>' +
      '<g class="trend-line">' + pathHtml + '</g><g class="trend-points">' +
      pointsHtml + '</g></svg>';
  }

  function renderHistoryTrendRoomPicker(data, options) {
    var rooms = Array.isArray(data && data.rooms) ? data.rooms : [];
    if (!rooms.length) return "";
    var opts = options && typeof options === "object" ? options : {};
    var scope = data.scope && typeof data.scope === "object" ? data.scope : null;
    var selectedKey = String(state.historyTrendRoomKey || (scope && scope.room_key) || "");
    var selectedPlatform = String(state.historyPlatform || (scope && scope.platform) || "");
    var selectedIndex = rooms.findIndex(function (room) {
      return String(room.room_key) === selectedKey &&
        String(room.platform) === selectedPlatform;
    });
    if (selectedIndex < 0) {
      selectedIndex = rooms.findIndex(function (room) {
        return String(room.room_key) === selectedKey;
      });
    }
    var optionsHtml = rooms.map(function (room, index) {
      var title = room.room_title || "未命名直播间";
      return '<option value="' + index + '"' +
        (index === selectedIndex ? " selected" : "") + '>' +
        escapeHtml(title + " · " + platformLabel(room.platform) + " · " +
          room.room_key + " · " + room.sessions + " 场") +
        '</option>';
    }).join("");
    if (opts.required || rooms.length > 1) {
      if (opts.required && selectedIndex < 0) {
        optionsHtml = '<option value="" selected disabled>选择一个直播间…</option>' + optionsHtml;
      }
      return '<label class="history-trend-room-picker"><span>分析直播间</span>' +
        '<select data-trend-room-select aria-label="选择趋势分析的直播间">' +
        optionsHtml + '</select><small>趋势只分析一个平台下的一个直播间，不跨房间合并。</small></label>';
    }
    var room = rooms[0];
    return '<div class="history-trend-room-picker is-static"><span>分析直播间</span>' +
      '<b>' + escapeHtml(room.room_title || "未命名直播间") + '</b>' +
      '<small>' + escapeHtml(platformLabel(room.platform) + " · " + room.room_key +
        " · " + room.sessions + " 场") + '</small></div>';
  }

  function renderHistoryTrendScopeRequired(data) {
    if (!els.historyDetail) return;
    var rooms = Array.isArray(data.rooms) ? data.rooms : [];
    state.historyTrendRooms = rooms;
    state.historyTrendScope = null;
    state.historyTrendData = null;
    state.historyTrendLoadedKey = "";
    els.historyDetail.hidden = false;
    var reason = data.error || "当前筛选范围包含多个直播间，请先确定分析对象。";
    var unscopedNote = Number(data.unscoped_sessions || 0) > 0
      ? '<p class="history-trend-warning">另有 ' + escapeHtml(data.unscoped_sessions) +
        ' 场历史缺少房间标识，不会计入任何单房间趋势。</p>'
      : "";
    els.historyDetail.innerHTML =
      '<div class="history-detail-head">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-history-trend-back>返回场次</button>' +
        '<div class="history-detail-title"><span class="workspace-eyebrow">只读聚合 · 单房间</span>' +
        '<h2 tabindex="-1" data-history-trend-focus>历史趋势</h2><p>' +
        escapeHtml(reason) + '</p></div></div>' +
      '<div class="history-trend-scope-gate">' +
        '<p>趋势不会把不同直播间合并成一条线。选择一个直播间后，按开播小时、日期或自然周聚合该房间的真实消息。</p>' +
        renderHistoryTrendRoomPicker(data, { required: true }) +
        unscopedNote +
      '</div>' +
      '<p class="workspace-note">房间范围由平台与房间标识共同确定；切换平台或日期后需要重新选择。</p>';
    focusHistoryTrendTarget(true);
  }

  function renderHistoryTrend(data) {
    if (!els.historyDetail) return;
    var counts = data.counts || {};
    if (!data.scope || !data.scope.room_key) {
      renderHistoryTrendMessage(
        Number(counts.active_sessions || 0) > 0
          ? "当前范围没有已结束场次；进行中的场次不会进入趋势。"
          : "当前范围没有已结束场次。调整日期或平台后再试。",
        false,
        true
      );
      return;
    }
    var totals = data.totals || {};
    var buckets = Array.isArray(data.buckets) ? data.buckets : [];
    var granularity = historyTrendNormalizeGranularity(data.granularity);
    var granularityText = historyTrendGranularityUnit(granularity);
    var bucketCount = counts.bucket_count == null
      ? buckets.length : Number(counts.bucket_count);
    var totalDuration = Number(totals.duration_seconds) || 0;
    var receivedPerHour = totalDuration > 0
      ? Number(totals.real_received || 0) / (totalDuration / 3600)
      : null;
    var spokenRate = Number(totals.real_received || 0) > 0
      ? Number(totals.real_spoken || 0) / Number(totals.real_received)
      : null;
    var dropRate = Number(totals.real_received || 0) > 0
      ? Number(totals.real_dropped || 0) / Number(totals.real_received)
      : null;
    var platformText = (data.filters && data.filters.platform)
      ? platformLabel(data.filters.platform)
      : "全部平台";
    var scope = data.scope && typeof data.scope === "object" ? data.scope : {};
    var roomText = scope.room_title || "未命名直播间";
    var queryText = data.filters && data.filters.query
      ? " · 搜索「" + escapeHtml(data.filters.query) + "」"
      : "";
    var quality = data.quality || {};
    var flags = [];
    if (quality.short_sessions) flags.push("短样本 " + quality.short_sessions + " 场");
    if (quality.incomplete_sessions) flags.push("可能不完整 " + quality.incomplete_sessions + " 场");
    if (quality.replaced_sessions) flags.push("切换场次 " + quality.replaced_sessions + " 场");
    if (quality.unknown_end_sessions) flags.push("未知结束方式 " + quality.unknown_end_sessions + " 场");
    if (quality.inconsistent_sessions) flags.push("统计不一致 " + quality.inconsistent_sessions + " 场");
    if (quality.mock_sessions) flags.push("含模拟数据 " + quality.mock_sessions + " 场");
    if (quality.unscoped_sessions) flags.push("缺少房间标识 " + quality.unscoped_sessions + " 场");
    if (Number(totals.legacy_dropped_sessions || 0) > 0) {
      flags.push("旧口径场次 " + Number(totals.legacy_dropped_sessions) + " 场（含规则过滤）");
    }
    if (granularity === "hour") {
      var partialHours = buckets.filter(function (bucket) {
        return bucket.partial;
      }).length;
      if (partialHours) flags.push("不完整小时 " + partialHours + " 个");
    } else if (granularity === "week") {
      var partialLabels = buckets.filter(function (bucket) {
        return bucket.partial;
      }).map(function (bucket) {
        return bucket.iso_week || historyTrendBucketLabel(bucket, "week");
      }).filter(Boolean);
      if (partialLabels.length) {
        flags.push("不完整周 " + partialLabels.join("、"));
      }
    }
    if (totals.mock_received) flags.push("模拟已排除 " + totals.mock_received + " 条");
    if (data.coverage && data.coverage.partial) flags.push("本机历史覆盖不完整");
    if (data.stale || (data.data_health && Number(data.data_health.pending_writes) > 0)) {
      flags.push("仍有写入待落盘");
    }
    var moneyText;
    if (data.money && data.money.comparable === false) {
      moneyText = data.money.note || "金额字段不可比较";
    } else {
      moneyText = "礼物（本机字段）" + ctx.root.formatMoney(totals.gift_cny) +
        (Number(totals.gift_silver) ? " · 银瓜子 " + Number(totals.gift_silver) : "") +
        (Number(totals.gift_unknown) ? " · 瓜子 " + Number(totals.gift_unknown) : "") +
        " · SC " + ctx.root.formatMoney(totals.super_chat_cny);
    }
    var tableRows = buckets.slice().reverse().filter(function (bucket) {
      return Number(bucket.sessions) > 0;
    }).map(function (bucket) {
      var bucketDuration = Number(bucket.duration_seconds) || 0;
      var rate = bucketDuration > 0 ? Number(bucket.real_received || 0) / (bucketDuration / 3600) : null;
      var spoken = Number(bucket.real_received) > 0
        ? Number(bucket.real_spoken) / Number(bucket.real_received) : null;
      var dropped = Number(bucket.real_received) > 0
        ? Number(bucket.real_dropped) / Number(bucket.real_received) : null;
      var qualityBits = [];
      if (Number(bucket.short_sessions)) qualityBits.push("短场");
      if (Number(bucket.incomplete_sessions)) qualityBits.push("可能不完整");
      if (Number(bucket.replaced_sessions)) qualityBits.push("切换场次");
      if (Number(bucket.unknown_end_sessions)) qualityBits.push("未知结束");
      if (Number(bucket.inconsistent_sessions)) qualityBits.push("统计不一致");
      if (Number(bucket.mock_sessions)) qualityBits.push("含模拟");
      if (Number(bucket.legacy_dropped_sessions)) qualityBits.push("旧口径");
      var bucketText = granularity === "week"
        ? escapeHtml(bucket.iso_week || historyTrendBucketLabel(bucket, granularity))
        : escapeHtml(historyTrendBucketLabel(bucket, granularity));
      var bucketNote = granularity === "week"
        ? '<small>' + escapeHtml(bucket.week_label || "") +
          (bucket.partial ? " · 不完整" : "") + '</small>'
        : (granularity === "hour" && bucket.partial ? '<small>部分覆盖</small>' : "");
      return '<tr><td class="history-trend-bucket-cell">' + bucketText + bucketNote +
        '</td><td>' + escapeHtml(bucket.sessions) +
        '</td><td>' + escapeHtml(historyFormatRate(rate)) + '</td><td>' +
        escapeHtml(historyFormatPercent(spoken == null ? null : spoken * 100)) +
        '</td><td>' + escapeHtml(historyFormatPercent(dropped == null ? null : dropped * 100)) +
        '</td><td>' + escapeHtml(qualityBits.join(" · ") || "样本完整") + '</td></tr>';
    }).join("");
    els.historyDetail.hidden = false;
    els.historyDetail.innerHTML =
      '<div class="history-detail-head">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-history-trend-back>返回场次</button>' +
        '<div class="history-detail-title"><span class="workspace-eyebrow">只读聚合 · ' +
          historyTrendGranularityLabel(granularity) + '</span>' +
        '<h2 tabindex="-1" data-history-trend-focus>历史趋势</h2><p>' + escapeHtml(platformText) + queryText +
          ' · ' + escapeHtml(
            granularity === "hour"
              ? (data.range ? data.range.hours || data.range.bucket_count : 0) + ' 小时 · ' +
                (data.range ? data.range.days : 0) + ' 天'
              : (granularity === "week"
                ? (data.range ? data.range.bucket_count : 0) + ' 周 · ' +
                  (data.range ? data.range.days : 0) + ' 天'
                : (data.range ? data.range.days : 0) + ' 天')
          ) + '</p></div>' +
        '<div class="history-detail-actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-history-trend-refresh>刷新趋势</button>' +
          ctx.root.renderHistoryAnalysisExportActions("trend") +
          ctx.root.exportManageLinkHtml() +
        '</div>' +
      '</div>' +
      '<p class="history-export-status history-analysis-export-status" data-analysis-export-status="trend" role="status" aria-live="polite" hidden></p>' +
      '<div class="history-trend-scope">' +
        '<span class="is-scope">' + escapeHtml(roomText) + ' · ' +
          escapeHtml(scope.room_key || "—") + '</span>' +
        '<span>匹配 ' + escapeHtml(counts.matched_sessions || 0) + ' 场</span>' +
        '<span>有数据 ' + escapeHtml(counts.sessions_with_data || 0) + ' 场</span>' +
        '<span>聚合 ' + escapeHtml(bucketCount) + ' 个' + granularityText +
          (Number(counts.empty_buckets || 0)
            ? ' · 空 ' + escapeHtml(counts.empty_buckets) : '') +
          (Number(counts.partial_buckets || 0)
            ? ' · 不完整 ' + escapeHtml(counts.partial_buckets) : '') + '</span>' +
        '<span>本机保留 ' + escapeHtml(counts.all_sessions || 0) + ' 场</span>' +
        '<span>更新 ' + escapeHtml(formatDateTime(data.as_of)) + '</span>' +
      '</div>' +
      renderHistoryTrendRoomPicker(data) +
      '<div class="history-trend-kpis">' +
        '<div><span>匹配场次</span><b>' + escapeHtml(counts.matched_sessions || 0) + '</b></div>' +
        '<div><span>总时长</span><b>' + escapeHtml(formatDuration(totalDuration)) + '</b></div>' +
        '<div><span>收到 / 小时</span><b>' + escapeHtml(historyFormatRate(receivedPerHour)) + '</b></div>' +
        '<div><span>开始朗读率</span><b>' + escapeHtml(historyFormatPercent(spokenRate == null ? null : spokenRate * 100)) + '</b></div>' +
      '</div>' +
      '<div class="history-trend-grid">' +
        '<section class="card history-trend-chart-card">' +
          '<div class="history-trend-card-head"><div><span class="workspace-eyebrow">走势</span><h3>' +
            historyTrendGranularityLabel(granularity) + '</h3></div>' +
          '<div class="history-trend-card-tools">' +
            renderHistoryTrendGranularityToggle(granularity) +
            '<div class="history-trend-metrics">' +
              ['received_per_hour', 'spoken_rate', 'drop_rate'].map(function (metric) {
                return '<button type="button" data-trend-metric="' + metric + '" class="' +
                  (state.historyTrendMetric === metric ? "is-active" : "") +
                  '" aria-pressed="' + (state.historyTrendMetric === metric ? "true" : "false") + '">' +
                  escapeHtml(historyTrendMetricLabel(metric)) + '</button>';
              }).join("") +
            '</div>' +
          '</div></div>' +
          '<div class="history-trend-chart">' + renderHistoryTrendChart(data) + '</div>' +
        '</section>' +
        '<section class="card history-trend-quality-card">' +
          '<div class="workspace-card-head"><div><span class="workspace-eyebrow">质量</span><h3>口径与样本</h3></div></div>' +
          '<div class="history-trend-flags">' + (flags.length ? flags.map(function (flag) {
            return '<span>' + escapeHtml(flag) + '</span>';
          }).join("") : '<span>样本完整</span>') + '</div>' +
          '<dl class="history-trend-kv">' +
            '<div><dt>硬丢弃率</dt><dd>' + escapeHtml(historyFormatPercent(dropRate == null ? null : dropRate * 100)) + '</dd></div>' +
            '<div><dt>单场去重最高</dt><dd>' + escapeHtml(totals.unique_users_max || 0) + '</dd></div>' +
            '<div><dt>本机金额字段</dt><dd>' + escapeHtml(moneyText) + '</dd></div>' +
          '</dl>' +
          '<p class="history-trend-note">只统计真实消息；跨场 UID 不可相加，金额不能跨币种合并，未展示平台在线人数或营收。</p>' +
        '</section>' +
      '</div>' +
      '<section class="card history-trend-table-card">' +
        '<div class="workspace-card-head"><div><span class="workspace-eyebrow">明细</span><h3>按' +
          granularityText + '汇总</h3></div></div>' +
        '<div class="history-trend-table-wrap"><table class="history-trend-table"><caption>按开播' +
          granularityText + '聚合的本机历史趋势</caption>' +
          '<thead><tr><th scope="col">' +
            (granularity === "week" ? "周（周一起始）" : (granularity === "hour" ? "小时" : "日期")) +
          '</th><th scope="col">场次</th><th scope="col">收到 / 时</th>' +
          '<th scope="col">开始朗读率</th><th scope="col">硬丢弃率</th><th scope="col">质量</th></tr></thead>' +
          '<tbody>' + (tableRows || '<tr><td colspan="6">当前范围没有已结束场次。</td></tr>') + '</tbody>' +
        '</table></div>' +
      '</section>' +
      '<p class="workspace-note">趋势按开播时间归属，场次不拆分；少于 4 个可计算' +
        granularityText + '时不绘制折线。' +
        (granularity === "hour"
          ? '小时趋势最多展示近 7 天。'
          : (granularity === "week"
          ? '周趋势以本地周一为起点，跨周场次整场归入开播周。'
          : '')) +
        '趋势未检测时间重叠；切换场次不等于时间重叠。</p>';
    if (state.historyTrendGranularityFocusPending) {
      state.historyTrendGranularityFocusPending = false;
      var granularityButton = els.historyDetail.querySelector(
        '[data-trend-granularity="' + state.historyTrendGranularity + '"]'
      );
      if (granularityButton && typeof granularityButton.focus === "function") {
        granularityButton.focus();
      }
    }
    focusHistoryTrendTarget(true);
  }

  function renderHistoryTrendMessage(text, isError, shouldFocus) {
    if (!els.historyDetail) return;
    var trendActions = renderHistoryTrendGranularityToggle() +
      (isError
        ? '<button class="btn btn-ghost btn-sm" type="button" data-history-trend-refresh>重试趋势</button>'
        : "");
    els.historyDetail.hidden = false;
    els.historyDetail.innerHTML =
      '<div class="history-detail-head">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-history-trend-back>返回场次</button>' +
        '<div class="history-detail-title"><span class="workspace-eyebrow">只读聚合</span>' +
        '<h2 tabindex="-1" data-history-trend-focus>历史趋势</h2></div>' +
        (trendActions
          ? '<div class="history-detail-actions">' + trendActions + '</div>'
          : '') +
      '</div>' +
      '<div class="history-trend-empty ' + (isError ? "is-error" : "") +
        '" role="' + (isError ? "alert" : "status") + '" aria-live="' +
        (isError ? "assertive" : "polite") + '">' +
      escapeHtml(text) + '</div>';
    if (shouldFocus) focusHistoryTrendTarget(false);
  }

  function focusHistoryTrendTarget(preferRoom) {
    if (!state.historyTrendFocusPending || !els.historyDetail) return;
    state.historyTrendFocusPending = false;
    var target = preferRoom
      ? els.historyDetail.querySelector("[data-trend-room-select]")
      : null;
    target = target ||
      els.historyDetail.querySelector("[data-history-trend-refresh]") ||
      els.historyDetail.querySelector("[data-history-trend-focus]") ||
      els.historyDetail.querySelector("[data-history-trend-back]");
    if (!target) return;
    try {
      target.focus({ preventScroll: true });
    } catch (e) {
      target.focus();
    }
  }

  function setHistoryTrendGranularity(value, trigger) {
    var next = historyTrendNormalizeGranularity(value);
    if (!historyTrendGranularitySupported(next)) return;
    if (state.historyTrendGranularity === next) return;
    state.historyTrendGranularity = next;
    normalizeHistoryTrendRangeForGranularity();
    state.historyTrendGranularityFocusPending = true;
    state.historyTrendFocusPending = false;
    state.historyTrendSeq += 1;
    state.historyTrendLoading = false;
    state.historyTrendReloadPending = false;
    state.historyTrendData = null;
    state.historyTrendLoadedKey = "";
    if (trigger) trigger.setAttribute("aria-busy", "true");
    loadHistoryTrend(true);
  }

  function loadHistoryTrend(force) {
    var api = ctx.api;
    if (typeof api.trendSessions !== "function") {
      renderHistoryTrendMessage("后端未提供历史趋势接口。", true, true);
      return;
    }
    var bounds = historyTrendBounds();
    if (bounds.error) {
      renderHistoryTrendMessage(bounds.error, true, true);
      return;
    }
    var key = historyTrendKey();
    if (!force && state.historyTrendData && state.historyTrendLoadedKey === key) {
      renderHistoryTrend(state.historyTrendData);
      return;
    }
    if (state.historyTrendLoading) {
      state.historyTrendReloadPending = true;
      return;
    }
    var seq = ++state.historyTrendSeq;
    state.historyTrendLoading = true;
    state.historyTrendReloadPending = false;
    var roomKey = String(state.historyTrendRoomKey || "");
    renderHistoryTrendMessage("正在聚合历史趋势…", false, false);
    Promise.resolve(api.trendSessions(
      bounds.from,
      bounds.to,
      String(state.historyQuery || "").trim(),
      state.historyPlatform || null,
      state.historyTrendGranularity || "day",
      roomKey || null
    )).then(function (result) {
      if (seq !== state.historyTrendSeq || state.historyMode !== "trend") return;
      if (!result) throw new Error("历史趋势接口不可用");
      if (Array.isArray(result.rooms)) state.historyTrendRooms = result.rooms;
      if (result.error_code === "scope_required") {
        renderHistoryTrendScopeRequired(result);
        return;
      }
      if (result.error_code === "scope_not_found" ||
          result.error_code === "platform_required" ||
          result.error_code === "scope_incomplete") {
        state.historyTrendRoomKey = "";
        if (Array.isArray(result.rooms) && result.rooms.length) {
          renderHistoryTrendScopeRequired(result);
        } else {
          renderHistoryTrendMessage(
            result.error || "无法确定趋势范围。",
            true,
            true
          );
        }
        return;
      }
      if (result.ok === false) {
        throw new Error(result && result.error ? result.error : "历史趋势接口不可用");
      }
      state.historyTrendScope = result.scope || null;
      state.historyTrendData = result;
      state.historyTrendLoadedKey = key;
      renderHistoryTrend(result);
    }).catch(function (error) {
      if (seq !== state.historyTrendSeq || state.historyMode !== "trend") return;
      renderHistoryTrendMessage("趋势暂不可用：" +
        (error && error.message ? error.message : "未知错误"), true, true);
    }).then(function () {
      if (seq !== state.historyTrendSeq) return;
      state.historyTrendLoading = false;
      if (state.historyTrendReloadPending) {
        state.historyTrendReloadPending = false;
        loadHistoryTrend(true);
      }
    });
  }

  function openHistoryTrend() {
    ctx.root.invalidateHistoryComparison();
    if (!historyTrendGranularitySupported(state.historyTrendGranularity)) {
      state.historyTrendGranularity = "day";
    }
    normalizeHistoryTrendRangeForGranularity();
    state.historyMode = "trend";
    state.historySelectedId = null;
    state.historyDetailSession = null;
    state.historyTrendData = null;
    state.historyTrendLoadedKey = "";
    state.historyTrendRoomKey = "";
    state.historyTrendRooms = [];
    state.historyTrendScope = null;
    state.historyTrendFocusPending = true;
    state.historyTrendGranularityFocusPending = false;
    state.historyTrendSeq += 1;
    state.historyTrendLoading = false;
    state.historyTrendReloadPending = false;
    if (state.historyRange === "all") {
      state.historyRange = "365d";
      syncHistoryFilterUi();
    }
    if (els.historyLayout) els.historyLayout.classList.add("is-trend-mode");
    if (els.historyLayout) els.historyLayout.classList.add("is-detail-open");
    if (els.historyNoSelection) els.historyNoSelection.hidden = true;
    if (els.historyTrendBtn) {
      els.historyTrendBtn.classList.add("is-active");
      els.historyTrendBtn.setAttribute("aria-pressed", "true");
    }
    loadHistoryTrend(true);
  }

  function selectHistoryTrendRoom(room) {
    if (!room || !room.room_key) return;
    state.historyPlatform = String(room.platform || "");
    state.historyTrendRoomKey = String(room.room_key || "");
    state.historyTrendData = null;
    state.historyTrendLoadedKey = "";
    state.historyTrendFocusPending = true;
    state.historyTrendSeq += 1;
    state.historyTrendLoading = false;
    state.historyTrendReloadPending = false;
    syncHistoryFilterUi();
    loadHistoryTrend(true);
  }

  function selectHistoryTrendRoomByIndex(index) {
    if (String(index == null ? "" : index).trim() === "") return;
    var roomIndex = Number(index);
    if (!isFinite(roomIndex) || roomIndex < 0) return;
    selectHistoryTrendRoom(state.historyTrendRooms[roomIndex]);
  }

  function closeHistoryTrend() {
    state.historyMode = "detail";
    state.historyTrendSeq += 1;
    state.historyTrendLoading = false;
    state.historyTrendReloadPending = false;
    state.historyTrendFocusPending = false;
    state.historyTrendGranularityFocusPending = false;
    if (els.historyLayout) els.historyLayout.classList.remove("is-trend-mode");
    if (els.historyLayout) els.historyLayout.classList.remove("is-detail-open");
    if (els.historyDetail) {
      els.historyDetail.hidden = true;
      els.historyDetail.innerHTML = "";
    }
    if (els.historyNoSelection) els.historyNoSelection.hidden = false;
    if (els.historyTrendBtn) {
      els.historyTrendBtn.classList.remove("is-active");
      els.historyTrendBtn.setAttribute("aria-pressed", "false");
    }
    if (state.historyListNeedsTop) {
      if (els.historyList) els.historyList.scrollTop = 0;
      state.historyListNeedsTop = false;
    }
    renderHistoryList();
    loadHistory(true).then(function () {
      if (els.historyTrendBtn) els.historyTrendBtn.focus();
    });
  }

  function historyInsightFlagLabel(flag) {
    return ({
      target_short: "本场样本偏短",
      target_incomplete: "本场结束方式不完整",
      target_invalid_time: "本场时间异常",
      target_mock_mixed: "本场含模拟事件",
      target_spoken_drop_overlap: "朗读/丢弃计数需复核",
      target_minute_incomplete: "本场分钟数据不完整",
      cohort_limited: "基线样本有限",
      cohort_mock_mixed: "基线含模拟事件",
      cohort_replaced_sessions: "基线含切换场次",
      cohort_excluded: "部分候选未纳入基线",
      degraded: "本次运行存在历史写入缺口"
    })[flag] || "";
  }

  function historyInsightReasonText(reason) {
    if (reason === "target_unqualified") {
      return "本场时长、真实样本或结束方式不满足基线门槛，暂不生成同房间名次。";
    }
    if (reason === "insufficient_sample") {
      return "当前场之前同房间的有效样本不足 8 场，暂不生成名次；已有样本会继续累积。";
    }
    if (reason === "data_stale") {
      return "历史写入尚未完成，暂时无法生成可信复盘。";
    }
    if (reason === "unsupported") return "当前后端版本未提供场次复盘。";
    if (reason === "target_not_found") return "当前场次已不存在。";
    if (reason === "target_active") return "当前场次尚未结束，不能生成历史复盘。";
    if (reason === "target_incomplete") return "当前场次缺少平台、房间标识或合法时间。";
    if (reason === "target_invalid_time") return "当前场次起止时间异常，无法复盘。";
    if (reason === "invalid_argument") return "场次参数无效，请刷新历史后重试。";
    if (reason === "unavailable") return "历史存储暂不可用。";
    return "场次复盘暂不可用。";
  }

  function historyInsightPeakReason(reason) {
    if (reason === "minute_incomplete") return "分钟数据不完整，不计算峰值";
    if (reason === "short_duration") return "记录时长不足 5 分钟，不计算峰值";
    if (reason === "invalid_time") return "场次时间异常，不计算峰值";
    return "暂无可计算的峰值窗口";
  }

  function renderHistoryInsight() {
    var host = els.historyDetail
      ? els.historyDetail.querySelector("[data-history-insight-host]")
      : null;
    if (!host) return;
    if (!ctx.root.historyInsightsSupported()) {
      host.innerHTML = "";
      return;
    }
    var targetId = state.historySelectedId || "";
    var data = state.historyInsightData;
    var loading = state.historyInsightLoading;
    var error = state.historyInsightError;
    var head =
      '<div class="workspace-card-head"><div><span class="workspace-eyebrow">复盘</span>' +
      '<h3>同房间位置与记录内峰值</h3></div><span class="workspace-state is-neutral">本机观测</span></div>';
    if ((loading && (!data || state.historyInsightTargetId !== targetId)) ||
        (!data && !error)) {
      host.innerHTML = '<section class="history-insight-card" aria-label="场次复盘">' +
        head + '<div class="history-insight-loading" role="status" aria-live="polite">' +
        '正在计算同房间位置…</div></section>';
      return;
    }
    if (error) {
      host.innerHTML = '<section class="history-insight-card" aria-label="场次复盘">' +
        head + '<div class="history-insight-error" role="alert" tabindex="-1">' +
        escapeHtml(error) + '<button class="btn btn-ghost btn-sm" type="button" ' +
        'data-history-insight-retry>重试</button></div></section>';
      if (state.historyInsightFocusPending) {
        state.historyInsightFocusPending = false;
        var errorNode = host.querySelector(".history-insight-error");
        if (errorNode) errorNode.focus();
      }
      return;
    }
    if (!data || String(data.target && data.target.id || "") !== String(targetId)) {
      host.innerHTML = "";
      return;
    }

    var targetMetrics = data.target_metrics || {};
    var metric = data.metrics && data.metrics[0] ? data.metrics[0] : {};
    var peak = data.peak || {};
    var peakCohort = data.peak_cohort || {};
    var cohort = data.metric_cohort || {};
    var flags = (data.quality && data.quality.flags || []).map(historyInsightFlagLabel)
      .filter(Boolean);
    var currentRate = historyFormatRate(targetMetrics.received_per_hour);
    var spokenRate = historyFormatPercent(
      targetMetrics.spoken_rate == null ? null : targetMetrics.spoken_rate * 100
    );
    var dropRate = historyFormatPercent(
      targetMetrics.drop_rate == null ? null : targetMetrics.drop_rate * 100
    );

    var rangeHtml = "";
    if (data.insights_available && metric.available) {
      var current = Number(metric.current) || 0;
      var median = Number(metric.median) || 0;
      var p25 = metric.p25 == null ? null : Number(metric.p25);
      var p75 = metric.p75 == null ? null : Number(metric.p75);
      var scaleMax = Math.max(current, median, p75 == null ? 0 : p75, 1) * 1.12;
      var pointPct = Math.max(0, Math.min(100, current / scaleMax * 100));
      var bandLeft = p25 == null ? 0 : Math.max(0, Math.min(100, p25 / scaleMax * 100));
      var bandRight = p75 == null ? 0 : Math.max(0, Math.min(100, p75 / scaleMax * 100));
      var bandWidth = Math.max(0, bandRight - bandLeft);
      var rangeLabel = "当前 " + currentRate + "，中位数 " + historyFormatRate(metric.median) +
        (p25 == null ? "，样本不足不展示四分位区间" :
          "，P25 到 P75 为 " + historyFormatRate(p25) + " 到 " + historyFormatRate(p75));
      rangeHtml =
        '<div class="history-insight-range" role="img" aria-label="' +
          escapeHtml(rangeLabel) + '">' +
          (p25 == null ? "" :
            '<i class="history-insight-band" style="left:' + bandLeft.toFixed(1) +
            '%;width:' + bandWidth.toFixed(1) + '%"></i>') +
          '<i class="history-insight-median" style="left:' +
            Math.max(0, Math.min(100, median / scaleMax * 100)).toFixed(1) + '%"></i>' +
          '<i class="history-insight-point" style="left:' + pointPct.toFixed(1) + '%"></i>' +
        '</div>' +
        '<div class="history-insight-scale"><span>当前 ' + escapeHtml(currentRate) +
          '</span><span>中位 ' + escapeHtml(historyFormatRate(metric.median)) +
          '</span><span>' + (p25 == null ? "样本有限" :
            "P25–P75 " + escapeHtml(historyFormatRate(p25)) + "–" +
            escapeHtml(historyFormatRate(p75))) + '</span></div>' +
        '<p class="history-insight-rank">有 ' + escapeHtml(metric.higher_count || 0) +
          ' 场高于本场 · ' + escapeHtml(metric.tied_count || 0) +
          ' 场持平 · ' + escapeHtml(metric.lower_count || 0) +
          ' 场低于本场（有效 ' + escapeHtml(cohort.valid_count || 0) + ' 场）</p>';
    }

    var peakRange = peak.crosses_day
      ? (peak.day || "") + " " + (peak.start_local || "—") + "–" +
        (peak.end_day || "") + " " + (peak.end_local || "—")
      : (peak.start_local || "—") + "–" + (peak.end_local || "—");
    var targetPeakHtml = peak.available
      ? '<div class="history-insight-peak-main"><b>' +
          escapeHtml(peakRange) +
          '</b><span>' + escapeHtml(peak.count || 0) + ' 条 · 本机记录第 ' +
          escapeHtml(peak.offset_start_min || 0) + '–' + escapeHtml(peak.offset_end_min || 0) +
          ' 分钟</span></div>'
      : '<p class="history-insight-muted">' + escapeHtml(historyInsightPeakReason(peak.reason)) +
        '</p>';
    var hourHtml = "";
    if (peakCohort.available && Array.isArray(peakCohort.hours) && peakCohort.hours.length) {
      var shownHours = peakCohort.hours.slice(0, 3);
      hourHtml = '<p class="history-insight-muted">' +
        (peakCohort.hours.length > 3 ? "峰值最集中的 3 个时段" : "峰值时段") +
        '（' + escapeHtml(peakCohort.total_samples || peakCohort.valid_count || 0) +
        ' 个完整样本）</p><div class="history-insight-hour-list">' +
        shownHours.map(function (item) {
        return '<span class="history-insight-hour"><b>' + escapeHtml(item.hour) +
          ' 点档</b><small>' + escapeHtml(item.count) + ' 场</small></span>';
      }).join("") + '</div>';
    } else {
      hourHtml = '<p class="history-insight-muted">完整峰值样本 ' +
        escapeHtml(peakCohort.valid_count || 0) + ' / ' +
        escapeHtml(peakCohort.sample_threshold || 12) + '，暂不生成时段分布。</p>';
    }
    var excluded = cohort.excluded || {};
    var excludedText = "短场 " + Number(excluded.short || 0) +
      " · 不完整 " + Number(excluded.incomplete || 0) +
      " · 重叠 " + Number(excluded.overlap || 0) +
      " · 非法 " + Number(excluded.invalid || 0);
    var availability = "";
    if (!data.insights_available) {
      availability = '<div class="history-insight-callout">' +
        escapeHtml(historyInsightReasonText(data.reason)) + '</div>';
    }
    var flagsHtml = flags.length
      ? '<div class="history-insight-flags">' + flags.map(function (flag) {
          return '<span>' + escapeHtml(flag) + '</span>';
        }).join("") + '</div>'
      : "";
    host.innerHTML =
      '<section class="history-insight-card" aria-labelledby="historyInsightTitle" data-insight-target="' +
        escapeHtml(targetId) + '">' +
        '<div class="workspace-card-head"><div><span class="workspace-eyebrow">复盘</span>' +
          '<h3 id="historyInsightTitle" tabindex="-1">同房间位置与记录内峰值</h3></div>' +
          '<div class="history-insight-tools"><span class="workspace-state is-neutral">本机观测</span>' +
            ctx.root.renderHistoryAnalysisExportActions("insights") +
          '</div></div>' +
        '<p class="history-export-status history-analysis-export-status" data-analysis-export-status="insights" role="status" aria-live="polite" hidden></p>' +
        availability +
        '<div class="history-insight-grid">' +
          '<section class="history-insight-panel">' +
            '<div class="history-insight-panel-head"><div><span class="workspace-eyebrow">位置</span>' +
              '<h4>收到 / 小时 · 按本机记录时长</h4></div></div>' +
            (rangeHtml || '<div class="history-insight-target-value"><b>' +
              escapeHtml(currentRate) + '</b><span>本场收到 / 小时</span></div>') +
            '<div class="history-insight-facts">' +
              '<div><span>开始朗读率</span><b>' + escapeHtml(spokenRate) + '</b></div>' +
              '<div><span>丢弃率</span><b>' + escapeHtml(dropRate) + '</b>' +
                '<small>含筛选、队列和播放失败，受当时配置影响</small></div>' +
            '</div>' +
            '<p class="history-insight-sample">候选 ' + escapeHtml(cohort.candidate_count || 0) +
              ' 场 · 有效 ' + escapeHtml(cohort.valid_count || 0) + ' 场 · ' +
              escapeHtml(excludedText) + '</p>' +
          '</section>' +
          '<section class="history-insight-panel history-insight-peak-panel">' +
            '<div class="history-insight-panel-head"><div><span class="workspace-eyebrow">峰值</span>' +
              '<h4>本机消息到达峰值 · 5 分钟</h4></div></div>' +
            targetPeakHtml +
            '<div class="history-insight-hours">' + hourHtml + '</div>' +
          '</section>' +
        '</div>' +
        flagsHtml +
        '<p class="history-insight-note">同平台同房间 · 当前场之前最近 20 场 · 最多回看 365 天。' +
          '短场、不完整场、重叠场和分钟数据不完整样本按用途分别排除。' +
          '本机记录开始时间不等于平台真实开播时间；这里不是平台观众或平台营收口径。</p>' +
      '</section>';
    if (state.historyInsightFocusPending) {
      state.historyInsightFocusPending = false;
      var title = host.querySelector("#historyInsightTitle");
      if (title) {
        try { title.focus({ preventScroll: true }); }
        catch (e) { title.focus(); }
      }
    }
  }

  function loadHistoryInsights(targetId, force) {
    var id = String(targetId || "");
    if (!id || !ctx.root.historyInsightsSupported()) {
      renderHistoryInsight();
      return;
    }
    if (state.historySelectedId !== id) return;
    if (!force && state.historyInsightData &&
        state.historyInsightTargetId === id) {
      renderHistoryInsight();
      return;
    }
    var api = ctx.api;
    var seq = ++state.historyInsightSeq;
    state.historyInsightTargetId = id;
    state.historyInsightLoading = true;
    state.historyInsightError = "";
    if (state.historyInsightData &&
        String(state.historyInsightData.target && state.historyInsightData.target.id || "") !== id) {
      state.historyInsightData = null;
    }
    renderHistoryInsight();
    Promise.resolve(api.sessionInsights(id)).then(function (result) {
      if (seq !== state.historyInsightSeq ||
          state.historySelectedId !== id ||
          state.historyMode !== "detail") return;
      if (!result || result.ok === false || result.insights_available === undefined) {
        throw new Error(historyInsightReasonText(result && result.error_code));
      }
      if (String(result.target && result.target.id || "") !== id) {
        throw new Error("复盘结果与当前场次不一致");
      }
      state.historyInsightData = result;
      state.historyInsightError = "";
    }).catch(function (error) {
      if (seq !== state.historyInsightSeq ||
          state.historySelectedId !== id ||
          state.historyMode !== "detail") return;
      state.historyInsightError = error && error.message
        ? error.message
        : "场次复盘暂不可用。";
    }).then(function () {
      if (seq !== state.historyInsightSeq) return;
      state.historyInsightLoading = false;
      renderHistoryInsight();
    });
  }

  function returnHistoryOverview() {
    var current = state.historyDetailSession;
    if (!current) return;
    var scrollTop = state.historyCompareEntry === "multi"
      ? (state.historyMultiCompareScrollTop || 0)
      : (state.historyCompareScrollTop || 0);
    renderHistoryDetail(current);
    if (els.historyDetailPane) els.historyDetailPane.scrollTop = scrollTop;
    requestAnimationFrame(function () {
      var selector = state.historyCompareEntry === "baseline" ||
        state.historyCompareEntry === "multi"
        ? "[data-history-baseline]"
        : "[data-history-compare]";
      var button = els.historyDetail
        ? els.historyDetail.querySelector(selector)
        : null;
      if (button) {
        try { button.focus({ preventScroll: true }); }
        catch (e) { button.focus(); }
      }
      if (els.historyDetailPane) els.historyDetailPane.scrollTop = scrollTop;
    });
  }

  function exportHistorySession(sessionId, format, trigger) {
    var api = ctx.api;
    var status = els.historyDetail
      ? els.historyDetail.querySelector("[data-history-export-status]")
      : null;
    if (typeof api.exportSession !== "function") {
      if (status) {
        status.hidden = false;
        status.className = "history-export-status is-error";
        status.textContent = "后端未提供历史场次导出接口。";
      }
      return;
    }
    var buttons = els.historyDetail
      ? Array.prototype.slice.call(els.historyDetail.querySelectorAll("[data-history-export]"))
      : [];
    buttons.forEach(function (button) { button.disabled = true; });
    if (trigger) trigger.setAttribute("aria-busy", "true");
    if (status) {
      status.hidden = false;
      status.className = "history-export-status is-busy";
      status.textContent = "正在导出 " + String(format || "json").toUpperCase() + "…";
    }
    var finish = function () {
      buttons.forEach(function (button) { button.disabled = false; });
      if (trigger) trigger.removeAttribute("aria-busy");
    };
    Promise.resolve(api.exportSession(sessionId, format)).then(function (result) {
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : "导出失败");
      }
      if (status && document.contains(status)) {
        status.className = "history-export-status is-ok";
        status.innerHTML = "已导出 " + escapeHtml(String(result.format || format).toUpperCase()) +
          " · <code>" + escapeHtml(result.path || "文件已写入") + "</code>" +
          ctx.root.exportManageLinkHtml();
      }
    }).catch(function (error) {
      if (status && document.contains(status)) {
        status.className = "history-export-status is-error";
        status.textContent = "导出失败：" +
          (error && error.message ? error.message : "未知错误");
      }
    }).then(finish);
  }

  function setHistoryPrunePreview(text, tone) {
    if (!els.historyPrunePreview) return;
    els.historyPrunePreview.className = "history-prune-preview" + (tone ? " is-" + tone : "");
    els.historyPrunePreview.textContent = text;
  }

  function historyManagePruneReady() {
    return !state.historyManageBusy &&
      state.historyManagePreview &&
      Number(state.historyManagePreview.matched || 0) > 0 &&
      els.historyPruneConfirm &&
      String(els.historyPruneConfirm.value || "").trim() === "清理";
  }

  function updateHistoryManageButtons() {
    var busy = !!state.historyManageBusy;
    if (els.historyKeepDays) els.historyKeepDays.disabled = busy;
    if (els.historyPrunePreviewBtn) els.historyPrunePreviewBtn.disabled = busy;
    if (els.historyPruneBtn) els.historyPruneBtn.disabled = !historyManagePruneReady();
  }

  function openHistoryManage() {
    if (!els.historyManageModal || state.historyManageOpen) return;
    if (state.snapshot && state.snapshot.is_mock) return;
    state.historyManageOpen = true;
    state.historyManageBusy = false;
    state.historyManagePreview = null;
    state.historyManageSeq += 1;
    state.historyManageLastFocus = document.activeElement;
    state.historyAutoEnabled = false;
    state.historyAutoDays = 90;
    state.historyAutoBusy = false;
    state.historyAutoSeq += 1;
    if (els.historyPruneConfirm) els.historyPruneConfirm.value = "";
    if (els.historyKeepDays) els.historyKeepDays.value = "90";
    if (els.historyManageFacts) els.historyManageFacts.textContent = "正在读取历史统计…";
    setHistoryPrunePreview("正在读取历史统计…", "");
    setHistoryAutoStatus("读取设置…", false);
    updateHistoryAutoUi();
    els.historyManageModal.hidden = false;
    var app = document.querySelector(".app");
    if (app) {
      app.setAttribute("inert", "");
      app.setAttribute("aria-hidden", "true");
    }
    updateHistoryManageButtons();
    requestAnimationFrame(function () {
      if (els.historyManageClose) els.historyManageClose.focus();
    });
    previewHistoryPrune();
    loadHistoryAutoSettings();
  }

  function closeHistoryManage() {
    if (!els.historyManageModal || !state.historyManageOpen) return;
    state.historyManageOpen = false;
    state.historyManageBusy = false;
    state.historyManagePreview = null;
    state.historyManageSeq += 1;
    state.historyAutoSeq += 1;
    state.historyAutoBusy = false;
    els.historyManageModal.hidden = true;
    var app = document.querySelector(".app");
    if (app) {
      app.removeAttribute("inert");
      app.removeAttribute("aria-hidden");
    }
    var back = state.historyManageLastFocus;
    state.historyManageLastFocus = null;
    if (back && document.contains(back) && typeof back.focus === "function") back.focus();
    else if (els.historyManage) els.historyManage.focus();
  }

  function setHistoryAutoStatus(text, isError) {
    if (!els.historyAutoStatus) return;
    els.historyAutoStatus.className = "history-auto-status" + (isError ? " is-error" : "");
    els.historyAutoStatus.textContent = text;
  }

  function updateHistoryAutoUi() {
    if (els.historyAutoToggle) {
      els.historyAutoToggle.setAttribute("aria-checked", state.historyAutoEnabled ? "true" : "false");
      els.historyAutoToggle.textContent = state.historyAutoEnabled ? "开启" : "关闭";
      els.historyAutoToggle.disabled = !!state.historyAutoBusy;
    }
    if (els.historyAutoDays) {
      els.historyAutoDays.value = String(state.historyAutoDays);
      els.historyAutoDays.disabled = !!state.historyAutoBusy;
    }
    if (els.historyAutoSave) els.historyAutoSave.disabled = !!state.historyAutoBusy;
  }

  function loadHistoryAutoSettings() {
    var api = ctx.api;
    if (typeof api.historySettings !== "function") {
      setHistoryAutoStatus("后端未提供自动清理设置。", true);
      return;
    }
    var seq = ++state.historyAutoSeq;
    state.historyAutoBusy = true;
    updateHistoryAutoUi();
    setHistoryAutoStatus("读取设置…", false);
    Promise.resolve(api.historySettings()).then(function (result) {
      if (seq !== state.historyAutoSeq || !state.historyManageOpen) return;
      if (!result || result.ok === false || !result.settings) {
        throw new Error(result && result.error ? result.error : "读取自动清理设置失败");
      }
      state.historyAutoEnabled = !!result.settings.auto_prune_enabled;
      state.historyAutoDays = Number(result.settings.auto_prune_days) || 90;
      setHistoryAutoStatus(
        state.historyAutoEnabled
          ? "已开启；启动时清理早于 " + state.historyAutoDays + " 天的场次。"
          : "已关闭；不会自动删除历史。",
        false
      );
    }).catch(function (error) {
      if (seq !== state.historyAutoSeq || !state.historyManageOpen) return;
      setHistoryAutoStatus("读取失败：" +
        (error && error.message ? error.message : "未知错误"), true);
    }).then(function () {
      if (seq !== state.historyAutoSeq) return;
      state.historyAutoBusy = false;
      updateHistoryAutoUi();
    });
  }

  function saveHistoryAutoSettings() {
    var api = ctx.api;
    if (typeof api.updateHistorySettings !== "function" || state.historyAutoBusy) return;
    var seq = ++state.historyAutoSeq;
    state.historyAutoBusy = true;
    updateHistoryAutoUi();
    setHistoryAutoStatus("正在保存设置…", false);
    Promise.resolve(api.updateHistorySettings({
      auto_prune_enabled: !!state.historyAutoEnabled,
      auto_prune_days: Number(state.historyAutoDays) || 90
    })).then(function (result) {
      if (seq !== state.historyAutoSeq || !state.historyManageOpen) return;
      if (!result || result.ok === false || !result.settings) {
        throw new Error(result && result.error ? result.error : "保存自动清理设置失败");
      }
      state.historyAutoEnabled = !!result.settings.auto_prune_enabled;
      state.historyAutoDays = Number(result.settings.auto_prune_days) || 90;
      setHistoryAutoStatus(
        state.historyAutoEnabled
          ? "设置已保存；启动时清理早于 " + state.historyAutoDays + " 天。"
          : "设置已保存；自动清理已关闭。",
        false
      );
    }).catch(function (error) {
      if (seq !== state.historyAutoSeq || !state.historyManageOpen) return;
      setHistoryAutoStatus("保存失败：" +
        (error && error.message ? error.message : "未知错误"), true);
    }).then(function () {
      if (seq !== state.historyAutoSeq) return;
      state.historyAutoBusy = false;
      updateHistoryAutoUi();
    });
  }

  function previewHistoryPrune() {
    if (!state.historyManageOpen || state.historyManageBusy) return;
    var api = ctx.api;
    if (typeof api.prunePreview !== "function") {
      setHistoryPrunePreview("后端未提供历史清理预览。", "error");
      return;
    }
    var days = Number(els.historyKeepDays ? els.historyKeepDays.value : 90) || 90;
    var cutoff = Date.now() / 1000 - days * 86400;
    var seq = ++state.historyManageSeq;
    state.historyManageBusy = true;
    state.historyManagePreview = null;
    if (els.historyPruneConfirm) els.historyPruneConfirm.value = "";
    setHistoryPrunePreview("正在预览可清理场次…", "");
    updateHistoryManageButtons();
    Promise.resolve(api.prunePreview(cutoff, 1)).then(function (result) {
      if (seq !== state.historyManageSeq || !state.historyManageOpen) return;
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : "历史清理预览失败");
      }
      state.historyManagePreview = result;
      var total = Number(result.total || 0);
      var matched = Number(result.matched || 0);
      if (els.historyManageFacts) {
        els.historyManageFacts.textContent =
          "已结束历史 " + total + " 场 · 至少保留最近 " +
          Number(result.protected || 0) + " 场 · 截止 " +
          formatDateTime(result.cutoff_ts);
      }
      if (matched > 0) {
        setHistoryPrunePreview(
          "将清理 " + matched + " 场，范围 " +
          formatDateTime(result.oldest_candidate) + " → " +
          formatDateTime(result.newest_candidate) +
          "。执行前会自动备份，不删除已导出文件。",
          "ready"
        );
      } else {
        setHistoryPrunePreview("没有符合条件的场次，无需清理。", "");
      }
    }).catch(function (error) {
      if (seq !== state.historyManageSeq || !state.historyManageOpen) return;
      state.historyManagePreview = null;
      setHistoryPrunePreview("预览失败：" +
        (error && error.message ? error.message : "未知错误"), "error");
    }).then(function () {
      if (seq !== state.historyManageSeq) return;
      state.historyManageBusy = false;
      updateHistoryManageButtons();
    });
  }

  function executeHistoryPrune() {
    if (!state.historyManageOpen || state.historyManageBusy) return;
    var preview = state.historyManagePreview;
    if (!historyManagePruneReady() || !preview) return;
    var matched = Number(preview.matched || 0);
    if (!window.confirm("将从 ReadMe 历史中删除 " + matched +
        " 场记录，并在删除前创建 SQLite 备份。继续？")) return;
    var api = ctx.api;
    if (typeof api.pruneHistory !== "function") {
      setHistoryPrunePreview("后端未提供历史清理接口。", "error");
      return;
    }
    var seq = ++state.historyManageSeq;
    state.historyManageBusy = true;
    setHistoryPrunePreview("正在备份并清理…", "ready");
    updateHistoryManageButtons();
    Promise.resolve(api.pruneHistory(preview.cutoff_ts, 1)).then(function (result) {
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : "历史清理失败");
      }
      if (seq === state.historyManageSeq && state.historyManageOpen) {
        var total = Number(result.deleted || 0);
        var backup = result.backup_path ? "；备份：" + result.backup_path : "";
        setHistoryPrunePreview("已清理 " + total + " 场" + backup, "success");
        state.historyManagePreview = {
          ...preview,
          matched: 0,
          deleted: total,
          backup_path: result.backup_path || null
        };
        if (els.historyPruneConfirm) els.historyPruneConfirm.value = "";
      }
      resetHistoryDetail();
      state.historyLoaded = false;
      loadHistory(true);
    }).catch(function (error) {
      if (seq !== state.historyManageSeq || !state.historyManageOpen) return;
      setHistoryPrunePreview("清理失败：" +
        (error && error.message ? error.message : "未知错误"), "error");
    }).then(function () {
      if (seq !== state.historyManageSeq) return;
      state.historyManageBusy = false;
      updateHistoryManageButtons();
    });
  }

  ctx.modules.history = {
    showHistoryEmpty: showHistoryEmpty,
    showHistoryError: showHistoryError,
    renderHistoryList: renderHistoryList,
    loadHistory: loadHistory,
    selectHistorySession: selectHistorySession,
    openHistorySession: openHistorySession,
    setPostludeStatus: setPostludeStatus,
    resetPostludeExportButtons: resetPostludeExportButtons,
    exportPostludeSession: exportPostludeSession,
    showHistoryDetailError: showHistoryDetailError,
    focusHistoryDetail: focusHistoryDetail,
    resetHistoryDetail: resetHistoryDetail,
    renderHistoryDetail: renderHistoryDetail,
    readHistorySelection: readHistorySelection,
    clearHistorySelection: clearHistorySelection,
    closeHistoryDetail: closeHistoryDetail,
    syncHistoryFilterUi: syncHistoryFilterUi,
    applyHistoryFilters: applyHistoryFilters,
    clearHistoryFilters: clearHistoryFilters,
    returnHistoryOverview: returnHistoryOverview,
    exportHistorySession: exportHistorySession,
    historyTrendKey: historyTrendKey,
    historyTrendBounds: historyTrendBounds,
    historyTrendMetricLabel: historyTrendMetricLabel,
    historyTrendGranularityLabel: historyTrendGranularityLabel,
    historyTrendGranularitySupported: historyTrendGranularitySupported,
    renderHistoryTrendGranularityToggle: renderHistoryTrendGranularityToggle,
    historyTrendBucketLabel: historyTrendBucketLabel,
    historyTrendBucketShortLabel: historyTrendBucketShortLabel,
    historyTrendBucketTooltip: historyTrendBucketTooltip,
    historyTrendMetricValue: historyTrendMetricValue,
    historyTrendValueText: historyTrendValueText,
    renderHistoryTrendChart: renderHistoryTrendChart,
    renderHistoryTrendRoomPicker: renderHistoryTrendRoomPicker,
    renderHistoryTrendScopeRequired: renderHistoryTrendScopeRequired,
    renderHistoryTrend: renderHistoryTrend,
    renderHistoryTrendMessage: renderHistoryTrendMessage,
    focusHistoryTrendTarget: focusHistoryTrendTarget,
    setHistoryTrendGranularity: setHistoryTrendGranularity,
    loadHistoryTrend: loadHistoryTrend,
    openHistoryTrend: openHistoryTrend,
    selectHistoryTrendRoom: selectHistoryTrendRoom,
    selectHistoryTrendRoomByIndex: selectHistoryTrendRoomByIndex,
    closeHistoryTrend: closeHistoryTrend,
    historyInsightFlagLabel: historyInsightFlagLabel,
    historyInsightReasonText: historyInsightReasonText,
    historyInsightPeakReason: historyInsightPeakReason,
    renderHistoryInsight: renderHistoryInsight,
    loadHistoryInsights: loadHistoryInsights,
    setHistoryPrunePreview: setHistoryPrunePreview,
    historyManagePruneReady: historyManagePruneReady,
    updateHistoryManageButtons: updateHistoryManageButtons,
    openHistoryManage: openHistoryManage,
    closeHistoryManage: closeHistoryManage,
    setHistoryAutoStatus: setHistoryAutoStatus,
    updateHistoryAutoUi: updateHistoryAutoUi,
    loadHistoryAutoSettings: loadHistoryAutoSettings,
    saveHistoryAutoSettings: saveHistoryAutoSettings,
    previewHistoryPrune: previewHistoryPrune,
    executeHistoryPrune: executeHistoryPrune
  };
})();
