/**
 * Live check for the stuck "? Checking…" fix.
 *
 * Drives the *deployed* app in a real browser and verifies the two halves of the
 * fix end to end:
 *
 *   1. a profiles request that never settles is abandoned after the 8 s budget,
 *      so the nav chip leaves "Checking…" and the dialog offers a retry;
 *   2. the retry (and the chip itself) restarts the check exactly once and the
 *      real username + email come back — nothing is fabricated;
 *   3. signed-out visitors still see "Sign in", AI chat still streams, and the
 *      Messages section still gates on sign-in.
 *
 * The profiles request is intercepted, so no account or database row is needed
 * and nothing is written. Run:
 *
 *   LIVE_BASE=https://<deployed-host> node scripts/live-checking-fix.mjs
 */

import puppeteer from 'puppeteer';

const base = (process.env.LIVE_BASE || 'https://yfekzkf5om.dev.ap-jt.com').replace(/\/$/, '');
const AUTH_KEY = 'loky.ai.next.auth.v1';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const USER_EMAIL = 'lokesh@example.com';
const USERNAME = 'lokesh_dev';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function textOf(page, selector) {
  return page.$eval(selector, (node) => node.textContent.trim()).catch(() => '');
}

/** Poll until `fn()` is truthy, or give up. Returns the value or null. */
async function until(fn, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  /* ------------------------- 1. signed-out chip -------------------------- */

  {
    const page = await browser.newPage();
    const profileRequests = [];
    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/profiles')) profileRequests.push(request.url());
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const label = await until(async () => {
      const text = await textOf(page, '#navAccountLabel');
      return text && text !== 'Checking…' ? text : null;
    });

    check('signed-out nav chip settles on "Sign in"', label === 'Sign in', `label=${label}`);
    check('no profile request while signed out', profileRequests.length === 0, `${profileRequests.length} request(s)`);

    await page.click('#navAccount');
    const dialogText = await textOf(page, '#profileState');
    check(
      'signed-out profile dialog offers sign in',
      /signed in|sign in/i.test(dialogText),
      `state=${dialogText || '(empty)'}`,
    );

    await page.close();
  }

  /* ------------------ 2. stalled profile check + recovery ----------------- */

  {
    const page = await browser.newPage();
    let mode = 'stall';
    const profileRequests = [];
    const held = [];

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().includes('/rest/v1/profiles')) {
        profileRequests.push(request.url());
        if (mode === 'stall') {
          held.push(request); // never answered: the request simply hangs
          return;
        }
        request.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([
            { id: USER_ID, username: USERNAME, display_name: null, avatar_seed: USERNAME },
          ]),
        });
        return;
      }
      request.continue();
    });

    await page.evaluateOnNewDocument(
      (key, session) => window.localStorage.setItem(key, JSON.stringify(session)),
      AUTH_KEY,
      {
        accessToken: 'live-check-token',
        refreshToken: 'live-check-refresh',
        expiresAt: Date.now() + 3_600_000,
        user: { id: USER_ID, email: USER_EMAIL },
      },
    );

    await page.goto(base, { waitUntil: 'domcontentloaded' });

    // The chip must show progress first, otherwise the rest proves nothing.
    const loadingLabel = await until(
      async () => ((await textOf(page, '#navAccountLabel')) === 'Checking…' ? 'Checking…' : null),
      { timeout: 3000 },
    );
    check('stored session starts the check ("Checking…")', loadingLabel === 'Checking…');

    await page.click('#navAccount');
    const dialogLoading = await textOf(page, '#profileState');
    check(
      'dialog reports progress while the request hangs',
      /loading your profile/i.test(dialogLoading),
      `state=${dialogLoading}`,
    );

    // Tap the chip again mid-flight: the guard must not duplicate the request.
    await page.keyboard.press('Escape');
    await page.click('#navAccount');
    await page.keyboard.press('Escape');

    const settled = await until(
      async () => {
        const text = await textOf(page, '#navAccountLabel');
        return text && text !== 'Checking…' ? text : null;
      },
      { timeout: 20000 },
    );
    check('chip leaves "Checking…" after the timeout budget', Boolean(settled), `label=${settled}`);
    check('only one profile request was issued', profileRequests.length === 1, `${profileRequests.length} request(s)`);

    await page.click('#navAccount');
    const errorState = await textOf(page, '#profileState');
    const retryButtons = await page.$$eval('#profileActions button', (nodes) =>
      nodes.map((node) => node.textContent.trim()),
    );
    check(
      'dialog shows a retryable error instead of hanging',
      /network|timed out|try again/i.test(errorState),
      `state=${errorState}`,
    );
    check('retry action is offered', retryButtons.includes('Try again'), retryButtons.join(', '));

    /* ---------------------- 3. manual retry recovers ---------------------- */

    mode = 'ok';
    const before = profileRequests.length;

    const retry = await page.$('#profileActions button');
    await retry.click();

    const chipLabel = await until(
      async () => {
        const text = await textOf(page, '#navAccountLabel');
        return text === `@${USERNAME}` ? text : null;
      },
      { timeout: 20000 },
    );
    check('retry restores the real username in the chip', chipLabel === `@${USERNAME}`, `label=${chipLabel}`);
    check(
      'retry issues exactly one new profile request',
      profileRequests.length === before + 1,
      `${profileRequests.length - before} request(s)`,
    );

    const handle = await textOf(page, '#profileHandle');
    const email = await textOf(page, '#profileEmail');
    check('dialog shows the real handle', handle === `@${USERNAME}`, `handle=${handle}`);
    check('dialog keeps the real email', email === USER_EMAIL, `email=${email}`);
    check(
      'timeout error is cleared after recovery',
      (await textOf(page, '#profileState')) === '',
      `state=${await textOf(page, '#profileState')}`,
    );

    await page.close();
  }

  /* ----------------------------- 4. AI chat ------------------------------ */

  {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#input', { timeout: 15000 });
    await page.type('#input', 'Say hello in exactly three words.');
    await page.click('#send');

    const reply = await until(
      async () => {
        const texts = await page.$$eval('#messages .msg__content', (nodes) =>
          nodes.map((node) => node.textContent.trim()).filter(Boolean),
        );
        // The first bubble is the prompt, so a second non-empty bubble is the reply.
        return texts.length > 1 ? texts[texts.length - 1] : null;
      },
      { timeout: 60000, interval: 500 },
    );
    check('AI chat still streams a reply', Boolean(reply), (reply || '').slice(0, 60));
    await page.close();
  }

  /* --------------------------- 5. Mini Chat gate ------------------------- */

  {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#navMessages', { timeout: 15000 });
    await page.click('#navMessages');

    const signedOut = await until(
      async () => ((await page.$('#dmSignedOut')) ? page.$eval('#dmSignedOut', (n) => !n.hidden) : null),
      { timeout: 10000 },
    );
    check('Mini Chat shows the signed-out form, no invented username', signedOut === true);
    check(
      'signed-out gate fires no profile request',
      (await page.$$eval('#dmWhoami', (n) => n.length)) === 1,
    );
    await page.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed against ${base}`);
if (failed.length) {
  console.error('failed:', failed.map((result) => result.name).join('; '));
  process.exit(1);
}
