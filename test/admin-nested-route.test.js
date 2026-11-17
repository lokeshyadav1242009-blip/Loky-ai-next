import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalAdminPath, isAdminRoute } from '../public/admin-route.js';

/**
 * Both /admin and /admin/admin must mount the dashboard.
 *
 * The regression this locks down: the client matched the admin route with an
 * exact string comparison (`pathname.replace(/\/+$/, '') === '/admin'`), so any
 * nested admin path — /admin/admin in the bug report — returned false, the
 * dashboard was never opened and the AI assistant rendered instead.
 *
 * Matching decides which view mounts. It grants nothing: access is still the
 * server's decision in GET /api/admin/session (Super Admin UUID allow-list).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = (name) => fs.readFileSync(path.join(root, 'public', name), 'utf8');

const adminJs = pub('admin-ui.js');

test('/admin and nested /admin/* paths are admin routes', () => {
  const adminPaths = [
    '/admin',
    '/admin/',
    '/admin/admin',
    '/admin/admin/',
    '/admin/admin/admin',
    '/admin/users',
    '/admin/users/69b59366-0c6d-4577-82ad-282e624f19d2',
    '/ADMIN',
  ];
  for (const p of adminPaths) {
    assert.equal(isAdminRoute(p), true, `expected ${p} to mount the dashboard`);
  }
});

test('look-alike paths never mount the dashboard', () => {
  const otherPaths = [
    '/',
    '/messages',
    '/administrator',
    '/administer',
    '/admin-tools',
    '/ai/admin',
    '/myadmin',
    'admin',
    '',
  ];
  for (const p of otherPaths) {
    assert.equal(isAdminRoute(p), false, `expected ${p} to stay out of the dashboard`);
  }
});

test('a missing or non-string pathname fails closed', () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    assert.equal(isAdminRoute(value), false, `expected ${String(value)} to be denied`);
  }
});

test('nested admin paths collapse onto one canonical route', () => {
  assert.equal(canonicalAdminPath(), '/admin');
});

test('admin-ui delegates route matching instead of comparing strings', () => {
  assert.match(adminJs, /import \{ canonicalAdminPath, isAdminRoute \} from '\.\/admin-route\.js'/);
  assert.match(adminJs, /function isAdminPath\(\) \{\s*return isAdminRoute\(window\.location\.pathname\);/);
  // The exact-match form that caused the bug must not come back.
  assert.doesNotMatch(adminJs, /window\.location\.pathname\.replace\([^)]*\) === '\/admin'/);
});

test('opening the dashboard canonicalises the nested URL first', () => {
  assert.match(adminJs, /function canonicaliseAdminPath\(\)/);
  assert.match(adminJs, /window\.history\.replaceState\(window\.history\.state, '', target\)/);
  assert.match(adminJs, /if \(isAdminPath\(\)\) \{\s*canonicaliseAdminPath\(\);\s*await openAdmin\(\);/);
});

test('a non-admin on an admin path is denied, never shown the panel', () => {
  assert.match(adminJs, /if \(isAdminPath\(\)\) showAdminDenied\(\);/);
  assert.match(adminJs, /el\.navAdmin\?\.setAttribute\('hidden', ''\)/);
});
