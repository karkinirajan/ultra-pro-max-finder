import { describe, expect, it, vi } from 'vitest';

import { createRunner } from '../src/main/runner.js';
import { SheetsError } from '../src/main/sheets.js';
import { project, response } from './fixtures/voyager.js';

function setup(overrides = {}) {
  const calls = {};
  const parts = {
    watcher: {
      fetchProjects: vi.fn(async () =>
        response(project({ id: '1' }), project({ id: '2', client: 'Sam Roe' })),
      ),
    },
    templates: { spreadsheetId: vi.fn(async () => 'SHEET_ID') },
    sheets: { appendRows: vi.fn(async (_id, _tab, rows) => rows.length) },
    submitter: {
      submitAll: vi.fn(async (items) => items.map((i) => ({ id: i.id, outcome: 'submitted' }))),
    },
    getCookies: vi.fn(async () => [{ name: 'li_at' }]),
    notify: vi.fn(),
    ...overrides,
  };
  return { runner: createRunner(parts), parts, calls };
}

describe('runner', () => {
  it('writes the requests to the sheet tab of the account and answers them', async () => {
    const { runner, parts } = setup();
    const summary = await runner.run('jane@example.com');
    expect(parts.sheets.appendRows).toHaveBeenCalledTimes(1);
    const [id, tab, rows] = parts.sheets.appendRows.mock.calls[0];
    expect([id, tab]).toEqual(['SHEET_ID', 'jane@example.com']);
    expect(rows.map((r) => r['Client First Name'])).toEqual(['Jane', 'Sam']);
    expect(parts.submitter.submitAll.mock.calls[0][0].map((p) => p.id)).toEqual(['1', '2']);
    expect(parts.submitter.submitAll.mock.calls[0][1]).toEqual([{ name: 'li_at' }]);
    expect(parts.getCookies).toHaveBeenCalledWith('jane@example.com');
    expect(summary).toMatchObject({ found: 2, written: 2, skipped: 0 });
    expect(summary.results).toHaveLength(2);
    expect(parts.notify).toHaveBeenCalledWith('run:found', 'jane@example.com');
    expect(parts.notify).toHaveBeenCalledWith('run:done', 'jane@example.com');
  });

  it('does nothing when LinkedIn returned nothing', async () => {
    const { runner, parts } = setup({ watcher: { fetchProjects: vi.fn(async () => null) } });
    expect(await runner.run('a@x.com')).toMatchObject({ found: 0 });
    expect(parts.sheets.appendRows).not.toHaveBeenCalled();
    expect(parts.submitter.submitAll).not.toHaveBeenCalled();
  });

  it('does nothing when there are no requests', async () => {
    const { runner, parts } = setup({ watcher: { fetchProjects: vi.fn(async () => response()) } });
    expect(await runner.run('a@x.com')).toEqual({ found: 0, skipped: 0 });
    expect(parts.submitter.submitAll).not.toHaveBeenCalled();
  });

  it('counts requests it could not read, and carries on with the others', async () => {
    const { runner, parts } = setup({
      watcher: {
        fetchProjects: vi.fn(async () =>
          response(project({ id: '1', omit: ['header'] }), project({ id: '2' })),
        ),
      },
    });
    const summary = await runner.run('a@x.com');
    expect(summary).toMatchObject({ found: 1, skipped: 1 });
    expect(parts.submitter.submitAll.mock.calls[0][0].map((p) => p.id)).toEqual(['2']);
  });

  it('still answers the requests when no sheet link is saved', async () => {
    const { runner, parts } = setup({ templates: { spreadsheetId: vi.fn(async () => null) } });
    const summary = await runner.run('a@x.com');
    expect(parts.sheets.appendRows).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ written: 0, error: 'No Google Sheet link saved.' });
    expect(parts.submitter.submitAll).toHaveBeenCalled();
  });

  it('still answers the requests when the sheet cannot be written', async () => {
    const { runner, parts } = setup({
      sheets: {
        appendRows: vi.fn(async () => {
          throw new SheetsError('Could not write to the Google Sheet: no access', 403);
        }),
      },
    });
    const summary = await runner.run('a@x.com');
    expect(summary.error).toContain('no access');
    expect(summary.written).toBe(0);
    expect(parts.submitter.submitAll).toHaveBeenCalled();
  });

  it('still writes the rows when answering fails', async () => {
    const { runner, parts } = setup({
      submitter: {
        submitAll: vi.fn(async () => {
          throw new Error('browser crashed');
        }),
      },
    });
    const summary = await runner.run('a@x.com');
    expect(summary).toMatchObject({ written: 2, error: 'browser crashed', results: [] });
    expect(parts.sheets.appendRows).toHaveBeenCalled();
  });

  it('does not start a second run for an account that is already running', async () => {
    let release;
    const { runner, parts } = setup({
      watcher: { fetchProjects: vi.fn(() => new Promise((resolve) => (release = resolve))) },
    });
    const first = runner.run('a@x.com');
    expect(runner.isRunning('a@x.com')).toBe(true);
    expect(await runner.run('a@x.com')).toEqual({ skipped: true, reason: 'already running' });
    expect(parts.watcher.fetchProjects).toHaveBeenCalledTimes(1);
    release(response());
    await first;
    expect(runner.isRunning('a@x.com')).toBe(false);
  });

  it('can run again after a failure', async () => {
    const fetchProjects = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(response());
    const { runner } = setup({ watcher: { fetchProjects } });
    await expect(runner.run('a@x.com')).rejects.toThrow('offline');
    expect(runner.isRunning('a@x.com')).toBe(false);
    expect(await runner.run('a@x.com')).toMatchObject({ found: 0 });
  });

  it('runs different accounts side by side', async () => {
    const { runner } = setup();
    const results = await Promise.all([runner.run('a@x.com'), runner.run('b@x.com')]);
    expect(results.every((r) => r.found === 2)).toBe(true);
  });
});
