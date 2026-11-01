import { describe, expect, it } from 'vitest';

import {
  createScheduleStore,
  createScheduler,
  endsAt,
  firstRunAt,
  normalizeSchedule,
  randomDelayMs,
} from '../src/main/schedules.js';
import { fakeClock, tmpDir } from './helpers.js';

// lets the promise chain around a run finish (a run is only "over" after a few microtasks)
const flush = () => new Promise((resolve) => setImmediate(resolve));

const MIN = 60 * 1000;
const base = {
  timeValue: '10:30',
  startDateValue: '2026-11-01',
  endDateValue: '',
  durationMinutesValueLower: 10,
  durationMinutesValueHigher: 20,
};

describe('normalizeSchedule', () => {
  it('accepts a valid schedule, turning the numbers into integers', () => {
    expect(
      normalizeSchedule({
        ...base,
        durationMinutesValueLower: '10',
        durationMinutesValueHigher: '20',
      }),
    ).toEqual(base);
  });
  it.each([
    [{ timeValue: '' }, 'Choose a start time.'],
    [{ timeValue: '25:00' }, 'Choose a start time.'],
    [{ startDateValue: '01/11/2026' }, 'Choose a start date.'],
    [{ endDateValue: 'tomorrow' }, 'The end date is not valid.'],
    [{ durationMinutesValueLower: 0 }, 'between 1 and 1440'],
    [{ durationMinutesValueHigher: 5000 }, 'between 1 and 1440'],
    [{ durationMinutesValueLower: 1.5 }, 'between 1 and 1440'],
    [{ durationMinutesValueLower: 30, durationMinutesValueHigher: 20 }, 'cannot be greater'],
  ])('rejects %j', (change, message) => {
    expect(() => normalizeSchedule({ ...base, ...change })).toThrow(message);
  });
  it('rejects nothing-at-all', () => {
    expect(() => normalizeSchedule(undefined)).toThrow('Choose a start time.');
  });
});

describe('timing', () => {
  it('first runs at the start, or two minutes from now when the start has passed', () => {
    const future = firstRunAt(
      { ...base, startDateValue: '2026-11-02' },
      new Date('2026-11-01T09:00:00'),
    );
    expect(future).toEqual(new Date('2026-11-02T10:30:00'));
    const now = new Date('2026-11-05T09:00:00');
    expect(firstRunAt(base, now)).toEqual(new Date(now.getTime() + 2 * MIN));
  });
  it('ends at the end of the end date, or never', () => {
    expect(endsAt(base)).toBeNull();
    expect(endsAt({ ...base, endDateValue: '2026-11-03' })).toEqual(
      new Date('2026-11-03T23:59:59.999'),
    );
  });
  it('picks a whole number of minutes between the bounds, both included', () => {
    expect(randomDelayMs(base, () => 0)).toBe(10 * MIN);
    expect(randomDelayMs(base, () => 0.999999)).toBe(20 * MIN);
    expect(
      randomDelayMs(
        { ...base, durationMinutesValueLower: 7, durationMinutesValueHigher: 7 },
        () => 0.5,
      ),
    ).toBe(7 * MIN);
  });
});

describe('scheduler', () => {
  function setup(config = base, options = {}) {
    const clock = fakeClock(options.start);
    const runs = [];
    const scheduler = createScheduler({
      run: options.run ?? ((username) => runs.push([username, clock.now().toISOString()])),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 0,
    });
    scheduler.set('a@x.com', config);
    return { clock, runs, scheduler };
  }

  it('runs at the start and then every random number of minutes', async () => {
    const { clock, runs } = setup();
    clock.advance(29 * MIN);
    expect(runs).toHaveLength(0);
    clock.advance(1 * MIN); // 10:30
    await flush();
    expect(runs.map((r) => r[0])).toEqual(['a@x.com']);
    clock.advance(10 * MIN); // random() = 0 -> 10 minutes later
    await flush();
    expect(runs).toHaveLength(2);
  });

  it('takes effect when set, without a restart', () => {
    const { clock, scheduler } = setup();
    expect(scheduler.has('a@x.com')).toBe(true);
    expect(clock.pending()).toBe(1);
  });

  it('replaces the previous schedule of the same account', () => {
    const { clock, scheduler } = setup();
    scheduler.set('a@x.com', { ...base, timeValue: '23:00' });
    expect(clock.pending()).toBe(1);
  });

  it('cancels', () => {
    const { clock, scheduler } = setup();
    scheduler.cancel('a@x.com');
    expect(scheduler.has('a@x.com')).toBe(false);
    expect(clock.pending()).toBe(0);
    scheduler.set('a@x.com', base);
    scheduler.set('b@x.com', base);
    scheduler.cancelAll();
    expect(clock.pending()).toBe(0);
  });

  it('stops after the end date', async () => {
    const { clock, runs, scheduler } = setup({ ...base, endDateValue: '2026-11-01' });
    clock.advance(30 * MIN); // 10:30 first run
    await flush();
    expect(runs).toHaveLength(1);
    clock.advance(24 * 60 * MIN); // well past 23:59 of the end date
    await flush();
    expect(scheduler.has('a@x.com')).toBe(false);
    expect(runs.length).toBeLessThan(200);
  });

  it('does not start a run while the previous one is still going', async () => {
    let finish;
    const started = [];
    const { clock } = setup(base, {
      run: (username) => {
        started.push(username);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    clock.advance(30 * MIN);
    await flush();
    clock.advance(10 * MIN);
    await flush();
    expect(started).toHaveLength(1);
    finish();
    await new Promise((r) => setImmediate(r));
    clock.advance(10 * MIN);
    await flush();
    expect(started).toHaveLength(2);
  });

  it('keeps scheduling after a run fails', async () => {
    const calls = [];
    const { clock } = setup(base, {
      run: () => {
        calls.push(1);
        throw new Error('network down');
      },
    });
    clock.advance(30 * MIN);
    await new Promise((r) => setImmediate(r));
    clock.advance(10 * MIN);
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(2);
  });

  it('waits in steps when the start is further away than a timer can count', () => {
    const { clock, runs } = setup({ ...base, startDateValue: '2027-01-15' });
    clock.advance(60 * 24 * 60 * MIN); // 60 days: Jan 15 10:30 is 75 days away
    expect(runs).toHaveLength(0);
    expect(clock.pending()).toBe(1);
  });

  it('exposes when the next run is due', () => {
    const { scheduler } = setup();
    expect(scheduler.nextRunOf('a@x.com')).toEqual(new Date('2026-11-01T10:30:00'));
    expect(scheduler.nextRunOf('nobody')).toBeNull();
  });
});

describe('schedule store', () => {
  it('saves, reads and removes schedules per account', async () => {
    const store = createScheduleStore({ dir: await tmpDir() });
    expect(await store.all()).toEqual({});
    await store.set('a@x.com', base);
    await store.set('b@x.com', { ...base, timeValue: '08:00' });
    expect(await store.get('b@x.com')).toMatchObject({ timeValue: '08:00' });
    await store.remove('a@x.com');
    expect(Object.keys(await store.all())).toEqual(['b@x.com']);
    expect(await store.get('a@x.com')).toBeNull();
  });
});
