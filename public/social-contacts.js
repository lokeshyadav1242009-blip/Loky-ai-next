/**
 * LOKY CONNECT — contact list model.
 *
 * Chats and Friends are two different relationships in the database. Chats come
 * from conversation_members/connect_threads, Friends from the friendships table
 * via my_friends(); start_conversation() never creates a friendship row. So
 * somebody you can message is not automatically a friend, and an empty Friends
 * tab used to be correct rather than a bug.
 *
 * The social list now shows both in one place, but never blurs them: an
 * accepted friendship is labelled "Friend" and a chat-only contact is labelled
 * "Chat contact". Nothing here invents a friendship — a row is only a friend
 * when my_friends() returned it.
 *
 * Pure module: no DOM, no fetch, no globals, so the merge rules are unit tested.
 */

export const CONTACT_KIND_FRIEND = 'friend';
export const CONTACT_KIND_CHAT = 'chat';

/** Label shown on a contact row. */
export function contactKindLabel(kind) {
  return kind === CONTACT_KIND_FRIEND ? 'Friend' : 'Chat contact';
}

/** True when the contact is an accepted friendship. */
export function isFriendContact(contact) {
  return Boolean(contact) && contact.kind === CONTACT_KIND_FRIEND;
}

function cleanUsername(value) {
  return typeof value === 'string' ? value.trim().replace(/^@+/, '') : '';
}

function timeOf(value) {
  const at = new Date(value || 0).getTime();
  return Number.isNaN(at) ? 0 : at;
}

/** Friends first, then the most recently active chat, then username. */
function sortContacts(rows) {
  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === CONTACT_KIND_FRIEND ? -1 : 1;
    const at = timeOf(a.lastAt);
    const bt = timeOf(b.lastAt);
    if (bt !== at) return bt - at;
    return String(a.username || '').localeCompare(String(b.username || ''));
  });
}

/**
 * Merge accepted friends and chat contacts into one list.
 *
 * Deduped by user id: an accepted friendship always wins over the same person
 * appearing as a chat contact, and the signed-in user is never listed.
 *
 * @returns {Array<{userId:string|null,username:string,displayName:string,
 *   avatarSeed:string,kind:'friend'|'chat',friendsSince:string|null,
 *   conversationId:string|null,lastAt:string|null,unreadCount:number,
 *   friendRow?:object,threadRow?:object}>}
 */
export function buildContacts({ friends, threads, meId } = {}) {
  const byId = new Map();

  for (const row of Array.isArray(friends) ? friends : []) {
    const id = row && (row.user_id || row.id);
    if (!id || id === meId) continue;
    const username = cleanUsername(row.username);
    byId.set(id, {
      userId: id,
      username,
      displayName: row.display_name || '',
      avatarSeed: row.avatar_seed || username,
      kind: CONTACT_KIND_FRIEND,
      friendsSince: row.friends_since || null,
      conversationId: null,
      lastAt: null,
      unreadCount: 0,
      friendRow: row,
    });
  }

  for (const row of Array.isArray(threads) ? threads : []) {
    const id = row && row.peer_id;
    const username = cleanUsername(row && row.peer_username);
    // Without an id and a username there is nothing to identify the person by.
    if (!id && !username) continue;
    if (id && id === meId) continue;

    // peer_id is authoritative; the username is only a fallback so an older
    // payload still cannot list the same person twice.
    const key = id || `u:${username.toLowerCase()}`;
    const existing = byId.get(key);
    if (existing) {
      existing.conversationId = existing.conversationId || row.conversation_id || null;
      existing.lastAt = row.last_at || existing.lastAt;
      existing.unreadCount = Number(row.unread_count) || existing.unreadCount || 0;
      continue;
    }

    byId.set(key, {
      userId: id || null,
      username,
      displayName: row.peer_display_name || '',
      avatarSeed: row.peer_avatar_url || username,
      kind: CONTACT_KIND_CHAT,
      friendsSince: null,
      conversationId: row.conversation_id || null,
      lastAt: row.last_at || null,
      unreadCount: Number(row.unread_count) || 0,
      threadRow: row,
    });
  }

  return sortContacts([...byId.values()]);
}

/** '3 friends · 2 chat contacts' for the pane subtitle. */
export function contactSummary(contacts) {
  const list = Array.isArray(contacts) ? contacts : [];
  const friends = list.filter((contact) => contact.kind === CONTACT_KIND_FRIEND).length;
  const chats = list.length - friends;
  const parts = [];
  if (friends) parts.push(`${friends} ${friends === 1 ? 'friend' : 'friends'}`);
  if (chats) parts.push(`${chats} chat ${chats === 1 ? 'contact' : 'contacts'}`);
  return parts.join(' · ');
}

/** Filter contacts by username or display name (case-insensitive). */
export function filterContacts(contacts, term) {
  const list = Array.isArray(contacts) ? contacts : [];
  const q = String(term || '').trim().toLowerCase().replace(/^@+/, '');
  if (!q) return list;
  return list.filter((contact) =>
    `${contact.username || ''} ${contact.displayName || ''}`.toLowerCase().includes(q)
  );
}
