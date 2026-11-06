/* ============================================================
   幕台 · 历史对比 / 基准域（2B-C1）
   依赖 history 模块 API 与 shell-core ctx。
   ============================================================ */
(function () {
  "use strict";
  var ctx = window.MutaiShell;
  if (!ctx) throw new Error("shell context missing");
  var state = ctx.state;
  var els = ctx.els;
  var TYPE_META = ctx.constants.TYPE_META;
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
  var platformCapability = ctx.shared.platformCapability;
  var platformLabel = ctx.shared.platformLabel;
  var platformMoneyComparable = ctx.shared.platformMoneyComparable;

  function historyNumber() { return ctx.shared.historyNumber.apply(this, arguments); }
  function historyDurationOf() { return ctx.shared.historyDurationOf.apply(this, arguments); }
  function historyPerHour() { return ctx.shared.historyPerHour.apply(this, arguments); }
  function historyRatio() { return ctx.shared.historyRatio.apply(this, arguments); }
  function historyFormatDelta() { return ctx.shared.historyFormatDelta.apply(this, arguments); }
  function historyTypeTotal() { return ctx.shared.historyTypeTotal.apply(this, arguments); }
  function historyMinutesTotal() { return ctx.shared.historyMinutesTotal.apply(this, arguments); }
  function historyPeakFiveMinute() { return ctx.shared.historyPeakFiveMinute.apply(this, arguments); }
  function historyGiftText() { return ctx.shared.historyGiftText.apply(this, arguments); }
  function historySessionMetrics() { return ctx.shared.historySessionMetrics.apply(this, arguments); }

  function historyComparisonModel(current, baseline) {
    var c = historySessionMetrics(current);
    var b = historySessionMetrics(baseline);
    var badReasons = ["stale", "interrupted", "connect_failed"];
    var flags = [];
    if (c.duration < 600 || c.received < 20) flags.push("当前场样本偏短");
    if (b.duration < 600 || b.received < 20) flags.push("基准场样本偏短");
    if (c.duration > 0 && b.duration > 0 &&
        Math.max(c.duration, b.duration) / Math.min(c.duration, b.duration) > 2) {
      flags.push("时长差异大");
    }
    if (badReasons.indexOf(current && current.end_reason) >= 0 ||
        badReasons.indexOf(baseline && baseline.end_reason) >= 0) {
      flags.push("对比数据可能不完整");
    }
    var knownReasons = ["finished", "", null, "stale", "interrupted", "connect_failed", "replaced", "shutdown", "manual_disconnect"];
    if (knownReasons.indexOf(current && current.end_reason) < 0) {
      flags.push("当前场结束方式未知");
    }
    if (knownReasons.indexOf(baseline && baseline.end_reason) < 0) {
      flags.push("基准场结束方式未知");
    }
    if (historyNumber(current && current.mock_received) > 0) {
      flags.push("当前场模拟已排除 " + historyNumber(current.mock_received) + " 条");
    }
    if (historyNumber(baseline && baseline.mock_received) > 0) {
      flags.push("基准场模拟已排除 " + historyNumber(baseline.mock_received) + " 条");
    }
    if (c.received === 0 || b.received === 0) flags.push("没有真实消息样本");
    if (c.typedTotal !== c.received || b.typedTotal !== b.received) flags.push("类型样本不完整");
    if (c.minutesTotal !== c.typedTotal || b.minutesTotal !== b.typedTotal) flags.push("节奏样本不完整");
    var currentStart = historyNumber(current && current.started_at);
    var currentEnd = historyNumber(current && current.ended_at);
    var baselineStart = historyNumber(baseline && baseline.started_at);
    var baselineEnd = historyNumber(baseline && baseline.ended_at);
    if (baselineStart > currentStart) flags.push("基准场晚于当前记录");
    if (currentStart < baselineEnd && baselineStart < currentEnd) {
      flags.push("两场时间重叠");
    }
    var abnormal = flags.indexOf("对比数据可能不完整") >= 0;
    var noReal = c.received === 0 || b.received === 0;
    var short = flags.indexOf("当前场样本偏短") >= 0 ||
      flags.indexOf("基准场样本偏短") >= 0;
    var durationDiff = flags.indexOf("时长差异大") >= 0;
    return {
      current: c,
      baseline: b,
      flags: flags,
      suppressAllDeltas: abnormal || noReal,
      suppressRateDeltas: short || noReal,
      suppressTotalDeltas: durationDiff || abnormal || noReal,
      suppressTypeDeltas: c.typedTotal !== c.received || b.typedTotal !== b.received || abnormal || noReal
    };
  }

  function setHistoryCompareStatus(text, tone) {
    var node = els.historyDetail
      ? els.historyDetail.querySelector("[data-history-compare-status]")
      : null;
    if (!node) return;
    if (!text) {
      node.hidden = true;
      node.textContent = "";
      node.className = "history-compare-status";
      node.setAttribute("role", "status");
      return;
    }
    node.hidden = false;
    node.className = "history-compare-status is-" + (tone || "neutral");
    node.textContent = text;
    node.setAttribute("role", tone === "error" ? "alert" : "status");
  }

  function historyCompareErrorMessage(result) {
    var status = result && result.status;
    var code = result && result.error_code;
    if (code === "target_not_found") return "当前场次已不存在，请刷新历史。";
    if (code === "target_active") return "当前场次尚未结束，不能作为历史基准。";
    if (code === "target_incomplete") return "当前场次缺少平台、房间标识或合法时间。";
    if (code === "target_invalid_time") return "当前场次起止时间异常，无法对比。";
    if (code === "baseline_not_found") {
      var baselineIndex = Number(result && result.baseline_index || 0);
      return baselineIndex > 0
        ? "B" + baselineIndex + " 已被删除，请调整对比场后重试。"
        : "基准场已被删除或不可用，请重新选择。";
    }
    if (code === "baseline_active") return "所选基准场尚未结束，不能参与对比。";
    if (code === "baseline_incomplete") return "所选基准场缺少平台、房间标识或合法时间。";
    if (code === "baseline_invalid_time") return "所选基准场起止时间异常，无法对比。";
    if (code === "same_session") return "当前场不能作为自己的基准。";
    if (code === "too_many_baselines") return "多场对比最多选择 3 个基准。";
    if (code === "insufficient_baselines") return "多场对比至少需要 2 个基准。";
    if (code === "duplicate_baseline") return "基准场不能重复选择。";
    if (code === "scope_mismatch") return "只能对比同平台、同房间的场次。";
    if (code === "unsupported") return "当前后端版本不支持任意基准场对比。";
    if (code === "unavailable") return "历史存储暂不可用。";
    if (code === "internal") return "历史场次对比失败，请稍后重试。";
    if (status === "target_not_found") return "当前场次已不存在，请刷新历史。";
    if (status === "target_active") return "当前场次尚未结束，不能作为历史基准。";
    if (status === "target_incomplete") return "当前场次缺少平台、房间号或开播时间，无法对比。";
    if (status === "ambiguous_tie") return "同房间存在相同开播时间的上一场，无法确定基准。";
    if (status === "unavailable") return "历史存储暂不可用。";
    return result && result.error ? result.error : "读取上一场失败。";
  }

  function historyCompareHealthWarning(result) {
    var health = result && result.data_health;
    var notes = [];
    if (result && result.stale) notes.push("历史快照可能未包含最新写入");
    if (health && Number(health.pending_writes) > 0) {
      notes.push(Number(health.pending_writes) + " 个写入仍待落盘");
    }
    if (health && Number(health.dropped_ops) > 0) {
      notes.push("本次运行有 " + Number(health.dropped_ops) + " 次写入丢弃");
    }
    if (health && Number(health.failed_ops) > 0) {
      notes.push("本次运行有 " + Number(health.failed_ops) + " 次写入失败");
    }
    return notes.join("；");
  }

  function historyBaselineRelationLabel(relation) {
    if (relation === "later") return "更晚";
    if (relation === "same_start") return "同时间开播";
    return "更早";
  }

  function setHistoryBaselineStatus(text, tone, canRetry) {
    if (!els.historyBaselineStatus) return;
    var keepFocus = els.historyBaselineStatus.contains(document.activeElement);
    els.historyBaselineStatus.className = "history-baseline-status" +
      (tone ? " is-" + tone : "");
    els.historyBaselineStatus.textContent = text || "";
    els.historyBaselineStatus.setAttribute(
      "role",
      tone === "error" ? "alert" : "status"
    );
    if (canRetry) {
      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "history-baseline-retry";
      retry.setAttribute("data-history-baseline-retry", "");
      retry.textContent = "重试";
      els.historyBaselineStatus.appendChild(retry);
    }
    if (keepFocus) {
      var target = canRetry
        ? els.historyBaselineStatus.querySelector("[data-history-baseline-retry]")
        : els.historyBaselineStatus;
      if (target) target.focus();
    }
  }

  function renderHistoryBaselineCurrent() {
    var current = state.historyDetailSession;
    if (!current) return;
    var scope = platformLabel(current.platform) + " · " +
      String(current.room_key || "—");
    if (els.historyBaselineScope) {
      els.historyBaselineScope.textContent =
        "同平台、同房间的已结束场次才会出现在这里。" + scope;
    }
    if (!els.historyBaselineCurrent) return;
    els.historyBaselineCurrent.innerHTML =
      '<span>当前场 · 不可作为基准</span>' +
      '<b>' + escapeHtml(historyRoomLabel(current)) + '</b>' +
      '<small>' + escapeHtml(formatDateTime(current.started_at)) + ' → ' +
      escapeHtml(formatDateTime(current.ended_at)) + ' · ' +
      escapeHtml(formatDuration(historyDurationOf(current))) + '</small>';
  }

  function renderHistoryBaselineChips() {
    if (!els.historyBaselineChips) return;
    if (!state.historyBaselineMulti) {
      els.historyBaselineChips.hidden = true;
      els.historyBaselineChips.innerHTML = "";
      return;
    }
    var selected = state.historyBaselineSelectedIds || [];
    if (!selected.length) {
      els.historyBaselineChips.hidden = false;
      els.historyBaselineChips.innerHTML =
        '<span class="history-baseline-selected-empty">尚未选择；至少选择 2 场，最多 3 场</span>';
      return;
    }
    var sessions = state.historyBaselineSessions || [];
    els.historyBaselineChips.hidden = false;
    els.historyBaselineChips.innerHTML = selected.map(function (id, index) {
      var session = sessions.find(function (item) {
        return String(item.id) === String(id);
      });
      var label = session
        ? "B" + (index + 1) + " " + formatDateTime(session.started_at)
        : "B" + (index + 1) + " 未加载场次";
      return '<button type="button" class="history-baseline-chip" data-remove-baseline="' +
        escapeHtml(id) + '" aria-label="移除 ' + escapeHtml(label) + '">' +
        escapeHtml(label) + ' <span aria-hidden="true">×</span></button>';
    }).join("");
  }

  function updateHistoryBaselineModeUi() {
    var multi = !!state.historyBaselineMulti;
    if (els.historyBaselineModeTabs) {
      els.historyBaselineModeTabs.hidden = !ctx.root.historyMultiCompareSupported();
      Array.prototype.forEach.call(
        els.historyBaselineModeTabs.querySelectorAll("[data-baseline-mode]"),
        function (button) {
          var active = button.getAttribute("data-baseline-mode") ===
            (multi ? "multi" : "single");
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-selected", active ? "true" : "false");
          button.tabIndex = active ? 0 : -1;
        }
      );
    }
    if (els.historyBaselineList) {
      els.historyBaselineList.setAttribute(
        "role", multi ? "group" : "radiogroup"
      );
      els.historyBaselineList.setAttribute(
        "aria-label", multi ? "同房间多场对比候选" : "同房间基准场候选"
      );
    }
    if (els.historyBaselineRecent) {
      els.historyBaselineRecent.hidden = !multi || !(state.historyBaselineSessions || []).length;
    }
    renderHistoryBaselineChips();
    updateHistoryBaselineApply();
  }

  function setHistoryBaselineMode(mode, options) {
    var next = mode === "multi" && ctx.root.historyMultiCompareSupported() ? "multi" : "single";
    state.historyBaselineMulti = next === "multi";
    state.historyBaselineSelectedId = "";
    state.historyBaselineSelectedIds = [];
    if (els.historyBaselineTitle) {
      els.historyBaselineTitle.textContent =
        state.historyBaselineMulti ? "选择对比场次" : "选择基准场";
    }
    if (els.historyBaselineScope) {
      els.historyBaselineScope.textContent = state.historyBaselineMulti
        ? "同平台、同房间的已结束场次；可多选 2–3 场，当前场不可作为基准。"
        : "同平台、同房间的已结束场次；当前场不可作为基准。";
    }
    if (!(options && options.keepStatus)) {
      setHistoryBaselineStatus(
        state.historyBaselineMulti ? "请选择 2–3 场对比；已选按选择顺序标记。" : "",
        "",
        false
      );
    }
    updateHistoryBaselineModeUi();
    renderHistoryBaselineList();
  }

  function updateHistoryBaselineApply() {
    if (!els.historyBaselineApply) return;
    if (state.historyBaselineMulti) {
      var count = (state.historyBaselineSelectedIds || []).length;
      els.historyBaselineApply.disabled =
        count < 2 || count > 3 ||
        state.historyBaselineLoading || state.historyBaselineLoadingMore;
      els.historyBaselineApply.textContent = state.historyBaselineLoading ||
        state.historyBaselineLoadingMore
        ? "正在读取…"
        : "对比所选 " + count + " 场";
      return;
    }
    var selected = (state.historyBaselineSessions || []).some(function (session) {
      return String(session.id) === String(state.historyBaselineSelectedId || "");
    });
    els.historyBaselineApply.disabled =
      !selected || state.historyBaselineLoading || state.historyBaselineLoadingMore;
    els.historyBaselineApply.textContent = state.historyBaselineLoading ||
      state.historyBaselineLoadingMore ? "正在读取…" : "用此场对比";
  }

  function renderHistoryBaselineList() {
    if (!els.historyBaselineList) return;
    var sessions = state.historyBaselineSessions || [];
    if (!sessions.length) {
      els.historyBaselineList.innerHTML =
        '<div class="history-baseline-empty">' +
        (state.historyBaselineError
          ? "无法读取同房间候选场次。"
          : state.historyBaselineLoading
          ? "正在读取同房间场次…"
          : "本房间还没有其他已结束场次。") +
        '</div>';
    } else {
      els.historyBaselineList.innerHTML = sessions.map(function (session) {
        var selected = state.historyBaselineMulti
          ? (state.historyBaselineSelectedIds || []).some(function (id) {
              return String(id) === String(session.id);
            })
          : String(session.id) === String(state.historyBaselineSelectedId || "");
        var disabled = state.historyBaselineMulti &&
          (state.historyBaselineSelectedIds || []).length >= 3 && !selected;
        var relation = session.relation || (
          Number(session.started_at) < Number(state.historyDetailSession.started_at)
            ? "earlier"
            : Number(session.started_at) > Number(state.historyDetailSession.started_at)
              ? "later"
              : "same_start"
        );
        var mock = Number(session.mock_received || 0) +
          Number(session.mock_spoken || 0) + Number(session.mock_dropped || 0);
        return '<label class="history-baseline-item' +
          (selected ? " is-selected" : "") + '">' +
          '<input type="' + (state.historyBaselineMulti ? "checkbox" : "radio") +
            '" name="' + (state.historyBaselineMulti
              ? "history-baseline-multi" : "history-baseline") +
            '" value="' + escapeHtml(session.id) + '"' +
            (selected ? " checked" : "") + (disabled ? " disabled" : "") + '>' +
          '<span class="history-baseline-main">' +
            '<span class="history-baseline-top"><b>' +
              escapeHtml(formatDateTime(session.started_at)) + '</b>' +
              '<i>' + escapeHtml(historyBaselineRelationLabel(relation)) + '</i>' +
              (mock ? '<i class="is-muted">含模拟数据</i>' : '') +
            '</span>' +
            '<span class="history-baseline-stats">时长 ' +
              escapeHtml(formatDuration(historyDurationOf(session))) +
              ' · 收到 ' + escapeHtml(session.real_received || 0) +
              ' · 开始朗读 ' + escapeHtml(session.real_spoken || 0) +
              ' · ' + escapeHtml(historyEndLabel(session.end_reason)) +
            '</span>' +
          '</span>' +
          '<span class="history-baseline-pick">' +
            (selected ? "已选" : "选择") + '</span>' +
        '</label>';
      }).join("");
    }
    if (els.historyBaselineCount) {
      els.historyBaselineCount.textContent = state.historyBaselineLoading
        ? "正在读取…"
        : "共 " + Number(state.historyBaselineTotal || 0) +
          " 场 · 已加载 " + sessions.length + " 场";
    }
    if (els.historyBaselineMore) {
      els.historyBaselineMore.hidden = !state.historyBaselineHasMore ||
        !!state.historyBaselineLoading;
      els.historyBaselineMore.disabled = !!state.historyBaselineLoadingMore;
      els.historyBaselineMore.textContent = state.historyBaselineLoadingMore
        ? "正在加载更多…"
        : "加载更多";
    }
    if (els.historyBaselineRecent) {
      els.historyBaselineRecent.hidden =
        !state.historyBaselineMulti || sessions.length === 0;
    }
    renderHistoryBaselineChips();
    updateHistoryBaselineApply();
  }

  function syncHistoryBaselineOptions() {
    if (!els.historyBaselineList) return;
    var selectedIds = state.historyBaselineSelectedIds || [];
    var atLimit = state.historyBaselineMulti && selectedIds.length >= 3;
    Array.prototype.forEach.call(
      els.historyBaselineList.querySelectorAll(".history-baseline-item"),
      function (item) {
        var input = item.querySelector("input");
        if (!input) return;
        var selected = state.historyBaselineMulti
          ? selectedIds.some(function (id) {
              return String(id) === String(input.value);
            })
          : String(input.value) === String(state.historyBaselineSelectedId || "");
        input.checked = selected;
        if (state.historyBaselineMulti) input.disabled = atLimit && !selected;
        item.classList.toggle("is-selected", selected);
        var pick = item.querySelector(".history-baseline-pick");
        if (pick) pick.textContent = selected ? "已选" : "选择";
      }
    );
  }

  function selectHistoryBaseline(id) {
    var value = String(id || "");
    if (state.historyBaselineMulti) {
      var selected = (state.historyBaselineSelectedIds || []).slice();
      var index = selected.indexOf(value);
      if (index >= 0) {
        selected.splice(index, 1);
      } else if (selected.length < 3) {
        selected.push(value);
      } else {
        setHistoryBaselineStatus("最多选择 3 场；请先取消一场。", "error", false);
        renderHistoryBaselineList();
        return;
      }
      state.historyBaselineSelectedIds = selected;
      state.historyBaselineSelectedId = "";
    } else {
      state.historyBaselineSelectedId = value;
      state.historyBaselineSelectedIds = [];
    }
    syncHistoryBaselineOptions();
    renderHistoryBaselineChips();
    updateHistoryBaselineApply();
  }

  function selectRecentHistoryBaselines() {
    if (!state.historyBaselineMulti) return;
    var recent = (state.historyBaselineSessions || []).slice().sort(function (left, right) {
      var diff = Number(right.started_at || 0) - Number(left.started_at || 0);
      if (diff) return diff;
      return String(left.id).localeCompare(String(right.id));
    }).slice(0, 3).map(function (session) {
      return String(session.id);
    });
    if (recent.length < 2) {
      setHistoryBaselineStatus("可用场次不足 2 场。", "error", false);
      return;
    }
    state.historyBaselineSelectedIds = recent;
    state.historyBaselineSelectedId = "";
    renderHistoryBaselineList();
    setHistoryBaselineStatus("已选择最近 " + recent.length + " 场。", "", false);
  }

  function loadHistoryBaselines(append) {
    if (!state.historyBaselineOpen || state.historyBaselineLoading ||
        state.historyBaselineLoadingMore) return;
    var current = state.historyDetailSession;
    if (!current || !current.id) return;
    var api = ctx.api;
    if (typeof api.listBaselines !== "function") {
      setHistoryBaselineStatus("后端未提供基准场候选接口。", "error", false);
      return;
    }
    var cursor = append ? state.historyBaselineCursor : null;
    var seq = ++state.historyBaselineSeq;
    var previousScrollTop = els.historyBaselineList
      ? els.historyBaselineList.scrollTop
      : 0;
    state.historyBaselineLoading = !append;
    state.historyBaselineLoadingMore = !!append;
    state.historyBaselineError = "";
    if (!append) {
      state.historyBaselineSessions = [];
      state.historyBaselineCursor = null;
      state.historyBaselineHasMore = false;
      state.historyBaselineTotal = 0;
      state.historyBaselineSelectedId = "";
    }
    setHistoryBaselineStatus(
      append ? "正在加载更多同房间场次…" : "正在读取同房间场次…",
      "",
      false
    );
    renderHistoryBaselineList();
    Promise.resolve(api.listBaselines(String(current.id), 30, cursor)).then(function (result) {
      if (!state.historyBaselineOpen || seq !== state.historyBaselineSeq ||
          !state.historyDetailSession ||
          String(state.historyDetailSession.id) !== String(current.id)) return;
      if (!result || result.ok === false) {
        if (result && result.error_code === "target_not_found") {
          closeHistoryBaselinePicker({ restoreFocus: false });
          ctx.modules.history.closeHistoryDetail();
          state.historyLoaded = false;
          ctx.modules.history.loadHistory(true).then(function () {
            state.historyNotice = "当前场次已不存在，历史列表已刷新。";
            ctx.modules.history.renderHistoryList();
          });
          return;
        }
        state.historyBaselineError = historyCompareErrorMessage(result);
        setHistoryBaselineStatus(
          "无法读取同房间历史：" + historyCompareErrorMessage(result),
          "error",
          true
        );
        return;
      }
      var incoming = Array.isArray(result.candidates) ? result.candidates : [];
      var merged = append ? (state.historyBaselineSessions || []).slice() : [];
      var known = new Set(merged.map(function (session) { return String(session.id); }));
      var currentPlatform = String(current.platform || "").trim();
      var currentRoomKey = String(current.room_key || "").trim();
      incoming.forEach(function (session) {
        var id = String(session && session.id || "");
        if (!id || id === String(current.id) || known.has(id)) return;
        if (String(session.platform || "").trim() !== currentPlatform ||
            String(session.room_key || "").trim() !== currentRoomKey) return;
        known.add(id);
        merged.push(session);
      });
      state.historyBaselineSessions = merged;
      state.historyBaselineError = "";
      state.historyBaselineTotal = Number(result.total) || merged.length;
      state.historyBaselineCursor = result.next_cursor || null;
      state.historyBaselineHasMore = !!result.has_more && !!result.next_cursor;
      if (state.historyBaselineSelectedId &&
          !merged.some(function (session) {
            return String(session.id) === String(state.historyBaselineSelectedId);
          })) {
        state.historyBaselineSelectedId = "";
      }
      renderHistoryBaselineList();
      if (els.historyBaselineList) {
        els.historyBaselineList.scrollTop = previousScrollTop;
      }
      if (!merged.length) {
        setHistoryBaselineStatus("本房间还没有其他已结束场次。", "", false);
      } else if (historyCompareHealthWarning(result)) {
        setHistoryBaselineStatus(
          historyCompareHealthWarning(result) + "，候选可能暂时不完整。",
          "",
          false
        );
      } else {
        setHistoryBaselineStatus("", "", false);
      }
    }).catch(function () {
      if (!state.historyBaselineOpen || seq !== state.historyBaselineSeq) return;
      state.historyBaselineError = "读取失败";
      setHistoryBaselineStatus("无法读取同房间历史，请稍后重试。", "error", true);
    }).then(function () {
      if (seq !== state.historyBaselineSeq) return;
      state.historyBaselineLoading = false;
      state.historyBaselineLoadingMore = false;
      renderHistoryBaselineList();
      if (append) {
        var target = null;
        if (state.historyBaselineHasMore && els.historyBaselineMore &&
            !els.historyBaselineMore.hidden) {
          target = els.historyBaselineMore;
        } else if (els.historyBaselineList) {
          var inputs = els.historyBaselineList.querySelectorAll("input:not([disabled])");
          target = inputs.length ? inputs[inputs.length - 1] : null;
        }
        if (!target) target = els.historyBaselineClose;
        if (target) {
          target.focus();
        }
      }
    });
  }

  function openHistoryBaselinePicker(options) {
    var opts = options && typeof options === "object" ? options : {};
    if (state.historyBaselineOpen) return;
    if (!ctx.root.historyArbitraryCompareSupported()) {
      setHistoryCompareStatus("当前后端版本不支持任意基准场对比。", "error");
      return;
    }
    var current = state.historyDetailSession;
    if (!current || !current.id) return;
    if (!current.platform || !current.room_key) {
      setHistoryCompareStatus("当前场缺少平台或房间标识，无法选择基准场。", "error");
      return;
    }
    state.historyBaselineOpen = true;
    state.historyBaselineLoading = false;
    state.historyBaselineLoadingMore = false;
    state.historyBaselineSessions = [];
    state.historyBaselineTotal = 0;
    state.historyBaselineHasMore = false;
    state.historyBaselineError = "";
    state.historyBaselineCursor = null;
    state.historyBaselineSelectedId = "";
    state.historyBaselineSelectedIds = [];
    state.historyBaselineMulti = !!opts.multi && ctx.root.historyMultiCompareSupported();
    state.historyBaselineLastFocus = document.activeElement;
    state.historyBaselineSeq += 1;
    renderHistoryBaselineCurrent();
    setHistoryBaselineMode(state.historyBaselineMulti ? "multi" : "single", {
      keepStatus: true
    });
    if (state.historyBaselineMulti && state.historyMultiCompareData) {
      state.historyBaselineSelectedIds = (state.historyMultiCompareData.baselines || [])
        .map(function (item) { return String(item.id); })
        .slice(0, 3);
      renderHistoryBaselineList();
    }
    setHistoryBaselineStatus("正在读取同房间场次…", "", false);
    if (els.historyBaselineModal) els.historyBaselineModal.hidden = false;
    var app = document.querySelector(".app");
    if (app) {
      app.setAttribute("inert", "");
      app.setAttribute("aria-hidden", "true");
    }
    requestAnimationFrame(function () {
      if (els.historyBaselineClose) els.historyBaselineClose.focus();
    });
    loadHistoryBaselines(false);
  }

  function closeHistoryBaselinePicker(options) {
    if (!state.historyBaselineOpen) return;
    var opts = options && typeof options === "object" ? options : {};
    state.historyBaselineOpen = false;
    state.historyBaselineLoading = false;
    state.historyBaselineLoadingMore = false;
    state.historyBaselineMulti = false;
    state.historyBaselineSelectedIds = [];
    state.historyBaselineSeq += 1;
    if (els.historyBaselineModal) els.historyBaselineModal.hidden = true;
    var app = document.querySelector(".app");
    if (app) {
      app.removeAttribute("inert");
      app.removeAttribute("aria-hidden");
    }
    if (opts.restoreFocus === false) return;
    var back = state.historyBaselineLastFocus;
    state.historyBaselineLastFocus = null;
    if (back && document.contains(back) && typeof back.focus === "function") {
      try { back.focus({ preventScroll: true }); }
      catch (e) { back.focus(); }
    }
  }

  function openHistoryComparisonWithBaseline(baselineId) {
    var current = state.historyDetailSession;
    if (!current || !current.id || !baselineId) return;
    var api = ctx.api;
    if (typeof api.compareSessions !== "function") {
      setHistoryCompareStatus("后端未提供任意基准场对比接口。", "error");
      return;
    }
    state.historyMultiCompareSeq += 1;
    state.historyMultiCompareLoading = false;
    var requestSeq = ++state.historyCompareRequestSeq;
    state.historyCompareLoading = true;
    var keepCompareScroll = state.historyView === "compare"
      ? state.historyCompareScrollTop
      : (els.historyDetailPane ? els.historyDetailPane.scrollTop : 0);
    setHistoryCompareStatus("正在载入基准场对比…", "busy");
    Promise.resolve(api.compareSessions(String(current.id), String(baselineId))).then(function (result) {
      if (requestSeq !== state.historyCompareRequestSeq ||
          state.historySelectedId !== String(current.id) ||
          state.historyMode !== "detail" ||
          !state.historyDetailSession ||
          String(state.historyDetailSession.id) !== String(current.id)) return;
      if (!result || result.ok === false) {
        if (result && result.error_code === "target_not_found") {
          ctx.modules.history.closeHistoryDetail();
          state.historyLoaded = false;
          ctx.modules.history.loadHistory(true).then(function () {
            state.historyNotice = "当前场次已不存在，历史列表已刷新。";
            ctx.modules.history.renderHistoryList();
          });
          return;
        }
        throw new Error(historyCompareErrorMessage(result));
      }
      state.historyDetailSession = result.target || current;
      state.historyCompare = result.baseline;
      state.historyCompareSource = "manual";
      state.historyCompareEntry = "baseline";
      state.historyCompareScrollTop = keepCompareScroll;
      renderHistoryCompare(state.historyDetailSession, result.baseline, "manual");
      var healthWarning = historyCompareHealthWarning(result);
      if (healthWarning) {
        setHistoryCompareStatus(healthWarning, "empty");
      }
      if (els.historyDetailPane) els.historyDetailPane.scrollTop = 0;
      ctx.modules.history.focusHistoryDetail();
    }).catch(function (error) {
      if (requestSeq !== state.historyCompareRequestSeq ||
          state.historySelectedId !== String(current.id) ||
          state.historyMode !== "detail") return;
      setHistoryCompareStatus("对比失败：" +
        (error && error.message ? error.message : "未知错误"), "error");
      var status = els.historyDetail
        ? els.historyDetail.querySelector("[data-history-compare-status]")
        : null;
      if (status && typeof status.focus === "function") status.focus();
    }).then(function () {
      if (requestSeq !== state.historyCompareRequestSeq) return;
      state.historyCompareLoading = false;
    });
  }

  function applyHistoryBaselineSelection() {
    if (state.historyBaselineMulti) {
      var ids = (state.historyBaselineSelectedIds || []).slice(0, 3);
      if (ids.length < 2) return;
      closeHistoryBaselinePicker();
      ctx.root.openHistoryMultiComparison(ids);
      return;
    }
    var id = String(state.historyBaselineSelectedId || "");
    if (!id) return;
    closeHistoryBaselinePicker();
    openHistoryComparisonWithBaseline(id);
  }

  function openHistoryCompare() {
    var current = state.historyDetailSession;
    if (!current || !current.id) return;
    var api = ctx.api;
    var button = els.historyDetail
      ? els.historyDetail.querySelector("[data-history-compare]")
      : null;
    var returnLabel = state.historyView === "compare" ? "改用上一场" : "对比上一场";
    if (typeof api.previousSession !== "function") {
      setHistoryCompareStatus("后端未提供上一场对比接口。", "error");
      return;
    }
    var requestSeq = ++state.historyCompareRequestSeq;
    state.historyCompareLoading = true;
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "读取上一场…";
    }
    setHistoryCompareStatus("正在查找同平台同房间的上一场…", "busy");

    Promise.resolve(api.previousSession(String(current.id))).then(function (result) {
      if (requestSeq !== state.historyCompareRequestSeq ||
          state.historySelectedId !== String(current.id) ||
          state.historyMode !== "detail") return;
      if (!result || result.ok === false) {
        if (result && result.error_code === "target_not_found") {
          ctx.modules.history.closeHistoryDetail();
          state.historyLoaded = false;
          ctx.modules.history.loadHistory(true).then(function () {
            state.historyNotice = "当前场次已不存在，历史列表已刷新。";
            ctx.modules.history.renderHistoryList();
          });
          return;
        }
        throw new Error(historyCompareErrorMessage(result));
      }
      if (!result.has_previous || !result.previous) {
        setHistoryCompareStatus("没有更早的同房间场次可对比。", "empty");
        var emptyStatus = els.historyDetail
          ? els.historyDetail.querySelector("[data-history-compare-status]")
          : null;
        if (emptyStatus && typeof emptyStatus.focus === "function") {
          emptyStatus.focus();
        }
        return;
      }
      state.historyDetailSession = result.target || current;
      state.historyCompare = result.previous;
      state.historyCompareSource = "previous";
      state.historyCompareEntry = "previous";
      state.historyCompareScrollTop = els.historyDetailPane
        ? els.historyDetailPane.scrollTop
        : 0;
      renderHistoryCompare(state.historyDetailSession, result.previous, "previous");
      if (els.historyDetailPane) els.historyDetailPane.scrollTop = 0;
      ctx.modules.history.focusHistoryDetail();
    }).catch(function (error) {
      if (requestSeq !== state.historyCompareRequestSeq ||
          state.historySelectedId !== String(current.id) ||
          state.historyMode !== "detail") return;
      setHistoryCompareStatus("对比失败：" +
        (error && error.message ? error.message : "未知错误"), "error");
      var status = els.historyDetail
        ? els.historyDetail.querySelector("[data-history-compare-status]")
        : null;
      if (status && typeof status.focus === "function") status.focus();
    }).then(function () {
      state.historyCompareLoading = false;
      if (requestSeq !== state.historyCompareRequestSeq) return;
      var liveButton = els.historyDetail
        ? els.historyDetail.querySelector("[data-history-compare]")
        : null;
      if (liveButton) {
        liveButton.disabled = false;
        liveButton.removeAttribute("aria-busy");
        liveButton.textContent = returnLabel;
      }
    });
  }

  function historyCompareRow(label, current, previous, delta, deltaClass) {
    var display = function (value) { return value == null ? "—" : value; };
    return '<tr><th scope="row">' + escapeHtml(label) + '</th><td>' +
      escapeHtml(display(current)) + '</td><td>' + escapeHtml(display(previous)) + '</td>' +
      '<td class="' + (deltaClass || "") + '">' + escapeHtml(display(delta)) + '</td></tr>';
  }

  function renderHistoryCompare(current, baseline, source) {
    if (!els.historyDetail || !current || !baseline) return;
    state.historyView = "compare";
    state.historyCompare = baseline;
    state.historyCompareSource = source === "manual" ? "manual" : "previous";
    state.historyCompareEntry = state.historyCompareSource === "manual"
      ? "baseline"
      : "previous";
    var model = historyComparisonModel(current, baseline);
    var c = model.current;
    var b = model.baseline;
    var delta = function (cv, pv, digits, suffix, suppress) {
      if (suppress || cv == null || pv == null) return "—";
      return historyFormatDelta(cv - pv, digits, suffix);
    };
    var hourDelta = function (cv, pv) {
      if (model.suppressRateDeltas || cv == null || pv == null) return "—";
      return historyFormatDelta(cv - pv, 1, "/时");
    };
    var ppDelta = function (cv, pv) {
      if (model.suppressRateDeltas || cv == null || pv == null) return "—";
      return historyFormatDelta((cv - pv) * 100, 1, "pp");
    };
    var rows = [
      historyCompareRow("时长", formatDuration(c.duration), formatDuration(b.duration), "", ""),
      historyCompareRow("收到", c.received, b.received, delta(c.received, b.received, 0, " 条", model.suppressTotalDeltas), ""),
      historyCompareRow("开始朗读", c.spoken, b.spoken, delta(c.spoken, b.spoken, 0, " 条", model.suppressTotalDeltas), ""),
      historyCompareRow("硬丢弃", c.dropped, b.dropped, delta(c.dropped, b.dropped, 0, " 条", model.suppressTotalDeltas), ""),
      historyCompareRow("收到 / 小时", historyFormatRate(c.receivedPerHour), historyFormatRate(b.receivedPerHour), hourDelta(c.receivedPerHour, b.receivedPerHour), ""),
      historyCompareRow("开始朗读 / 小时", historyFormatRate(c.spokenPerHour), historyFormatRate(b.spokenPerHour), hourDelta(c.spokenPerHour, b.spokenPerHour), ""),
      historyCompareRow("开始朗读率", historyFormatPercent(c.spokenRate == null ? null : c.spokenRate * 100), historyFormatPercent(b.spokenRate == null ? null : b.spokenRate * 100), ppDelta(c.spokenRate, b.spokenRate), ""),
      historyCompareRow("硬丢弃率", historyFormatPercent(c.droppedRate == null ? null : c.droppedRate * 100), historyFormatPercent(b.droppedRate == null ? null : b.droppedRate * 100), ppDelta(c.droppedRate, b.droppedRate), ""),
      historyCompareRow("UID 去重", c.users, b.users, delta(c.users, b.users, 0, " 人", model.suppressTotalDeltas), ""),
      historyCompareRow("互动 UID / 小时", historyFormatRate(c.usersPerHour), historyFormatRate(b.usersPerHour), hourDelta(c.usersPerHour, b.usersPerHour), ""),
      historyCompareRow("峰值 5 分钟", c.peak5m, b.peak5m, delta(c.peak5m, b.peak5m, 0, " 条", model.suppressTotalDeltas), "")
    ].join("");

    var currentTypes = current.types && typeof current.types === "object" ? current.types : {};
    var baselineTypes = baseline.types && typeof baseline.types === "object" ? baseline.types : {};
    var typeRows = TYPE_META.map(function (meta) {
      var cShare = c.typedTotal ? historyNumber(currentTypes[meta.key]) / c.typedTotal * 100 : null;
      var bShare = b.typedTotal ? historyNumber(baselineTypes[meta.key]) / b.typedTotal * 100 : null;
      var typeDelta = model.suppressTypeDeltas || cShare == null || bShare == null
        ? "—"
        : historyFormatDelta(cShare - bShare, 1, "pp");
      return historyCompareRow(meta.label, historyFormatPercent(cShare), historyFormatPercent(bShare), typeDelta, "");
    }).join("");

    var flags = model.flags.length
      ? '<div class="history-compare-flags" role="note">' + model.flags.map(function (flag) {
          return '<span>' + escapeHtml(flag) + '</span>';
        }).join("") + '</div>'
      : "";
    var title = escapeHtml(historyRoomLabel(current));
    var baselineTitle = escapeHtml(historyRoomLabel(baseline));
    var sourceLabel = state.historyCompareSource === "manual" ? "手动选择" : "上一场 · 自动";
    var moneyComparable = platformMoneyComparable(current.platform);
    var currentCapability = platformCapability(current.platform);
    var moneyUnavailable = currentCapability.money_note || "该平台金额口径未接入";
    var giftLabel = currentCapability.gift_value_unit === "diamond"
      ? "礼物价值" : "礼物（本机字段）";
    var scLabel = currentCapability.supports_super_chat ? "SC（本机字段）" : "SC / 舰长";
    var giftUnavailable = currentCapability.gift_value_unit === "diamond"
      ? "仅单条钻石 · 不汇总" : "口径未接入";
    var scUnavailable = currentCapability.supports_super_chat ? "口径未接入" : "平台未提供";
    var baselineAction = state.historyCompareSource === "manual"
      ? '<button class="btn btn-ghost btn-sm" type="button" data-history-compare>改用上一场</button>'
      : "";
    els.historyDetail.hidden = false;
    els.historyDetail.innerHTML =
      '<div class="history-detail-head history-compare-head">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-history-compare-back>返回概览</button>' +
        '<div class="history-detail-title"><span class="workspace-eyebrow">只读对比</span>' +
          '<h2 tabindex="-1" data-history-focus>场次对比</h2>' +
          '<p>' + title + ' · ' + escapeHtml(formatDateTime(current.started_at)) +
          ' → ' + escapeHtml(formatDateTime(current.ended_at)) + '</p></div>' +
        '<div class="history-detail-actions">' +
          (ctx.root.historyArbitraryCompareSupported()
            ? '<button class="btn btn-ghost btn-sm" type="button" data-history-baseline aria-haspopup="dialog" aria-controls="historyBaselineModal">更换基准场</button>'
            : '') +
          baselineAction +
          ctx.root.renderHistoryAnalysisExportActions("compare") +
        '</div>' +
      '</div>' +
      '<p class="history-compare-status" data-history-compare-status role="status" aria-live="polite" tabindex="-1" hidden></p>' +
      '<p class="history-export-status history-analysis-export-status" data-analysis-export-status="compare" role="status" aria-live="polite" hidden></p>' +
      '<div class="history-compare-scope">同平台 · 同房间 · 仅已结束场次 · 变化 = 当前 − 基准</div>' +
      '<div class="history-compare-context">' +
        '<div class="history-compare-session is-current" data-side="current">' +
          '<span>当前记录</span><b>' + title + '</b><small>' +
          escapeHtml(platformLabel(current.platform)) + ' · ' +
          escapeHtml(formatDateTime(current.started_at)) + '</small></div>' +
        '<div class="history-compare-session" data-side="baseline">' +
          '<span>基准场 · ' + escapeHtml(sourceLabel) + '</span><b>' +
          baselineTitle + '</b><small>' +
          escapeHtml(platformLabel(baseline.platform)) + ' · ' +
          escapeHtml(formatDateTime(baseline.started_at)) + ' · ' +
          escapeHtml(historyEndLabel(baseline.end_reason)) + '</small></div>' +
      '</div>' +
      flags +
      '<div class="history-compare-grid">' +
        '<section class="history-compare-section"><h3>节奏与响应</h3>' +
          '<table class="history-compare-table"><caption>当前记录与基准场核心指标，变化为当前减基准</caption>' +
          '<thead><tr><th scope="col">指标</th><th scope="col">当前记录</th><th scope="col">基准场</th><th scope="col">变化</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table></section>' +
        '<section class="history-compare-section"><h3>类型结构</h3>' +
          '<table class="history-compare-table"><caption>当前记录与基准场类型占比</caption>' +
          '<thead><tr><th scope="col">类型</th><th scope="col">当前记录</th><th scope="col">基准场</th><th scope="col">变化</th></tr></thead>' +
          '<tbody>' + typeRows + '</tbody></table></section>' +
        '<section class="history-compare-section"><h3>金额与状态</h3>' +
          '<table class="history-compare-table"><caption>当前记录与基准场本机金额字段</caption>' +
          '<thead><tr><th scope="col">项目</th><th scope="col">当前记录</th><th scope="col">基准场</th><th scope="col">说明</th></tr></thead>' +
          '<tbody>' +
            historyCompareRow(giftLabel, moneyComparable ? historyGiftText(current) : giftUnavailable, moneyComparable ? historyGiftText(baseline) : giftUnavailable, moneyComparable ? "不跨币种相加" : moneyUnavailable, "") +
            historyCompareRow(scLabel, moneyComparable ? ctx.root.formatMoney(current.super_chat_cny) : scUnavailable, moneyComparable ? ctx.root.formatMoney(baseline.super_chat_cny) : scUnavailable, moneyComparable ? "仅本机字段" : moneyUnavailable, "") +
            historyCompareRow("结束方式", historyEndLabel(current.end_reason), historyEndLabel(baseline.end_reason), "", "") +
          '</tbody></table></section>' +
      '</div>' +
      '<p class="history-compare-note">基准场可以是同房间更早或更晚的任意已结束场次；不随主历史列表搜索、日期或平台筛选变化。变化值不表示“更好/更差”。</p>';
  }

  function historyMultiValue(metrics, key) {
    if (!metrics) return "—";
    var value = metrics[key];
    if (value == null) return "—";
    if (key === "receivedPerHour" || key === "spokenPerHour" || key === "usersPerHour") {
      return historyFormatRate(value);
    }
    if (key === "spokenRate" || key === "droppedRate") {
      return historyFormatPercent(value * 100);
    }
    return String(value);
  }

  function historyMultiDelta(model, key) {
    var current = model.current;
    var baseline = model.baseline;
    var currentValue = current[key];
    var baselineValue = baseline[key];
    if (currentValue == null || baselineValue == null) return "—";
    var difference = currentValue - baselineValue;
    if (key === "receivedPerHour" || key === "spokenPerHour" || key === "usersPerHour") {
      return model.suppressRateDeltas ? "—" : historyFormatDelta(difference, 1, "/时");
    }
    if (key === "spokenRate" || key === "droppedRate") {
      return model.suppressRateDeltas ? "—" : historyFormatDelta(difference * 100, 1, "pp");
    }
    if (key === "users" || key === "peak5m") {
      return model.suppressTotalDeltas ? "—" : historyFormatDelta(difference, 0,
        key === "users" ? " 人" : " 条");
    }
    return model.suppressTotalDeltas ? "—" : historyFormatDelta(difference, 0, " 条");
  }

  function historyMultiSampleFlags(session) {
    var flags = [];
    var duration = historyDurationOf(session);
    var received = historyNumber(session && session.real_received);
    var endReason = String(session && session.end_reason || "");
    var knownEndReasons = [
      "", "finished", "manual_disconnect", "replaced", "shutdown",
      "stale", "interrupted", "connect_failed"
    ];
    if (duration < 600 || received < 20) flags.push("样本偏短");
    if (["stale", "interrupted", "connect_failed"].indexOf(endReason) >= 0) {
      flags.push("结束不完整");
    } else if (knownEndReasons.indexOf(endReason) < 0) {
      flags.push("结束方式未知");
    }
    if (historyNumber(session && session.mock_received) > 0) {
      flags.push("含模拟已排除 " + historyNumber(session.mock_received) + " 条");
    }
    if (received === 0) {
      flags.push("没有真实消息样本");
    } else {
      if (historyTypeTotal(session) !== received) flags.push("类型样本不完整");
      if (historyMinutesTotal(session) !== historyTypeTotal(session)) {
        flags.push("节奏样本不完整");
      }
    }
    return flags;
  }

  function historyMultiQualityFlags(session, item, isCurrent) {
    var flags = historyMultiSampleFlags(session);
    if (!isCurrent && item) {
      if (item.overlaps_target) flags.push("与当前场重叠");
      if ((item.overlaps_baselines || []).length) {
        flags.push("与 " + item.overlaps_baselines.join("、") + " 重叠");
      }
      if (item.relation === "later") flags.push("晚于当前场");
    }
    return flags;
  }

  function historyMultiContextCard(session, label, item, isCurrent) {
    var quality = historyMultiQualityFlags(session, item, isCurrent);
    var relation = !isCurrent && item
      ? historyBaselineRelationLabel(item.relation)
      : "当前记录";
    return '<article class="history-multi-context-card' +
      (isCurrent ? " is-current" : "") + '" data-side="' +
      (isCurrent ? "current" : "baseline") + '">' +
      '<span class="history-multi-context-label">' + escapeHtml(label) + '</span>' +
      '<b>' + escapeHtml(historyRoomLabel(session)) + '</b>' +
      '<small>' + escapeHtml(formatDateTime(session.started_at)) + ' → ' +
        escapeHtml(formatDateTime(session.ended_at)) + '</small>' +
      '<div class="history-multi-context-meta"><span>' +
        escapeHtml(historyDurationOf(session) ? formatDuration(historyDurationOf(session)) : "—") +
        ' · ' + escapeHtml(historyEndLabel(session.end_reason)) + ' · ' +
        escapeHtml(relation) + '</span></div>' +
      '<div class="history-multi-context-flags">' +
        (quality.length
          ? quality.map(function (flag) { return '<span>' + escapeHtml(flag) + '</span>'; }).join("")
          : '<span>样本完整</span>') +
      '</div></article>';
  }

  function historyMultiResponseValid(result, targetId, ids) {
    if (!result || !result.target || !Array.isArray(result.baselines)) return false;
    var target = result.target;
    if (String(target.id || "") !== String(targetId)) return false;
    if (!target.platform || !target.room_key) return false;
    if (target.started_at == null || target.ended_at == null ||
        !isFinite(Number(target.started_at)) ||
        !isFinite(Number(target.ended_at)) ||
        Number(target.ended_at) < Number(target.started_at)) return false;
    if (!target.types || typeof target.types !== "object") return false;
    if (result.baselines.length !== ids.length) return false;
    for (var index = 0; index < ids.length; index += 1) {
      var item = result.baselines[index];
      if (!item || !item.session) return false;
      if (Number(item.index) !== index + 1) return false;
      if (String(item.id || "") !== String(ids[index])) return false;
      var session = item.session;
      if (String(session.id || "") !== String(ids[index])) return false;
      if (!session.platform || !session.room_key) return false;
      if (String(session.platform) !== String(target.platform) ||
          String(session.room_key) !== String(target.room_key)) return false;
      if (session.started_at == null || session.ended_at == null ||
          !isFinite(Number(session.started_at)) ||
          !isFinite(Number(session.ended_at)) ||
          Number(session.ended_at) < Number(session.started_at)) return false;
      if (!session.types || typeof session.types !== "object") return false;
    }
    return true;
  }

  function historyMultiEmpty(title, message) {
    if (!els.historyDetail) return;
    state.historyView = "multi_compare";
    state.historyCompareEntry = "multi";
    els.historyDetail.hidden = false;
    els.historyDetail.innerHTML =
      '<div class="history-detail-head">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-history-compare-back>返回概览</button>' +
        '<div class="history-detail-title"><span class="workspace-eyebrow">只读对比</span>' +
        '<h2 tabindex="-1" data-history-focus>' + escapeHtml(title) + '</h2></div>' +
      '</div>' +
      '<div class="history-multi-empty" role="alert">' + escapeHtml(message) + '</div>';
    if (state.historyMultiCompareFocusPending) {
      state.historyMultiCompareFocusPending = false;
      ctx.modules.history.focusHistoryDetail();
    }
  }

  function renderHistoryMultiCompare(data) {
    if (!els.historyDetail || !data || !data.target) return;
    var target = data.target;
    var items = Array.isArray(data.baselines) ? data.baselines : [];
    var models = items.map(function (item) {
      return historyComparisonModel(target, item.session);
    });
    var currentMetrics = historySessionMetrics(target);
    var labels = ["当前记录"].concat(items.map(function (item) {
      return "B" + item.index;
    }));
    var metricDefs = [
      ["received", "收到", ""],
      ["spoken", "开始朗读", ""],
      ["dropped", "硬丢弃", ""],
      ["receivedPerHour", "收到 / 小时", "rate"],
      ["spokenPerHour", "开始朗读 / 小时", "rate"],
      ["spokenRate", "开始朗读率", "percent"],
      ["droppedRate", "硬丢弃率", "percent"],
      ["usersPerHour", "互动 UID / 小时", "rate"],
      ["peak5m", "峰值 5 分钟", ""]
    ];
    var matrixRows = metricDefs.map(function (definition) {
      var key = definition[0];
      var cells = '<td><b>' + escapeHtml(historyMultiValue(currentMetrics, key)) +
        '</b><small>当前</small></td>';
      items.forEach(function (item, index) {
        var model = models[index];
        cells += '<td><b>' + escapeHtml(historyMultiValue(model.baseline, key)) +
          '</b><small>' + escapeHtml(historyMultiDelta(model, key)) + '</small></td>';
      });
      return '<tr><th scope="row">' + escapeHtml(definition[1]) +
        '</th>' + cells + '</tr>';
    }).join("");
    var matrixHead = '<th scope="col">指标</th><th scope="col">当前</th>' +
      items.map(function (item) {
        return '<th scope="col">B' + item.index + '<small>' +
          escapeHtml(formatDateTime(item.session.started_at)) + '</small></th>';
      }).join("");
    var typeRows = TYPE_META.map(function (meta) {
      var targetTotal = historyTypeTotal(target);
      var targetShare = targetTotal
        ? historyNumber(target.types[meta.key]) / targetTotal * 100 : null;
      var cells = '<td>' + escapeHtml(historyFormatPercent(targetShare)) + '</td>';
      items.forEach(function (item) {
        var total = historyTypeTotal(item.session);
        var share = total
          ? historyNumber(item.session.types[meta.key]) / total * 100 : null;
        cells += '<td>' + escapeHtml(historyFormatPercent(share)) + '</td>';
      });
      return '<tr><th scope="row"><i class="type-dot" style="--dot:' +
        escapeHtml(typeColor(meta.key)) + '"></i>' + escapeHtml(meta.label) +
        '</th>' + cells + '</tr>';
    }).join("");
    var qualityRows = '<tr><td>当前</td><td>' +
      escapeHtml(formatDuration(historyDurationOf(target))) + '</td><td>' +
      escapeHtml(historyEndLabel(target.end_reason)) + '</td><td>' +
      escapeHtml(historyMultiQualityFlags(target, null, true).join(" · ") || "样本完整") +
      '</td></tr>' + items.map(function (item, index) {
        return '<tr><td>B' + item.index + '</td><td>' +
          escapeHtml(formatDuration(historyDurationOf(item.session))) + '</td><td>' +
          escapeHtml(historyEndLabel(item.session.end_reason)) + '</td><td>' +
          escapeHtml(historyMultiQualityFlags(item.session, item, false).join(" · ") || "样本完整") +
          '</td></tr>';
      }).join("");
    var sampleFlags = [];
    historyMultiSampleFlags(target).forEach(function (flag) {
      sampleFlags.push("当前 " + flag);
    });
    items.forEach(function (item) {
      historyMultiSampleFlags(item.session).forEach(function (flag) {
        sampleFlags.push("B" + item.index + " " + flag);
      });
      var currentDuration = historyDurationOf(target);
      var baselineDuration = historyDurationOf(item.session);
      if (currentDuration > 0 && baselineDuration > 0 &&
          Math.max(currentDuration, baselineDuration) /
            Math.min(currentDuration, baselineDuration) > 2) {
        sampleFlags.push("B" + item.index + " 与当前时长差异大");
      }
    });
    var overlapText = (data.overlap_pairs || []).map(function (pair) {
      if (pair.left === "当前") return pair.right + " 与当前场重叠";
      if (pair.right === "当前") return pair.left + " 与当前场重叠";
      return pair.left + " 与 " + pair.right + " 重叠";
    }).filter(function (text, index, all) {
      return all.indexOf(text) === index;
    });
    var healthText = historyCompareHealthWarning(data);
    var warningItems = [];
    if (healthText) warningItems.push(healthText);
    warningItems = warningItems.concat(overlapText, sampleFlags);
    var scopePlatform = data.scope && data.scope.platform;
    var scopeCapability = platformCapability(scopePlatform);
    var money = platformMoneyComparable(scopePlatform)
      ? '<section class="history-multi-section"><div class="workspace-card-head"><div><span class="workspace-eyebrow">金额</span><h3>本机金额字段</h3></div></div>' +
        '<div class="history-multi-money">' + [target].concat(items.map(function (item) {
          return item.session;
        })).map(function (session, index) {
          return '<div><span>' + escapeHtml(labels[index]) + '</span><b>' +
            escapeHtml(historyGiftText(session)) + '</b><small>SC ' +
            escapeHtml(ctx.root.formatMoney(session.super_chat_cny)) + '</small></div>';
        }).join("") + '</div><p class="workspace-note">金额只读本机字段，不代表平台营收；不跨币种相加。</p></section>'
      : '<section class="history-multi-section"><div class="workspace-card-head"><div><span class="workspace-eyebrow">金额</span><h3>平台金额边界</h3></div></div><p class="history-multi-note">' +
        escapeHtml(scopeCapability.money_note || "该平台金额口径未接入，不参与跨场比较。") +
        '</p></section>';
    els.historyDetail.hidden = false;
    els.historyDetail.innerHTML =
      '<div class="history-detail-head history-compare-head">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-history-compare-back>返回概览</button>' +
        '<div class="history-detail-title"><span class="workspace-eyebrow">只读对比 · ' +
          items.length + ' 个基准</span><h2 tabindex="-1" data-history-focus>多场对比</h2>' +
          '<p>' + escapeHtml(historyRoomLabel(target)) + ' · ' +
          escapeHtml(formatDateTime(target.started_at)) + ' → ' +
          escapeHtml(formatDateTime(target.ended_at)) + '</p></div>' +
        '<div class="history-detail-actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-history-baseline-multi>调整对比场</button>' +
          ctx.root.renderHistoryAnalysisExportActions("compare_multi") +
        '</div>' +
      '</div>' +
      '<p class="history-export-status history-analysis-export-status" ' +
        'data-analysis-export-status="compare_multi" role="status" aria-live="polite" hidden></p>' +
      '<div class="history-multi-scope">同平台 · 同房间 · 仅已结束场次 · 变化 = 当前 − 基准 · 不表示更好/更差</div>' +
      '<div class="history-multi-context" data-baselines="' + items.length + '">' +
        historyMultiContextCard(target, "当前记录", null, true) +
        items.map(function (item) {
          return historyMultiContextCard(item.session, "B" + item.index, item, false);
        }).join("") +
      '</div>' +
      (warningItems.length
        ? '<div class="history-multi-warnings" role="' +
          (healthText ? "alert" : "note") + '">' +
          warningItems.map(function (flag) {
            return '<span>' + escapeHtml(flag) + '</span>';
          }).join("") + '</div>'
        : "") +
      '<section class="history-multi-section"><div class="workspace-card-head"><div><span class="workspace-eyebrow">核心指标</span><h3>当前与各基准</h3></div></div>' +
        '<div class="history-multi-matrix-wrap"><table class="history-multi-matrix"><caption>当前记录与多个基准场的核心指标，变化为当前减基准</caption>' +
          '<thead><tr>' + matrixHead + '</tr></thead><tbody>' + matrixRows + '</tbody></table></div>' +
      '</section>' +
      '<div class="history-multi-grid">' +
        '<section class="history-multi-section"><div class="workspace-card-head"><div><span class="workspace-eyebrow">结构</span><h3>类型占比</h3></div></div>' +
          '<div class="history-multi-table-wrap"><table class="history-multi-table"><caption>各场次按已识别类型的占比</caption><thead><tr><th scope="col">类型</th>' +
            labels.map(function (label) { return '<th scope="col">' + escapeHtml(label) + '</th>'; }).join("") +
          '</tr></thead><tbody>' + typeRows + '</tbody></table></div>' +
          '<p class="workspace-note">按已识别类型计算；类型样本不完整时仍展示已有类型。</p></section>' +
        '<section class="history-multi-section"><div class="workspace-card-head"><div><span class="workspace-eyebrow">质量</span><h3>样本与结束状态</h3></div></div>' +
          '<div class="history-multi-table-wrap"><table class="history-multi-table"><caption>各场次样本质量和结束状态</caption><thead><tr><th scope="col">场次</th><th scope="col">时长</th><th scope="col">结束方式</th><th scope="col">质量</th></tr></thead><tbody>' +
            qualityRows + '</tbody></table></div></section>' +
      '</div>' +
      money +
      '<p class="workspace-note">多场对比按选择顺序标记 B1–B3；基准之间不做排名，也不计算平均值或最佳基准。</p>';
    state.historyMultiCompareData = data;
    state.historyView = "multi_compare";
    if (state.historyMultiCompareFocusPending) {
      state.historyMultiCompareFocusPending = false;
      ctx.modules.history.focusHistoryDetail();
    }
  }

  function openHistoryMultiComparison(baselineIds) {
    var current = state.historyDetailSession;
    if (!current || !current.id || !ctx.root.historyMultiCompareSupported()) return;
    var ids = (baselineIds || []).map(String).filter(function (id, index, all) {
      return id && all.indexOf(id) === index;
    }).slice(0, 3);
    if (ids.length < 2) {
      setHistoryCompareStatus("多场对比至少选择 2 场。", "error");
      return;
    }
    var api = ctx.api;
    var fromMultiView = state.historyView === "multi_compare";
    state.historyCompareRequestSeq += 1;
    state.historyCompareLoading = false;
    state.historyView = "multi_compare";
    state.historyCompareEntry = "multi";
    var seq = ++state.historyMultiCompareSeq;
    state.historyMultiCompareLoading = true;
    state.historyMultiCompareError = "";
    state.historyMultiCompareFocusPending = true;
    if (!fromMultiView) {
      state.historyMultiCompareScrollTop = els.historyDetailPane
        ? els.historyDetailPane.scrollTop
        : 0;
    }
    if (els.historyDetail) {
      els.historyDetail.hidden = false;
      els.historyDetail.innerHTML =
        '<div class="history-detail-loading" role="status" aria-live="polite" tabindex="-1">' +
        '正在载入多场对比…</div>';
      var loading = els.historyDetail.querySelector(".history-detail-loading");
      if (loading) {
        try { loading.focus({ preventScroll: true }); }
        catch (e) { loading.focus(); }
      }
    }
    Promise.resolve(api.compareMultiSessions(String(current.id), ids)).then(function (result) {
      if (seq !== state.historyMultiCompareSeq ||
          state.historySelectedId !== String(current.id) ||
          state.historyMode !== "detail" ||
          !state.historyDetailSession ||
          String(state.historyDetailSession.id) !== String(current.id)) return;
      if (!result) {
        throw new Error("多场对比暂不可用，请稍后重试。");
      }
      if (result.ok === false) {
        if (result.error_code === "target_not_found") {
          ctx.modules.history.closeHistoryDetail();
          state.historyLoaded = false;
          ctx.modules.history.loadHistory(true).then(function () {
            state.historyNotice = "当前场次已不存在，历史列表已刷新。";
            ctx.modules.history.renderHistoryList();
          });
          return;
        }
        throw new Error(historyCompareErrorMessage(result));
      }
      if (!historyMultiResponseValid(result, current.id, ids)) {
        throw new Error("多场对比数据格式异常，请重试。");
      }
      state.historyDetailSession = result.target || current;
      state.historyCompareEntry = "multi";
      renderHistoryMultiCompare(result);
      if (els.historyDetailPane) els.historyDetailPane.scrollTop = 0;
    }).catch(function (error) {
      if (seq !== state.historyMultiCompareSeq ||
          state.historySelectedId !== String(current.id) ||
          state.historyMode !== "detail") return;
      state.historyMultiCompareError = error && error.message
        ? error.message : "多场对比暂不可用。";
      historyMultiEmpty("多场对比", state.historyMultiCompareError);
    }).then(function () {
      if (seq !== state.historyMultiCompareSeq) return;
      state.historyMultiCompareLoading = false;
    });
  }

  function historyAnalysisExportSupported(kind) {
    var caps = state.snapshot && state.snapshot.history &&
      state.snapshot.history.capabilities;
    if (!caps || Number(caps.analysis_export || 0) < 1) return false;
    var api = ctx.api;
    if (kind === "trend") return typeof api.exportTrendReport === "function";
    if (kind === "compare") return typeof api.exportCompareReport === "function";
    if (kind === "compare_multi") {
      return Number(caps.multi_compare || 0) >= 1 &&
        Number(caps.analysis_export_compare_multi || 0) >= 1 &&
        typeof api.exportCompareMultiReport === "function";
    }
    if (kind === "insights") return typeof api.exportInsightsReport === "function";
    return false;
  }

  function renderHistoryAnalysisExportActions(kind) {
    if (!historyAnalysisExportSupported(kind)) return "";
    return '<div class="history-analysis-export-actions" role="group" aria-label="导出当前分析">' +
      '<button class="btn btn-ghost btn-sm" type="button" data-history-analysis-export="' +
        escapeHtml(kind) + '" data-format="json">导出 JSON</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-history-analysis-export="' +
        escapeHtml(kind) + '" data-format="csv">导出 CSV</button>' +
    '</div>';
  }

  function historyAnalysisExportStatusNode(kind) {
    return els.historyDetail
      ? els.historyDetail.querySelector('[data-analysis-export-status="' + kind + '"]')
      : null;
  }

  function setHistoryAnalysisExportStatus(kind, text, tone, node) {
    node = node || historyAnalysisExportStatusNode(kind);
    if (!node || !document.contains(node)) return;
    if (!text) {
      node.hidden = true;
      node.className = "history-export-status history-analysis-export-status";
      node.textContent = "";
      node.removeAttribute("role");
      return;
    }
    node.hidden = false;
    node.className = "history-export-status history-analysis-export-status is-" +
      (tone || "busy");
    node.setAttribute("role", tone === "error" ? "alert" : "status");
    if (tone === "ok") {
      node.innerHTML = text;
    } else {
      node.textContent = text;
    }
  }

  function historyAnalysisExportViewKey(kind) {
    if (kind === "trend") {
      return [
        "trend",
        state.historyMode,
        state.historyTrendGranularity || "day",
        state.historyTrendLoadedKey || "",
        state.historyTrendData && state.historyTrendData.range
          ? state.historyTrendData.range.started_from + ":" +
            state.historyTrendData.range.started_to
          : ""
      ].join("|");
    }
    if (kind === "compare") {
      return [
        "compare",
        state.historyDetailSession && state.historyDetailSession.id,
        state.historyCompare && state.historyCompare.id,
        state.historyCompareSource
      ].join("|");
    }
    if (kind === "compare_multi") {
      return [
        "compare_multi",
        state.historyDetailSession && state.historyDetailSession.id,
        (state.historyMultiCompareData && state.historyMultiCompareData.baselines || [])
          .map(function (item) { return item.id; }).join(",")
      ].join("|");
    }
    if (kind === "insights") return "insights|" + String(state.historySelectedId || "");
    return kind;
  }

  function exportHistoryAnalysis(kind, format, trigger) {
    var api = ctx.api;
    var normalized = String(format || "json").toLowerCase() === "csv" ? "csv" : "json";
    var buttons = els.historyDetail
      ? Array.prototype.slice.call(els.historyDetail.querySelectorAll(
        '[data-history-analysis-export="' + kind + '"]'
      ))
      : [];
    if (!historyAnalysisExportSupported(kind)) {
      setHistoryAnalysisExportStatus(kind, "当前后端版本未提供分析报告导出。", "error");
      return;
    }
    var statusNode = historyAnalysisExportStatusNode(kind);
    var exportSeq = ++state.historyAnalysisExportSeq;
    var exportViewKey = historyAnalysisExportViewKey(kind);
    var isCurrent = function () {
      return exportSeq === state.historyAnalysisExportSeq &&
        exportViewKey === historyAnalysisExportViewKey(kind) &&
        statusNode && document.contains(statusNode);
    };
    var promise;
    if (kind === "trend") {
      var trend = state.historyTrendData;
      if (!trend || !trend.range || !trend.filters) {
        setHistoryAnalysisExportStatus(kind, "趋势数据尚未加载，无法导出。", "error");
        return;
      }
      var roomKey = trend.scope && trend.scope.room_key
        ? trend.scope.room_key
        : trend.filters.room_key;
      if (!roomKey) {
        setHistoryAnalysisExportStatus(kind, "趋势报告缺少单房间范围，无法导出。", "error");
        return;
      }
      promise = api.exportTrendReport(
        trend.range.started_from,
        trend.range.started_to,
        trend.filters.query || "",
        trend.filters.platform || null,
        trend.granularity || state.historyTrendGranularity || "day",
        roomKey,
        normalized
      );
    } else if (kind === "compare") {
      var current = state.historyDetailSession;
      var baseline = state.historyCompare;
      if (!current || !current.id || !baseline || !baseline.id) {
        setHistoryAnalysisExportStatus(kind, "对比结果尚未加载，无法导出。", "error");
        return;
      }
      promise = api.exportCompareReport(String(current.id), String(baseline.id), normalized);
    } else if (kind === "compare_multi") {
      var multi = state.historyMultiCompareData;
      var multiTarget = multi && multi.target;
      var multiBaselines = multi && Array.isArray(multi.baselines) ? multi.baselines : [];
      if (!multiTarget || !multiTarget.id || multiBaselines.length < 2) {
        setHistoryAnalysisExportStatus(kind, "多场对比结果尚未加载，无法导出。", "error");
        return;
      }
      promise = api.exportCompareMultiReport(
        String(multiTarget.id),
        multiBaselines.map(function (item) { return String(item.id); }),
        normalized
      );
    } else if (kind === "insights") {
      var targetId = state.historySelectedId ||
        (state.historyInsightData && state.historyInsightData.target &&
          state.historyInsightData.target.id);
      if (!targetId) {
        setHistoryAnalysisExportStatus(kind, "复盘目标尚未确定，无法导出。", "error");
        return;
      }
      promise = api.exportInsightsReport(String(targetId), normalized);
    } else {
      return;
    }

    buttons.forEach(function (button) { button.disabled = true; });
    if (trigger) trigger.setAttribute("aria-busy", "true");
    setHistoryAnalysisExportStatus(
      kind,
      "正在由服务端重算并导出 " + normalized.toUpperCase() + "…",
      "busy",
      statusNode
    );
    Promise.resolve(promise).then(function (result) {
      if (!result || result.ok === false) {
        var isCompareExport = kind === "compare" || kind === "compare_multi";
        var message = result && result.error_code && isCompareExport
          ? historyCompareErrorMessage(result)
          : (result && result.error ? result.error : "导出失败");
        throw new Error(message);
      }
      if (!isCurrent()) return;
      var warningCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
      var warningText = warningCount
        ? " · 含 " + warningCount + " 条质量提示"
        : "";
      var qualityCount = Number(result.quality_flag_count || 0);
      if (qualityCount > 0) {
        warningText += " · " + qualityCount + " 个场次质量标记";
      }
      setHistoryAnalysisExportStatus(
        kind,
        "已导出 " + escapeHtml(String(result.format || normalized).toUpperCase()) +
          " · <code>" + escapeHtml(result.path || "文件已写入") + "</code>" + warningText +
          (kind === "trend" ? "" : exportManageLinkHtml()),
        "ok",
        statusNode
      );
    }).catch(function (error) {
      if (!isCurrent()) return;
      setHistoryAnalysisExportStatus(
        kind,
        "导出失败：" + (error && error.message ? error.message : "未知错误"),
        "error",
        statusNode
      );
    }).then(function () {
      buttons.forEach(function (button) { button.disabled = false; });
      if (trigger && document.contains(trigger)) trigger.removeAttribute("aria-busy");
    });
  }

  function exportManageSupported() {
    var caps = state.snapshot && state.snapshot.history &&
      state.snapshot.history.capabilities;
    var api = ctx.api;
    return !!(caps && Number(caps.export_manage || 0) >= 1 &&
      typeof api.exportStorageStatus === "function" &&
      typeof api.exportStoragePreview === "function" &&
      typeof api.exportStoragePrune === "function" &&
      typeof api.openExportDir === "function");
  }

  function exportManageLinkHtml() {
    return exportManageSupported()
      ? ' · <button type="button" class="export-manage-link" data-open-export-manage>管理导出文件</button>'
      : "";
  }

  function syncExportManageEntry() {
    if (!els.exportManage) return;
    els.exportManage.hidden = !exportManageSupported();
  }

  function setExportStatus(text, tone) {
    if (!els.exportPreview) return;
    els.exportPreview.className = "export-manage-preview" +
      (tone ? " is-" + tone : "");
    els.exportPreview.textContent = text;
  }

  function renderExportStats(status) {
    if (!els.exportStats) return;
    var data = status && typeof status === "object" ? status : {};
    var items = [
      ["总文件", Number(data.files || 0) + " 个"],
      ["占用空间", formatBytes(data.bytes || 0)],
      ["导出文件", Number(data.app_files || 0) + " 个"],
      ["其他文件", Number(data.unknown_files || 0) + " 个"],
      ["子目录 / 链接", Number(data.subdirs || 0) + " / " + Number(data.symlinks || 0)],
      ["临时文件", Number(data.temp_files || 0) + " 个"],
      ["残留临时", Number(data.stale_temp_files || 0) + " 个"],
      ["不可处理", Number(data.protected_files || 0) + " 个"],
      ["最近导出", data.app_newest_mtime ? formatDateTime(data.app_newest_mtime) : "—"]
    ];
    els.exportStats.innerHTML = items.map(function (item) {
      return '<div class="export-manage-stat"><span>' + escapeHtml(item[0]) +
        '</span><b>' + escapeHtml(item[1]) + '</b></div>';
    }).join("");
    if (data.scan_truncated) {
      els.exportStats.innerHTML +=
        '<p class="export-manage-warning">目录条目超过扫描上限，预览与删除已禁用；请打开文件夹手动处理。</p>';
    }
    if (els.exportManageDirectory) {
      safeText(
        els.exportManageDirectory,
        data.exists
          ? (data.directory || "—")
          : "尚未创建 · " + (data.directory || "—")
      );
    }
  }

  function renderExportWeeks(status) {
    if (!els.exportWeek) return;
    var weeks = status && Array.isArray(status.weeks) ? status.weeks : [];
    var selected = String(state.exportManageWeek || "");
    var options = ['<option value="">全部时间</option>'];
    weeks.forEach(function (week) {
      if (!week || !week.key) return;
      options.push(
        '<option value="' + escapeHtml(week.key) + '">' +
        escapeHtml(week.label || week.key) +
        " · " + Number(week.app_files || 0) + " 个</option>"
      );
    });
    els.exportWeek.innerHTML = options.join("");
    if (selected && !weeks.some(function (week) {
      return week && week.key === selected;
    })) {
      selected = "";
      state.exportManageWeek = "";
    }
    els.exportWeek.value = selected;
  }

  function renderExportPreview(preview) {
    if (!els.exportSamples) return;
    var plan = preview && typeof preview === "object" ? preview : null;
    if (!plan) {
      els.exportSamples.hidden = true;
      els.exportSamples.innerHTML = "";
      return;
    }
    var totals = plan.totals || {};
    var protectedData = plan.protected || {};
    var scope = plan.week_label ? plan.week_label + "：" : "";
    var text = scope + "将删除 " + Number(totals.total_count || 0) + " 个文件，释放 " +
      formatBytes(totals.total_bytes || 0) + "（导出 " +
      Number(totals.app_count || 0) + " / 临时 " + Number(totals.temp_count || 0) +
      "）。";
    var protections = [];
    if (protectedData.recent_keep_latest) {
      protections.push("最近 " + protectedData.recent_keep_latest + " 个受保护");
    }
    if (protectedData.not_expired) {
      protections.push("未过期 " + protectedData.not_expired + " 个");
    }
    if (protectedData.unknown_files) {
      protections.push("未知文件 " + protectedData.unknown_files + " 个");
    }
    if (protectedData.subdirs || protectedData.symlinks) {
      protections.push("目录/链接 " +
        (Number(protectedData.subdirs || 0) + Number(protectedData.symlinks || 0)) + " 个");
    }
    if (protections.length) text += " " + protections.join(" · ") + "。";
    if (plan.warnings && plan.warnings.length) {
      text += " " + plan.warnings.join("；") + "。";
    }
    if (plan.sample_truncated) {
      text += " 仅展示最旧的 30 个文件。";
    }
    setExportStatus(
      text,
      Number(totals.total_count || 0) > 0 ? "ready" : ""
    );
    var samples = Array.isArray(plan.sample) ? plan.sample : [];
    if (!samples.length) {
      els.exportSamples.hidden = true;
      els.exportSamples.innerHTML = "";
      return;
    }
    els.exportSamples.hidden = false;
    els.exportSamples.innerHTML = samples.map(function (item) {
      return '<div class="export-manage-sample"><b>' +
        escapeHtml(item.name || "") + '</b><small>' +
        escapeHtml((item.kind === "temp" ? "临时" : "导出") + " · " +
          formatBytes(item.bytes || 0) + " · " + formatDateTime(item.mtime)) +
        '</small></div>';
    }).join("");
  }

  function updateExportManageButtons() {
    var busy = !!state.exportManageBusy;
    var ready = !!state.exportManagePreview &&
      Number((state.exportManagePreview.totals || {}).total_count || 0) > 0 &&
      els.exportPruneConfirm &&
      String(els.exportPruneConfirm.value || "") === "删除导出";
    if (els.exportKeepDays) els.exportKeepDays.disabled = busy;
    if (els.exportKeepLatest) els.exportKeepLatest.disabled = busy;
    var truncated = !!(state.exportManageStatus && state.exportManageStatus.scan_truncated);
    if (els.exportPreviewBtn) els.exportPreviewBtn.disabled = busy || truncated;
    if (els.exportPruneBtn) els.exportPruneBtn.disabled = busy || !ready;
    if (els.exportPruneConfirm) els.exportPruneConfirm.disabled = busy;
    if (els.exportOpenDir) els.exportOpenDir.disabled = busy;
  }

  function loadExportStatus() {
    var api = ctx.api;
    if (!exportManageSupported() || state.exportManageBusy) return Promise.resolve(null);
    var seq = ++state.exportManageSeq;
    state.exportManageBusy = true;
    updateExportManageButtons();
    if (els.exportStats) els.exportStats.textContent = "正在读取文件统计…";
    return Promise.resolve(api.exportStorageStatus(state.exportManageWeek || null)).then(function (result) {
      if (seq !== state.exportManageSeq || !state.exportManageOpen) return null;
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : "读取导出目录失败");
      }
      state.exportManageStatus = result;
      renderExportStats(result);
      renderExportWeeks(result);
      if (result.scan_truncated) {
        setExportStatus("导出目录条目过多，请打开文件夹手动处理后再刷新。", "error");
      }
      return result;
    }).catch(function (error) {
      if (seq === state.exportManageSeq && state.exportManageOpen) {
        setExportStatus("读取失败：" +
          (error && error.message ? error.message : "未知错误"), "error");
      }
      return null;
    }).then(function (result) {
      if (seq === state.exportManageSeq) {
        state.exportManageBusy = false;
        updateExportManageButtons();
      }
      return result;
    });
  }

  function previewExportFiles() {
    var api = ctx.api;
    if (!exportManageSupported() || state.exportManageBusy) return Promise.resolve(null);
    if (state.exportManageStatus && state.exportManageStatus.scan_truncated) {
      setExportStatus("导出目录条目过多，请打开文件夹手动处理后再刷新。", "error");
      return Promise.resolve(null);
    }
    var days = Number(els.exportKeepDays ? els.exportKeepDays.value : 90) || 90;
    var keepLatest = Number(els.exportKeepLatest ? els.exportKeepLatest.value : 50) || 50;
    var seq = ++state.exportManageSeq;
    state.exportManageBusy = true;
    state.exportManagePreview = null;
    if (els.exportPruneConfirm) els.exportPruneConfirm.value = "";
    setExportStatus("正在扫描可清理文件…", "");
    renderExportPreview(null);
    updateExportManageButtons();
    return Promise.resolve(api.exportStoragePreview(days, keepLatest, state.exportManageWeek || null)).then(function (result) {
      if (seq !== state.exportManageSeq || !state.exportManageOpen) return null;
      if (!result || result.ok === false) {
        throw new Error(
          result && result.error_code === "scan_truncated"
            ? "导出目录条目过多，请打开文件夹手动处理"
            : (result && result.error ? result.error : "预览失败")
        );
      }
      state.exportManagePreview = result;
      renderExportPreview(result);
      return result;
    }).catch(function (error) {
      if (seq === state.exportManageSeq && state.exportManageOpen) {
        state.exportManagePreview = null;
        setExportStatus("预览失败：" +
          (error && error.message ? error.message : "未知错误"), "error");
      }
      return null;
    }).then(function (result) {
      if (seq === state.exportManageSeq) {
        state.exportManageBusy = false;
        updateExportManageButtons();
      }
      return result;
    });
  }

  function openExportManage() {
    if (!els.exportManageModal || !exportManageSupported() || state.exportManageOpen) return;
    state.exportManageOpen = true;
    state.exportManageBusy = false;
    state.exportManagePreview = null;
    state.exportManageStatus = null;
    state.exportManageWeek = "";
    state.exportManageDays = 90;
    state.exportManageKeepLatest = 50;
    state.exportManageLastFocus = document.activeElement;
    state.exportManageSeq += 1;
    if (els.exportKeepDays) els.exportKeepDays.value = "90";
    if (els.exportWeek) els.exportWeek.value = "";
    if (els.exportKeepLatest) els.exportKeepLatest.value = "50";
    if (els.exportPruneConfirm) els.exportPruneConfirm.value = "";
    renderExportStats(null);
    if (els.exportManageDirectory) els.exportManageDirectory.textContent = "正在读取导出目录…";
    setExportStatus("正在读取文件统计…", "");
    renderExportPreview(null);
    els.exportManageModal.hidden = false;
    var app = document.querySelector(".app");
    if (app) {
      app.setAttribute("inert", "");
      app.setAttribute("aria-hidden", "true");
    }
    updateExportManageButtons();
    requestAnimationFrame(function () {
      if (els.exportManageClose) els.exportManageClose.focus();
    });
    loadExportStatus().then(function (status) {
      if (status && !status.scan_truncated && state.exportManageOpen) {
        return previewExportFiles();
      }
      return null;
    });
  }

  function closeExportManage() {
    if (!els.exportManageModal || !state.exportManageOpen) return;
    state.exportManageOpen = false;
    state.exportManageBusy = false;
    state.exportManagePreview = null;
    state.exportManageStatus = null;
    state.exportManageSeq += 1;
    els.exportManageModal.hidden = true;
    var app = document.querySelector(".app");
    if (app) {
      app.removeAttribute("inert");
      app.removeAttribute("aria-hidden");
    }
    var back = state.exportManageLastFocus;
    state.exportManageLastFocus = null;
    if (back && document.contains(back) && typeof back.focus === "function") back.focus();
    else if (els.exportManage) els.exportManage.focus();
  }

  function executeExportPrune() {
    if (!state.exportManageOpen || state.exportManageBusy || !state.exportManagePreview) return;
    if (!els.exportPruneConfirm ||
        String(els.exportPruneConfirm.value || "") !== "删除导出") return;
    var api = ctx.api;
    var days = Number(els.exportKeepDays ? els.exportKeepDays.value : 90) || 90;
    var keepLatest = Number(els.exportKeepLatest ? els.exportKeepLatest.value : 50) || 50;
    var previewId = state.exportManagePreview.preview_id;
    var seq = ++state.exportManageSeq;
    state.exportManageBusy = true;
    setExportStatus("正在删除旧导出…", "");
    updateExportManageButtons();
    Promise.resolve(api.exportStoragePrune(previewId, days, keepLatest, state.exportManageWeek || null)).then(function (result) {
      if (seq !== state.exportManageSeq || !state.exportManageOpen) return null;
      if (!result || result.ok === false) {
        throw new Error(
          result && result.error_code === "stale_preview"
            ? "文件已变化，请重新预览"
            : (result && result.error ? result.error : "删除失败")
        );
      }
      state.exportManagePreview = null;
      state.exportManageStatus = result.status || null;
      if (result.status) renderExportStats(result.status);
      renderExportPreview(null);
      var message = "已删除 " + Number(result.deleted_count || 0) + " 个文件，释放 " +
        formatBytes(result.deleted_bytes || 0) + "。";
      if (result.failed_count) {
        message += " " + Number(result.failed_count) + " 个失败：" +
          (result.failed || []).map(function (item) { return item.name; }).join("、") + "。";
      }
      if (result.partial && !result.failed_count) {
        message += " 部分文件状态已变化，未全部删除。";
      }
      setExportStatus(message, result.failed_count ? "error" : "success");
      if (els.exportPruneConfirm) els.exportPruneConfirm.value = "";
      return result;
    }).catch(function (error) {
      if (seq === state.exportManageSeq && state.exportManageOpen) {
        state.exportManagePreview = null;
        renderExportPreview(null);
        setExportStatus("删除失败：" +
          (error && error.message ? error.message : "未知错误"), "error");
      }
      return null;
    }).then(function (result) {
      if (seq !== state.exportManageSeq) return;
      state.exportManageBusy = false;
      updateExportManageButtons();
      if (result && result.status) {
        // 保持删除结果文案；统计已在上面更新。
      }
    });
  }

  function openExportDirectory() {
    var api = ctx.api;
    if (!exportManageSupported() || state.exportManageBusy) return;
    var seq = state.exportManageSeq;
    Promise.resolve(api.openExportDir()).then(function (result) {
      if (seq !== state.exportManageSeq || !state.exportManageOpen) return;
      if (!result || result.ok === false) {
        throw new Error(result && result.error ? result.error : "无法打开导出目录");
      }
      if (result.directory && els.exportManageDirectory) {
        els.exportManageDirectory.textContent = result.directory;
      }
    }).catch(function (error) {
      if (seq === state.exportManageSeq && state.exportManageOpen) {
        setExportStatus("打开目录失败：" +
          (error && error.message ? error.message : "未知错误"), "error");
      }
    });
  }

  function formatBytes(value) {
    var number = Math.max(0, Number(value) || 0);
    if (number < 1024) return Math.round(number) + " B";
    if (number < 1024 * 1024) return (number / 1024).toFixed(1) + " KB";
    if (number < 1024 * 1024 * 1024) {
      return (number / (1024 * 1024)).toFixed(1) + " MB";
    }
    return (number / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  ctx.modules.compare = {
    historyComparisonModel: historyComparisonModel,
    setHistoryCompareStatus: setHistoryCompareStatus,
    historyCompareErrorMessage: historyCompareErrorMessage,
    historyCompareHealthWarning: historyCompareHealthWarning,
    historyBaselineRelationLabel: historyBaselineRelationLabel,
    setHistoryBaselineStatus: setHistoryBaselineStatus,
    renderHistoryBaselineCurrent: renderHistoryBaselineCurrent,
    renderHistoryBaselineChips: renderHistoryBaselineChips,
    updateHistoryBaselineModeUi: updateHistoryBaselineModeUi,
    setHistoryBaselineMode: setHistoryBaselineMode,
    updateHistoryBaselineApply: updateHistoryBaselineApply,
    renderHistoryBaselineList: renderHistoryBaselineList,
    syncHistoryBaselineOptions: syncHistoryBaselineOptions,
    selectHistoryBaseline: selectHistoryBaseline,
    selectRecentHistoryBaselines: selectRecentHistoryBaselines,
    loadHistoryBaselines: loadHistoryBaselines,
    openHistoryBaselinePicker: openHistoryBaselinePicker,
    closeHistoryBaselinePicker: closeHistoryBaselinePicker,
    openHistoryComparisonWithBaseline: openHistoryComparisonWithBaseline,
    applyHistoryBaselineSelection: applyHistoryBaselineSelection,
    openHistoryCompare: openHistoryCompare,
    historyCompareRow: historyCompareRow,
    renderHistoryCompare: renderHistoryCompare,
    historyMultiValue: historyMultiValue,
    historyMultiDelta: historyMultiDelta,
    historyMultiSampleFlags: historyMultiSampleFlags,
    historyMultiQualityFlags: historyMultiQualityFlags,
    historyMultiContextCard: historyMultiContextCard,
    historyMultiResponseValid: historyMultiResponseValid,
    historyMultiEmpty: historyMultiEmpty,
    renderHistoryMultiCompare: renderHistoryMultiCompare,
    openHistoryMultiComparison: openHistoryMultiComparison,
    historyAnalysisExportSupported: historyAnalysisExportSupported,
    renderHistoryAnalysisExportActions: renderHistoryAnalysisExportActions,
    historyAnalysisExportStatusNode: historyAnalysisExportStatusNode,
    setHistoryAnalysisExportStatus: setHistoryAnalysisExportStatus,
    historyAnalysisExportViewKey: historyAnalysisExportViewKey,
    exportHistoryAnalysis: exportHistoryAnalysis,
    exportManageSupported: exportManageSupported,
    exportManageLinkHtml: exportManageLinkHtml,
    syncExportManageEntry: syncExportManageEntry,
    setExportStatus: setExportStatus,
    renderExportStats: renderExportStats,
    renderExportPreview: renderExportPreview,
    updateExportManageButtons: updateExportManageButtons,
    loadExportStatus: loadExportStatus,
    previewExportFiles: previewExportFiles,
    openExportManage: openExportManage,
    closeExportManage: closeExportManage,
    executeExportPrune: executeExportPrune,
    openExportDirectory: openExportDirectory,
    formatBytes: formatBytes
  };
})();
