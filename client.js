/**
 * leo-status - client half for the DSH Web UI.
 *
 * A sidebar nav entry (inline SVG checklist glyph) plus a full-page read-only
 * dashboard. The dashboard fetches the host snapshot, groups todos by due date
 * and renders them with search, source chips and a completed filter.
 *
 * Plain browser module: no build, no JSX, no third-party packages. React is
 * obtained from the module loader (`require('react')`). Styling uses a single
 * injected <style> tag whose classes are prefixed `ls-`; only DSH theme tokens
 * are used for colors/radii/focus rings.
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
    /** Cordis client Context captured in apply(); components use host services through it. */
    let clientContext = null;

    /** Resolve a host client service defensively (null when unavailable). */
    function clientService(name) {
      try {
        if (clientContext === null || typeof clientContext.get !== 'function') return null;
        const service = clientContext.get(name);
        return service === undefined ? null : service;
      } catch {
        return null;
      }
    }

    /**
     * 页面 token（Host 注入到 index HTML 的 window.__LEO_STATUS_PAGE_TOKEN__）。
     * DSH 的 cookie 鉴权在部分窗口/重启后会 401，token 让插件 API 不依赖 cookie；
     * cookie 仍是 Host 侧的回退，两边任一通过即可。
     */
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
      // DSH may be mounted below /d/<device>/ (device center) or another proxy
      // prefix. Root-absolute URLs escape that mount and can hit an unrelated
      // hub on the same origin. Resolve plugin routes relative to the DSH page,
      // just like the host's own client transport.
      let target = url;
      if (typeof url === 'string' && url.startsWith('/leo-status/')) {
        target = url.slice(1);
        // The device tunnel drops custom headers but preserves the query.
        if (token !== '') {
          const separator = target.includes('?') ? '&' : '?';
          target += separator + '_leo_status_token=' + encodeURIComponent(token);
        }
      }
      return fetch(target, options);
    }

    /** JSON request against the host API; rejects on HTTP/`ok:false` with the host message. */
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

    // -- yuan (阿源) endpoints and helpers ---------------------------------------

    const YUAN_STATE_API = '/leo-status/api/yuan/state';
    const YUAN_SIGNALS_API = '/leo-status/api/yuan/signals';
    const YUAN_CHAT_API = '/leo-status/api/yuan/chat';
    const YUAN_ACCEPT_API = '/leo-status/api/yuan/suggestion/accept';
    const YUAN_DISMISS_API = '/leo-status/api/yuan/suggestion/dismiss';
    const YUAN_REMEMBER_API = '/leo-status/api/yuan/remember';
    const YUAN_MEMORY_DELETE_API = '/leo-status/api/yuan/memory/delete';
    const YUAN_MEMORY_ACCEPT_API = '/leo-status/api/yuan/memory/accept';
    const YUAN_REMINDER_API = '/leo-status/api/yuan/reminder';
    const YUAN_REMINDER_DONE_API = '/leo-status/api/yuan/reminder/done';
    const YUAN_SEEN_API = '/leo-status/api/yuan/seen';

    /** Translator for slot components registered with `locale: NS`. */
    function translatorFor(props) {
      return props !== null && typeof props === 'object' && typeof props.t === 'function' ? props.t : boundT;
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

    function yuanSignalCounts(state) {
      const counts = { suggestion: 0, reminder: 0, deadline: 0 };
      const signals = state !== null && typeof state === 'object' && Array.isArray(state.signals) ? state.signals : EMPTY;
      for (const signal of signals) {
        if (signal === null || typeof signal !== 'object') continue;
        const kind = typeof signal.kind === 'string' ? signal.kind : '';
        const count = typeof signal.count === 'number' && Number.isFinite(signal.count) ? signal.count : 1;
        if (Object.prototype.hasOwnProperty.call(counts, kind)) counts[kind] += count;
      }
      return counts;
    }

    function yuanSeverity(state) {
      const signals = state !== null && typeof state === 'object' && Array.isArray(state.signals) ? state.signals : EMPTY;
      let severity = null;
      for (const signal of signals) {
        if (signal === null || typeof signal !== 'object') continue;
        if (signal.kind === 'suggestion' && signal.isNew === false) continue;
        if (signal.severity === 'urgent') return 'urgent';
        if (signal.severity === 'warn') severity = 'warn';
        else if (signal.severity === 'info' && severity === null) severity = 'info';
      }
      if (severity !== null) return severity;
      const badge = state !== null && typeof state === 'object' ? state.badge : null;
      if (badge !== null && typeof badge === 'object') {
        if (toCount(badge.urgent) > 0) return 'urgent';
        if (badge.hasUnread === true) return 'info';
      }
      return null;
    }

    function normalizeYuanState(body) {
      const source = body !== null && typeof body === 'object' ? body : {};
      return {
        name: typeof source.name === 'string' ? source.name : '',
        suggestions: Array.isArray(source.suggestions) ? source.suggestions : [],
        signals: Array.isArray(source.signals) ? source.signals : [],
        badge: source.badge !== undefined ? source.badge : null,
        unread: source.unread !== undefined ? source.unread : null,
        chat: Array.isArray(source.chat) ? source.chat : [],
        memory: Array.isArray(source.memory) ? source.memory : [],
        reminders: Array.isArray(source.reminders) ? source.reminders : [],
        model: source.model !== undefined ? source.model : null,
        agent: source.agent !== undefined ? source.agent : null,
        sessions: Array.isArray(source.sessions) ? source.sessions : [],
        context: source.context || null,
        contextSessionId: source.contextSessionId || source.agent?.sessionId || null,
      };
    }

    function yuanMessageRole(message) {
      return message !== null && typeof message === 'object' && message.role === 'assistant' ? 'assistant' : 'user';
    }

    function yuanMessageText(message) {
      if (message === null || typeof message !== 'object') return '';
      if (typeof message.text === 'string') return message.text;
      if (typeof message.reply === 'string') return message.reply;
      return '';
    }

    function yuanProposalList(proposals) {
      if (Array.isArray(proposals)) {
        return proposals
          .map((item) => (typeof item === 'string' ? { kind: 'todo', text: item } : item))
          .filter((item) => item !== null && typeof item === 'object');
      }
      if (proposals !== null && typeof proposals === 'object') {
        const list = [];
        for (const text of Array.isArray(proposals.todos) ? proposals.todos : EMPTY) {
          if (typeof text === 'string' && text !== '') list.push({ kind: 'todo', text });
        }
        for (const text of Array.isArray(proposals.memories) ? proposals.memories : EMPTY) {
          if (typeof text === 'string' && text !== '') list.push({ kind: 'memory', text });
        }
        for (const item of Array.isArray(proposals.reminders) ? proposals.reminders : EMPTY) {
          if (item !== null && typeof item === 'object' && typeof item.text === 'string') {
            list.push({ kind: 'reminder', text: item.text });
          }
        }
        return list;
      }
      return EMPTY;
    }

    /** Tool calls captured on one assistant message (v0.4.3). */
    function yuanToolList(message) {
      if (message === null || typeof message !== 'object' || !Array.isArray(message.tools)) return EMPTY;
      return message.tools.filter((tool) => tool !== null && typeof tool === 'object');
    }

    /** Hydrate the last assistant chat entry with the tools of a fresh chat response. */
    function withToolsOnLastAssistant(chat, tools, usedAgent) {
      if (!Array.isArray(tools) || tools.length === 0 || !Array.isArray(chat)) return chat;
      const next = chat.slice();
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const message = next[index];
        if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue;
        if (!Array.isArray(message.tools) || message.tools.length === 0) {
          next[index] = {
            ...message,
            tools,
            usedAgent: usedAgent === true || message.usedAgent === true,
          };
        }
        break;
      }
      return next;
    }

    function yuanToolArgumentsText(tool) {
      if (tool === null || typeof tool !== 'object') return '';
      const value = tool.arguments;
      if (typeof value === 'string') return value;
      if (value === undefined || value === null) return '';
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    function yuanToolResultText(tool) {
      if (tool === null || typeof tool !== 'object') return '';
      const value = tool.result;
      if (typeof value === 'string') return value;
      if (value === undefined || value === null) return '';
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }

    function yuanProposalLabel(proposal, t) {
      const kind = proposal !== null && typeof proposal === 'object' && typeof proposal.kind === 'string' ? proposal.kind : 'todo';
      const text =
        proposal !== null && typeof proposal === 'object' && typeof proposal.text === 'string'
          ? proposal.text
          : String(proposal);
      const key = kind === 'memory' ? 'yuanProposalMemory' : kind === 'reminder' ? 'yuanProposalReminder' : 'yuanProposalTodo';
      return t(key) + ': ' + text;
    }

    function yuanSourceLabel(item, t) {
      if (item === null || typeof item !== 'object') return '';
      if (typeof item.sessionTitle === 'string' && item.sessionTitle !== '') return item.sessionTitle;
      if (item.source === 'session') return t('yuanSourceSession');
      if (item.source === 'note') return t('yuanSourceNote');
      if (typeof item.project === 'string' && item.project !== '') return item.project;
      return '';
    }

    function yuanLocalId(prefix) {
      return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    /** Host memory endpoints return `{memories:[...]}` (remember also returns the item). */
    function yuanMemoryList(body, fallback) {
      if (body !== null && typeof body === 'object') {
        if (Array.isArray(body.memories)) return body.memories;
        if (Array.isArray(body.memory)) return body.memory;
      }
      return Array.isArray(fallback) ? fallback : EMPTY;
    }

    async function yuanRequest(url, options) {
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

    /**
     * Module-level Yuan store. Components subscribe with useState + useEffect (no
     * useSyncExternalStore, so the mini-React render harness keeps working).
     */
    const yuan = {
      open: false,
      loading: false,
      error: null,
      state: null,
      sending: false,
      activity: null,
      failedText: null,
      lastLoadedAt: 0,
      lastBoard: null,
      boardSeq: 0,
      lastSeenAt: 0,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      emit() {
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch (error) {
            console.error('[leo-status] yuan listener failed', error);
          }
        }
      },
      set(patch) {
        Object.assign(this, patch);
        this.emit();
      },
      patchState(patch) {
        if (this.state === null) return;
        this.state = { ...this.state, ...patch };
        this.emit();
      },
      async load(force) {
        if (this.loading) return this.state;
        if (force !== true && this.state !== null && Date.now() - this.lastLoadedAt < 5000) return this.state;
        this.set({ loading: true, error: null });
        try {
          const body = await yuanRequest(YUAN_STATE_API);
          this.set({ loading: false, error: null, state: normalizeYuanState(body), lastLoadedAt: Date.now() });
        } catch (error) {
          this.set({ loading: false, error: describeError(error) });
        }
        return this.state;
      },
      async pollSignals() {
        try {
          const body = await yuanRequest(YUAN_SIGNALS_API);
          const previous = this.state;
          const next =
            previous === null
              ? normalizeYuanState(body)
              : {
                  ...previous,
                  signals: Array.isArray(body.signals) ? body.signals : previous.signals,
                  badge: body.badge !== undefined ? body.badge : previous.badge,
                  unread: body.unread !== undefined ? body.unread : previous.unread,
                };
          this.set({ state: next, error: null });
        } catch (error) {
          this.set({ error: describeError(error) });
        }
      },
      async send(text, options) {
        const settings = options !== null && typeof options === 'object' ? options : {};
        const message = typeof text === 'string' ? text.trim() : '';
        if (message === '' || this.sending) return null;
        const retry = settings.retry === true && this.failedText !== null;
        const previous = this.state;
        const previousChat = previous !== null && Array.isArray(previous.chat) ? previous.chat : EMPTY;
        const optimistic = retry
          ? null
          : { id: yuanLocalId('local-'), role: 'user', text: message, at: new Date().toISOString() };
        const chat = optimistic === null ? previousChat : [...previousChat, optimistic];
        this.set({ sending: true, error: null, failedText: null });
        this.patchState({ chat });
        let activityBusy = false;
        const activityTimer = setInterval(async () => {
          if (activityBusy) return;
          activityBusy = true;
          try { const result = await yuanRequest('/leo-status/api/yuan/activity'); this.set({ activity: result.activity }); }
          catch { /* The chat request supplies the actionable failure. */ }
          finally { activityBusy = false; }
        }, 700);
        try {
          const body = await yuanRequest(YUAN_CHAT_API, { method: 'POST', body: { message } });
          const responseChat = Array.isArray(body.chat) ? withToolsOnLastAssistant(body.chat, body.tools, body.usedAgent) : chat;
          const next =
            previous === null
              ? { ...normalizeYuanState(body), chat: responseChat }
              : {
                  ...previous,
                  chat: responseChat,
                  suggestions: Array.isArray(body.suggestions) ? body.suggestions : previous.suggestions,
                  signals: Array.isArray(body.signals) ? body.signals : previous.signals,
                  badge: body.badge !== undefined ? body.badge : previous.badge,
                  agent: body.agent !== undefined ? body.agent : previous.agent,
                };
          this.set({ sending: false, error: null, failedText: null, state: next });
          return body;
        } catch (error) {
          // Keep the user's optimistic message so it can be retried without retyping.
          this.set({ sending: false, error: describeError(error), failedText: message });
          this.patchState({ chat });
          return null;
        } finally {
          clearInterval(activityTimer);
          this.set({ activity: null });
        }
      },
      async stop() {
        try { await yuanRequest('/leo-status/api/yuan/stop', { method: 'POST', body: {} }); }
        catch (error) { this.set({ error: describeError(error) }); }
      },
      async acceptSuggestion(id) {
        if (typeof id !== 'string' || id === '') return null;
        const previous = this.state;
        const before = previous !== null && Array.isArray(previous.suggestions) ? previous.suggestions : EMPTY;
        const remaining = before.filter((item) => item !== null && item.id !== id);
        this.patchState({ suggestions: remaining });
        try {
          const body = await yuanRequest(YUAN_ACCEPT_API, { method: 'POST', body: { id } });
          const suggestions = Array.isArray(body.suggestions) ? body.suggestions : remaining;
          if (this.state === null) this.set({ state: { ...normalizeYuanState(body), suggestions } });
          else this.patchState({ suggestions });
          if (body.board !== null && typeof body.board === 'object') {
            this.set({ lastBoard: body.board, boardSeq: this.boardSeq + 1 });
          }
          return body;
        } catch (error) {
          this.set({ error: describeError(error) });
          this.patchState({ suggestions: before });
          return null;
        }
      },
      async dismissSuggestion(id) {
        if (typeof id !== 'string' || id === '') return null;
        const previous = this.state;
        const before = previous !== null && Array.isArray(previous.suggestions) ? previous.suggestions : EMPTY;
        const remaining = before.filter((item) => item !== null && item.id !== id);
        this.patchState({ suggestions: remaining });
        try {
          const body = await yuanRequest(YUAN_DISMISS_API, { method: 'POST', body: { id } });
          const suggestions = Array.isArray(body.suggestions) ? body.suggestions : remaining;
          if (this.state === null) this.set({ state: { ...normalizeYuanState(body), suggestions } });
          else this.patchState({ suggestions });
          return body;
        } catch (error) {
          this.set({ error: describeError(error) });
          this.patchState({ suggestions: before });
          return null;
        }
      },
      async remember(text) {
        const value = typeof text === 'string' ? text.trim() : '';
        if (value === '') return null;
        const previous = this.state !== null && Array.isArray(this.state.memory) ? this.state.memory : EMPTY;
        try {
          const body = await yuanRequest(YUAN_REMEMBER_API, { method: 'POST', body: { text: value } });
          const memory = yuanMemoryList(body, previous);
          if (this.state === null) this.set({ state: { ...normalizeYuanState(body), memory } });
          else this.patchState({ memory });
          return body;
        } catch (error) {
          this.set({ error: describeError(error) });
          return null;
        }
      },
      async deleteMemory(id) {
        if (typeof id !== 'string' || id === '') return null;
        const previous = this.state !== null && Array.isArray(this.state.memory) ? this.state.memory : EMPTY;
        try {
          const body = await yuanRequest(YUAN_MEMORY_DELETE_API, { method: 'POST', body: { id } });
          const memory = yuanMemoryList(
            body,
            previous.filter((item) => item !== null && typeof item === 'object' && item.id !== id),
          );
          if (this.state === null) this.set({ state: { ...normalizeYuanState(body), memory } });
          else this.patchState({ memory });
          return body;
        } catch (error) {
          this.set({ error: describeError(error) });
          return null;
        }
      },
      async acceptMemory(id) {
        if (typeof id !== 'string' || id === '') return null;
        const previous = this.state !== null && Array.isArray(this.state.memory) ? this.state.memory : EMPTY;
        try {
          const body = await yuanRequest(YUAN_MEMORY_ACCEPT_API, { method: 'POST', body: { id } });
          const memory = yuanMemoryList(
            body,
            previous.map((item) =>
              item !== null && typeof item === 'object' && item.id === id ? { ...item, status: 'active' } : item,
            ),
          );
          if (this.state === null) this.set({ state: { ...normalizeYuanState(body), memory } });
          else this.patchState({ memory });
          return body;
        } catch (error) {
          this.set({ error: describeError(error) });
          return null;
        }
      },
      async addReminder(text, at) {
        const value = typeof text === 'string' ? text.trim() : '';
        if (value === '') return null;
        try {
          const body = await yuanRequest(YUAN_REMINDER_API, {
            method: 'POST',
            body: at === undefined || at === null ? { text: value } : { text: value, at },
          });
          this.patchState({
            reminders: Array.isArray(body.reminders) ? body.reminders : this.state !== null ? this.state.reminders : [],
            signals: Array.isArray(body.signals) ? body.signals : this.state !== null ? this.state.signals : [],
          });
          return body;
        } catch (error) {
          this.set({ error: describeError(error) });
          return null;
        }
      },
      async completeReminder(id) {
        if (typeof id !== 'string' || id === '') return null;
        try {
          const body = await yuanRequest(YUAN_REMINDER_DONE_API, { method: 'POST', body: { id } });
          this.patchState({
            reminders: Array.isArray(body.reminders) ? body.reminders : this.state !== null ? this.state.reminders : [],
            signals: Array.isArray(body.signals) ? body.signals : this.state !== null ? this.state.signals : [],
          });
          return body;
        } catch (error) {
          this.set({ error: describeError(error) });
          return null;
        }
      },
      async markSeen() {
        try {
          const body = await yuanRequest(YUAN_SEEN_API, { method: 'POST', body: {} });
          this.set({ lastSeenAt: typeof body.lastSeenAt === 'number' ? body.lastSeenAt : Date.now() });
          this.patchState({ unread: false, signals: (this.state?.signals || []).filter((s) => s.kind !== 'unread').map((s) => s.kind === 'suggestion' ? { ...s, isNew: false } : s), badge: { ...this.state?.badge, hasUnread: false } });
        } catch {
          /* 未读标记失败不影响面板 */
        }
      },
      toggle() {
        if (this.open) this.closePanel();
        else this.openPanel();
      },
      openPanel() {
        this.set({ open: true });
        this.load().then(() => this.markSeen());
      },
      closePanel() {
        this.set({ open: false });
      },
    };

    /** Subscribe a component to the Yuan store with the mini-React-compatible hooks. */
    function useYuanStore() {
      const [, forceRender] = useState(0);
      useEffect(() => {
        const unsubscribe = yuan.subscribe(() => forceRender((value) => value + 1));
        if (yuan.state === null && !yuan.loading) yuan.load();
        return unsubscribe;
      }, []);
      return yuan;
    }

    // DeepSeek whale silhouette adapted from DSH ui-conversation (MIT); Yuan adds a sky badge and sparkle.
    const YUAN_WHALE_PATH = "M22.403 0.567C22.145 0.477 22.068 0.718 21.939 0.85C21.895 0.893 21.86 0.947 21.824 0.997C21.515 1.421 21.13 1.721 20.591 1.77C19.829 1.867 19.221 2.244 18.712 2.958C18.535 2.227 18.116 1.839 17.516 1.626C17.203 1.506 16.887 1.379 16.663 1.064C16.508 0.839 16.462 0.581 16.383 0.329C16.332 0.176 16.283 0.02 16.121 -0.002C15.944 -0.029 15.875 0.133 15.805 0.269C15.52 0.822 15.408 1.43 15.42 2.046C15.449 3.432 16.031 4.532 17.202 5.274C17.337 5.356 17.374 5.445 17.335 5.582C17.261 5.862 17.169 6.134 17.086 6.413C17.032 6.59 16.952 6.63 16.764 6.558C16.118 6.301 15.562 5.909 15.074 5.433C14.248 4.633 13.5 3.751 12.568 3.06C12.349 2.898 12.13 2.748 11.903 2.605C10.952 1.682 12.028 0.923 12.277 0.833C12.537 0.739 12.367 0.416 11.526 0.42C10.684 0.424 9.914 0.706 8.933 1.081C8.789 1.138 8.638 1.179 8.484 1.213C7.593 1.044 6.668 1.006 5.702 1.115C3.883 1.318 2.43 2.178 1.362 3.646C0.079 5.41 -0.223 7.415 0.147 9.506C0.535 11.71 1.66 13.535 3.389 14.962C5.181 16.441 7.246 17.166 9.601 17.027C11.032 16.944 12.624 16.753 14.421 15.232C14.874 15.458 15.35 15.548 16.138 15.615C16.746 15.672 17.331 15.585 17.784 15.491C18.493 15.341 18.444 14.684 18.188 14.564C16.108 13.595 16.565 13.989 16.15 13.67C17.206 12.42 18.82 10.198 19.363 7.086C19.421 6.709 19.484 6.171 19.469 5.866C19.458 5.681 19.493 5.604 19.681 5.556C20.199 5.412 20.691 5.172 21.125 4.806C22.366 3.824 22.758 2.554 22.708 1.1C22.7 0.878 22.649 0.654 22.403 0.567ZM11.175 14.451C9.159 12.726 8.182 12.088 7.778 12.067C7.401 12.047 7.469 12.505 7.552 12.807C7.639 13.103 7.752 13.313 7.91 13.581C8.02 13.758 8.095 14.01 7.801 14.16C7.152 14.487 6.023 13.806 5.97 13.772C4.657 12.85 3.559 11.766 2.785 10.369C2.037 9.025 1.603 7.583 1.532 6.044C1.513 5.672 1.622 5.541 1.992 5.473C2.479 5.383 2.981 5.364 3.468 5.436C5.525 5.736 7.276 6.675 8.744 8.323C9.582 9.299 10.216 10.425 10.869 11.496C11.563 12.592 12.31 13.603 13.262 14.414C13.598 14.696 13.866 14.91 14.123 15.068C13.349 15.154 12.058 15.167 11.175 14.452L11.175 14.451ZM12.141 8.26C12.141 8.095 12.273 7.963 12.439 7.963C12.476 7.963 12.511 7.971 12.541 7.982C12.582 7.997 12.62 8.019 12.65 8.053C12.704 8.106 12.733 8.181 12.733 8.26C12.733 8.425 12.601 8.556 12.435 8.556C12.27 8.556 12.141 8.425 12.141 8.26ZM15.142 9.799C14.949 9.878 14.757 9.945 14.572 9.953C14.284 9.968 13.972 9.851 13.802 9.709C13.537 9.487 13.348 9.363 13.27 8.977C13.236 8.812 13.255 8.556 13.284 8.41C13.352 8.094 13.277 7.892 13.055 7.708C12.873 7.558 12.643 7.516 12.39 7.516C12.296 7.516 12.209 7.475 12.145 7.441C12.039 7.389 11.952 7.257 12.035 7.096C12.062 7.043 12.19 6.916 12.22 6.893C12.563 6.698 12.96 6.762 13.326 6.908C13.665 7.047 13.922 7.302 14.292 7.663C14.669 8.098 14.738 8.218 14.953 8.545C15.123 8.801 15.277 9.063 15.383 9.364C15.447 9.551 15.364 9.705 15.142 9.799Z";
    function RobotIcon() {
      return h('svg', { className: 'ls-yuan-whale', width: 26, height: 26, viewBox: '0 0 32 32', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 16, cy: 16, r: 15, fill: '#eaf2ff' }),
        h('path', { d: YUAN_WHALE_PATH, transform: 'translate(4 8) scale(.96)', fill: '#4f7cf7' }),
        h('path', { d: 'M25 2.5 26.1 5.4 29 6.5 26.1 7.6 25 10.5 23.9 7.6 21 6.5 23.9 5.4Z', fill: '#ffc957', stroke: '#fff', strokeWidth: .7 }));
    }

    // Capture on pointer-down: clicking a control may otherwise collapse selection.
    // Only the selected excerpt / visible content is sampled, never the whole DOM or draft.
    function captureOrigin(props = {}) {
      const sessionId = props.sessionId || null;
      const row = sessionId ? clientService('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId] : null;
      const origin = { sessionId, location: props.location || (sessionId ? 'DSH 会话' : 'Leo 待办'),
        title: row?.displayTitle || row?.title || (sessionId ? '当前会话' : 'Leo 待办'),
        selection: String(window.getSelection?.() || '').slice(0, 1800) };
      const root = document.querySelector('.ls-page') || [...document.querySelectorAll('[data-conversation-content]')].find(n => !n.closest('.ls-yuan-float')) || document.querySelector('main') || document.querySelector('[role="main"]');
      if (!root) return origin;
      origin.page = [...root.querySelectorAll('h1,h2,[role="tab"][aria-selected="true"]')].slice(0, 5).map((n) => n.textContent).join(' · ').slice(0, 350);
      const visible = (node) => { const r = node.getBoundingClientRect(); return r.width > 80 && r.height > 60 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0; };
      origin.code = [...root.querySelectorAll('pre')].filter(visible).slice(0, 1).map((n) => n.textContent.slice(0, 1000)).join('');
      const picture = [...root.querySelectorAll('img')].find((n) => visible(n) && n.naturalWidth >= 160 && n.naturalHeight >= 100 && !n.closest('nav,header,.ls-yuan-native,[data-composer-seat]'));
      if (picture) {
        try {
          const scale = Math.min(1, 640 / Math.max(picture.naturalWidth, picture.naturalHeight));
          const canvas = document.createElement('canvas'); canvas.width = Math.round(picture.naturalWidth * scale); canvas.height = Math.round(picture.naturalHeight * scale);
          canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL('image/jpeg', .65); if (data.length <= 180000) origin.image = data;
        } catch { origin.page += picture.alt ? ' · 图片：' + picture.alt.slice(0, 200) : ''; }
      }
      return origin;
    }

    const floating = { state: { sessionId: null, visible: false, source: null }, listeners: new Set(),
      set(value) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(this.state); } };
    function useFloating() {
      const [value, setValue] = useState(floating.state);
      useEffect(() => { floating.listeners.add(setValue); setValue(floating.state); return () => floating.listeners.delete(setValue); }, []);
      return value;
    }
    async function openYuan(options = {}) {
      if (options.newSession && floating.state.source && !options.origin) options = { ...options, origin: captureOrigin(floating.state.source) };
      const result = await apiJson('/leo-status/api/yuan/open', { method: 'POST', body: options });
      if (result.remote) throw new Error('阿源位于中心设备，请在设备中心切换到中心设备后打开原生会话');
      yuan.set({ state: { ...(yuan.state || {}), sessions: result.sessions, context: result.context, contextSessionId: result.sessionId, mode: result.mode || null } });
      floating.set({ sessionId: result.sessionId, visible: true, ...(options.origin ? { source: options.origin } : {}) });
      return result;
    }

    const FLOAT_LAYOUT_KEY = 'leo-status.yuan.float-layout.v1';
    function clampFloat(layout) {
      const width = Math.max(Math.min(360, innerWidth - 16), Math.min(Number(layout?.width) || 620, innerWidth - 16));
      const height = Math.max(Math.min(300, innerHeight - 56), Math.min(Number(layout?.height) || 720, innerHeight - 56));
      return { width, height, x: Math.max(8, Math.min(Number.isFinite(layout?.x) ? layout.x : innerWidth - width - 24, innerWidth - width - 8)),
        y: Math.max(40, Math.min(Number.isFinite(layout?.y) ? layout.y : innerHeight - height - 24, innerHeight - height - 8)) };
    }
    function readFloatLayout() { try { return clampFloat(JSON.parse(localStorage.getItem(FLOAT_LAYOUT_KEY))); } catch { return clampFloat(null); } }
    /** Collapsed launcher keeps its own absolute position; null means the CSS default corner. */
    const BUBBLE_POSITION_KEY = 'leo-status.yuan.bubble-position.v1';
    function readBubblePosition() {
      try {
        const value = JSON.parse(localStorage.getItem(BUBBLE_POSITION_KEY));
        return Number.isFinite(value?.x) && Number.isFinite(value?.y) ? clampBubble(value) : null;
      } catch { return null; }
    }
    function clampBubble(position) {
      const w = Math.max(48, Number(position?.w) || 96), h = Math.max(32, Number(position?.h) || 44);
      return { x: Math.max(8, Math.min(Number(position?.x) || 0, innerWidth - w - 8)),
        y: Math.max(8, Math.min(Number(position?.y) || 0, innerHeight - h - 8)), w, h };
    }
    function YuanChatView(props) {
      const [view, setView] = useState(() => { try { return localStorage.getItem('leo-status.yuan.float-view') === 'trajectory' ? 'trajectory' : 'chat'; } catch { return 'chat'; } });
      return h(React.Fragment, null,
        h('div', { className: 'ls-yuan-view-tabs', role: 'tablist', 'aria-label': '阿源会话视图' }, [['chat','对话'],['trajectory','轨迹']].map(([id,label]) => h('button', {
          key: id, role: 'tab', 'aria-selected': view === id, onClick: () => { setView(id); try { localStorage.setItem('leo-status.yuan.float-view', id); } catch {} },
        }, label))), props.renderSlot('conversation.session', { view }));
    }
    function YuanEmbeddedChat(props) {
      const session = props.useSession(s => s);
      return props.renderFactorySlot('conversation.content', {
        variant: 'embedded', phase: session.openState === 'loading' ? 'settling' : 'active', hero: false,
      }, { slots: { views: YuanChatView } });
    }
    function YuanFloatingPanel({ SessionProvider, renderSlot }) {
      const state = useFloating();
      const store = useYuanStore();
      const identity = store.state?.mode === 'hub' ? '中心设备 · 记忆在中心'
        : store.state?.mode === 'device' ? '本机运行 · 记忆同步中心'
        : '独立记忆 · 全权限';
      const [reference, setReference] = useState(null), [error, setError] = useState('');
      const [geometry, setGeometry] = useState(readFloatLayout), [wide, setWide] = useState(false), [, setViewport] = useState(0);
      const [bubblePos, setBubblePos] = useState(readBubblePosition);
      const panel = useRef(null), drag = useRef(null), sizing = useRef(null), opener = useRef(null), previousSize = useRef(null);
      const bubbleDrag = useRef(null), suppressBubbleClick = useRef(false);
      const layout = clampFloat(geometry);
      useEffect(() => { try { localStorage.setItem(FLOAT_LAYOUT_KEY, JSON.stringify(geometry)); } catch {} }, [geometry]);
      useEffect(() => {
        if (!state.sessionId) return;
        let alive = true;
        const ref = clientService('sessions').retain(state.sessionId, { source: 'leoYuanFloat' });
        setReference(ref); setError('');
        ref.ready.catch(e => { if (alive) setError(e.message); });
        return () => { alive = false; ref.release(); };
      }, [state.sessionId]);
      useEffect(() => {
        if (state.visible) opener.current = document.activeElement;
        else opener.current?.focus?.();
      }, [state.visible]);
      useEffect(() => {
        const onResize = () => { setViewport(n => n + 1); setBubblePos(current => (current ? clampBubble(current) : current)); };
        window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize);
      }, []);
      useEffect(() => { if (!bubblePos) return; try { localStorage.setItem(BUBBLE_POSITION_KEY, JSON.stringify(bubblePos)); } catch {} }, [bubblePos]);
      if (!state.sessionId) return null;
      const updateOrigin = () => {
        const main = [...document.querySelectorAll('[data-conversation-session]')].find(n => !n.closest('.ls-yuan-float'));
        const origin = captureOrigin(main ? { sessionId: main.dataset.conversationSession } : { location: document.querySelector('.ls-page') ? 'Leo 待办' : state.source?.location });
        void openYuan({ sessionId: state.sessionId, origin }).catch(e => setError(e.message));
      };
      return h(React.Fragment, null,
        !state.visible ? h('button', {
          type: 'button', className: 'ls-yuan-bubble', title: '展开阿源（可拖动）', 'aria-label': '展开阿源',
          style: bubblePos ? { left: bubblePos.x, top: bubblePos.y, right: 'auto', bottom: 'auto' } : undefined,
          onPointerDown: e => {
            if (e.button !== 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            bubbleDrag.current = { startX: e.clientX, startY: e.clientY, dx: e.clientX - rect.left, dy: e.clientY - rect.top, w: rect.width, h: rect.height, moved: false };
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
          },
          onPointerMove: e => {
            const start = bubbleDrag.current;
            if (!start) return;
            if (!start.moved && Math.hypot(e.clientX - start.startX, e.clientY - start.startY) < 4) return;
            start.moved = true;
            setBubblePos(clampBubble({ x: e.clientX - start.dx, y: e.clientY - start.dy, w: start.w, h: start.h }));
          },
          onPointerUp: () => {
            if (bubbleDrag.current?.moved) { suppressBubbleClick.current = true; setTimeout(() => { suppressBubbleClick.current = false; }, 0); }
            bubbleDrag.current = null;
          },
          onPointerCancel: () => { bubbleDrag.current = null; },
          onLostPointerCapture: () => { bubbleDrag.current = null; },
          onClick: () => {
            if (suppressBubbleClick.current) { suppressBubbleClick.current = false; return; }
            floating.set({ visible: true });
          },
        }, h(RobotIcon), '阿源') : null,
        h('section', { ref: panel, className: 'ls-yuan-float' + (wide ? ' ls-yuan-float-wide' : ''), role: 'dialog', 'aria-modal': false, 'aria-label': '阿源浮框',
          style: { display: state.visible ? 'flex' : 'none', left: layout.x, top: layout.y, width: layout.width, height: layout.height, right: 'auto', bottom: 'auto', maxWidth: 'none', maxHeight: 'none' },
          onKeyDown: e => { if (e.key === 'Escape' && !e.defaultPrevented) { floating.set({ visible: false }); e.stopPropagation(); } } },
          h('header', { className: 'ls-yuan-float-head', onPointerDown: e => {
            if (e.button !== 0 || e.target.closest('button')) return;
            const r = panel.current.getBoundingClientRect(); drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
          }, onPointerMove: e => { if (!drag.current) return; setGeometry(clampFloat({ ...layout, x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy })); },
          onPointerUp: () => { drag.current = null; }, onPointerCancel: () => { drag.current = null; }, onLostPointerCapture: () => { drag.current = null; } },
            h('div', { className: 'ls-yuan-float-identity' }, h(RobotIcon), h('strong', null, '阿源'), h('span', null, identity)),
            h('button', { className: 'ls-yuan-btn', onPointerDown: e => { e.preventDefault(); }, onClick: updateOrigin, title: '携带当前页面、选中文字或代码' }, '更新位置'),
            h('button', { className: 'ls-yuan-btn', onClick: () => { setGeometry(clampFloat(null)); setWide(false); }, title: '重置浮框大小和位置' }, '重置'),
            h('button', { className: 'ls-yuan-btn', onClick: () => { if (!wide) { previousSize.current = geometry; setGeometry(clampFloat({ width: 940, height: 850 })); } else setGeometry(previousSize.current || clampFloat(null)); setWide(!wide); }, 'aria-label': wide ? '缩小浮框' : '放大浮框' }, wide ? '↙' : '↗'),
            h('button', { className: 'ls-yuan-btn', onClick: () => floating.set({ visible: false }), 'aria-label': '收起阿源' }, '收起')),
          h(YuanNativeTools, { sessionId: state.sessionId, floating: true }),
          error ? h('p', { role: 'alert', className: 'ls-native-error' }, error) : null,
          h('div', { className: 'ls-yuan-float-body' }, reference?.sessionId === state.sessionId ? h(SessionProvider, { session: reference }, renderSlot('leo.yuan.conversation', {})) : h('p', null, '正在连接阿源…')),
          h('footer', { className: 'ls-yuan-float-foot' }, '拖动标题栏移动 · 右下角缩放'),
          h('button', { className: 'ls-yuan-resize', 'aria-label': '调整浮框大小', title: '拖动调整大小；方向键微调',
            onPointerDown: e => { e.preventDefault(); e.currentTarget.focus(); sizing.current = { startX: e.clientX, startY: e.clientY, ...layout }; e.currentTarget.setPointerCapture(e.pointerId); },
            onPointerMove: e => { const s = sizing.current; if (s) setGeometry(clampFloat({ ...s, width: s.width + e.clientX - s.startX, height: s.height + e.clientY - s.startY })); },
            onPointerUp: () => { sizing.current = null; }, onLostPointerCapture: () => { sizing.current = null; },
            onKeyDown: e => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return; e.preventDefault(); setGeometry(clampFloat({ ...layout, width: layout.width + (e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0), height: layout.height + (e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0) })); },
          }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }, h('path', { d: 'M3 13 13 3M8 13 13 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })))));
    }

    function YuanEntry(props) {
      const [busy, setBusy] = useState(false), [error, setError] = useState('');
      const snapshot = useRef(null);
      const store = useYuanStore();
      const isYuan = store.state?.sessions?.some((s) => s.id === props.sessionId);
      if (isYuan) return null;
      return h('span', { className: 'ls-yuan-launch' },
        h('button', { type: 'button', className: 'ls-yuan-entry', disabled: busy,
          title: '打开阿源 · 携带当前位置', 'aria-label': '打开阿源 · 携带当前位置',
          onPointerDown: () => { snapshot.current = captureOrigin(props); },
          onClick: async () => { setBusy(true); setError(''); try { await openYuan({ origin: snapshot.current || captureOrigin(props) }); }
            catch (e) { setError(e.message); } finally { snapshot.current = null; setBusy(false); } } }, h(RobotIcon)),
        error ? h('span', { className: 'ls-native-error', role: 'alert', onClick: () => setError(''), title: '点击收起' }, error) : null);
    }

    function MemoryBrowser() {
      const [items, setItems] = useState([]), [query, setQuery] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(null);
      const [editing, setEditing] = useState(null), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false);
      const generation = useRef(0);
      const load = async (value = query) => {
        const request = ++generation.current;
        try { const result = await apiJson('/leo-status/api/yuan/memory/query', { method: 'POST', body: { query: value } });
          if (request === generation.current) { setItems(result.items); setStatus(result.status); setError(''); } }
        catch (e) { if (request === generation.current) setError(e.message); }
      };
      useEffect(() => { const timer = setTimeout(() => load(query), 180); return () => { clearTimeout(timer); generation.current++; }; }, [query]);
      const change = async (item, action, text) => { setBusy(true); try {
        await apiJson('/leo-status/api/yuan/memory/change', { method: 'POST', body: { id: item.id, action, text } });
        setEditing(null); await load();
      } catch(e) { setError(e.message); } finally { setBusy(false); } };
      const kinds = { episode: '对话记录', preference: '偏好', fact: '事实', project: '项目', decision: '决定' };
      return h('div', { className: 'ls-memory-browser' },
        h('p', { className: 'ls-native-hint' }, '自动记录阿源对话，按当前问题检索。提炼保留原文依据；不确定的信息等待核对。'),
        h('div', { className: 'ls-toolbar__row' }, h('input', { className: 'ls-search__input', type: 'search', placeholder: '搜索记忆与对话…', 'aria-label': '搜索记忆与对话', value: query, onChange: (e) => setQuery(e.target.value) }),
          h('button', { className: 'ls-yuan-btn', onClick: () => load() }, '刷新')),
        error ? h('p', { className: 'ls-yuan-error', role: 'alert' }, error) : null,
        status?.lastError ? h('p', { className: 'ls-native-hint' }, '自动提炼暂不可用，原文仍可检索。') : null,
        status?.extracting ? h('p', { className: 'ls-native-hint' }, '正在整理新对话…') : null,
        items.length === 0 ? h('p', { className: 'ls-native-empty' }, query ? '没有相关记忆' : '与阿源对话后，记忆会自动出现在这里。') : null,
        items.map((item) => h('article', { className: 'ls-memory-row', key: item.id },
          h('div', { className: 'ls-native-hint' }, (kinds[item.kind] || '记忆') + (item.status === 'pending' ? ' · 待核对' : '') + ' · ' + new Date(item.at).toLocaleDateString()),
          editing === item.id ? h('textarea', { className: 'ls-memory-edit', value: draft, onChange: (e) => setDraft(e.target.value), 'aria-label': '修正记忆' }) : h('p', null, item.text),
          h('details', null, h('summary', null, '原文依据'), h('blockquote', null, item.source?.quote || '来自旧版记忆'),
            item.source?.sessionId ? h('button', { className: 'ls-yuan-btn', onClick: () => clientService('uiWorkspace')?.openSession(item.source.sessionId) }, '打开来源会话') : null),
          h('div', { className: 'ls-yuan-actions' },
            item.status === 'pending' ? h('button', { className: 'ls-yuan-btn', disabled: busy, onClick: () => change(item, 'accept') }, '确认') : null,
            editing === item.id ? h(React.Fragment, null, h('button', { className: 'ls-yuan-btn', disabled: busy || !draft.trim(), onClick: () => change(item, 'correct', draft) }, '保存修正'),
              h('button', { className: 'ls-yuan-btn', onClick: () => setEditing(null) }, '取消')) : h('button', { className: 'ls-yuan-btn', onClick: () => { setEditing(item.id); setDraft(item.text); } }, '纠正'),
            h('button', { className: 'ls-yuan-btn', disabled: busy, onClick: () => change(item, 'forget') }, '忘记')))));
    }

    function YuanNativeTools(props) {
      const store = useYuanStore(), [panel, setPanel] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
      const root = useRef(null);
      useEffect(() => { store.load(); }, [props.sessionId]);
      useEffect(() => {
        if (!store.state?.context) return;
        const timer = setInterval(() => store.load(true), 5000);
        return () => clearInterval(timer);
      }, [store.state?.context]);
      useEffect(() => {
        if (!panel) return;
        const close = (e) => { if (e.key === 'Escape' || (e.type === 'pointerdown' && root.current && !root.current.contains(e.target))) setPanel(''); };
        document.addEventListener('pointerdown', close); document.addEventListener('keydown', close);
        return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
      }, [panel]);
      const sessions = store.state?.sessions || [];
      if (!props.floating && !sessions.some((s) => s.id === props.sessionId)) return null;
      const context = store.state?.contextSessionId === props.sessionId ? store.state?.context : null;
      const navigate = async (options) => { setBusy(true); setError(''); try { await openYuan(options); setPanel(''); }
        catch(e) { setError(e.message); } finally { setBusy(false); } };
      return h('div', { className: 'ls-yuan-native', ref: root },
        !props.floating ? h('span', { className: 'ls-native-name' }, h(RobotIcon), '阿源') : null,
        h('button', { className: 'ls-yuan-btn', disabled: busy, onClick: () => navigate({ newSession: true }) }, '新会话'),
        ['历史','记忆','建议'].map((name) => h('button', { key: name, className: 'ls-yuan-btn', 'aria-expanded': panel === name, onClick: () => setPanel(panel === name ? '' : name) }, name)),
        context ? h('button', { className: 'ls-context-chip', onClick: () => setPanel(panel === '位置' ? '' : '位置'), title: '将在下一次发言时提供给阿源，10 分钟后过期' }, '来自 ' + (context.title || context.location)) : null,
        error ? h('span', { className: 'ls-native-error', role: 'alert' }, error) : null,
        panel ? h('section', { className: 'ls-native-popover', 'aria-label': '阿源' + panel },
          h('div', { className: 'ls-native-popover-head' }, h('strong', null, panel === '位置' ? '已携带的位置' : '阿源 · ' + panel), h('button', { className: 'ls-yuan-btn', onClick: () => setPanel(''), 'aria-label': '关闭阿源菜单' }, '×')),
          panel === '历史' ? sessions.map((s) => h('button', { key: s.id, className: 'ls-history-row', disabled: busy, onClick: () => navigate({ sessionId: s.id }) },
            h('span', null, clientService('sessions')?.list?.getSnapshot?.()?.byId?.[s.id]?.displayTitle || s.title), h('small', null, new Date(s.lastActiveAt || s.createdAt).toLocaleString()))) : null,
          panel === '记忆' ? h(MemoryBrowser) : null,
          panel === '建议' ? h(SuggestionReview, { t: translatorFor(props), store }) : null,
          panel === '位置' ? h('div', null, h('p', { className: 'ls-native-hint' }, '点击入口时的快照；下一次发言时提供，不会自动发送消息。10 分钟后过期。'),
            h('p', null, context?.title || context?.location), h('p', null, context?.selection || context?.page || ''),
            context?.code ? h('pre', null, context.code) : null, context?.recent?.map((r, i) => h('blockquote', { key: i }, r.text)), context?.image ? h('p', null, '已携带一张缩略图片') : null) : null) : null);
    }

    function SuggestionReview({ t, store }) {
      const [limit, setLimit] = useState(20);
      const suggestions = pendingSuggestions(store.state?.suggestions || []);
      return h('div', { className: 'ls-review' }, h('p', { className: 'ls-native-hint' }, t('intakeHint')),
        store.error ? h('p', { className: 'ls-yuan-error', role: 'alert' }, store.error) : null,
        !suggestions.length ? h('p', { className: 'ls-native-empty' }, '没有待确认建议') : null,
        suggestions.slice(0, limit).map((item) => h(YuanSuggestionItem, { key: item.id, t, item, onAccept: (id) => store.acceptSuggestion(id), onDismiss: (id) => store.dismissSuggestion(id) })),
        suggestions.length > limit ? h('button', { className: 'ls-yuan-btn', onClick: () => setLimit(limit + 20) }, '显示更多') : null);
    }

    /** Copy text with a graceful no-op when the clipboard API is unavailable. */
    function copyToClipboard(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(String(text ?? '')).catch(() => {});
          return true;
        }
      } catch {
        /* clipboard unavailable */
      }
      return false;
    }

    function CopyButton({ t, text, className }) {
      const [copied, setCopied] = useState(false);
      const label = copied ? t('yuanCopied') : t('yuanCopy');
      return h(
        'button',
        {
          type: 'button',
          className: 'ls-yuan-copy' + (typeof className === 'string' && className !== '' ? ' ' + className : ''),
          title: label,
          'aria-label': label,
          onClick: () => {
            copyToClipboard(text);
            setCopied(true);
            if (typeof setTimeout === 'function') setTimeout(() => setCopied(false), 1500);
          },
        },
        label,
      );
    }

    function sanitizeHref(value) {
      const href = typeof value === 'string' ? value.trim() : '';
      if (href === '') return null;
      if (/^(https?:|mailto:)/i.test(href) || href.startsWith('/') || href.startsWith('#')) return href;
      return null;
    }

    const YUAN_INLINE_PATTERN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

    /** Render a safe Markdown inline subset into React nodes (no innerHTML). */
    function renderInline(text) {
      const source = typeof text === 'string' ? text : '';
      if (source === '') return [];
      const tokens = source.split(YUAN_INLINE_PATTERN);
      const nodes = [];
      tokens.forEach((token, index) => {
        if (token === '') return;
        const key = 'in-' + index;
        if (/^\*\*[^*\n]+\*\*$/.test(token) || /^__[^_\n]+__$/.test(token)) {
          nodes.push(h('strong', { key }, renderInline(token.slice(2, -2))));
        } else if (/^\*[^*\n]+\*$/.test(token) || /^_[^_\n]+_$/.test(token)) {
          nodes.push(h('em', { key }, renderInline(token.slice(1, -1))));
        } else if (/^`[^`\n]+`$/.test(token)) {
          nodes.push(h('code', { key, className: 'ls-yuan-inline-code' }, token.slice(1, -1)));
        } else if (/^\[[^\]\n]+\]\([^)\s]+\)$/.test(token)) {
          const match = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
          const href = sanitizeHref(match === null ? '' : match[2]);
          if (href === null) nodes.push(token);
          else {
            nodes.push(
              h(
                'a',
                { key, href, target: '_blank', rel: 'noreferrer noopener', className: 'ls-yuan-link' },
                match[1],
              ),
            );
          }
        } else {
          nodes.push(token);
        }
      });
      return nodes;
    }

    function isMarkdownBlockStart(line) {
      return (
        /^\s*$/.test(line) ||
        /^\s*(```|~~~)/.test(line) ||
        /^\s*#{1,6}\s+/.test(line) ||
        /^\s*>/.test(line) ||
        /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
        /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
      );
    }

    function CodeBlock({ t, code, language }) {
      const [copied, setCopied] = useState(false);
      const label = copied ? t('yuanCopied') : t('yuanCopyCode');
      const codeText = typeof code === 'string' ? code : '';
      return h(
        'div',
        { className: 'ls-yuan-code' },
        h(
          'div',
          { className: 'ls-yuan-code__head' },
          h('span', { className: 'ls-yuan-code__lang' }, typeof language === 'string' && language !== '' ? language : ''),
          h(
            'button',
            {
              type: 'button',
              className: 'ls-yuan-code-copy',
              title: label,
              'aria-label': label,
              onClick: () => {
                copyToClipboard(codeText);
                setCopied(true);
                if (typeof setTimeout === 'function') setTimeout(() => setCopied(false), 1500);
              },
            },
            label,
          ),
        ),
        h('pre', { className: 'ls-yuan-code__pre' }, h('code', null, codeText)),
      );
    }

    /** Block-level Markdown subset renderer (headings/lists/code/quotes/links/...). */
    function renderMarkdown(text, t) {
      const lines = String(text ?? '').split(/\r?\n/);
      const blocks = [];
      let index = 0;
      let key = 0;
      const nextKey = () => 'md-' + key++;
      while (index < lines.length) {
        const line = lines[index];
        if (/^\s*$/.test(line)) {
          index += 1;
          continue;
        }
        const fence = /^\s*(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
        if (fence !== null) {
          const marker = fence[1];
          const language = fence[2];
          const codeLines = [];
          index += 1;
          const close = new RegExp('^\\s*' + marker + '\\s*$');
          while (index < lines.length && !close.test(lines[index])) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) index += 1;
          blocks.push(h(CodeBlock, { key: nextKey(), t, code: codeLines.join('\n'), language }));
          continue;
        }
        const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
        if (heading !== null) {
          const level = heading[1].length;
          const tag = level <= 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
          blocks.push(
            h(
              tag,
              { key: nextKey(), className: 'ls-yuan-md-heading ls-yuan-md-heading--' + level },
              renderInline(heading[2].trim()),
            ),
          );
          index += 1;
          continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
          blocks.push(h('hr', { key: nextKey(), className: 'ls-yuan-md-hr' }));
          index += 1;
          continue;
        }
        if (/^\s*>/.test(line)) {
          const quoteLines = [];
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
            index += 1;
          }
          blocks.push(
            h('blockquote', { key: nextKey(), className: 'ls-yuan-md-quote' }, renderInline(quoteLines.join('\n'))),
          );
          continue;
        }
        if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
          const firstMatch = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
          const ordered = firstMatch !== null && /^\d/.test(firstMatch[2]);
          const items = [];
          while (index < lines.length) {
            const itemMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
            if (itemMatch === null) break;
            const indent = Math.min(3, Math.floor(itemMatch[1].replace(/\t/g, '  ').length / 2));
            const body = itemMatch[3];
            const task = /^\[([ xX])\]\s*(.*)$/.exec(body);
            let content;
            if (task !== null) {
              const checked = task[1] !== ' ';
              content = h(
                'span',
                { className: 'ls-yuan-task' + (checked ? ' ls-yuan-task--done' : '') },
                h(
                  'span',
                  { className: 'ls-yuan-task__box', 'aria-hidden': 'true' },
                  h(CheckIcon, { mode: checked ? 'done' : 'open' }),
                ),
                h('span', null, renderInline(task[2])),
              );
            } else {
              content = h('span', null, renderInline(body));
            }
            items.push(
              h(
                'li',
                {
                  key: nextKey(),
                  className: 'ls-yuan-md-li',
                  style: indent > 0 ? { marginLeft: indent * 14 + 'px' } : undefined,
                },
                content,
              ),
            );
            index += 1;
          }
          blocks.push(h(ordered ? 'ol' : 'ul', { key: nextKey(), className: 'ls-yuan-md-list' }, items));
          continue;
        }
        const paragraphLines = [];
        while (index < lines.length && !isMarkdownBlockStart(lines[index])) {
          paragraphLines.push(lines[index]);
          index += 1;
        }
        if (paragraphLines.length === 0) {
          index += 1;
          continue;
        }
        blocks.push(h('p', { key: nextKey(), className: 'ls-yuan-md-p' }, renderInline(paragraphLines.join('\n'))));
      }
      return blocks;
    }

    function MarkdownView({ t, text }) {
      return h('div', { className: 'ls-yuan-markdown' }, renderMarkdown(text, t));
    }

    const YUAN_TOOL_RESULT_LIMIT = 2000;

    /** One tool call card: name + argument summary + collapsible result. */
    function YuanToolCard({ t, tool }) {
      const [argsOpen, setArgsOpen] = useState(false);
      const [resultOpen, setResultOpen] = useState(false);
      const name =
        tool !== null && typeof tool === 'object' && typeof tool.name === 'string' && tool.name !== ''
          ? tool.name
          : t('toolCall');
      const isError = tool !== null && typeof tool === 'object' && tool.isError === true;
      const argsText = yuanToolArgumentsText(tool);
      const rawResult = yuanToolResultText(tool);
      const resultText =
        rawResult.length > YUAN_TOOL_RESULT_LIMIT
          ? rawResult.slice(0, YUAN_TOOL_RESULT_LIMIT) + '\u2026'
          : rawResult;
      const argsSummary = argsText.length > 120 ? argsText.slice(0, 117) + '\u2026' : argsText;
      const stateLabel = isError ? t('toolError') : resultText === '' ? t('toolPending') : t('toolResult');
      return h(
        'div',
        { className: 'ls-yuan-tool' + (isError ? ' ls-yuan-tool--error' : '') },
        h(
          'div',
          { className: 'ls-yuan-tool__head' },
          h(
            'span',
            { className: 'ls-yuan-tool__icon', 'aria-hidden': 'true' },
            h(
              'svg',
              { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
              h('path', {
                d: 'M10.6 2.4a2.9 2.9 0 0 0-3.2 3.9L2.8 10.9a1.4 1.4 0 0 0 2 2l4.6-4.6a2.9 2.9 0 0 0 3.9-3.2l-1.8 1.8-1.9-.4-.4-1.9 1.4-1.4z',
                stroke: 'currentColor',
                strokeWidth: 1.1,
                strokeLinejoin: 'round',
              }),
            ),
          ),
          h('span', { className: 'ls-yuan-tool__name' }, name),
          h('span', { className: 'ls-yuan-tool__state' }, stateLabel),
          argsText !== ''
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ls-yuan-tool__toggle ls-yuan-tool__toggle--args',
                  title: t('toolArgs'),
                  'aria-label': t('toolArgs'),
                  'aria-expanded': argsOpen ? 'true' : 'false',
                  onClick: () => setArgsOpen((value) => !value),
                },
                argsOpen ? t('toolCollapse') : t('toolExpand'),
              )
            : null,
        ),
        argsText !== ''
          ? h(
              'button',
              {
                type: 'button',
                className: 'ls-yuan-tool__args',
                title: argsText,
                onClick: () => setArgsOpen((value) => !value),
              },
              t('toolArgs') + ': ' + (argsOpen ? argsText : argsSummary),
            )
          : null,
        argsOpen && argsText !== '' ? h('pre', { className: 'ls-yuan-tool__pre' }, argsText) : null,
        h(
          'div',
          { className: 'ls-yuan-tool__result' },
          h(
            'button',
            {
              type: 'button',
              className: 'ls-yuan-tool__toggle ls-yuan-tool__toggle--result',
              'aria-expanded': resultOpen ? 'true' : 'false',
              disabled: resultText === '',
              onClick: () => setResultOpen((value) => !value),
            },
            resultText === ''
              ? t('toolPending')
              : t('toolResult') + ' \u00b7 ' + (resultOpen ? t('toolCollapse') : t('toolExpand')),
          ),
          resultText !== '' && resultOpen
            ? h('pre', { className: 'ls-yuan-tool__pre' + (isError ? ' ls-yuan-tool__pre--error' : '') }, resultText)
            : null,
        ),
      );
    }

    function YuanSuggestionItem({ t, item, onAccept, onDismiss }) {
      const reasons = item !== null && typeof item === 'object' && Array.isArray(item.reasons) ? item.reasons : EMPTY;
      const source = yuanSourceLabel(item, t);
      const id = item !== null && typeof item === 'object' && typeof item.id === 'string' ? item.id : '';
      return h(
        'article',
        { className: 'ls-yuan-card ls-yuan-toolcard' },
        h(
          'div',
          { className: 'ls-yuan-toolcard__head' },
          h(
            'span',
            { className: 'ls-yuan-toolcard__icon', 'aria-hidden': 'true' },
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
          h('span', { className: 'ls-yuan-toolcard__tag' }, t('yuanSuggestionTag')),
          source !== '' ? h('span', { className: 'ls-yuan-toolcard__source' }, source) : null,
        ),
        h('div', { className: 'ls-yuan-card__text' }, item !== null && typeof item.text === 'string' ? item.text : ''),
        item?.origin ? h('details', { className: 'ls-yuan-card__meta' },
          h('summary', null, t('intakeEvidence')),
          h('div', null, [item.origin.deviceName, item.origin.relPath || item.origin.file, item.origin.line ? ':' + item.origin.line : '', item.sessionTitle || item.sessionId].filter(Boolean).join(' ')),
          item.origin.heading ? h('div', null, item.origin.heading) : null,
          item.origin.evidence?.quote ? h('blockquote', null, item.origin.evidence.quote) : null,
          h('div', null, t('intakeOwner')),
        ) : null,
        reasons.length > 0
          ? h(
              'div',
              { className: 'ls-yuan-reasons' },
              reasons.slice(0, 3).map((reason, index) =>
                h('span', { key: 'reason-' + index, className: 'ls-yuan-reason' }, String(reason)),
              ),
            )
          : null,
        h(
          'div',
          { className: 'ls-yuan-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'ls-yuan-btn ls-yuan-btn--primary',
              disabled: id === '',
              onClick: () => onAccept(id),
            },
            t('yuanAccept'),
          ),
          h(
            'button',
            { type: 'button', className: 'ls-yuan-btn', disabled: id === '', onClick: () => onDismiss(id) },
            t('yuanDismiss'),
          ),
        ),
      );
    }

    const PRIORITY_RANK = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
    const PRIORITY_LABEL_KEYS = {
      highest: 'priorityHighest',
      high: 'priorityHigh',
      medium: 'priorityMedium',
      low: 'priorityLow',
      lowest: 'priorityLowest',
    };

    const zh = {
      nav: '待办',
      title: 'Leo 状态',
      subtitle: '待办 · 笔记与已确认事项',
      refresh: '刷新',
      refreshing: '刷新中…',
      refreshHint: '重新扫描磁盘上的笔记与会话',
      lastScan: '最后扫描',
      statOpen: '未完成',
      statOverdue: '逾期',
      statToday: '今天',
      statSoon: '未来 7 天',
      statDone: '已完成',
      searchPlaceholder: '搜索待办…',
      searchLabel: '搜索待办（匹配文本、标题或标签）',
      clearSearch: '清除搜索',
      allSources: '全部',
      filterBySource: '按来源筛选',
      hideDone: '隐藏已完成',
      groupOverdue: '逾期',
      groupToday: '今天',
      groupSoon: '未来 7 天',
      groupLater: '以后',
      groupUndated: '无日期',
      groupDone: '已完成',
      expandDone: '展开已完成',
      collapseDone: '收起已完成',
      cancelled: '作废',
      staleWarning: '数据可能已过期',
      loading: '正在读取待办…',
      emptyTitle: '还没有待办',
      emptyBefore: '在 Obsidian 笔记里写 ',
      emptyCode: '- [ ] 任务',
      emptyAfter: '，刷新后自动显示；会话中提取的事项需要先在「待确认建议」中接受。',
      filteredEmptyTitle: '没有匹配的待办',
      filteredEmptyBody: '换个关键词，或放宽来源筛选。',
      clearFilters: '清除筛选',
      offlineTitle: '无法连接到宿主',
      offlineBody: '没有拿到待办数据。请确认 leo-status 宿主端插件已启用，然后重试。',
      retry: '重试',
      untitled: '（无文本）',
      sessionFallback: 'DSH 会话',
      due: '截止',
      overdue: '逾期',
      today: '今天',
      dayUnit: '天',
      priority: '优先级',
      priorityHighest: '最高',
      priorityHigh: '高',
      priorityMedium: '中',
      priorityLow: '低',
      priorityLowest: '最低',
      took: '扫描耗时',
      files: '文件',
      sources: '来源',
      sourceErrors: '来源错误',
      loadFailed: '读取失败',
      deviceLocal: '本机',
      allDevices: '全部设备',
      devicesUnit: '台设备',
      devicesLabel: '设备',
      device: '设备',
      filterByDevice: '按设备筛选',
      online: '在线',
      offline: '离线',
      hubStatus: '中心',
      deviceConnected: '已连接中心',
      deviceOffline: '中心离线',
      hubOfflineTitle: '中心不可达，显示本机缓存',
      lastSync: '最后同步',
      relayStarting: '中转连接中…',
      relayRunning: '中转正常',
      relayStopped: '中转断开',
      relayDisabled: '未启用中转',
      joinTitle: '加入 leo-status 中心',
      joinIntro: '填写中心地址与密码，把这台设备的待办同步到中心看板。',
      joinHubUrl: '中心地址',
      joinPassword: '密码',
      joinName: '本机名称',
      joinRootLabel: '笔记目录（可选）',
      joinRootPlaceholder: '例如：C:\\notes',
      joinSubmit: '加入中心',
      joinSubmitting: '加入中…',
      joinFailed: '加入失败',
      actionCancel: '作废',
      actionRestore: '启用',
      actionDelete: '删除',
      actionDeleteConfirm: '再点一次确认删除',
      actionFailed: '操作失败',
      actionPending: '处理中…',
      actionDismiss: '关闭',
      checkDone: '标记完成',
      checkUndone: '标记未完成',
      yuanName: '阿源',
      intakeEvidence: '查看来源与依据',
      intakeOwner: '执行人：Leo · Accept 只加入看板，不修改来源笔记',
      intakeHint: '会话和其他候选事项需确认后接受；忽略后不会反复出现。Obsidian 库任务自动进入看板。',
      intakeMore: '显示更多建议',
      yuanStop: '停止执行',
      yuanEntryTitle: '打开阿源',
      yuanPanelAria: '阿源面板',
      yuanSubtitle: '看板管家',
      yuanModelLabel: '模型',
      yuanModelOffline: '离线（模型不可用）',
      yuanClose: '关闭',
      yuanOpenPanel: '打开阿源面板',
      yuanSuggestionCard: '阿源建议',
      yuanPendingCount: '待确认',
      yuanSourceSession: '来自会话',
      yuanSourceNote: '来自笔记',
      yuanSuggestSection: '待确认建议',
      yuanSuggestEmpty: '暂无待确认建议',
      yuanAccept: '接受',
      yuanDismiss: '忽略',
      yuanAccepted: '已接受',
      yuanDismissed: '已忽略',
      yuanReminderSection: '提醒',
      yuanReminderEmpty: '暂无提醒',
      yuanReminderDone: '完成',
      yuanReminderExpired: '已过期',
      yuanChatSection: '对话',
      yuanChatEmpty: '还没有对话，问阿源点什么吧',
      yuanThinking: '阿源正在思考…',
      yuanInputPlaceholder: '问阿源…（Enter 发送，Shift+Enter 换行）',
      yuanSend: '发送',
      yuanYou: '你',
      yuanAssistant: '阿源',
      yuanMemorySection: '记忆',
      yuanMemoryEmpty: '还没有记忆',
      yuanMemoryDelete: '删除记忆',
      yuanRememberHint: '输入「记住：…」让阿源记住',
      yuanLoading: '正在连接阿源…',
      yuanError: '阿源出错',
      yuanRetry: '重试',
      yuanProposalTodo: '建议 todo',
      yuanProposalMemory: '记住了',
      yuanProposalReminder: '提醒',
      yuanChipSuggest: '建议',
      yuanChipReminder: '提醒',
      yuanChipDeadline: '截止',
      yuanExpandMemory: '展开记忆',
      yuanCollapseMemory: '收起记忆',
      yuanSignalEmpty: '暂无信号',
      yuanWelcome: '你好，我是阿源。看板上的事都可以问我。',
      yuanQuickHint: '试着问：',
      yuanQuick1: '今天先做哪三件？',
      yuanQuick2: '记住：我晚上不看新任务',
      yuanQuick3: '提醒我周五交报告',
      yuanSending: '发送中…',
      yuanRetrySend: '重试发送',
      yuanSendFailed: '发送失败',
      yuanCopy: '复制',
      yuanCopied: '已复制',
      yuanCopyCode: '复制代码',
      yuanSuggestionTag: '建议',
      yuanMemoryPending: '待确认',
      yuanMemoryConfirm: '确认',
      yuanMemoryAdd: '记住：…',
      yuanComposerHint: 'Enter 发送 · Shift+Enter 换行',
      toolCall: '工具调用',
      toolResult: '结果',
      toolError: '出错',
      toolPending: '已调用',
      toolArgs: '参数',
      toolExpand: '展开',
      toolCollapse: '收起',
      agentReady: '工具已连接',
      agentDegraded: '工具降级',
      yuanAgentHint: '阿源可以调用工具读文件；一般不会主动翻你的文件，只在需要时读。',
      openNativeSession: '原生会话',
      openNativeSessionHint: '在 DSH 原生会话界面打开阿源的 Agent 会话',
      obsidianCardTitle: '数据源 · Obsidian 自动发现',
      obsidianCardHint: 'Obsidian 库的任务自动进入看板。扫描不会修改笔记；看板操作可写回本机笔记。',
      obsidianAutoDetect: '自动发现',
      obsidianAutoDetectOn: '已开启',
      obsidianAutoDetectOff: '已关闭',
      obsidianAutoDetectHint: '在桌面/文档等目录自动探测含 .obsidian 的库（roots 为空时生效）',
      obsidianVaults: '检测到的库',
      obsidianVaultsEmpty: '没找到含 .obsidian 的库，可在 settings.json 手动添加 markdownRoots',
      obsidianAttach: '接入',
      obsidianAttached: '已接入',
      obsidianRoots: '已接入目录',
      obsidianRootsEmpty: '还没有接入任何笔记目录',
      obsidianRemove: '移除',
      obsidianRules: '识别规则',
      obsidianRuleCheckbox: '复选框',
      obsidianRuleCheckboxHint: '识别 - [ ] / - [x] 任务行（始终启用）',
      obsidianRuleTag: '#todo 标签行',
      obsidianRuleTagHint: '识别含 #todo / #task / #待办 的行',
      obsidianRuleMarker: 'TODO: 标记',
      obsidianRuleMarkerHint: '识别行内 TODO: / 待办：标记',
      obsidianRuleFrontmatter: 'frontmatter todo',
      obsidianRuleFrontmatterHint: 'frontmatter 含 todo:true 或 status:todo',
      obsidianRuleFrontmatterList: 'frontmatter 列表',
      obsidianRuleFrontmatterListHint: 'frontmatter 的 todos: 列表项',
      obsidianReadonly: '只读',
      obsidianRescan: '重新扫描',
      obsidianRescanning: '扫描中…',
      obsidianLoading: '正在读取数据源…',
      obsidianError: '数据源操作失败',
      obsidianRetry: '重试',
      obsidianNotes: '条笔记',
      obsidianSaved: '已保存',
      tabTodos: '待办',
      tabSources: '数据源',
      tabAria: '看板视图切换',
      sourcesSummary: '数据源与自动识别设置',
    };

    const en = {
      nav: 'Todos',
      title: 'Leo Status',
      subtitle: 'Todos · track after accepting',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      refreshHint: 'Rescan notes and sessions on disk',
      lastScan: 'Last scan',
      statOpen: 'Open',
      statOverdue: 'Overdue',
      statToday: 'Today',
      statSoon: 'Next 7 days',
      statDone: 'Completed',
      searchPlaceholder: 'Search todos…',
      searchLabel: 'Search todos (matches text, headings or tags)',
      clearSearch: 'Clear search',
      allSources: 'All',
      filterBySource: 'Filter by source',
      hideDone: 'Hide completed',
      groupOverdue: 'Overdue',
      groupToday: 'Today',
      groupSoon: 'Next 7 days',
      groupLater: 'Later',
      groupUndated: 'No date',
      groupDone: 'Completed',
      expandDone: 'Expand completed',
      collapseDone: 'Collapse completed',
      cancelled: 'Cancelled',
      staleWarning: 'Data may be stale',
      loading: 'Loading todos…',
      emptyTitle: 'No todos yet',
      emptyBefore: 'Write ',
      emptyCode: '- [ ] a task',
      emptyAfter: ' in an Obsidian note and refresh to see it here. Session suggestions must be accepted first.',
      filteredEmptyTitle: 'No matching todos',
      filteredEmptyBody: 'Try another keyword or loosen the source filter.',
      clearFilters: 'Clear filters',
      offlineTitle: 'Cannot reach the host',
      offlineBody: 'No todo data was returned. Make sure the leo-status host plugin is enabled, then retry.',
      retry: 'Retry',
      untitled: '(no text)',
      sessionFallback: 'DSH session',
      due: 'Due',
      overdue: 'Overdue',
      today: 'Today',
      dayUnit: 'days',
      priority: 'Priority',
      priorityHighest: 'Highest',
      priorityHigh: 'High',
      priorityMedium: 'Medium',
      priorityLow: 'Low',
      priorityLowest: 'Lowest',
      took: 'Scan time',
      files: 'Files',
      sources: 'Sources',
      sourceErrors: 'Source errors',
      loadFailed: 'Failed to load',
      deviceLocal: 'This device',
      allDevices: 'All devices',
      devicesUnit: 'devices',
      devicesLabel: 'Devices',
      device: 'Device',
      filterByDevice: 'Filter by device',
      online: 'Online',
      offline: 'Offline',
      hubStatus: 'Hub',
      deviceConnected: 'Connected to hub',
      deviceOffline: 'Hub offline',
      hubOfflineTitle: 'Hub unreachable, showing local cache',
      lastSync: 'Last sync',
      relayStarting: 'Relay connecting…',
      relayRunning: 'Relay online',
      relayStopped: 'Relay offline',
      relayDisabled: 'Relay disabled',
      joinTitle: 'Join a leo-status hub',
      joinIntro: 'Enter the hub URL and password to sync this device to the shared board.',
      joinHubUrl: 'Hub URL',
      joinPassword: 'Password',
      joinName: 'Device name',
      joinRootLabel: 'Notes folder (optional)',
      joinRootPlaceholder: 'e.g. C:\\notes',
      joinSubmit: 'Join hub',
      joinSubmitting: 'Joining…',
      joinFailed: 'Join failed',
      actionCancel: 'Cancel',
      actionRestore: 'Restore',
      actionDelete: 'Delete',
      actionDeleteConfirm: 'Click again to confirm deletion',
      actionFailed: 'Action failed',
      actionPending: 'Working…',
      actionDismiss: 'Dismiss',
      checkDone: 'Mark done',
      checkUndone: 'Mark undone',
      yuanName: 'Yuan',
      intakeEvidence: 'View source and evidence',
      intakeOwner: 'Owner: Leo · Accept adds to the board without editing source notes',
      intakeHint: 'Review session and other suggestions before accepting. Obsidian vault tasks enter the board automatically.',
      intakeMore: 'Show more suggestions',
      yuanStop: 'Stop execution',
      yuanEntryTitle: 'Open Yuan',
      yuanPanelAria: 'Yuan panel',
      yuanSubtitle: 'Board assistant',
      yuanModelLabel: 'Model',
      yuanModelOffline: 'Offline (no model)',
      yuanClose: 'Close',
      yuanOpenPanel: 'Open Yuan panel',
      yuanSuggestionCard: 'Yuan suggestions',
      yuanPendingCount: 'pending',
      yuanSourceSession: 'From a session',
      yuanSourceNote: 'From a note',
      yuanSuggestSection: 'Pending suggestions',
      yuanSuggestEmpty: 'No pending suggestions',
      yuanAccept: 'Accept',
      yuanDismiss: 'Dismiss',
      yuanAccepted: 'Accepted',
      yuanDismissed: 'Dismissed',
      yuanReminderSection: 'Reminders',
      yuanReminderEmpty: 'No reminders',
      yuanReminderDone: 'Done',
      yuanReminderExpired: 'Overdue',
      yuanChatSection: 'Chat',
      yuanChatEmpty: 'No messages yet - ask Yuan something',
      yuanThinking: 'Yuan is thinking…',
      yuanInputPlaceholder: 'Ask Yuan… (Enter to send, Shift+Enter for newline)',
      yuanSend: 'Send',
      yuanYou: 'You',
      yuanAssistant: 'Yuan',
      yuanMemorySection: 'Memory',
      yuanMemoryEmpty: 'No memories yet',
      yuanMemoryDelete: 'Delete memory',
      yuanRememberHint: 'Type "remember: …" to teach Yuan',
      yuanLoading: 'Connecting to Yuan…',
      yuanError: 'Yuan error',
      yuanRetry: 'Retry',
      yuanProposalTodo: 'Suggested todo',
      yuanProposalMemory: 'Remembered',
      yuanProposalReminder: 'Reminder',
      yuanChipSuggest: 'Suggestions',
      yuanChipReminder: 'Reminders',
      yuanChipDeadline: 'Deadlines',
      yuanExpandMemory: 'Expand memory',
      yuanCollapseMemory: 'Collapse memory',
      yuanSignalEmpty: 'No signals',
      yuanWelcome: 'Hi, I am Yuan. Ask me anything about your board.',
      yuanQuickHint: 'Try asking:',
      yuanQuick1: 'What should I do first today?',
      yuanQuick2: 'Remember: I do not check new tasks at night',
      yuanQuick3: 'Remind me to submit the report on Friday',
      yuanSending: 'Sending…',
      yuanRetrySend: 'Retry sending',
      yuanSendFailed: 'Message failed',
      yuanCopy: 'Copy',
      yuanCopied: 'Copied',
      yuanCopyCode: 'Copy code',
      yuanSuggestionTag: 'Suggestion',
      yuanMemoryPending: 'Pending',
      yuanMemoryConfirm: 'Confirm',
      yuanMemoryAdd: 'Remember: …',
      yuanComposerHint: 'Enter to send · Shift+Enter for newline',
      toolCall: 'Tool call',
      toolResult: 'Result',
      toolError: 'Error',
      toolPending: 'Called',
      toolArgs: 'Arguments',
      toolExpand: 'Expand',
      toolCollapse: 'Collapse',
      agentReady: 'Tools connected',
      agentDegraded: 'Tools degraded',
      yuanAgentHint: 'Yuan can call tools to read files; it usually will not browse your files unless it needs to.',
      openNativeSession: 'Native session',
      openNativeSessionHint: 'Open Yuan agent session in the native DSH chat UI',
      obsidianCardTitle: 'Data sources · Obsidian auto-detect',
      obsidianCardHint: 'Obsidian vault tasks enter the board automatically. Scanning does not edit notes; board actions can update local notes.',
      obsidianAutoDetect: 'Auto-detect',
      obsidianAutoDetectOn: 'On',
      obsidianAutoDetectOff: 'Off',
      obsidianAutoDetectHint: 'Scan common folders for vaults containing .obsidian (when roots are empty)',
      obsidianVaults: 'Detected vaults',
      obsidianVaultsEmpty: 'No vaults with .obsidian found; add markdownRoots in settings.json manually',
      obsidianAttach: 'Attach',
      obsidianAttached: 'Attached',
      obsidianRoots: 'Attached folders',
      obsidianRootsEmpty: 'No folders attached yet',
      obsidianRemove: 'Remove',
      obsidianRules: 'Parsing rules',
      obsidianRuleCheckbox: 'Checkboxes',
      obsidianRuleCheckboxHint: 'Detect - [ ] / - [x] task lines (always on)',
      obsidianRuleTag: '#todo tag lines',
      obsidianRuleTagHint: 'Detect lines containing #todo / #task or the configured tags',
      obsidianRuleMarker: 'TODO: markers',
      obsidianRuleMarkerHint: 'Detect inline TODO: / reminder markers',
      obsidianRuleFrontmatter: 'frontmatter todo',
      obsidianRuleFrontmatterHint: 'frontmatter with todo:true or status:todo',
      obsidianRuleFrontmatterList: 'frontmatter list',
      obsidianRuleFrontmatterListHint: 'Items in the frontmatter todos: list',
      obsidianReadonly: 'Read-only',
      obsidianRescan: 'Rescan',
      obsidianRescanning: 'Scanning…',
      obsidianLoading: 'Reading data sources…',
      obsidianError: 'Data source action failed',
      obsidianRetry: 'Retry',
      obsidianNotes: 'notes',
      obsidianSaved: 'Saved',
      tabTodos: 'Todos',
      tabSources: 'Data sources',
      tabAria: 'Board view tabs',
      sourcesSummary: 'Data sources and auto-detect settings',
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
.ls-yuan-entry{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;flex:none}
.ls-yuan-entry:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-yuan-entry:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.ls-yuan-entry.is-open{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1))}
.ls-yuan-dot{position:absolute;top:-2px;right:-2px;width:8px;height:8px;border-radius:50%;border:2px solid var(--dsw-alias-bg-layer-1);background:var(--dsw-alias-brand-primary);box-sizing:content-box}
.ls-yuan-dot.is-urgent{background:var(--dsw-alias-state-error-primary)}
.ls-yuan-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.ls-yuan-dot.is-info{background:var(--dsw-alias-brand-primary)}
.ls-yuan-panel{margin:6px 0 4px;max-height:52vh;overflow-y:auto;box-sizing:border-box;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;display:flex;flex-direction:column;gap:10px}
.ls-yuan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.ls-yuan-head__main{display:flex;flex-direction:column;gap:2px;min-width:0}
.ls-yuan-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px}
.ls-yuan-title__icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--dsw-radius-xs);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-size:12px;font-weight:600}
.ls-yuan-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-yuan-close{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;flex:none}
.ls-yuan-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-yuan-close:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-yuan-head__actions{display:flex;align-items:center;gap:6px;flex:none}
.ls-yuan-native{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:10px;line-height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.ls-yuan-native:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-yuan-native:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-yuan-chips{display:flex;flex-wrap:wrap;gap:6px}
.ls-yuan-chip{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11px;line-height:20px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.ls-yuan-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-yuan-chip--urgent{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1))}
.ls-yuan-chip--warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1))}
.ls-yuan-section{display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.ls-yuan-section__title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ls-yuan-card{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.ls-yuan-card--expired{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1))}
.ls-yuan-card__text{font-size:13px;word-break:break-word}
.ls-yuan-card__meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ls-yuan-card__meta--error{color:var(--dsw-alias-state-error-primary)}
.ls-yuan-reasons{display:flex;flex-wrap:wrap;gap:4px}
.ls-yuan-reason{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.ls-yuan-actions{display:flex;flex-wrap:wrap;gap:6px}
.ls-yuan-btn{display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:12px;line-height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.ls-yuan-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.ls-yuan-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-yuan-btn:disabled{opacity:.5;cursor:default}
.ls-yuan-btn--primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.ls-yuan-btn--primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);opacity:.9}
.ls-yuan-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-error{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.ls-yuan-notice{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.ls-yuan-chat{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;padding-right:2px}
.ls-yuan-msg{max-width:88%;display:flex;flex-direction:column;gap:2px;padding:6px 9px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.ls-yuan-msg--user{align-self:flex-end;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}
.ls-yuan-msg--assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-yuan-msg__meta{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-proposals{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.ls-yuan-proposal{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-yuan-thinking{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-yuan-memory-toggle{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font:inherit;font-size:12px;line-height:22px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ls-yuan-memory-toggle:hover{color:var(--dsw-alias-label-primary)}
.ls-yuan-memory-toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px;border-radius:var(--dsw-radius-sm)}
.ls-yuan-memory{display:flex;flex-wrap:wrap;gap:6px}
.ls-yuan-mem{display:inline-flex;align-items:center;gap:4px;max-width:100%;font-size:11px;line-height:18px;padding:0 4px 0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ls-yuan-mem__text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-yuan-mem__del{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;cursor:pointer;flex:none}
.ls-yuan-mem__del:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1)}
.ls-yuan-composer{display:flex;align-items:flex-end;gap:6px}
.ls-yuan-input{flex:1 1 auto;min-width:0;min-height:30px;max-height:88px;padding:6px 8px;font:inherit;font-size:13px;line-height:1.4;resize:none;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);outline:none}
.ls-yuan-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ls-yuan-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px;border-color:transparent}
.ls-yuan-hint{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-pagecard{margin-bottom:16px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.ls-yuan-pagecard__head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.ls-yuan-pagecard__title{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:600}
.ls-yuan-pagecard__count{font-size:11px;font-weight:500;line-height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ls-yuan-pagecard__list{display:flex;flex-direction:column;gap:6px}
.ls-yuan-pagecard__row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}
.ls-yuan-pagecard__row:first-child{border-top:none;padding-top:0}
.ls-yuan-pagecard__text{min-width:0;flex:1 1 240px;font-size:13px}
.ls-yuan-pagecard__meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:block;margin-top:2px}
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
.ls-yuan-msgrow{display:flex;align-items:flex-start;gap:8px;max-width:100%}
.ls-yuan-msgrow--user{justify-content:flex-end}
.ls-yuan-avatar{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:600;flex:none;margin-top:2px}
.ls-yuan-msgbody{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:calc(100% - 34px)}
.ls-yuan-msgbody--user{max-width:82%;align-items:flex-end}
.ls-yuan-msghead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-msghead--user{justify-content:flex-end}
.ls-yuan-msgname{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ls-yuan-model{font-size:9px;line-height:14px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ls-yuan-msgtime{font-variant-numeric:tabular-nums}
.ls-yuan-msgtext{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;min-width:0}
.ls-yuan-bubble{max-width:100%;padding:6px 10px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.ls-yuan-copy{display:inline-flex;align-items:center;justify-content:center;height:18px;padding:0 6px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:9px;line-height:18px;cursor:pointer;opacity:0;transition:opacity .12s ease}
.ls-yuan-msgrow:hover .ls-yuan-copy{opacity:1}
.ls-yuan-copy:focus-visible{opacity:1;outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-yuan-markdown{display:flex;flex-direction:column;gap:5px;min-width:0}
.ls-yuan-md-p{margin:0;font-size:12px;line-height:1.65}
.ls-yuan-md-heading{margin:2px 0 0;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-yuan-md-heading--1{font-size:14px}
.ls-yuan-md-heading--2{font-size:13px}
.ls-yuan-md-heading--3,.ls-yuan-md-heading--4,.ls-yuan-md-heading--5,.ls-yuan-md-heading--6{font-size:12px}
.ls-yuan-md-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:1.55}
.ls-yuan-md-li{word-break:break-word}
.ls-yuan-md-quote{margin:0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.ls-yuan-md-hr{width:100%;margin:4px 0;border:none;border-top:1px solid var(--dsw-alias-border-l1)}
.ls-yuan-inline-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-yuan-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.ls-yuan-link:hover{text-decoration:underline}
.ls-yuan-task{display:inline-flex;align-items:flex-start;gap:5px}
.ls-yuan-task--done{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.ls-yuan-task__box{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary);margin-top:1px}
.ls-yuan-task--done .ls-yuan-task__box{color:var(--dsw-alias-state-success-primary)}
.ls-yuan-code{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);overflow:hidden}
.ls-yuan-code__head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:22px;padding:2px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ls-yuan-code__lang{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-code-copy{font:inherit;font-size:10px;line-height:18px;padding:0 6px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ls-yuan-code-copy:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.ls-yuan-code-copy:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-yuan-code__pre{margin:0;padding:8px 10px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-primary)}
.ls-yuan-welcome{display:flex;flex-direction:column;gap:8px}
.ls-yuan-welcome__text{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ls-yuan-quick{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.ls-yuan-quick__hint{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-quick__chip{font:inherit;font-size:10px;line-height:20px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ls-yuan-quick__chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-yuan-quick__chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-yuan-thinking{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-yuan-dots{display:inline-flex;align-items:center;gap:3px}
.ls-yuan-dots__dot{width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary);animation:ls-yuan-dot 1.1s ease-in-out infinite}
.ls-yuan-dots__dot:nth-child(2){animation-delay:.15s}
.ls-yuan-dots__dot:nth-child(3){animation-delay:.3s}
.ls-yuan-retry{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);font-size:11px;color:var(--dsw-alias-state-error-primary)}
.ls-yuan-toolcard{gap:5px}
.ls-yuan-toolcard__head{display:flex;align-items:center;gap:6px;min-width:0}
.ls-yuan-toolcard__icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--dsw-radius-xs);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);flex:none}
.ls-yuan-toolcard__tag{font-size:10px;font-weight:600;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-yuan-toolcard__source{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-memcard{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.ls-yuan-memcard--pending{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1))}
.ls-yuan-memcard__main{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.ls-yuan-memcard__text{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.ls-yuan-badge{font-size:9px;line-height:14px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-yuan-badge--pending{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.ls-yuan-memory{display:flex;flex-direction:column;gap:4px}
.ls-yuan-memory-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:6px}
.ls-yuan-input{max-height:132px}
.ls-yuan-send{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;flex:none}
.ls-yuan-send:hover:not(:disabled){opacity:.9}
.ls-yuan-send:disabled{opacity:.45;cursor:default}
.ls-yuan-send:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.ls-yuan-composer-hint{margin-top:2px;font-size:10px;color:var(--dsw-alias-label-tertiary);text-align:right}
@keyframes ls-yuan-dot{0%,80%,100%{opacity:.35;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
.ls-yuan-tools{display:flex;flex-direction:column;gap:5px}
.ls-yuan-tool{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}
.ls-yuan-tool--error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent)}
.ls-yuan-tool__head{display:flex;align-items:center;gap:6px;min-width:0}
.ls-yuan-tool__icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-tool__name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}
.ls-yuan-tool__state{font-size:9px;line-height:14px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none}
.ls-yuan-tool--error .ls-yuan-tool__state{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.ls-yuan-tool__toggle{font:inherit;font-size:10px;line-height:18px;padding:0 6px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.ls-yuan-tool__toggle:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ls-yuan-tool__toggle:disabled{opacity:.6;cursor:default}
.ls-yuan-tool__toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.ls-yuan-tool__toggle--args{margin-left:auto}
.ls-yuan-tool__args{display:block;width:100%;box-sizing:border-box;text-align:left;font:inherit;font-size:10px;line-height:16px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ls-yuan-tool__args:hover{color:var(--dsw-alias-label-primary)}
.ls-yuan-tool__args:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px;border-radius:var(--dsw-radius-xs)}
.ls-yuan-tool__pre{margin:0;padding:4px 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
.ls-yuan-tool__pre--error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.ls-yuan-tool__result{display:flex;flex-direction:column;gap:4px}
.ls-yuan-agent{font-size:9px;line-height:14px;padding:0 5px;border-radius:999px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);white-space:nowrap}
.ls-yuan-agent--degraded{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.ls-yuan-welcome__hint{font-size:10px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
@media (max-width:720px){.ls-yuan-panel{max-height:60vh}.ls-yuan-pagecard{padding:12px}}
@keyframes ls-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes ls-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (max-width:720px){.ls-page{padding:20px 16px}.ls-stat{flex-basis:calc(50% - 5px)}.ls-badge{max-width:110px}.ls-tags{display:none}.ls-switch{margin-left:0}.ls-conn{max-width:200px}.ls-device-badge{max-width:90px}.ls-join__grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.ls-refresh--busy .ls-refresh__icon{animation:none}.ls-skel{animation:none}}

/* Native Yuan: a launcher, never a second composer. */
.ls-yuan-launch{position:relative;display:inline-flex;align-items:center}
.ls-yuan-entry{width:34px;height:34px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.ls-yuan-entry:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.ls-yuan-entry:disabled{opacity:.5;cursor:wait}
.ls-yuan-native{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-native-name{display:inline-flex;align-items:center;gap:6px;font-weight:600;margin-right:4px}
.ls-yuan-native .ls-yuan-btn{font-size:12px;padding:3px 8px}
.ls-context-chip{max-width:170px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:4px 8px;border-radius:20px;font:inherit;cursor:pointer}
.ls-native-popover{box-sizing:border-box;position:fixed;z-index:1000;right:24px;top:110px;width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 145px);overflow:auto;padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 40px #0002;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;text-align:left;white-space:normal}
.ls-native-popover *{box-sizing:border-box}
.ls-native-popover-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-size:14px}
.ls-native-popover pre,.ls-native-popover blockquote{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;padding:8px 12px;border-left:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.ls-native-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);margin:6px 0 14px}
.ls-native-error{position:absolute;z-index:1001;right:0;top:38px;width:280px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;white-space:normal;box-shadow:0 8px 24px #0002}
.ls-native-empty{padding:30px 8px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.ls-history-row{display:flex;justify-content:space-between;gap:14px;align-items:center;width:100%;padding:12px 8px;background:transparent;color:inherit;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;cursor:pointer;font:inherit}
.ls-history-row:hover{background:var(--dsw-alias-bg-layer-1)}
.ls-history-row small{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}
.ls-memory-row{padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
.ls-memory-row p{margin:8px 0;white-space:pre-wrap;line-height:1.65}
.ls-memory-row details{font-size:12px;color:var(--dsw-alias-label-secondary);margin:8px 0}
.ls-memory-row summary{cursor:pointer}
.ls-memory-row blockquote{margin:8px 0;padding:8px 12px;border-left:2px solid var(--dsw-alias-border-l2);white-space:pre-wrap}
.ls-memory-edit{width:100%;min-height:90px;resize:vertical;font:inherit;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit}
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
.ls-review .ls-yuan-card{margin-bottom:10px}
@media(max-width:640px){.ls-page{padding:20px 16px}.ls-head{gap:12px;margin-bottom:20px}.ls-title{font-size:20px}.ls-head__meta{justify-content:flex-start}.ls-head .ls-conn{font-size:11px;padding:0 4px}.ls-stat{padding:0 8px}.ls-stat__num{font-size:20px}.ls-stat__label{font-size:11px}.ls-native-popover{right:12px;top:105px;max-width:calc(100vw - 24px)}.ls-native-name{display:none}.ls-context-chip{max-width:110px}}
.ls-yuan-float{position:fixed;right:24px;bottom:24px;z-index:120;pointer-events:auto;display:flex;flex-direction:column;width:620px;height:720px;max-width:calc(100vw - 32px);max-height:calc(100vh - 72px);min-width:min(380px,calc(100vw - 32px));min-height:320px;resize:both;overflow:hidden;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 16px 60px #0003;font-size:14px}
.ls-yuan-float-wide{width:940px;height:850px}
.ls-yuan-float{resize:none}
.ls-yuan-resize{position:absolute;bottom:4px;right:4px;width:28px;height:28px;padding:4px;border:0;background:var(--dsw-alias-bg-layer-1);border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:nwse-resize;touch-action:none;z-index:5;display:grid;place-items:center}
.ls-yuan-float-foot{flex:none;height:28px;padding:5px 40px 5px 16px;font-size:10px;color:var(--dsw-alias-label-tertiary);box-sizing:border-box}
.ls-yuan-whale{flex:none;transition:transform .18s}.ls-yuan-entry:hover .ls-yuan-whale,.ls-yuan-bubble:hover .ls-yuan-whale{transform:translateY(-2px) rotate(-7deg)}
@media(prefers-reduced-motion:reduce){.ls-yuan-whale{transition:none}.ls-yuan-entry:hover .ls-yuan-whale,.ls-yuan-bubble:hover .ls-yuan-whale{transform:none}}
.ls-yuan-view-tabs{display:flex;gap:20px;padding:8px 18px 0;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);position:sticky;top:0;z-index:3}
.ls-yuan-view-tabs button{font:inherit;font-size:13px;padding:6px 0;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
.ls-yuan-view-tabs button[aria-selected=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ls-yuan-float-head{display:flex;align-items:center;gap:8px;flex:none;padding:14px 16px 10px;cursor:move;touch-action:none;user-select:none}
.ls-yuan-float-identity{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.ls-yuan-float-identity strong{font-size:16px}.ls-yuan-float-identity span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ls-yuan-float>.ls-yuan-native{padding:0 12px 10px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;cursor:default;flex:none;background:transparent}
.ls-yuan-float-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden}
.ls-yuan-float-body>[data-conversation-content]{flex:1;min-height:0;--dsh-chat-user-width:100%;--dsh-chat-content-padding:16px}
.ls-yuan-float .ls-native-popover{position:absolute;top:92px;right:12px;max-height:calc(100% - 110px);max-width:calc(100% - 24px);z-index:10}
.ls-yuan-bubble{position:fixed;right:24px;bottom:24px;pointer-events:auto;display:flex;align-items:center;gap:8px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 6px 24px #0002;cursor:grab;touch-action:none;user-select:none;z-index:120}
.ls-yuan-bubble:active{cursor:grabbing}
.ls-yuan-float-head:active{cursor:grabbing}
@media(max-width:640px){.ls-yuan-float{right:8px;bottom:8px;max-width:calc(100vw - 16px);height:75vh;max-height:calc(100vh - 48px)}.ls-yuan-float-identity span{display:none}.ls-yuan-float-head{padding:10px}.ls-yuan-float-head .ls-yuan-btn{padding:3px 6px}.ls-yuan-bubble{right:12px;bottom:12px}}
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

    // -- small pure helpers ------------------------------------------------------

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
          h(YuanEntry, { location: 'Leo 待办' }),
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

      // Yuan (阿源) store: subscribe for the top suggestion card and apply boards
      // returned by accepted suggestions.
      const yuanStore = useYuanStore();
      const appliedYuanBoard = useRef(0);
      useEffect(() => {
        if (yuanStore.boardSeq > 0 && yuanStore.boardSeq !== appliedYuanBoard.current && yuanStore.lastBoard !== null) {
          appliedYuanBoard.current = yuanStore.boardSeq;
          applyBoard(yuanStore.lastBoard);
        }
      }, [yuanStore.boardSeq, yuanStore.lastBoard, applyBoard]);

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
      const yuanSuggestions =
        yuanStore.state !== null && Array.isArray(yuanStore.state.suggestions)
          ? yuanStore.state.suggestions
          : boardSuggestions;
      const yuanPending = pendingSuggestions(yuanSuggestions);

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
      const acceptYuanSuggestion = (id) => {
        yuanStore.acceptSuggestion(id);
      };
      const dismissYuanSuggestion = (id) => {
        yuanStore.dismissSuggestion(id);
      };
      const openYuanPanel = () => {
        yuanStore.openPanel();
      };

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
            h('button', { type: 'button', role: 'tab', className: 'ls-tab' + (activeTab === 'suggestions' ? ' ls-tab--active' : ''), 'aria-selected': activeTab === 'suggestions', onClick: () => switchTab('suggestions') }, '待确认', yuanPending.length ? h('span', { className: 'ls-count' }, yuanPending.length) : null),
            h('button', { type: 'button', role: 'tab', className: 'ls-tab' + (activeTab === 'memory' ? ' ls-tab--active' : ''), 'aria-selected': activeTab === 'memory', onClick: () => switchTab('memory') }, '记忆'),
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
          activeTab === 'suggestions' ? h(SuggestionReview, { t, store: yuanStore }) : null,
          activeTab === 'memory' ? h(MemoryBrowser) : null,
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

    // -- sidebar checklist glyph -------------------------------------------------

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

    // -- plugin apply ------------------------------------------------------------

    function apply(ctx) {
      clientContext = ctx;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'leo-status: dictionaries');
      boundT = ctx.locale.bind(NS);

      ctx.effect(() => insertStyle('leo-status/client.css', CSS), 'leo-status: client styles');
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'leo-yuan-float', order: 50,
        children: { 'leo.yuan.conversation': { kind: 'single', scope: 'session' } } }, YuanFloatingPanel)), 'leo-status: yuan floating surface');
      ctx.effect(() => ctx.slots.inject('leo.yuan.conversation', () => ctx.slots.register({ name: 'leo.yuan.conversation' }, YuanEmbeddedChat)), 'leo-status: embedded native conversation');

      // The sidebar nav row: id must equal the `main` key so the shell can select it.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 20,
                label: () => boundT('nav'),
                locale: NS,
              },
              LeoIcon,
            ),
          ),
        'leo-status: sidebar entry',
      );

      // The full page mounted when the nav row is selected.
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
              },
              DashboardPage,
            ),
          ),
        'leo-status: dashboard page',
      );

      // 阿源: a small launcher and utilities on its native DSH session.
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'leo-yuan',
                order: 100,
                locale: NS,
              },
              YuanEntry,
            ),
          ),
        'leo-status: yuan entry',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'leo-yuan-native',
                order: 5,
                locale: NS,
              },
              YuanNativeTools,
            ),
          ),
        'leo-status: yuan native tools',
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});

