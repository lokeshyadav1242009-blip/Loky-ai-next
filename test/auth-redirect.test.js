/**
 * Regression tests for the confirmation-link and signup repairs.
 *
 * These run in node against the same pure helpers the browser imports
 * (public/auth-utils.js), so the behaviour asserted here is exactly what
 * direct-messages.js relies on when it handles a Supabase auth redirect.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SIGNUP_INTENT_VERSION,
  classifyAuthError,
  createSignupIntent,
  describeAuthLinkError,
  hasAuthRedirect,
  isSignupIntentUsable,
  normalizeDisplayName,
  parseAuthRedirect,
  stripAuthRedirect,
  validateEmail,
  validatePassword,
  validateSignupForm,
} from '../public/auth-utils.js';

const SITE = 'https://loky.example.com/';

/* ------------------------------- callbacks -------------------------------- */

test('a plain visit is not an auth redirect', () => {
  for (const href of [SITE, `${SITE}?utm=x`, `${SITE}#chat`, '']) {
    const parsed = parseAuthRedirect(href);
    assert.equal(parsed.action, 'none', href);
    assert.equal(hasAuthRedirect(href), false, href);
  }
});

test('implicit-flow confirmation (#access_token…) becomes a session', () => {
  const parsed = parseAuthRedirect(
    `${SITE}#access_token=abc123&refresh_token=ref456&expires_in=3600&token_type=bearer&type=signup`
  );

  assert.equal(parsed.action, 'session');
  assert.equal(parsed.type, 'signup');
  assert.deepEqual(parsed.session, {
    accessToken: 'abc123',
    refreshToken: 'ref456',
    expiresIn: 3600,
  });
  assert.equal(hasAuthRedirect(`${SITE}#access_token=abc123`), true);
});

test('a session without expires_in still gets a usable lifetime', () => {
  const parsed = parseAuthRedirect(`${SITE}#access_token=abc&type=magiclink`);
  assert.equal(parsed.action, 'session');
  assert.equal(parsed.session.expiresIn, 3600);
  assert.equal(parsed.type, 'magiclink');
});

test('token_hash links keep their type so /verify can be called', () => {
  const parsed = parseAuthRedirect(`${SITE}?token_hash=hash789&type=email`);
  assert.equal(parsed.action, 'token_hash');
  assert.equal(parsed.tokenHash, 'hash789');
  assert.equal(parsed.type, 'email');
});

test('PKCE code links are detected (and never mistaken for a session)', () => {
  const parsed = parseAuthRedirect(`${SITE}?code=pkce-code-1&state=xyz`);
  assert.equal(parsed.action, 'code');
  assert.equal(parsed.code, 'pkce-code-1');
  assert.equal(parsed.session, null);
});

test('expired and denied links are classified for the user-facing copy', () => {
  const expired = parseAuthRedirect(
    `${SITE}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`
  );
  assert.equal(expired.action, 'error');
  assert.equal(expired.error.kind, 'expired');

  const denied = parseAuthRedirect(`${SITE}#error=access_denied&error_description=User+denied`);
  assert.equal(denied.action, 'error');
  assert.equal(denied.error.kind, 'denied');

  const invalid = parseAuthRedirect(`${SITE}#error_code=invalid_request`);
  assert.equal(invalid.action, 'error');
  assert.equal(invalid.error.kind, 'invalid');

  assert.equal(classifyAuthError('otp_expired', ''), 'expired');
  assert.match(describeAuthLinkError({ kind: 'expired' }), /expired|already used/i);
  assert.match(describeAuthLinkError({ kind: 'invalid' }), /not valid/i);
});

test('an error in the URL wins over a stale token in the same URL', () => {
  const parsed = parseAuthRedirect(
    `${SITE}?error=access_denied&error_code=otp_expired#access_token=abc&type=signup`
  );
  assert.equal(parsed.action, 'error');
  assert.equal(parsed.error.kind, 'expired');
});

/* ------------------------------ URL stripping ----------------------------- */

test('stripping removes only auth parameters and keeps the rest', () => {
  assert.equal(
    stripAuthRedirect(
      `${SITE}#access_token=abc&refresh_token=def&expires_in=3600&type=signup&error_code=x`
    ),
    SITE
  );

  assert.equal(
    stripAuthRedirect(`${SITE}?token_hash=h&type=email&keep=1`),
    `${SITE}?keep=1`
  );

  assert.equal(stripAuthRedirect(`${SITE}?code=abc&state=s`), SITE);
  assert.equal(stripAuthRedirect(`${SITE}#chat`), `${SITE}#chat`);
  assert.equal(stripAuthRedirect(SITE), SITE);
});

test('a stripped URL is no longer an auth redirect (no redirect loop)', () => {
  const href = `${SITE}?token_hash=h&type=signup&tab=messages`;
  const stripped = stripAuthRedirect(href);

  assert.equal(hasAuthRedirect(href), true);
  assert.equal(hasAuthRedirect(stripped), false);
  assert.equal(parseAuthRedirect(stripped).action, 'none');
  assert.match(stripped, /tab=messages/);
});

/* --------------------------------- signup --------------------------------- */

test('email validation rejects obviously broken addresses', () => {
  assert.equal(validateEmail('someone@example.com').ok, true);
  assert.equal(validateEmail('  Someone@Example.com  ').ok, true);
  assert.equal(validateEmail('').ok, false);
  assert.equal(validateEmail('nope').ok, false);
  assert.equal(validateEmail('a@b').ok, false);
  assert.equal(validateEmail('a b@example.com').ok, false);
});

test('password validation enforces a minimum length locally', () => {
  assert.equal(validatePassword('12345').ok, false);
  assert.equal(validatePassword('123456').ok, true);
  assert.equal(validatePassword('x'.repeat(PASSWORD_MIN_LENGTH)).ok, true);
  assert.equal(validatePassword('x'.repeat(PASSWORD_MAX_LENGTH)).ok, true);
  assert.equal(validatePassword('x'.repeat(PASSWORD_MAX_LENGTH + 1)).ok, false);
  assert.equal(validatePassword('').ok, false);
});

test('signup form requires display name, username, email and password together', () => {
  const good = validateSignupForm({
    displayName: '  Lokesh  ',
    username: '  @Lokesh_Dev ',
    email: ' lokesh@example.com ',
    password: 'secret123',
  });

  assert.equal(good.ok, true);
  assert.deepEqual(good.errors, {});
  // Canonical stored form: username normalised, email trimmed.
  assert.equal(good.value.username, 'lokesh_dev');
  assert.equal(good.value.email, 'lokesh@example.com');
  assert.equal(good.value.displayName, 'Lokesh');
  assert.equal(good.value.password, 'secret123');

  const missingUsername = validateSignupForm({
    displayName: 'Lokesh',
    username: '',
    email: 'lokesh@example.com',
    password: 'secret123',
  });
  assert.equal(missingUsername.ok, false);
  assert.ok(missingUsername.errors.username);

  const badPassword = validateSignupForm({
    displayName: 'Lokesh',
    username: 'lokesh_dev',
    email: 'lokesh@example.com',
    password: '123',
  });
  assert.equal(badPassword.ok, false);
  assert.ok(badPassword.errors.password);

  const reserved = validateSignupForm({
    displayName: 'Lokesh',
    username: 'admin',
    email: 'lokesh@example.com',
    password: 'secret123',
  });
  assert.equal(reserved.ok, false);
  assert.match(reserved.errors.username, /reserved/i);
});

test('display names are trimmed, collapsed and optional', () => {
  assert.equal(normalizeDisplayName('  Lokesh   Yadav '), 'Lokesh Yadav');
  assert.equal(normalizeDisplayName(''), '');
  assert.equal(normalizeDisplayName(undefined), '');

  const noName = validateSignupForm({
    username: 'lokesh_dev',
    email: 'lokesh@example.com',
    password: 'secret123',
  });
  assert.equal(noName.ok, true);
  assert.equal(noName.value.displayName, '');
});

/* ------------------------------ signup intent ----------------------------- */

test('the signup intent survives the confirmation round-trip', () => {
  const now = Date.now();
  const intent = createSignupIntent(
    { email: '  Lokesh@Example.com ', username: '@Lokesh_Dev', displayName: ' Lokesh ' },
    now
  );

  assert.equal(intent.v, SIGNUP_INTENT_VERSION);
  assert.equal(intent.username, 'lokesh_dev');
  assert.equal(intent.email, 'lokesh@example.com');
  assert.equal(intent.displayName, 'Lokesh');
  assert.equal(intent.password, undefined, 'no password is ever stored');

  // Same address, different casing/whitespace: still usable.
  assert.equal(isSignupIntentUsable(intent, 'lokesh@example.com', now + 1000), true);
  assert.equal(isSignupIntentUsable(intent, ' LOKESH@example.COM ', now + 1000), true);
  // Different account or older than a week: not usable.
  assert.equal(isSignupIntentUsable(intent, 'other@example.com', now + 1000), false);
  assert.equal(isSignupIntentUsable(intent, 'lokesh@example.com', now + 8 * 24 * 60 * 60 * 1000), false);
});

test('a stale or hostile signup intent is rejected', () => {
  assert.equal(isSignupIntentUsable(null, 'a@b.co'), false);
  assert.equal(isSignupIntentUsable({ username: 'ab' }, 'a@b.co'), false);
  assert.equal(isSignupIntentUsable({ v: 0, username: 'lokesh_dev' }, 'a@b.co'), false);
  assert.equal(
    isSignupIntentUsable({ v: SIGNUP_INTENT_VERSION, username: 'admin', at: Date.now() }, 'a@b.co'),
    false
  );
  // No email yet (session not loaded) is not a reason to discard it.
  assert.equal(
    isSignupIntentUsable(
      { v: SIGNUP_INTENT_VERSION, username: 'lokesh_dev', at: Date.now() },
      ''
    ),
    true
  );
});

/* ---------------------------- page wiring sanity --------------------------- */

test('signup markup and identical field ids exist in the shipped page', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  // The ids direct-messages.js looks up must exist, or the form silently stalls.
  for (const id of [
    'dmEmail',
    'dmPassword',
    'dmSignIn',
    'dmSignUp',
    'dmSignupFields',
    'dmUsernameNew',
    'dmSignupHelp',
    'authBanner',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }

  // The signup extras start hidden: existing users must never see them.
  assert.match(html, /id="dmSignupFields"[^>]*hidden/);
  assert.match(html, /id="authBanner"[^>]*hidden/);
});

test('the browser layer handles redirects before loading the profile', async () => {
  const source = await readFile(new URL('../public/direct-messages.js', import.meta.url), 'utf8');

  // Regression: a confirmation link used to load nothing but a signed-out chip.
  assert.match(source, /handleAuthRedirect/);
  assert.match(source, /stripAuthRedirect\(/);
  assert.match(source, /establishSession\(/);
  assert.match(source, /verifyTokenHash\(/);
  // Confirmation must never be replayed by a reload.
  assert.match(source, /replaceState/);
  // Signup must not create the profile before the account exists.
  assert.match(source, /applySignupIntent/);
  assert.doesNotMatch(source, /password.*localStorage/i);
});
