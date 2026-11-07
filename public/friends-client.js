/**
 * LOKY AI Next — friend requests, friendships and reporting (network layer).
 *
 * Every call goes through the existing authenticated Supabase client, so the
 * session, timeout and error mapping behave exactly like Mini Chat. The
 * database functions decide what is allowed; this module only names them.
 */

import { callRpc, currentUser } from './supabase-client.js';

/** Error codes the database raises on purpose (see 0002_friends_admin.sql). */
export const FRIEND_ERROR_CODES = new Set([
  'not_authenticated',
  'cannot_request_self',
  'invalid_recipient',
  'request_pending',
  'already_friends',
  'user_not_found',
  'user_unavailable',
  'not_your_request',
  'request_already_answered',
  'request_not_found',
  'invalid_decision',
  'reason_required',
  'not_authorized',
  'not_a_participant',
  'report_target_required',
  'message_not_found',
  'migration_missing',
]);

/**
 * Postgres reports a raised message as `message` with code P0001, so check both
 * places before falling back to the transport code.
 */
export function friendErrorCode(error) {
  if (!error) return 'unknown';
  if (FRIEND_ERROR_CODES.has(error.code)) return error.code;
  const message = String(error.message || '').trim();
  if (FRIEND_ERROR_CODES.has(message)) return message;
  return error.code || 'unknown';
}

export function currentUserId() {
  const user = currentUser();
  return user && user.id ? user.id : null;
}

async function call(name, args) {
  try {
    return await callRpc(name, args || {});
  } catch (error) {
    const code = friendErrorCode(error);
    const wrapped = new Error(code);
    wrapped.code = code;
    wrapped.cause = error;
    throw wrapped;
  }
}

/* ------------------------------ friend requests ---------------------------- */

export function listFriendRequests() {
  return call('my_friend_requests', {});
}

export function listFriends() {
  return call('my_friends', {});
}

export function getFriendStatus(userId) {
  if (!userId) return Promise.resolve('none');
  return call('friend_status', { other_user: userId });
}

export function sendFriendRequest(userId, note = null) {
  return call('send_friend_request', { other_user: userId, note: note || null });
}

export function respondToFriendRequest(requestId, decision) {
  return call('respond_friend_request', { request_id: requestId, decision });
}

export function cancelFriendRequest(requestId) {
  return call('cancel_friend_request', { request_id: requestId });
}

/* --------------------------------- presence -------------------------------- */

export function touchPresence() {
  return call('touch_last_seen', {});
}

/* --------------------------------- reporting ------------------------------- */

export function reportContent({ reason, conversationId = null, messageId = null, details = null }) {
  return call('report_content', {
    reason,
    conversation_id: conversationId,
    message_id: messageId,
    details,
  });
}
