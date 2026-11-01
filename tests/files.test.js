import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createMutex,
  readJson,
  readJsonLines,
  readText,
  removeFile,
  writeAtomic,
  writeJson,
  writeJsonLines,
} from '../src/main/files.js';
import { tmpDir } from './helpers.js';

describe('files', () => {
  it('writes atomically, creates folders, leaves no temp file and keeps the file private', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'a', 'b.txt');
    await writeAtomic(file, 'hello');
    expect(await fs.readFile(file, 'utf8')).toBe('hello');
    expect(await fs.readdir(path.dirname(file))).toEqual(['b.txt']);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('reads a missing file as the fallback', async () => {
    const dir = await tmpDir();
    expect(await readText(path.join(dir, 'none'), 'x')).toBe('x');
    expect(await readJson(path.join(dir, 'none'), { a: 1 })).toEqual({ a: 1 });
    expect(await readJsonLines(path.join(dir, 'none'))).toEqual([]);
  });

  it('treats an empty file (the old app created empty ones) as the fallback', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'e.json'), '  \n');
    expect(await readJson(path.join(dir, 'e.json'), { ok: true })).toEqual({ ok: true });
  });

  it('refuses to read a corrupt JSON file instead of returning the fallback (which would overwrite it)', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'bad.json'), '{ not json');
    await expect(readJson(path.join(dir, 'bad.json'), {})).rejects.toThrow();
  });

  it('round-trips JSON and JSON lines, ignoring blank lines', async () => {
    const dir = await tmpDir();
    await writeJson(path.join(dir, 'x.json'), { a: [1, 2] });
    expect(await readJson(path.join(dir, 'x.json'), null)).toEqual({ a: [1, 2] });
    await writeJsonLines(path.join(dir, 'x.jsonl'), [{ n: 1 }, { n: 2 }]);
    await fs.appendFile(path.join(dir, 'x.jsonl'), '\n\n');
    expect(await readJsonLines(path.join(dir, 'x.jsonl'))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('removes a file and does not mind it being gone', async () => {
    const dir = await tmpDir();
    await writeAtomic(path.join(dir, 'r'), 'x');
    await removeFile(path.join(dir, 'r'));
    await removeFile(path.join(dir, 'r'));
    expect(await readText(path.join(dir, 'r'), 'gone')).toBe('gone');
  });

  it('runs tasks one after another and keeps going after a failure', async () => {
    const exclusive = createMutex();
    const order = [];
    const slow = exclusive(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    const failing = exclusive(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const last = exclusive(async () => order.push('last'));
    await expect(failing).rejects.toThrow('boom');
    await Promise.all([slow, last]);
    expect(order).toEqual(['slow', 'failing', 'last']);
  });
});
