import { describe, expect, it } from 'vitest';

import {
  assertText,
  assertUsername,
  isUsername,
  spreadsheetIdFromUrl,
} from '../src/main/validate.js';

describe('validate', () => {
  it.each(['jane@example.com', 'jane.doe+work@example.co.uk', '+9779812345678', 'a-b_c%d'])(
    'accepts the login %s',
    (name) => expect(isUsername(name)).toBe(true),
  );

  it.each([
    '',
    '../../etc/passwd',
    'a/b',
    'a b',
    '<img src=x onerror=1>',
    'name"quote',
    "name'quote",
    'x'.repeat(101),
    null,
    42,
  ])('rejects %j (it ends up in a partition name and a sheet tab)', (name) =>
    expect(isUsername(name)).toBe(false),
  );

  it('throws a plain message for a bad account name', () => {
    expect(() => assertUsername('../x')).toThrow('Invalid account name.');
    expect(assertUsername('a@b.c')).toBe('a@b.c');
  });

  it('checks text type and length', () => {
    expect(assertText('ok')).toBe('ok');
    expect(() => assertText(5)).toThrow('Text must be text.');
    expect(() => assertText('x'.repeat(11), { max: 10, name: 'Message' })).toThrow(
      'Message is too long.',
    );
  });

  it('extracts the spreadsheet id only from a docs.google.com spreadsheet link', () => {
    expect(
      spreadsheetIdFromUrl('https://docs.google.com/spreadsheets/d/1AbC_dEf-9/edit#gid=0'),
    ).toBe('1AbC_dEf-9');
    expect(spreadsheetIdFromUrl('  https://docs.google.com/spreadsheets/d/xyz/edit ')).toBe('xyz');
    for (const bad of [
      '',
      'https://evil.example/spreadsheets/d/xyz',
      'http://docs.google.com/spreadsheets/d/x',
      null,
      7,
    ])
      expect(spreadsheetIdFromUrl(bad)).toBeNull();
  });
});
