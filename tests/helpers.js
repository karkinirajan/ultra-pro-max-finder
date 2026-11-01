import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const made = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tmpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'upmf-'));
  made.push(dir);
  return dir;
}

/** A reversible stand-in for Electron's safeStorage. The "ciphertext" is visibly not the plain text. */
export function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`enc:${text.split('').reverse().join('')}`),
    decryptString: (buffer) => {
      const text = buffer.toString();
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this key');
      return text.slice(4).split('').reverse().join('');
    },
  };
}

/** A clock and timers that only move when the test says so. */
export function fakeClock(start = new Date('2026-11-01T10:00:00')) {
  let current = start.getTime();
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => new Date(current),
    setTimer: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, at: current + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    /** Moves time forward, running every timer that falls due on the way, in order. */
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        current = due[1].at;
        due[1].fn();
      }
      current = target;
    },
  };
}
