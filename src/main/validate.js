/** Input checks for everything that arrives over IPC or from the user. */

// A LinkedIn login is an e-mail address or a phone number. It becomes a session partition name and a
// Google Sheet tab (100 characters at most), so only plain characters are accepted: the old code
// used it, unchecked, in file paths.
const USERNAME = /^[A-Za-z0-9._%+@-]{1,100}$/;

export function isUsername(value) {
  return typeof value === 'string' && USERNAME.test(value);
}

export function assertUsername(value) {
  if (!isUsername(value)) throw new Error('Invalid account name.');
  return value;
}

export function assertText(value, { max = 20000, name = 'Text' } = {}) {
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  if (value.length > max) throw new Error(`${name} is too long.`);
  return value;
}

const SPREADSHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/;

export function spreadsheetIdFromUrl(url) {
  const match = typeof url === 'string' ? SPREADSHEET_URL.exec(url.trim()) : null;
  return match ? match[1] : null;
}
