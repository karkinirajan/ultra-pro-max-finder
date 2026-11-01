import { log } from '../log.js';
import { partitionOf, relogScript } from './login.js';

export const REQUESTS_PAGE = 'https://www.linkedin.com/service-marketplace/provider/requests';
export const PROJECTS_XHR =
  'https://www.linkedin.com/*queryId=voyagerMarketplacesDashMarketplaceProjects.*';
// The request headers LinkedIn's own page sends and the app copies when it asks again for the data.
const COPIED = [
  'accept',
  'accept-language',
  'csrf-token',
  'x-li-lang',
  'x-li-page-instance',
  'x-li-pem-metadata',
];

export function pickHeaders(requestHeaders) {
  const lower = Object.fromEntries(
    Object.entries(requestHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return Object.fromEntries(
    COPIED.filter((name) => lower[name] !== undefined).map((n) => [n, lower[n]]),
  );
}

/**
 * Opens the ProFinder requests page with the account's saved session and returns the JSON the page
 * itself loads for the list of projects (or null if it never does).
 *
 * The listener is installed *before* the page loads. The old code waited ten seconds, closed the
 * window and only then installed it, so the first run found nothing. The page's own request is let
 * through immediately instead of being held back while the data was processed.
 */
export function createRequestWatcher({
  BrowserWindow,
  session,
  getParent,
  accounts,
  timeoutMs = 45000,
}) {
  async function fetchProjects(username) {
    const partition = partitionOf(username);
    const ses = session.fromPartition(partition);
    const window = new BrowserWindow({
      parent: getParent(),
      modal: true,
      show: false,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const { webContents } = window;

    let relogged = false;
    webContents.on('did-redirect-navigation', async (_event, url) => {
      if (relogged || !url.includes('login?session_redirect')) return;
      relogged = true;
      const password = await accounts.getPassword(username);
      if (!password) {
        log.warn(
          `${username}: the LinkedIn session expired and no password is stored; sign in again.`,
        );
        return;
      }
      await webContents.executeJavaScript(relogScript(password)).catch(() => {});
    });
    window.once('ready-to-show', () => window.show());

    let timer;
    const body = await new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      ses.webRequest.onBeforeSendHeaders(
        { urls: [PROJECTS_XHR], types: ['xhr'] },
        (details, callback) => {
          callback({ cancel: false, requestHeaders: details.requestHeaders });
          ses.webRequest.onBeforeSendHeaders(null); // the first matching request is the one needed
          ses
            .fetch(details.url, { headers: pickHeaders(details.requestHeaders) })
            .then((response) => (response.ok ? response.json() : null))
            .then(resolve, (error) => {
              log.warn(`${username}: could not read the project list:`, error.message);
              resolve(null);
            });
        },
      );
      window.loadURL(REQUESTS_PAGE).catch((error) => {
        log.warn(`${username}: could not open the requests page:`, error.message);
        resolve(null);
      });
    });
    clearTimeout(timer);
    ses.webRequest.onBeforeSendHeaders(null);
    if (!window.isDestroyed()) window.close();
    return body;
  }

  return { fetchProjects };
}
