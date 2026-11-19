/**
 * Regression tests for the simplified signup experience.
 *
 * The signup screen collects an email and a password only. The profile — with a
 * unique username — is generated after the account exists, and Google is offered
 * only when the Supabase project reports the provider as enabled. These tests
 * pin both contracts so a future edit cannot quietly put the extra fields back
 * or ship a Google button that dead-ends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildOAuthUrl,
  isProviderEnabled,
  passwordChecks,
  validateSignupCredentials,
} from '../public/auth-utils.js';
import { suggestUsername, validateUsername } from '../public/username-utils.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');

/** The markup of one gate screen, from its id to the closing </form>. */
function screenMarkup(id) {
  const start = html.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `the ${id} screen must exist`);
  const end = html.indexOf('</form>', start);
  assert.notEqual(end, -1, `the ${id} screen must be a form`);
  return html.slice(start, end);
}

test('signup asks for an email and a password only', () => {
  const form = screenMarkup('authSignUp');
  const inputs = [...form.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);

  assert.equal(inputs.length, 2, 'exactly two fields: email and password');
  assert.match(inputs[0], /type="email"/);
  assert.match(inputs[1], /type="password"/);

  // The fields that made signup long must stay gone.
  for (const gone of [
    'authDisplayName',
    'authUsernameNew',
    'authSignupHelp',
    'name="username"',
    'name="name"',
    'type="tel"',
  ]) {
    assert.equal(form.includes(gone), false, `${gone} must not be on the signup screen`);
  }
});

test('signup exposes password reveal, live requirements and optional Google', () => {
  const form = screenMarkup('authSignUp');
  assert.match(form, /id="authPasswordNewToggle"/);
  assert.match(form, /id="authPasswordNewReq"/);
  // Hidden until the project reports the provider as enabled.
  assert.match(form, /id="authOauthSignup"[^>]*hidden/);
  assert.match(form, /id="authGoogleBtn"/);
});

test('sign-in keeps its fields and gains a reveal plus the same optional Google', () => {
  const form = screenMarkup('authSignIn');
  assert.match(form, /id="authEmail"/);
  assert.match(form, /id="authPassword"/);
  assert.match(form, /id="authPasswordToggle"/);
  assert.match(form, /id="authOauth"[^>]*hidden/);
  assert.match(form, /id="authGoogleBtnSignIn"/);
});

test('validateSignupCredentials accepts email + password and reports each problem', () => {
  const good = validateSignupCredentials({
    email: '  lokesh@example.com ',
    password: 'secret123',
  });
  assert.equal(good.ok, true);
  assert.equal(good.value.email, 'lokesh@example.com');

  const badEmail = validateSignupCredentials({ email: 'nope', password: 'secret123' });
  assert.equal(badEmail.ok, false);
  assert.ok(badEmail.errors.email);

  const weakPassword = validateSignupCredentials({ email: 'a@b.com', password: '123' });
  assert.equal(weakPassword.ok, false);
  assert.ok(weakPassword.errors.password);

  const empty = validateSignupCredentials({});
  assert.ok(empty.errors.email);
  assert.ok(empty.errors.password);
});

test('passwordChecks mirrors what the validator enforces', () => {
  assert.deepEqual(
    passwordChecks('').map((check) => check.met),
    [false, false, false]
  );
  assert.equal(
    passwordChecks('secret123').every((check) => check.met),
    true
  );
  assert.equal(passwordChecks('      ')[2].met, false);
});

test('suggestUsername derives a valid username and suffixes retries', () => {
  assert.equal(suggestUsername('Lokesh.Yadav@example.com'), 'lokesh_yadav');
  assert.equal(validateUsername(suggestUsername('a@b.com')).ok, true);

  const retry = suggestUsername('lokesh@example.com', 1, () => 0.5);
  assert.match(retry, /^lokesh_\d{4}$/);
  assert.equal(validateUsername(retry).ok, true);

  // Short, reserved and over-long local parts still produce something valid.
  for (const email of ['a@b.com', 'admin@x.com', `${'x'.repeat(40)}@x.com`]) {
    const candidate = suggestUsername(email);
    assert.equal(validateUsername(candidate).ok, true, `${email} produced ${candidate}`);
  }
});

test('buildOAuthUrl points at Supabase authorize with only public values', () => {
  const url = buildOAuthUrl({
    baseUrl: 'https://proj.supabase.co/',
    provider: 'google',
    redirectTo: 'https://loky.example/',
    apikey: 'anon-key',
  });
  assert.equal(
    url,
    'https://proj.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Floky.example%2F&apikey=anon-key'
  );

  assert.equal(buildOAuthUrl({ baseUrl: '', provider: 'google' }), '');
  assert.equal(buildOAuthUrl({ baseUrl: 'https://x.co', provider: 'bad provider' }), '');
});

test('isProviderEnabled only trusts an explicit true', () => {
  assert.equal(isProviderEnabled({ external: { google: true } }, 'google'), true);
  assert.equal(isProviderEnabled({ external: { google: false } }, 'google'), false);
  assert.equal(isProviderEnabled({ external: {} }, 'google'), false);
  assert.equal(isProviderEnabled({}, 'google'), false);
  assert.equal(isProviderEnabled(null, 'google'), false);
});
