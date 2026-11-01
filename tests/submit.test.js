import { describe, expect, it, vi } from 'vitest';

import { createSubmitter, toPlaywrightCookies } from '../src/main/linkedin/submit.js';
import { describeAll } from '../src/main/linkedin/projects.js';
import { career, project, response } from './fixtures/voyager.js';

/** A page that records what is done to it, in order. `failOn` makes one action throw. */
function fakePage(events, { failOn = [] } = {}) {
  const act =
    (id, extra) =>
    async (...args) => {
      events.push(`${id}${extra ?? ''}${args[0]?.state ? `(${args[0].state})` : ''}`);
      if (failOn.includes(id)) throw new Error(`${id} not found`);
    };
  const handle = (id) => ({
    click: act(id, '.click'),
    waitFor: act(id, '.waitFor'),
    fill: async (text) => events.push(`${id}.fill:${text}`),
    scrollIntoViewIfNeeded: act(id, '.scroll'),
  });
  return {
    goto: async (url) => events.push(`goto:${url}`),
    waitForTimeout: async (ms) => events.push(`wait:${ms}`),
    setViewportSize: async (size) => events.push(`viewport:${size.width}x${size.height}`),
    locator: (selector) => handle(selector),
    getByRole: (role, { name }) => handle(`${role}:${name}`),
    close: async () => events.push('page.close'),
  };
}

function fakeChromium({ failOn, events = [] } = {}) {
  const added = [];
  const context = {
    addCookies: async (cookies) => added.push(cookies),
    newPage: async () => {
      events.push('newPage');
      return fakePage(events, { failOn });
    },
  };
  const browser = {
    newContext: async () => context,
    close: async () => events.push('browser.close'),
  };
  return { chromium: { launch: vi.fn(async () => browser) }, events, added, context, browser };
}

const items = (...projects) => describeAll(response(...projects)).projects;
const templatesWith = ({
  proposals = { 'resume writing': 'Hi <first_name>, I can help.' },
  message = '',
} = {}) => ({
  proposalFor: async (jobType) => proposals[jobType.toLowerCase()] ?? proposals.default ?? null,
  message: async () => message,
});
const cookie = {
  name: 'li_at',
  value: 'v',
  domain: '.linkedin.com',
  path: '/',
  secure: true,
  httpOnly: true,
  expirationDate: 2000000000,
  sameSite: 'no_restriction',
};

describe('toPlaywrightCookies', () => {
  it('keeps only what Playwright knows and maps the fields', () => {
    expect(toPlaywrightCookies([{ ...cookie, hostOnly: false, session: false }])).toEqual([
      {
        name: 'li_at',
        value: 'v',
        domain: '.linkedin.com',
        path: '/',
        expires: 2000000000,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
    ]);
  });
  it('turns a session cookie into one without an expiry', () => {
    expect(toPlaywrightCookies([{ ...cookie, session: true }])[0].expires).toBe(-1);
    expect(toPlaywrightCookies([{ ...cookie, expirationDate: undefined }])[0].expires).toBe(-1);
  });
  it.each([
    ['lax', 'Lax'],
    ['strict', 'Strict'],
    ['unspecified', 'Lax'],
    [undefined, 'Lax'],
    ['no_restriction', 'None'],
  ])('maps sameSite %s to %s', (given, expected) => {
    expect(toPlaywrightCookies([{ ...cookie, sameSite: given }])[0].sameSite).toBe(expected);
  });
  it('makes a SameSite=None cookie Secure, which browsers insist on, and defaults the path', () => {
    const [out] = toPlaywrightCookies([{ ...cookie, secure: false, path: '' }]);
    expect(out.secure).toBe(true);
    expect(out.path).toBe('/');
    expect(toPlaywrightCookies([{ ...cookie, sameSite: 'lax', secure: false }])[0].secure).toBe(
      false,
    );
  });
});

describe('submitter', () => {
  const options = { settleMs: 0 };

  it('answers a request: proposal with the first name, then the saved message, in order', async () => {
    const fake = fakeChromium();
    const submitter = createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith({ message: 'Thanks <first_name>!' }),
      ...options,
    });
    const results = await submitter.submitAll(items(project({ id: '7', client: 'Jane Q Doe' })), [
      cookie,
    ]);
    expect(results).toEqual([{ id: '7', outcome: 'submitted' }]);
    expect(fake.events).toEqual([
      'newPage',
      'goto:https://www.linkedin.com/service-marketplace/projects/7',
      'wait:0',
      'li-icon[type="chevron-down"].click',
      'button:Submit proposal.click',
      'textarea.waitFor(attached)',
      'textarea.fill:Hi Jane, I can help.',
      'button[data-test-proposal-submission-modal__submit-button].waitFor',
      'button[data-test-proposal-submission-modal__submit-button].click',
      'button:Message.click',
      '.msg-form__contenteditable.waitFor(attached)',
      '.msg-form__contenteditable.fill:Thanks Jane!',
      'button:Send.scroll',
      'button:Send.click',
      'page.close',
      'browser.close',
    ]);
  });

  it('adds the converted cookies once and opens the browser visibly', async () => {
    const fake = fakeChromium();
    await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith(),
      ...options,
    }).submitAll(items(project({ id: '1' }), project({ id: '2' })), [cookie]);
    expect(fake.chromium.launch).toHaveBeenCalledWith({ headless: false });
    expect(fake.added).toHaveLength(1);
    expect(fake.added[0][0]).toMatchObject({ name: 'li_at', sameSite: 'None' });
  });

  it('does not click Message or Send when no follow-up message is saved', async () => {
    const fake = fakeChromium();
    await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith({ message: '' }),
      ...options,
    }).submitAll(items(project()), [cookie]);
    expect(fake.events.some((e) => e.includes('Message') || e.includes('Send'))).toBe(false);
    expect(fake.events).toContain(
      'button[data-test-proposal-submission-modal__submit-button].click',
    );
  });

  it('declines a request from someone early in their career', async () => {
    const fake = fakeChromium();
    const [result] = await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith({ proposals: {} }),
      ...options,
    }).submitAll(items(project({ id: '3', questions: [career('Early career')] })), [cookie]);
    expect(result).toEqual({ id: '3', outcome: 'declined' });
    expect(fake.events.filter((e) => e.endsWith('.click'))).toEqual([
      'li-icon[type="chevron-down"].click',
      'button:No thanks.click',
      'button:Decline.click',
    ]);
  });

  it('answers a mid-career request instead of declining', async () => {
    const fake = fakeChromium();
    const [result] = await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith(),
      ...options,
    }).submitAll(items(project({ questions: [career('Mid career')] })), [cookie]);
    expect(result.outcome).toBe('submitted');
  });

  it('skips a request with no template before opening anything (the old code clicked first, then crashed)', async () => {
    const fake = fakeChromium();
    const [result] = await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith({ proposals: {} }),
      ...options,
    }).submitAll(items(project({ jobType: 'Coaching' })), [cookie]);
    expect(result).toMatchObject({
      outcome: 'skipped',
      reason: expect.stringContaining('no template for "Coaching"'),
    });
    expect(fake.events).not.toContain('newPage');
  });

  it('uses the "default" template for a job type without its own', async () => {
    const fake = fakeChromium();
    const [result] = await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith({ proposals: { default: 'Hello <first_name>' } }),
      ...options,
    }).submitAll(items(project({ jobType: 'Coaching' })), [cookie]);
    expect(result.outcome).toBe('submitted');
    expect(fake.events).toContain('textarea.fill:Hello Jane');
  });

  it('carries on with the next request when one fails, and closes the failed page', async () => {
    const fake = fakeChromium({ failOn: ['button:Submit proposal'] });
    const results = await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith(),
      ...options,
    }).submitAll(items(project({ id: '1' }), project({ id: '2' })), [cookie]);
    expect(results.map((r) => [r.id, r.outcome])).toEqual([
      ['1', 'failed'],
      ['2', 'failed'],
    ]);
    expect(results[0].reason).toContain('Submit proposal not found');
    expect(fake.events.filter((e) => e === 'page.close')).toHaveLength(2);
    expect(fake.events.filter((e) => e === 'newPage')).toHaveLength(2); // the second was still attempted
  });

  it('goes on when the expand arrow is missing', async () => {
    const fake = fakeChromium({ failOn: ['li-icon[type="chevron-down"]'] });
    const [result] = await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith(),
      ...options,
    }).submitAll(items(project()), [cookie]);
    expect(result.outcome).toBe('submitted');
  });

  it('sizes the page when given a viewport', async () => {
    const fake = fakeChromium();
    await createSubmitter({
      chromium: fake.chromium,
      templates: templatesWith(),
      viewport: { width: 1280, height: 800 },
      ...options,
    }).submitAll(items(project()), [cookie]);
    expect(fake.events).toContain('viewport:1280x800');
  });

  it('does not open a browser when there is nothing to answer', async () => {
    const fake = fakeChromium();
    expect(
      await createSubmitter({
        chromium: fake.chromium,
        templates: templatesWith(),
        ...options,
      }).submitAll([], [cookie]),
    ).toEqual([]);
    expect(fake.chromium.launch).not.toHaveBeenCalled();
  });

  it('closes the browser even if adding the cookies fails', async () => {
    const fake = fakeChromium();
    fake.context.addCookies = async () => {
      throw new Error('bad cookie');
    };
    await expect(
      createSubmitter({
        chromium: fake.chromium,
        templates: templatesWith(),
        ...options,
      }).submitAll(items(project()), [cookie]),
    ).rejects.toThrow('bad cookie');
    expect(fake.events).toContain('browser.close');
  });
});
