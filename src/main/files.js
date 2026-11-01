import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Writes through a temporary file and renames it, so a crash never leaves a half-written file. */
export async function writeAtomic(file, content) {
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, content, { mode: 0o600 });
  await fs.rename(temp, file);
}

export async function readText(file, fallback = '') {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** A missing or empty file gives the fallback; a corrupt one throws, so it is never silently overwritten. */
export async function readJson(file, fallback) {
  const text = (await readText(file, '')).trim();
  return text ? JSON.parse(text) : fallback;
}

export async function writeJson(file, value) {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** One JSON object per line, the format the old app used for userInfo.json. */
export async function readJsonLines(file) {
  const text = await readText(file, '');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export async function writeJsonLines(file, items) {
  await writeAtomic(file, items.map((item) => `${JSON.stringify(item)}\n`).join(''));
}

export async function removeFile(file) {
  await fs.rm(file, { force: true });
}

/** Runs read-modify-write sections one after another (the old code lost accounts when two overlapped). */
export function createMutex() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
