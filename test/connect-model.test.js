import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECT_TABS,
  REACTIONS,
  normalizeTab,
  validateAttachment,
  previewText,
  unreadLabel,
  groupReactions,
  totalUnread,
  pendingIncoming,
  draftIsSendable,
  buildSendPayload,
  friendAction,
  initials,
} from '../public/connect-model.js';

test('the four LOKY CONNECT tabs are chats, friends, requests, discover', () => {
  assert.deepEqual(
    CONNECT_TABS.map((tab) => tab.id),
    ['chats', 'friends', 'requests', 'discover']
  );
  for (const tab of CONNECT_TABS) {
    assert.ok(tab.label.length > 0, 'every tab needs a label');
  }
});

test('normalizeTab falls back to chats for junk input', () => {
  assert.equal(normalizeTab('friends'), 'friends');
  assert.equal(normalizeTab('DISCOVER'), 'discover');
  assert.equal(normalizeTab('nonsense'), 'chats');
  assert.equal(normalizeTab(undefined), 'chats');
});

test('validateAttachment accepts images and videos inside the limits', () => {
  const image = validateAttachment({ type: 'image/png', size: 1024, name: 'a.png' });
  assert.equal(image.ok, true);
  assert.equal(image.kind, 'image');

  const video = validateAttachment({ type: 'video/mp4', size: 1024 * 1024, name: 'a.mp4' });
  assert.equal(video.ok, true);
  assert.equal(video.kind, 'video');
});

test('validateAttachment rejects unsupported types and oversize files', () => {
  const pdf = validateAttachment({ type: 'application/pdf', size: 100, name: 'a.pdf' });
  assert.equal(pdf.ok, false);
  assert.match(pdf.error, /PNG|JPG|MP4/i);

  const huge = validateAttachment({ type: 'video/mp4', size: 500 * 1024 * 1024, name: 'a.mp4' });
  assert.equal(huge.ok, false);

  assert.equal(validateAttachment(null).ok, false);
});

test('previewText never renders an empty preview for a media-only message', () => {
  assert.equal(previewText({ body: 'hello there' }), 'hello there');
  const media = previewText({ body: '', media_type: 'image' });
  assert.ok(media.length > 0, 'media preview must not be blank');
  assert.equal(previewText({ deleted_at: '2026-01-01' }).length > 0, true);
});

test('unreadLabel is blank at zero and shows a count otherwise', () => {
  assert.equal(unreadLabel(0), '');
  assert.equal(unreadLabel(3), '3');
  assert.ok(unreadLabel(250).length > 0);
});

test('totalUnread sums thread counts and ignores junk', () => {
  assert.equal(totalUnread([{ unread_count: 2 }, { unread_count: 0 }, { unread_count: 5 }]), 7);
  assert.equal(totalUnread([]), 0);
  assert.equal(totalUnread([{ unread_count: '4' }]), 4);
});

test('pendingIncoming only counts incoming requests', () => {
  // my_friend_requests() returns 'incoming'/'outgoing' plus a status column;
  // only a pending incoming request should raise the Requests badge.
  const rows = [
    { direction: 'incoming', status: 'pending' },
    { direction: 'outgoing', status: 'pending' },
    { direction: 'incoming', status: 'accepted' },
  ];
  assert.equal(pendingIncoming(rows), 1);
  assert.equal(pendingIncoming([]), 0);
});

test('groupReactions collapses rows and flags the current user', () => {
  const rows = [
    { emoji: '❤️', user_id: 'me' },
    { emoji: '❤️', user_id: 'other' },
    { emoji: '🔥', user_id: 'other' },
  ];
  const chips = groupReactions(rows, 'me');
  assert.equal(chips.length, 2);

  const heart = chips.find((chip) => chip.emoji === '❤️');
  assert.equal(heart.count, 2);
  assert.equal(heart.mine, true);

  const fire = chips.find((chip) => chip.emoji === '🔥');
  assert.equal(fire.count, 1);
  assert.equal(fire.mine, false);

  assert.deepEqual(groupReactions([], 'me'), []);
  assert.ok(REACTIONS.includes('❤️'));
});

test('friendAction maps relationship state to the button the UI shows', () => {
  assert.equal(friendAction('none', false).action, 'request');
  assert.equal(friendAction('pending_out', false).disabled, true);
  assert.equal(friendAction('pending_in', false).action, 'requests');
  assert.equal(friendAction('friends', false).action, 'message');
  assert.equal(friendAction('none', true).disabled, true, 'you cannot add yourself');
});

test('draftIsSendable requires text or an attachment', () => {
  assert.equal(draftIsSendable({ text: '   ' }), false);
  assert.equal(draftIsSendable({ text: 'hi' }), true);
  assert.equal(draftIsSendable({ text: '', attachment: { path: 'x', kind: 'image' } }), true);
  assert.equal(draftIsSendable({ text: 'x'.repeat(4001) }), false);
});

test('buildSendPayload trims text and maps the attachment and reply', () => {
  const payload = buildSendPayload({
    text: '  hello  ',
    attachment: { path: 'conv/1.png', kind: 'image' },
    replyTo: 'msg-1',
  });
  assert.equal(payload.body, 'hello');
  assert.equal(payload.media_path, 'conv/1.png');
  assert.equal(payload.media_type, 'image');
  assert.equal(payload.reply_to, 'msg-1');

  const plain = buildSendPayload({ text: 'hi' });
  assert.equal(plain.media_path, null);
  assert.equal(plain.reply_to, null);
});

test('initials produce at most two uppercase characters', () => {
  assert.equal(initials('lokesh yadav'), 'LY');
  assert.equal(initials('sunita'), 'S');
  assert.equal(initials(''), '?');
  assert.ok(initials('a b c').length <= 2);
});
