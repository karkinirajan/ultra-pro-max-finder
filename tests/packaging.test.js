import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The packager copies the project folder, not the files git tracks. The key of the Google service
// account sat in that folder (ignored by git but still there) and ended up inside the bundle, so the
// package script lists what to include instead of what to leave out.
const scripts = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).scripts;
const pattern = /--ignore='([^']+)'/.exec(scripts.package)?.[1];
const ignored = (path) => new RegExp(pattern).test(path);

describe('package script', () => {
  it('has an ignore pattern', () => {
    expect(pattern).toBeTruthy();
  });

  it.each([
    '/package.json',
    '/LICENSE',
    '/src',
    '/src/main/index.js',
    '/src/renderer/index.html',
    '/src/preload/index.cjs',
    '/node_modules',
    '/node_modules/bootstrap/dist/css/bootstrap.min.css',
    '/node_modules/@googleapis/sheets/package.json',
  ])('includes %s', (path) => expect(ignored(path)).toBe(false));

  it.each([
    '/credentials.json',
    '/google-credentials.json',
    '/service-account-credentials.json',
    '/.env',
    '/.env.local',
    '/tests',
    '/tests/e2e/smoke.mjs',
    '/coverage',
    '/dist',
    '/userData',
    '/some-new-secret.pem',
    '/eslint.config.js',
    '/.git',
    '/.github/workflows/ci.yml',
  ])('leaves out %s', (path) => expect(ignored(path)).toBe(true));
});
