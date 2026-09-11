import { expect, test } from 'bun:test';
import width from 'fast-string-width';
import { colorEntryLabel, entryTable, fitCell, type PickerRow } from './entry-picker.ts';

const row: PickerRow = {
  entry: { id: 'one', projectId: 'p', projectName: '映画制作 🎬', tags: ['Meeting', '計画'],
    description: 'Feature planning 👨‍👩‍👧‍👦 e\u0301 discussion '.repeat(30) + '\n\x1b[31mred',
    start: '', end: '', billable: false },
  input: { date: '2026-09-11', minutes: 229, jobId: 'j', employeeId: 'e', description: '', billable: false },
  status: 'new',
};

test('table fits terminal cells at narrow and wide widths without a status column', () => {
  for (const columns of [20, 40, 60, 80, 90, 100, 110, 160, 240]) {
    const table = entryTable([row, { ...row, status: 'conflict' }, { ...row, status: 'changed' }, { ...row, status: 'deleted' }], columns);
    for (const line of [table.header, table.separator, ...table.labels]) {
      expect(width(line) + 6).toBeLessThan(columns);
      expect(line).not.toMatch(/[\n\r\x1b]/);
    }
    expect(table.labels[0]!.indexOf('│')).toBe(table.labels[1]!.indexOf('│'));
    expect(table.header).not.toContain('Status');
    expect(table.labels[1]).not.toContain('conflict');
  }
  expect(fitCell('👨‍👩‍👧‍👦abc', 3)).toBe('👨‍👩‍👧‍👦…');
  expect(width(fitCell('映画', 3))).toBe(3);
});

test('changed entries are labelled in both picker and confirmation tables', () => {
  const table = entryTable([{ ...row, status: 'changed' }, row], 110);
  expect(table.labels[0]).toContain('[updated]');
  expect(table.labels[1]).not.toContain('[updated]');
});

test('combined table distinguishes updates and deletions without an extra column', () => {
  const table = entryTable([row, { ...row, status: 'changed' }, { ...row, status: 'deleted' }], 110);
  expect(table.labels[0]).not.toContain('[deleted]');
  expect(table.labels[1]).toContain('[updated]');
  expect(table.labels[2]).toContain('[deleted]');
  expect(table.header).not.toContain('Status');
});

test('status styling preserves text and terminal width', () => {
  const label = '01:00 │ [updated] Meeting │ [deleted] Old entry';
  for (const dim of [true, false]) {
    const styled = colorEntryLabel(label, dim);
    expect(styled.replace(/\x1b\[[0-9;]*m/g, '')).toBe(label);
    expect(width(styled)).toBe(width(label));
  }
});
