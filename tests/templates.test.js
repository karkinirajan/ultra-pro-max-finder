import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTemplates, fillFirstName } from '../src/main/templates.js';
import { tmpDir } from './helpers.js';

async function setup() {
  const dir = await tmpDir();
  return { dir, templates: createTemplates({ dir }) };
}

describe('fillFirstName', () => {
  it('replaces both placeholder spellings with the first name', () => {
    expect(fillFirstName('Hi <first_name>, hello (first_name)!', 'Jane Q Doe')).toBe(
      'Hi Jane, hello Jane!',
    );
  });
  it('uses the whole name when it has no space', () => {
    expect(fillFirstName('Hi <first_name>', 'Madonna')).toBe('Hi Madonna');
  });
  it('does not treat "$&" in a name as a replacement pattern', () => {
    expect(fillFirstName('Hi <first_name>', "$& O'Neil")).toBe('Hi $&');
  });
  it('copes with a missing name', () => {
    expect(fillFirstName('Hi <first_name>', undefined)).toBe('Hi ');
  });
});

describe('templates', () => {
  it('saves proposal templates under a lower-case title and deletes them', async () => {
    const { templates } = await setup();
    await templates.saveProposal('Resume Writing', 'Text A');
    await templates.saveProposal('LinkedIn Profile', 'Text B');
    expect(await templates.proposals()).toEqual({
      'resume writing': 'Text A',
      'linkedin profile': 'Text B',
    });
    await templates.deleteProposal('Resume Writing');
    expect(Object.keys(await templates.proposals())).toEqual(['linkedin profile']);
  });

  it('refuses a template without a title', async () => {
    const { templates } = await setup();
    await expect(templates.saveProposal('  ', 'x')).rejects.toThrow('A template needs a title.');
  });

  it('picks the template of the job type, ignoring case', async () => {
    const { templates } = await setup();
    await templates.saveProposal('Resume Writing', 'A');
    expect(await templates.proposalFor('RESUME WRITING')).toBe('A');
  });

  it('falls back to a template titled "default" (the old code looked for a file that never existed and crashed)', async () => {
    const { templates } = await setup();
    await templates.saveProposal('Default', 'D');
    expect(await templates.proposalFor('Something else')).toBe('D');
  });

  it('returns null when nothing matches and there is no default', async () => {
    const { templates } = await setup();
    await templates.saveProposal('Resume Writing', 'A');
    expect(await templates.proposalFor('Coaching')).toBeNull();
  });

  it('reads the data files of the old app as they are', async () => {
    const { dir, templates } = await setup();
    await fs.writeFile(
      path.join(dir, 'template.json'),
      JSON.stringify({ 'resume writing': 'Old text' }),
    );
    await fs.writeFile(path.join(dir, 'messageTemplate.txt'), 'Old message');
    await fs.writeFile(
      path.join(dir, 'excelUrl.txt'),
      'https://docs.google.com/spreadsheets/d/OLD_ID/edit\n',
    );
    expect(await templates.proposalFor('Resume Writing')).toBe('Old text');
    expect(await templates.message()).toBe('Old message');
    expect(await templates.spreadsheetId()).toBe('OLD_ID');
  });

  it('normalises Windows line endings in saved text', async () => {
    const { templates } = await setup();
    await templates.saveProposal('a', 'one\r\ntwo\rthree');
    await templates.saveMessage('x\r\ny');
    expect((await templates.proposals()).a).toBe('one\ntwo\nthree');
    expect(await templates.message()).toBe('x\ny');
  });

  it('keeps the follow-up message and clears it when saved empty', async () => {
    const { templates } = await setup();
    expect(await templates.message()).toBe('');
    await templates.saveMessage('Thanks <first_name>');
    expect(await templates.message()).toBe('Thanks <first_name>');
    await templates.saveMessage('');
    expect(await templates.message()).toBe('');
  });

  it('accepts only a Google Sheets link for the sheet (or an empty one to clear it)', async () => {
    const { templates } = await setup();
    await expect(templates.saveSheetUrl('https://example.com/x')).rejects.toThrow(
      'not a Google Sheets link',
    );
    expect(await templates.spreadsheetId()).toBeNull();
    await templates.saveSheetUrl('https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0');
    expect(await templates.spreadsheetId()).toBe('ABC123');
    await templates.saveSheetUrl('');
    expect(await templates.sheetUrl()).toBe('');
  });

  it('does not lose templates when two are saved at once', async () => {
    const { templates } = await setup();
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((t) => templates.saveProposal(t, t.toUpperCase())),
    );
    expect(Object.keys(await templates.proposals()).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
