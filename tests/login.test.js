import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLogin,
  fillLoginScript,
  partitionOf,
  relogScript,
} from '../src/main/linkedin/login.js';

/** Runs a generated page script against a fake document and reports what it set. */
function runInFakePage(script, { withButton = true } = {}) {
  const elements = {
    'input[autocomplete="username"]': { value: '' },
    'input[autocomplete="current-password"]': { value: '' },
    'button[data-id="sign-in-form__submit-btn"]': withButton
      ? {
          clicked: 0,
          click() {
            this.clicked += 1;
          },
        }
      : null,
    '#password': { value: '' },
    'button[type=submit]': {
      clicked: 0,
      click() {
        this.clicked += 1;
      },
    },
    '.main__sign-in-container a[data-tracking-control-name="cold_join_sign_in"]': {
      clicked: 0,
      click() {
        this.clicked += 1;
      },
    },
  };
  const document = { querySelector: (selector) => elements[selector] ?? null };
  const result = vm.runInNewContext(script, { document, setTimeout: (fn) => fn(), Promise });
  return { elements, result };
}

const NASTY = [
  'plain',
  'quo"te',
  "apo'strophe",
  'back`tick',
  '${process.exit(1)}',
  '</script><script>alert(1)</script>',
  'back\\slash\\',
  'new\nline',
  '  ',
  '"; document.body.remove(); "',
];

describe('login scripts', () => {
  it.each(NASTY)('fill the form with exactly %j and nothing else', (password) => {
    const { elements, result } = runInFakePage(
      fillLoginScript({ username: 'jane@example.com', password }),
    );
    expect(elements['input[autocomplete="username"]'].value).toBe('jane@example.com');
    expect(elements['input[autocomplete="current-password"]'].value).toBe(password);
    expect(elements['button[data-id="sign-in-form__submit-btn"]'].clicked).toBe(1);
    expect(result).toBe(true);
  });

  it('do nothing on a page without the sign-in form', () => {
    const { result } = runInFakePage(fillLoginScript({ username: 'a', password: 'b' }), {
      withButton: false,
    });
    expect(result).toBe(false);
  });

  it.each(NASTY)('re-login types exactly %j into the password field', async (password) => {
    const { elements, result } = runInFakePage(relogScript(password));
    expect(await result).toBe(true);
    expect(elements['#password'].value).toBe(password);
    expect(elements['button[type=submit]'].clicked).toBe(1);
  });

  it('names the session partition after the account', () => {
    expect(partitionOf('jane@example.com')).toBe('persist:jane@example.com');
  });
});

class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.url = '';
    this.scripts = [];
    this.signedIn = false;
    this.closed = false;
  }
  getURL() {
    return this.url;
  }
  async loadURL(url) {
    this.url = url;
  }
  setWindowOpenHandler(handler) {
    this.openHandler = handler;
  }
  async executeJavaScript(script) {
    this.scripts.push(script);
    if (script.includes('C_C_M')) return this.signedIn;
    return true;
  }
  close() {
    this.closed = true;
  }
}

describe('createLogin', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    const views = [];
    class FakeView {
      constructor(options) {
        this.options = options;
        this.webContents = new FakeContents();
        this.bounds = null;
        views.push(this);
      }
      setBounds(bounds) {
        this.bounds = bounds;
      }
    }
    const children = new Set();
    const window = {
      isDestroyed: () => false,
      contentView: {
        addChildView: (v) => children.add(v),
        removeChildView: (v) => children.delete(v),
      },
    };
    const accounts = { add: vi.fn(async () => true) };
    const onAccountAdded = vi.fn();
    const login = createLogin({
      WebContentsView: FakeView,
      getWindow: () => window,
      accounts,
      onAccountAdded,
      getBounds: () => ({ x: 0, y: 100, width: 800, height: 600 }),
      log: { warn: vi.fn() },
    });
    return { login, views, children, accounts, onAccountAdded };
  }

  it("opens LinkedIn sandboxed, in the account's own session, without Node.js", async () => {
    const { login, views, children } = setup();
    await login.start('jane@example.com', 'pw');
    expect(views[0].options.webPreferences).toEqual({
      partition: 'persist:jane@example.com',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(views[0].webContents.url).toBe('https://www.linkedin.com/login');
    expect(views[0].bounds).toEqual({ x: 0, y: 100, width: 800, height: 600 });
    expect(children.size).toBe(1);
    expect(views[0].webContents.openHandler()).toEqual({ action: 'deny' });
  });

  it('fills the form on LinkedIn pages only, never on another site', async () => {
    const { login, views } = setup();
    await login.start('jane@example.com', 'pw');
    const contents = views[0].webContents;
    contents.emit('did-finish-load');
    await Promise.resolve();
    expect(contents.scripts).toHaveLength(1);
    contents.url = 'https://evil.example/login';
    contents.emit('did-finish-load');
    await Promise.resolve();
    contents.url = 'https://www.linkedin.com.evil.example/login';
    contents.emit('did-finish-load');
    await Promise.resolve();
    expect(contents.scripts).toHaveLength(1);
  });

  it('saves the account only once LinkedIn shows a signed-in session, then closes the view', async () => {
    vi.useFakeTimers();
    const { login, views, children, accounts, onAccountAdded } = setup();
    await login.start('jane@example.com', 'pw');
    const contents = views[0].webContents;
    contents.url = 'https://www.linkedin.com/feed/';
    contents.emit('did-navigate');
    await vi.advanceTimersByTimeAsync(0);
    expect(accounts.add).not.toHaveBeenCalled();
    contents.signedIn = true;
    contents.emit('did-navigate');
    contents.emit('did-navigate');
    await vi.advanceTimersByTimeAsync(0);
    expect(accounts.add).toHaveBeenCalledTimes(1);
    expect(accounts.add).toHaveBeenCalledWith('jane@example.com', 'pw');
    expect(onAccountAdded).toHaveBeenCalledWith('jane@example.com');
    expect(children.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(children.size).toBe(0);
    expect(contents.closed).toBe(true);
  });

  it('replaces a view that is already open for the same account', async () => {
    const { login, views, children } = setup();
    await login.start('a@x.com', 'pw');
    await login.start('a@x.com', 'pw');
    expect(views).toHaveLength(2);
    expect(children.size).toBe(1);
    expect(views[0].webContents.closed).toBe(true);
  });

  it('tolerates a sign-in page that fails to load', async () => {
    const { login, views } = setup();
    const original = FakeContents.prototype.loadURL;
    FakeContents.prototype.loadURL = async () => {
      throw new Error('ERR_INTERNET_DISCONNECTED');
    };
    try {
      await expect(login.start('a@x.com', 'pw')).resolves.toBeUndefined();
    } finally {
      FakeContents.prototype.loadURL = original;
    }
    expect(views).toHaveLength(1);
  });

  it('closing an account that has no view does nothing', () => {
    expect(() => setup().login.close('nobody@x.com')).not.toThrow();
  });
});
