import { describe, expect, it, vi } from 'vitest';

import { createHandlers, createTrustCheck, registerIpc } from '../src/main/ipc.js';
import { SheetsError } from '../src/main/sheets.js';

const config = {
  timeValue: '10:00',
  startDateValue: '2026-11-01',
  endDateValue: '',
  durationMinutesValueLower: 5,
  durationMinutesValueHigher: 9,
};

function setup({ known = ['a@x.com'] } = {}) {
  const calls = [];
  const schedules = {};
  const deps = {
    accounts: {
      list: async () => known.map((username) => ({ username })),
      exists: async (u) => known.includes(u),
      remove: vi.fn(async () => {}),
      canEncrypt: () => true,
    },
    templates: {
      spreadsheetId: vi.fn(async () => 'SHEET'),
      proposals: async () => ({ a: 'A' }),
      message: async () => 'M',
      sheetUrl: async () => 'U',
      saveProposal: vi.fn(async () => {}),
      deleteProposal: vi.fn(async () => {}),
      saveMessage: vi.fn(async () => {}),
      saveSheetUrl: vi.fn(async () => {}),
    },
    scheduleStore: {
      all: async () => schedules,
      get: async (u) => schedules[u] ?? null,
      set: vi.fn(async (u, c) => {
        schedules[u] = c;
      }),
      remove: vi.fn(async (u) => {
        delete schedules[u];
      }),
    },
    scheduler: { set: vi.fn(), cancel: vi.fn() },
    sheets: { readRows: vi.fn(async () => [{ A: '1' }]) },
    runner: {
      isRunning: () => false,
      run: vi.fn(async () => ({
        found: 2,
        written: 2,
        skipped: 1,
        results: [{ outcome: 'submitted' }, { outcome: 'submitted' }, { outcome: 'declined' }],
      })),
    },
    login: { start: vi.fn(async () => {}), close: vi.fn() },
    clearSession: vi.fn(async () => {}),
    openScheduleDialog: vi.fn(),
    closeScheduleDialog: vi.fn(),
    notify: vi.fn(),
  };
  return { handlers: createHandlers(deps), deps, calls, schedules };
}

describe('trust check', () => {
  const trusted = createTrustCheck('/app/src/renderer');
  const from = (url) => ({ senderFrame: { url } });
  it("accepts the app's own pages", () => {
    expect(trusted(from('file:///app/src/renderer/index.html'))).toBe(true);
    expect(trusted(from('file:///app/src/renderer/schedule.html?u=a%40x.com'))).toBe(true);
  });
  it.each([
    'https://www.linkedin.com/feed/',
    'file:///etc/passwd',
    'file:///app/src/renderer-evil/index.html',
    'file:///app/src/main/index.js',
    'file:///app/src/renderer/../main/index.js',
    '',
    undefined,
  ])('refuses %s', (url) => expect(trusted(from(url))).toBe(false));
  it('refuses an event without a frame', () => {
    expect(trusted({})).toBe(false);
    expect(trusted(undefined)).toBe(false);
  });
});

describe('registerIpc', () => {
  it('runs a handler for a trusted sender and refuses everyone else', async () => {
    const registered = {};
    const ipcMain = { handle: (channel, fn) => (registered[channel] = fn) };
    const handler = vi.fn(async (x) => x * 2);
    registerIpc({ ipcMain, handlers: { 'x:y': handler }, isTrusted: (e) => e.ok });
    expect(await registered['x:y']({ ok: true }, 21)).toBe(42);
    await expect(registered['x:y']({ ok: false }, 1)).rejects.toThrow('untrusted sender');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('handlers', () => {
  it('lists accounts with their schedule and running state', async () => {
    const { handlers, schedules } = setup({ known: ['a@x.com', 'b@x.com'] });
    schedules['b@x.com'] = config;
    expect(await handlers['accounts:list']()).toEqual([
      { username: 'a@x.com', scheduled: false, running: false },
      { username: 'b@x.com', scheduled: true, running: false },
    ]);
  });

  describe('accounts:login', () => {
    it('opens the sign-in view and reports whether the password will be kept', async () => {
      const { handlers, deps } = setup();
      expect(await handlers['accounts:login']({ username: 'a@x.com', password: 'pw' })).toEqual({
        storesPassword: true,
      });
      expect(deps.login.start).toHaveBeenCalledWith('a@x.com', 'pw');
    });
    it.each([
      [{ username: '../x', password: 'pw' }, 'Invalid account name.'],
      [{ username: 'a@x.com', password: '' }, 'Enter the password.'],
      [{ username: 'a@x.com', password: 5 }, 'Password must be text.'],
      [{ username: 'a@x.com', password: 'x'.repeat(513) }, 'Password is too long.'],
      [undefined, 'Invalid account name.'],
    ])('rejects %j', async (input, message) => {
      const { handlers, deps } = setup();
      await expect(handlers['accounts:login'](input)).rejects.toThrow(message);
      expect(deps.login.start).not.toHaveBeenCalled();
    });
  });

  it('removes an account together with its schedule, sign-in view, saved session and password', async () => {
    const { handlers, deps } = setup();
    await handlers['accounts:remove']('a@x.com');
    expect(deps.scheduler.cancel).toHaveBeenCalledWith('a@x.com');
    expect(deps.login.close).toHaveBeenCalledWith('a@x.com');
    expect(deps.scheduleStore.remove).toHaveBeenCalledWith('a@x.com');
    expect(deps.clearSession).toHaveBeenCalledWith('a@x.com');
    expect(deps.accounts.remove).toHaveBeenCalledWith('a@x.com');
    expect(deps.notify).toHaveBeenCalledWith('accounts:changed');
    await expect(handlers['accounts:remove']('../../x')).rejects.toThrow('Invalid account name.');
  });

  it('runs an account now and summarises the result', async () => {
    const { handlers } = setup();
    expect(await handlers['run:now']('a@x.com')).toEqual({
      found: 2,
      skipped: 1,
      written: 2,
      outcomes: { submitted: 2, declined: 1 },
      error: null,
      note: null,
      alreadyRunning: false,
    });
  });
  it('says so when a run is already in progress', async () => {
    const { handlers, deps } = setup();
    deps.runner.run.mockResolvedValue({ skipped: true, reason: 'already running' });
    expect(await handlers['run:now']('a@x.com')).toMatchObject({
      alreadyRunning: true,
      skipped: 0,
      note: 'already running',
    });
  });
  it('will not run an unknown account', async () => {
    const { handlers, deps } = setup();
    await expect(handlers['run:now']('ghost@x.com')).rejects.toThrow('Unknown account.');
    expect(deps.runner.run).not.toHaveBeenCalled();
  });

  describe('sheet:read', () => {
    it('returns the rows', async () => {
      const { handlers, deps } = setup();
      expect(await handlers['sheet:read']('a@x.com')).toEqual({ ok: true, rows: [{ A: '1' }] });
      expect(deps.sheets.readRows).toHaveBeenCalledWith('SHEET', 'a@x.com');
    });
    it('explains when no sheet link is saved', async () => {
      const { handlers, deps } = setup();
      deps.templates.spreadsheetId.mockResolvedValue(null);
      expect(await handlers['sheet:read']('a@x.com')).toEqual({ ok: false, reason: 'no-sheet' });
    });
    it.each([
      [403, 'forbidden'],
      [400, 'missing-tab'],
      [404, 'missing-tab'],
      [500, 'error'],
      [undefined, 'error'],
    ])('maps status %s to %s', async (status, reason) => {
      const { handlers, deps } = setup();
      deps.sheets.readRows.mockRejectedValue(new SheetsError('nope', status));
      expect(await handlers['sheet:read']('a@x.com')).toMatchObject({
        ok: false,
        reason,
        message: 'nope',
      });
    });
  });

  it('reads and saves templates, validating the text', async () => {
    const { handlers, deps } = setup();
    expect(await handlers['templates:get']()).toEqual({
      proposals: { a: 'A' },
      message: 'M',
      sheetUrl: 'U',
    });
    await handlers['templates:saveProposal']({ title: 'T', text: 'body' });
    expect(deps.templates.saveProposal).toHaveBeenCalledWith('T', 'body');
    await handlers['templates:deleteProposal']('T');
    await handlers['templates:saveMessage']('hi');
    await handlers['templates:saveSheetUrl']('https://docs.google.com/spreadsheets/d/x');
    expect(deps.templates.deleteProposal).toHaveBeenCalledWith('T');
    expect(deps.templates.saveMessage).toHaveBeenCalledWith('hi');
    await expect(handlers['templates:saveProposal']({ title: 5, text: 'x' })).rejects.toThrow(
      'Title must be text.',
    );
    await expect(handlers['templates:saveMessage']('x'.repeat(20001))).rejects.toThrow('too long');
    await expect(handlers['templates:saveSheetUrl'](null)).rejects.toThrow('Link must be text.');
  });

  describe('schedules', () => {
    it('opens the dialog for a known account only', async () => {
      const { handlers, deps } = setup();
      await handlers['schedule:open']('a@x.com');
      expect(deps.openScheduleDialog).toHaveBeenCalledWith('a@x.com');
      await expect(handlers['schedule:open']('ghost@x.com')).rejects.toThrow('Unknown account.');
    });
    it('saves a schedule and starts it at once', async () => {
      const { handlers, deps } = setup();
      const saved = await handlers['schedule:save']({ username: 'a@x.com', config });
      expect(saved).toEqual(config);
      expect(deps.scheduleStore.set).toHaveBeenCalledWith('a@x.com', config);
      expect(deps.scheduler.set).toHaveBeenCalledWith('a@x.com', config);
      expect(deps.closeScheduleDialog).toHaveBeenCalled();
      expect(deps.notify).toHaveBeenCalledWith('accounts:changed');
      expect(await handlers['schedule:get']('a@x.com')).toEqual(config);
    });
    it('does not start (or save) an invalid schedule', async () => {
      const { handlers, deps } = setup();
      await expect(
        handlers['schedule:save']({
          username: 'a@x.com',
          config: { ...config, durationMinutesValueLower: 50 },
        }),
      ).rejects.toThrow('cannot be greater');
      expect(deps.scheduleStore.set).not.toHaveBeenCalled();
      expect(deps.scheduler.set).not.toHaveBeenCalled();
    });
    it('removes a schedule and stops it', async () => {
      const { handlers, deps } = setup();
      await handlers['schedule:remove']('a@x.com');
      expect(deps.scheduler.cancel).toHaveBeenCalledWith('a@x.com');
      expect(deps.scheduleStore.remove).toHaveBeenCalledWith('a@x.com');
    });
  });
});
