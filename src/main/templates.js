import path from 'node:path';

import { createMutex, readJson, readText, writeAtomic, writeJson } from './files.js';
import { spreadsheetIdFromUrl } from './validate.js';

const FIRST_NAME = /<first_name>|\(first_name\)/g;

/** Replaces the two placeholder spellings the old app accepted with the client's first name. */
export function fillFirstName(text, fullName) {
  const first =
    String(fullName ?? '')
      .trim()
      .split(/\s+/)[0] || String(fullName ?? '');
  return text.replace(FIRST_NAME, () => first);
}

const normalizeNewlines = (text) => text.replace(/\r\n?/g, '\n');

/**
 * What the user saves in the app: proposal templates (one per job type), the follow-up message and the
 * link to the Google Sheet. The files keep the names and formats they had (template.json,
 * messageTemplate.txt, excelUrl.txt), so existing data is picked up as it is.
 */
export function createTemplates({ dir }) {
  const proposalFile = path.join(dir, 'template.json');
  const messageFile = path.join(dir, 'messageTemplate.txt');
  const sheetFile = path.join(dir, 'excelUrl.txt');
  const exclusive = createMutex();

  const proposals = () => readJson(proposalFile, {});

  async function saveProposal(title, text) {
    const key = String(title ?? '')
      .trim()
      .toLowerCase();
    if (!key) throw new Error('A template needs a title.');
    return exclusive(async () => {
      const all = await proposals();
      all[key] = normalizeNewlines(text);
      await writeJson(proposalFile, all);
    });
  }

  function deleteProposal(title) {
    const key = String(title ?? '')
      .trim()
      .toLowerCase();
    return exclusive(async () => {
      const all = await proposals();
      delete all[key];
      await writeJson(proposalFile, all);
    });
  }

  /**
   * The text for a job type. The old code fell back to a file called "default" that never existed, so a
   * job type without its own template crashed; the fallback is now a template titled "default".
   */
  async function proposalFor(jobType) {
    const all = await proposals();
    return all[String(jobType ?? '').toLowerCase()] ?? all.default ?? null;
  }

  async function message() {
    return readText(messageFile, '');
  }

  function saveMessage(text) {
    return exclusive(() => writeAtomic(messageFile, normalizeNewlines(text)));
  }

  async function sheetUrl() {
    return (await readText(sheetFile, '')).trim();
  }

  async function saveSheetUrl(url) {
    const clean = String(url ?? '').trim();
    if (clean && !spreadsheetIdFromUrl(clean)) {
      throw new Error(
        'That is not a Google Sheets link (https://docs.google.com/spreadsheets/d/...).',
      );
    }
    await exclusive(() => writeAtomic(sheetFile, clean));
  }

  async function spreadsheetId() {
    return spreadsheetIdFromUrl(await sheetUrl());
  }

  return {
    proposals,
    saveProposal,
    deleteProposal,
    proposalFor,
    message,
    saveMessage,
    sheetUrl,
    saveSheetUrl,
    spreadsheetId,
  };
}
