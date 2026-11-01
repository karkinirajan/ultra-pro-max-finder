import path from 'node:path';

/**
 * The old package was called "profinder", and Electron names the data folder after the package, so
 * every existing user's accounts, templates and schedules are in .../profinder. The package is now
 * called differently; the data folder must not follow, or the app would start empty.
 */
export const DATA_FOLDER = 'profinder';

export function userDataDir({ appData, env = process.env }) {
  return env.UPMF_USER_DATA ? path.resolve(env.UPMF_USER_DATA) : path.join(appData, DATA_FOLDER);
}
