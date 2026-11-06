# Versions

Read from `package-lock.json` and the installed packages on 2026-11-01.

| Component                     | Version                    | Was (resolved in the old lock file)                             | Where it is set      |
| ----------------------------- | -------------------------- | --------------------------------------------------------------- | -------------------- |
| Node.js                       | 26 (26.13.0 here)          | unpinned                                                        | `.nvmrc`, `engines`  |
| Electron                      | 45.2.1                     | 26.2.4                                                          | `package.json` (dev) |
| Playwright                    | 1.64.1                     | 1.40.0                                                          | `package.json`       |
| @googleapis/sheets            | 18.1.2                     | `googleapis` 126.0.1 (the whole Google API collection)          |                      |
| google-auth-library           | 11.3.2                     | 9.0.0                                                           |                      |
| Bootstrap                     | 5.3.8 (bundled)            | from a CDN: unpinned "latest", 5.0.0-beta2 in the second window |                      |
| material-icons                | 1.13.14 (bundled)          | from Google Fonts                                               |                      |
| Vitest / @vitest/coverage-v8  | 5.0.5                      | absent                                                          | dev                  |
| ESLint / @eslint/js / globals | 10.14.0 / 10.0.1 / 17.14.0 | absent                                                          | dev                  |
| Prettier                      | 3.9.10                     | absent                                                          | dev                  |
| @electron/packager            | 20.3.0                     | `electron-packager` 17.1.2                                      | dev                  |

238 packages are locked (the old lock held 392).

**Removed:** `puppeteer` 21.3.6, `xlsx` 0.18.5, `exceljs` 4.3.0, `node-cron` 3.0.2, `toad-scheduler` 3.0.0, `date-fns` 2.30.0, `electron-dl` 3.5.0 (none of them used any more, or only by dead code), `node-schedule` 2.1.1 (replaced by a small scheduler that is tested), and from the page: jQuery 2.1.1 and Materialize 0.97.3 (loaded from CDNs, unused).

`npm audit`: **0 vulnerabilities in the production dependencies.** The full tree reports two moderate advisories (`glob`, `minimatch`) inside build tools (`@electron/packager`, `eslint`); they are not shipped in the app, and the fix npm offers is a downgrade to ESLint 4 and packager 18, so it was not applied.

## Verified here

- 262 unit tests pass (97% of lines of `src/main`), ESLint and Prettier are clean.
- The real app, started headless by `npm run test:e2e` (twice, same result): old data is picked up, windows are sandboxed with context isolation and no Node, hostile text is inert, templates and a schedule can be saved, no console errors or CSP violations.
- `npm run package` builds a Linux x64 bundle that starts; its `app.asar` holds only `package.json`, `src`, `node_modules` and `LICENSE`, and no credentials file.

## Not verified here

- Anything against live LinkedIn (sign-in, the request list, answering a request) or a live Google Sheet. The parser's input shape comes from the old code; its test data is made up.
- Encryption of passwords with a real keyring (none is available in this environment; the unit tests use a fake `safeStorage`, and the end-to-end run confirmed the "no encryption" path leaves the old file alone).
- Windows and macOS builds, and a GitHub Actions run.
