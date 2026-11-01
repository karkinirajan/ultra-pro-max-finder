import { describe, expect, it } from 'vitest';

import { MIN_BROWSER, usableSize } from '../src/main/window.js';

describe('usableSize', () => {
  it('uses the screen area when it is big enough', () => {
    expect(usableSize({ width: 1920, height: 1040 })).toEqual({ width: 1920, height: 1040 });
  });
  it('never goes below the minimum (a headless session reports 1x1)', () => {
    expect(usableSize({ width: 1, height: 1 })).toEqual({ width: 1000, height: 700 });
    expect(usableSize({ width: 1, height: 1 }, MIN_BROWSER)).toEqual({ width: 1280, height: 800 });
  });
  it('copes with a missing or nonsense area', () => {
    for (const area of [undefined, null, {}, { width: 'wide', height: NaN }])
      expect(usableSize(area)).toEqual({ width: 1000, height: 700 });
  });
  it('rounds fractional sizes', () => {
    expect(usableSize({ width: 1500.6, height: 900.4 })).toEqual({ width: 1501, height: 900 });
  });
});
