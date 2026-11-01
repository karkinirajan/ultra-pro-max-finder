import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  createRequestWatcher,
  pickHeaders,
  PROJECTS_XHR,
  REQUESTS_PAGE,
} from '../src/main/linkedin/requests.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup({ password = 'S3cret"pw', timeoutMs = 5000, loadFails = false } = {}) {
  const events = [];
  const windows = [];
  const ses = {
    webRequest: {
      onBeforeSendHeaders: vi.fn((...args) =>
        events.push(args[0] === null ? 'listener removed' : 'listener installed'),
      ),
    },
    fetch: vi.fn(),
  };
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.executeJavaScript = vi.fn(async () => true);
      this.destroyed = false;
      this.shown = false;
      windows.push(this);
    }
    loadURL = vi.fn(async (url) => {
      events.push(`loadURL ${url}`);
      if (loadFails) throw new Error('ERR_FAILED');
    });
    show() {
      this.shown = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroyed = true;
      events.push('window closed');
    }
  }
  const accounts = { getPassword: vi.fn(async () => password) };
  const watcher = createRequestWatcher({
    BrowserWindow: FakeWindow,
    session: { fromPartition: vi.fn(() => ses) },
    getParent: () => 'parent-window',
    accounts,
    timeoutMs,
  });
  return { watcher, ses, windows, events, accounts };
}

const details = {
  url: 'https://www.linkedin.com/voyager/api/graphql?queryId=voyagerMarketplacesDashMarketplaceProjects.abc',
  requestHeaders: {
    Accept: 'application/json',
    'Csrf-Token': 'ajax:123',
    'X-Li-Track': '{}',
    Cookie: 'li_at=SECRET',
    'x-li-lang': 'en_US',
  },
};

describe('pickHeaders', () => {
  it('copies only the headers the page needs, with lower-case names, and never cookies or tracking', () => {
    expect(pickHeaders(details.requestHeaders)).toEqual({
      accept: 'application/json',
      'csrf-token': 'ajax:123',
      'x-li-lang': 'en_US',
    });
  });
  it('copes with nothing', () => {
    expect(pickHeaders(undefined)).toEqual({});
  });
});

describe('fetchProjects', () => {
  it('installs the listener before the page loads (the old code did it after closing the window)', async () => {
    const { watcher, ses, events } = setup();
    const result = watcher.fetchProjects('jane@example.com');
    await tick();
    expect(events.slice(0, 2)).toEqual(['listener installed', `loadURL ${REQUESTS_PAGE}`]);
    const [filter, handler] = ses.webRequest.onBeforeSendHeaders.mock.calls[0];
    expect(filter).toEqual({ urls: [PROJECTS_XHR], types: ['xhr'] });
    ses.fetch.mockResolvedValue({ ok: true, json: async () => ({ included: [] }) });
    handler(details, vi.fn());
    expect(await result).toEqual({ included: [] });
  });

  it("lets the page's own request through at once, before the data has been fetched", async () => {
    const { watcher, ses } = setup();
    const result = watcher.fetchProjects('a@x.com');
    await tick();
    let release;
    ses.fetch.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const callback = vi.fn();
    ses.webRequest.onBeforeSendHeaders.mock.calls[0][1](details, callback);
    expect(callback).toHaveBeenCalledWith({
      cancel: false,
      requestHeaders: details.requestHeaders,
    });
    release({ ok: true, json: async () => ({ ok: 1 }) });
    expect(await result).toEqual({ ok: 1 });
  });

  it('asks again with only the copied headers, uses the first request only, then cleans up', async () => {
    const { watcher, ses, events, windows } = setup();
    const result = watcher.fetchProjects('a@x.com');
    await tick();
    ses.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    ses.webRequest.onBeforeSendHeaders.mock.calls[0][1](details, vi.fn());
    await result;
    expect(ses.fetch).toHaveBeenCalledWith(details.url, {
      headers: { accept: 'application/json', 'csrf-token': 'ajax:123', 'x-li-lang': 'en_US' },
    });
    expect(events.at(-1)).toBe('window closed');
    expect(events).toContain('listener removed');
    expect(windows[0].destroyed).toBe(true);
  });

  it("opens a sandboxed modal window in the account's own session and shows it when ready", async () => {
    const { watcher, windows } = setup({ timeoutMs: 10 });
    await watcher.fetchProjects('jane@example.com');
    expect(windows[0].options).toEqual({
      parent: 'parent-window',
      modal: true,
      show: false,
      webPreferences: {
        partition: 'persist:jane@example.com',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows[0].emit('ready-to-show');
    expect(windows[0].shown).toBe(true);
  });

  it.each([
    ['LinkedIn refuses', { ok: false, json: async () => ({}) }],
    [
      'the data cannot be read',
      {
        ok: true,
        json: async () => {
          throw new Error('bad json');
        },
      },
    ],
  ])('gives null when %s', async (_name, response) => {
    const { watcher, ses } = setup();
    const result = watcher.fetchProjects('a@x.com');
    await tick();
    ses.fetch.mockResolvedValue(response);
    ses.webRequest.onBeforeSendHeaders.mock.calls[0][1](details, vi.fn());
    expect(await result).toBeNull();
  });

  it('gives null when the request itself fails', async () => {
    const { watcher, ses } = setup();
    const result = watcher.fetchProjects('a@x.com');
    await tick();
    ses.fetch.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));
    ses.webRequest.onBeforeSendHeaders.mock.calls[0][1](details, vi.fn());
    expect(await result).toBeNull();
  });

  it('gives null and cleans up when the page never asks for the list', async () => {
    const { watcher, events, windows } = setup({ timeoutMs: 20 });
    expect(await watcher.fetchProjects('a@x.com')).toBeNull();
    expect(windows[0].destroyed).toBe(true);
    expect(events).toContain('listener removed');
  });

  it('gives null when the requests page cannot be opened', async () => {
    const { watcher } = setup({ loadFails: true });
    expect(await watcher.fetchProjects('a@x.com')).toBeNull();
  });

  describe('when the saved LinkedIn session has expired', () => {
    async function redirected(setupOptions, urls) {
      const context = setup({ timeoutMs: 30, ...setupOptions });
      const result = context.watcher.fetchProjects('a@x.com');
      await tick();
      for (const url of urls)
        context.windows[0].webContents.emit('did-redirect-navigation', {}, url);
      await tick();
      await result;
      return context;
    }

    it('signs in again with the stored password, once, typed in exactly', async () => {
      const { windows } = await redirected({ password: 'p"w\\`${x}' }, [
        'https://www.linkedin.com/login?session_redirect=x',
        'https://www.linkedin.com/login?session_redirect=y',
      ]);
      const calls = windows[0].webContents.executeJavaScript.mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toContain(JSON.stringify('p"w\\`${x}'));
    });

    it('does nothing when no password is stored', async () => {
      const { windows } = await redirected({ password: null }, [
        'https://www.linkedin.com/login?session_redirect=x',
      ]);
      expect(windows[0].webContents.executeJavaScript).not.toHaveBeenCalled();
    });

    it('ignores other redirects', async () => {
      const { windows, accounts } = await redirected({}, ['https://www.linkedin.com/feed/']);
      expect(accounts.getPassword).not.toHaveBeenCalled();
      expect(windows[0].webContents.executeJavaScript).not.toHaveBeenCalled();
    });
  });
});
