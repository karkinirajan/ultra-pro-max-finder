// Starts the real app (Electron) with a throw-away data folder and uses it like a person would.
// No LinkedIn or Google call is made. Run with: npm run test:e2e
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = process.env.UPMF_SHOTS ? path.resolve(process.env.UPMF_SHOTS) : null;
const userData = await mkdtemp(path.join(os.tmpdir(), 'upmf-e2e-'));
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

let failures = 0;
const step = (name) => process.stdout.write(`- ${name} ... `);
const ok = (detail = '') => console.log(`ok ${detail}`);
function check(condition, message) {
  if (!condition) {
    failures += 1;
    console.log(`FAILED: ${message}`);
  }
  return condition;
}

// What a user of the old version would already have on disk (accounts, a template, a plain-text password).
await mkdir(userData, { recursive: true });
await writeFile(
  path.join(userData, 'userInfo.json'),
  '{"username":"jane@example.com","isScheduled":true}\n{"username":"sam@example.com","isScheduled":true}\n',
);
await writeFile(
  path.join(userData, 'pass.json'),
  '{"username":"jane@example.com","password":"Old-Plain-Text-Pw"}\n',
);
await writeFile(
  path.join(userData, 'template.json'),
  JSON.stringify({
    [HOSTILE]: `${HOSTILE}<script>window.__pwned=1</script>`,
    'resume writing': 'Hi <first_name>',
  }),
);
await writeFile(path.join(userData, 'messageTemplate.txt'), HOSTILE);

const app = await electron.launch({
  args: [root, '--ozone-platform=headless', '--no-sandbox'],
  env: { ...process.env, UPMF_USER_DATA: userData },
});
const problems = [];
try {
  const window = await app.firstWindow();
  window.on(
    'console',
    (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`),
  );
  window.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('#accountsBody tr');

  step('the window opens and lists the accounts of the old data');
  const names = await window.locator('#accountsBody td.account-name').allTextContents();
  check(names.join() === 'jane@example.com,sam@example.com', `accounts were ${names}`);
  check((await window.title()) === 'Ultra Pro Max Finder', 'window title');
  ok(names.join(' & '));
  if (shots) await window.screenshot({ path: path.join(shots, '1-accounts.png') });

  step('the plain-text password file was moved away from disk');
  const plain = await readFile(path.join(userData, 'pass.json'), 'utf8').catch(() => null);
  const vault = await readFile(path.join(userData, 'credentials.vault.json'), 'utf8').catch(
    () => '',
  );
  const encryptionAvailable = await app.evaluate(({ safeStorage }) =>
    safeStorage.isEncryptionAvailable(),
  );
  if (encryptionAvailable) {
    check(plain === null, 'pass.json still exists');
    check(
      vault.includes('jane@example.com') && !vault.includes('Old-Plain-Text-Pw'),
      'vault missing or holds the password in clear',
    );
    ok('encrypted');
  } else {
    check(
      plain !== null && plain.includes('Old-Plain-Text-Pw'),
      'without encryption the old file must be left alone',
    );
    check(!vault.includes('Old-Plain-Text-Pw'), 'password leaked into the vault');
    ok('encryption unavailable here: left in place, as designed');
  }

  step('the window is locked down');
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      sandbox: p.sandbox,
    };
  });
  check(
    prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.sandbox === true,
    `web preferences were ${JSON.stringify(prefs)}`,
  );
  const exposed = await window.evaluate(() => ({
    require: typeof require,
    process: typeof process,
    ipc: typeof window.ipcRenderer,
    api: Object.keys(window.api ?? {})
      .sort()
      .join(),
    apiHasIpc: Object.keys(window.api ?? {}).some((k) => /ipc/i.test(k)),
  }));
  check(
    exposed.require === 'undefined' &&
      exposed.process === 'undefined' &&
      exposed.ipc === 'undefined',
    `page globals ${JSON.stringify(exposed)}`,
  );
  check(
    exposed.api === 'accounts,run,schedule,sheet,templates' && !exposed.apiHasIpc,
    `window.api was ${exposed.api}`,
  );
  ok(JSON.stringify(prefs));

  step('the Proposals page shows hostile template text as text');
  await window.click('#nav-proposals');
  await window.waitForSelector('#savedTemplate option', { state: 'attached' });
  const options = await window.locator('#savedTemplate option').allTextContents();
  check(
    options.includes(HOSTILE.toLowerCase()) || options.includes(HOSTILE),
    `options were ${JSON.stringify(options)}`,
  );
  const savedMessage = await window.locator('#savedMessage').textContent();
  check(savedMessage === HOSTILE, 'saved message is not shown literally');
  const injected = await window.evaluate(() => ({
    pwned: window.__pwned,
    imgs: document.querySelectorAll('#mainBody img').length,
    scripts: document.querySelectorAll('#mainBody script').length,
  }));
  check(
    injected.pwned === undefined && injected.imgs === 0 && injected.scripts === 0,
    `injection result ${JSON.stringify(injected)}`,
  );
  ok('no element created, no script ran');
  if (shots) await window.screenshot({ path: path.join(shots, '2-proposals.png') });

  step('a template can be saved, and a bad sheet link is refused');
  await window.fill('#templateTitle', 'Coaching');
  await window.fill('#templateText', 'Hello <first_name>, glad to help.');
  await window.click('#proposalForm button[type=submit]');
  await window.waitForFunction(() =>
    [...document.querySelectorAll('#savedTemplate option')].some(
      (o) => o.textContent === 'coaching',
    ),
  );
  const saved = JSON.parse(await readFile(path.join(userData, 'template.json'), 'utf8'));
  check(
    saved.coaching === 'Hello <first_name>, glad to help.' &&
      saved['resume writing'] === 'Hi <first_name>',
    'template.json content',
  );
  await window.fill('#sheetUrl', 'https://example.com/not-a-sheet');
  await window.click('#sheetForm button[type=submit]');
  await window.waitForSelector('.alert-danger');
  const refusal = await window.locator('.alert-danger').first().textContent();
  check(
    /not a Google Sheets link/.test(refusal) && !/Error invoking/.test(refusal),
    `refusal text was "${refusal}"`,
  );
  await window.fill('#sheetUrl', 'https://docs.google.com/spreadsheets/d/DEMO_SHEET_ID/edit');
  await window.click('#sheetForm button[type=submit]');
  await window.waitForSelector('.alert-success:has-text("Link saved")');
  check(
    (await readFile(path.join(userData, 'excelUrl.txt'), 'utf8')).includes('DEMO_SHEET_ID'),
    'excelUrl.txt content',
  );
  ok();

  step('a schedule can be set from its dialog and shows on the account');
  await window.click('#nav-accounts');
  await window.waitForSelector('#accountsBody tr');
  const dialogPromise = app.waitForEvent('window');
  await window.click('#accountsBody tr:first-child button[title="Schedule"]');
  const dialog = await dialogPromise;
  await dialog.waitForLoadState('domcontentloaded');
  check(
    (await dialog.locator('#who').textContent()) === 'jane@example.com',
    'dialog names the account',
  );
  await dialog.fill('#timeInput', '09:30');
  await dialog.fill('#startDateInput', '2030-01-01');
  await dialog.fill('#lower', '30');
  await dialog.fill('#higher', '10');
  await dialog.click('button[type=submit]');
  await dialog.waitForSelector('#error:not(.d-none)');
  check(
    /cannot be greater/.test(await dialog.locator('#error').textContent()),
    'bad interval should be refused in the dialog',
  );
  await dialog.fill('#lower', '10');
  await dialog.fill('#higher', '30');
  const closed = dialog.waitForEvent('close');
  await dialog.click('button[type=submit]');
  await closed;
  await window.waitForSelector('#accountsBody tr:first-child:has-text("Scheduled")');
  const schedules = JSON.parse(await readFile(path.join(userData, 'schedules.json'), 'utf8'));
  check(
    schedules['jane@example.com']?.durationMinutesValueHigher === 30 &&
      !schedules['sam@example.com'],
    `schedules.json was ${JSON.stringify(schedules)}`,
  );
  const row2 = await window.locator('#accountsBody tr:nth-child(2)').textContent();
  check(row2.includes('Not scheduled'), 'the other account should not be scheduled');
  ok();
  if (shots) await window.screenshot({ path: path.join(shots, '3-accounts-scheduled.png') });

  step('the Add Account page explains what happens to the password');
  await window.click('#nav-add');
  await window.waitForSelector('#loginForm');
  check(
    /encrypted by the operating system/.test(await window.locator('#passwordHint').textContent()),
    'hint text',
  );
  ok();

  step('the sheet area reports a missing Google credentials file in place, without a new notice');
  const noticesBefore = await window.locator('#notice .alert').count(); // earlier steps' toasts may still show
  await window.click('#nav-accounts');
  await window.waitForSelector('#sheetTable');
  await window.waitForFunction(() => document.querySelector('#sheetTable')?.textContent.length > 0);
  const sheetText = await window.locator('#sheetTable').textContent();
  check(/No Google credentials/.test(sheetText), `sheet area said "${sheetText}"`);
  check(
    (await window.locator('#notice .alert').count()) <= noticesBefore,
    'a missing key must show in place, not add a notice on every visit',
  );
  ok(`"${sheetText.trim().slice(0, 60)}..."`);

  step('there were no console errors or CSP violations');
  const real = problems.filter((p) => !/GOOGLE_APPLICATION_CREDENTIALS|google-credentials/.test(p));
  check(real.length === 0, `console problems: ${JSON.stringify(real)}`);
  ok(`${problems.length} message(s), all about the missing Google key`);
} catch (error) {
  failures += 1;
  console.log(`\nFAILED with an exception: ${error.stack ?? error}`);
} finally {
  await app.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
