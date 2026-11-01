import { log } from './log.js';
import { describeAll } from './linkedin/projects.js';
import { SheetsError } from './sheets.js';

/**
 * One cycle for one account: fetch the open requests, write them to the Google Sheet and answer them.
 * The two halves run side by side and fail independently, as they did before.
 */
export function createRunner({ watcher, templates, sheets, submitter, getCookies, notify }) {
  const running = new Set();

  async function writeRows(username, projects) {
    const spreadsheetId = await templates.spreadsheetId();
    if (!spreadsheetId) {
      log.warn(`${username}: no Google Sheet link saved, so the requests are not recorded.`);
      return { written: 0, error: 'No Google Sheet link saved.' };
    }
    try {
      const written = await sheets.appendRows(
        spreadsheetId,
        username,
        projects.map((project) => project.row),
      );
      return { written };
    } catch (error) {
      log.error(`${username}: ${error.message}`);
      return { written: 0, error: error instanceof SheetsError ? error.message : String(error) };
    }
  }

  async function answer(username, projects) {
    try {
      return { results: await submitter.submitAll(projects, await getCookies(username)) };
    } catch (error) {
      log.error(`${username}: could not answer the requests:`, error.message);
      return { results: [], error: error.message };
    }
  }

  async function run(username) {
    if (running.has(username)) return { skipped: true, reason: 'already running' };
    running.add(username);
    try {
      const body = await watcher.fetchProjects(username);
      if (!body) return { found: 0, reason: 'LinkedIn did not return the request list' };
      const { projects, skipped } = describeAll(body);
      if (skipped)
        log.warn(`${username}: ${skipped} request(s) had an unexpected shape and were skipped.`);
      notify?.('run:found', username);
      if (projects.length === 0) return { found: 0, skipped };
      const [sheet, outcome] = await Promise.all([
        writeRows(username, projects),
        answer(username, projects),
      ]);
      notify?.('run:done', username);
      return { found: projects.length, skipped, ...sheet, ...outcome };
    } finally {
      running.delete(username);
    }
  }

  return { run, isRunning: (username) => running.has(username) };
}
