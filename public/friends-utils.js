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
  };
  return map[code] || 'Something went wrong. Please try again.';
}
