import path from 'node:path';
import { existsSync } from 'node:fs';

import { GoogleAuth } from 'google-auth-library';
import { sheets as sheetsClient } from '@googleapis/sheets';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export class SheetsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SheetsError';
    this.status = status;
  }
}

/** A1 notation needs a quoted tab name once it holds anything but letters, digits and underscores
 * (an e-mail address as a tab name does). */
export function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

/**
 * Where the Google service-account key is read from: ``GOOGLE_APPLICATION_CREDENTIALS``, else
 * ``google-credentials.json`` in the app's data folder. It used to be ``credentials.json`` inside the
 * source tree, committed to git.
 */
export function resolveCredentialsPath({ env = process.env, dir, exists = existsSync }) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  const candidate = path.join(dir, 'google-credentials.json');
  return exists(candidate) ? candidate : null;
}

function wrap(error, what) {
  const status = error?.response?.status ?? error?.status ?? error?.code;
  const code = typeof status === 'number' ? status : undefined;
  return new SheetsError(`${what}: ${error?.message ?? error}`, code);
}

/**
 * The few Google Sheets operations the app needs. ``client`` is a Sheets v4 client; it is created on
 * first use from the service-account key, so the app starts (and its other features work) without one.
 */
export function createSheets({ credentialsPath, client = null }) {
  let cached = client;
  function api() {
    if (cached) return cached;
    if (!credentialsPath) {
      throw new SheetsError(
        'No Google credentials: set GOOGLE_APPLICATION_CREDENTIALS or put google-credentials.json in the app data folder.',
      );
    }
    const auth = new GoogleAuth({ keyFile: credentialsPath, scopes: [SCOPE] });
    cached = sheetsClient({ version: 'v4', auth });
    return cached;
  }

  async function ensureTab(spreadsheetId, title) {
    const { spreadsheets } = api();
    const info = await spreadsheets.get({ spreadsheetId });
    const exists = (info.data.sheets ?? []).some((sheet) => sheet.properties?.title === title);
    if (!exists) {
      await spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      });
    }
  }

  /** Appends objects as rows under the header of the tab (written first when the tab is empty). */
  async function appendRows(spreadsheetId, tab, rows) {
    if (rows.length === 0) return 0;
    const header = Object.keys(rows[0]);
    const range = quoteSheetName(tab);
    try {
      await ensureTab(spreadsheetId, tab);
      const { values } = api().spreadsheets;
      const first = await values.get({
        spreadsheetId,
        range: `${range}!A1:A1`,
      });
      if (!first.data.values?.length) {
        await values.update({
          spreadsheetId,
          range: `${range}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [header] },
        });
      }
      await values.append({
        spreadsheetId,
        range: `${range}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: rows.map((row) => header.map((key) => row[key] ?? '')),
        },
      });
      return rows.length;
    } catch (error) {
      if (error instanceof SheetsError) throw error;
      throw wrap(error, 'Could not write to the Google Sheet');
    }
  }

  /** The tab as objects keyed by its first row. A missing tab or no access throws a SheetsError with the HTTP status. */
  async function readRows(spreadsheetId, tab) {
    try {
      const response = await api().spreadsheets.values.get({
        spreadsheetId,
        range: quoteSheetName(tab),
      });
      const [headers = [], ...body] = response.data.values ?? [];
      return body.map((row) =>
        Object.fromEntries(headers.map((name, index) => [name, row[index] ?? ''])),
      );
    } catch (error) {
      if (error instanceof SheetsError) throw error;
      throw wrap(error, 'Could not read the Google Sheet');
    }
  }

  return { appendRows, readRows };
}
