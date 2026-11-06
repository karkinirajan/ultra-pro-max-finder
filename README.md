# Ultra Pro Max Finder

A desktop app (Electron) for freelancers who answer **LinkedIn ProFinder** requests. For each LinkedIn account you add, it checks the open project requests on a schedule, writes them to a **Google Sheet**, and answers each one in a visible browser with a saved proposal template (and an optional follow-up message), or declines requests from people early in their career.

> It automates actions on LinkedIn. LinkedIn's User Agreement restricts automated access, so accounts used this way can be limited or closed. Use it at your own risk.

## How it works

1. **Add Account** signs in to LinkedIn inside the app. The session is kept in its own storage per account, and the password (if the system can encrypt it) is kept encrypted for automatic re-login.
2. **Run now** (or a schedule) opens the ProFinder requests page, reads the list of requests, appends them to the account's tab in your Google Sheet, and then for each request: **declines** it when the client says they are not in a mid or late career, otherwise **submits** your proposal template for that job type (with `<first_name>` replaced) and sends your follow-up message.
3. **Proposals** is where you keep the proposal templates (one per job type, plus an optional `default`), the follow-up message, and the link of the Google Sheet.

## Quickstart

Requires Node.js 26 (see `.nvmrc`).

```bash
npm ci
npx playwright install chromium   # the browser used to answer requests
npm start
```

### Google Sheet

The requests are written with a Google **service account** (no sign-in popup):

1. In Google Cloud, create a service account and a JSON key for it.
2. Share your Google Sheet with the service account's e-mail address (Editor).
3. Give the app the key: set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`, or save it as `google-credentials.json` in the app's data folder (below).
4. Paste the sheet's link on the **Proposals** page.

The key is never read from the project folder (it used to be, and was committed to git).

### Where your data is

The app's data folder is `~/.config/profinder` on Linux (the same folder as the old version, so existing accounts, templates and schedules are picked up), `~/Library/Application Support/profinder` on macOS and `%APPDATA%\profinder` on Windows. It holds `userInfo.json` (accounts), `credentials.vault.json` (encrypted passwords), `template.json`, `messageTemplate.txt`, `excelUrl.txt` (the sheet link), `schedules.json`, and the LinkedIn session of each account.

## Security

- Windows run **sandboxed with context isolation and no Node.js**, including the window that shows linkedin.com. The page can only call a fixed list of functions (`window.api`), each of which checks its input, and only pages from the app's own folder may call them.
- **Passwords** are encrypted with the operating system's keychain (Electron `safeStorage`). Where that is not available (a Linux desktop without a keyring) no password is stored and the saved LinkedIn session is used. The old plain-text `pass.json` is migrated and deleted on first start.
- Everything from the user, the disk or the sheet is put on the page as text, never as HTML, and the pages have a strict Content-Security-Policy; Bootstrap and the icons are bundled, not loaded from CDNs.
- Packaged builds contain only `package.json`, `src`, `node_modules` and `LICENSE`.

## Project structure

```
src/
├── main/                 the Electron main process (ES modules)
│   ├── index.js          starts the app and wires the modules below to Electron
│   ├── accounts.js       accounts and their encrypted passwords
│   ├── templates.js      proposal templates, follow-up message, sheet link
│   ├── schedules.js      schedule store and the scheduler
│   ├── sheets.js         Google Sheets (read and append)
│   ├── runner.js         one cycle: fetch requests, write rows, answer them
│   ├── ipc.js            the functions the page may call, with validation
│   ├── validate.js  files.js  paths.js  window.js  log.js
│   └── linkedin/         login.js  requests.js  projects.js  submit.js
├── preload/              the bridges exposed to the pages (sandboxed, CommonJS)
└── renderer/             the pages: index.html, schedule.html, their scripts and style
tests/                    unit tests (Vitest) and e2e/smoke.mjs (drives the real app)
```

## Scripts

| Command                                 | What it does                                                        |
| --------------------------------------- | ------------------------------------------------------------------- |
| `npm start`                             | run the app                                                         |
| `npm test`                              | unit tests with coverage                                            |
| `npm run test:e2e`                      | start the real app headless and use it (no LinkedIn or Google call) |
| `npm run lint` / `npm run format:check` | ESLint / Prettier                                                   |
| `npm run package`                       | build a distributable into `dist/` for the current platform         |

## Testing

262 unit tests cover the stores, scheduler, validation, Google Sheets wrapper, the parser of LinkedIn's data, the Playwright flow (against a fake page), the sign-in and request-capture logic (against fake Electron objects), the IPC layer and the packaging rules. The end-to-end script starts the real app with a temporary data folder and checks, among other things, that hostile text in a template is shown as text and that the window really is sandboxed.

The parser reads LinkedIn's undocumented JSON. Its tests use made-up data in the shape the code expects, not real LinkedIn data, so a change on LinkedIn's side will not be caught until it breaks a real run.

## Versions

[VERSIONS.md](./VERSIONS.md). What changed and what needs your attention (**the Google key in the git history**): [work-done.md](./work-done.md).

## License

MIT, see [LICENSE](./LICENSE).
