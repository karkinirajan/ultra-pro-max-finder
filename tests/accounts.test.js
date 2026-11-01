import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAccounts } from '../src/main/accounts.js';
import { fakeSafeStorage, tmpDir } from './helpers.js';

async function setup(options) {
  const dir = await tmpDir();
  return { dir, accounts: createAccounts({ dir, safeStorage: fakeSafeStorage(options) }) };
}

describe('accounts', () => {
  it('lists, adds and removes accounts', async () => {
    const { accounts } = await setup();
    expect(await accounts.list()).toEqual([]);
    await accounts.add('a@example.com', 'pw-a');
    await accounts.add('b@example.com', 'pw-b');
    expect(await accounts.list()).toEqual([
      { username: 'a@example.com' },
      { username: 'b@example.com' },
    ]);
    await accounts.remove('a@example.com');
    expect(await accounts.list()).toEqual([{ username: 'b@example.com' }]);
  });

  it('keeps the other accounts when one is added (the old save overwrote the file once per account)', async () => {
    const { accounts } = await setup();
    for (const name of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']) await accounts.add(name, 'pw');
    expect((await accounts.list()).map((a) => a.username)).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
  });

  it('adding an existing account replaces it instead of duplicating it', async () => {
    const { accounts } = await setup();
    await accounts.add('a@x.com', 'old');
    await accounts.add('a@x.com', 'new');
    expect(await accounts.list()).toHaveLength(1);
    expect(await accounts.getPassword('a@x.com')).toBe('new');
  });

  it('gives each account its own password (the old lookup assigned instead of comparing, so everyone got the first)', async () => {
    const { accounts } = await setup();
    await accounts.add('first@x.com', 'pw-first');
    await accounts.add('second@x.com', 'pw-second');
    expect(await accounts.getPassword('second@x.com')).toBe('pw-second');
    expect(await accounts.getPassword('first@x.com')).toBe('pw-first');
    expect(await accounts.getPassword('nobody@x.com')).toBeNull();
  });

  it('never writes a password to disk in plain text', async () => {
    const { dir, accounts } = await setup();
    await accounts.add('a@x.com', 'S3cret-Pa55');
    for (const name of await fs.readdir(dir)) {
      expect(await fs.readFile(path.join(dir, name), 'utf8')).not.toContain('S3cret-Pa55');
    }
    const vault = JSON.parse(await fs.readFile(path.join(dir, 'credentials.vault.json'), 'utf8'));
    expect(Buffer.from(vault['a@x.com'], 'base64').toString()).toMatch(/^enc:/); // ciphertext, not the password
  });

  it('stores no password at all when the system cannot encrypt, and the account still works', async () => {
    const { dir, accounts } = await setup({ available: false });
    expect(await accounts.add('a@x.com', 'S3cret-Pa55')).toBe(false);
    expect(await accounts.list()).toEqual([{ username: 'a@x.com' }]);
    expect(await accounts.getPassword('a@x.com')).toBeNull();
    expect(await accounts.canEncrypt()).toBe(false);
    expect(await fs.readFile(path.join(dir, 'credentials.vault.json'), 'utf8')).not.toContain(
      'S3cret',
    );
  });

  it('removes the password with the account', async () => {
    const { accounts } = await setup();
    await accounts.add('a@x.com', 'pw');
    await accounts.remove('a@x.com');
    expect(await accounts.getPassword('a@x.com')).toBeNull();
  });

  it('rejects names that are not a login', async () => {
    const { accounts } = await setup();
    await expect(accounts.add('../../evil', 'pw')).rejects.toThrow('Invalid account name.');
    await expect(accounts.remove('a b')).rejects.toThrow('Invalid account name.');
    await expect(accounts.getPassword('<x>')).rejects.toThrow('Invalid account name.');
  });

  it('survives a password that cannot be decrypted', async () => {
    const { dir, accounts } = await setup();
    await accounts.add('a@x.com', 'pw');
    await fs.writeFile(
      path.join(dir, 'credentials.vault.json'),
      JSON.stringify({ 'a@x.com': 'AAAA' }),
    );
    expect(await accounts.getPassword('a@x.com')).toBeNull();
  });

  it('ignores corrupted entries in the account list', async () => {
    const { dir, accounts } = await setup();
    await fs.writeFile(
      path.join(dir, 'userInfo.json'),
      '{"username":"good@x.com","isScheduled":true}\n{"username":"../bad"}\n{"nope":1}\n',
    );
    expect(await accounts.list()).toEqual([{ username: 'good@x.com' }]);
  });

  it('answers whether an account exists', async () => {
    const { accounts } = await setup();
    await accounts.add('a@x.com', 'pw');
    expect(await accounts.exists('a@x.com')).toBe(true);
    expect(await accounts.exists('b@x.com')).toBe(false);
  });

  describe('moving the old plain-text pass.json into the vault', () => {
    const legacy =
      '{"username":"a@x.com","password":"pw-a"}\n{"username":"b@x.com","password":"pw-b"}\n{"username":"../bad","password":"x"}\n';

    it('encrypts the passwords, deletes the plain-text file and loses nothing else', async () => {
      const { dir, accounts } = await setup();
      await fs.writeFile(path.join(dir, 'pass.json'), legacy);
      expect(await accounts.migrateLegacyPasswords()).toEqual({ migrated: 2, pending: 0 });
      await expect(fs.stat(path.join(dir, 'pass.json'))).rejects.toThrow();
      expect(await accounts.getPassword('b@x.com')).toBe('pw-b');
      expect(await fs.readFile(path.join(dir, 'credentials.vault.json'), 'utf8')).not.toContain(
        'pw-a',
      );
    });

    it('leaves the file untouched when it cannot encrypt yet (nothing is lost)', async () => {
      const { dir, accounts } = await setup({ available: false });
      await fs.writeFile(path.join(dir, 'pass.json'), legacy);
      expect(await accounts.migrateLegacyPasswords()).toEqual({ migrated: 0, pending: 3 });
      expect(await fs.readFile(path.join(dir, 'pass.json'), 'utf8')).toBe(legacy);
    });

    it('does nothing when there is no old file, or it is empty (the old app created an empty one)', async () => {
      const { dir, accounts } = await setup();
      expect(await accounts.migrateLegacyPasswords()).toEqual({ migrated: 0, pending: 0 });
      await fs.writeFile(path.join(dir, 'pass.json'), '');
      expect(await accounts.migrateLegacyPasswords()).toEqual({ migrated: 0, pending: 0 });
    });

    it('does not touch a pass.json it cannot read', async () => {
      const { dir, accounts } = await setup();
      await fs.writeFile(path.join(dir, 'pass.json'), '{ broken');
      expect(await accounts.migrateLegacyPasswords()).toEqual({ migrated: 0, pending: 0 });
      expect(await fs.readFile(path.join(dir, 'pass.json'), 'utf8')).toBe('{ broken');
    });
  });
});
