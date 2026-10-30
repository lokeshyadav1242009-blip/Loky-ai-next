/**
 * Live check for the email-confirmation and quick-signup repair.
 *
 * Drives the *deployed* app in a real browser and verifies the parts that can be
 * reproduced without a real inbox:
 *
 *   1. a confirmation link that lands as `#access_token=…` actually signs the
 *      user in (session stored, profile loaded, URL cleaned) — the exact case
 *      that used to leave the app signed out so people signed in again by hand;
 *   2. a reload afterwards stays signed in (no second confirmation, no loop);
 *   3. an expired / already-used link shows a terminal message instead of a
 *      silent failure, and writes no session;
 *   4. an account confirmed without a username is offered the username step
 *      instead of being sent back to the signup form;
 *   5. "Create account" reveals the display-name + username fields, and a
 *      half-filled form is rejected locally (no signup request is sent).
 *
 * Supabase is mocked at the network layer (`/api/supabase-config` plus the
 * auth/rest endpoints), so no real account, email or database row is touched.
 *
 *   LIVE_BASE=https://<deployed-host> node scripts/live-auth-confirm.mjs
 */

import puppeteer from 'puppeteer';

const base = (process.env.LIVE_BASE || 'https://yfekzkf5om.dev.ap-jt.com').replace(/\/$/, '');
const AUTH_KEY = 'loky.ai.next.auth.v1';
const INTENT_KEY = 'loky.ai.next.signup.intent.v1';
const MOCK_SUPABASE = 'https://mock-supabase.test';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const USER_EMAIL = 'lokesh@example.com';
const USERNAME = 'lokesh_dev';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function textOf(page, selector) {
  return page.$eval(selector, (node) => node.textContent.trim()).catch(() => '');
}

async function until(fn, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

/**
 * Mock Supabase for one page. `hasProfile` decides whether the confirmed user
 * already has a username; every interesting call is recorded for assertions.
 */
async function mockSupabase(page, { hasProfile = true } = {}) {
  const calls = { user: 0, profiles: 0, profileWrites: 0, signup: 0 };

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();

    if (url.includes('/api/supabase-config')) {
      request.respond({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: MOCK_SUPABASE, anonKey: 'test-anon-key' }),
      });
      return;
    }

    if (url.startsWith(MOCK_SUPABASE)) {
      if (request.method() === 'OPTIONS') {
        request.respond({ status: 204, headers: CORS, body: '' });
        return;
      }
      const json = (body) =>
        request.respond({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      if (url.includes('/auth/v1/user')) {
        calls.user += 1;
        json({ id: USER_ID, email: USER_EMAIL });
        return;
      }
      if (url.includes('/auth/v1/signup')) {
        calls.signup += 1;
        json({ id: USER_ID, email: USER_EMAIL });
        return;
      }
      if (url.includes('/rest/v1/profiles')) {
        if (request.method() === 'OPTIONS') {
          request.respond({ status: 204, headers: CORS, body: '' });
          return;
        }
        if (request.method() === 'GET') {
          calls.profiles += 1;
          json(
            hasProfile
              ? [{ id: USER_ID, username: USERNAME, display_name: null, avatar_seed: USERNAME }]
              : []
          );
          return;
        }
        calls.profileWrites += 1;
        json([{ id: USER_ID, username: USERNAME, display_name: null, avatar_seed: USERNAME }]);
        return;
      }
      json({});
      return;
    }

    request.continue();
  });

  return calls;
}

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  /* ------------------- 1. confirmation link signs the user in -------------- */

  {
    const page = await browser.newPage();
    const calls = await mockSupabase(page, { hasProfile: true });
    await page.evaluateOnNewDocument((key) => window.localStorage.removeItem(key), AUTH_KEY);

    await page.goto(
      `${base}/#access_token=confirm-token&refresh_token=refresh-token&expires_in=3600&token_type=bearer&type=signup`,
      { waitUntil: 'domcontentloaded' }
    );

    const chip = await until(async () => {
      const text = await textOf(page, '#navAccountLabel');
      return text && text !== 'Checking…' ? text : null;
    });
    check('confirmation link signs the user in', chip === `@${USERNAME}`, `chip=${chip}`);
    check('/auth/v1/user was used to establish the session', calls.user >= 1, `${calls.user} call(s)`);

    const stored = await page.evaluate((key) => window.localStorage.getItem(key), AUTH_KEY);
    check('session is stored for the next visit', Boolean(stored && stored.includes('confirm-token')));

    const banner = await textOf(page, '#authBanner');
    check('confirmation is reported in the banner', /confirmed/i.test(banner), `banner=${banner}`);

    const href = await page.evaluate(() => window.location.href);
    check('token is stripped from the address bar', !/access_token|refresh_token/.test(href), href);

    /* --------------------- 2. reload stays signed in ---------------------- */

    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadedChip = await until(async () => {
      const text = await textOf(page, '#navAccountLabel');
      return text && text !== 'Checking…' ? text : null;
    });
    check('a reload keeps the session (no second sign-in)', reloadedChip === `@${USERNAME}`, `chip=${reloadedChip}`);
    check(
      'a reload does not replay the confirmation',
      (await textOf(page, '#authBanner')) === '',
      `banner=${await textOf(page, '#authBanner')}`
    );

    await page.close();
  }

  /* -------------------------- 3. expired link ------------------------------ */

  {
    const page = await browser.newPage();
    const calls = await mockSupabase(page);
    await page.evaluateOnNewDocument((key) => window.localStorage.removeItem(key), AUTH_KEY);

    await page.goto(
      `${base}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`,
      { waitUntil: 'domcontentloaded' }
    );

    const banner = await until(async () => {
      const text = await textOf(page, '#authBanner');
      return text ? text : null;
    });
    check(
      'an expired link shows a terminal message',
      Boolean(banner) && /expired|already used/i.test(banner),
      `banner=${banner}`
    );
    check('an expired link never calls Auth again', calls.user === 0, `${calls.user} call(s)`);

    const chip = await until(async () => {
      const text = await textOf(page, '#navAccountLabel');
      return text && text !== 'Checking…' ? text : null;
    });
    check('an expired link leaves a usable signed-out app', chip === 'Sign in', `chip=${chip}`);

    const stored = await page.evaluate((key) => window.localStorage.getItem(key), AUTH_KEY);
    check('an expired link stores no session', stored === null);

    const href = await page.evaluate(() => window.location.href);
    check('the error is stripped from the address bar', !/error_code|error_description/.test(href), href);

    await page.close();
  }

  /* ------------------ 4. confirmed without a username --------------------- */

  {
    const page = await browser.newPage();
    await mockSupabase(page, { hasProfile: false });
    await page.evaluateOnNewDocument((key) => window.localStorage.removeItem(key), AUTH_KEY);

    await page.goto(`${base}/#access_token=confirm-token&refresh_token=r&type=signup`, {
      waitUntil: 'domcontentloaded',
    });

    const banner = await until(async () => {
      const text = await textOf(page, '#authBanner');
      return text ? text : null;
    });
    check(
      'confirmation without a username offers the username step',
      Boolean(banner) && /username/i.test(banner),
      `banner=${banner}`
    );

    await page.click('#navMessages');
    const signedInVisible = await until(
      async () => (await page.$('#dmSignedIn')) && page.$eval('#dmSignedIn', (n) => !n.hidden),
      { timeout: 10000 }
    );
    check('the account panel shows the signed-in state', signedInVisible === true);

    await page.close();
  }

  /* ----------------------- 5. signup field reveal ------------------------- */

  {
    const page = await browser.newPage();
    const calls = await mockSupabase(page);
    await page.evaluateOnNewDocument(
      (authKey, intentKey) => {
        window.localStorage.removeItem(authKey);
        window.localStorage.removeItem(intentKey);
      },
      AUTH_KEY,
      INTENT_KEY
    );

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#navMessages', { timeout: 15000 });
    await page.click('#navMessages');
    await page.waitForSelector('#dmSignUp', { visible: true, timeout: 10000 });

    const hiddenFirst = await page.$eval('#dmSignupFields', (n) => n.hidden).catch(() => null);
    check('signup extras stay hidden until asked for', hiddenFirst === true, `hidden=${hiddenFirst}`);

    await page.click('#dmSignUp');
    const revealed = await until(
      async () => (await page.$('#dmSignupFields')) && page.$eval('#dmSignupFields', (n) => !n.hidden),
      { timeout: 5000 }
    );
    check('"Create account" reveals the signup fields', revealed === true);

    const fields = await page.$$eval('#dmSignupFields input', (nodes) =>
      nodes.map((node) => node.id)
    );
    check(
      'the form collects display name, username, email and password',
      ['dmDisplayName', 'dmUsernameNew'].every((id) => fields.includes(id)) &&
        Boolean(await page.$('#dmEmail')) &&
        Boolean(await page.$('#dmPassword')),
      fields.join(',')
    );

    // Half-filled form: a missing username must be caught locally.
    await page.type('#dmEmail', USER_EMAIL);
    await page.type('#dmPassword', 'secret123');
    await page.click('#dmSignUp');
    await sleep(600);
    const notice = await textOf(page, '#dmNotice');
    check('a missing username is rejected before any request', /username/i.test(notice), `notice=${notice}`);
    check('no signup request was sent', calls.signup === 0, `${calls.signup} request(s)`);

    const intent = await page.evaluate((key) => window.localStorage.getItem(key), INTENT_KEY);
    check('a rejected signup stores no intent', intent === null);

    await page.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} live auth checks passed against ${base}`
);
if (failed.length) console.log(`failed: ${failed.map((f) => f.name).join('; ')}`);
process.exit(failed.length ? 1 : 0);
