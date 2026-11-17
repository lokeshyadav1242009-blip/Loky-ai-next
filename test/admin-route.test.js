import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * /admin must render the dashboard, not the assistant.
 *
 * The regression this file locks down: the dashboard was only ever revealed
 * from a `loky:auth-changed` listener, and the single dispatch of that event is
 * the SIGN-OUT path (public/direct-messages.js). Nothing announced a signed-in
 * session, so verifyAdminAccess() never ran on a normal visit and /admin fell
 * through to the AI assistant. The auth gate now tells the admin UI directly.
 *
 * Access itself is decided by the server (GET /api/admin/session, which only
 * answers 200 for the configured Super Admin UUID). Nothing here grants access
 * from a username, an email or local state.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = (name) => fs.readFileSync(path.join(root, 'public', name), 'utf8');

const appJs = pub('app.js');
const adminJs = pub('admin-ui.js');
const html = pub('index.html');
const css = pub('styles.css');
const serverAdmin = fs.readFileSync(path.join(root, 'server', 'admin.js'), 'utf8');

/* ------------------------------- the wiring ------------------------------- */

test('the auth gate announces a signed-in session to the admin UI', () => {
  assert.match(appJs, /const adminUI = initAdminUI\(\)/);
  assert.match(
    appJs,
    /onUnlocked:\s*\(\)\s*=>\s*\{[\s\S]{0,240}?syncAdmin\?\.\(\{\s*signedIn:\s*true\s*\}\)/,
  );
  assert.match(
    appJs,
    /onLocked:\s*\(\)\s*=>\s*\{[\s\S]{0,240}?syncAdmin\?\.\(\{\s*signedIn:\s*false\s*\}\)/,
  );
});

test('syncAdmin is exported and collapses overlapping session checks', () => {
  assert.match(adminJs, /export async function syncAdmin/);
  assert.match(adminJs, /if \(syncPromise\) return syncPromise/);
  assert.match(adminJs, /return \{ openAdmin, closeAdmin, verifyAdminAccess, syncAdmin \}/);
});

test('the dashboard still waits for the server before opening on a deep link', () => {
  // Path check is exact ('/admin'), tolerating a trailing slash only.
  assert.match(adminJs, /=== '\/admin'/);
  assert.match(adminJs, /if \(isAdminPath\(\)\) await openAdmin\(\)/);
  assert.match(adminJs, /if \(isAdminPath\(\)\) showAdminDenied\(\)/);
});

test('access is decided by /api/admin/session, not by a name or local state', () => {
  assert.match(adminJs, /api\('\/session'\)/);
  assert.match(adminJs, /data\?\.isAdmin === true/);
  // A signed-in non-owner must never be treated as an admin.
  assert.doesNotMatch(adminJs, /localStorage/);
  assert.doesNotMatch(adminJs, /signedIn\s*\?\s*true/);
});

test('a token that lags the unlock is retried once, not read as denial', () => {
  assert.match(adminJs, /async function adminSession/);
  assert.match(adminJs, /error\?\.status === 401/);
  // The retry is bounded: exactly one extra attempt.
  assert.match(adminJs, /setTimeout\(resolve, 250\)/);
});

test('signing out hides the nav entry and closes the panel', () => {
  assert.match(adminJs, /hideAdminDenied/);
  assert.match(adminJs, /el\.navAdmin\?\.setAttribute\('hidden', ''\)/);
  assert.match(adminJs, /function closeAdmin\(\)/);
});

/* ------------------------------ the sections ------------------------------ */

test('the dashboard exposes Users, Messages, Conversations, System status and Analytics', () => {
  for (const tab of ['users', 'messages', 'chats', 'system', 'analytics']) {
    assert.match(html, new RegExp(`data-admin-tab="${tab}"`));
  }
  assert.match(html, />Users</);
  assert.match(html, />Messages</);
  assert.match(html, />Conversations</);
  assert.match(html, />System status</);
  assert.match(html, />Analytics</);
});

test('the Messages section reads metadata from the admin API', () => {
  assert.match(adminJs, /el\.tabMessages\?\.addEventListener\('click', loadMessages\)/);
  assert.match(adminJs, /api\('\/messages'\)/);
  assert.match(adminJs, /function renderMessages\(\)/);
  // Contents are never listed, only ids and timestamps.
  assert.match(adminJs, /Message contents are never listed here/);
  assert.match(serverAdmin, /router\.get\('\/messages'/);
  assert.match(serverAdmin, /select=id,conversation_id,created_at/);
});

test('the panel is a full-screen layer, so it replaces the assistant view', () => {
  assert.match(css, /\.admin \{[^}]*position: fixed/);
  assert.match(css, /\.admin \{[^}]*inset: 0/);
  assert.match(html, /id="adminPanel"[^>]*hidden/);
});

test('Access Denied is its own surface, separate from the panel', () => {
  assert.match(html, /id="adminDenied"/);
  assert.match(adminJs, /function showAdminDenied\(\)/);
  assert.match(html, /id="adminClose"/);
});
