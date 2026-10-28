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

/* ------------------------------- messages --------------------------------- */

test('the Messages section markup is present in the shell', () => {
  assert.match(html, /id="messenger"/);
  assert.match(html, /id="msgList"/);
  assert.match(html, /id="msgSearch"/);
  assert.match(html, /id="msgBody"/);
  assert.match(html, /id="msgComposer"/);
  assert.match(html, /id="msgInput"/);
  assert.match(html, /id="msgSend"/);
  assert.match(html, /id="msgAttach"/);
  assert.match(html, /id="msgEmoji"/);
  assert.match(html, /id="msgEmpty"/);
  assert.match(html, /id="msgNew"/);
});

test('the top navigation switches between AI Assistant and Messages', () => {
  assert.match(html, /id="navAssistant"/);
  assert.match(html, /id="navMessages"/);
  assert.match(html, /AI Assistant/);
  assert.match(html, />\s*Messages\s*</);
});

test('app.js wires the section switch without unmounting the assistant', () => {
  assert.match(js, /initMessages/);
  assert.match(js, /leaveMessages/);
  assert.match(js, /function setSection/);
  // The assistant shell is hidden, never removed from the DOM.
  assert.match(js, /appShell\.hidden/);
  assert.ok(!/appShell\.remove\(|appShell\.innerHTML\s*=/.test(js), 'assistant shell must not be destroyed');
});

test('the Messages client module is loaded as an ES module', () => {
  assert.match(html, /<script type="module" src="\.\/app\.js">/);
  assert.match(js, /from '\.\/messages\.js'/);
  assert.match(js, /from '\.\/messages-utils\.js'/);
});

test('the chat list renders avatars, names, previews, timestamps and unread badges', () => {
  assert.match(messagesJs, /msg-avatar/);
  assert.match(messagesJs, /msg-row__name/);
  assert.match(messagesJs, /msg-row__preview/);
  assert.match(messagesJs, /msg-row__time/);
  assert.match(messagesJs, /msg-badge/);
  assert.match(messagesJs, /thread\.unread/);
});

test('sent and received bubbles are visually distinct', () => {
  assert.match(messagesJs, /msg-bubble--\$\{/);
  assert.match(messagesJs, /message\.direction === 'out' \? 'out' : 'in'/);
  assert.match(css, /\.msg-bubble--out/);
  assert.match(css, /\.msg-bubble--in/);
});

test('each bubble carries its own timestamp', () => {
  assert.match(messagesJs, /msg-bubble__time/);
  assert.match(messagesJs, /formatClockTime/);
});

test('the Messages section supports search, new, rename and delete', () => {
  assert.match(messagesJs, /state\.query/);
  assert.match(messagesJs, /function startNewConversation/);
  assert.match(messagesJs, /function renameActiveThread/);
  assert.match(messagesJs, /function deleteActiveThread/);
  assert.match(messagesJs, /function openThread/);
});

test('the empty state is rendered when there are no conversations', () => {
  assert.match(messagesJs, /function renderEmpty/);
  assert.match(messagesJs, /No conversations yet/);
  assert.match(messagesJs, /el\.empty\.hidden = false/);
  assert.match(messagesJs, /el\.empty\.hidden = true/);
});

test('demo conversations are labelled as samples, never as real chats', () => {
  assert.match(messagesJs, /msg-chip-demo/);
  assert.match(messagesJs, /'Sample'/);
  assert.match(messagesJs, /Sample conversation/);
  assert.match(messagesUtils, /demo: true/);
});

test('the Messages storage key is separate from the assistant history key', () => {
  assert.match(messagesUtils, /loky\.ai\.next\.messages\.v1/);
  assert.ok(!messagesJs.includes('loky.ai.next.v1'), 'messages must not reuse the assistant storage key');
});

test('the Messages feature ships no Status, calls or video-call surfaces', () => {
  const section = html.slice(html.indexOf('id="messenger"'), html.indexOf('id="aboutDialog"'));
  assert.ok(!/status/i.test(section), 'no Status feature expected in the Messages markup');
  assert.ok(!/video|call/i.test(section), 'no call/video feature expected in the Messages markup');
  assert.ok(!/\bcreateOffer\b|getUserMedia|MediaStream/.test(messagesJs), 'no WebRTC/media APIs expected');
});

test('the Messages feature stays local: no network calls or new endpoints', () => {
  assert.ok(!/fetch\(|XMLHttpRequest|EventSource/.test(messagesJs), 'Messages must not talk to the network');
  assert.ok(!/socket\.io|ws:\/\//.test(messagesJs), 'Messages must not open a websocket');
});

test('the Messages feature introduces no new dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['dompurify', 'dotenv', 'express', 'marked']);
});

test('the Messages styles are present and mobile-first', () => {
  assert.match(css, /\.messenger\s*\{/);
  assert.match(css, /\.msg-list-pane/);
  assert.match(css, /\.msg-thread\b/);
  assert.match(css, /\.msg-composer/);
  assert.match(css, /\.msg-avatar/);
  assert.match(css, /\.msg-emoji-panel/);
  assert.match(css, /@media \(max-width: 899px\)/);
});

/* -------------------------------- security -------------------------------- */

test('no API key or secret literal is embedded in the frontend', () => {
  const frontend = `${html}\n${css}\n${js}\n${pub('chat-utils.js')}\n${messagesJs}\n${messagesUtils}`;
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(frontend), 'looks like a hardcoded API key');
  assert.ok(!/AI_API_KEY\s*[:=]\s*['"][^'"]+['"]/.test(frontend), 'API key assignment in frontend');
  assert.ok(!/AI_API_KEY/.test(js), 'frontend must not reference AI_API_KEY');
});

test('the frontend still uses only local assets (no CDN)', () => {
  assert.ok(!/https?:\/\/(unpkg|cdn|jsdelivr|cdnjs)/i.test(html));
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /href="\.\/styles\.css"/);
});
