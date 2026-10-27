/**
 * Copy the two browser-side open-source libraries (marked + DOMPurify) from
 * node_modules into public/vendor so the app serves them itself.
 *
 * Why: no CDN dependency at runtime (works offline, no third-party script on
 * the page, no SRI bookkeeping), and no bundler/build step is required.
 * Runs automatically on `npm install` via the postinstall script.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  return results;
}

if (process.argv[1] && process.argv[1].endsWith('vendor-assets.js')) {
  vendorAssets().catch((error) => {
    // Never fail the install: the app still runs, only Markdown rendering degrades.
    console.warn('[vendor] failed:', error.message);
    process.exitCode = 0;
  });
}
