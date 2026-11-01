import path from 'node:path';

import { createMutex, readJson, writeJson } from './files.js';
import { log } from './log.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TIMER = 2 ** 31 - 1; // the longest delay setTimeout accepts (about 24.8 days)
const GRACE_MS = 2 * 60 * 1000; // a schedule whose start has passed first runs two minutes from now

export function normalizeSchedule(input) {
  const { timeValue, startDateValue, endDateValue = '' } = input ?? {};
  const lower = Number(input?.durationMinutesValueLower);
  const higher = Number(input?.durationMinutesValueHigher);
  if (!TIME.test(timeValue ?? '')) throw new Error('Choose a start time.');
  if (!DATE.test(startDateValue ?? '')) throw new Error('Choose a start date.');
  if (endDateValue && !DATE.test(endDateValue)) throw new Error('The end date is not valid.');
  if (!Number.isInteger(lower) || !Number.isInteger(higher) || lower < 1 || higher > 1440) {
    throw new Error('The interval must be between 1 and 1440 minutes.');
  }
  if (lower > higher) throw new Error('The lower interval cannot be greater than the higher one.');
  return {
    timeValue,
    startDateValue,
    endDateValue,
    durationMinutesValueLower: lower,
    durationMinutesValueHigher: higher,
  };
}

export function firstRunAt(config, now) {
  const start = new Date(`${config.startDateValue}T${config.timeValue}:00`);
  return start < now ? new Date(now.getTime() + GRACE_MS) : start;
}

/** The end date is inclusive: the schedule stops after the end of that day (local time). */
export function endsAt(config) {
  return config.endDateValue ? new Date(`${config.endDateValue}T23:59:59.999`) : null;
}

/** A random whole number of minutes between the two bounds, as milliseconds. */
export function randomDelayMs(config, random = Math.random) {
  const { durationMinutesValueLower: lower, durationMinutesValueHigher: higher } = config;
  return (lower + Math.floor(random() * (higher - lower + 1))) * 60 * 1000;
}

export function createScheduleStore({ dir }) {
  const file = path.join(dir, 'schedules.json');
  const exclusive = createMutex();
  const all = () => readJson(file, {});
  return {
    all,
    get: async (username) => (await all())[username] ?? null,
    set: (username, config) =>
      exclusive(async () => {
        const schedules = await all();
        schedules[username] = config;
        await writeJson(file, schedules);
      }),
    remove: (username) =>
      exclusive(async () => {
        const schedules = await all();
        delete schedules[username];
        await writeJson(file, schedules);
      }),
  };
}

/**
 * Runs ``run(username)`` at the scheduled start and then again after a random number of minutes
 * between the two bounds, until the end date. Saving a schedule takes effect at once (the old app only
 * picked it up after a restart), a run never starts while the previous one is still going, and the
 * clock and timers are injectable so the behaviour can be tested.
 */
export function createScheduler({
  run,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
}) {
  const jobs = new Map();

  function cancel(username) {
    const job = jobs.get(username);
    if (job) clearTimer(job.timer);
    jobs.delete(username);
  }

  function arm(username, job, target) {
    job.target = target;
    const delay = target.getTime() - now().getTime();
    if (delay > MAX_TIMER) {
      job.timer = setTimer(() => arm(username, job, target), MAX_TIMER);
    } else {
      job.timer = setTimer(() => fire(username, job), Math.max(delay, 0));
    }
  }

  function fire(username, job) {
    if (jobs.get(username) !== job) return;
    const end = endsAt(job.config);
    if (end && now() > end) {
      cancel(username);
      return;
    }
    if (!job.running) {
      job.running = true;
      Promise.resolve()
        .then(() => run(username))
        .catch((error) => log.error(`Scheduled run for ${username} failed:`, error.message))
        .finally(() => {
          job.running = false;
        });
    } else {
      log.warn(`Skipping a scheduled run for ${username}: the previous one is still running.`);
    }
    const next = new Date(now().getTime() + randomDelayMs(job.config, random));
    if (end && next > end) {
      cancel(username);
      return;
    }
    arm(username, job, next);
  }

  function set(username, config) {
    cancel(username);
    const job = { config, timer: null, running: false };
    jobs.set(username, job);
    arm(username, job, firstRunAt(config, now()));
  }

  return {
    set,
    cancel,
    has: (username) => jobs.has(username),
    cancelAll: () => [...jobs.keys()].forEach(cancel),
    nextRunOf: (username) => jobs.get(username)?.target ?? null,
  };
}
