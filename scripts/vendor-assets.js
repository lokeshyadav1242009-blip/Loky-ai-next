/**
 * Copy the two browser-side open-source libraries (marked + DOMPurify) from
 * node_modules into public/vendor so the app serves them itself.
 *
 * Why: no CDN dependency at runtime (works offline, no third-party script on
 * the page, no SRI bookkeeping), and no bundler/build step is required.
 * Runs automatically on `npm install` via the postinstall script.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'public', 'vendor');

const ASSETS = [
  {
    name: 'marked',
    sources: [
      'node_modules/marked/lib/marked.esm.js',
      'node_modules/marked/marked.min.js',
    ],
    target: 'marked.esm.js',
  },
  {
    name: 'dompurify',
    sources: [
      'node_modules/dompurify/dist/purify.es.mjs',
      'node_modules/dompurify/dist/purify.min.js',
    ],
    target: 'purify.esm.js',
  },
];

/**
 * KaTeX is vendored as a directory rather than a single file: the stylesheet
 * references `fonts/KaTeX_*.woff2` relatively, so the fonts must land in
 * public/vendor/katex/fonts next to the CSS or maths renders in a fallback
 * serif face. Served from our own origin, which is what CSP font-src allows.
 */
const KATEX_CSS = ['node_modules/katex/dist/katex.min.css'];
const KATEX_SCRIPT = ['node_modules/katex/dist/katex.mjs', 'node_modules/katex/dist/katex.min.js'];
const KATEX_FONTS = 'node_modules/katex/dist/fonts';

export async function vendorAssets({ quiet = false } = {}) {
  await mkdir(vendorDir, { recursive: true });
  const results = [];

  for (const asset of ASSETS) {
    const source = asset.sources.map((s) => path.join(root, s)).find(existsSync);
    if (!source) {
      results.push({ asset: asset.name, copied: false });
      if (!quiet) {
        console.warn(
          `[vendor] ${asset.name} not found in node_modules - run "npm install" first.`,
        );
      }
      continue;
    }
    const target = path.join(vendorDir, asset.target);
    const contents = await readFile(source, 'utf8');
    // Marked ships an ESM build already; DOMPurify's ESM build may reference
    // a default export, which is what the frontend imports.
    await writeFile(target, contents, 'utf8');
    results.push({ asset: asset.name, copied: true, target: path.relative(root, target) });
  }

  if (!quiet) {
    const copied = results.filter((r) => r.copied).length;
    console.log(`[vendor] ${copied}/${ASSETS.length} browser assets ready in public/vendor`);
  }

  await vendorKatex({ quiet, results });

  return results;
}

/** Copy katex.min.css + katex.mjs + every font it references. */
async function vendorKatex({ quiet, results }) {
  const katexDir = path.join(vendorDir, 'katex');
  const css = KATEX_CSS.map((s) => path.join(root, s)).find(existsSync);
  const script = KATEX_SCRIPT.map((s) => path.join(root, s)).find(existsSync);

  if (!css || !script) {
    results.push({ asset: 'katex', copied: false });
    if (!quiet) {
      console.warn('[vendor] katex not found in node_modules - run "npm install" first.');
    }
    return;
  }

  await mkdir(katexDir, { recursive: true });
  await copyFile(css, path.join(katexDir, 'katex.min.css'));

  // Keep the ESM build's name stable so the frontend import cannot drift.
  const scriptName = script.endsWith('.mjs') ? 'katex.mjs' : 'katex.min.js';
  await copyFile(script, path.join(katexDir, scriptName));

  const fontsSource = path.join(root, KATEX_FONTS);
  let fonts = 0;
  if (existsSync(fontsSource)) {
    const fontsDir = path.join(katexDir, 'fonts');
    await mkdir(fontsDir, { recursive: true });
    for (const file of await readdir(fontsSource)) {
      if (!/\.(woff2?|ttf)$/i.test(file)) continue;
      await copyFile(path.join(fontsSource, file), path.join(fontsDir, file));
      fonts += 1;
    }
  }

  results.push({
    asset: 'katex',
    copied: true,
    script: scriptName,
    fonts,
    target: path.relative(root, katexDir),
  });

  if (!quiet) {
    console.log(`[vendor] katex ready (${scriptName}, ${fonts} fonts) in public/vendor/katex`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('vendor-assets.js')) {
  vendorAssets().catch((error) => {
    // Never fail the install: the app still runs, only Markdown rendering degrades.
    console.warn('[vendor] failed:', error.message);
    process.exitCode = 0;
  });
}
