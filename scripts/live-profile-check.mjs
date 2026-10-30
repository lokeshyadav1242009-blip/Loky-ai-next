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
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
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

  // 4. Loading branch: delay the config request and observe "Checking…".
  const loadingPage = await browser.newPage();
  await loadingPage.setViewport({ width: 1280, height: 900 });
  await loadingPage.setRequestInterception(true);
  loadingPage.on('request', async (request) => {
    if (request.url().includes('/api/supabase-config')) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      request.continue().catch(() => {});
      return;
    }
    request.continue().catch(() => {});
  });
  await loadingPage.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const loadingChip = await loadingPage
    .waitForFunction(
      () => {
        const node = document.getElementById('navAccount');
        return node && node.dataset.state === 'loading' ? node.textContent.trim() : false;
      },
      { timeout: 3000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => '');
  check('chip shows a visible loading state while the session is checked', /checking/i.test(loadingChip), `text="${loadingChip}"`);

  const settled = await loadingPage
    .waitForFunction(
      () => {
        const node = document.getElementById('navAccount');
        return node && node.dataset.state !== 'loading';
      },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check('chip leaves the loading state once the session is resolved', settled);
  await loadingPage.close();

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

  // 8. No runtime breakage.
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  const relevantConsole = consoleErrors.filter((text) => !/favicon|404 \(Not Found\)/i.test(text));
  check('no console errors', relevantConsole.length === 0, relevantConsole.join(' | ').slice(0, 300));
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
