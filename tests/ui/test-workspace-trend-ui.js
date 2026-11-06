'use strict';

const PW_ROOT = process.env.MUTAI_PW_ROOT || '';
const { chromium } = require(PW_ROOT ? PW_ROOT + 'playwright' : 'playwright');
const path = require('path');
const PROJECT_ROOT = process.env.MUTAI_PROJECT_ROOT || path.resolve(__dirname, '../..');
const fs = require('fs');

const URL = process.env.MUTAI_UI_URL || 'file:///' + path.resolve(PROJECT_ROOT, 'ui/index.html').replace(/\\/g, '/');
const OUT = process.env.MUTAI_UI_SHOTS || path.join(PROJECT_ROOT, 'qa/shots/ui');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
function check(condition, label, detail) {
  if (condition) {
    pass += 1;
    console.log('PASS  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  } else {
    fail += 1;
    console.log('FAIL  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1707, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console: ' + message.text());
  });
  page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));

  await page.addInitScript(() => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const now = Date.now() / 1000;
    const roomDefs = [
      { platform: 'bilibili', room_id: 100, room_key: '100', room_title: '夜航电台' },
      { platform: 'bilibili', room_id: 200, room_key: '200', room_title: '凌晨唱片店' }
    ];
    const sessions = [];
    roomDefs.forEach((room, roomIndex) => {
      for (let index = 0; index < 6; index += 1) {
        const started = now - (index + 1) * 86400 - roomIndex * 1800;
        sessions.push({
          id: room.room_key + '-' + index,
          ...room,
          started_at: started,
          ended_at: started + 3600,
          end_reason: 'manual_disconnect',
          last_event_at: started + 3500,
          real_received: 80 + roomIndex * 20 + index * 8,
          real_spoken: 60 + roomIndex * 12 + index * 4,
          real_dropped: 10 + index,
          mock_received: index === 0 ? 3 : 0,
          mock_spoken: 0,
          mock_dropped: 0,
          unique_users: 20 + index,
          gift_cny: 12.5,
          gift_silver: 0,
          gift_unknown: 0,
          super_chat_cny: 30
        });
      }
    });
    [8, 15, 22].forEach((daysAgo, index) => {
      const started = now - daysAgo * 86400;
      sessions.push({
        id: '100-extra-' + index,
        ...roomDefs[0],
        started_at: started,
        ended_at: started + 3600,
        end_reason: 'manual_disconnect',
        last_event_at: started + 3500,
        real_received: 70 + index * 5,
        real_spoken: 50 + index * 4,
        real_dropped: 8 + index,
        mock_received: 0,
        mock_spoken: 0,
        mock_dropped: 0,
        unique_users: 18 + index,
        gift_cny: 10,
        gift_silver: 0,
        gift_unknown: 0,
        super_chat_cny: 20
      });
    });
    sessions.push({
      id: 'dy-1',
      platform: 'douyin',
      room_id: 0,
      room_key: 'dy:demo',
      room_title: '抖音演示场',
      started_at: now - 2 * 86400,
      ended_at: now - 2 * 86400 + 3600,
      end_reason: 'manual_disconnect',
      last_event_at: now - 2 * 86400 + 3500,
      real_received: 42,
      real_spoken: 35,
      real_dropped: 7,
      mock_received: 0,
      mock_spoken: 0,
      mock_dropped: 0,
      unique_users: 12,
      gift_cny: 0,
      gift_silver: 0,
      gift_unknown: 0,
      super_chat_cny: 0
    });

    const state = {
      connection: 'connected',
      room_id: 100,
      room_title: '夜航电台',
      stats: { received: 12, spoken: 8, dropped: 1 },
      session: {
        id: 'live-session',
        started_at: now - 900,
        stats: { received: 12, spoken: 8, dropped: 1 },
        real: { received: 12, spoken: 8, dropped: 1 },
        mock: { received: 0, spoken: 0, dropped: 0 }
      },
      mock: { running: false, sent: 0 },
      queue_len: 0,
      now_playing: null,
      account: { logged_in: false, uname: null, mid: null },
      history: {
        available: true,
        error: null,
        capabilities: {
          trend: 1,
          trend_granularities: ['hour', 'day', 'week'],
          analysis_export: 1,
          export_manage: 1
        }
      },
      last_error: null,
      config: {
        overlay: {
          enabled: false, x: 60, y: 120, width: 520, height: 620, scale: 1,
          click_through: true, always_on_top: true,
          types: { danmaku: true, gift: true, super_chat: true, guard: true, enter: true }
        }
      }
    };
    const appearance = {
      schema_version: 1,
      preset: 'broadcast',
      custom: false,
      theme_mode: 'dark',
      accent: '#FF5F3A',
      pattern: { type: 'none', spacing_px: 24, dot_size_px: 1.5 },
      radius: { enabled: false, value_px: 12 },
      font: 'broadcast'
    };
    const trendCalls = [];
    let listCalls = 0;
    let trendError = false;
    let trendEmpty = false;
    let scopeIncomplete = false;
    const platformCounts = {};
    sessions.forEach((session) => {
      platformCounts[session.platform] = (platformCounts[session.platform] || 0) + 1;
    });

    function roomsFor(query, startedFrom, startedTo, platform) {
      const groups = new Map();
      const xssProbe = query.includes('XSS-PROBE');
      sessions.forEach((session) => {
        if (startedFrom != null && Number(session.started_at) < Number(startedFrom)) return;
        if (startedTo != null && Number(session.started_at) >= Number(startedTo)) return;
        if (platform && session.platform !== platform) return;
        if (query && !xssProbe &&
            !String(session.room_title).toLowerCase().includes(query.toLowerCase())) return;
        const key = session.platform + '|' + session.room_key;
        const current = groups.get(key) || {
          platform: session.platform,
          room_key: session.room_key,
          room_id: session.room_id,
          room_title: session.room_title,
          sessions: 0,
          last_started_at: 0
        };
        current.sessions += 1;
        current.last_started_at = Math.max(current.last_started_at, session.started_at);
        groups.set(key, current);
      });
      return [...groups.values()].sort((a, b) => b.last_started_at - a.last_started_at);
    }

    function weekStart(epoch) {
      const date = new Date(Number(epoch) * 1000);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      return date.getTime() / 1000;
    }

    function isoWeek(epoch) {
      const date = new Date(Number(epoch) * 1000);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
      const first = new Date(date.getFullYear(), 0, 4);
      const week = 1 + Math.round(
        ((date.getTime() - first.getTime()) / 86400000 -
         3 + ((first.getDay() + 6) % 7)) / 7
      );
      return date.getFullYear() + '-W' + String(week).padStart(2, '0');
    }

    function dateText(epoch) {
      const date = new Date(Number(epoch) * 1000);
      return date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
    }

    function hourText(epoch) {
      const date = new Date(Number(epoch) * 1000);
      return dateText(epoch) + ' ' + String(date.getHours()).padStart(2, '0') + ':00';
    }

    function trendFor(startedFrom, startedTo, query, platform, roomKey, granularity) {
      const rooms = roomsFor(query, startedFrom, startedTo, platform);
      const isHour = granularity === 'hour';
      const isWeek = granularity === 'week';
      if (trendError) {
        return { ok: false, available: true, error_code: 'internal', error: '模拟趋势故障' };
      }
      if (trendEmpty) {
        return {
          ok: true,
          available: true,
          api_version: 1,
          as_of: Date.now() / 1000,
          granularity: 'day',
          date_basis: 'started_at',
          range: { started_from: startedFrom, started_to: startedTo, days: 30 },
          counts: {
            matched_sessions: 0,
            all_sessions: sessions.length,
            sessions_with_data: 0,
            empty_sessions: 0,
            active_sessions: 1,
            platform_count: 0,
            room_count: 0
          },
          totals: {},
          buckets: [],
          quality: {},
          coverage: {},
          money: { comparable: true },
          filters: { query: query || '', platform: platform || null, room_key: null },
          scope: null,
          rooms: []
        };
      }
      if (scopeIncomplete) {
        return {
          ok: false,
          available: true,
          error_code: 'scope_incomplete',
          error: '当前范围有 1 场历史缺少房间标识，无法确定趋势范围',
          rooms: [],
          unscoped_sessions: 1,
          filters: { query: query || '', platform: platform || null, room_key: null }
        };
      }
      if (!roomKey && rooms.length > 1) {
        return {
          ok: false,
          available: true,
          error_code: 'scope_required',
          error: '历史趋势需要先选择一个直播间',
          rooms,
          filters: { query: query || '', platform: platform || null, room_key: null }
        };
      }
      const scope = roomKey
        ? rooms.find((room) => room.room_key === roomKey &&
            (!platform || room.platform === platform))
        : rooms[0];
      if (!scope) {
        return {
          ok: false,
          available: true,
          error_code: 'scope_not_found',
          error: '所选直播间不在当前筛选范围内',
          rooms
        };
      }
      const selected = sessions.filter((session) =>
        session.platform === scope.platform &&
        session.room_key === scope.room_key &&
        (startedFrom == null || session.started_at >= startedFrom) &&
        (startedTo == null || session.started_at < startedTo)
      );
      let buckets = [];
      const byDay = new Map();
      selected.forEach((session) => {
        const date = new Date(session.started_at * 1000);
        const key = date.getFullYear() + '-' +
          String(date.getMonth() + 1).padStart(2, '0') + '-' +
          String(date.getDate()).padStart(2, '0');
        const bucket = byDay.get(key) || {
          day: key,
          day_start: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000,
          sessions: 0,
          sessions_with_data: 0,
          empty_sessions: 0,
          real_received: 0,
          real_spoken: 0,
          real_dropped: 0,
          duration_seconds: 0,
          unique_users_sum: 0,
          unique_users_max: 0,
          gift_cny: 0,
          gift_silver: 0,
          gift_unknown: 0,
          super_chat_cny: 0,
          mock_received: 0,
          mock_spoken: 0,
          mock_dropped: 0,
          short_sessions: 0,
          incomplete_sessions: 0,
          replaced_sessions: 0,
          unknown_end_sessions: 0,
          mock_sessions: 0
        };
        bucket.sessions += 1;
        bucket.sessions_with_data += 1;
        bucket.real_received += session.real_received;
        bucket.real_spoken += session.real_spoken;
        bucket.real_dropped += session.real_dropped;
        bucket.duration_seconds += session.ended_at - session.started_at;
        bucket.unique_users_sum += session.unique_users;
        bucket.unique_users_max = Math.max(bucket.unique_users_max, session.unique_users);
        bucket.gift_cny += session.gift_cny;
        bucket.super_chat_cny += session.super_chat_cny;
        byDay.set(key, bucket);
      });
      for (let index = 29; index >= 0; index -= 1) {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - index);
        const key = date.getFullYear() + '-' +
          String(date.getMonth() + 1).padStart(2, '0') + '-' +
          String(date.getDate()).padStart(2, '0');
        const bucket = byDay.get(key) || {
          day: key,
          day_start: date.getTime() / 1000,
          sessions: 0,
          sessions_with_data: 0,
          empty_sessions: 0,
          real_received: 0,
          real_spoken: 0,
          real_dropped: 0,
          duration_seconds: 0,
          unique_users_sum: 0,
          unique_users_max: 0,
          gift_cny: 0,
          gift_silver: 0,
          gift_unknown: 0,
          super_chat_cny: 0,
          mock_received: 0,
          mock_spoken: 0,
          mock_dropped: 0,
          short_sessions: 0,
          incomplete_sessions: 0,
          replaced_sessions: 0,
          unknown_end_sessions: 0,
          mock_sessions: 0
        };
        bucket.spoken_rate = bucket.real_received
          ? bucket.real_spoken / bucket.real_received : null;
        bucket.drop_rate = bucket.real_received
          ? bucket.real_dropped / bucket.real_received : null;
        bucket.has_data = bucket.real_received > 0;
        buckets.push(bucket);
      }
      const totals = buckets.reduce((sum, bucket) => {
        sum.real_received += bucket.real_received;
        sum.real_spoken += bucket.real_spoken;
        sum.real_dropped += bucket.real_dropped;
        sum.duration_seconds += bucket.duration_seconds;
        sum.unique_users_max = Math.max(sum.unique_users_max, bucket.unique_users_max);
        sum.gift_cny += bucket.gift_cny;
        sum.super_chat_cny += bucket.super_chat_cny;
        sum.mock_received += bucket.mock_received;
        return sum;
      }, {
        real_received: 0,
        real_spoken: 0,
        real_dropped: 0,
        duration_seconds: 0,
        unique_users_max: 0,
        gift_cny: 0,
        gift_silver: 0,
        gift_unknown: 0,
        super_chat_cny: 0,
        mock_received: 0
      });
      totals.spoken_rate = totals.real_received
        ? totals.real_spoken / totals.real_received : null;
      totals.drop_rate = totals.real_received
        ? totals.real_dropped / totals.real_received : null;
      if (isHour) {
        const template = buckets[0];
        buckets = Array.from({ length: 8 }, (_, index) => {
          const start = startedFrom + index * 3600;
          return {
            ...template,
            hour: hourText(start),
            hour_start: start,
            hour_end: start + 3600,
            bucket_key: hourText(start),
            bucket_label: hourText(start),
            bucket_start: start,
            bucket_end: start + 3600,
            sessions: index < 4 ? 1 : 0,
            sessions_with_data: index < 4 ? 1 : 0,
            empty_sessions: index < 4 ? 0 : 1,
            real_received: index < 4 ? 20 : 0,
            real_spoken: index < 4 ? 16 : 0,
            real_dropped: index < 4 ? 4 : 0,
            duration_seconds: index < 4 ? 3600 : 0,
            has_data: index < 4,
            partial: index === 0 || index === 7
          };
        });
      } else if (isWeek) {
        const weeks = new Map();
        buckets.forEach((bucket) => {
          const start = weekStart(bucket.day_start);
          const week = weeks.get(start) || {
            bucket_key: isoWeek(start),
            bucket_label: isoWeek(start),
            bucket_start: start,
            bucket_end: start + 7 * 86400,
            iso_week: isoWeek(start),
            week_start: start,
            week_end: start + 7 * 86400,
            week_start_date: dateText(start),
            week_last_date: dateText(start + 6 * 86400),
            week_label: dateText(start) + ' ~ ' + dateText(start + 6 * 86400),
            sessions: 0,
            sessions_with_data: 0,
            empty_sessions: 0,
            real_received: 0,
            real_spoken: 0,
            real_dropped: 0,
            duration_seconds: 0,
            unique_users_sum: 0,
            unique_users_max: 0,
            gift_cny: 0,
            gift_silver: 0,
            gift_unknown: 0,
            super_chat_cny: 0,
            mock_received: 0,
            mock_spoken: 0,
            mock_dropped: 0,
            short_sessions: 0,
            incomplete_sessions: 0,
            replaced_sessions: 0,
            unknown_end_sessions: 0,
            inconsistent_sessions: 0,
            mock_sessions: 0,
            partial: start < startedFrom || start + 7 * 86400 > startedTo
          };
          week.sessions += bucket.sessions;
          week.sessions_with_data += bucket.sessions_with_data;
          week.empty_sessions += bucket.empty_sessions;
          week.real_received += bucket.real_received;
          week.real_spoken += bucket.real_spoken;
          week.real_dropped += bucket.real_dropped;
          week.duration_seconds += bucket.duration_seconds;
          week.unique_users_sum += bucket.unique_users_sum;
          week.unique_users_max = Math.max(week.unique_users_max, bucket.unique_users_max);
          week.gift_cny += bucket.gift_cny;
          week.super_chat_cny += bucket.super_chat_cny;
          week.mock_received += bucket.mock_received;
          week.short_sessions += bucket.short_sessions;
          week.incomplete_sessions += bucket.incomplete_sessions;
          week.replaced_sessions += bucket.replaced_sessions;
          week.unknown_end_sessions += bucket.unknown_end_sessions;
          week.inconsistent_sessions += bucket.inconsistent_sessions;
          week.mock_sessions += bucket.mock_sessions;
          week.has_data = week.real_received > 0;
          weeks.set(start, week);
        });
        buckets = [...weeks.values()];
      }
      return {
        ok: true,
        available: true,
        api_version: 1,
        as_of: Date.now() / 1000,
        granularity: isHour ? 'hour' : (isWeek ? 'week' : 'day'),
        date_basis: 'started_at',
        range: {
          started_from: startedFrom,
          started_to: startedTo,
          days: isHour ? 1 : (isWeek ? 30 : buckets.length),
          ...(isHour ? { hours: 8 } : {}),
          bucket_count: buckets.length,
          first_bucket_partial: !!(buckets[0] && buckets[0].partial),
          last_bucket_partial: !!(buckets[buckets.length - 1] && buckets[buckets.length - 1].partial)
        },
        counts: {
          matched_sessions: selected.length,
          all_sessions: sessions.length,
          sessions_with_data: selected.length,
          empty_sessions: 0,
          active_sessions: 0,
          platform_count: 1,
          room_count: 1,
          bucket_count: buckets.length,
          non_empty_buckets: buckets.filter((bucket) => bucket.sessions > 0).length,
          empty_buckets: buckets.filter((bucket) => bucket.sessions === 0).length,
          partial_buckets: buckets.filter((bucket) => bucket.partial).length
        },
        totals,
        buckets,
        quality: {
          short_sessions: 0,
          incomplete_sessions: 0,
          replaced_sessions: 0,
          unknown_end_sessions: 0,
          mock_sessions: selected.filter((session) => session.mock_received > 0).length,
          low_sample: selected.length < 20
        },
        coverage: {
          data_starts_at: buckets[0].day_start || buckets[0].bucket_start,
          data_ends_at: now,
          partial: true
        },
        money: {
          comparable: true,
          note: '本机聚合字段',
          gift_cny: totals.gift_cny,
          gift_silver: 0,
          gift_unknown: 0,
          super_chat_cny: totals.super_chat_cny
        },
        filters: {
          query: query || '',
          platform: scope.platform,
          room_key: scope.room_key
        },
        scope,
        rooms,
        hour_basis: isHour
          ? { boundary: 'local_civil', end_exclusive: true, max_hours: 168 }
          : null,
        week_basis: isWeek
          ? { start_weekday: 'monday', label: 'iso8601', boundary: 'local_civil', end_exclusive: true }
          : null,
        truncated: false,
        max_buckets: isHour ? 168 : 366,
        data_health: { pending_writes: 0, dropped_ops: 0, failed_ops: 0 }
      };
    }

    const api = {
      get_state: () => clone(state),
      poll_events: () => ({ cursor: 0, events: [] }),
      list_voices: () => [],
      get_appearance: () => ({ ok: true, appearance: clone(appearance), read_only: false, migration: {} }),
      set_appearance: (value) => ({ ok: true, appearance: clone(value), rejected: [] }),
      get_overlay_config: () => ({ enabled: false, width: 520, height: 620 }),
      get_config_v2: () => ({ monitor: { font_px: null }, overlay: {} }),
      monitor_visible: () => ({ visible: false }),
      toggle_monitor: () => ({ ok: true, visible: true }),
      set_overlay_visible: () => ({ ok: true, visible: false }),
      mock_status: () => ({ running: false, sent: 0 }),
      history_status: () => ({
        ok: true,
        available: true,
        gap_events: 0,
        capabilities: { trend: 1, trend_granularities: ['hour', 'day', 'week'] }
      }),
      history_list_sessions: (limit, offset, query, startedFrom, startedTo, platform) => {
        listCalls += 1;
        let filtered = sessions.filter((session) => {
          if (startedFrom != null && session.started_at < startedFrom) return false;
          if (startedTo != null && session.started_at >= startedTo) return false;
          if (platform && session.platform !== platform) return false;
          if (query && !String(session.room_title).toLowerCase().includes(query.toLowerCase())) {
            return false;
          }
          return true;
        });
        const page = filtered.slice(0, limit);
        return {
          ok: true,
          sessions: clone(page),
          total: filtered.length,
          all_total: sessions.length,
          platforms: Object.keys(platformCounts).sort().map((key) => ({
            platform: key,
            count: platformCounts[key]
          })),
          has_more: page.length < filtered.length,
          next_cursor: page.length ? {
            started_at: page[page.length - 1].started_at,
            id: page[page.length - 1].id
          } : null,
          gap_events: 0
        };
      },
      history_get_session: (id) => {
        const session = sessions.find((item) => item.id === id);
        return session
          ? {
              ok: true,
              session: {
                ...clone(session),
                types: { danmaku: 80, gift: 10, super_chat: 2, guard: 3, enter: 5 },
                minutes: []
              }
            }
          : { ok: false, error: '场次不存在', session: null };
      },
      history_get_previous_session: () => ({
        ok: true,
        status: 'no_previous',
        target: null,
        previous: null,
        has_previous: false
      }),
      history_trend: (startedFrom, startedTo, query, platform, granularity, roomKey) => {
        trendCalls.push({
          startedFrom,
          startedTo,
          query,
          platform,
          granularity,
          roomKey
        });
        return trendFor(startedFrom, startedTo, query || '', platform, roomKey, granularity);
      },
      history_export_session: () => ({ ok: false, error: '测试不导出' }),
      history_export_trend: () => ({ ok: false, error: '测试不导出' }),
      history_export_storage_status: () => ({ ok: true, available: true, directory: path.join(PROJECT_ROOT, 'exports/history') }),
      history_export_storage_preview: () => ({ ok: true, available: true, preview_id: 'test', totals: {} }),
      history_export_storage_prune: () => ({ ok: true, deleted_count: 0 }),
      history_export_storage_open_dir: () => ({ ok: true, available: true }),
      history_delete_session: () => ({ ok: false, error: '测试不删除' }),
      preview: () => ({ ok: true })
    };
    window.__fakeTrend = {
      trendCalls,
      get listCalls() { return listCalls; },
      setTrendError(value) { trendError = !!value; },
      setTrendEmpty(value) { trendEmpty = !!value; },
      setScopeIncomplete(value) { scopeIncomplete = !!value; }
    };
    window.pywebview = { api };
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  await page.click('[data-workspace-view="data"]');
  await page.waitForTimeout(150);
  await page.click('[data-data-tab="history"]');
  await page.waitForTimeout(350);

  await page.evaluate(() => {
    document.getElementById('wsHistoryList').scrollTop = 600;
  });
  await page.fill('#wsHistorySearch', '夜航');
  await page.waitForTimeout(360);
  const filteredScrollTop = await page.evaluate(() =>
    document.getElementById('wsHistoryList').scrollTop
  );
  check(filteredScrollTop === 0, '筛选后历史列表回到首条', filteredScrollTop);
  await page.click('#wsHistoryFilterReset');
  await page.waitForTimeout(250);

  const before = await page.evaluate(() => ({
    listCalls: window.__fakeTrend.listCalls,
    trendCalls: window.__fakeTrend.trendCalls.length
  }));
  await page.click('#wsHistoryTrendBtn');
  await page.waitForTimeout(220);
  const scopeGate = await page.evaluate(() => ({
    trendClass: document.getElementById('wsHistoryLayout').classList.contains('is-trend-mode'),
    listDisplay: getComputedStyle(document.querySelector('.history-list-pane')).display,
    listItemsDisplay: getComputedStyle(document.getElementById('wsHistoryList')).display,
    filterDisplay: getComputedStyle(document.querySelector('.history-filter-bar')).display,
    detailHidden: document.getElementById('wsHistoryDetail').hidden,
    gate: !!document.querySelector('.history-trend-scope-gate'),
    options: [...document.querySelectorAll('[data-trend-room-select] option')]
      .map((node) => node.textContent),
    roomOptions: [...document.querySelectorAll('[data-trend-room-select] option')]
      .filter((node) => !node.disabled).length,
    selectedRoom: document.querySelector('[data-trend-room-select]')?.value,
    trendPressed: document.getElementById('wsHistoryTrendBtn').getAttribute('aria-pressed'),
    rangeValue: document.getElementById('wsHistoryRange').value,
    allRangeDisabled: document.querySelector('#wsHistoryRange option[value="all"]')?.disabled,
    activeIsRoomSelect: document.activeElement ===
      document.querySelector('[data-trend-room-select]'),
    listCalls: window.__fakeTrend.listCalls,
    lastTrend: window.__fakeTrend.trendCalls[window.__fakeTrend.trendCalls.length - 1],
    bodyOverflow: [document.body.scrollWidth, document.body.clientWidth]
  }));
  check(scopeGate.trendClass, '趋势模式隐藏左侧场次列表');
  check(scopeGate.listItemsDisplay === 'none', '场次条目视觉收起', scopeGate.listItemsDisplay);
  check(scopeGate.filterDisplay !== 'none', '趋势模式保留筛选条', scopeGate.filterDisplay);
  check(scopeGate.detailHidden === false, '趋势详情区可见');
  check(scopeGate.gate, '多房间时出现单房间范围选择');
  check(scopeGate.roomOptions === 3, '范围选择列出候选直播间', scopeGate.options);
  check(scopeGate.selectedRoom === '', '多房间时先显示未选择占位态', scopeGate.selectedRoom);
  check(scopeGate.lastTrend && scopeGate.lastTrend.roomKey === null,
    '趋势首次请求不携带房间，交由后端 fail-closed');
  check(scopeGate.listCalls === before.listCalls, '进入趋势不重复加载历史列表');
  check(scopeGate.trendPressed === 'true', '趋势按钮暴露 aria-pressed 状态');
  check(scopeGate.rangeValue === '365d', '趋势默认使用近 365 天范围', scopeGate.rangeValue);
  check(scopeGate.allRangeDisabled === true, '趋势模式禁用“全部时间”选项');
  check(scopeGate.activeIsRoomSelect, '进入趋势后焦点落到房间选择器');
  check(scopeGate.bodyOverflow[0] <= scopeGate.bodyOverflow[1], '1707 趋势页无横向溢出',
    scopeGate.bodyOverflow);
  await page.screenshot({ path: path.join(OUT, 'history-trend-scope-1707x960.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(180);
  const escapedTrend = await page.evaluate(() => ({
    trendClass: document.getElementById('wsHistoryLayout').classList.contains('is-trend-mode'),
    detailHidden: document.getElementById('wsHistoryDetail').hidden
  }));
  check(!escapedTrend.trendClass && escapedTrend.detailHidden,
    'Escape 可从趋势模式返回场次', escapedTrend);
  await page.click('#wsHistoryTrendBtn');
  await page.waitForTimeout(200);

  await page.selectOption('[data-trend-room-select]', '0');
  await page.waitForTimeout(260);
  const aggregated = await page.evaluate(() => ({
    scope: document.querySelector('.history-trend-scope .is-scope')?.textContent,
    svg: !!document.querySelector('.history-trend-svg'),
    rows: document.querySelectorAll('.history-trend-table tbody tr').length,
    activeMetric: document.querySelector('[data-trend-metric].is-active')?.getAttribute('data-trend-metric'),
    metricPressed: document.querySelector('[data-trend-metric].is-active')?.getAttribute('aria-pressed'),
    manageEntry: !!document.querySelector('[data-open-export-manage]'),
    lastTrend: window.__fakeTrend.trendCalls[window.__fakeTrend.trendCalls.length - 1],
    rooms: [...document.querySelectorAll('[data-trend-room-select] option')].length,
    activeIsRoomSelect: document.activeElement ===
      document.querySelector('[data-trend-room-select]')
  }));
  check(aggregated.scope && aggregated.scope.includes('夜航电台'), '选定房间后显示固定范围', aggregated.scope);
  check(aggregated.svg, '有效样本足够时绘制趋势折线');
  check(aggregated.rows >= 6, '历史日汇总表有数据', aggregated.rows);
  check(aggregated.lastTrend.roomKey === '100', '选定房间后请求携带 room_key', aggregated.lastTrend);
  check(aggregated.activeMetric === 'received_per_hour', '默认指标为收到/小时');
  check(aggregated.metricPressed === 'true', '趋势指标暴露 aria-pressed 状态');
  check(aggregated.manageEntry, '趋势卡头提供导出文件管理入口');
  check(aggregated.rooms === 2, '趋势页保留房间切换入口', aggregated.rooms);
  check(aggregated.activeIsRoomSelect, '选定房间后焦点回到房间选择器');
  await page.screenshot({ path: path.join(OUT, 'history-trend-1707x960.png') });

  await page.click('[data-trend-metric="spoken_rate"]');
  await page.waitForTimeout(100);
  const metric = await page.evaluate(() => ({
    active: document.querySelector('[data-trend-metric].is-active')?.getAttribute('data-trend-metric'),
    label: document.querySelector('.history-trend-svg')?.getAttribute('aria-label'),
    calls: window.__fakeTrend.trendCalls.length
  }));
  check(metric.active === 'spoken_rate', '切换指标后按钮状态更新');
  check(metric.label && metric.label.includes('开始朗读率'), '切换指标后重绘图表', metric.label);

  const callsBeforeWeek = await page.evaluate(() => window.__fakeTrend.trendCalls.length);
  await page.click('[data-trend-granularity="week"]');
  await page.waitForTimeout(260);
  const weekly = await page.evaluate(() => ({
    lastTrend: window.__fakeTrend.trendCalls[window.__fakeTrend.trendCalls.length - 1],
    calls: window.__fakeTrend.trendCalls.length,
    active: document.querySelector('[data-trend-granularity].is-active')
      ?.getAttribute('data-trend-granularity'),
    pressed: document.querySelector('[data-trend-granularity="week"]')
      ?.getAttribute('aria-pressed'),
    title: document.querySelector('.history-trend-card-head h3')?.textContent,
    header: document.querySelector('.history-trend-table thead th')?.textContent,
    caption: document.querySelector('.history-trend-table caption')?.textContent,
    chart: document.querySelector('.history-trend-svg')?.getAttribute('aria-label'),
    range: document.querySelector('#wsHistoryDetail .history-detail-title p')?.textContent,
    rowCount: document.querySelectorAll('.history-trend-table tbody tr').length,
    quality: document.querySelector('.history-trend-quality-card')?.textContent || '',
    error: document.querySelector('.history-trend-empty')?.textContent || '',
    note: [...document.querySelectorAll('#wsHistoryDetail .workspace-note')]
      .map((node) => node.textContent).join(' '),
    focused: document.activeElement === document.querySelector('[data-trend-granularity="week"]')
  }));
  check(weekly.lastTrend && weekly.lastTrend.granularity === 'week' &&
      weekly.calls === callsBeforeWeek + 1,
    '切换周粒度后请求携带 week', weekly.lastTrend);
  check(weekly.active === 'week' && weekly.pressed === 'true',
    '周粒度按钮暴露选中状态', weekly);
  check(weekly.quality.includes('不完整周'),
    '周粒度明确列出不完整周', weekly.quality);
  check(weekly.note.includes('未检测时间重叠'),
    '趋势说明披露未检测时间重叠', weekly.note);
  check(weekly.title === '按开播周' && weekly.header === '周（周一起始）' &&
      weekly.caption.includes('按开播周') && weekly.chart &&
      weekly.chart.includes('可计算周'),
    '周粒度图表与表格文案同步', weekly);
  check(/\d+ 周/.test(weekly.range) && weekly.rowCount >= 4,
    '周粒度显示周数与非空周行', weekly);
  check(weekly.focused, '切换粒度后焦点留在周按钮');

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(120);
  const weekly1024 = await page.evaluate(() => {
    const wrapper = document.querySelector('.history-trend-table-wrap');
    const table = document.querySelector('.history-trend-table');
    return {
      body: [document.body.scrollWidth, document.body.clientWidth],
      wrapper: [wrapper.scrollWidth, wrapper.clientWidth],
      table: [table.scrollWidth, table.clientWidth],
      granularityButtons: document.querySelectorAll('[data-trend-granularity]').length,
      bucketCell: (() => {
        const node = document.querySelector('.history-trend-bucket-cell');
        return node ? node.textContent.trim() : '';
      })()
    };
  });
  check(weekly1024.body[0] <= weekly1024.body[1] &&
      weekly1024.wrapper[0] <= weekly1024.wrapper[1] + 1 &&
      weekly1024.table[0] <= weekly1024.table[1] + 1 &&
      weekly1024.granularityButtons === 3,
    '1024 周粒度与周标签不横向溢出', weekly1024);
  await page.screenshot({ path: path.join(OUT, 'history-trend-week-1024x700.png') });

  await page.setViewportSize({ width: 1707, height: 960 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, 'history-trend-week-1707x960.png') });
  await page.click('[data-trend-granularity="day"]');
  await page.waitForTimeout(260);
  const backToDay = await page.evaluate(() => ({
    lastTrend: window.__fakeTrend.trendCalls[window.__fakeTrend.trendCalls.length - 1],
    active: document.querySelector('[data-trend-granularity].is-active')
      ?.getAttribute('data-trend-granularity'),
    title: document.querySelector('.history-trend-card-head h3')?.textContent
  }));
  check(backToDay.lastTrend.granularity === 'day' && backToDay.active === 'day' &&
      backToDay.title === '按开播日',
    '切回日粒度恢复日视图', backToDay);

  await page.click('[data-trend-granularity="hour"]');
  await page.waitForTimeout(260);
  const hourly = await page.evaluate(() => ({
    lastTrend: window.__fakeTrend.trendCalls[window.__fakeTrend.trendCalls.length - 1],
    active: document.querySelector('[data-trend-granularity].is-active')
      ?.getAttribute('data-trend-granularity'),
    pressed: document.querySelector('[data-trend-granularity="hour"]')
      ?.getAttribute('aria-pressed'),
    title: document.querySelector('.history-trend-card-head h3')?.textContent,
    header: document.querySelector('.history-trend-table thead th')?.textContent,
    caption: document.querySelector('.history-trend-table caption')?.textContent,
    chart: document.querySelector('.history-trend-svg')?.getAttribute('aria-label'),
    range: document.querySelector('#wsHistoryDetail .history-detail-title p')?.textContent,
    rangeValue: document.getElementById('wsHistoryRange')?.value,
    buttons: document.querySelectorAll('[data-trend-granularity]').length,
    rowCount: document.querySelectorAll('.history-trend-table tbody tr').length,
    quality: document.querySelector('.history-trend-quality-card')?.textContent || '',
    error: document.querySelector('.history-trend-empty')?.textContent || '',
    note: [...document.querySelectorAll('#wsHistoryDetail .workspace-note')]
      .map((node) => node.textContent).join(' '),
    focused: document.activeElement === document.querySelector('[data-trend-granularity="hour"]')
  }));
  check(hourly.lastTrend && hourly.lastTrend.granularity === 'hour' &&
      hourly.rangeValue === '7d',
    '切换小时粒度自动使用近 7 天范围', hourly);
  check(hourly.active === 'hour' && hourly.pressed === 'true' && hourly.buttons === 3,
    '小时粒度按钮暴露选中状态', hourly);
  check(hourly.title === '按开播小时' && hourly.header === '小时' &&
      hourly.caption.includes('按开播小时') && hourly.chart &&
      hourly.chart.includes('可计算小时'),
    '小时粒度图表与表格文案同步', hourly);
  check(/\d+ 小时/.test(hourly.range) && hourly.rowCount >= 4,
    '小时粒度显示小时数与非空小时行', hourly);
  check(hourly.quality.includes('不完整小时') &&
      hourly.note.includes('近 7 天') &&
      hourly.focused,
    '小时粒度质量提示与焦点保持', hourly);
  await page.screenshot({ path: path.join(OUT, 'history-trend-hour-1707x960.png') });
  await page.click('[data-trend-granularity="day"]');
  await page.waitForTimeout(220);

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(120);
  const at1280 = await page.evaluate(() => ({
    body: [document.body.scrollWidth, document.body.clientWidth],
    chart: (() => {
      const node = document.querySelector('.history-trend-chart-card');
      return [node.scrollWidth, node.clientWidth];
    })(),
    gridColumns: getComputedStyle(document.querySelector('.history-trend-grid')).gridTemplateColumns
  }));
  check(at1280.body[0] <= at1280.body[1], '1280 趋势页无横向溢出', at1280.body);
  check(at1280.chart[0] <= at1280.chart[1], '1280 图表卡不溢出', at1280.chart);
  check(at1280.gridColumns.split(' ').length === 1, '1280 趋势内容单列', at1280.gridColumns);
  await page.screenshot({ path: path.join(OUT, 'history-trend-1280x820.png') });

  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(120);
  const at1024 = await page.evaluate(() => {
    const wrapper = document.querySelector('.history-trend-table-wrap');
    const table = document.querySelector('.history-trend-table');
    return {
      body: [document.body.scrollWidth, document.body.clientWidth],
      wrapper: [wrapper.scrollWidth, wrapper.clientWidth],
      table: [table.scrollWidth, table.clientWidth],
      gridColumns: getComputedStyle(document.querySelector('.history-trend-grid')).gridTemplateColumns,
      listHidden: getComputedStyle(document.getElementById('wsHistoryList')).display === 'none',
      filterVisible: getComputedStyle(document.querySelector('.history-filter-bar')).display !== 'none'
    };
  });
  check(at1024.body[0] <= at1024.body[1], '1024 趋势页无横向溢出', at1024.body);
  check(at1024.wrapper[0] <= at1024.wrapper[1] + 1, '1024 表格容器不横向滚动', at1024.wrapper);
  check(at1024.table[0] <= at1024.table[1] + 1, '1024 表格自身不横向滚动', at1024.table);
  check(at1024.gridColumns.split(' ').length === 1, '1024 趋势内容单列', at1024.gridColumns);
  check(at1024.listHidden, '1024 趋势模式仍隐藏列表');
  check(at1024.filterVisible, '1024 趋势模式仍可调整筛选');
  await page.screenshot({ path: path.join(OUT, 'history-trend-1024x700.png') });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(100);
  const listCallsBeforeFilter = await page.evaluate(() => window.__fakeTrend.listCalls);
  await page.selectOption('#wsHistoryPlatform', 'douyin');
  await page.waitForTimeout(220);
  const trendFilter = await page.evaluate(() => ({
    listCalls: window.__fakeTrend.listCalls,
    lastTrend: window.__fakeTrend.trendCalls[window.__fakeTrend.trendCalls.length - 1],
    scope: document.querySelector('.history-trend-scope .is-scope')?.textContent || '',
    roomKey: document.getElementById('wsHistoryPlatform').value,
    activeIsPlatformSelect: document.activeElement ===
      document.getElementById('wsHistoryPlatform')
  }));
  check(trendFilter.listCalls === listCallsBeforeFilter, '趋势模式下筛选不触发列表请求',
    trendFilter);
  check(trendFilter.lastTrend.platform === 'douyin' && trendFilter.lastTrend.roomKey === null,
    '趋势筛选后按平台重新聚合', trendFilter.lastTrend);
  check(trendFilter.scope.includes('抖音演示场'), '平台筛选自动收敛到单房间', trendFilter.scope);
  check(trendFilter.activeIsPlatformSelect, '趋势筛选不抢走筛选控件焦点');

  await page.evaluate(() => {
    document.getElementById('wsHistoryList').scrollTop = 240;
  });
  await page.click('[data-history-trend-back]');
  await page.waitForTimeout(260);
  const returned = await page.evaluate(() => ({
    trendClass: document.getElementById('wsHistoryLayout').classList.contains('is-trend-mode'),
    detailHidden: document.getElementById('wsHistoryDetail').hidden,
    listVisible: getComputedStyle(document.querySelector('.history-list-pane')).display !== 'none',
    trendActive: document.getElementById('wsHistoryTrendBtn').classList.contains('is-active'),
    trendPressed: document.getElementById('wsHistoryTrendBtn').getAttribute('aria-pressed'),
    focused: document.activeElement && document.activeElement.id,
    listCalls: window.__fakeTrend.listCalls,
    listScrollTop: document.getElementById('wsHistoryList').scrollTop
  }));
  check(!returned.trendClass, '返回场次退出趋势模式');
  check(returned.detailHidden, '返回场次隐藏趋势详情');
  check(returned.listVisible, '返回场次恢复列表');
  check(!returned.trendActive, '返回场次清除趋势按钮激活态');
  check(returned.trendPressed === 'false', '返回场次清除趋势 aria-pressed');
  check(returned.focused === 'wsHistoryTrendBtn', '返回后焦点回到趋势按钮', returned.focused);
  check(returned.listCalls > listCallsBeforeFilter, '返回后按当前筛选重新加载列表');
  check(returned.listScrollTop === 0, '趋势内筛选后返回列表回到首条',
    returned.listScrollTop);

  await page.evaluate(() => window.__fakeTrend.setTrendError(true));
  await page.click('#wsHistoryTrendBtn');
  await page.waitForTimeout(220);
  const failed = await page.evaluate(() => ({
    error: !!document.querySelector('.history-trend-empty.is-error'),
    text: document.querySelector('.history-trend-empty.is-error')?.textContent || '',
    role: document.querySelector('.history-trend-empty.is-error')?.getAttribute('role'),
    activeIsRetry: document.activeElement ===
      document.querySelector('[data-history-trend-refresh]')
  }));
  check(failed.error && failed.text.includes('模拟趋势故障'), '趋势接口失败有可读错误态', failed.text);
  check(failed.role === 'alert', '趋势失败态可被辅助技术播报', failed.role);
  check(failed.activeIsRetry, '趋势失败后焦点落到重试按钮');
  await page.evaluate(() => window.__fakeTrend.setTrendError(false));
  await page.click('[data-history-trend-refresh]');
  await page.waitForTimeout(220);
  const recovered = await page.evaluate(() => ({
    content: !!document.querySelector(
      '.history-trend-svg, .history-trend-table-card, .history-trend-scope-gate'
    ),
    error: !!document.querySelector('.history-trend-empty.is-error'),
    lowSample: (document.querySelector('.history-trend-chart')?.textContent || '')
      .includes('不足 4 个可计算日')
  }));
  check(recovered.content && !recovered.error, '刷新趋势可从错误态恢复', recovered);
  check(recovered.lowSample, '样本不足时不伪造折线', recovered);

  await page.evaluate(() => window.__fakeTrend.setTrendError(true));
  await page.click('[data-trend-granularity="week"]');
  await page.waitForTimeout(220);
  const weekFailed = await page.evaluate(() => ({
    error: document.querySelector('.history-trend-empty.is-error')?.textContent || '',
    dayButton: !!document.querySelector('[data-trend-granularity="day"]'),
    weekActive: document.querySelector('[data-trend-granularity="week"]')
      ?.getAttribute('aria-pressed')
  }));
  check(weekFailed.error.includes('模拟趋势故障') && weekFailed.dayButton &&
      weekFailed.weekActive === 'true',
    '周请求失败保留日/周切换入口', weekFailed);
  await page.evaluate(() => window.__fakeTrend.setTrendError(false));
  await page.click('[data-trend-granularity="day"]');
  await page.waitForTimeout(240);
  const fallbackDay = await page.evaluate(() => ({
    title: document.querySelector('.history-trend-card-head h3')?.textContent,
    active: document.querySelector('[data-trend-granularity].is-active')
      ?.getAttribute('data-trend-granularity'),
    error: !!document.querySelector('.history-trend-empty.is-error')
  }));
  check(fallbackDay.title === '按开播日' && fallbackDay.active === 'day' && !fallbackDay.error,
    '周失败后可切回日趋势', fallbackDay);

  await page.click('[data-history-trend-back]');
  await page.waitForTimeout(160);
  await page.evaluate(() => window.__fakeTrend.setTrendEmpty(true));
  await page.click('#wsHistoryTrendBtn');
  await page.waitForTimeout(220);
  const empty = await page.evaluate(() => ({
    text: document.querySelector('.history-trend-empty')?.textContent || '',
    hasMissingRoom: document.body.textContent.includes('未命名直播间')
  }));
  check(empty.text.includes('没有已结束场次'), '空范围使用明确空态', empty.text);
  check(!empty.hasMissingRoom, '空范围不伪造直播间名称', empty.hasMissingRoom);

  await page.click('[data-history-trend-back]');
  await page.waitForTimeout(160);
  await page.evaluate(() => window.__fakeTrend.setTrendEmpty(false));
  await page.evaluate(() => window.__fakeTrend.setScopeIncomplete(true));
  await page.click('#wsHistoryTrendBtn');
  await page.waitForTimeout(220);
  const incomplete = await page.evaluate(() => ({
    alert: document.querySelector('.history-trend-empty.is-error')?.textContent || '',
    role: document.querySelector('.history-trend-empty.is-error')?.getAttribute('role')
  }));
  check(incomplete.alert.includes('缺少房间标识'), '空房间范围有明确阻断文案', incomplete.alert);
  check(incomplete.role === 'alert', '空房间阻断可被辅助技术播报', incomplete.role);

  await page.evaluate(() => window.__fakeTrend.setScopeIncomplete(false));
  await page.fill(
    '#wsHistorySearch',
    'XSS-PROBE<img src=x onerror="window.__trendXss=1">'
  );
  await page.waitForTimeout(420);
  const escaped = await page.evaluate(() => ({
    executed: window.__trendXss === 1,
    images: document.querySelectorAll('#wsHistoryDetail img').length,
    text: document.querySelector('#wsHistoryDetail .history-detail-title p')?.textContent || ''
  }));
  check(!escaped.executed && escaped.images === 0, '趋势搜索词按文本渲染，不执行 HTML',
    escaped);
  check(escaped.text.includes('XSS-PROBE<img'), '趋势搜索词保留可读文本', escaped.text);

  check(errors.length === 0, '无页面脚本错误', errors);
  console.log('\nSUMMARY  PASS=' + pass + '  FAIL=' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
