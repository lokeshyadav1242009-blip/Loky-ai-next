/**
 * Diagnostic + contract check for the Messages section.
 *
 * Prints the exact source regions involved (so the wiring can be reviewed
 * without a browser) and asserts the module-level contract that the runtime
 * depends on:
 *
 *   1. every named import in public/messages.js exists as an export in the
 *      module it is imported from (a missing export breaks the whole ES
 *      module graph, and therefore the entire app);
 *   2. public/app.js switches the shell/messenger and calls initMessages()
 *      when the Messages section is selected;
 *   3. the Messages module never talks to a server (no fetch/XHR) — messages
 *      are local-only.
 *
 * Exit code 0 when the contract holds, 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const app = read('public/app.js');
const messages = read('public/messages.js');
const utils = read('public/messages-utils.js');
const chatUtils = read('public/chat-utils.js');
const html = read('public/index.html');

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const show = (title, text) => {
  console.log(`\n===== ${title} =====`);
  console.log(text);
};

/* ------------------------------- diagnostics ------------------------------ */

const sectionIdx = app.indexOf('function setSection');
if (sectionIdx === -1) {
  show('app.js setSection', '(not found)');
} else {
  const lines = app.split('\n');
  const from = Math.max(0, lineOf(app, sectionIdx) - 4);
  show('app.js setSection', lines.slice(from, from + 70).join('\n'));
}

const cacheIdx = messages.indexOf('function cacheElements');
if (cacheIdx !== -1) {
  const lines = messages.split('\n');
  const from = Math.max(0, lineOf(messages, cacheIdx) - 4);
  show('messages.js cacheElements', lines.slice(from, from + 45).join('\n'));
}

const imports = [...messages.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)];
const sources = new Map([
  ['./messages-utils.js', utils],
  ['./chat-utils.js', chatUtils],
]);

const missingExports = [];
for (const [, names, source] of imports) {
  const target = sources.get(source);
  if (!target) continue;
  const exported = new Set(
    [...target.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)].map(
      (m) => m[1],
    ),
  );
  for (const raw of names.split(',')) {
    const name = raw.trim().split(/\s+as\s+/)[0].trim();
    if (!name) continue;
    if (!exported.has(name)) missingExports.push(`${source} -> ${name}`);
  }
}

show(
  'messages.js network usage',
  (messages.match(/fetch\(|XMLHttpRequest|EventSource|\/api\//g) || ['(none)']).join(', '),
);

show(
  'index.html ids (messages subset)',
  [...html.matchAll(/id="(msg[^"]*|messenger|appShell|appnav|navAssistant|navMessages)"/g)]
    .map((m) => m[1])
    .join(', '),
);

/* -------------------------------- assertions ------------------------------ */

const problems = [];

if (missingExports.length) {
  problems.push(`missing exports: ${missingExports.join(', ')}`);
}
if (!/initMessages\(\)/.test(app)) {
  problems.push('app.js never calls initMessages()');
}
if (!/leaveMessages\(\)/.test(app)) {
  problems.push('app.js never calls leaveMessages()');
}
if (!/appShell\.hidden/.test(app)) {
  problems.push('app.js does not toggle appShell.hidden');
}
if (!/messenger\.hidden/.test(app)) {
  problems.push('app.js does not toggle messenger.hidden');
}
if (/(fetch\(|XMLHttpRequest|EventSource)/.test(messages)) {
  problems.push('messages.js performs network requests (messages must stay local)');
}
if (!/loky\.ai\.next\.messages\.v1/.test(utils)) {
  problems.push('messages-utils.js lost the localStorage key');
}

console.log('\n===== result =====');
if (problems.length) {
  for (const p of problems) console.log(`FAIL - ${p}`);
  process.exit(1);
}
console.log('ok - messages module contract holds');
