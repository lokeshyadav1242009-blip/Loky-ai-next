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
  return payload.data;
}

/** Ask for a documented reason before any privileged action. */
function askReason(promptText, { min = 5, confirmLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    if (!el.reasonDialog) {
      resolve(null);
      return;
    }
    el.reasonLabel.textContent = promptText;
    el.reasonText.value = '';
    el.reasonError.hidden = true;
    el.reasonOk.textContent = confirmLabel;
    el.reasonDialog.hidden = false;
    el.reasonText.focus();

    state.reasonResolver = (value) => {
      state.reasonResolver = null;
      el.reasonDialog.hidden = true;
      resolve(value);
    };

    el.reasonOk.onclick = () => {
      const value = el.reasonText.value.trim();
      if (value.length < min) {
        el.reasonError.textContent = `Please write at least ${min} characters.`;
        el.reasonError.hidden = false;
        return;
      }
      state.reasonResolver?.(value);
    };
    el.reasonCancel.onclick = () => state.reasonResolver?.(null);
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
  };
  return map[error?.code] || error?.message || 'The admin request failed.';
}

async function loadStats() {
  try {
    state.stats = await api('/stats');
    renderStats();
  } catch (error) {
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

function syncTabs() {
  for (const tab of [el.tabUsers, el.tabReports, el.tabLogs]) {
    if (!tab) continue;
    const selected = tab.dataset.adminTab === state.tab;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
  }
  if (el.userSearchWrap) el.userSearchWrap.hidden = state.tab !== 'users';
}

/* ---------------------------------- open ---------------------------------- */

/**
 * Verify the session against the server before revealing anything. Returns
 * true only when the server itself confirms an active administrator.
 */
export async function verifyAdminAccess() {
  try {
    const data = await api('/session');
    return data?.isAdmin === true;
  } catch {
    return false;
  }
}

export async function openAdmin() {
  openLayer('admin', closeAdmin);
  if (!el.panel) return;
  el.panel.hidden = false;
  state.open = true;
  setNotice('');
  await loadStats();
  await loadUsers(el.userSearch?.value || '');
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
  el.userSearchWrap = document.getElementById('adminUserSearchWrap');
  el.userSearch = document.getElementById('adminUserSearch');
  el.userSearchForm = document.getElementById('adminUserSearchForm');
  el.reasonDialog = document.getElementById('adminReasonDialog');
  el.reasonLabel = document.getElementById('adminReasonLabel');
  el.reasonText = document.getElementById('adminReasonText');
  el.reasonError = document.getElementById('adminReasonError');
  el.reasonOk = document.getElementById('adminReasonOk');
  el.reasonCancel = document.getElementById('adminReasonCancel');

  el.close?.addEventListener('click', closeAdmin);
  el.tabUsers?.addEventListener('click', () => loadUsers(el.userSearch?.value || ''));
  el.tabReports?.addEventListener('click', loadReports);
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
    if (isAdmin) el.navAdmin?.removeAttribute('hidden');
    else el.navAdmin?.setAttribute('hidden', '');
  });

  return { openAdmin, closeAdmin, verifyAdminAccess };
}
