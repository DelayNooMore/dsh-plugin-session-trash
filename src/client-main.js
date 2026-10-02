// Client half for dsh-plugin-session-trash. Loaded by the DSH client ModuleLoader;
// tools/build.mjs bundles this file with esbuild (format=esm) and rewrites the
// two external namespace imports into loader-scope require() calls, keeping
// createPlugin as a flat function declaration in the factory body.
'use strict';

import * as React from 'react';
import * as P from '@deepseek-ai/dsh-client-ui-primitives';
import { TYPERT_REMOTE } from './remote.js';

const h = React.createElement;
const PLUGIN_ID = 'dsh-plugin-session-trash';
const DANGER_COLOR = '#e5484d';

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
const STRINGS = {
  zh: {
    menuTrash: '移入回收站',
    settingsNav: '回收站',
    dialogPurgeTitle: '永久删除会话',
    dialogPurgeDesc: '永久删除「{title}」？此操作不可撤销。',
    dialogPurgeAllTitle: '清空回收站',
    dialogPurgeAllDesc: '永久删除回收站中的全部会话？此操作不可撤销。',
    dialogPurgeConfirm: '永久删除',
    toastTrashed: '已移入回收站，可在「设置 → 回收站」中恢复或清空',
    toastLinger: '已移入回收站。该会话在本次运行中被打开过，侧栏条目要等重启应用后才会消失。',
    toastPurged: '已永久删除',
    toastPurgedAll: '回收站已清空',
    cancel: '取消',
    close: '关闭',
    pending: '正在处理…',
    untitled: '未命名会话',
    empty: '回收站是空的。',
    loading: '正在加载…',
    refresh: '刷新',
    reveal: '打开回收站文件夹',
    purgeAll: '清空回收站',
    restore: '恢复',
    purge: '永久删除',
    restoredAttached: '已恢复到原工作区。',
    restoredDetached: '会话文件已恢复，但未能重新挂接到工作区。',
    listFailed: '读取回收站失败。',
    reasonBusy: '会话正在运行，请先停止后再删除。',
    reasonNotFound: '会话目录不存在（可能已被删除）。',
    reasonDetachFailed: '从工作区移除登记失败，已取消删除。',
    reasonMoveFailed: '移动会话目录失败。',
    reasonTargetExists: '原位置已存在同名目录。',
    reasonConfirmRequired: '操作缺少确认参数。',
    reasonIOError: '文件操作失败。',
    reasonBadRequest: '请求参数无效。',
    reasonGeneric: '操作失败。',
  },
  en: {
    menuTrash: 'Move to Trash',
    settingsNav: 'Trash',
    dialogPurgeTitle: 'Purge Session',
    dialogPurgeDesc: 'Permanently delete “{title}”? This cannot be undone.',
    dialogPurgeAllTitle: 'Empty Trash',
    dialogPurgeAllDesc: 'Permanently delete every session in the trash? This cannot be undone.',
    dialogPurgeConfirm: 'Delete Permanently',
    toastTrashed: 'Moved to trash. Restore or empty it in Settings → Trash.',
    toastLinger: 'Moved to trash. This session was opened during the current run; its sidebar row will disappear after the app restarts.',
    toastPurged: 'Deleted permanently',
    toastPurgedAll: 'Trash emptied',
    cancel: 'Cancel',
    close: 'Close',
    pending: 'Working…',
    untitled: 'Untitled session',
    empty: 'The trash is empty.',
    loading: 'Loading…',
    refresh: 'Refresh',
    reveal: 'Open Trash Folder',
    purgeAll: 'Empty Trash',
    restore: 'Restore',
    purge: 'Delete Permanently',
    restoredAttached: 'Restored to its workspace.',
    restoredDetached: 'Session files restored, but re-attaching to the workspace failed.',
    listFailed: 'Failed to read the trash.',
    reasonBusy: 'The session is running; stop it before deleting.',
    reasonNotFound: 'Session directory does not exist (it may already be gone).',
    reasonDetachFailed: 'Failed to detach the session from its workspace; nothing was deleted.',
    reasonMoveFailed: 'Failed to move the session directory.',
    reasonTargetExists: 'A directory already exists at the original location.',
    reasonConfirmRequired: 'Operation is missing its confirmation flag.',
    reasonIOError: 'File operation failed.',
    reasonBadRequest: 'Invalid request.',
    reasonGeneric: 'Operation failed.',
  },
};

const langState = { lang: 'zh', listeners: new Set() };
function setLang(lang) {
  if (langState.lang === lang) return;
  langState.lang = lang;
  for (const cb of [...langState.listeners]) {
    try { cb(lang); } catch { /* one bad listener must not break the rest */ }
  }
}
function detectLang(locale) {
  let raw = null;
  try { raw = locale?.getSnapshot?.().active ?? null; } catch { /* fall through */ }
  if (typeof raw !== 'string' || raw === '') {
    raw = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
  }
  return /^zh/i.test(raw) ? 'zh' : 'en';
}
function observeLang(locale) {
  try {
    const off = locale?.subscribe?.(() => setLang(detectLang(locale)));
    if (typeof off !== 'function') return () => {};
    return off;
  } catch { return () => {}; }
}
function t(key) {
  const dict = STRINGS[langState.lang] ?? STRINGS.en;
  return dict[key] ?? STRINGS.en[key] ?? key;
}
function fmt(template, values) {
  return Object.entries(values).reduce((acc, [name, value]) => acc.split(`{${name}}`).join(String(value)), template);
}
function useLang() {
  const [lang, setLangState] = React.useState(langState.lang);
  React.useEffect(() => {
    const cb = (v) => setLangState(v);
    langState.listeners.add(cb);
    return () => { langState.listeners.delete(cb); };
  }, []);
  return lang;
}
function reasonText(reason) {
  const key = ({
    busy: 'reasonBusy',
    'not-found': 'reasonNotFound',
    'detach-failed': 'reasonDetachFailed',
    'move-failed': 'reasonMoveFailed',
    'target-exists': 'reasonTargetExists',
    'confirm-required': 'reasonConfirmRequired',
    'io-error': 'reasonIOError',
    'bad-request': 'reasonBadRequest',
  })[reason];
  return key ? t(key) : `${t('reasonGeneric')}${reason ? ` (${reason})` : ''}`;
}

// ---------------------------------------------------------------------------
// Pending-dialog store (menu items unmount when the menu closes, the overlay
// entry in shell.overlay survives them)
// ---------------------------------------------------------------------------
const dialogStore = {
  state: null,
  listeners: new Set(),
  open(next) { this.state = next; this.emit(); },
  close() { this.state = null; this.emit(); },
  emit() {
    for (const cb of [...this.listeners]) {
      try { cb(this.state); } catch { /* ignore */ }
    }
  },
};
function useDialogState() {
  const [state, setState] = React.useState(dialogStore.state);
  React.useEffect(() => {
    const cb = (v) => setState(v);
    dialogStore.listeners.add(cb);
    return () => { dialogStore.listeners.delete(cb); };
  }, []);
  return state;
}

// ---------------------------------------------------------------------------
// RPC plumbing (whale-pet pattern: local $mount + one-shot inject fiber)
// ---------------------------------------------------------------------------
let activeCtx = null;
const remoteLeases = new WeakMap();

function callTrash(method, request) {
  const ctx = activeCtx;
  if (!ctx) return Promise.reject(new Error('sessionTrash client is not active'));
  return new Promise((resolve, reject) => {
    const owner = ctx.root ?? ctx;
    let lease = remoteLeases.get(owner);
    if (!lease) {
      lease = { mounted: null };
      remoteLeases.set(owner, lease);
    }
    if (!lease.mounted) {
      lease.mounted = new Promise((res, rej) => {
        try {
          const fiber = ctx.inject(['remote'], (scope) => {
            Promise.resolve(scope.remote?.$mount?.(TYPERT_REMOTE)).then(res, rej);
          });
          Promise.resolve(fiber)?.catch?.(rej);
        } catch (error) { rej(error); }
      });
      lease.mounted.catch(() => {
        if (remoteLeases.get(owner) === lease) remoteLeases.delete(owner);
      });
    }
    lease.mounted.then(() => {
      try {
        const fiber = ctx.inject(['remote.sessionTrash'], (scope) => {
          Promise.resolve(scope.remote.sessionTrash[method](request)).then(resolve, reject);
        });
        Promise.resolve(fiber)?.catch?.(reject);
      } catch (error) { reject(error); }
    }, reject);
  });
}

// Transport envelope {ok, value|error} vs domain result {ok, reason, ...}.
function unwrapResult(result) {
  if (result && typeof result === 'object' && ('value' in result || 'error' in result) && !('reason' in result)) {
    if (!result.ok) {
      const detail = result.error?.message ?? result.message ?? 'sessionTrash RPC failed';
      throw new Error(String(detail));
    }
    return result.value;
  }
  return result;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
const CSS_TEXT = `
.st-danger-button { color: ${DANGER_COLOR} !important; border-color: rgba(229,72,77,.55) !important; }
.st-danger-button:hover:not(:disabled) { background: rgba(229,72,77,.12) !important; }
.st-settings { display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
.st-toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
.st-list { list-style: none; margin: 0; padding: 0; border: 1px solid rgba(128,128,128,.25); border-radius: 10px; overflow: hidden; }
.st-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid rgba(128,128,128,.18); }
.st-row:last-child { border-bottom: none; }
.st-row:hover { background: rgba(128,128,128,.08); }
.st-row-main { min-width: 0; flex: 1; }
.st-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-meta { opacity: .65; font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-row-actions { display: flex; gap: 8px; flex-shrink: 0; }
.st-empty { opacity: .6; padding: 18px 2px; }
.st-notice { font-size: 13px; opacity: .85; }
.st-error { font-size: 13px; color: ${DANGER_COLOR}; }
`;

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(`${PLUGIN_ID}-css`)) return;
  const style = document.createElement('style');
  style.id = `${PLUGIN_ID}-css`;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

// The settings nav icon is hardcoded per section id inside DSH's settings
// shell (unknown ids get a generic gear). Swap the gear for the official
// trash artwork on our nav row. React owns the svg element, so the paths are
// replaced in place (innerHTML) and a MutationObserver re-applies them
// whenever the shell re-renders or re-mounts the nav.
const TRASH_ICON_PATHS =
  '<path d="M1.28149 3.88831H14.7187" stroke="currentColor"></path>' +
  '<path d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833" stroke="currentColor"></path>' +
  '<path d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831" stroke="currentColor"></path>' +
  '<path d="M6.44946 6.98926V11.1238" stroke="currentColor"></path>' +
  '<path d="M9.55054 6.98926V11.1238" stroke="currentColor"></path>';
let navIconTarget = null;
let navIconScheduled = false;
function swapNavIcon() {
  if (navIconTarget && navIconTarget.isConnected) return;
  navIconTarget = null;
  const labels = new Set([STRINGS.zh.settingsNav, STRINGS.en.settingsNav]);
  for (const span of document.querySelectorAll('span')) {
    const label = (span.textContent || '').trim();
    if (!labels.has(label)) continue;
    const svg = span.closest('button')?.querySelector('svg');
    if (!svg) continue;
    svg.innerHTML = TRASH_ICON_PATHS;
    navIconTarget = svg;
    return;
  }
}
function installNavIconSwap() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  swapNavIcon();
  new MutationObserver(() => {
    if (navIconScheduled) return;
    navIconScheduled = true;
    Promise.resolve().then(() => { navIconScheduled = false; swapNavIcon(); });
  }).observe(document.body, { childList: true, subtree: true });
}

// If the deleted session is the one the renderer will re-open on the next
// boot, drop the pointer so the dead session is not resurrected. Returns
// whether the pointer actually pointed at it.
// Ask the client session store to re-pull session/list: the trash/restore RPCs
// already settled on the Host, so one refresh applies the row add/remove in
// place — no page reload needed.
function refreshSessionList() {
  try {
    Promise.resolve(activeCtx?.get?.('sessions')?.refresh?.()).catch(() => { /* best effort */ });
  } catch { /* best effort */ }
}

function clearCurrentSessionPointer(sessionId) {
  try {
    const raw = localStorage.getItem('dsh.sessions.current');
    if (raw && JSON.parse(raw)?.sessionId === sessionId) {
      localStorage.removeItem('dsh.sessions.current');
      return true;
    }
  } catch { /* best effort */ }
  return false;
}
function TrashMenuItem(props) {
  useLang();
  const closeMenu = () => {
    try { props.useMenuOpenState?.()[1](false); } catch { /* menu state is optional */ }
  };
  return h(P.MenuItemButton, {
    danger: true,
    separatorBefore: true,
    icon: h(P.IconTrashOutlineRegular ?? P.IconEllipsisOutlineRegular, { size: 14 }),
    onSelect() {
      closeMenu();
      dialogStore.open({
        kind: 'trash',
        sessionId: props.sessionId,
        displayTitle: props.displayTitle ?? null,
      });
    },
  }, t('menuTrash'));
}

// Trash flow without a confirmation: fire the RPC and surface the outcome as
// the official 3-second toast.
function TrashToastFlow({ request }) {
  const [phase, setPhase] = React.useState('pending'); // pending | done | linger | error
  const [errorText, setErrorText] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    callTrash('trash', { sessionId: request.sessionId, displayTitle: request.displayTitle })
      .then((result) => {
        const value = unwrapResult(result);
        if (!alive) return;
        if (value && value.ok === false) {
          setPhase('error');
          setErrorText(reasonText(value.reason));
          return;
        }
        clearCurrentSessionPointer(request.sessionId);
        refreshSessionList();
        setPhase(value?.lingerUntilRestart === true ? 'linger' : 'done');
      })
      .catch((reason) => {
        if (!alive) return;
        setPhase('error');
        setErrorText(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { alive = false; };
  }, [request]);
  if (phase === 'pending') return null;
  const text = phase === 'done' ? t('toastTrashed')
    : phase === 'linger' ? t('toastLinger')
    : `${t('reasonGeneric')} ${errorText ?? ''}`;
  return h(P.Toast, {
    text,
    tone: phase === 'done' ? 'success' : undefined,
    holdMs: phase === 'done' ? 3000 : 6000,
    onDone: () => dialogStore.close(),
  });
}

// Purge / empty-trash stay confirmed (irreversible), then toast the outcome.
function PurgeConfirmDialog({ request }) {
  useLang();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  React.useEffect(() => { setBusy(false); setError(null); }, [request]);
  if (!request) return null;

  let title;
  let description;
  let confirmLabel;
  let call;
  if (request.kind === 'purge') {
    title = t('dialogPurgeTitle');
    description = fmt(t('dialogPurgeDesc'), { title: request.displayTitle ?? t('untitled') });
    confirmLabel = t('dialogPurgeConfirm');
    call = () => callTrash('purge', { sessionId: request.sessionId, confirm: true });
  } else {
    title = t('dialogPurgeAllTitle');
    description = t('dialogPurgeAllDesc');
    confirmLabel = t('dialogPurgeConfirm');
    call = () => callTrash('purgeAll', { confirm: true });
  }

  const close = () => { if (!busy) dialogStore.close(); };
  const confirm = () => {
    setBusy(true);
    setError(null);
    call()
      .then((result) => {
        const value = unwrapResult(result);
        if (value && value.ok === false) throw new Error(reasonText(value.reason));
        setBusy(false);
        clearCurrentSessionPointer(request.sessionId);
        refreshSessionList();
        request.onSettled?.();
        dialogStore.close();
        dialogStore.open({
          kind: 'toast',
          text: request.kind === 'purge' ? t('toastPurged') : t('toastPurgedAll'),
          tone: 'success',
          holdMs: 3000,
        });
      })
      .catch((reason) => {
        setBusy(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return h(P.Modal, {
    open: true,
    onClose: close,
    closeLabel: t('close'),
    title,
    description,
    footer: h(React.Fragment, null,
      h(P.Button, { variant: 'outline', disabled: busy, onClick: close }, t('cancel')),
      h(P.Button, { variant: 'outline', className: 'st-danger-button', disabled: busy, onClick: confirm }, confirmLabel)),
  },
  busy && h('div', { role: 'status', style: { marginTop: 8, opacity: .7 } }, t('pending')),
  error !== null && h('div', { role: 'alert', style: { marginTop: 8, color: DANGER_COLOR } }, error));
}

// The shell.overlay entry: toast flow for trash, confirm modal for purges.
function TrashOverlay() {
  const request = useDialogState();
  if (!request) return null;
  if (request.kind === 'toast') {
    return h(P.Toast, {
      text: request.text,
      tone: request.tone,
      holdMs: request.holdMs ?? 3000,
      onDone: () => dialogStore.close(),
    });
  }
  if (request.kind === 'trash') return h(TrashToastFlow, { request });
  return h(PurgeConfirmDialog, { request });
}

function TrashSettingsSection() {
  useLang();
  const [items, setItems] = React.useState(null);
  const [error, setError] = React.useState(null);

  const reload = React.useCallback(() => {
    callTrash('list', {})
      .then((result) => {
        const value = unwrapResult(result);
        if (!value || value.ok !== true) throw new Error(reasonText(value?.reason));
        setItems(Array.isArray(value.items) ? value.items : []);
        setError(null);
      })
      .catch((reason) => {
        setError(`${t('listFailed')} ${reason instanceof Error ? reason.message : String(reason)}`);
        setItems((prev) => prev ?? []);
      });
  }, []);

  React.useEffect(() => { reload(); }, [reload]);

  const restore = (item) => {
    setError(null);
    callTrash('restore', { sessionId: item.sessionId })
      .then((result) => {
        const value = unwrapResult(result);
        if (!value || value.ok !== true) throw new Error(reasonText(value?.reason));
        // One session-list refresh brings the restored row back into the
        // sidebar in place — no reload needed.
        refreshSessionList();
        reload();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const reveal = () => {
    callTrash('reveal', {})
      .then((result) => {
        const value = unwrapResult(result);
        if (value && value.ok === false) throw new Error(reasonText(value.reason));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const rows = items ?? [];

  return h('div', { className: 'st-settings' },
    h('div', { className: 'st-toolbar' },
      h(P.Button, {
        variant: 'outline',
        className: 'st-danger-button',
        disabled: rows.length === 0,
        onClick: () => dialogStore.open({ kind: 'purgeAll', onSettled: reload }),
      }, t('purgeAll')),
      h(P.Button, { variant: 'ghost', onClick: reveal }, t('reveal')),
      h(P.Button, { variant: 'ghost', onClick: reload }, t('refresh'))),
    error !== null && h('div', { className: 'st-error' }, error),
    items === null
      ? h('div', { className: 'st-empty' }, t('loading'))
      : rows.length === 0
        ? h('div', { className: 'st-empty' }, t('empty'))
        : h('ul', { className: 'st-list' }, rows.map((item) => {
          const metaParts = [];
          if (item.workspaceTitle) metaParts.push(item.workspaceTitle);
          else if (item.workspacePath) metaParts.push(item.workspacePath);
          if (item.trashedAt) {
            try { metaParts.push(new Date(item.trashedAt).toLocaleString()); } catch { /* skip */ }
          }
          const size = formatBytes(item.sizeBytes);
          if (size) metaParts.push(size);
          return h('li', { key: item.sessionId, className: 'st-row' },
            h('div', { className: 'st-row-main' },
              h('div', { className: 'st-title' }, item.displayTitle ?? t('untitled')),
              h('div', { className: 'st-meta' }, metaParts.join(' · '))),
            h('div', { className: 'st-row-actions' },
              h(P.Button, { variant: 'outline', onClick: () => restore(item) }, t('restore')),
              h(P.Button, {
                variant: 'outline',
                className: 'st-danger-button',
                onClick: () => dialogStore.open({ kind: 'purge', sessionId: item.sessionId, displayTitle: item.displayTitle, onSettled: reload }),
              }, t('purge'))));
        })));
}

function createPlugin() {
  return {
    inject: ['slots', 'sessions', 'locale', 'remote'],
    apply(ctx) {
      activeCtx = ctx;
      injectStyles();
      installNavIconSwap();
      observeLang(ctx.locale);
      setLang(detectLang(ctx.locale));
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
        { name: 'sidebar.workspaces.session.menu.item', id: 'trash', order: 450, label: () => t('menuTrash') },
        TrashMenuItem));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'session-trash-dialog', order: 95 },
        TrashOverlay));
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'session-trash', order: 30, label: () => t('settingsNav') },
        TrashSettingsSection));
    },
  };
}

export { createPlugin };
