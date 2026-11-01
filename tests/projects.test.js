import { describe, expect, it } from 'vitest';

import {
  describeAll,
  describeProject,
  formatDate,
  formatTime,
  parseRelativeTime,
  projectId,
  shouldDecline,
  splitName,
} from '../src/main/linkedin/projects.js';
import { career, location, project, response } from './fixtures/voyager.js';

const NOW = new Date('2026-11-01T10:00:00');

describe('parseRelativeTime', () => {
  it.each([
    ['5m ago', '2026-11-01T09:55:00'],
    ['2h ago', '2026-11-01T08:00:00'],
    ['3d ago', '2026-10-29T10:00:00'],
    ['2w ago', '2026-10-18T10:00:00'],
    ['1M ago', '2026-10-01T10:00:00'],
    ['1y ago', '2025-11-01T10:00:00'],
    ['Posted 15 minutes ago', '2026-11-01T09:45:00'],
    ['2 hours ago', '2026-11-01T08:00:00'],
    ['3 days ago', '2026-10-29T10:00:00'],
    ['less than one minute ago', '2026-11-01T10:00:00'],
  ])('%s', (text, expected) => expect(parseRelativeTime(text, NOW)).toEqual(new Date(expected)));

  it('tells a minute (m) from a month (M)', () => {
    expect(parseRelativeTime('2m ago', NOW).getMonth()).toBe(NOW.getMonth());
    expect(parseRelativeTime('2M ago', NOW).getMonth()).toBe(8);
  });

  it.each([undefined, null, '', 'yesterday', '5 parsecs ago', 42])(
    'cannot read %j (the old code threw on a missing text)',
    (text) => expect(parseRelativeTime(text, NOW)).toBeNull(),
  );
});

describe('formatting', () => {
  it('prints the month 1-based and zero-padded (the old code printed November as 10)', () => {
    expect(formatDate(new Date('2026-11-01T10:00:00'))).toBe('2026-11-01');
    expect(formatDate(new Date('2026-01-09T10:00:00'))).toBe('2026-01-09');
    expect(formatTime(new Date('2026-11-01T07:05:00'))).toBe('07:05');
  });
});

describe('small helpers', () => {
  it('finds the project id in the urn', () => {
    expect(projectId('urn:li:fsd_marketplaceProject:(12345,67890)')).toBe('12345');
    expect(projectId('urn:li:thing:999')).toBe('999');
    expect(projectId(undefined)).toBeNull();
  });
  it('splits a name at the first space, and does not cut a one-word name', () => {
    expect(splitName('Jane Q Doe')).toEqual({ first: 'Jane', last: 'Q Doe' });
    expect(splitName('Madonna')).toEqual({ first: 'Madonna', last: '' }); // the old slice(0, -1) gave "Madonn"
    expect(splitName('  Jane   Doe ')).toEqual({ first: 'Jane', last: 'Doe' });
    expect(splitName(undefined)).toEqual({ first: '', last: '' });
  });
});

describe('describeProject', () => {
  it('builds the sheet row with the same column names as before', () => {
    const data = response(project({ id: '42' }));
    const [item] = describeAll(data, NOW).projects;
    expect(item.row).toEqual({
      Title: 'Engineering Manager at Example Corp',
      'Job Type': 'Resume Writing',
      'Proposal URL': 'https://www.linkedin.com/service-marketplace/projects/42',
      'Proposal Date': '2026-11-01',
      'Proposal Time': '09:55',
      'Client First Name': 'Jane',
      'Client Last Name': 'Q Doe',
      'Client Location': 'Austin, Texas',
      'Client Profile': 'https://www.linkedin.com/in/jane-doe',
      'First Followup': '',
    });
    expect(Object.keys(item.row)).toEqual([
      'Title',
      'Job Type',
      'Proposal URL',
      'Proposal Date',
      'Proposal Time',
      'Client First Name',
      'Client Last Name',
      'Client Location',
      'Client Profile',
      'First Followup',
    ]); // fmt: skip
    expect(item).toMatchObject({ id: '42', jobType: 'Resume Writing', clientName: 'Jane Q Doe' });
  });

  it('uses the current time when the request has no (readable) age instead of crashing', () => {
    for (const insight of [null, 'sometime', '']) {
      const [item] = describeAll(response(project({ insight })), NOW).projects;
      expect(item.row['Proposal Date']).toBe('2026-11-01');
      expect(item.row['Proposal Time']).toBe('10:00');
    }
  });

  it('leaves the location empty when it cannot be resolved', () => {
    const data = { included: [project({ locationUrn: 'urn:li:fsd_geo:missing' })] };
    expect(describeAll(data, NOW).projects[0].row['Client Location']).toBe('');
  });

  it('finds the right location among several entities', () => {
    const data = { included: [location('urn:li:fsd_geo:9', 'Elsewhere'), location(), project()] };
    expect(describeAll(data, NOW).projects[0].row['Client Location']).toBe('Austin, Texas');
  });

  it.each(['header', 'creatorInformation'])(
    'skips a request without its %s section instead of throwing',
    (part) => {
      const result = describeAll(
        response(project({ id: '1', omit: [part] }), project({ id: '2' })),
        NOW,
      );
      expect(result.projects.map((p) => p.id)).toEqual(['2']);
      expect(result.skipped).toBe(1);
    },
  );

  it('copes with a request that has no questionnaire', () => {
    const [item] = describeAll(response(project({ omit: ['description'] })), NOW).projects;
    expect(item.careerAnswer).toBeNull();
  });

  it('copes with a response that has nothing in it', () => {
    for (const data of [undefined, null, {}, { included: 'nope' }, { included: [] }])
      expect(describeAll(data, NOW)).toEqual({ projects: [], skipped: 0 });
  });

  it('describeProject returns null for something that is not a request', () => {
    expect(describeProject(undefined, [], NOW)).toBeNull();
    expect(describeProject({}, [], NOW)).toBeNull();
  });
});

describe('shouldDecline', () => {
  const decide = (questions) =>
    shouldDecline(describeAll(response(project({ questions })), NOW).projects[0]);

  it('answers when the career question is not asked', () => expect(decide([])).toBe(false));
  it.each(['Late career', 'Mid career', 'mid career (10+ years)'])(
    'answers when the client says "%s"',
    (a) => expect(decide([career(a)])).toBe(false),
  );
  it.each(['Early career', 'Student', ''])('declines when the client says "%s"', (a) =>
    expect(decide([career(a)])).toBe(true),
  );
  it('declines when the answer is missing altogether', () => {
    expect(decide([{ question: 'Where are you in your career?' }])).toBe(true);
  });
});
