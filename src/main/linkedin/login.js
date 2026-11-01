/** Script that fills in and submits LinkedIn's sign-in form. */
export function fillLoginScript({ username, password }) {
  // JSON.stringify yields a valid JavaScript string literal, so a quote, backtick or "${" in a password
  // cannot break out of it (the old code pasted the password between double quotes).
  const u = JSON.stringify(String(username ?? ''));
  const p = JSON.stringify(String(password ?? ''));
  return `(() => {
    const user = document.querySelector('input[autocomplete="username"]');
    const pass = document.querySelector('input[autocomplete="current-password"]');
    const submit = document.querySelector('button[data-id="sign-in-form__submit-btn"]');
    if (user) user.value = ${u};
    if (pass) pass.value = ${p};
    if (user && pass && submit) { submit.click(); return true; }
    return false;
  })()`;
}

/** Same for the "session expired" sign-in page that a request can be redirected to. */
export function relogScript(password) {
  const p = JSON.stringify(String(password ?? ''));
  return `(() => {
    const link = document.querySelector('.main__sign-in-container a[data-tracking-control-name="cold_join_sign_in"]');
    if (link) link.click();
    return new Promise((resolve) => setTimeout(() => {
      const field = document.querySelector('#password');
      if (field) field.value = ${p};
      const button = document.querySelector('button[type=submit]');
      if (button) button.click();
      resolve(Boolean(field && button));
    }, 1000));
  })()`;
}

export const partitionOf = (username) => `persist:${username}`;

const isLinkedIn = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === 'https:' && (hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com'))
    );
  } catch {
    return false;
  }
};

/**
 * Shows LinkedIn's sign-in page inside the app, fills it in and, once LinkedIn reports a signed-in
 * session, saves the account. Nothing from LinkedIn gets Node.js: the view is sandboxed, which the old
 * code (nodeIntegration on a remote site) was not.
 */
export function createLogin({
  WebContentsView,
  getWindow,
  accounts,
  onAccountAdded,
  getBounds,
  log,
}) {
  const open = new Map();

  function close(username) {
    const view = open.get(username);
    if (!view) return;
    open.delete(username);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    view.webContents.close();
  }

  async function start(username, password) {
    close(username);
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionOf(username),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    open.set(username, view);
    getWindow().contentView.addChildView(view);
    view.setBounds(getBounds());
    const { webContents } = view;

    let saved = false;
    const tryFill = async () => {
      if (!isLinkedIn(webContents.getURL())) return;
      await webContents.executeJavaScript(fillLoginScript({ username, password })).catch(() => {});
    };
    webContents.on('did-finish-load', tryFill);
    // Navigation events can arrive back to back during a sign-in redirect. Nothing awaits between the
    // check of `saved` after the page answers and setting it, so only one of them saves the account.
    const checkSignedIn = async () => {
      if (saved || !isLinkedIn(webContents.getURL())) return;
      const signedIn = await webContents
        .executeJavaScript("localStorage.getItem('C_C_M') !== null")
        .catch(() => false);
      if (!signedIn || saved) return;
      saved = true;
      await accounts.add(username, password);
      onAccountAdded(username);
      setTimeout(() => close(username), 10000); // lets the page finish settling, as before
    };
    webContents.on('did-navigate', () => {
      checkSignedIn().catch((error) => log.warn('Sign-in check failed:', error.message));
    });
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await webContents.loadURL('https://www.linkedin.com/login');
    } catch (error) {
      log.warn('Could not load the LinkedIn sign-in page:', error.message);
    }
  }

  /** Keeps the open sign-in views the right size when the window changes. */
  function relayout() {
    for (const view of open.values()) view.setBounds(getBounds());
  }

  return { start, close, relayout };
}
