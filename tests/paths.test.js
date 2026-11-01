import { describe, expect, it } from 'vitest';

import { DATA_FOLDER, userDataDir } from '../src/main/paths.js';

describe('userDataDir', () => {
  it('keeps the folder of the old "profinder" app, so existing data is found', () => {
    expect(DATA_FOLDER).toBe('profinder');
    expect(userDataDir({ appData: '/home/jane/.config', env: {} })).toBe(
      '/home/jane/.config/profinder',
    );
  });
  it('can be pointed elsewhere (tests, a second profile)', () => {
    expect(userDataDir({ appData: '/home/jane/.config', env: { UPMF_USER_DATA: '/tmp/x' } })).toBe(
      '/tmp/x',
    );
  });
});
