/**
 * LOKY CONNECT — pure presentation model.
 *
 * No DOM, no fetch, no globals: every function here is a deterministic
 * transform so the rules that matter (what a preview says, whether an upload is
 * allowed, how unread counts are capped, how reactions collapse) can be unit
 * tested in Node without a browser or a database.
 */

/** The four surfaces of LOKY CONNECT, in navigation order. */
export const CONNECT_TABS = Object.freeze([
  { id: 'chats', label: 'Chats' },
  { id: 'friends', label: 'Friends' },
  { id: 'requests', label: 'Requests' },
  { id: 'discover', label: 'Discover' },
]);

/** Reactions offered in the message menu. */
export const REACTIONS = Object.freeze(['❤️', '😂', '👍', '🔥', '😮', '😢']);

/** Upload ceilings. Must stay <= the storage bucket limits in 0003. */
export const MEDIA_LIMITS = Object.freeze({
  image: 8 * 1024 * 1024,
  video: 25 * 1024 * 1024,
});

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

/** Clamp an unknown tab id to a real one. */
export function normalizeTab(id) {
  const wanted = String(id == null ? '' : id).trim().toLowerCase();
  const found = CONNECT_TABS.find((tab) => tab.id === wanted);
  return found ? found.id : 'chats';
}

/** 'image' | 'video' | null for a MIME type. */
export function mediaKind(mime) {
  const type = typeof mime === 'string' ? mime.toLowerCase().split(';')[0].trim() : '';
  if (IMAGE_TYPES.includes(type)) return 'image';
  if (VIDEO_TYPES.includes(type)) return 'video';
  return null;
}

/**
 * Validate a candidate upload before a single byte leaves the device.
 * Returns { ok: true, kind } or { ok: false, error }.
 */
export function validateAttachment(file) {
  if (!file || typeof file !== 'object') {
    return { ok: false, error: 'No file selected.' };
  }
  const kind = mediaKind(file.type);
  if (!kind) {
    return { ok: false, error: 'Only PNG, JPG, WEBP, GIF, MP4, WEBM or MOV files can be sent.' };
  }
  const size = Number(file.size) || 0;
  if (size <= 0) {
    return { ok: false, error: 'That file looks empty.' };
  }
  if (size > MEDIA_LIMITS[kind]) {
    const mb = Math.round(MEDIA_LIMITS[kind] / (1024 * 1024));
    return { ok: false, error: `${kind === 'image' ? 'Photos' : 'Videos'} must be under ${mb} MB.` };
  }
  return { ok: true, kind };
}

/** Initials for a fallback avatar: '@sunita' / 'Sunita Yadav' -> 'SY' / 'S'. */
export function initials(name) {
  const clean = String(name || '').replace(/^@+/, '').trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 1).toUpperCase();
}

/** Stable hue (0-359) from a seed, so an avatar keeps its colour. */
export function avatarHue(seed) {
  const text = String(seed || 'loky');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return hash;
}

/** '9+' cap for badge counters. */
export function unreadLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return n > 9 ? '9+' : String(n);
}

/** Human preview for a chat row. Deleted beats media beats text. */
export function previewText(row = {}) {
  if (row.deleted_at) return 'Message deleted';
  if (row.media_type === 'image') {
    return row.body ? `📷 ${String(row.body).slice(0, 60)}` : '📷 Photo';
  }
  if (row.media_type === 'video') {
    return row.body ? `🎬 ${String(row.body).slice(0, 60)}` : '🎬 Video';
  }
  const body = typeof row.body === 'string' ? row.body.trim() : '';
  return body ? body.slice(0, 80) : 'No messages yet';
}

/** Short clock label (HH:MM) in the viewer's locale. */
export function clockLabel(value, locale) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(locale || undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Day divider label: Today / Yesterday / 12 Mar 2026. */
export function dayLabel(value, now = new Date(), locale) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(locale || undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Chat-list timestamp: time today, 'Yesterday', else a date. */
export function listTime(value, now = new Date(), locale) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const label = dayLabel(value, now, locale);
  if (label === 'Today') return clockLabel(value, locale);
  if (label === 'Yesterday') return 'Yesterday';
  return date.toLocaleDateString(locale || undefined, { day: '2-digit', month: 'short' });
}

/** Presence line: Online when seen < 2 min ago, otherwise last seen text. */
export function presenceLabel(lastSeen, now = new Date()) {
  if (!lastSeen) return 'Last seen hidden';
  const seen = new Date(lastSeen);
  if (Number.isNaN(seen.getTime())) return 'Last seen hidden';
  const seconds = Math.max(0, (now.getTime() - seen.getTime()) / 1000);
  if (seconds < 120) return 'Online';
  if (seconds < 3600) return `Last seen ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `Last seen ${Math.floor(seconds / 3600)}h ago`;
  return `Last seen ${dayLabel(lastSeen, now)}`;
}

/**
 * Collapse raw reaction rows ({emoji,user_id}) into display chips.
 * `mine` marks reactions the viewer already gave (so the chip can toggle off).
 */
export function groupReactions(rows, myId) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const emoji = row && row.emoji;
    if (!emoji) continue;
    const entry = map.get(emoji) || { emoji, count: 0, mine: false };
    entry.count += 1;
    if (myId && row.user_id === myId) entry.mine = true;
    map.set(emoji, entry);
  }
  return [...map.values()];
}

/** Sort chat rows newest-activity first without mutating the input. */
export function sortThreads(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const at = new Date(a?.last_at || 0).getTime() || 0;
    const bt = new Date(b?.last_at || 0).getTime() || 0;
    return bt - at;
  });
}

/** Filter chat rows by peer username/display name (case-insensitive). */
export function filterThreads(rows, term) {
  const q = String(term || '').trim().toLowerCase().replace(/^@+/, '');
  if (!q) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const hay = `${row?.peer_username || ''} ${row?.peer_display_name || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

/** Total unread across every thread (drives the nav badge). */
export function totalUnread(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum, row) => sum + (Number(row?.unread_count) || 0),
    0
  );
}

/**
 * True only while a friend request is still answerable.
 *
 * public.my_friend_requests() returns EVERY request involving the user (no
 * status filter) and cancel_friend_request() marks the row 'cancelled'
 * instead of deleting it, so status must be checked before rendering.
 */
export function isPendingRequest(row) {
  return Boolean(row) && String(row.status || '').toLowerCase() === 'pending';
}

/**
 * Split my_friend_requests() rows into the lists the Requests tab shows.
 * Accepted, rejected and cancelled rows are excluded so a finished request
 * can never linger as if it were still waiting.
 */
export function splitPendingRequests(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const incoming = [];
  const outgoing = [];
  for (const row of list) {
    if (!isPendingRequest(row)) continue;
    if (row.direction === 'incoming' || row.direction === 'in') incoming.push(row);
    else if (row.direction === 'outgoing' || row.direction === 'out') outgoing.push(row);
  }
  return { incoming, outgoing };
}

/** Pending incoming request count (drives the Requests badge). */
export function pendingIncoming(requests) {
  const list = Array.isArray(requests) ? requests : [];
  return list.filter(
    (row) =>
      Boolean(row) &&
      (row.direction === 'incoming' || row.direction === 'in') &&
      row.status === 'pending'
  ).length;
}

/** Notification line for the bell list. */
export function notificationText(row = {}) {
  const who = row.actor_username ? `@${row.actor_username}` : 'Someone';
  switch (row.kind) {
    case 'friend_request':
      return `${who} sent you a friend request`;
    case 'friend_accepted':
      return `${who} accepted your friend request`;
    case 'message':
      return `${who}: ${previewText({ body: row.body })}`;
    case 'reaction':
      return `${who} reacted to your message`;
    default:
      return row.body ? String(row.body) : 'New activity';
  }
}

/** A send is allowed only with text or an attachment. */
export function draftIsSendable({ text, attachment } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (attachment) return true;
  return body.length > 0 && body.length <= 4000;
}

/** Compose the payload the send RPC expects. */
export function buildSendPayload({ text, attachment, replyTo } = {}) {
  const body = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
  return {
    body,
    media_path: attachment ? attachment.path : null,
    media_type: attachment ? attachment.kind : null,
    reply_to: replyTo || null,
  };
}

/** Friend-request button state for a discovered profile. */
export function friendAction(status, isSelf) {
  if (isSelf) return { label: 'You', disabled: true, action: 'none' };
  switch (status) {
    case 'friends':
    case 'friend':
    case 'accepted':
      return { label: 'Message', disabled: false, action: 'message' };
    case 'self':
      return { label: 'You', disabled: true, action: 'none' };
    case 'pending_out':
      return { label: 'Request Sent', disabled: true, action: 'none' };
    case 'pending_in':
      return { label: 'Respond', disabled: false, action: 'requests' };
    default:
      return { label: 'Add friend', disabled: false, action: 'request' };
  }
}

/* ---------------------- conversation header (Phase 2) ---------------------- */

/**
 * Menu shown in a conversation header.
 *
 * Only actions that apply to the current relationship are returned: a removed
 * friend keeps the chat but loses "Remove friend", and a blocked peer offers
 * "Unblock user" instead of "Block user".
 */
export function threadMenuModel({ isFriend = false, isBlocked = false, isSelf = false } = {}) {
  if (isSelf) return { visible: false, items: [] };
  const items = [{ id: 'profile', label: 'View profile', danger: false }];
  if (isFriend && !isBlocked) items.push({ id: 'remove', label: 'Remove friend', danger: false });
  if (isBlocked) items.push({ id: 'unblock', label: 'Unblock user', danger: false });
  else items.push({ id: 'block', label: 'Block user', danger: true });
  return { visible: true, items };
}

/** True when personId appears in the signed-in user's own block list. */
export function isPersonBlocked(blocked, personId) {
  if (!personId) return false;
  const list = Array.isArray(blocked) ? blocked : [];
  return list.some((person) => person && person.id === personId);
}

/** Banner copy for a conversation the user has blocked. */
export function threadBlockedNotice(username) {
  const clean = String(username || '').trim();
  const handle = clean ? (clean.startsWith('@') ? clean : `@${clean}`) : 'this user';
  return `You blocked ${handle}. Unblock to send new messages — existing messages stay in your history.`;
}
