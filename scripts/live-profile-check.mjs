/**
 * Live check for the always-visible auth state + profile UI.
 *
 * Boots the real server, then drives a real browser to verify:
 *   1. the nav account chip is visible at page load (no need to open Messages),
 *   2. a logged-out visitor sees "Sign in", never a fabricated username,
 *   3. the profile dialog has explicit signed-out / loading branches,
 *   4. no auth token request is fired while logged out (no 429 retry loop),
 *   5. the state survives a reload and the chip never sticks on "Checking…",
 *   6. mobile layout keeps the chip and dialog inside the viewport,
 *   7. the AI chat and Messages section still work (no regression).
 *
 * Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/live-profile-check.mjs
 *   (optional: PORT=4180)
 */

import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const port = Number(process.env.PORT || 4180);
const base = `http://127.0.0.1:${port}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required to boot the server.');
  process.exit(2);
}

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/supabase-config`, { cache: 'no-store' });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let browser;
try {
  const up = await waitForServer();
  check('local server answers /api/supabase-config', up, up ? '' : serverLog.slice(0, 300));
  if (!up) throw new Error('server did not start');

  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const pageErrors = [];
  const consoleErrors = [];
  const authTokenRequests = [];
  const failed5xx = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 500) failed5xx.push(`${response.status()} ${response.url()}`);
  });
  page.on('request', (request) => {
    const url = request.url();
    if (/\/auth\/v1\/token/.test(url) && request.method() === 'POST') authTokenRequests.push(url);
  });

  const response = await page.goto(base, { waitUntil: 'networkidle2', timeout: 45000 });
  check('page responds 2xx', Boolean(response && response.status() < 400), `http=${response && response.status()}`);

  // 1. The chip is the answer to "am I signed in?" and must exist at boot.
  const chip = await page.evaluate(() => {
    const node = document.getElementById('navAccount');
    if (!node) return { present: false };
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      present: true,
      visible: !node.hidden && style.display !== 'none' && rect.width > 0 && rect.height > 0,
      state: node.dataset.state || '',
      label: (document.getElementById('navAccountLabel')?.textContent || '').trim(),
      inNav: Boolean(node.closest('.appnav')),
      insideViewport: rect.left >= 0 && rect.right <= window.innerWidth + 1,
      aria: node.getAttribute('aria-label') || '',
    };
  });
  check('nav account chip exists on page load', chip.present);
  check('nav account chip is visible inside the nav', Boolean(chip.visible && chip.inNav));
  check('chip renders inside the viewport', Boolean(chip.insideViewport));
  check('logged-out chip reads "Sign in"', chip.label === 'Sign in', `label="${chip.label}"`);
  check('logged-out chip state is not loading', chip.state === 'out', `state=${chip.state}`);
  check('chip labels the signed-out state for screen readers', /signed out/i.test(chip.aria), chip.aria);

  // 2. Profile dialog: explicit signed-out branch, no invented identity.
  await page.click('#navAccount');
  const dialog = await page.evaluate(() => {
    const node = document.getElementById('profileDialog');
    const meta = document.getElementById('profileMeta');
    const handle = document.getElementById('profileHandle');
    const actions = document.getElementById('profileActions');
    const state = document.getElementById('profileState');
    return {
      open: Boolean(node) && !node.hidden,
      handle: (handle?.textContent || '').trim(),
      metaHidden: Boolean(meta?.hidden),
      metaText: (meta?.textContent || '').replace(/\s+/g, ' ').trim(),
      actionLabels: actions ? [...actions.querySelectorAll('button')].map((b) => b.textContent.trim()) : [],
      stateText: state && !state.hidden ? state.textContent.trim() : '',
      rect: node ? node.getBoundingClientRect().toJSON() : null,
    };
  });
  check('profile dialog opens from the nav chip', dialog.open);
  check('signed-out profile says "Signed out"', /signed out/i.test(dialog.handle), `handle="${dialog.handle}"`);
  check('signed-out profile shows no username/email rows', dialog.metaHidden, dialog.metaText.slice(0, 80));
  check('signed-out profile offers Sign in', dialog.actionLabels.some((label) => /sign in/i.test(label)), dialog.actionLabels.join(', '));

  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => document.getElementById('profileDialog').hidden);
  check('Escape closes the profile dialog', closed);

  // 3. Logged out must not fire password grants (that is what trips the 429).
  check('no auth token POST while logged out', authTokenRequests.length === 0, authTokenRequests.slice(0, 2).join(' | '));

  // 4. Signed-in states. A stored session is seeded and the profiles request is
  // answered by the page's own request interception: this exercises the real UI
  // code paths (loading / username / missing username / error) without opening a
  // real account, sending email or firing an auth grant against the project.
  const SESSION_KEY = 'loky.ai.next.auth.v1';
  const userId = '11111111-2222-3333-4444-555555555555';
  const userEmail = 'loky.tester@example.test';

  async function openSessionPage({ profiles, delayMs = 0 }) {
    // Isolated context: a seeded session must not leak into the logged-out page
    // (localStorage is shared per origin inside one browser context).
    const context = await browser.createBrowserContext();
    const sessionPage = await context.newPage();
    await sessionPage.setViewport({ width: 1280, height: 900 });
    await sessionPage.evaluateOnNewDocument(
      (key, session) => {
        window.localStorage.setItem(key, JSON.stringify(session));
      },
      SESSION_KEY,
      {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 3600 * 1000,
        user: { id: userId, email: userEmail },
      },
    );

    const seen = { profiles: 0, preflights: 0, tokenPosts: 0 };
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-expose-headers': '*',
    };

    await sessionPage.setRequestInterception(true);
    sessionPage.on('request', async (request) => {
      const url = request.url();
      if (/\/auth\/v1\/token/.test(url) && request.method() === 'POST') seen.tokenPosts += 1;
      if (url.includes('/rest/v1/profiles')) {
        // The Supabase REST call carries an Authorization header, so the browser
        // sends a preflight first; answer it or the fetch fails as a CORS error.
        if (request.method() === 'OPTIONS') {
          seen.preflights += 1;
          request.respond({ status: 204, headers: corsHeaders }).catch(() => {});
          return;
        }
        seen.profiles += 1;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        request
          .respond({
            status: profiles.status,
            contentType: 'application/json',
            headers: corsHeaders,
            body: JSON.stringify(profiles.body),
          })
          .catch(() => {});
        return;
      }
      request.continue().catch(() => {});
    });
    return { sessionPage, seen, context };
  }

  // 4a. Loading → signed in with a real username from the profiles table.
  const loadingRun = await openSessionPage({
    profiles: { status: 200, body: [{ id: userId, username: 'loky_user1', display_name: null, avatar_seed: null }] },
    delayMs: 1000,
  });
  await loadingRun.sessionPage.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const loadingChip = await loadingRun.sessionPage
    .waitForFunction(
      () => {
        const node = document.getElementById('navAccount');
        return node && node.dataset.state === 'loading' ? node.textContent.trim() : false;
      },
      { timeout: 4000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => '');
  check('chip shows a visible loading state while the session is checked', /checking/i.test(loadingChip), `text="${loadingChip}"`);

  const loadingDialog = await loadingRun.sessionPage.evaluate(() => {
    document.getElementById('navAccount')?.click();
    const state = document.getElementById('profileState');
    return {
      open: !document.getElementById('profileDialog').hidden,
      text: state && !state.hidden ? state.textContent.trim() : '',
    };
  });
  check('profile dialog explains it is loading', /loading your profile/i.test(loadingDialog.text), `text="${loadingDialog.text}"`);

  const settled = await loadingRun.sessionPage
    .waitForFunction(
      () => document.getElementById('navAccount')?.dataset.state !== 'loading',
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check('chip leaves the loading state once the session is resolved', settled);

  const signedIn = await loadingRun.sessionPage.evaluate(() => {
    const chip = document.getElementById('navAccount');
    const meta = document.getElementById('profileMeta');
    const state = document.getElementById('profileState');
    return {
      chipState: chip?.dataset.state,
      chipLabel: document.getElementById('navAccountLabel')?.textContent.trim() || '',
      avatar: document.getElementById('navAvatar')?.textContent.trim() || '',
      dialogOpen: !document.getElementById('profileDialog').hidden,
      handle: document.getElementById('profileHandle')?.textContent.trim() || '',
      metaHidden: Boolean(meta?.hidden),
      metaText: (meta?.textContent || '').replace(/\s+/g, ' ').trim(),
      stateHidden: Boolean(state?.hidden),
      stateText: state && !state.hidden ? state.textContent.trim() : '',
      actions: [...(document.getElementById('profileActions')?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()),
    };
  });
  check('signed-in chip shows the database username', /loky_user1/i.test(signedIn.chipLabel), `label="${signedIn.chipLabel}"`);
  check('signed-in chip state is "in"', signedIn.chipState === 'in', `state=${signedIn.chipState}`);
  check('avatar falls back to initials of the username', signedIn.avatar.length > 0 && signedIn.avatar !== '?', `avatar="${signedIn.avatar}"`);
  check('profile dialog shows the same username', /@loky_user1/.test(signedIn.handle), `handle="${signedIn.handle}"`);
  check('profile dialog lists username and email', !signedIn.metaHidden && /loky_user1/.test(signedIn.metaText) && signedIn.metaText.includes(userEmail), signedIn.metaText);
  check('signed-in profile has no loading/error notice', signedIn.stateHidden, signedIn.stateText);
  check('signed-in profile offers Sign out', signedIn.actions.some((label) => /sign out/i.test(label)), signedIn.actions.join(', '));
  check('signed-in session fired no auth token request', loadingRun.seen.tokenPosts === 0, `posts=${loadingRun.seen.tokenPosts}`);
  await loadingRun.sessionPage.close();

  // 4b. Signed in but no username row yet: offer setup, never invent a handle.
  const noNameRun = await openSessionPage({ profiles: { status: 200, body: [] } });
  await noNameRun.sessionPage.goto(base, { waitUntil: 'networkidle2', timeout: 45000 });
  await noNameRun.sessionPage
    .waitForFunction(() => document.getElementById('navAccount')?.dataset.state !== 'loading', { timeout: 15000 })
    .catch(() => {});
  const noName = await noNameRun.sessionPage.evaluate(() => {
    document.getElementById('navAccount')?.click();
    const state = document.getElementById('profileState');
    return {
      chipState: document.getElementById('navAccount')?.dataset.state,
      chipLabel: document.getElementById('navAccountLabel')?.textContent.trim() || '',
      handle: document.getElementById('profileHandle')?.textContent.trim() || '',
      metaHidden: Boolean(document.getElementById('profileMeta')?.hidden),
      stateText: state && !state.hidden ? state.textContent.trim() : '',
      actions: [...(document.getElementById('profileActions')?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()),
    };
  });
  check('missing username falls back to the email in the chip', noName.chipLabel.includes(userEmail), `label="${noName.chipLabel}"`);
  check('missing username marks the chip as needing setup', noName.chipState === 'setup', `state=${noName.chipState}`);
  check('missing username is never fabricated', /no username/i.test(noName.handle), `handle="${noName.handle}"`);
  check('missing username hides the username/email rows', noName.metaHidden);
  check('missing username offers a setup path', noName.actions.some((label) => /choose a username/i.test(label)), noName.actions.join(', '));
  check('missing username explains the setup step', /choose a username/i.test(noName.stateText), noName.stateText);
  await noNameRun.sessionPage.close();

  // 4c. Profile request fails: useful error, manual retry only, no retry storm.
  const errorRun = await openSessionPage({ profiles: { status: 500, body: { message: 'boom' } } });
  await errorRun.sessionPage.goto(base, { waitUntil: 'networkidle2', timeout: 45000 });
  await errorRun.sessionPage
    .waitForFunction(() => document.getElementById('navAccount')?.dataset.state !== 'loading', { timeout: 15000 })
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 800));
  const errored = await errorRun.sessionPage.evaluate(() => {
    document.getElementById('navAccount')?.click();
    const state = document.getElementById('profileState');
    return {
      stateKind: state?.dataset.kind || '',
      stateText: state && !state.hidden ? state.textContent.trim() : '',
      handle: document.getElementById('profileHandle')?.textContent.trim() || '',
      actions: [...(document.getElementById('profileActions')?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()),
    };
  });
  check('profile error is shown to the user', errored.stateKind === 'error' && errored.stateText.length > 0, `${errored.stateKind}: ${errored.stateText}`);
  check('profile error does not claim a username', !/loky_user1/.test(errored.handle), `handle="${errored.handle}"`);
  check('profile error offers a manual retry', errored.actions.some((label) => /try again/i.test(label)), errored.actions.join(', '));
  check('failed profile load is not retried automatically', errorRun.seen.profiles <= 1, `requests=${errorRun.seen.profiles}`);
  await errorRun.sessionPage.close();

  // 5. Reload restores the signed-out state instead of resetting to blank.
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  const afterReload = await page
    .waitForFunction(
      () => {
        const node = document.getElementById('navAccount');
        return node && node.dataset.state !== 'loading'
          ? { state: node.dataset.state, label: document.getElementById('navAccountLabel')?.textContent.trim() || '' }
          : false;
      },
      { timeout: 15000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check('auth state is restored after a reload', Boolean(afterReload && afterReload.state === 'out'), JSON.stringify(afterReload));
  check('reload keeps the "Sign in" affordance', Boolean(afterReload && afterReload.label === 'Sign in'), String(afterReload?.label));

  // 6. Existing surfaces: the AI chat and the Messages section still work.
  const aiChat = await page.evaluate(() => {
    const composer = document.getElementById('composer');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    return { composer: Boolean(composer), input: Boolean(input), send: Boolean(send) };
  });
  check('AI chat composer intact', aiChat.composer && aiChat.input && aiChat.send);

  await page.evaluate(() => document.getElementById('navMessages')?.click());
  const messengerVisible = await page
    .waitForFunction(() => {
      const node = document.getElementById('messenger');
      return node && !node.hidden;
    }, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('Messages section still opens', messengerVisible);

  const chipAfterNav = await page.evaluate(() => {
    const node = document.getElementById('navAccount');
    return { state: node?.dataset.state, accountVisible: Boolean(document.querySelector('.dm-account')) };
  });
  check('chip stays mounted while switching sections', chipAfterNav.state === 'out', `state=${chipAfterNav.state}`);
  check('Messages account panel still renders', chipAfterNav.accountVisible);
  await page.evaluate(() => document.getElementById('navAssistant')?.click());

  // 7. Mobile: chip and dialog must fit, and the username must not be clipped away.
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForFunction(() => document.getElementById('navAccount')?.dataset.state !== 'loading', { timeout: 15000 }).catch(() => {});

  const mobile = await page.evaluate(() => {
    const node = document.getElementById('navAccount');
    const rect = node.getBoundingClientRect();
    return {
      labelVisible: rect.width > 0 && rect.height > 0,
      insideViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      overlapSwitch: (() => {
        const swap = document.querySelector('.appnav__switch');
        if (!swap) return false;
        const swapRect = swap.getBoundingClientRect();
        return rect.left < swapRect.right - 1 && rect.right > swapRect.left + 1;
      })(),
    };
  });
  check('mobile: chip is rendered and inside the viewport', mobile.labelVisible && mobile.insideViewport, JSON.stringify(mobile));
  check('mobile: chip does not overlap the section switch', !mobile.overlapSwitch);
  check('mobile: no horizontal overflow introduced', mobile.overflow <= 1, `overflow=${mobile.overflow}px`);

  await page.tap('#navAccount');
  const mobileDialog = await page.evaluate(() => {
    const node = document.getElementById('profileDialog');
    const card = node?.querySelector('.about__card');
    const rect = card?.getBoundingClientRect();
    return {
      open: Boolean(node) && !node.hidden,
      fits: Boolean(rect) && rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.top >= -1 && rect.height <= window.innerHeight + 1,
    };
  });
  check('mobile: profile dialog opens', mobileDialog.open);
  check('mobile: profile dialog fits the viewport', mobileDialog.fits);
  await page.keyboard.press('Escape');

  await page.screenshot({ path: 'artifacts/live-profile-mobile.png' }).catch(() => {});
  await page.setViewport({ width: 1280, height: 900 });
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await page.screenshot({ path: 'artifacts/live-profile-desktop.png' }).catch(() => {});

  // 8. No runtime breakage. The local server intentionally boots without an AI
  // key, so /api/health answers 503; assert that is the ONLY 5xx source rather
  // than blanket-ignoring console noise.
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  const nonHealth5xx = failed5xx.filter((entry) => !/\/api\/health/.test(entry));
  check('no 5xx from the app APIs (local /api/health probe excepted)', nonHealth5xx.length === 0, nonHealth5xx.slice(0, 3).join(' | '));
  const onlyHealthIsFailing = nonHealth5xx.length === 0;
  const relevantConsole = consoleErrors.filter((text) => {
    if (/favicon|404 \(Not Found\)/i.test(text)) return false;
    // The unconfigured local AI key makes /api/health return 503; nothing else does.
    if (onlyHealthIsFailing && /status of 503 \(Service Unavailable\)/i.test(text)) return false;
    return true;
  });
  check('no console errors beyond the local /api/health 503', relevantConsole.length === 0, relevantConsole.join(' | ').slice(0, 300));
  check('still no auth token POST after all reloads', authTokenRequests.length === 0, authTokenRequests.slice(0, 2).join(' | '));
} catch (error) {
  check('check run completed', false, String(error).slice(0, 300));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
if (failed.length) {
  console.error('failed:', failed.map((entry) => entry.name).join(', '));
  process.exit(1);
}
