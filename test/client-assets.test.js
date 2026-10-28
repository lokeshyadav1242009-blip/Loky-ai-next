import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = (name) => fs.readFileSync(path.join(root, 'public', name), 'utf8');

const html = pub('index.html');
const css = pub('styles.css');
const js = pub('app.js');
const messagesJs = pub('messages.js');
const messagesUtils = pub('messages-utils.js');

/* ------------------------------ chat history ----------------------------- */

test('history list container exists in the shell', () => {
  assert.match(html, /id="historyList"/);
  assert.match(html, /id="historyEmpty"/);
  assert.match(html, /id="newChat"/);
});

test('history rows render a title and a timestamp', () => {
  assert.match(js, /history__title/);
  assert.match(js, /history__time/);
  assert.match(css, /\.history__title/);
  assert.match(css, /\.history__time/);
});

test('conversations are persisted in localStorage under the stable key', () => {
  assert.match(js, /localStorage/);
  assert.match(js, /STORAGE_KEY/);
});

test('rename, delete and reopen handlers exist', () => {
  assert.match(js, /renamingId/);
  assert.match(js, /function renderHistory/);
  assert.match(js, /function startNewChat/);
  // Delete + rename buttons are created per history row.
  assert.match(js, /history__rename|rename/);
  assert.match(js, /delete/);
});

/* ---------------------------- owner branding ----------------------------- */

test('LOKY AI is displayed prominently', () => {
  assert.match(html, /LOKY/);
  assert.match(css, /\.hero__wordmark/);
  assert.match(js, /hero__wordmark/);
});

test('"Created by Lokesh Yadav" appears on the welcome screen and in About', () => {
  assert.match(html, /Created by Lokesh Yadav/);
  assert.match(html, /id="aboutDialog"/);
  assert.match(html, /Lokesh Yadav/);
  assert.match(js, /hero__credit/);
});

test('the About dialog is wired to open and close', () => {
  assert.match(js, /aboutBtn\.addEventListener/);
  assert.match(js, /aboutClose\.addEventListener/);
  assert.match(js, /function openAbout/);
  assert.match(js, /function closeAbout/);
});

test('the dark theme is preserved', () => {
  assert.match(html, /data-theme="dark"/);
  assert.match(css, /--bg:\s*#08090f/);
});

/* ---------------------------- opening animation -------------------------- */

test('an intro overlay with logo and credit is present in the shell', () => {
  assert.match(html, /id="intro"/);
  assert.match(html, /intro__mark/);
  assert.match(html, /intro__glow/);
  assert.match(html, /Created by Lokesh Yadav/);
});

test('the intro animation is defined in CSS with a ~2 second duration', () => {
  assert.match(css, /@keyframes introFade/);
  assert.match(css, /@keyframes introGlow/);
  assert.match(css, /@keyframes introMark/);
  assert.match(css, /2s/);
});

test('the intro plays once on boot only', () => {
  assert.match(js, /function playIntro/);
  // playIntro is invoked exactly once, from the boot section.
  const calls = js.match(/playIntro\(\)/g) ?? [];
  assert.equal(calls.length, 2, 'expected a definition and a single call site');
  assert.match(js, /playIntro\(\);\s*$/m);
});

test('reduced motion is respected', () => {
  assert.match(js, /prefers-reduced-motion/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

/* ---------------------- removed banner above the input -------------------- */

test('no banner box sits above the composer anymore', () => {
  assert.ok(!/id="banner"/.test(html), 'banner element still present in index.html');
  assert.ok(!/class="banner/.test(html), 'banner class still present in index.html');
  assert.ok(!/\.banner\s*\{/.test(css), 'banner CSS still present in styles.css');
  assert.ok(!/el\.banner\b/.test(js), 'banner DOM reference still present in app.js');
});

test('the composer keeps its textarea, send button and layout', () => {
  assert.match(html, /id="input"/);
  assert.match(html, /id="send"/);
  assert.match(html, /class="composer"/);
  assert.match(html, /id="composer"/);
  assert.match(css, /\.composer-wrap/);
  assert.match(css, /\.composer\b/);
});

test('errors are surfaced inline in the chat instead of a box above the input', () => {
  assert.match(js, /function showNotice/);
  assert.match(js, /function renderNotice/);
});

/* -------------------------------- security -------------------------------- */

test('no API key or secret literal is embedded in the frontend', () => {
  const frontend = `${html}\n${css}\n${js}\n${pub('chat-utils.js')}`;
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(frontend), 'looks like a hardcoded API key');
  assert.ok(!/AI_API_KEY\s*[:=]\s*['"][^'"]+['"]/.test(frontend), 'API key assignment in frontend');
  assert.ok(!/AI_API_KEY/.test(js), 'frontend must not reference AI_API_KEY');
});

test('the frontend still uses only local assets (no CDN)', () => {
  assert.ok(!/https?:\/\/(unpkg|cdn|jsdelivr|cdnjs)/i.test(html));
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /href="\.\/styles\.css"/);
});
