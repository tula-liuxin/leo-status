/**
 * leo-status - client half for the DSH Web UI.
 *
 * A sidebar nav entry (inline SVG checklist glyph) plus the full-page board: todos,
 * pending suggestions and the Obsidian data-source card. Yuan lives in the separate
 * "ayuan" plugin; this half is board-only. Plain browser module: no build, no JSX,
 * React from the module loader. Styling uses one injected <style> tag whose classes
 * are prefixed "ls-".
 */
window.__ModuleLoader__.load({
  id: 'leo-status',
  factory(require) {

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** Locale namespace owned by this plugin. */
    const NS = 'leoStatus';
    /** Panel id shared by the sidebar entry and the page the shell mounts. */
    const PANEL_ID = 'leo-status';
    /** Same-origin host endpoint that returns the Board (see CONTRACT-V2.md). */
    const API = '/leo-status/api/todos';
    /** Same-origin endpoint used by the "join hub" form. */
    const JOIN_API = '/leo-status/api/join';
    /** Same-origin endpoint used by the inline todo actions (v3). */
    const ACTION_API = '/leo-status/api/todos/action';
    /** v0.4 data-source endpoints: vault discovery, attach and settings. */
    const VAULTS_API = '/leo-status/api/obsidian/vaults';
    const VAULT_ATTACH_API = '/leo-status/api/obsidian/attach';
    const SETTINGS_API = '/leo-status/api/settings';
    /** Pending-suggestion review endpoints (board domain, stays with leo-status after the split). */
    const SUGGEST_ACCEPT_API = '/leo-status/api/yuan/suggestion/accept';
    const SUGGEST_DISMISS_API = '/leo-status/api/yuan/suggestion/dismiss';
    /** Default hub URL offered in the join form. */
    const DEFAULT_HUB_URL = 'https://dsh.agencyarche.com/leo-status';
    /** Device id reserved for the local device in a v2 board. */
    const LOCAL_DEVICE_ID = 'local';
    /** Internal chip key used to select the local device (hosts may use a non-"local" id for it). */
    const LOCAL_CHIP_KEY = '$local';
    /** Stable empty list so memo dependencies do not churn. */
    const EMPTY = Object.freeze([]);
    /** Bound translator for the plugin namespace; set once the plugin applies. */
    let boundT = null;

    /** 页面 token（Host 注入到 index HTML 的 window.__LEO_STATUS_PAGE_TOKEN__）。 */
    function pageToken() {
      try {
        const value = typeof window !== 'undefined' ? window.__LEO_STATUS_PAGE_TOKEN__ : '';
        return typeof value === 'string' ? value : '';
      } catch {
        return '';
      }
    }

    /** 带页面 token 的同源 fetch；没有 token 时退回普通 cookie 请求。 */
    function apiFetch(url, init) {
      const options = { ...(init || {}) };
      const headers = { ...(options.headers || {}) };
      const token = pageToken();
      if (token !== '') headers['x-leo-status-token'] = token;
      options.headers = headers;
      if (options.credentials === undefined) options.credentials = 'same-origin';
      // DSH 可能挂在 /d/<device>/ 之类的前缀下；插件路由按页面相对路径解析。
      let target = url;
      if (typeof url === 'string' && url.startsWith('/leo-status/')) {
        target = url.slice(1);
        if (token !== '') {
          const separator = target.includes('?') ? '&' : '?';
          target += separator + '_leo_status_token=' + encodeURIComponent(token);
        }
      }
      return fetch(target, options);
    }

    async function apiJson(url, options) {
      const settings = options !== null && typeof options === 'object' ? options : {};
      const init = { credentials: 'same-origin', headers: { accept: 'application/json' } };
      if (typeof settings.method === 'string') init.method = settings.method;
      if (settings.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(settings.body);
      }
      const response = await apiFetch(url, init);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || body === null || typeof body !== 'object' || body.ok !== true) {
        const message =
          body !== null && typeof body === 'object' && typeof body.error === 'string' && body.error !== ''
            ? body.error
            : response.ok
              ? 'invalid response'
              : 'HTTP ' + response.status;
        throw new Error(message);
      }
      return body;
    }


    function pendingSuggestions(list) {
      if (!Array.isArray(list)) return EMPTY;
      return list.filter(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          (item.status === undefined || item.status === 'pending'),
      );
    }


    function suggestionSourceLabel(item, t) {
      if (item === null || typeof item !== 'object') return '';
      if (typeof item.sessionTitle === 'string' && item.sessionTitle !== '') return item.sessionTitle;
      if (item.source === 'session') return t('suggestionSourceSession');
      if (item.source === 'note') return t('suggestionSourceNote');
      if (typeof item.project === 'string' && item.project !== '') return item.project;
      return '';
    }

    const PRIORITY_RANK = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
    const PRIORITY_LABEL_KEYS = {
      highest: 'priorityHighest',
      high: 'priorityHigh',
      medium: 'priorityMedium',
      low: 'priorityLow',
      lowest: 'priorityLowest',
    };


    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /** Local-calendar date key, `YYYY-MM-DD`. */
    function localDateKey(date) {
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    /** Day index of a `YYYY-MM-DD` string, or null when it cannot be parsed. */
    function dayNumber(iso) {
      if (typeof iso !== 'string') return null;
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
      if (match === null) return null;
      return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
    }

    function formatMonthDay(iso) {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof iso === 'string' ? iso : '');
      return match === null ? '' : match[2] + '-' + match[3];
    }

    /** Short local timestamp; same-day values omit the date, others show `MM-DD HH:mm`. */
    function formatStamp(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const sameDay =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
      const time = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
      return sameDay ? time : pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + time;
    }

    function baseName(path) {
      if (typeof path !== 'string' || path === '') return '';
      const parts = path.split(/[\\/]/);
      return parts[parts.length - 1] || '';
    }

    function toCount(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    function normalizeText(value) {
      return typeof value === 'string' ? value.toLowerCase() : '';
    }

    function describeError(error) {
      if (error instanceof Error && error.message !== '') return error.message;
      if (typeof error === 'string' && error !== '') return error;
      return 'unknown error';
    }

    /** Tooltip: full path/heading chain for markdown, session title/project for dsh. */
    function rowTooltip(todo, t) {
      const parts = [];
      if (todo.kind === 'dsh') {
        if (typeof todo.sessionTitle === 'string' && todo.sessionTitle !== '') parts.push(todo.sessionTitle);
        if (typeof todo.project === 'string' && todo.project !== '') parts.push(todo.project);
        if (parts.length === 0) parts.push(t('sessionFallback'));
      } else {
        if (typeof todo.file === 'string' && todo.file !== '') {
          parts.push(todo.file + (typeof todo.line === 'number' ? ':' + todo.line : ''));
        } else if (typeof todo.relPath === 'string' && todo.relPath !== '') {
          parts.push(todo.relPath);
        }
        if (
          typeof todo.relPath === 'string' &&
          todo.relPath !== '' &&
          todo.relPath !== todo.file
        ) {
          parts.push(todo.relPath);
        }
        if (typeof todo.heading === 'string' && todo.heading !== '') parts.push(todo.heading);
      }
      if (Array.isArray(todo.tags) && todo.tags.length > 0) {
        parts.push(todo.tags.map((tag) => '#' + tag).join(' '));
      }
      if (parts.length === 0) parts.push(typeof todo.text === 'string' && todo.text !== '' ? todo.text : t('untitled'));
      return parts.join('\n');
    }

    function sourceBadge(todo, t) {
      if (todo.kind === 'dsh') {
        return {
          kind: 'dsh',
          text:
            typeof todo.sessionTitle === 'string' && todo.sessionTitle !== ''
              ? todo.sessionTitle
              : t('sessionFallback'),
          title:
            typeof todo.sessionTitle === 'string' && todo.sessionTitle !== ''
              ? todo.sessionTitle + (typeof todo.project === 'string' && todo.project !== '' ? '\n' + todo.project : '')
              : t('sessionFallback'),
        };
      }
      const name = baseName(todo.file) || baseName(todo.relPath);
      return {
        kind: 'md',
        text: name !== '' ? name : typeof todo.sourceLabel === 'string' && todo.sourceLabel !== '' ? todo.sourceLabel : '—',
        title: typeof todo.file === 'string' && todo.file !== '' ? todo.file : typeof todo.relPath === 'string' ? todo.relPath : '',
      };
    }

    // -- multi-device helpers (v2) ----------------------------------------------

    /** deviceId of a todo; empty for old v1 boards. */
    function todoDeviceId(todo) {
      return todo !== null && typeof todo === 'object' && typeof todo.deviceId === 'string' ? todo.deviceId : '';
    }

    /** True when the todo belongs to this browser's device (v1 boards are all local). */
    function isLocalTodo(todo, localDeviceId) {
      if (todo === null || typeof todo !== 'object') return true;
      if (todo.local === true) return true;
      if (todo.local === false) return false;
      const id = todoDeviceId(todo);
      if (localDeviceId !== '' && id === localDeviceId) return true;
      if (id === '' || id === LOCAL_DEVICE_ID) return true;
      return false;
    }

    /** Device options with chip keys and per-device open counts from the merged todos. */
    function buildDeviceOptions(devices, todos, t, localDeviceId) {
      // A board labels its own local entry with `local:true` from the producer's point of
      // view; when this device's id is present, prefer the explicit id match.
      const hasExplicitLocal = localDeviceId !== '' && devices.some((device) => device.id === localDeviceId);
      const options = devices.map((device) => {
        const local = hasExplicitLocal ? device.id === localDeviceId : device.local === true;
        const rawName = typeof device.name === 'string' && device.name !== '' ? device.name : device.id;
        return {
          id: device.id,
          key: local ? LOCAL_CHIP_KEY : device.id,
          label: local ? t('deviceLocal') : rawName,
          rawName,
          local,
          online: local ? true : device.online === true,
          open: 0,
          lastSeen: typeof device.lastSeen === 'string' && device.lastSeen !== '' ? device.lastSeen : null,
        };
      });
      // The local device is always the first chip; keep the board order for the rest.
      options.sort((left, right) => (left.local === right.local ? 0 : left.local ? -1 : 1));
      const counts = new Map(options.map((option) => [option.key, 0]));
      for (const todo of todos) {
        if (todo === null || typeof todo !== 'object' || todo.done === true || todo.cancelled === true) continue;
        const key = isLocalTodo(todo, localDeviceId) ? LOCAL_CHIP_KEY : todoDeviceId(todo);
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
      }
      for (const option of options) {
        option.open = counts.has(option.key) ? counts.get(option.key) : 0;
      }
      return options;
    }

    /** Row badge label: "This device" for local rows, the device name for remote rows. */
    function resolveDeviceLabel(todo, devices, t, localDeviceId) {
      if (isLocalTodo(todo, localDeviceId)) return t('deviceLocal');
      if (typeof todo.deviceName === 'string' && todo.deviceName !== '') return todo.deviceName;
      const id = todoDeviceId(todo);
      const device = devices.find((candidate) => candidate.id === id);
      return device !== undefined && typeof device.name === 'string' && device.name !== ''
        ? device.name
        : id;
    }

    /** Header connection pill for hub/device modes; null in local mode or on v1 boards. */
    function connectionStatus(snapshot, devices, t) {
      const mode =
        typeof snapshot.mode === 'string'
          ? snapshot.mode
          : typeof snapshot.role === 'string'
            ? snapshot.role
            : '';
      if (mode === 'hub') {
        const count = devices.length > 0 ? devices.length : 1;
        return {
          tone: 'hub',
          text: t('hubStatus') + ' \u00b7 ' + count + ' ' + t('devicesUnit'),
          title: '',
        };
      }
      if (mode === 'device') {
        const hub = snapshot.hub !== null && typeof snapshot.hub === 'object' ? snapshot.hub : null;
        const connected = hub !== null && hub.connected === true;
        const hubError = hub !== null && typeof hub.error === 'string' ? hub.error : '';
        return {
          tone: connected ? 'online' : 'offline',
          text: connected ? t('deviceConnected') : t('deviceOffline'),
          title: hubError,
        };
      }
      return null;
    }

    /** Relay/tunnel pill for hub mode (starting | running | stopped | disabled). */
    function relayStatus(snapshot, t) {
      const mode =
        typeof snapshot.mode === 'string'
          ? snapshot.mode
          : typeof snapshot.role === 'string'
            ? snapshot.role
            : '';
      if (mode !== 'hub') return null;
      const hub = snapshot.hub !== null && typeof snapshot.hub === 'object' ? snapshot.hub : null;
      const relay = hub !== null && hub.relay !== null && typeof hub.relay === 'object' ? hub.relay : null;
      if (relay === null) return null;
      const state = typeof relay.state === 'string' ? relay.state : '';
      const relayError = typeof relay.error === 'string' ? relay.error : '';
      if (state === 'starting') return { tone: 'hub', text: t('relayStarting'), title: relayError };
      if (state === 'running') return { tone: 'online', text: t('relayRunning'), title: '' };
      if (state === 'stopped') return { tone: 'offline', text: t('relayStopped'), title: relayError };
      if (state === 'disabled') return { tone: 'muted', text: t('relayDisabled'), title: '' };
      return null;
    }

    function dueChipInfo(todo, todayDay, t) {
      const dueDay = dayNumber(todo.due);
      if (dueDay === null) return null;
      const dateText = formatMonthDay(todo.due);
      const diff = dueDay - todayDay;
      if (todo.done === true || todo.cancelled === true) {
        return { tone: 'done', label: dateText, title: t('due') + ': ' + todo.due };
      }
      if (diff < 0) {
        return {
          tone: 'overdue',
          label: dateText,
          title: t('due') + ': ' + todo.due + ' · ' + t('overdue') + ' ' + -diff + ' ' + t('dayUnit'),
        };
      }
      if (diff === 0) {
        return { tone: 'today', label: t('today'), title: t('due') + ': ' + todo.due };
      }
      return { tone: 'future', label: dateText, title: t('due') + ': ' + todo.due };
    }

    function priorityTitle(priority, t) {
      if (typeof priority !== 'string' || priority === '') return '';
      const key = PRIORITY_LABEL_KEYS[priority];
      return t('priority') + ': ' + (key === undefined ? priority : t(key));
    }

    function buildSourceOptions(snapshot, todos) {
      const map = new Map();
      const sources = snapshot && Array.isArray(snapshot.sources) ? snapshot.sources : EMPTY;
      for (const source of sources) {
        if (source === null || typeof source !== 'object' || typeof source.id !== 'string') continue;
        map.set(source.id, {
          id: source.id,
          label:
            typeof source.label === 'string' && source.label !== '' ? source.label : source.id,
          open: typeof source.open === 'number' && Number.isFinite(source.open) ? source.open : null,
          error: typeof source.error === 'string' && source.error !== '' ? source.error : null,
        });
      }
      for (const todo of todos) {
        if (todo === null || typeof todo !== 'object' || typeof todo.sourceId !== 'string') continue;
        if (map.has(todo.sourceId)) continue;
        map.set(todo.sourceId, {
          id: todo.sourceId,
          label:
            typeof todo.sourceLabel === 'string' && todo.sourceLabel !== ''
              ? todo.sourceLabel
              : todo.sourceId,
          open: null,
          error: null,
        });
      }
      return [...map.values()].map((source) => ({ ...source,
        open: todos.filter((todo) => todo.sourceId === source.id && !todo.done && !todo.cancelled).length,
      }));
    }

    function buildStats(snapshot, todos, todayDay) {
      if (snapshot && snapshot.stats !== null && typeof snapshot.stats === 'object') {
        return {
          open: toCount(snapshot.stats.open),
          overdue: toCount(snapshot.stats.overdue),
          dueToday: toCount(snapshot.stats.dueToday),
          dueSoon: toCount(snapshot.stats.dueSoon),
        };
      }
      let open = 0;
      let overdue = 0;
      let dueToday = 0;
      let dueSoon = 0;
      for (const todo of todos) {
        if (todo === null || typeof todo !== 'object' || todo.done === true || todo.cancelled === true) continue;
        open += 1;
        const dueDay = dayNumber(todo.due);
        if (dueDay === null) continue;
        const diff = dueDay - todayDay;
        if (diff < 0) overdue += 1;
        else if (diff === 0) dueToday += 1;
        else if (diff <= 7) dueSoon += 1;
      }
      return { open, overdue, dueToday, dueSoon };
    }

    function applyFilters(todos, query, selectedSources, hideDone, selectedDevices, localDeviceId) {
      const needle = normalizeText(typeof query === 'string' ? query.trim() : '');
      const hasSourceFilter = selectedSources.length > 0;
      const hasDeviceFilter = selectedDevices.length > 0;
      const result = [];
      for (const todo of todos) {
        if (todo === null || typeof todo !== 'object') continue;
        if (hideDone && (todo.done === true || todo.cancelled === true)) continue;
        if (hasDeviceFilter) {
          const local = isLocalTodo(todo, localDeviceId);
          const id = todoDeviceId(todo);
          const matched = selectedDevices.some((key) =>
            key === LOCAL_CHIP_KEY ? local : !local && id === key,
          );
          if (!matched) continue;
        }
        if (hasSourceFilter && !selectedSources.includes(todo.sourceId)) continue;
        if (needle !== '') {
          const tags = Array.isArray(todo.tags) ? todo.tags.filter((tag) => typeof tag === 'string') : EMPTY;
          const haystack = normalizeText(
            (typeof todo.text === 'string' ? todo.text : '') +
              ' ' +
              (typeof todo.heading === 'string' ? todo.heading : '') +
              ' ' +
              tags.join(' '),
          );
          if (!haystack.includes(needle)) continue;
        }
        result.push(todo);
      }
      return result;
    }

    function comparePriorityText(a, b) {
      const rankA = Object.prototype.hasOwnProperty.call(PRIORITY_RANK, a.priority) ? PRIORITY_RANK[a.priority] : 5;
      const rankB = Object.prototype.hasOwnProperty.call(PRIORITY_RANK, b.priority) ? PRIORITY_RANK[b.priority] : 5;
      if (rankA !== rankB) return rankA - rankB;
      return String(typeof a.text === 'string' ? a.text : '').localeCompare(
        String(typeof b.text === 'string' ? b.text : ''),
        'zh',
      );
    }

    function compareDue(a, b) {
      const dueA = dayNumber(a.due);
      const dueB = dayNumber(b.due);
      if (dueA !== dueB) return (dueA === null ? Number.MAX_SAFE_INTEGER : dueA) - (dueB === null ? Number.MAX_SAFE_INTEGER : dueB);
      return comparePriorityText(a, b);
    }

    function buildGroups(todos, todayDay) {
      const overdue = [];
      const today = [];
      const soon = [];
      const later = [];
      const undated = [];
      const done = [];
      for (const todo of todos) {
        if (todo === null || typeof todo !== 'object') continue;
        if (todo.done === true || todo.cancelled === true) {
          done.push(todo);
          continue;
        }
        const dueDay = dayNumber(todo.due);
        if (dueDay === null) {
          undated.push(todo);
          continue;
        }
        const diff = dueDay - todayDay;
        if (diff < 0) overdue.push(todo);
        else if (diff === 0) today.push(todo);
        else if (diff <= 7) soon.push(todo);
        else later.push(todo);
      }
      overdue.sort(compareDue);
      soon.sort(compareDue);
      later.sort(compareDue);
      today.sort(comparePriorityText);
      undated.sort(comparePriorityText);
      done.sort(comparePriorityText);
      return [
        { id: 'overdue', labelKey: 'groupOverdue', rows: overdue },
        { id: 'today', labelKey: 'groupToday', rows: today },
        { id: 'soon', labelKey: 'groupSoon', rows: soon },
        { id: 'later', labelKey: 'groupLater', rows: later },
        { id: 'undated', labelKey: 'groupUndated', rows: undated },
        { id: 'done', labelKey: 'groupDone', rows: done },
      ];
    }

    // -- presentational building blocks ------------------------------------------

    /** Status glyph artwork shared by the static and clickable checkbox variants. */
    function CheckIcon({ mode }) {
      const complete = mode === 'done' || mode === 'cancelled';
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('rect', {
          x: 2.5,
          y: 2.5,
          width: 11,
          height: 11,
          rx: 2.5,
          stroke: 'currentColor',
          strokeWidth: complete ? 0 : 1.4,
          fill: complete ? 'currentColor' : 'none',
        }),
        mode === 'done'
          ? h('path', {
              d: 'M5 8.2l1.9 1.9 4.1-4.2',
              stroke: 'var(--dsw-alias-bg-layer-1)',
              strokeWidth: 1.7,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            })
          : mode === 'cancelled'
            ? h('path', {
                d: 'M5.4 8h5.2',
                stroke: 'var(--dsw-alias-bg-layer-1)',
                strokeWidth: 1.7,
                strokeLinecap: 'round',
              })
            : null,
      );
    }

    /** Read-only status glyph: empty box for open, checked box for done, dashed box for cancelled. */
    function CheckGlyph({ mode, label }) {
      const className =
        'ls-check' + (mode === 'done' ? ' ls-check--done' : mode === 'cancelled' ? ' ls-check--cancelled' : '');
      return h(
        'span',
        { className, role: 'img', 'aria-label': label },
        h(CheckIcon, { mode }),
      );
    }

    /** Clickable status checkbox for local markdown rows (v3.1); toggles done/undone. */
    function CheckButton({ mode, label, pending, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'ls-check-btn' + (mode === 'done' ? ' ls-check-btn--done' : ''),
          title: label,
          'aria-label': label,
          disabled: pending,
          onClick,
        },
        h(CheckIcon, { mode }),
      );
    }

    function DueChip({ t, todo, todayDay }) {
      const info = dueChipInfo(todo, todayDay, t);
      if (info === null) return null;
      return h('span', { className: 'ls-due ls-due--' + info.tone, title: info.title }, info.label);
    }

    function PriorityDot({ t, priority }) {
      if (typeof priority !== 'string' || priority === '') return null;
      const known = Object.prototype.hasOwnProperty.call(PRIORITY_RANK, priority);
      return h('span', {
        className: 'ls-pri' + (known ? ' ls-pri--' + priority : ''),
        title: priorityTitle(priority, t),
        'aria-hidden': 'true',
      });
    }

    /** Inline cancel/restore/delete buttons; only rendered for local markdown todos (v3). */
    function RowActions({ t, todo, pending, armed, onAction, onArmDelete }) {
      const cancelled = todo.cancelled === true;
      const primaryAction = cancelled ? 'restore' : 'cancel';
      const primaryLabel = cancelled ? t('actionRestore') : t('actionCancel');
      const primaryTitle = pending ? t('actionPending') : primaryLabel;
      const deleteTitle = pending
        ? t('actionPending')
        : armed
          ? t('actionDeleteConfirm')
          : t('actionDelete');
      const iconProps = {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      };
      return h(
        'span',
        { className: 'ls-acts' },
        h(
          'button',
          {
            type: 'button',
            className: 'ls-act',
            title: primaryTitle,
            'aria-label': primaryTitle,
            disabled: pending,
            onClick: () => onAction(primaryAction),
          },
          h(
            'svg',
            iconProps,
            cancelled
              ? [
                  h('path', {
                    key: 'arc',
                    d: 'M3 8a5 5 0 1 0 1.5-3.55',
                    stroke: 'currentColor',
                    strokeWidth: 1.4,
                    strokeLinecap: 'round',
                  }),
                  h('path', {
                    key: 'arrow',
                    d: 'M2.8 2.4v3h3',
                    stroke: 'currentColor',
                    strokeWidth: 1.4,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  }),
                ]
              : [
                  h('circle', {
                    key: 'circle',
                    cx: 8,
                    cy: 8,
                    r: 5.5,
                    stroke: 'currentColor',
                    strokeWidth: 1.4,
                  }),
                  h('path', {
                    key: 'slash',
                    d: 'M4.2 4.2l7.6 7.6',
                    stroke: 'currentColor',
                    strokeWidth: 1.4,
                    strokeLinecap: 'round',
                  }),
                ],
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ls-act ls-act--delete' + (armed ? ' ls-act--armed' : ''),
            title: deleteTitle,
            'aria-label': deleteTitle,
            disabled: pending,
            onClick: armed ? () => onAction('delete') : onArmDelete,
          },
          h(
            'svg',
            iconProps,
            h('path', {
              d: 'M3 4.5h10',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
            }),
            h('path', {
              d: 'M6.2 4.5V3.2h3.6v1.3',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
            h('path', {
              d: 'M4.6 4.6l.5 8h5.8l.5-8',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ),
        ),
      );
    }

    function TodoRow({
      t,
      todo,
      todayDay,
      devices,
      showDevice,
      localDeviceId,
      pendingTodoId,
      armedDeleteId,
      onTodoAction,
      onTodoDeleteArm,
    }) {
      const done = todo.done === true;
      const cancelled = todo.cancelled === true;
      const complete = done || cancelled;
      const indent =
        typeof todo.indent === 'number' && todo.indent > 0 ? Math.min(Math.floor(todo.indent), 3) : 0;
      const text =
        typeof todo.text === 'string' && todo.text !== '' ? todo.text : t('untitled');
      const tags = Array.isArray(todo.tags)
        ? todo.tags.filter((tag) => typeof tag === 'string' && tag !== '')
        : EMPTY;
      const badge = sourceBadge(todo, t);
      const deviceLabel = showDevice ? resolveDeviceLabel(todo, devices, t, localDeviceId) : '';
      // Inline write actions only make sense for local markdown todos; DSH session todos
      // and other devices' todos stay read-only.
      const actionable =
        (todo.kind === 'suggestion' || (todo.kind === 'markdown' && isLocalTodo(todo, localDeviceId))) &&
        typeof todo.id === 'string' &&
        todo.id !== '';
      // The status checkbox toggles done/undone only for editable, non-cancelled rows.
      const checkboxEditable = actionable && todo.cancelled !== true;
      const rowPending = pendingTodoId === todo.id;
      const checkLabel = rowPending
        ? t('actionPending')
        : done
          ? t('checkUndone')
          : t('checkDone');
      const tooltip =
        rowTooltip(todo, t) + (showDevice ? '\n' + t('device') + ': ' + deviceLabel : '');
      return h(
        'li',
        {
          className: 'ls-row' + (complete ? ' ls-row--done' : ''),
          title: tooltip,
          style: indent > 0 ? { paddingLeft: 12 + indent * 14 + 'px' } : undefined,
        },
        checkboxEditable
          ? h(CheckButton, {
              mode: done ? 'done' : 'open',
              label: checkLabel,
              pending: rowPending,
              onClick: () => onTodoAction(todo, done ? 'undone' : 'done'),
            })
          : h(CheckGlyph, {
              mode: done ? 'done' : cancelled ? 'cancelled' : 'open',
              label: done ? t('groupDone') : cancelled ? t('cancelled') : t('statOpen'),
            }),
        cancelled ? h('span', { className: 'ls-cancel', title: t('cancelled') }, t('cancelled')) : null,
        h('span', { className: 'ls-row__text' }, text),
        tags.length > 0
          ? h(
              'span',
              { className: 'ls-tags' },
              tags.slice(0, 2).map((tag) =>
                h('span', { key: 'tag:' + tag, className: 'ls-tag', title: '#' + tag }, '#' + tag),
              ),
              tags.length > 2
                ? h(
                    'span',
                    { className: 'ls-tag ls-tag--more', title: tags.map((tag) => '#' + tag).join(' ') },
                    '+' + (tags.length - 2),
                  )
                : null,
            )
          : null,
        h(DueChip, { t, todo, todayDay }),
        h(PriorityDot, { t, priority: todo.priority }),
        h('span', { className: 'ls-badge ls-badge--' + badge.kind, title: badge.title }, badge.text),
        showDevice
          ? h('span', { className: 'ls-device-badge', title: t('device') + ': ' + deviceLabel }, deviceLabel)
          : null,
        actionable
          ? h(RowActions, {
              t,
              todo,
              pending: pendingTodoId === todo.id,
              armed: armedDeleteId === todo.id,
              onAction: (action) => onTodoAction(todo, action),
              onArmDelete: () => onTodoDeleteArm(todo),
            })
          : null,
      );
    }

    function TodoGroup({
      t,
      group,
      doneExpanded,
      onToggleDone,
      todayDay,
      devices,
      showDevice,
      localDeviceId,
      pendingTodoId,
      armedDeleteId,
      onTodoAction,
      onTodoDeleteArm,
    }) {
      const isDone = group.id === 'done';
      const expanded = isDone ? doneExpanded : true;
      const count = group.rows.length;
      const heading = isDone
        ? h(
            'h3',
            { className: 'ls-group__head' },
            h(
              'button',
              {
                type: 'button',
                className: 'ls-group__toggle',
                'aria-expanded': expanded ? 'true' : 'false',
                title: expanded ? t('collapseDone') : t('expandDone'),
                onClick: onToggleDone,
              },
              h(
                'svg',
                {
                  className: 'ls-group__chevron',
                  width: 10,
                  height: 10,
                  viewBox: '0 0 12 12',
                  fill: 'none',
                  'aria-hidden': 'true',
                  focusable: 'false',
                },
                h('path', {
                  d: 'M4.2 2.6L7.8 6l-3.6 3.4',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }),
              ),
              t(group.labelKey),
            ),
            h('span', { className: 'ls-group__count' }, String(count)),
          )
        : h(
            'h3',
            { className: 'ls-group__head' },
            h('span', { className: 'ls-group__title' }, t(group.labelKey)),
            h('span', { className: 'ls-group__count' }, String(count)),
          );
      return h(
        'section',
        { className: 'ls-group ls-group--' + group.id },
        heading,
        expanded && count > 0
          ? h(
              'ul',
              { className: 'ls-group__rows' },
              group.rows.map((todo, index) =>
                h(TodoRow, {
                  key: typeof todo.id === 'string' && todo.id !== '' ? todo.id : 'row-' + index,
                  t,
                  todo,
                  todayDay,
                  devices,
                  showDevice,
                  localDeviceId,
                  pendingTodoId,
                  armedDeleteId,
                  onTodoAction,
                  onTodoDeleteArm,
                }),
              ),
            )
          : null,
      );
    }

    function StatCard({ t, labelKey, value, tone }) {
      return h(
        'div',
        { className: 'ls-stat' + (tone !== null ? ' ls-stat--' + tone : '') },
        h('div', { className: 'ls-stat__num' }, String(toCount(value))),
        h('div', { className: 'ls-stat__label' }, t(labelKey)),
      );
    }

    function StatsBar({ t, stats, completed }) {
      return h(
        'div',
        { className: 'ls-stats' },
        h(StatCard, { t, labelKey: 'statOpen', value: stats.open, tone: null }),
        h(StatCard, { t, labelKey: 'statOverdue', value: stats.overdue, tone: stats.overdue > 0 ? 'alert' : null }),
        h(StatCard, { t, labelKey: 'statToday', value: stats.dueToday, tone: stats.dueToday > 0 ? 'warn' : null }),
        h(StatCard, { t, labelKey: 'statSoon', value: stats.dueSoon, tone: null }),
        h(StatCard, { t, labelKey: 'statDone', value: completed, tone: null }),
      );
    }

    function Toolbar({
      t,
      query,
      onQueryChange,
      sources,
      selectedSources,
      onToggleSource,
      onClearSources,
      hideDone,
      onToggleHideDone,
      devices,
      selectedDevices,
      onToggleDevice,
      onClearDevices,
    }) {
      const searchRow = h(
        'div',
        { className: 'ls-toolbar__row' },
        h(
          'div',
          { className: 'ls-search' },
          h(
            'svg',
            {
              className: 'ls-search__icon',
              width: 14,
              height: 14,
              viewBox: '0 0 16 16',
              fill: 'none',
              'aria-hidden': 'true',
              focusable: 'false',
            },
            h('circle', { cx: 7, cy: 7, r: 4.5, stroke: 'currentColor', strokeWidth: 1.4 }),
            h('path', { d: 'M10.4 10.4L14 14', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          ),
          h('input', {
            type: 'search',
            className: 'ls-search__input',
            value: query,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchLabel'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => onQueryChange(event.target.value),
          }),
          query !== ''
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ls-search__clear',
                  title: t('clearSearch'),
                  'aria-label': t('clearSearch'),
                  onClick: () => onQueryChange(''),
                },
                '\u00d7',
              )
            : null,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ls-switch',
            role: 'switch',
            'aria-checked': hideDone ? 'true' : 'false',
            title: t('hideDone'),
            onClick: onToggleHideDone,
          },
          h(
            'span',
            { className: 'ls-switch__track', 'aria-hidden': 'true' },
            h('span', { className: 'ls-switch__knob' }),
          ),
          h('span', { className: 'ls-switch__label' }, t('hideDone')),
        ),
      );

      // Device chips sit above the source chips and only exist on a merged (multi-device) board.
      const deviceRow =
        devices.length > 1
          ? h(
              'div',
              { className: 'ls-toolbar__row' },
              h('span', { className: 'ls-filter__label' }, t('devicesLabel')),
              h(
                'div',
                { className: 'ls-chips', role: 'group', 'aria-label': t('filterByDevice') },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-chip',
                    'aria-pressed': selectedDevices.length === 0 ? 'true' : 'false',
                    onClick: onClearDevices,
                  },
                  t('allDevices'),
                ),
                devices.map((device) =>
                  h(
                    'button',
                    {
                      key: device.id,
                      type: 'button',
                      className: 'ls-chip',
                      'aria-pressed': selectedDevices.includes(device.key) ? 'true' : 'false',
                      title:
                        device.rawName +
                        ' \u00b7 ' +
                        (device.online ? t('online') : t('offline')) +
                        (device.lastSeen !== null ? ' \u00b7 ' + formatStamp(device.lastSeen) : ''),
                      onClick: () => onToggleDevice(device.key),
                    },
                    h('span', {
                      className:
                        'ls-chip__dot' + (device.online ? ' ls-chip__dot--online' : ' ls-chip__dot--offline'),
                      'aria-hidden': 'true',
                    }),
                    device.label,
                    h('span', { className: 'ls-chip__count' }, String(device.open)),
                  ),
                ),
              ),
            )
          : null;

      const sourceRow = h(
        'div',
        { className: 'ls-toolbar__row' },
        h('span', { className: 'ls-filter__label' }, t('sources')),
        h(
          'div',
          { className: 'ls-chips', role: 'group', 'aria-label': t('filterBySource') },
          h(
            'button',
            {
              type: 'button',
              className: 'ls-chip',
              'aria-pressed': selectedSources.length === 0 ? 'true' : 'false',
              onClick: onClearSources,
            },
            t('allSources'),
          ),
          sources.map((source) =>
            h(
              'button',
              {
                key: source.id,
                type: 'button',
                className: 'ls-chip' + (source.error !== null ? ' ls-chip--error' : ''),
                'aria-pressed': selectedSources.includes(source.id) ? 'true' : 'false',
                title: source.error !== null ? source.error : source.label,
                onClick: () => onToggleSource(source.id),
              },
              source.error !== null
                ? h('span', { className: 'ls-chip__err', 'aria-hidden': 'true' })
                : null,
              source.label,
              typeof source.open === 'number'
                ? h('span', { className: 'ls-chip__count' }, String(source.open))
                : null,
            ),
          ),
        ),
      );

      return h('div', { className: 'ls-toolbar' }, searchRow, h('details', { className: 'ls-filter-details' }, h('summary', null, '来源与设备', selectedSources.length + selectedDevices.length ? ' · 已筛选' : ''), deviceRow, sourceRow));
    }

    function PageHeader({ t, generatedAt, pending, onRefresh, status, relay }) {
      const stamp = formatStamp(generatedAt);
      return h(
        'header',
        { className: 'ls-head' },
        h(
          'div',
          { className: 'ls-head__main' },
          h('h2', { className: 'ls-title' }, t('title')),
          h('p', { className: 'ls-subtitle' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'ls-head__meta' },
          status !== null && status !== undefined
            ? h(
                'span',
                {
                  className: 'ls-conn ls-conn--' + status.tone,
                  title: status.title !== '' ? status.title : undefined,
                },
                h('span', { className: 'ls-conn__dot', 'aria-hidden': 'true' }),
                h('span', { className: 'ls-conn__text' }, status.text),
              )
            : null,
          relay !== null && relay !== undefined
            ? h(
                'span',
                {
                  className: 'ls-conn ls-conn--' + relay.tone,
                  title: relay.title !== '' ? relay.title : undefined,
                },
                h('span', { className: 'ls-conn__dot', 'aria-hidden': 'true' }),
                h('span', { className: 'ls-conn__text' }, relay.text),
              )
            : null,
          h(
            'span',
            { className: 'ls-stamp', title: typeof generatedAt === 'string' ? generatedAt : '' },
            t('lastScan') + ' ' + (stamp === '' ? '\u2014' : stamp),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ls-refresh' + (pending ? ' ls-refresh--busy' : ''),
              disabled: pending,
              title: t('refreshHint'),
              onClick: onRefresh,
            },
            h(
              'svg',
              {
                className: 'ls-refresh__icon',
                width: 14,
                height: 14,
                viewBox: '0 0 16 16',
                fill: 'none',
                'aria-hidden': 'true',
                focusable: 'false',
              },
              h('path', {
                d: 'M13.2 8a5.2 5.2 0 1 1-1.7-3.85',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
              }),
              h('path', {
                d: 'M13.4 2.6v3.1h-3.1',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
            h('span', null, pending ? t('refreshing') : t('refresh')),
          ),
        ),
      );
    }

    function LoadingBlock({ t }) {
      return h(
        'div',
        { className: 'ls-loading', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'ls-loading__text' }, t('loading')),
        h(
          'div',
          { className: 'ls-skeleton', 'aria-hidden': 'true' },
          [0, 1, 2, 3].map((index) => h('div', { key: index, className: 'ls-skel' })),
        ),
      );
    }

    function OfflineBlock({ t, error, onRetry }) {
      return h(
        'div',
        { className: 'ls-empty ls-empty--offline', role: 'status' },
        h('p', { className: 'ls-empty__title' }, t('offlineTitle')),
        h('p', { className: 'ls-empty__body' }, t('offlineBody')),
        error !== null ? h('p', { className: 'ls-empty__detail' }, t('loadFailed') + ': ' + error) : null,
        h('button', { type: 'button', className: 'ls-btn', onClick: onRetry }, t('retry')),
      );
    }

    function EmptyBlock({ t }) {
      return h(
        'div',
        { className: 'ls-empty', role: 'status' },
        h('p', { className: 'ls-empty__title' }, t('emptyTitle')),
        h(
          'p',
          { className: 'ls-empty__body' },
          t('emptyBefore'),
          h('code', null, t('emptyCode')),
          t('emptyAfter'),
        ),
      );
    }

    function FilteredEmpty({ t, onClear }) {
      return h(
        'div',
        { className: 'ls-empty', role: 'status' },
        h('p', { className: 'ls-empty__title' }, t('filteredEmptyTitle')),
        h('p', { className: 'ls-empty__body' }, t('filteredEmptyBody')),
        h('button', { type: 'button', className: 'ls-btn', onClick: onClear }, t('clearFilters')),
      );
    }

    function ErrorBanner({ t, error, onRetry }) {
      return h(
        'div',
        { className: 'ls-banner', role: 'status' },
        h('span', { className: 'ls-banner__text', title: error }, t('loadFailed') + ': ' + error),
        h('button', { type: 'button', className: 'ls-btn ls-btn--small', onClick: onRetry }, t('retry')),
      );
    }

    /** Closable error banner shown directly below the toolbar after a failed row action. */
    function ActionErrorBanner({ t, error, onClose }) {
      return h(
        'div',
        { className: 'ls-banner', role: 'status' },
        h('span', { className: 'ls-banner__text', title: error }, t('actionFailed') + ': ' + error),
        h(
          'button',
          {
            type: 'button',
            className: 'ls-banner__close',
            title: t('actionDismiss'),
            'aria-label': t('actionDismiss'),
            onClick: onClose,
          },
          '\u00d7',
        ),
      );
    }

    function StaleBanner({ t, error }) {
      return h(
        'div',
        { className: 'ls-banner ls-banner--warn', role: 'status' },
        h(
          'span',
          { className: 'ls-banner__text', title: error },
          t('staleWarning') + (error !== '' ? ': ' + error : ''),
        ),
      );
    }

    /** Device-mode banner when the hub cannot be reached. */
    function HubOfflineBanner({ t, hub }) {
      const info = hub !== null && typeof hub === 'object' ? hub : null;
      const error = info !== null && typeof info.error === 'string' ? info.error : '';
      const stamp = info !== null ? formatStamp(info.lastSyncAt) : '';
      return h(
        'div',
        { className: 'ls-banner', role: 'status' },
        h(
          'div',
          { className: 'ls-banner__main' },
          h('span', { className: 'ls-banner__title' }, t('hubOfflineTitle')),
          error !== '' ? h('span', { className: 'ls-banner__detail', title: error }, error) : null,
        ),
        h(
          'span',
          { className: 'ls-banner__meta' },
          t('lastSync') + ': ' + (stamp === '' ? '\u2014' : stamp),
        ),
      );
    }

    /** Local-mode card that joins this device to a hub (POST /leo-status/api/join). */
    function JoinCard({ t, defaultName, onJoined }) {
      const [hubUrl, setHubUrl] = useState(DEFAULT_HUB_URL);
      const [password, setPassword] = useState('');
      const [name, setName] = useState(typeof defaultName === 'string' ? defaultName : '');
      const [markdownRoot, setMarkdownRoot] = useState('');
      const [pending, setPending] = useState(false);
      const [error, setError] = useState(null);

      const submit = async (event) => {
        if (event !== undefined && event !== null && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        if (pending) return;
        const trimmedUrl = hubUrl.trim();
        const trimmedName = name.trim();
        const trimmedRoot = markdownRoot.trim();
        if (trimmedUrl === '' || password === '' || trimmedName === '') return;
        const payload = { hubUrl: trimmedUrl, password, name: trimmedName };
        if (trimmedRoot !== '') payload.markdownRoot = trimmedRoot;
        setPending(true);
        setError(null);
        try {
          const response = await apiFetch(JOIN_API, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok || body === null || typeof body !== 'object' || body.ok !== true) {
            const message =
              body !== null && typeof body === 'object' && typeof body.error === 'string' && body.error !== ''
                ? body.error
                : response.ok
                  ? 'invalid response'
                  : 'HTTP ' + response.status;
            throw new Error(message);
          }
          setPending(false);
          onJoined(body.board);
        } catch (joinError) {
          setPending(false);
          setError(describeError(joinError));
        }
      };

      return h(
        'form',
        { className: 'ls-join', onSubmit: submit, 'aria-label': t('joinTitle') },
        h('h3', { className: 'ls-join__title' }, t('joinTitle')),
        h('p', { className: 'ls-join__intro' }, t('joinIntro')),
        h(
          'div',
          { className: 'ls-join__grid' },
          h(
            'label',
            { className: 'ls-field' },
            h('span', { className: 'ls-field__label' }, t('joinHubUrl')),
            h('input', {
              className: 'ls-input',
              type: 'url',
              value: hubUrl,
              required: true,
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setHubUrl(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'ls-field' },
            h('span', { className: 'ls-field__label' }, t('joinPassword')),
            h('input', {
              className: 'ls-input',
              type: 'password',
              value: password,
              required: true,
              autoComplete: 'current-password',
              onChange: (event) => setPassword(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'ls-field' },
            h('span', { className: 'ls-field__label' }, t('joinName')),
            h('input', {
              className: 'ls-input',
              type: 'text',
              value: name,
              required: true,
              maxLength: 60,
              autoComplete: 'off',
              onChange: (event) => setName(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'ls-field' },
            h('span', { className: 'ls-field__label' }, t('joinRootLabel')),
            h('input', {
              className: 'ls-input',
              type: 'text',
              value: markdownRoot,
              placeholder: t('joinRootPlaceholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setMarkdownRoot(event.target.value),
            }),
          ),
        ),
        h(
          'div',
          { className: 'ls-join__actions' },
          h(
            'button',
            {
              type: 'submit',
              className: 'ls-btn ls-btn--primary',
              disabled: pending || hubUrl.trim() === '' || password === '' || name.trim() === '',
            },
            pending ? t('joinSubmitting') : t('joinSubmit'),
          ),
          error !== null
            ? h('span', { className: 'ls-join__error', title: error }, t('joinFailed') + ': ' + error)
            : null,
        ),
      );
    }

    function PageFooter({ t, snapshot }) {
      const took = toCount(snapshot.tookMs);
      const sources = Array.isArray(snapshot.sources)
        ? snapshot.sources.filter((source) => source !== null && typeof source === 'object')
        : EMPTY;
      const files = sources.reduce((sum, source) => sum + toCount(source.files), 0);
      const failed = sources.filter(
        (source) => typeof source.error === 'string' && source.error !== '',
      );
      return h(
        'footer',
        { className: 'ls-foot' },
        h(
          'div',
          { className: 'ls-foot__line' },
          h('span', null, t('took') + ': ' + took + ' ms'),
          h('span', null, t('files') + ': ' + files),
          h('span', null, t('sources') + ': ' + sources.length),
          failed.length > 0 ? h('span', null, t('sourceErrors') + ': ' + failed.length) : null,
        ),
        failed.length > 0
          ? h(
              'ul',
              { className: 'ls-foot__errors' },
              failed.map((source, index) =>
                h(
                  'li',
                  { key: typeof source.id === 'string' ? source.id : 'source-' + index, className: 'ls-foot__error' },
                  (typeof source.label === 'string' && source.label !== ''
                    ? source.label
                    : typeof source.id === 'string'
                      ? source.id
                      : t('sources')) +
                    ': ' +
                    source.error,
                ),
              ),
            )
          : null,
      );
    }

    // -- Obsidian data-source card (v0.4) ---------------------------------------

    /** Rule rows rendered in the data-source card; only `checkbox` is read-only. */
    const OBSIDIAN_RULE_DEFS = [
      { key: 'checkbox', labelKey: 'obsidianRuleCheckbox', hintKey: 'obsidianRuleCheckboxHint' },
      { key: 'autoDetect', labelKey: 'obsidianAutoDetect', hintKey: 'obsidianAutoDetectHint', readonly: false },
      { key: 'tagLines', labelKey: 'obsidianRuleTag', hintKey: 'obsidianRuleTagHint', readonly: false },
      { key: 'markers', labelKey: 'obsidianRuleMarker', hintKey: 'obsidianRuleMarkerHint', readonly: false },
      { key: 'frontmatter', labelKey: 'obsidianRuleFrontmatter', hintKey: 'obsidianRuleFrontmatterHint', readonly: false },
      { key: 'frontmatterList', labelKey: 'obsidianRuleFrontmatterList', hintKey: 'obsidianRuleFrontmatterListHint', readonly: false },
    ];

    /** Keep the tail of a long filesystem path so rows stay scannable. */
    function shortenPath(value, maxLength) {
      const text = typeof value === 'string' ? value : '';
      const limit = typeof maxLength === 'number' && maxLength > 8 ? maxLength : 52;
      if (text.length <= limit) return text;
      const parts = text.replace(/\\/g, '/').split('/').filter((part) => part !== '');
      let tail = parts.slice(-2).join('/');
      if (tail.length > limit - 2) tail = tail.slice(-(limit - 2));
      return '\u2026/' + tail;
    }

    function readMarkdownRoots(settings) {
      if (settings === null || typeof settings !== 'object') return EMPTY;
      if (!Array.isArray(settings.markdownRoots)) return EMPTY;
      return settings.markdownRoots.filter((root) => root !== null && typeof root === 'object');
    }

    function readObsidianRules(settings) {
      const source = settings !== null && typeof settings === 'object' ? settings : {};
      const obsidian = source.obsidian !== null && typeof source.obsidian === 'object' ? source.obsidian : {};
      const conventions =
        obsidian.conventions !== null && typeof obsidian.conventions === 'object' ? obsidian.conventions : {};
      return {
        autoDetect: obsidian.autoDetect !== false,
        checkbox: true,
        tagLines: conventions.tagLines !== false,
        markers: conventions.markers === true,
        frontmatter: conventions.frontmatter !== false,
        frontmatterList: conventions.frontmatterList !== false,
      };
    }

    /** Dashboard card: Obsidian vault discovery, attached roots and parsing toggles. */
    function ObsidianSourceCard({ t, applyBoard }) {
      const [vaults, setVaults] = useState(EMPTY);
      const [roots, setRoots] = useState(EMPTY);
      const [rules, setRules] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [pendingKey, setPendingKey] = useState(null);
      const mounted = useRef(true);

      const load = async () => {
        setLoading(true);
        setError(null);
        try {
          const [vaultBody, settingsBody] = await Promise.all([apiJson(VAULTS_API), apiJson(SETTINGS_API)]);
          if (!mounted.current) return;
          setVaults(
            Array.isArray(vaultBody.vaults)
              ? vaultBody.vaults.filter(
                  (vault) => vault !== null && typeof vault === 'object' && typeof vault.path === 'string',
                )
              : EMPTY,
          );
          const settings =
            settingsBody.settings !== null && typeof settingsBody.settings === 'object'
              ? settingsBody.settings
              : {};
          setRoots(readMarkdownRoots(settings));
          setRules(readObsidianRules(settings));
          setLoading(false);
        } catch (loadError) {
          if (!mounted.current) return;
          setLoading(false);
          setError(describeError(loadError));
        }
      };

      useEffect(() => {
        mounted.current = true;
        load();
        return () => {
          mounted.current = false;
        };
      }, []);

      const reloadVaults = async () => {
        const body = await apiJson(VAULTS_API);
        if (!mounted.current) return;
        setVaults(
          Array.isArray(body.vaults)
            ? body.vaults.filter(
                (vault) => vault !== null && typeof vault === 'object' && typeof vault.path === 'string',
              )
            : EMPTY,
        );
      };

      const applySettingsPayload = (settings) => {
        if (settings === null || typeof settings !== 'object') return;
        setRoots(readMarkdownRoots(settings));
        setRules(readObsidianRules(settings));
      };

      const beginAction = (key) => {
        if (pendingKey !== null) return false;
        setPendingKey(key);
        setError(null);
        setNotice(null);
        return true;
      };
      const endAction = () => {
        if (mounted.current) setPendingKey(null);
      };

      const attachVault = async (vault) => {
        if (!beginAction('vault:' + vault.path)) return;
        try {
          const body = await apiJson(VAULT_ATTACH_API, {
            method: 'POST',
            body: { path: vault.path, label: typeof vault.name === 'string' ? vault.name : '' },
          });
          if (!mounted.current) return;
          if (Array.isArray(body.roots)) setRoots(body.roots);
          if (body.board !== null && typeof body.board === 'object') applyBoard(body.board);
          await reloadVaults();
          if (mounted.current) setNotice(t('obsidianAttached'));
        } catch (actionError) {
          if (mounted.current) setError(describeError(actionError));
        } finally {
          endAction();
        }
      };

      const removeRoot = async (root) => {
        if (!beginAction('root:' + (typeof root.id === 'string' ? root.id : root.path))) return;
        const nextRoots = roots.filter(
          (item) =>
            item !== root &&
            !(typeof root.path === 'string' && typeof item.path === 'string' && item.path === root.path),
        );
        try {
          const body = await apiJson(SETTINGS_API, {
            method: 'POST',
            body: { markdownRoots: nextRoots, ...(nextRoots.length === 0 ? { obsidian: { autoDetect: false } } : {}) },
          });
          if (!mounted.current) return;
          applySettingsPayload(body.settings);
          if (body.board !== null && typeof body.board === 'object') applyBoard(body.board);
          await reloadVaults();
          if (mounted.current) setNotice(t('obsidianSaved'));
        } catch (actionError) {
          if (mounted.current) setError(describeError(actionError));
        } finally {
          endAction();
        }
      };

      const toggleRule = async (ruleKey) => {
        if (rules === null) return;
        if (!beginAction('rule:' + ruleKey)) return;
        const nextValue = rules[ruleKey] !== true;
        const patch =
          ruleKey === 'autoDetect'
            ? { obsidian: { autoDetect: nextValue } }
            : { obsidian: { conventions: { [ruleKey]: nextValue } } };
        try {
          const body = await apiJson(SETTINGS_API, { method: 'POST', body: patch });
          if (!mounted.current) return;
          applySettingsPayload(body.settings);
          if (body.board !== null && typeof body.board === 'object') applyBoard(body.board);
          await reloadVaults();
          if (mounted.current) setNotice(t('obsidianSaved'));
        } catch (actionError) {
          if (mounted.current) setError(describeError(actionError));
        } finally {
          endAction();
        }
      };

      const rescan = async () => {
        if (!beginAction('rescan')) return;
        try {
          const board = await apiJson(API + '?refresh=1');
          if (!mounted.current) return;
          if (board !== null && typeof board === 'object') applyBoard(board);
          setNotice(t('obsidianSaved'));
        } catch (actionError) {
          if (mounted.current) setError(describeError(actionError));
        } finally {
          endAction();
        }
      };

      const autoDetectOn = rules !== null && rules.autoDetect === true;
      const ruleNodes = OBSIDIAN_RULE_DEFS.map((def) => {
        const checked = def.readonly === true ? true : rules !== null && rules[def.key] === true;
        return h(
          'div',
          { key: def.key, className: 'ls-obs-rule' },
          def.readonly === true
            ? h('span', { className: 'ls-obs-checkbox', 'aria-hidden': 'true' }, h(CheckIcon, { mode: 'done' }))
            : h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  className: 'ls-obs-toggle',
                  'aria-checked': checked ? 'true' : 'false',
                  title: t(def.labelKey),
                  'aria-label': t(def.labelKey),
                  disabled: pendingKey !== null,
                  onClick: () => toggleRule(def.key),
                },
                h('span', { className: 'ls-obs-toggle__knob', 'aria-hidden': 'true' }),
              ),
          h(
            'span',
            { className: 'ls-obs-rule__main' },
            h('span', { className: 'ls-obs-rule__label' }, t(def.labelKey)),
            h('span', { className: 'ls-obs-rule__hint' }, t(def.hintKey)),
          ),
          def.readonly === true ? h('span', { className: 'ls-obs-readonly' }, t('obsidianReadonly')) : null,
        );
      });

      return h(
        'section',
        { className: 'ls-obs-card', 'aria-label': t('obsidianCardTitle') },
        h(
          'div',
          { className: 'ls-obs-head' },
          h(
            'div',
            { className: 'ls-obs-head__main' },
            h(
              'div',
              { className: 'ls-obs-title' },
              h(
                'span',
                { className: 'ls-obs-icon', 'aria-hidden': 'true' },
                h(
                  'svg',
                  { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
                  h('path', {
                    d: 'M2.2 4.4h4l1.2 1.4h6.4v7.8H2.2z',
                    stroke: 'currentColor',
                    strokeWidth: 1.3,
                    strokeLinejoin: 'round',
                  }),
                  h('path', {
                    d: 'M5.5 8.4h5M8 6v4.8',
                    stroke: 'currentColor',
                    strokeWidth: 1.3,
                    strokeLinecap: 'round',
                  }),
                ),
              ),
              h('span', null, t('obsidianCardTitle')),
            ),
            h(
              'div',
              { className: 'ls-obs-sub' },
              t('obsidianCardHint') +
                ' \u00b7 ' +
                t('obsidianAutoDetect') +
                ': ' +
                (autoDetectOn ? t('obsidianAutoDetectOn') : t('obsidianAutoDetectOff')),
            ),
          ),
          h(
            'div',
            { className: 'ls-obs-actions' },
            notice !== null ? h('span', { className: 'ls-obs-notice' }, notice) : null,
            h(
              'button',
              {
                type: 'button',
                className: 'ls-obs-btn',
                disabled: pendingKey !== null,
                onClick: rescan,
              },
              pendingKey === 'rescan' ? t('obsidianRescanning') : t('obsidianRescan'),
            ),
          ),
        ),
        error !== null
          ? h(
              'div',
              { className: 'ls-obs-error' },
              h('span', null, t('obsidianError') + ': ' + error),
              h('button', { type: 'button', className: 'ls-obs-btn', onClick: load }, t('obsidianRetry')),
            )
          : null,
        loading && rules === null
          ? h('div', { className: 'ls-obs-empty' }, t('obsidianLoading'))
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'ls-obs-section' },
                h(
                  'div',
                  { className: 'ls-obs-section__title' },
                  h('span', null, t('obsidianVaults')),
                  h('span', { className: 'ls-obs-badge' }, String(vaults.length)),
                ),
                vaults.length === 0
                  ? h('div', { className: 'ls-obs-empty' }, t('obsidianVaultsEmpty'))
                  : vaults.map((vault) =>
                      h(
                        'div',
                        { key: vault.path, className: 'ls-obs-row' },
                        h(
                          'div',
                          { className: 'ls-obs-row__main' },
                          h(
                            'span',
                            { className: 'ls-obs-name' },
                            typeof vault.name === 'string' && vault.name !== ''
                              ? vault.name
                              : baseName(vault.path) || vault.path,
                          ),
                          h('span', { className: 'ls-obs-path', title: vault.path }, shortenPath(vault.path)),
                          h(
                            'span',
                            { className: 'ls-obs-meta' },
                            String(toCount(vault.noteCount)) + ' ' + t('obsidianNotes'),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'ls-obs-actions' },
                          vault.attached === true
                            ? h('span', { className: 'ls-obs-badge ls-obs-badge--ok' }, t('obsidianAttached'))
                            : h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'ls-obs-btn ls-obs-btn--primary',
                                  disabled: pendingKey !== null,
                                  onClick: () => attachVault(vault),
                                },
                                t('obsidianAttach'),
                              ),
                        ),
                      ),
                    ),
              ),
              h(
                'div',
                { className: 'ls-obs-section' },
                h(
                  'div',
                  { className: 'ls-obs-section__title' },
                  h('span', null, t('obsidianRoots')),
                  h('span', { className: 'ls-obs-badge' }, String(roots.length)),
                ),
                roots.length === 0
                  ? h('div', { className: 'ls-obs-empty' }, t('obsidianRootsEmpty'))
                  : roots.map((root, index) =>
                      h(
                        'div',
                        {
                          key: typeof root.id === 'string' ? root.id : 'root-' + index,
                          className: 'ls-obs-row',
                        },
                        h(
                          'div',
                          { className: 'ls-obs-row__main' },
                          h(
                            'span',
                            { className: 'ls-obs-name' },
                            typeof root.label === 'string' && root.label !== ''
                              ? root.label
                              : baseName(root.path) || String(root.path ?? ''),
                          ),
                          h(
                            'span',
                            { className: 'ls-obs-path', title: typeof root.path === 'string' ? root.path : '' },
                            shortenPath(root.path),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'ls-obs-actions' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'ls-obs-btn',
                              disabled: pendingKey !== null,
                              onClick: () => removeRoot(root),
                            },
                            t('obsidianRemove'),
                          ),
                        ),
                      ),
                    ),
              ),
              h(
                'div',
                { className: 'ls-obs-section' },
                h('div', { className: 'ls-obs-section__title' }, h('span', null, t('obsidianRules'))),
                h('div', { className: 'ls-obs-rules' }, ruleNodes),
              ),
            ),
      );
    }

    // -- data loading ------------------------------------------------------------

    /** Fetch the snapshot, with explicit loading/refresh/error/stale states. */
    function useTodoData() {
      const [state, setState] = useState({ snapshot: null, error: null, pending: true, stale: null });
      const alive = useRef(true);

      const load = useCallback(async (force) => {
        setState((previous) => ({ ...previous, pending: true, error: null }));
        try {
          const response = await apiFetch(force ? API + '?refresh=1' : API, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const body = await response.json();
          if (body === null || typeof body !== 'object') throw new Error('invalid response');
          const message =
            typeof body.error === 'string' && body.error !== '' ? body.error : 'invalid response';
          if (body.ok === false) {
            // A stale snapshot is still renderable: show the last data plus a warning.
            if (body.stale === true) {
              if (!alive.current) return;
              setState({ snapshot: body, error: null, pending: false, stale: message });
              return;
            }
            throw new Error(message);
          }
          if (!alive.current) return;
          setState({ snapshot: body, error: null, pending: false, stale: null });
        } catch (error) {
          if (!alive.current) return;
          setState((previous) => ({ ...previous, pending: false, error: describeError(error) }));
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        load(false);
        return () => {
          alive.current = false;
        };
      }, [load]);

      const refresh = useCallback(() => load(true), [load]);
      const retry = useCallback(() => load(false), [load]);
      // Apply a board returned by another endpoint (e.g. the join response) without a refetch.
      const applyBoard = useCallback((board) => {
        if (board === null || typeof board !== 'object' || !alive.current) return;
        const isStale = board.ok === false && board.stale === true;
        setState({
          snapshot: board,
          error: null,
          pending: false,
          stale: isStale ? (typeof board.error === 'string' ? board.error : '') : null,
        });
      }, []);
      return {
        snapshot: state.snapshot,
        error: state.error,
        pending: state.pending,
        stale: state.stale,
        refresh,
        retry,
        applyBoard,
      };
    }

    // -- full-page dashboard -----------------------------------------------------


    function DashboardPage(props) {
      const t = props !== null && typeof props === 'object' && typeof props.t === 'function' ? props.t : boundT;
      const { snapshot, error, pending, stale, refresh, retry, applyBoard } = useTodoData();
      const todos = snapshot !== null && Array.isArray(snapshot.todos) ? snapshot.todos : EMPTY;
      const todayDay = dayNumber(localDateKey(new Date())) ?? 0;

      const [query, setQuery] = useState('');
      const [selectedSources, setSelectedSources] = useState(EMPTY);
      const [selectedDevices, setSelectedDevices] = useState(EMPTY);
      // The completed group is collapsed by default; "hide completed" removes it entirely.
      const [hideDone, setHideDone] = useState(false);
      const [doneExpanded, setDoneExpanded] = useState(false);
      const [activeTab, setActiveTab] = useState('todos');
      const [sourcesVisited, setSourcesVisited] = useState(false);
      const [pendingTodoId, setPendingTodoId] = useState(null);
      const [armedDeleteId, setArmedDeleteId] = useState(null);
      const [actionError, setActionError] = useState(null);
      const armedTimer = useRef(null);
      const mounted = useRef(true);
      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
          if (armedTimer.current !== null) {
            clearTimeout(armedTimer.current);
            armedTimer.current = null;
          }
        };
      }, []);

      const localDeviceId =
        snapshot !== null &&
        snapshot.device !== null &&
        typeof snapshot.device === 'object' &&
        typeof snapshot.device.id === 'string'
          ? snapshot.device.id
          : '';

      const boardDevices = useMemo(() => {
        if (snapshot === null || !Array.isArray(snapshot.devices)) return EMPTY;
        return snapshot.devices.filter(
          (device) => device !== null && typeof device === 'object' && typeof device.id === 'string',
        );
      }, [snapshot]);
      const deviceOptions = useMemo(
        () => buildDeviceOptions(boardDevices, todos, t, localDeviceId),
        [boardDevices, todos, t, localDeviceId],
      );
      const multiDevice = deviceOptions.length > 1;

      const sources = useMemo(() => buildSourceOptions(snapshot, todos), [snapshot, todos]);
      const filtered = useMemo(
        () => applyFilters(todos, query, selectedSources, hideDone, selectedDevices, localDeviceId),
        [todos, query, selectedSources, hideDone, selectedDevices, localDeviceId],
      );
      const groups = useMemo(() => buildGroups(filtered, todayDay), [filtered, todayDay]);
      const stats = useMemo(() => buildStats(snapshot, todos, todayDay), [snapshot, todos, todayDay]);
      const completed = useMemo(() => {
        let count = 0;
        for (const todo of todos) {
          if (todo !== null && typeof todo === 'object' && todo.done === true && todo.cancelled !== true) count += 1;
        }
        return count;
      }, [todos]);
      const shownGroups = groups.filter((group) => group.rows.length > 0);

      const boardSuggestions =
        snapshot !== null && Array.isArray(snapshot.suggestions) ? snapshot.suggestions : EMPTY;
      const suggestionPending = pendingSuggestions(boardSuggestions);

      const mode =
        snapshot !== null && typeof snapshot.mode === 'string'
          ? snapshot.mode
          : snapshot !== null && typeof snapshot.role === 'string'
            ? snapshot.role
            : '';
      const hub =
        snapshot !== null && snapshot.hub !== null && typeof snapshot.hub === 'object' ? snapshot.hub : null;
      const hubOffline = mode === 'device' && (hub === null || hub.connected !== true);
      const connection = snapshot !== null ? connectionStatus(snapshot, boardDevices, t) : null;
      const relay = snapshot !== null ? relayStatus(snapshot, t) : null;
      const defaultDeviceName =
        snapshot !== null &&
        snapshot.device !== null &&
        typeof snapshot.device === 'object' &&
        typeof snapshot.device.name === 'string'
          ? snapshot.device.name
          : '';

      const toggleSource = (id) => {
        setSelectedSources((previous) =>
          previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
        );
      };
      const clearSources = () => setSelectedSources(EMPTY);
      const toggleDevice = (id) => {
        setSelectedDevices((previous) =>
          previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
        );
      };
      const clearDevices = () => setSelectedDevices(EMPTY);
      const changeQuery = (value) => {
        setQuery(value);
        if (value.trim() !== '') setDoneExpanded(true);
      };
      const clearFilters = () => {
        setQuery('');
        setSelectedSources(EMPTY);
        setSelectedDevices(EMPTY);
      };
      const switchTab = (tab) => {
        setActiveTab(tab);
        if (tab === 'sources') setSourcesVisited(true);
      };
      const [suggestionBusy, setSuggestionBusy] = useState('');
      const [suggestionError, setSuggestionError] = useState(null);
      const changeSuggestion = async (id, action) => {
        if (typeof id !== 'string' || id === '') return;
        setSuggestionBusy(id);
        setSuggestionError(null);
        try {
          const body = await apiJson(action === 'accept' ? SUGGEST_ACCEPT_API : SUGGEST_DISMISS_API, { method: 'POST', body: { id } });
          if (!mounted.current) return;
          if (body.board !== null && typeof body.board === 'object') applyBoard(body.board);
          else refresh();
        } catch (error) {
          if (mounted.current) setSuggestionError(describeError(error));
        } finally {
          if (mounted.current) setSuggestionBusy('');
        }
      };
      const acceptSuggestion = (id) => { void changeSuggestion(id, 'accept'); };
      const dismissSuggestion = (id) => { void changeSuggestion(id, 'dismiss'); };

      // -- inline todo actions (v3) ----------------------------------------------
      const clearArmedDelete = () => {
        if (armedTimer.current !== null) {
          clearTimeout(armedTimer.current);
          armedTimer.current = null;
        }
        setArmedDeleteId(null);
      };
      const armDelete = (todo) => {
        if (todo === null || typeof todo !== 'object') return;
        if (armedTimer.current !== null) clearTimeout(armedTimer.current);
        setArmedDeleteId(todo.id);
        armedTimer.current = setTimeout(() => {
          armedTimer.current = null;
          setArmedDeleteId(null);
        }, 3000);
      };
      const runTodoAction = async (todo, action) => {
        if (pendingTodoId !== null) return;
        if (todo === null || typeof todo !== 'object' || typeof todo.id !== 'string' || todo.id === '') return;
        clearArmedDelete();
        setPendingTodoId(todo.id);
        setActionError(null);
        try {
          const response = await apiFetch(ACTION_API, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ action, id: todo.id }),
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok || body === null || typeof body !== 'object' || body.ok !== true) {
            const message =
              body !== null && typeof body === 'object' && typeof body.error === 'string' && body.error !== ''
                ? body.error
                : response.ok
                  ? t('actionFailed')
                  : 'HTTP ' + response.status;
            throw new Error(message);
          }
          if (!mounted.current) return;
          setPendingTodoId(null);
          setActionError(null);
          if (body.board !== null && typeof body.board === 'object') applyBoard(body.board);
          else refresh();
        } catch (actionFailure) {
          if (!mounted.current) return;
          setPendingTodoId(null);
          setActionError(describeError(actionFailure));
        }
      };

      let body;
      if (snapshot === null) {
        body = pending ? h(LoadingBlock, { t }) : h(OfflineBlock, { t, error, onRetry: retry });
      } else {
        body = h(
          'div',
          { className: 'ls-body' },
          mode === 'local'
            ? h(JoinCard, {
                t,
                defaultName: defaultDeviceName,
                onJoined: (board) => {
                  // The join response already carries a full board: apply it directly.
                  if (board !== null && board !== undefined && typeof board === 'object') applyBoard(board);
                  else refresh();
                },
              })
            : null,
          hubOffline ? h(HubOfflineBanner, { t, hub }) : null,
          stale !== null ? h(StaleBanner, { t, error: stale }) : null,
          h(StatsBar, { t, stats, completed }),
          h(
            'div',
            { className: 'ls-tabs', role: 'tablist', 'aria-label': t('tabAria') },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: 'ls-tab' + (activeTab === 'todos' ? ' ls-tab--active' : ''),
                'aria-selected': activeTab === 'todos' ? 'true' : 'false',
                title: t('tabTodos'),
                onClick: () => switchTab('todos'),
              },
              t('tabTodos'),
            ),
            h('button', { type: 'button', role: 'tab', className: 'ls-tab' + (activeTab === 'suggestions' ? ' ls-tab--active' : ''), 'aria-selected': activeTab === 'suggestions', onClick: () => switchTab('suggestions') }, '待确认', suggestionPending.length ? h('span', { className: 'ls-count' }, suggestionPending.length) : null),
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: 'ls-tab' + (activeTab === 'sources' ? ' ls-tab--active' : ''),
                'aria-selected': activeTab === 'sources' ? 'true' : 'false',
                title: t('tabSources'),
                onClick: () => switchTab('sources'),
              },
              t('tabSources'),
            ),
          ),
          activeTab === 'suggestions' ? h(SuggestionReview, { t, suggestions: boardSuggestions, pending: suggestionPending, busy: suggestionBusy, error: suggestionError, onAccept: acceptSuggestion, onDismiss: dismissSuggestion }) : null,
          activeTab === 'todos'
            ? h(
                'div',
                { className: 'ls-tabpanel', role: 'tabpanel', 'aria-label': t('tabTodos') },
                h(Toolbar, {
                  t,
                  query,
                  onQueryChange: changeQuery,
                  sources,
                  selectedSources,
                  onToggleSource: toggleSource,
                  onClearSources: clearSources,
                  hideDone,
                  onToggleHideDone: () => setHideDone((value) => !value),
                  devices: deviceOptions,
                  selectedDevices,
                  onToggleDevice: toggleDevice,
                  onClearDevices: clearDevices,
                }),
                actionError !== null
                  ? h(ActionErrorBanner, {
                      t,
                      error: actionError,
                      onClose: () => setActionError(null),
                    })
                  : null,
                error !== null ? h(ErrorBanner, { t, error, onRetry: refresh }) : null,
                todos.length === 0
                  ? h(EmptyBlock, { t })
                  : shownGroups.length === 0
                    ? h(FilteredEmpty, { t, onClear: clearFilters })
                    : h(
                        'div',
                        { className: 'ls-groups' },
                        shownGroups.map((group) =>
                          h(TodoGroup, {
                            key: group.id,
                            t,
                            group,
                            doneExpanded,
                            onToggleDone: () => setDoneExpanded((value) => !value),
                            todayDay,
                            devices: boardDevices,
                            showDevice: multiDevice,
                            localDeviceId,
                            pendingTodoId,
                            armedDeleteId,
                            onTodoAction: runTodoAction,
                            onTodoDeleteArm: armDelete,
                          }),
                        ),
                      ),
              )
            : null,
          sourcesVisited
            ? h(
                'div',
                {
                  className: 'ls-tabpanel' + (activeTab === 'sources' ? '' : ' ls-tabpanel--hidden'),
                  role: 'tabpanel',
                  'aria-label': t('sourcesSummary'),
                  'aria-hidden': activeTab === 'sources' ? 'false' : 'true',
                },
                h(ObsidianSourceCard, { t, applyBoard }),
              )
            : null,
          h(PageFooter, { t, snapshot }),
        );
      }

      return h(
        'section',
        { className: 'ls-page', 'aria-label': t('title') },
        h(PageHeader, {
          t,
          generatedAt: snapshot !== null ? snapshot.generatedAt : undefined,
          pending,
          onRefresh: refresh,
          status: connection,
          relay,
        }),
        body,
      );
    }


    /** One pending suggestion card: text, source, evidence and accept/dismiss. */
    function SuggestionItem({ t, item, busy, onAccept, onDismiss }) {
      const reasons = item !== null && typeof item === 'object' && Array.isArray(item.reasons) ? item.reasons : EMPTY;
      const source = suggestionSourceLabel(item, t);
      const id = item !== null && typeof item === 'object' && typeof item.id === 'string' ? item.id : '';
      return h(
        'article',
        { className: 'ls-sug' },
        h(
          'div',
          { className: 'ls-sug__head' },
          h(
            'span',
            { className: 'ls-sug__icon', 'aria-hidden': 'true' },
            h(
              'svg',
              { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
              h('path', {
                d: 'M8 1.8a4.3 4.3 0 0 1 2.6 7.7c-.5.4-.8 1-.8 1.6H6.2c0-.6-.3-1.2-.8-1.6A4.3 4.3 0 0 1 8 1.8z',
                stroke: 'currentColor',
                strokeWidth: 1.3,
                strokeLinejoin: 'round',
              }),
              h('path', {
                d: 'M6.5 13h3M7.2 14.5h1.6',
                stroke: 'currentColor',
                strokeWidth: 1.2,
                strokeLinecap: 'round',
              }),
            ),
          ),
          h('span', { className: 'ls-sug__tag' }, t('suggestionTag')),
          source !== '' ? h('span', { className: 'ls-sug__source' }, source) : null,
        ),
        h('div', { className: 'ls-sug__text' }, item !== null && typeof item.text === 'string' ? item.text : ''),
        item?.origin ? h('details', { className: 'ls-sug__meta' },
          h('summary', null, t('intakeEvidence')),
          h('div', null, [item.origin.deviceName, item.origin.relPath || item.origin.file, item.origin.line ? ':' + item.origin.line : '', item.sessionTitle || item.sessionId].filter(Boolean).join(' ')),
          item.origin.heading ? h('div', null, item.origin.heading) : null,
          item.origin.evidence?.quote ? h('blockquote', null, item.origin.evidence.quote) : null,
          h('div', null, t('intakeOwner')),
        ) : null,
        reasons.length > 0
          ? h('div', { className: 'ls-sug__reasons' }, reasons.slice(0, 3).map((reason, index) =>
              h('span', { key: 'reason-' + index, className: 'ls-sug__reason' }, String(reason)),
            ))
          : null,
        h('div', { className: 'ls-sug__actions' },
          h('button', { type: 'button', className: 'ls-btn ls-btn--small ls-btn--primary', disabled: id === '' || busy, onClick: () => onAccept(id) }, t('suggestionAccept')),
          h('button', { type: 'button', className: 'ls-btn ls-btn--small', disabled: id === '' || busy, onClick: () => onDismiss(id) }, t('suggestionDismiss')),
        ),
      );
    }

    /** Pending-suggestion review that lives on the board (no Yuan panel needed). */
    function SuggestionReview({ t, suggestions, pending, busy, error, onAccept, onDismiss }) {
      const [limit, setLimit] = useState(20);
      const list = pending !== undefined ? pending : pendingSuggestions(suggestions);
      return h('div', { className: 'ls-review' },
        h('p', { className: 'ls-sug__hint' }, t('intakeHint')),
        error !== null && error !== undefined ? h('p', { className: 'ls-sug__error', role: 'alert' }, String(error)) : null,
        list.length === 0 ? h('p', { className: 'ls-sug__empty' }, t('intakeEmpty')) : null,
        list.slice(0, limit).map((item) => h(SuggestionItem, { key: item.id, t, item, busy: busy === item.id, onAccept, onDismiss })),
        list.length > limit ? h('button', { type: 'button', className: 'ls-btn ls-btn--small', onClick: () => setLimit(limit + 20) }, t('intakeMore')) : null);
    }

    function LeoIcon(props) {
      const safeProps = props !== null && typeof props === 'object' ? props : {};
      const size = typeof safeProps.size === 'number' && safeProps.size > 0 ? safeProps.size : 16;
      const color = safeProps.active === true ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h(
        'svg',
        {
          className: 'ls-icon',
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M6.2 3.6h7.1M6.2 8h7.1M6.2 12.4h7.1',
          stroke: color,
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M2.1 3.2l1.1 1.1 1.7-1.9',
          stroke: color,
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M2.1 7.6l1.1 1.1 1.7-1.9',
          stroke: color,
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('rect', {
          x: 1.9,
          y: 10.7,
          width: 2.1,
          height: 2.1,
          rx: 0.6,
          stroke: color,
          strokeWidth: 1.2,
        }),
      );
    }


    const zh = {
      nav: "待办",
      title: "Leo 状态",
      subtitle: "待办 · 笔记与已确认事项",
      refresh: "刷新",
      refreshing: "刷新中…",
      refreshHint: "重新扫描磁盘上的笔记与会话",
      lastScan: "最后扫描",
      statOpen: "未完成",
      statOverdue: "逾期",
      statToday: "今天",
      statSoon: "未来 7 天",
      statDone: "已完成",
      searchPlaceholder: "搜索待办…",
      searchLabel: "搜索待办（匹配文本、标题或标签）",
      clearSearch: "清除搜索",
      allSources: "全部",
      filterBySource: "按来源筛选",
      hideDone: "隐藏已完成",
      groupOverdue: "逾期",
      groupToday: "今天",
      groupSoon: "未来 7 天",
      groupLater: "以后",
      groupUndated: "无日期",
      groupDone: "已完成",
      expandDone: "展开已完成",
      collapseDone: "收起已完成",
      cancelled: "作废",
      staleWarning: "数据可能已过期",
      loading: "正在读取待办…",
      emptyTitle: "还没有待办",
      emptyBefore: "在 Obsidian 笔记里写 ",
      emptyCode: "- [ ] 任务",
      emptyAfter: "，刷新后自动显示；会话中提取的事项需要先在「待确认建议」中接受。",
      filteredEmptyTitle: "没有匹配的待办",
      filteredEmptyBody: "换个关键词，或放宽来源筛选。",
      clearFilters: "清除筛选",
      offlineTitle: "无法连接到宿主",
      offlineBody: "没有拿到待办数据。请确认 leo-status 宿主端插件已启用，然后重试。",
      retry: "重试",
      untitled: "（无文本）",
      sessionFallback: "DSH 会话",
      due: "截止",
      overdue: "逾期",
      today: "今天",
      dayUnit: "天",
      priority: "优先级",
      priorityHighest: "最高",
      priorityHigh: "高",
      priorityMedium: "中",
      priorityLow: "低",
      priorityLowest: "最低",
      took: "扫描耗时",
      files: "文件",
      sources: "来源",
      sourceErrors: "来源错误",
      loadFailed: "读取失败",
      deviceLocal: "本机",
      allDevices: "全部设备",
      devicesUnit: "台设备",
      devicesLabel: "设备",
      device: "设备",
      filterByDevice: "按设备筛选",
      online: "在线",
      offline: "离线",
      hubStatus: "中心",
      deviceConnected: "已连接中心",
      deviceOffline: "中心离线",
      hubOfflineTitle: "中心不可达，显示本机缓存",
      lastSync: "最后同步",
      relayStarting: "中转连接中…",
      relayRunning: "中转正常",
      relayStopped: "中转断开",
      relayDisabled: "未启用中转",
      joinTitle: "加入 leo-status 中心",
      joinIntro: "填写中心地址与密码，把这台设备的待办同步到中心看板。",
      joinHubUrl: "中心地址",
      joinPassword: "密码",
      joinName: "本机名称",
      joinRootLabel: "笔记目录（可选）",
      joinRootPlaceholder: "例如：C:\\notes",
      joinSubmit: "加入中心",
      joinSubmitting: "加入中…",
      joinFailed: "加入失败",
      actionCancel: "作废",
      actionRestore: "启用",
      actionDelete: "删除",
      actionDeleteConfirm: "再点一次确认删除",
      actionFailed: "操作失败",
      actionPending: "处理中…",
      actionDismiss: "关闭",
      checkDone: "标记完成",
      checkUndone: "标记未完成",
      intakeEvidence: "查看来源与依据",
      intakeOwner: "执行人：Leo · Accept 只加入看板，不修改来源笔记",
      intakeHint: "会话和其他候选事项需确认后接受；忽略后不会反复出现。Obsidian 库任务自动进入看板。",
      intakeMore: "显示更多建议",
      suggestionSourceSession: "来自会话",
      suggestionSourceNote: "来自笔记",
      suggestionAccept: "接受",
      suggestionDismiss: "忽略",
      suggestionTag: "建议",
      obsidianCardTitle: "数据源 · Obsidian 自动发现",
      obsidianCardHint: "Obsidian 库的任务自动进入看板。扫描不会修改笔记；看板操作可写回本机笔记。",
      obsidianAutoDetect: "自动发现",
      obsidianAutoDetectOn: "已开启",
      obsidianAutoDetectOff: "已关闭",
      obsidianAutoDetectHint: "在桌面/文档等目录自动探测含 .obsidian 的库（roots 为空时生效）",
      obsidianVaults: "检测到的库",
      obsidianVaultsEmpty: "没找到含 .obsidian 的库，可在 settings.json 手动添加 markdownRoots",
      obsidianAttach: "接入",
      obsidianAttached: "已接入",
      obsidianRoots: "已接入目录",
      obsidianRootsEmpty: "还没有接入任何笔记目录",
      obsidianRemove: "移除",
      obsidianRules: "识别规则",
      obsidianRuleCheckbox: "复选框",
      obsidianRuleCheckboxHint: "识别 - [ ] / - [x] 任务行（始终启用）",
      obsidianRuleTag: "#todo 标签行",
      obsidianRuleTagHint: "识别含 #todo / #task / #待办 的行",
      obsidianRuleMarker: "TODO: 标记",
      obsidianRuleMarkerHint: "识别行内 TODO: / 待办：标记",
      obsidianRuleFrontmatter: "frontmatter todo",
      obsidianRuleFrontmatterHint: "frontmatter 含 todo:true 或 status:todo",
      obsidianRuleFrontmatterList: "frontmatter 列表",
      obsidianRuleFrontmatterListHint: "frontmatter 的 todos: 列表项",
      obsidianReadonly: "只读",
      obsidianRescan: "重新扫描",
      obsidianRescanning: "扫描中…",
      obsidianLoading: "正在读取数据源…",
      obsidianError: "数据源操作失败",
      obsidianRetry: "重试",
      obsidianNotes: "条笔记",
      obsidianSaved: "已保存",
      tabTodos: "待办",
      tabSources: "数据源",
      tabAria: "看板视图切换",
      sourcesSummary: "数据源与自动识别设置",
      intakeEmpty: "没有待确认建议",
    };

    const en = {
      nav: "Todos",
      title: "Leo Status",
      subtitle: "Todos · track after accepting",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      refreshHint: "Rescan notes and sessions on disk",
      lastScan: "Last scan",
      statOpen: "Open",
      statOverdue: "Overdue",
      statToday: "Today",
      statSoon: "Next 7 days",
      statDone: "Completed",
      searchPlaceholder: "Search todos…",
      searchLabel: "Search todos (matches text, headings or tags)",
      clearSearch: "Clear search",
      allSources: "All",
      filterBySource: "Filter by source",
      hideDone: "Hide completed",
      groupOverdue: "Overdue",
      groupToday: "Today",
      groupSoon: "Next 7 days",
      groupLater: "Later",
      groupUndated: "No date",
      groupDone: "Completed",
      expandDone: "Expand completed",
      collapseDone: "Collapse completed",
      cancelled: "Cancelled",
      staleWarning: "Data may be stale",
      loading: "Loading todos…",
      emptyTitle: "No todos yet",
      emptyBefore: "Write ",
      emptyCode: "- [ ] a task",
      emptyAfter: " in an Obsidian note and refresh to see it here. Session suggestions must be accepted first.",
      filteredEmptyTitle: "No matching todos",
      filteredEmptyBody: "Try another keyword or loosen the source filter.",
      clearFilters: "Clear filters",
      offlineTitle: "Cannot reach the host",
      offlineBody: "No todo data was returned. Make sure the leo-status host plugin is enabled, then retry.",
      retry: "Retry",
      untitled: "(no text)",
      sessionFallback: "DSH session",
      due: "Due",
      overdue: "Overdue",
      today: "Today",
      dayUnit: "days",
      priority: "Priority",
      priorityHighest: "Highest",
      priorityHigh: "High",
      priorityMedium: "Medium",
      priorityLow: "Low",
      priorityLowest: "Lowest",
      took: "Scan time",
      files: "Files",
      sources: "Sources",
      sourceErrors: "Source errors",
      loadFailed: "Failed to load",
      deviceLocal: "This device",
      allDevices: "All devices",
      devicesUnit: "devices",
      devicesLabel: "Devices",
      device: "Device",
      filterByDevice: "Filter by device",
      online: "Online",
      offline: "Offline",
      hubStatus: "Hub",
      deviceConnected: "Connected to hub",
      deviceOffline: "Hub offline",
      hubOfflineTitle: "Hub unreachable, showing local cache",
      lastSync: "Last sync",
      relayStarting: "Relay connecting…",
      relayRunning: "Relay online",
      relayStopped: "Relay offline",
      relayDisabled: "Relay disabled",
      joinTitle: "Join a leo-status hub",
      joinIntro: "Enter the hub URL and password to sync this device to the shared board.",
      joinHubUrl: "Hub URL",
      joinPassword: "Password",
      joinName: "Device name",
      joinRootLabel: "Notes folder (optional)",
      joinRootPlaceholder: "e.g. C:\\notes",
      joinSubmit: "Join hub",
      joinSubmitting: "Joining…",
      joinFailed: "Join failed",
      actionCancel: "Cancel",
      actionRestore: "Restore",
      actionDelete: "Delete",
      actionDeleteConfirm: "Click again to confirm deletion",
      actionFailed: "Action failed",
      actionPending: "Working…",
      actionDismiss: "Dismiss",
      checkDone: "Mark done",
      checkUndone: "Mark undone",
      intakeEvidence: "View source and evidence",
      intakeOwner: "Owner: Leo · Accept adds to the board without editing source notes",
      intakeHint: "Review session and other suggestions before accepting. Obsidian vault tasks enter the board automatically.",
      intakeMore: "Show more suggestions",
      suggestionSourceSession: "From a session",
      suggestionSourceNote: "From a note",
      suggestionAccept: "Accept",
      suggestionDismiss: "Dismiss",
      suggestionTag: "Suggestion",
      obsidianCardTitle: "Data sources · Obsidian auto-detect",
      obsidianCardHint: "Obsidian vault tasks enter the board automatically. Scanning does not edit notes; board actions can update local notes.",
      obsidianAutoDetect: "Auto-detect",
      obsidianAutoDetectOn: "On",
      obsidianAutoDetectOff: "Off",
      obsidianAutoDetectHint: "Scan common folders for vaults containing .obsidian (when roots are empty)",
      obsidianVaults: "Detected vaults",
      obsidianVaultsEmpty: "No vaults with .obsidian found; add markdownRoots in settings.json manually",
      obsidianAttach: "Attach",
      obsidianAttached: "Attached",
      obsidianRoots: "Attached folders",
      obsidianRootsEmpty: "No folders attached yet",
      obsidianRemove: "Remove",
      obsidianRules: "Parsing rules",
      obsidianRuleCheckbox: "Checkboxes",
      obsidianRuleCheckboxHint: "Detect - [ ] / - [x] task lines (always on)",
      obsidianRuleTag: "#todo tag lines",
      obsidianRuleTagHint: "Detect lines containing #todo / #task or the configured tags",
      obsidianRuleMarker: "TODO: markers",
      obsidianRuleMarkerHint: "Detect inline TODO: / reminder markers",
      obsidianRuleFrontmatter: "frontmatter todo",
      obsidianRuleFrontmatterHint: "frontmatter with todo:true or status:todo",
      obsidianRuleFrontmatterList: "frontmatter list",
      obsidianRuleFrontmatterListHint: "Items in the frontmatter todos: list",
      obsidianReadonly: "Read-only",
      obsidianRescan: "Rescan",
      obsidianRescanning: "Scanning…",
      obsidianLoading: "Reading data sources…",
      obsidianError: "Data source action failed",
      obsidianRetry: "Retry",
      obsidianNotes: "notes",
      obsidianSaved: "Saved",
      tabTodos: "Todos",
      tabSources: "Data sources",
      tabAria: "Board view tabs",
      sourcesSummary: "Data sources and auto-detect settings",
      intakeEmpty: "No pending suggestions",
    };

    const CSS = `
.ls-page{box-sizing:border-box;height:100%;overflow-y:auto;padding:24px 32px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}
.ls-page *{box-sizing:border-box}
.ls-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.ls-title{font-size:18px;font-weight:600;line-height:1.35;margin:0;color:var(--dsw-alias-label-primary)}
.ls-subtitle{margin:4px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.ls-head__meta{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.ls-stamp{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.ls-conn{display:inline-flex;align-items:center;gap:6px;max-width:280px;font-size:12px;line-height:24px;padding:0 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-conn__dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.ls-conn__text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.ls-conn--hub .ls-conn__dot{background:var(--dsw-alias-brand-primary)}
.ls-conn--online .ls-conn__dot{background:var(--dsw-alias-state-success-primary)}
.ls-conn--offline{color:var(--dsw-alias-state-error-primary)}
.ls-conn--offline .ls-conn__dot{background:var(--dsw-alias-state-error-primary)}
.ls-refresh{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;line-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.ls-refresh:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-refresh:disabled{opacity:.6;cursor:default}
.ls-refresh:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.ls-refresh__icon{display:block;flex:none}
.ls-refresh--busy .ls-refresh__icon{animation:ls-spin .9s linear infinite}
.ls-stats{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.ls-stat{flex:1 1 140px;min-width:110px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.ls-stat__num{font-size:22px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}
.ls-stat__label{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-stat--alert .ls-stat__num{color:var(--dsw-alias-state-error-primary)}
.ls-stat--warn .ls-stat__num{color:var(--dsw-alias-state-warn-primary)}
.ls-toolbar{display:flex;flex-direction:column;gap:8px;padding:10px 12px;margin-bottom:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.ls-toolbar__row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;min-width:0}
.ls-filter__label{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ls-search{display:flex;align-items:center;gap:6px;flex:1 1 220px;min-width:180px}
.ls-search__icon{flex:none;color:var(--dsw-alias-label-tertiary)}
.ls-search__input{flex:1 1 auto;min-width:0;height:30px;padding:0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);outline:none}
.ls-search__input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ls-search__input:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px;border-color:transparent}
.ls-search__input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.ls-search__clear{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;flex:none}
.ls-search__clear:hover{color:var(--dsw-alias-label-primary)}
.ls-search__clear:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.ls-chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;line-height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.ls-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-chip[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.ls-chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-chip__count{font-size:11px;opacity:.75;font-variant-numeric:tabular-nums}
.ls-chip__err{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:none}
.ls-chip--error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1))}
.ls-chip__dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.ls-chip__dot--online{background:var(--dsw-alias-state-success-primary)}
.ls-chip__dot--offline{background:var(--dsw-alias-label-tertiary)}
.ls-switch{display:inline-flex;align-items:center;gap:8px;margin-left:auto;padding:0;border:none;background:none;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.ls-switch:hover{color:var(--dsw-alias-label-primary)}
.ls-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:3px;border-radius:999px}
.ls-switch__track{position:relative;display:inline-block;width:34px;height:20px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);transition:background .15s ease;flex:none}
.ls-switch[aria-checked="true"] .ls-switch__track{background:var(--dsw-alias-brand-primary)}
.ls-switch__knob{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform .15s ease}
.ls-switch[aria-checked="true"] .ls-switch__knob{transform:translateX(14px)}
.ls-groups{display:flex;flex-direction:column;gap:18px}
.ls-group__head{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ls-group__title{font:inherit}
.ls-group__toggle{display:inline-flex;align-items:center;gap:6px;padding:0;border:none;background:none;font:inherit;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:var(--dsw-radius-sm)}
.ls-group__toggle:hover{color:var(--dsw-alias-label-primary)}
.ls-group__toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.ls-group__chevron{flex:none;transition:transform .15s ease}
.ls-group__toggle[aria-expanded="true"] .ls-group__chevron{transform:rotate(90deg)}
.ls-group__count{display:inline-block;min-width:20px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
.ls-group__rows{list-style:none;margin:0;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ls-row{display:flex;align-items:center;gap:8px;min-height:36px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.ls-row:first-child{border-top:none}
.ls-row:hover{background:var(--dsw-alias-bg-layer-2)}
.ls-check{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;color:var(--dsw-alias-label-tertiary)}
.ls-check--done{color:var(--dsw-alias-state-success-primary)}
.ls-check--cancelled{color:var(--dsw-alias-label-secondary)}
.ls-check-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}
.ls-check-btn:hover:not(:disabled){color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.ls-check-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-check-btn:disabled{opacity:.5;cursor:default}
.ls-check-btn--done{color:var(--dsw-alias-state-success-primary)}
.ls-row__text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-row--done .ls-row__text{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.ls-tags{display:inline-flex;align-items:center;gap:4px;flex:none;max-width:220px;overflow:hidden}
.ls-tag{display:inline-block;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.ls-tag--more{color:var(--dsw-alias-label-secondary)}
.ls-cancel{flex:none;font-size:11px;line-height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-due{flex:none;font-size:11px;line-height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.ls-due--overdue{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.ls-due--today{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.ls-due--done{opacity:.8}
.ls-pri{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.ls-pri--highest{background:var(--dsw-alias-state-error-primary)}
.ls-pri--high{background:var(--dsw-alias-state-warn-primary)}
.ls-pri--medium{background:var(--dsw-alias-brand-primary)}
.ls-pri--low{background:var(--dsw-alias-label-tertiary)}
.ls-pri--lowest{background:var(--dsw-alias-border-l2)}
.ls-badge{flex:none;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ls-badge--dsh{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.ls-device-badge{flex:none;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary)}
.ls-acts{display:inline-flex;align-items:center;gap:2px;flex:none}
.ls-act{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}
.ls-act:hover:not(:disabled){color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.ls-act:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-act:disabled{opacity:.5;cursor:default}
.ls-act--armed{color:var(--dsw-alias-state-error-primary)}
.ls-act--armed:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.ls-empty{max-width:720px;margin:8px 0;padding:28px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7;text-align:center}
.ls-empty__title{margin:0 0 6px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-empty__body{margin:0}
.ls-empty__detail{margin:10px 0 0;font-size:12px;word-break:break-word}
.ls-empty code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;padding:1px 5px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-btn{display:inline-flex;align-items:center;justify-content:center;margin-top:14px;font:inherit;font-size:13px;line-height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ls-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.ls-btn--small{margin-top:0;font-size:12px;line-height:24px;padding:0 10px;flex:none}
.ls-loading{display:flex;flex-direction:column;gap:14px;max-width:760px}
.ls-loading__text{font-size:13px;color:var(--dsw-alias-label-secondary)}
.ls-skeleton{display:flex;flex-direction:column;gap:8px}
.ls-skel{height:36px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-skeleton);animation:ls-pulse 1.4s ease-in-out infinite}
.ls-skel:nth-child(2){animation-delay:.16s}
.ls-skel:nth-child(3){animation-delay:.32s}
.ls-skel:nth-child(4){animation-delay:.48s}
.ls-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;padding:8px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px}
.ls-banner__text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-banner--warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);color:var(--dsw-alias-state-warn-primary)}
.ls-banner__main{display:flex;flex-direction:column;gap:2px;min-width:0}
.ls-banner__title{font-weight:600}
.ls-banner__detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-banner__meta{font-size:11px;opacity:.85;white-space:nowrap}
.ls-banner__close{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:999px;background:transparent;color:currentColor;font-size:14px;line-height:1;cursor:pointer;flex:none;opacity:.75}
.ls-banner__close:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}
.ls-banner__close:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-join{margin-bottom:16px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.ls-join__title{margin:0 0 4px;font-size:15px;font-weight:600}
.ls-join__intro{margin:0 0 12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-join__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 12px}
.ls-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.ls-field__label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-input{width:100%;height:30px;padding:0 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);outline:none}
.ls-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ls-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px;border-color:transparent}
.ls-join__actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:12px}
.ls-join__error{min-width:0;font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.ls-btn--primary{margin-top:0;border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.ls-btn--primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);opacity:.9}
.ls-btn--primary:disabled{opacity:.5;cursor:default}
.ls-foot{margin-top:20px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-foot__line{display:flex;flex-wrap:wrap;gap:14px}
.ls-foot__errors{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.ls-foot__error{color:var(--dsw-alias-state-warn-primary);word-break:break-word}
.ls-obs-card{margin-bottom:16px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.ls-obs-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}
.ls-obs-head__main{min-width:0;display:flex;flex-direction:column;gap:2px}
.ls-obs-title{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:600}
.ls-obs-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--dsw-radius-xs);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);flex:none}
.ls-obs-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-obs-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ls-obs-section{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px}
.ls-obs-section__title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ls-obs-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.ls-obs-row__main{min-width:0;flex:1 1 220px;display:flex;flex-direction:column;gap:1px}
.ls-obs-name{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-obs-path{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-obs-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-obs-badge{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-obs-badge--ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.ls-obs-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ls-obs-error{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.ls-obs-notice{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.ls-obs-rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 14px}
.ls-obs-rule{display:flex;align-items:flex-start;gap:8px;min-width:0}
.ls-obs-rule__main{min-width:0;display:flex;flex-direction:column;gap:1px}
.ls-obs-rule__label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
.ls-obs-rule__hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-obs-toggle{position:relative;display:inline-flex;align-items:center;width:34px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-state-idle-primary);cursor:pointer;flex:none;margin-top:1px}
.ls-obs-toggle[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.ls-obs-toggle:disabled{opacity:.5;cursor:default}
.ls-obs-toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.ls-obs-toggle__knob{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform .15s ease}
.ls-obs-toggle[aria-checked="true"] .ls-obs-toggle__knob{transform:translateX(14px)}
.ls-obs-checkbox{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-state-success-primary);flex:none}
.ls-obs-readonly{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none;margin-top:2px}
.ls-obs-btn{display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:12px;line-height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.ls-obs-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-obs-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-obs-btn:disabled{opacity:.5;cursor:default}
.ls-obs-btn--primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.ls-obs-btn--primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);opacity:.9}
@media (max-width:720px){.ls-obs-rules{grid-template-columns:1fr}}
.ls-tabs{display:inline-flex;align-items:center;align-self:flex-start;gap:2px;margin-bottom:14px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.ls-tab{font:inherit;font-size:12px;line-height:24px;padding:0 14px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ls-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-tab--active{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);font-weight:600}
.ls-tab:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-tabpanel--hidden{display:none}
@keyframes ls-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes ls-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (max-width:720px){.ls-page{padding:20px 16px}.ls-stat{flex-basis:calc(50% - 5px)}.ls-badge{max-width:110px}.ls-tags{display:none}.ls-switch{margin-left:0}.ls-conn{max-width:200px}.ls-device-badge{max-width:90px}.ls-join__grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.ls-refresh--busy .ls-refresh__icon{animation:none}.ls-skel{animation:none}}
.ls-count{display:inline-block;margin-left:6px;min-width:18px;padding:0 5px;background:var(--dsw-alias-bg-layer-2);border-radius:10px;font-size:11px}
.ls-page{padding:28px clamp(16px,3vw,44px)}
.ls-head,.ls-body{max-width:1120px;margin-left:auto;margin-right:auto}
.ls-head{align-items:center;margin-bottom:26px}
.ls-title{font-size:22px;letter-spacing:-.4px}
.ls-head__meta{gap:8px}
.ls-head .ls-stamp,.ls-head .ls-conn--running{display:none}
.ls-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;padding:14px 0;margin-bottom:24px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.ls-stat{min-width:0;padding:2px 16px;border:0;border-right:1px solid var(--dsw-alias-border-l1);border-radius:0;background:transparent}
.ls-stat:first-child{padding-left:0}.ls-stat:last-child{border:0}
.ls-stat__num{font-size:24px;font-weight:500}.ls-stat__label{font-size:12px;margin-top:6px}
.ls-tabs{gap:6px;margin-bottom:18px;background:transparent;border:0;padding:0}
.ls-tab{padding:7px 13px;border-radius:8px}
.ls-toolbar{padding:0 0 14px;border:0;background:transparent;border-radius:0;gap:12px}
.ls-search__input{height:36px;border-radius:8px}
.ls-filter-details{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-filter-details summary{cursor:pointer;list-style-position:inside;margin-bottom:8px}
.ls-filter-details .ls-toolbar__row{margin-top:8px}
.ls-review .ls-sug{margin-bottom:10px}
@media(max-width:640px){.ls-page{padding:20px 16px}.ls-head{gap:12px;margin-bottom:20px}.ls-title{font-size:20px}.ls-head__meta{justify-content:flex-start}.ls-head .ls-conn{font-size:11px;padding:0 4px}.ls-stat{padding:0 8px}.ls-stat__num{font-size:20px}.ls-stat__label{font-size:11px}}

.ls-review{display:flex;flex-direction:column;gap:10px;margin-top:4px}
.ls-sug{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.ls-sug__head{display:flex;align-items:center;gap:6px;min-width:0}
.ls-sug__icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--dsw-radius-xs);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);flex:none}
.ls-sug__tag{font-size:10px;font-weight:600;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-sug__source{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ls-sug__text{font-size:13px;word-break:break-word}
.ls-sug__meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ls-sug__reasons{display:flex;flex-wrap:wrap;gap:4px}
.ls-sug__reason{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.ls-sug__actions{display:flex;flex-wrap:wrap;gap:6px}
.ls-sug__hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);margin:6px 0 2px}
.ls-sug__empty{padding:30px 8px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.ls-sug__error{font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
`;

    /** Idempotent stylesheet install/remove keyed by a plugin CSS id. */
    function insertStyle(tagId, css) {
      const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']';
      const existing = document.querySelector(selector);
      if (existing === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'leo-status';
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
      return () => {
        const tag = document.querySelector(selector);
        if (tag !== null) tag.remove();
      };
    }

    // -- plugin apply -----------------------------------------------------------

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'leo-status: dictionaries');
      boundT = ctx.locale.bind(NS);

      ctx.effect(() => insertStyle('leo-status/client.css', CSS), 'leo-status: client styles');

      // The sidebar nav row: id must equal the "main" key so the shell can select it.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => boundT('nav'), locale: NS },
              LeoIcon,
            ),
          ),
        'leo-status: sidebar entry',
      );

      // The full page mounted when the nav row is selected.
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, DashboardPage),
          ),
        'leo-status: dashboard page',
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };

  },
});