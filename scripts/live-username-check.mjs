/**
 * Live check for the username system on the deployed site.
 *
 * Verifies in a real browser that:
 *   1. the page loads without uncaught errors,
 *   2. the account panel is present, styled and offers sign-up/sign-in,
 *   3. the user-search surface stays hidden while signed out,
 *   4. the username helpers behave (validation + normalisation),
 *   5. the pre-existing Messages UI still works (list renders, New opens).
 *
 * Usage: node scripts/live-username-check.mjs [url]
 *   (defaults to the deployed URL, override with BASE_URL or argv[2])
 */

import puppeteer from 'puppeteer';

const base = process.argv[2] || process.env.BASE_URL || 'https://yfekzkf5om.dev.ap-jt.com';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const response = await page.goto(base, { waitUntil: 'networkidle2', timeout: 45000 });
  check('page responds 2xx', Boolean(response && response.status() < 400), `http=${response && response.status()}`);

  // Open the Messages section the same way a user does.
  await page.evaluate(() => {
    const nav = document.querySelector('[data-view-target="messages"], #navMessages, #msgNav');
    if (nav) nav.click();
  });
  await page.waitForFunction(
    () => {
      const messenger = document.getElementById('messenger');
      return messenger && !messenger.hidden;
    },
    { timeout: 10000 },
  ).catch(() => {});

  const messengerVisible = await page.evaluate(() => {
    const messenger = document.getElementById('messenger');
    return Boolean(messenger) && !messenger.hidden;
  });
  check('Messages section opens', messengerVisible);

  // 1. account panel
  const account = await page.evaluate(() => {
    const panel = document.getElementById('dmAccount');
    if (!panel) return null;
    const style = getComputedStyle(panel);
    return {
      present: true,
      visible: panel.offsetParent !== null,
      paddingLeft: style.paddingLeft,
      display: style.display,
      hasEmail: Boolean(document.getElementById('dmEmail')),
      hasPassword: Boolean(document.getElementById('dmPassword')),
      hasSignIn: Boolean(document.getElementById('dmSignIn')),
      hasSignUp: Boolean(document.getElementById('dmSignUp')),
      signedOutVisible: (() => {
        const node = document.getElementById('dmSignedOut');
        return Boolean(node) && !node.hidden;
      })(),
      findHidden: (() => {
        const node = document.getElementById('dmFind');
        return Boolean(node) && node.hidden;
      })(),
      passwordType: document.getElementById('dmPassword')?.getAttribute('type') || '',
    };
  });

  check('account panel exists', Boolean(account && account.present));
  check('account panel is visible in Messages', Boolean(account && account.visible));
  check(
    'account panel is styled by the shipped CSS',
    Boolean(account && account.paddingLeft && account.paddingLeft !== '0px'),
    account ? `padding-left=${account.paddingLeft}` : 'no panel',
  );
  check(
    'sign up / sign in controls are present',
    Boolean(account && account.hasEmail && account.hasPassword && account.hasSignIn && account.hasSignUp),
  );
  check('password input is masked', Boolean(account && account.passwordType === 'password'), account?.passwordType);
  check('signed-out block shown by default', Boolean(account && account.signedOutVisible));
  check('user search hidden while signed out', Boolean(account && account.findHidden));

  // 2. username helpers actually run in the browser
  const helpers = await page.evaluate(async () => {
    const mod = await import('/username-utils.js');
    return {
      short: mod.validateUsername('ab').ok,
      badChar: mod.validateUsername('bad name!').ok,
      good: mod.validateUsername('Loky_User1').ok,
      goodNormalized: mod.normalizeUsername('Loky_User1'),
      reserved: mod.validateUsername('admin').ok,
      same: mod.isSameUsername('Loky', ' loky '),
      key: mod.directConversationKey('aaa', 'bbb'),
      keyStable: mod.directConversationKey('bbb', 'aaa'),
    };
  });

  check('username "ab" rejected as too short', helpers.short === false);
  check('username with spaces/punctuation rejected', helpers.badChar === false);
  check('username "Loky_User1" accepted', helpers.good === true);
  check('username normalised to lowercase', helpers.goodNormalized === 'loky_user1', helpers.goodNormalized);
  check('reserved username rejected', helpers.reserved === false);
  check('case-insensitive comparison works', helpers.same === true);
  check(
    'conversation key is order independent',
    helpers.key === helpers.keyStable,
    `${helpers.key} vs ${helpers.keyStable}`,
  );

  // 3. existing Messages features still work
  const existing = await page.evaluate(() => {
    const list = document.getElementById('msgList');
    return {
      listPresent: Boolean(list),
      rows: list ? list.children.length : -1,
      hasNewButton: Boolean(document.getElementById('msgNew')),
      hasComposer: Boolean(document.getElementById('msgForm') || document.querySelector('.msg-composer')),
      hasSearch: Boolean(document.getElementById('msgSearch')),
      localKeyPresent: Boolean(window.localStorage.getItem('loky.ai.next.messages.v1')),
    };
  });
  check('conversation list still renders', existing.listPresent && existing.rows > 0, `rows=${existing.rows}`);
  check('new-conversation and search controls intact', existing.hasNewButton && existing.hasSearch);
  check('composer intact', existing.hasComposer);

  if (existing.hasNewButton) {
    await page.click('#msgNew');
    const newRowOpen = await page.evaluate(() => {
      const row = document.getElementById('msgNewRow');
      return Boolean(row) && !row.hidden;
    });
    check('New conversation row still opens', newRowOpen);
    await page.keyboard.press('Escape');
  }

  // 4. no runtime breakage
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  const relevantConsole = consoleErrors.filter((text) => !/favicon|404 \(Not Found\)/i.test(text));
  check('no console errors', relevantConsole.length === 0, relevantConsole.join(' | ').slice(0, 300));

  await page.screenshot({ path: 'artifacts/live-username-account.png' }).catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
if (failed.length) {
  console.error('failed:', failed.map((entry) => entry.name).join(', '));
  process.exit(1);
}
