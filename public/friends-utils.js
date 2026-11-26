/**
 * LOKY AI Next — friend request rules (pure, no DOM, no network).
 *
 * The database is the authority: these helpers only decide what the UI shows
 * and are unit tested so the states stay consistent between the search list,
 * the Friend Requests section and the server responses.
 */

export const REQUEST_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled'];

export const STATUS_LABELS = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || 'Unknown';
}

/** Pending is the only state a receiver can act on. */
export function canRespondToRequest(request, meId) {
  if (!request || !meId) return false;
  return request.status === 'pending' && request.direction === 'incoming' && request.other_id !== meId;
}

/** Pending is the only state a sender can cancel. */
export function canCancelRequest(request, meId) {
  if (!request || !meId) return false;
  return request.status === 'pending' && request.direction === 'outgoing' && request.other_id !== meId;
}

/**
 * Validate a request before it is sent. Mirrors the database rules so the user
 * gets an immediate answer, while the RPC still enforces them for real.
 */
export function validateFriendRequest({ meId, targetId, currentStatus } = {}) {
  if (!meId) return { ok: false, code: 'not_authenticated' };
  if (!targetId) return { ok: false, code: 'invalid_recipient' };
  if (targetId === meId) return { ok: false, code: 'cannot_request_self' };
  if (currentStatus === 'friends') return { ok: false, code: 'already_friends' };
  if (currentStatus === 'pending_out') return { ok: false, code: 'request_pending' };
  if (currentStatus === 'pending_in') return { ok: false, code: 'request_pending_incoming' };
  return { ok: true, code: null };
}

/**
 * What the action button next to a person should say and do, given the
 * relationship status returned by public.friend_status().
 */
export function friendButtonModel(status) {
  switch (status) {
    case 'self':
      return { label: 'You', action: null, disabled: true };
    case 'friends':
      return { label: 'Message', action: 'message', disabled: false };
    case 'pending_out':
      return { label: 'Requested', action: 'cancel', disabled: false };
    case 'pending_in':
      return { label: 'Respond', action: 'respond', disabled: false };
    default:
      return { label: 'Add friend', action: 'request', disabled: false };
  }
}

/** Split the request list into the two sections the UI renders. */
export function groupRequests(rows, meId) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const incoming = [];
  const outgoing = [];
  for (const row of list) {
    if (row.other_id && row.other_id === meId) continue; // never show yourself
    const direction =
      row.direction || (row.receiver_id && row.receiver_id === meId ? 'incoming' : 'outgoing');
    if (direction === 'incoming') incoming.push({ ...row, direction });
    else outgoing.push({ ...row, direction });
  }
  const pendingCount =
    incoming.filter((r) => r.status === 'pending').length +
    outgoing.filter((r) => r.status === 'pending').length;
  return { incoming, outgoing, pendingCount };
}

/** Number shown on the nav badge: incoming requests still waiting. */
export function pendingIncomingCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.status === 'pending' && r.direction === 'incoming',
  ).length;
}

/** Human text for a database/RPC error code. */
export function describeFriendError(code) {
  const map = {
    cannot_request_self: 'You cannot send a friend request to yourself.',
    request_pending: 'There is already a pending request between you two.',
    request_pending_incoming: 'This person already sent you a request — open Friend requests to respond.',
    already_friends: 'You are already friends with this person.',
    user_not_found: 'That account no longer exists.',
    user_unavailable: 'That account is not available right now.',
    not_your_request: 'That request does not belong to you.',
    request_already_answered: 'This request was already answered.',
    not_authenticated: 'Please sign in again.',
    reason_required: 'Please add a short reason.',
    not_authorized: 'You are not allowed to do that.',
    user_blocked: 'This chat is unavailable because one of you blocked the other.',
    cannot_block_self: 'You cannot block yourself.',
    cannot_remove_self: 'You cannot remove yourself.',
    not_friends: 'You are not friends with this person any more.',
    block_not_found: 'That person is not in your blocked list.',
    migration_missing: 'Friend management is not enabled on the server yet.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

/* ---------------------------- friend management --------------------------- */

/**
 * The three-dot menu shown on every friend row. Both entries need a
 * confirmation step, so the menu only names the intent; the UI asks first.
 */
export const FRIEND_MENU_ITEMS = [
  { id: 'remove', label: 'Remove friend', danger: false },
  { id: 'block', label: 'Block user', danger: true },
];

/** Which menu a row may show. Only real friends get one; never yourself. */
export function friendMenuModel(status) {
  if (status !== 'friends') return { visible: false, items: [] };
  return { visible: true, items: FRIEND_MENU_ITEMS.map((item) => ({ ...item })) };
}

function handleFor(name) {
  const clean = String(name || '').trim();
  if (!clean) return 'this person';
  return clean.startsWith('@') ? clean : `@${clean}`;
}

export function removeFriendConfirmText(name) {
  const handle = handleFor(name);
  return {
    title: 'Remove friend?',
    body: `${handle} will be removed from your friends. They will not be blocked and can send you a new request later.`,
    confirmLabel: 'Remove friend',
    danger: false,
  };
}

export function blockUserConfirmText(name) {
  const handle = handleFor(name);
  return {
    title: 'Block user?',
    body: `${handle} will be removed from your friends and cannot message you, send friend requests or react in your chats. Their existing messages stay in your history.`,
    confirmLabel: 'Block user',
    danger: true,
  };
}

/**
 * Pure list updates so the UI can react the instant the database confirms an
 * action, without waiting for the next poll.
 */
export function withoutPerson(list, userId) {
  return (Array.isArray(list) ? list : []).filter(
    (row) => row && row.user_id !== userId && row.id !== userId,
  );
}

export function withPerson(list, row) {
  const base = Array.isArray(list) ? list : [];
  if (!row || !row.id) return base;
  if (base.some((item) => item && item.id === row.id)) return base;
  return [row, ...base];
}

/** Blocked list rows from public.my_blocked_users(), never including yourself. */
export function blockedListModel(rows, meId) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  return list.filter((row) => row.id !== meId && row.username);
}
