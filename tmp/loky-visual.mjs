/* Visual/layout probe for LOKY AI Next (dev-only, not part of the repo). */
import puppeteer from '/workspace/Loky-ai-next/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8099';
const OUT = process.env.OUT_DIR || '/tmp/loky-shots';
const TAG = process.env.TAG || 'cur';
const W = Number(process.env.W || 390);
const H = Number(process.env.H || 844);

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = async (page, label) => {
  const data = await page.evaluate(() => {
    const info = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, present: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        sel,
        present: true,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        w: Math.round(r.width),
        h: Math.round(r.height),
        opacity: cs.opacity,
        visibility: cs.visibility,
        display: cs.display,
        visibleInViewport: r.bottom > 0 && r.top < innerHeight && cs.opacity !== '0' && cs.visibility !== 'hidden' && cs.display !== 'none',
      };
    };
    return {
      vw: innerWidth,
      vh: innerHeight,
      docScroll: document.documentElement.scrollHeight,
      els: ['#intro', '.app', '.main', '.topbar', '.messages', '.hero', '.hero__mark', '.hero__brand', '.hero__wordmark', '.hero__credit', '.composer-wrap', '.composer', '#input', '.send']
        .map(info),
      heroBrandFlexDir: (() => {
        const e = document.querySelector('.hero__brand');
        return e ? getComputedStyle(e).flexDirection : null;
      })(),
      introExists: !!document.querySelector('#intro'),
      msgCount: document.querySelectorAll('.msg').length,
    };
  });
  console.log(`\n--- ${label} (viewport ${data.vw}x${data.vh}) ---`);
  for (const e of data.els) {
    if (!e.present) {
      console.log(`  ${e.sel.padEnd(16)} MISSING`);
      continue;
    }
    console.log(
      `  ${e.sel.padEnd(16)} top=${String(e.top).padStart(5)} bot=${String(e.bottom).padStart(5)} ${String(e.w).padStart(4)}x${String(e.h).padStart(4)} op=${e.opacity} vis=${e.visibility} disp=${e.display} inVP=${e.visibleInViewport ? 'YES' : 'no '}`
    );
  }
  console.log(`  heroBrandFlexDir=${data.heroBrandFlexDir} introExists=${data.introExists} msgs=${data.msgCount} docScroll=${data.docScroll}`);
  return data;
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
});

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });

await sleep(400);
await page.screenshot({ path: `${OUT}/${TAG}-01-intro.png` });
await probe(page, 'DURING INTRO (0.4s)');

await sleep(3000);
await page.screenshot({ path: `${OUT}/${TAG}-02-after-intro.png` });
await probe(page, 'AFTER INTRO (3.4s)');

await page.evaluate(() => {
  const m = document.querySelector('.messages');
  if (m) m.scrollTop = m.scrollHeight;
});
await sleep(500);
await page.screenshot({ path: `${OUT}/${TAG}-03-scrolled.png` });
await probe(page, 'AFTER SCROLL TO BOTTOM');

console.log('\n--- console output ---');
console.log(errors.length ? errors.slice(0, 25).join('\n') : '(none)');

await browser.close();
