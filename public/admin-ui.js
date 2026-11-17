/**
 * LOKY AI Next — Admin Dashboard (client).
 *
 * Security note: this file only *renders*. Every request goes to /api/admin/*,
 * where the server verifies the caller's Supabase token and requires
 * profiles.is_admin = true. Hiding or revealing the nav entry here is a
 * convenience, never the access control: without a valid admin token the API
 * answers 401/403 and the dashboard stays empty.
 */

import { getAccessToken } from './supabase-client.js';
import { closeLayer, openLayer } from './back-nav.js';

const state = {
  tab: 'users',
  stats: null,
  users: [],
  reports: [],
  logs: [],
  moderation: null,
  analytics: null,
  analyticsError: null,
  system: null,
  aiHealth: null,
  chats: [],
  superAdmin: null,
  open: false,
  notice: '',
  busy: false,
  reasonResolver: null,
};

const el = {};

/* --------------------------------- helpers -------------------------------- */

function esc(value) {
  return String(value == null ? '' : value);
}

function setNotice(message, tone = 'info') {
  state.notice = message || '';
  if (!el.notice) return;
  el.notice.textContent = state.notice;
  el.notice.dataset.tone = tone;
  el.notice.hidden = !state.notice;
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function api(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const response = await fetch(`/api/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    const code = payload?.error?.code || `http_${response.status}`;
    const error = new Error(payload?.error?.message || code);
    error.code = code;
    error.status = response.status;
    throw error;
  }

  // A panel the database cannot answer is not a failure: the server says
  // available:false and why. Callers render "Not configured" instead of a
  // red banner, and never a made-up number.
  if (payload?.available === false) {
    const error = new Error(payload?.message || 'Not configured.');
    error.code = payload?.reason || 'not_configured';
    error.notConfigured = true;
    throw error;
  }

  return payload.data;
}

/** Ask for a documented reason before any privileged action. */
function askReason(promptText, { min = 5, confirmLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    if (!el.reasonDialog) {
      resolve(null);
      return;
    }
    // Never stack prompts: settle any previous one as cancelled first.
    if (state.reasonResolver) closeReasonDialog(null);

    state.reasonMin = min;
    state.reasonResolver = resolve;

    el.reasonLabel.textContent = promptText;
    el.reasonText.value = '';
    el.reasonError.hidden = true;
    el.reasonOk.textContent = confirmLabel;
    el.reasonDialog.hidden = false;
    el.reasonDialog.classList.add('is-open');
    el.reasonText.focus();
  });
}

/** Close the prompt and settle the pending action (null means cancelled). */
function closeReasonDialog(value) {
  if (!el.reasonDialog) return;
  const resolve = state.reasonResolver;
  state.reasonResolver = null;
  el.reasonDialog.classList.remove('is-open');
  el.reasonDialog.hidden = true;
  if (el.reasonText) el.reasonText.value = '';
  if (el.reasonError) el.reasonError.hidden = true;
  if (typeof resolve === 'function') resolve(value);
}

/** Validate the typed reason, then let the privileged action run. */
function confirmReasonDialog() {
  if (!state.reasonResolver) return;
  const value = el.reasonText.value.trim();
  const min = state.reasonMin ?? 5;
  if (value.length < min) {
    el.reasonError.textContent = `Please write at least ${min} characters.`;
    el.reasonError.hidden = false;
    el.reasonText.focus();
    return;
  }
  closeReasonDialog(value);
}

/**
 * Bind the prompt's controls exactly once, at boot. The buttons must respond
 * however the dialog came to be on screen: Cancel closes it, Confirm validates
 * and resolves the action, Escape and a backdrop tap cancel.
 */
function bindReasonDialog() {
  if (!el.reasonDialog || el.reasonDialog.dataset.reasonBound === 'true') return;
  el.reasonDialog.dataset.reasonBound = 'true';

  el.reasonOk?.addEventListener('click', confirmReasonDialog);
  el.reasonCancel?.addEventListener('click', () => closeReasonDialog(null));
  el.reasonDialog.addEventListener('click', (event) => {
    if (event.target === el.reasonDialog) closeReasonDialog(null);
  });
  el.reasonDialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeReasonDialog(null);
    }
  });
  el.reasonText?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      confirmReasonDialog();
    }
  });
}

/* ---------------------------------- stats --------------------------------- */

function statCard(label, value) {
  const card = document.createElement('div');
  card.className = 'admin-stat';
  const num = document.createElement('span');
  num.className = 'admin-stat__value';
  num.textContent = value == null ? '—' : String(value);
  const name = document.createElement('span');
  name.className = 'admin-stat__label';
  name.textContent = label;
  card.append(num, name);
  return card;
}

function renderStats() {
  if (!el.stats) return;
  el.stats.replaceChildren();
  const s = state.stats;
  if (!s) return;
  el.stats.append(
    statCard('Registered users', s.totalUsers),
    statCard('Active users', s.activeUsers),
    statCard('Conversations', s.totalConversations),
    statCard('Messages', s.totalMessages),
    statCard('Pending requests', s.pendingFriendRequests),
    statCard('Open reports', s.openReports)
  );
}

/* ---------------------------------- users --------------------------------- */

function renderUsers() {
  if (!el.body) return;
  el.body.replaceChildren();

  if (!state.users.length) {
    el.body.append(emptyState('No users match that search.'));
    return;
  }

  const list = document.createElement('ul');
  list.className = 'admin-list';

  for (const user of state.users) {
    const li = document.createElement('li');
    li.className = 'admin-row';

    const main = document.createElement('div');
    main.className = 'admin-row__main';

    const title = document.createElement('span');
    title.className = 'admin-row__title';
    title.textContent = `${user.display_name || '@' + (user.username || 'unknown')}`;
    if (user.is_admin) {
      const pill = document.createElement('span');
      pill.className = 'admin-pill admin-pill--admin';
      pill.textContent = 'admin';
      title.append(' ', pill);
    }

    const meta = document.createElement('span');
    meta.className = 'admin-row__meta';
    meta.textContent = `${user.username ? '@' + user.username : 'no username'} · ${user.email || 'no email'} · joined ${fmtDate(user.created_at)} · seen ${fmtDate(user.last_seen_at)}`;

    const counts = document.createElement('span');
    counts.className = 'admin-row__meta';
    counts.textContent = `${user.conversation_count ?? 0} chats · ${user.message_count ?? 0} messages`;

    const status = document.createElement('span');
    status.className = `admin-pill admin-pill--${esc(user.status || 'active')}`;
    status.textContent = user.status || 'active';

    main.append(title, meta, counts);

    const actions = document.createElement('div');
    actions.className = 'admin-row__actions';

    if (!user.is_admin) {
      if (user.status === 'active') {
        actions.append(
          adminButton('Suspend', 'danger', () => changeStatus(user, 'suspended'))
        );
      } else {
        actions.append(adminButton('Reactivate', 'primary', () => changeStatus(user, 'active')));
      }
      // Permanent deletion always requires a typed reason and is audited.
      // Admins (including the Super Admin) never get a delete control, and the
      // server refuses those deletions even if a request is forged by hand.
      const deleteBtn = adminButton('Delete', 'danger', () => deleteUser(user));
      if (!state.deletionEnabled) {
        // Deletion needs a secure server-side path that is not configured yet.
        // The server refuses it too, so the button is visibly disabled rather
        // than failing only after the owner has typed a reason.
        deleteBtn.disabled = true;
        deleteBtn.title =
          'Account deletion is disabled until a secure server-side implementation is configured.';
      }
      actions.append(deleteBtn);
    }

    li.append(main, status, actions);
    list.append(li);
  }

  el.body.append(list);
}

function adminButton(label, tone, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn--${tone === 'danger' ? 'ghost' : 'primary'} btn--sm admin-btn`;
  if (tone === 'danger') button.dataset.tone = 'danger';
  button.textContent = label;
  button.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    try {
      await onClick();
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  });
  return button;
}

async function changeStatus(user, status) {
  const reason = await askReason(
    `Reason for setting ${user.username ? '@' + user.username : 'this account'} to "${status}" (recorded in the audit log):`,
    { min: 5, confirmLabel: status === 'suspended' ? 'Suspend account' : 'Reactivate account' }
  );
  if (!reason) return;
  try {
    await api(`/users/${user.id}/status`, { method: 'POST', body: { status, reason } });
    setNotice(`Account ${status}.`, 'ok');
    await loadUsers(el.userSearch?.value || '');
  } catch (error) {
    setNotice(describeAdminError(error), 'error');
  }
}

/* --------------------------------- reports -------------------------------- */

function renderReports() {
  if (!el.body) return;
  el.body.replaceChildren();

  if (!state.reports.length) {
    el.body.append(emptyState('No reports in this queue.'));
    return;
  }

  const list = document.createElement('ul');
  list.className = 'admin-list';

  for (const report of state.reports) {
    const li = document.createElement('li');
    li.className = 'admin-row';

    const main = document.createElement('div');
    main.className = 'admin-row__main';

    const title = document.createElement('span');
    title.className = 'admin-row__title';
    title.textContent = `${report.reason || 'Report'} · ${report.reporter_username ? '@' + report.reporter_username : 'unknown reporter'}`;

    const meta = document.createElement('span');
    meta.className = 'admin-row__meta';
    meta.textContent = `${report.message_id ? 'Reported message' : 'Reported conversation'} · ${fmtDate(report.created_at)}`;

    const details = document.createElement('span');
    details.className = 'admin-row__meta';
    details.textContent = report.details || 'No extra details provided.';

    main.append(title, meta, details);

    const status = document.createElement('span');
    status.className = `admin-pill admin-pill--${esc(report.status || 'open')}`;
    status.textContent = report.status || 'open';

    const actions = document.createElement('div');
    actions.className = 'admin-row__actions';

    if (report.conversation_id) {
      actions.append(
        adminButton('Review chat', 'primary', () => reviewConversation(report))
      );
    }
    if (report.status !== 'resolved' && report.status !== 'dismissed') {
      actions.append(adminButton('Resolve', 'primary', () => updateReport(report, 'resolved')));
      actions.append(adminButton('Dismiss', 'danger', () => updateReport(report, 'dismissed')));
    }

    li.append(main, status, actions);
    list.append(li);
  }

  el.body.append(list);
}

async function updateReport(report, status) {
  const reason = await askReason(`Note for marking this report "${status}" (audit log):`, {
    min: 5,
    confirmLabel: status === 'resolved' ? 'Mark resolved' : 'Dismiss report',
  });
  if (!reason) return;
  try {
    await api(`/reports/${report.id}`, { method: 'POST', body: { status, note: reason } });
    setNotice(`Report ${status}.`, 'ok');
    await loadReports();
  } catch (error) {
    setNotice(describeAdminError(error), 'error');
  }
}

/**
 * Opening a reported conversation requires a documented reason and is written
 * to the immutable audit log before any message is shown.
 */
async function reviewConversation(report) {
  const reason = await askReason(
    'Legitimate reason for reviewing this reported conversation (recorded permanently in the audit log):',
    { min: 10, confirmLabel: 'Review conversation' }
  );
  if (!reason) return;

  try {
    const data = await api(
      `/conversations/${report.conversation_id}?reason=${encodeURIComponent(reason)}`
    );
    state.moderation = data;
    renderModeration(data);
    setNotice('Conversation opened. This access was written to the audit log.', 'ok');
    await loadLogs();
  } catch (error) {
    setNotice(describeAdminError(error), 'error');
  }
}

function renderModeration(data) {
  if (!el.body) return;
  el.body.replaceChildren();

  const header = document.createElement('div');
  header.className = 'admin-mod__head';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn--ghost btn--sm';
  back.textContent = '← Back to reports';
  back.addEventListener('click', () => {
    state.moderation = null;
    renderReports();
  });

  const who = document.createElement('span');
  who.className = 'admin-row__meta';
  who.textContent = `Members: ${(data.members || [])
    .map((m) => (m.username ? '@' + m.username : m.id))
    .join(', ')}`;

  header.append(back, who);
  el.body.append(header);

  const list = document.createElement('ul');
  list.className = 'admin-mod__messages';

  for (const message of data.messages || []) {
    const member = (data.members || []).find((m) => m.id === message.senderId);
    const li = document.createElement('li');
    li.className = 'admin-mod__msg';

    const meta = document.createElement('span');
    meta.className = 'admin-mod__meta';
    meta.textContent = `${member?.username ? '@' + member.username : message.senderId} · ${fmtDate(message.createdAt)}`;

    const body = document.createElement('span');
    body.className = 'admin-mod__body';
    body.textContent = message.body || '';

    li.append(meta, body);
    list.append(li);
  }

  el.body.append(list);
}

/* ----------------------------------- logs --------------------------------- */

function renderLogs() {
  if (!el.body) return;
  el.body.replaceChildren();

  if (!state.logs.length) {
    el.body.append(emptyState('No admin activity recorded yet.'));
    return;
  }

  const list = document.createElement('ul');
  list.className = 'admin-list';

  for (const entry of state.logs) {
    const li = document.createElement('li');
    li.className = 'admin-row';

    const main = document.createElement('div');
    main.className = 'admin-row__main';

    const title = document.createElement('span');
    title.className = 'admin-row__title';
    title.textContent = `${entry.action} · ${entry.target_type || 'n/a'}`;

    const meta = document.createElement('span');
    meta.className = 'admin-row__meta';
    meta.textContent = `${entry.admin_username ? '@' + entry.admin_username : 'admin'} · ${fmtDate(entry.created_at)}`;

    const reason = document.createElement('span');
    reason.className = 'admin-row__meta';
    reason.textContent = entry.reason || 'No reason recorded.';

    main.append(title, meta, reason);
    li.append(main);
    list.append(li);
  }

  el.body.append(list);
}

/* ---------------------------------- loader -------------------------------- */

function emptyState(text) {
  const p = document.createElement('p');
  p.className = 'admin-empty';
  p.textContent = text;
  return p;
}

function describeAdminError(error) {
  const map = {
    not_admin: 'This account is not an administrator.',
    account_inactive: 'This admin account is not active.',
    missing_token: 'Please sign in again.',
    invalid_token: 'Your session expired. Please sign in again.',
    reason_required: 'A documented reason is required for this action.',
    conversation_not_reported: 'Only reported conversations can be reviewed.',
    cannot_change_own_status: 'You cannot change your own account status.',
    cannot_change_admin_status: 'Administrator accounts cannot be suspended here.',
    rate_limited: 'Too many admin requests. Wait a minute and try again.',
    user_not_found: 'That user no longer exists.',
    report_not_found: 'That report no longer exists.',
    deletion_disabled:
      'Account deletion is disabled until a secure server-side implementation is configured. Suspend the account instead.',
  };
  return map[error?.code] || error?.message || 'The admin request failed.';
}

async function loadStats() {
  try {
    state.stats = await api('/stats');
    renderStats();
  } catch (error) {
    if (error.notConfigured) {
      state.stats = null;
      renderStats();
      return;
    }
    setNotice(describeAdminError(error), 'error');
  }
}

async function loadUsers(term = '') {
  try {
    state.users = await api(`/users?q=${encodeURIComponent(term)}`);
    state.tab = 'users';
    syncTabs();
    renderUsers();
  } catch (error) {
    if (error.notConfigured) {
      state.users = [];
      state.tab = 'users';
      syncTabs();
      if (el.body) el.body.replaceChildren(emptyState(error.message));
      return;
    }
    setNotice(describeAdminError(error), 'error');
  }
}

async function loadReports() {
  try {
    state.reports = await api('/reports');
    state.tab = 'reports';
    state.moderation = null;
    syncTabs();
    renderReports();
  } catch (error) {
    setNotice(describeAdminError(error), 'error');
  }
}

async function loadLogs() {
  try {
    state.logs = await api('/audit?limit=100');
    state.tab = 'logs';
    syncTabs();
    renderLogs();
  } catch (error) {
    setNotice(describeAdminError(error), 'error');
  }
}

function tabs() {
  return [el.tabOverview, el.tabUsers, el.tabChats, el.tabAnalytics, el.tabReports, el.tabSystem, el.tabLogs].filter(
    Boolean,
  );
}

function syncTabs() {
  for (const tab of tabs()) {
    const selected = tab.dataset.adminTab === state.tab;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
  }
  if (el.userSearchWrap) el.userSearchWrap.hidden = state.tab !== 'users';
}

/* --------------------------------- charts --------------------------------- */

/**
 * Inline SVG bar chart — no charting dependency.
 *
 * The dashboard is used on Android phones, so a few dozen DOM nodes are a better
 * trade than shipping a chart library over a mobile connection.
 */
function barChart(series, label) {
  const wrap = document.createElement('figure');
  wrap.className = 'admin-chart';

  const caption = document.createElement('figcaption');
  caption.className = 'admin-chart__label';
  caption.textContent = label;
  wrap.append(caption);

  const points = Array.isArray(series) ? series : [];
  const max = Math.max(1, ...points.map((point) => Number(point.count) || 0));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${Math.max(points.length, 1) * 10} 40`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label}: ${points.map((p) => `${p.day} ${p.count}`).join(', ')}`);

  points.forEach((point, index) => {
    const count = Number(point.count) || 0;
    const height = count === 0 ? 0.6 : Math.max(1.2, (count / max) * 38);
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('x', String(index * 10 + 1));
    bar.setAttribute('y', String(40 - height));
    bar.setAttribute('width', '7');
    bar.setAttribute('height', String(height));
    bar.setAttribute('rx', '1.5');
    bar.setAttribute('class', 'admin-chart__bar');
    svg.append(bar);
  });

  wrap.append(svg);
  return wrap;
}

function renderCharts(series) {
  if (!series) {
    return emptyState(
      'Not configured: the 14-day activity charts need a database function that is not installed. The totals above are live.',
    );
  }
  const box = document.createElement('div');
  box.className = 'admin-charts';
  box.append(
    barChart(series?.users, 'New users · last 14 days'),
    barChart(series?.messages, 'Messages · last 14 days'),
  );
  return box;
}

function analyticsUnavailable() {
  const error = state.analyticsError;
  if (error?.notConfigured) return emptyState(error.message);
  if (error?.code === 'db_admin_flag_missing') {
    return emptyState(
      'Not configured: the database admin functions require profiles.is_admin = true for this account.',
    );
  }
  return emptyState('Analytics are unavailable right now.');
}

async function loadAnalyticsData() {
  try {
    state.analytics = await api('/analytics');
    state.analyticsError = null;
  } catch (error) {
    state.analytics = null;
    state.analyticsError = error;
  }
}

function activityCards(analytics) {
  const cards = document.createElement('div');
  cards.className = 'admin-stats';
  cards.append(
    statCard('Daily active', analytics?.activity?.dau),
    statCard('Weekly active', analytics?.activity?.wau),
    statCard('Messages today', analytics?.activity?.messagesToday),
    statCard('Messages · 7d', analytics?.activity?.messages7d),
    statCard('New users today', analytics?.growth?.newUsersToday),
    statCard('New users · 7d', analytics?.growth?.newUsers7d),
  );
  return cards;
}

/* -------------------------------- analytics ------------------------------- */

async function loadAnalytics() {
  state.tab = 'analytics';
  syncTabs();
  await loadAnalyticsData();
  if (!el.body) return;
  el.body.replaceChildren();
  if (!state.analytics) {
    el.body.append(analyticsUnavailable());
    return;
  }
  el.body.append(activityCards(state.analytics), renderCharts(state.analytics.series));
}

/* --------------------------------- overview ------------------------------- */

async function loadSystemData() {
  try {
    state.system = await api('/system');
  } catch {
    state.system = null;
  }
  try {
    const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
    state.aiHealth = await response.json();
  } catch {
    state.aiHealth = null;
  }
}

function systemList() {
  const sys = state.system;
  const ai = state.aiHealth || {};
  const supabase = sys?.supabase;
  const rows = [
    ['AI provider', ai.configured ? `${ai.provider || 'AI'} · ${ai.model || 'unknown model'}` : 'not configured'],
    [
      'Supabase',
      supabase?.reachable
        ? `reachable · ${supabase.status} · ${supabase.ms} ms`
        : supabase?.configured
          ? 'unreachable'
          : 'not configured',
    ],
    ['Backend', sys?.backend?.up ? `up · ${sys.backend.uptimeSeconds}s · node ${sys.backend.node || ''}` : 'unknown'],
    [
      'Privileged key',
      sys?.serviceRole?.configured
        ? 'configured (optional)'
        : 'not configured — dashboard uses database functions',
    ],
    // The panel is only rendered for the server-verified owner, so echoing the
    // session UUID here lets the owner confirm it is the allow-listed account
    // without reading server configuration. It is their own identifier.
    [
      'Your session UUID',
      state.superAdmin?.userId
        ? `${state.superAdmin.userId} — the configured owner`
        : 'not verified',
    ],
    ['Super Admin', sys?.superAdmin?.configured ? 'configured' : 'not configured'],
    ['Maintenance', sys?.maintenance?.on ? `ON · ${sys.maintenance.reason || 'no reason recorded'}` : 'off'],
  ];

  const list = document.createElement('ul');
  list.className = 'admin-sys';
  for (const [key, value] of rows) {
    const li = document.createElement('li');
    li.className = 'admin-sys__row';
    const k = document.createElement('span');
    k.className = 'admin-sys__key';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'admin-sys__val';
    v.textContent = String(value);
    li.append(k, v);
    list.append(li);
  }
  return list;
}

function maintenanceCard() {
  const wrap = document.createElement('div');
  wrap.className = 'admin-sys__actions';

  const on = state.system?.maintenance?.on === true;
  const label = document.createElement('span');
  label.className = 'admin-sys__key';
  label.textContent = on ? 'Maintenance mode is ON' : 'Maintenance mode is off';

  wrap.append(
    label,
    adminButton(on ? 'Turn off maintenance' : 'Turn on maintenance', on ? 'primary' : 'danger', async () => {
      try {
        const reason = await askReason('Reason for changing maintenance mode (recorded in the audit log):');
        if (!reason) return;
        const data = await api('/maintenance', { method: 'POST', body: { on: !on, reason } });
        state.system = { ...(state.system || {}), maintenance: data };
        setNotice(`Maintenance ${data.on ? 'enabled' : 'disabled'}.`, 'ok');
        renderSystem();
      } catch (error) {
        setNotice(describeAdminError(error), 'error');
      }
    }),
  );
  return wrap;
}

function renderSystem() {
  if (!el.body) return;
  el.body.replaceChildren(systemList(), maintenanceCard());
}

async function loadSystem() {
  state.tab = 'system';
  syncTabs();
  await loadSystemData();
  renderSystem();
}

function renderOverview() {
  if (!el.body) return;
  el.body.replaceChildren();

  if (state.analytics) {
    const a = state.analytics;
    if (a.totals) {
      // Totals come from the SECURITY DEFINER RPC, so they need no privileged
      // key. Each card is a real number or an em dash, never a guess.
      const cards = document.createElement('div');
      cards.className = 'admin-stats';
      cards.append(
        statCard('Registered users', a.totals.users),
        statCard('Active users', a.totals.activeUsers),
        statCard('Suspended', a.totals.suspendedUsers),
        statCard('Conversations', a.totals.conversations),
        statCard('Messages', a.totals.messages),
        statCard('Open reports', a.totals.openReports),
      );
      el.body.append(cards);
    } else {
      el.body.append(activityCards(a));
    }
    el.body.append(renderCharts(a.series));
  } else {
    el.body.append(analyticsUnavailable());
  }

  el.body.append(systemList());
}

async function loadOverview() {
  state.tab = 'overview';
  syncTabs();
  await Promise.all([
    (async () => {
      try {
        state.stats = await api('/stats');
      } catch {
        state.stats = null;
      }
    })(),
    loadSystemData(),
    loadAnalyticsData(),
  ]);
  renderStats();
  renderOverview();
}

/* ---------------------------------- chats --------------------------------- */

async function loadChats() {
  state.tab = 'chats';
  syncTabs();
  if (!el.body) return;
  try {
    state.chats = await api('/conversations');
  } catch (error) {
    state.chats = [];
    if (error.notConfigured) {
      // The database cannot list every conversation without a function it does
      // not have. Say so, instead of showing an empty list that reads as "none".
      el.body.replaceChildren(emptyState(error.message));
      return;
    }
    el.body.replaceChildren(emptyState(describeAdminError(error)));
    setNotice(describeAdminError(error), 'error');
    return;
  }
  renderChats();
}

function renderChats() {
  if (!el.body) return;
  el.body.replaceChildren();

  if (!state.chats.length) {
    el.body.append(emptyState('No conversations yet.'));
    return;
  }

  // Transparency: say plainly what this view does and does not show.
  const note = document.createElement('p');
  note.className = 'admin-hint';
  note.textContent =
    'Metadata only. Message contents are never shown here. Reviewing a reported conversation requires a written reason and is recorded in the audit log.';
  el.body.append(note);

  const list = document.createElement('ul');
  list.className = 'admin-list';
  for (const chat of state.chats) {
    const li = document.createElement('li');
    li.className = 'admin-item';

    const title = document.createElement('span');
    title.className = 'admin-item__name';
    title.textContent = `Conversation ${String(chat.id || '').slice(0, 8)}`;

    const meta = document.createElement('span');
    meta.className = 'admin-item__meta';
    meta.textContent = `${chat.memberCount ?? 0} member(s) · ${chat.messageCount ?? 0} message(s) · created ${fmtDate(chat.createdAt)}`;

    li.append(title, meta);
    list.append(li);
  }
  el.body.append(list);
}

/* ---------------------------------- delete -------------------------------- */

async function deleteUser(user) {
  const label = user.username ? `@${user.username}` : user.email || 'this account';
  try {
    const reason = await askReason(
      `Delete ${label} permanently? The account and its data are removed and this cannot be undone. Reason (recorded in the audit log):`,
      { min: 5, confirmLabel: 'Delete account' },
    );
    if (!reason) return;
    await api(`/users/${user.id}/delete`, { method: 'POST', body: { reason } });
    setNotice(`${label} deleted.`, 'ok');
    await loadUsers(el.userSearch?.value || '');
  } catch (error) {
    setNotice(
      error.code === 'deletion_disabled' ? error.message : describeAdminError(error),
      'error',
    );
  }
}

/* ---------------------------------- open ---------------------------------- */

/**
 * Verify the session against the server before revealing anything. Returns
 * true only when the server itself confirms an active administrator.
 */
export async function verifyAdminAccess() {
  try {
    const data = await api('/session');
    // The server only answers /session for the configured Super Admin, so a
    // 200 here already means owner access. isSuperAdmin is checked explicitly
    // so an older server build can never be treated as "admin enough".
    const allowed = data?.isAdmin === true && data?.isSuperAdmin !== false;
    state.superAdmin = allowed ? data : null;
    // Deletion is the one action that still needs the optional privileged key,
    // so the button stays disabled unless the server reports it available.
    state.deletionEnabled = allowed && data?.deletionEnabled === true;
    return allowed;
  } catch {
    state.superAdmin = null;
    return false;
  }
}

function isAdminPath() {
  return window.location.pathname.replace(/\/+$/, '') === '/admin';
}

function showAdminDenied() {
  const denied = document.getElementById('adminDenied');
  if (denied) denied.hidden = false;
}

export async function openAdmin() {
  openLayer('admin', closeAdmin);
  if (!el.panel) return;
  el.panel.hidden = false;
  state.open = true;
  setNotice('');
  await loadOverview();
}

export function closeAdmin() {
  closeLayer('admin');
  if (!el.panel) return;
  el.panel.hidden = true;
  state.open = false;
}

export function initAdminUI() {
  el.navAdmin = document.getElementById('navAdmin');
  el.panel = document.getElementById('adminPanel');
  el.close = document.getElementById('adminClose');
  el.notice = document.getElementById('adminNotice');
  el.stats = document.getElementById('adminStats');
  el.body = document.getElementById('adminBody');
  el.tabUsers = document.getElementById('adminTabUsers');
  el.tabReports = document.getElementById('adminTabReports');
  el.tabLogs = document.getElementById('adminTabLogs');
  el.tabOverview = document.getElementById('adminTabOverview');
  el.tabChats = document.getElementById('adminTabChats');
  el.tabAnalytics = document.getElementById('adminTabAnalytics');
  el.tabSystem = document.getElementById('adminTabSystem');
  el.userSearchWrap = document.getElementById('adminUserSearchWrap');
  el.userSearch = document.getElementById('adminUserSearch');
  el.userSearchForm = document.getElementById('adminUserSearchForm');
  el.reasonDialog = document.getElementById('adminReasonDialog');
  el.reasonLabel = document.getElementById('adminReasonLabel');
  el.reasonText = document.getElementById('adminReasonText');
  el.reasonError = document.getElementById('adminReasonError');
  el.reasonOk = document.getElementById('adminReasonOk');
  el.reasonCancel = document.getElementById('adminReasonCancel');

  // The reason prompt exists only for privileged actions. Wire its buttons now
  // (so Cancel/Confirm always respond) and guarantee it starts closed, so an
  // empty text field can never sit over the app at launch.
  bindReasonDialog();
  closeReasonDialog(null);

  el.close?.addEventListener('click', closeAdmin);
  el.tabOverview?.addEventListener('click', loadOverview);
  el.tabUsers?.addEventListener('click', () => loadUsers(el.userSearch?.value || ''));
  el.tabChats?.addEventListener('click', loadChats);
  el.tabAnalytics?.addEventListener('click', loadAnalytics);
  el.tabReports?.addEventListener('click', loadReports);
  el.tabSystem?.addEventListener('click', loadSystem);
  el.tabLogs?.addEventListener('click', loadLogs);

  el.userSearchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    loadUsers(el.userSearch?.value || '');
  });

  el.navAdmin?.addEventListener('click', () => {
    if (state.open) closeAdmin();
    else openAdmin();
  });

  // Reveal the nav entry only for a server-verified admin. A signed-out or
  // ordinary user never sees it, and the API would refuse them anyway.
  window.addEventListener('loky:auth-changed', async (event) => {
    if (!event?.detail?.signedIn) {
      el.navAdmin?.setAttribute('hidden', '');
      closeAdmin();
      return;
    }
    const isAdmin = await verifyAdminAccess();
    if (isAdmin) {
      el.navAdmin?.removeAttribute('hidden');
      // A deep link to /admin opens the dashboard only after the server agrees.
      if (isAdminPath()) await openAdmin();
    } else {
      el.navAdmin?.setAttribute('hidden', '');
      // Signed in but not the owner: show Access Denied, never the panel.
      if (isAdminPath()) showAdminDenied();
    }
  });

  return { openAdmin, closeAdmin, verifyAdminAccess };
}
