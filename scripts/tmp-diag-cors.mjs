import puppeteer from 'puppeteer';
const base = process.env.LIVE_BASE || 'https://yfekzkf5om.dev.ap-jt.com';
const AUTH_KEY = 'loky.ai.next.auth.v1';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-allow-headers': '*',
};
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.on('requestfailed', (r) => console.log('requestfailed:', r.method(), r.url().slice(0, 90), r.failure()?.errorText));
await page.setRequestInterception(true);
page.on('request', (request) => {
  const url = request.url();
  if (url.includes('/rest/v1/profiles')) {
    console.log('profile hit:', request.method(), url.slice(0, 120));
    if (request.method() === 'OPTIONS') {
      request.respond({ status: 204, headers: CORS, body: '' });
      return;
    }
    request.respond({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify([{ id: USER_ID, username: 'lokesh_dev', display_name: null, avatar_seed: 'lokesh_dev' }]),
    });
    return;
  }
  request.continue();
});
await page.evaluateOnNewDocument(
  (key, s) => window.localStorage.setItem(key, JSON.stringify(s)),
  AUTH_KEY,
  { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600000, user: { id: USER_ID, email: 'lokesh@example.com' } },
);
await page.goto(base, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));
console.log('chip:', await page.$eval('#navAccountLabel', (n) => n.textContent.trim()).catch(() => 'n/a'));
await page.click('#navAccount').catch(() => {});
await new Promise((r) => setTimeout(r, 500));
console.log('handle:', await page.$eval('#profileHandle', (n) => n.textContent.trim()).catch(() => 'n/a'));
console.log('state:', JSON.stringify(await page.$eval('#profileState', (n) => n.textContent.trim()).catch(() => 'n/a')));
await browser.close();
