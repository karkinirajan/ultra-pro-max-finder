import { describe, expect, it } from 'vitest';

import {
  createSheets,
  quoteSheetName,
  resolveCredentialsPath,
  SheetsError,
} from '../src/main/sheets.js';

function fakeClient({ tabs = [], cells = {}, fail = {} } = {}) {
  const calls = [];
  const maybeFail = (name) => {
    if (fail[name])
      throw Object.assign(new Error(fail[name].message), {
        response: { status: fail[name].status },
      });
  };
  return {
    calls,
    spreadsheets: {
      get: async (request) => {
        maybeFail('get');
        calls.push(['get', request]);
        return { data: { sheets: tabs.map((title) => ({ properties: { title } })) } };
      },
      batchUpdate: async (request) => {
        calls.push(['batchUpdate', request]);
        tabs.push(request.requestBody.requests[0].addSheet.properties.title);
      },
      values: {
        get: async (request) => {
          maybeFail('values.get');
          calls.push(['values.get', request]);
          return { data: { values: cells[request.range] } };
        },
        update: async (request) => calls.push(['values.update', request]),
        append: async (request) => {
          maybeFail('values.append');
          calls.push(['values.append', request]);
        },
      },
    },
  };
}

const callsNamed = (client, name) => client.calls.filter(([n]) => n === name).map(([, r]) => r);

describe('quoteSheetName', () => {
  it.each([
    ['Sheet1', "'Sheet1'"],
    ['jane.doe@example.com', "'jane.doe@example.com'"],
    ["O'Brien", "'O''Brien'"],
  ])('%s -> %s', (name, quoted) => expect(quoteSheetName(name)).toBe(quoted));
});

describe('resolveCredentialsPath', () => {
  it('prefers GOOGLE_APPLICATION_CREDENTIALS', () => {
    expect(
      resolveCredentialsPath({
        env: { GOOGLE_APPLICATION_CREDENTIALS: '/keys/k.json' },
        dir: '/data',
        exists: () => true,
      }),
    ).toBe('/keys/k.json');
  });
  it('then google-credentials.json in the data folder, if it exists', () => {
    expect(resolveCredentialsPath({ env: {}, dir: '/data', exists: () => true })).toBe(
      '/data/google-credentials.json',
    );
    expect(resolveCredentialsPath({ env: {}, dir: '/data', exists: () => false })).toBeNull();
  });
});

describe('appendRows', () => {
  it('creates a missing tab, writes the header when the tab is empty, then appends the rows', async () => {
    const client = fakeClient();
    const sheets = createSheets({ client });
    const count = await sheets.appendRows('SHEET', 'jane@example.com', [
      { A: '1', B: '2' },
      { B: 'only-b', A: 'only-a' },
    ]);
    expect(count).toBe(2);
    expect(
      callsNamed(client, 'batchUpdate')[0].requestBody.requests[0].addSheet.properties.title,
    ).toBe('jane@example.com');
    expect(callsNamed(client, 'values.update')[0]).toMatchObject({
      range: "'jane@example.com'!A1",
      requestBody: { values: [['A', 'B']] },
    });
    expect(callsNamed(client, 'values.append')[0]).toMatchObject({
      range: "'jane@example.com'!A1",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [
          ['1', '2'],
          ['only-a', 'only-b'],
        ],
      }, // follows the header, not each row's key order
    });
  });

  it('does not touch an existing tab or its header', async () => {
    const client = fakeClient({ tabs: ['t'], cells: { "'t'!A1:A1": [['A']] } });
    await createSheets({ client }).appendRows('S', 't', [{ A: 'x' }]);
    expect(callsNamed(client, 'batchUpdate')).toEqual([]);
    expect(callsNamed(client, 'values.update')).toEqual([]);
    expect(callsNamed(client, 'values.append')).toHaveLength(1);
  });

  it('fills a missing value with an empty cell', async () => {
    const client = fakeClient({ tabs: ['t'], cells: { "'t'!A1:A1": [['A']] } });
    await createSheets({ client }).appendRows('S', 't', [{ A: 'x', B: 'y' }, { A: 'z' }]);
    expect(callsNamed(client, 'values.append')[0].requestBody.values).toEqual([
      ['x', 'y'],
      ['z', ''],
    ]);
  });

  it('does nothing for no rows', async () => {
    const client = fakeClient();
    expect(await createSheets({ client }).appendRows('S', 't', [])).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it('reports a failure with the HTTP status', async () => {
    const client = fakeClient({
      fail: { get: { status: 403, message: 'The caller does not have permission' } },
    });
    const error = await createSheets({ client })
      .appendRows('S', 't', [{ A: 1 }])
      .catch((e) => e);
    expect(error).toBeInstanceOf(SheetsError);
    expect(error.status).toBe(403);
    expect(error.message).toContain('Could not write to the Google Sheet');
  });
});

describe('readRows', () => {
  it('turns the tab into objects keyed by its first row, padding short rows', async () => {
    const client = fakeClient({ cells: { "'t'": [['A', 'B', 'C'], ['1', '2', '3'], ['4']] } });
    expect(await createSheets({ client }).readRows('S', 't')).toEqual([
      { A: '1', B: '2', C: '3' },
      { A: '4', B: '', C: '' },
    ]);
  });
  it('gives an empty list for an empty tab', async () => {
    expect(await createSheets({ client: fakeClient() }).readRows('S', 't')).toEqual([]);
    expect(
      await createSheets({ client: fakeClient({ cells: { "'t'": [['A']] } }) }).readRows('S', 't'),
    ).toEqual([]);
  });
  it('carries the status of a refused read so the app can say "no permission"', async () => {
    const client = fakeClient({ fail: { 'values.get': { status: 403, message: 'forbidden' } } });
    await expect(createSheets({ client }).readRows('S', 't')).rejects.toMatchObject({
      name: 'SheetsError',
      status: 403,
    });
  });
});

describe('without credentials', () => {
  it('says what to do instead of failing obscurely', async () => {
    const sheets = createSheets({ credentialsPath: null });
    await expect(sheets.readRows('S', 't')).rejects.toThrow('GOOGLE_APPLICATION_CREDENTIALS');
    await expect(sheets.appendRows('S', 't', [{ A: 1 }])).rejects.toThrow(
      'google-credentials.json',
    );
  });
});
