import path from 'node:path';

import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  screen,
  session,
  WebContentsView,
} from 'electron';
import { chromium } from 'playwright';

import { createAccounts } from './accounts.js';
import { createHandlers, createTrustCheck, registerIpc } from './ipc.js';
import { createLogin } from './linkedin/login.js';
import { createRequestWatcher } from './linkedin/requests.js';
import { createSubmitter } from './linkedin/submit.js';
import { partitionOf } from './linkedin/login.js';
import { log } from './log.js';
import { userDataDir } from './paths.js';
import { createRunner } from './runner.js';
import { createScheduleStore, createScheduler, normalizeSchedule } from './schedules.js';
import { createSheets, resolveCredentialsPath } from './sheets.js';
import { createTemplates } from './templates.js';
import { MIN_BROWSER, usableSize } from './window.js';

// Same data folder as the old app (and UPMF_USER_DATA for a test or a second profile).
app.setPath('userData', userDataDir({ appData: app.getPath('appData') }));

const root = path.resolve(import.meta.dirname, '..', '..');
const rendererDir = path.join(root, 'src', 'renderer');
const preloadDir = path.join(root, 'src', 'preload');
const webPreferences = (preload) => ({
  preload,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
});

// LinkedIn pages and the app's own pages never get camera, location, notifications and the like.
app.on('session-created', (created) =>
  created.setPermissionRequestHandler((_contents, _permission, allow) => allow(false)),
);

if (!app.requestSingleInstanceLock()) {
  app.quit(); // a second copy would write the same files
} else {
  start();
}

function start() {
  let mainWindow = null;
  let scheduleWindow = null;

  const notify = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  function createWindow() {
    const { width, height } = usableSize(screen.getPrimaryDisplay().workAreaSize);
    mainWindow = new BrowserWindow({
      width,
      height,
      minWidth: 800,
      minHeight: 600,
      webPreferences: webPreferences(path.join(preloadDir, 'index.cjs')),
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) event.preventDefault();
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    mainWindow.loadFile(path.join(rendererDir, 'index.html'));
    return mainWindow;
  }

  app.whenReady().then(async () => {
    const dir = app.getPath('userData');
    const accounts = createAccounts({ dir, safeStorage });
    const migration = await accounts.migrateLegacyPasswords();
    if (migration.migrated)
      log.info(`Moved ${migration.migrated} saved password(s) into encrypted storage.`);

    const templates = createTemplates({ dir });
    const scheduleStore = createScheduleStore({ dir });
    const sheets = createSheets({ credentialsPath: resolveCredentialsPath({ dir }) });
    const workArea = usableSize(screen.getPrimaryDisplay().workAreaSize, MIN_BROWSER);
    const submitter = createSubmitter({ chromium, templates, viewport: workArea });
    const watcher = createRequestWatcher({
      BrowserWindow,
      session,
      getParent: () => mainWindow,
      accounts,
    });
    const runner = createRunner({
      watcher,
      templates,
      sheets,
      submitter,
      notify,
      getCookies: (username) => session.fromPartition(partitionOf(username)).cookies.get({}),
    });
    const scheduler = createScheduler({ run: (username) => runner.run(username) });

    const loginBounds = () => {
      const [width, height] = mainWindow.getContentSize();
      const top = Math.round(height / 3);
      return { x: 0, y: top, width, height: height - top };
    };
    const login = createLogin({
      WebContentsView,
      getWindow: () => mainWindow,
      accounts,
      onAccountAdded: () => notify('accounts:changed'),
      getBounds: loginBounds,
      log,
    });

    const closeScheduleDialog = () => {
      if (scheduleWindow && !scheduleWindow.isDestroyed()) scheduleWindow.close();
      scheduleWindow = null;
    };
    const openScheduleDialog = (username) => {
      closeScheduleDialog();
      scheduleWindow = new BrowserWindow({
        parent: mainWindow,
        modal: true,
        show: false,
        width: 520,
        height: 720,
        minWidth: 480,
        minHeight: 720,
        webPreferences: webPreferences(path.join(preloadDir, 'schedule.cjs')),
      });
      scheduleWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      scheduleWindow.loadFile(path.join(rendererDir, 'schedule.html'), { query: { u: username } });
      scheduleWindow.once('ready-to-show', () => scheduleWindow.show());
      scheduleWindow.on('closed', () => {
        scheduleWindow = null;
      });
    };

    const clearSession = async (username) => {
      const stored = session.fromPartition(partitionOf(username));
      await stored.clearStorageData();
      await stored.clearCache();
    };

    registerIpc({
      ipcMain,
      isTrusted: createTrustCheck(rendererDir),
      handlers: createHandlers({
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
      }),
    });

    // Schedules saved earlier start again with the app.
    for (const [username, saved] of Object.entries(await scheduleStore.all())) {
      try {
        if (await accounts.exists(username)) scheduler.set(username, normalizeSchedule(saved));
      } catch (error) {
        log.warn(`Ignoring the saved schedule of ${username}: ${error.message}`);
      }
    }

    createWindow().on('resize', () => login.relayout());
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0)
        createWindow().on('resize', () => login.relayout());
    });
    app.on('window-all-closed', () => {
      scheduler.cancelAll();
      if (process.platform !== 'darwin') app.quit();
    });
  });
}
