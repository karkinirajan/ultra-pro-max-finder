import path from 'node:path';

import { log } from './log.js';
import {
  createMutex,
  readJson,
  readJsonLines,
  removeFile,
  writeJson,
  writeJsonLines,
} from './files.js';
import { assertUsername, isUsername } from './validate.js';

/**
 * LinkedIn accounts and their passwords.
 *
 * ``userInfo.json`` (one JSON object per line, as before) lists the accounts. Passwords used to sit in
 * plain text in ``pass.json``; they are now encrypted with the operating system's keychain through
 * Electron's ``safeStorage`` and kept in ``credentials.vault.json``. When encryption is not available
 * (a Linux desktop without a keyring) no password is stored at all: the account still works through
 * its saved LinkedIn session, and only an automatic re-login is lost.
 */
export function createAccounts({ dir, safeStorage }) {
  const accountsFile = path.join(dir, 'userInfo.json');
  const vaultFile = path.join(dir, 'credentials.vault.json');
  const legacyFile = path.join(dir, 'pass.json');
  const exclusive = createMutex();

  function canEncrypt() {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  async function list() {
    const entries = await readJsonLines(accountsFile);
    return entries
      .filter((entry) => isUsername(entry?.username))
      .map((entry) => ({ username: entry.username }));
  }

  async function putPassword(vault, username, password) {
    if (password && canEncrypt()) {
      vault[username] = safeStorage.encryptString(password).toString('base64');
      return true;
    }
    delete vault[username];
    return false;
  }

  /** Adds or replaces an account. Returns whether the password could be kept (encrypted). */
  async function add(username, password) {
    assertUsername(username);
    return exclusive(async () => {
      const others = (await list()).filter((account) => account.username !== username);
      await writeJsonLines(accountsFile, [...others, { username }]);
      const vault = await readJson(vaultFile, {});
      const stored = await putPassword(vault, username, password);
      await writeJson(vaultFile, vault);
      return stored;
    });
  }

  async function remove(username) {
    assertUsername(username);
    return exclusive(async () => {
      const kept = (await list()).filter((account) => account.username !== username);
      await writeJsonLines(accountsFile, kept);
      const vault = await readJson(vaultFile, {});
      delete vault[username];
      await writeJson(vaultFile, vault);
    });
  }

  async function exists(username) {
    return (await list()).some((account) => account.username === username);
  }

  /** The stored password of exactly this account, or null. */
  async function getPassword(username) {
    assertUsername(username);
    const vault = await readJson(vaultFile, {});
    const encoded = vault[username];
    if (!encoded || !canEncrypt()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch {
      return null;
    }
  }

  /**
   * Moves the passwords of the old plain-text ``pass.json`` into the vault and deletes that file.
   * If encryption is not available the file is left alone (nothing is lost) and a warning is logged.
   */
  function migrateLegacyPasswords() {
    return exclusive(async () => {
      let entries;
      try {
        entries = await readJsonLines(legacyFile);
      } catch (error) {
        log.warn('Could not read the old pass.json, leaving it as it is:', error.message);
        return { migrated: 0, pending: 0 };
      }
      if (entries.length === 0) return { migrated: 0, pending: 0 };
      if (!canEncrypt()) {
        log.warn(
          'pass.json holds plain-text passwords but encryption is not available; not migrated.',
        );
        return { migrated: 0, pending: entries.length };
      }
      const vault = await readJson(vaultFile, {});
      let migrated = 0;
      for (const entry of entries) {
        if (isUsername(entry?.username) && typeof entry.password === 'string' && entry.password) {
          await putPassword(vault, entry.username, entry.password);
          migrated += 1;
        }
      }
      await writeJson(vaultFile, vault);
      await removeFile(legacyFile);
      return { migrated, pending: 0 };
    });
  }

  return {
    list,
    add,
    remove,
    exists,
    getPassword,
    migrateLegacyPasswords,
    canEncrypt,
  };
}
