import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSchedule } from './schedules.js';
import { assertText, assertUsername } from './validate.js';

/**
 * Only pages loaded from the app's own renderer folder may call the main process. The old app switched
 * Node.js integration on for its windows and let the renderer read any file under the app folder.
 */
export function createTrustCheck(rendererDir) {
  const root = path.resolve(rendererDir);
  return (event) => {
    const url = event?.senderFrame?.url ?? '';
    if (!url.startsWith('file://')) return false;
    try {
      const file = path.resolve(fileURLToPath(url));
      return file.startsWith(root + path.sep);
    } catch {
      return false;
    }
  };
}

function describeRun(result) {
  const counts = {};
  for (const item of result.results ?? []) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
  return {
    found: result.found ?? 0,
    skipped: result.skipped === true ? 0 : (result.skipped ?? 0),
    written: result.written ?? 0,
    outcomes: counts,
    error: result.error ?? null,
    note: result.reason ?? null,
    alreadyRunning: result.skipped === true,
  };
}

/** The operations the renderer can ask for, as plain async functions that check their input. */
export function createHandlers({
  accounts,
  templates,
  scheduleStore,
  scheduler,
  sheets,
  runner,
  login,
  clearSession,
  openScheduleDialog,
  closeScheduleDialog,
  notify,
}) {
  async function requireAccount(username) {
    assertUsername(username);
    if (!(await accounts.exists(username))) throw new Error('Unknown account.');
    return username;
  }

  return {
    'accounts:list': async () => {
      const schedules = await scheduleStore.all();
      return (await accounts.list()).map(({ username }) => ({
        username,
        scheduled: Boolean(schedules[username]),
        running: runner.isRunning(username),
      }));
    },

    'accounts:login': async ({ username, password } = {}) => {
      assertUsername(username);
      assertText(password, { max: 512, name: 'Password' });
      if (!password) throw new Error('Enter the password.');
      await login.start(username, password);
      return { storesPassword: accounts.canEncrypt() };
    },

    'accounts:remove': async (username) => {
      assertUsername(username);
      scheduler.cancel(username);
      login.close(username);
      await scheduleStore.remove(username);
      await clearSession(username);
      await accounts.remove(username);
      notify('accounts:changed');
      return true;
    },

    'run:now': async (username) => describeRun(await runner.run(await requireAccount(username))),

    'sheet:read': async (username) => {
      assertUsername(username);
      const spreadsheetId = await templates.spreadsheetId();
      if (!spreadsheetId) return { ok: false, reason: 'no-sheet' };
      try {
        return { ok: true, rows: await sheets.readRows(spreadsheetId, username) };
      } catch (error) {
        const status = error.status;
        const reason =
          status === 403 ? 'forbidden' : status === 400 || status === 404 ? 'missing-tab' : 'error';
        return { ok: false, reason, status: status ?? null, message: error.message };
      }
    },

    'templates:get': async () => ({
      proposals: await templates.proposals(),
      message: await templates.message(),
      sheetUrl: await templates.sheetUrl(),
    }),
    'templates:saveProposal': async ({ title, text } = {}) => {
      await templates.saveProposal(
        assertText(title, { max: 200, name: 'Title' }),
        assertText(text),
      );
      return true;
    },
    'templates:deleteProposal': async (title) => {
      await templates.deleteProposal(assertText(title, { max: 200, name: 'Title' }));
      return true;
    },
    'templates:saveMessage': async (text) => {
      await templates.saveMessage(assertText(text));
      return true;
    },
    'templates:saveSheetUrl': async (url) => {
      await templates.saveSheetUrl(assertText(url, { max: 500, name: 'Link' }));
      return true;
    },

    'schedule:open': async (username) => {
      openScheduleDialog(await requireAccount(username));
      return true;
    },
    'schedule:get': async (username) => scheduleStore.get(await requireAccount(username)),
    'schedule:save': async ({ username, config } = {}) => {
      await requireAccount(username);
      const normalized = normalizeSchedule(config);
      await scheduleStore.set(username, normalized);
      scheduler.set(username, normalized); // takes effect now; the old app needed a restart
      closeScheduleDialog();
      notify('accounts:changed');
      return normalized;
    },
    'schedule:remove': async (username) => {
      await requireAccount(username);
      scheduler.cancel(username);
      await scheduleStore.remove(username);
      notify('accounts:changed');
      return true;
    },
  };
}

export function registerIpc({ ipcMain, handlers, isTrusted }) {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrusted(event)) throw new Error('Request refused: untrusted sender.');
      return handler(...args);
    });
  }
}
