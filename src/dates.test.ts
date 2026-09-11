import { expect, test } from 'bun:test';
import { dateRange, entryInput, inRange, cleanText } from './dates.ts';
import type { Entry } from './types.ts';

test('calendar windows use fractional offsets and Monday weeks', () => {
  expect(dateRange('today', 'Asia/Kolkata', '2026-09-11T12:00:00Z').start).toBe('2026-09-10T18:30:00Z');
  const last = dateRange('last-week', 'Asia/Kolkata', '2026-09-11T12:00:00Z');
  expect(last.firstDate).toBe('2026-08-31');
  expect(last.lastDate).toBe('2026-09-06');
  expect(dateRange('this-month', 'Asia/Kolkata', '2026-09-11T12:00:00Z').firstDate).toBe('2026-09-01');
});
test('yesterday handles a 23-hour daylight-saving day', () => {
  const range = dateRange('yesterday', 'America/New_York', '2026-03-09T12:00:00Z');
  expect((Date.parse(range.end) - Date.parse(range.start)) / 3600000).toBe(23);
});
test('whole midnight-crossing entry has one stable day; precision is explicit', () => {
  const entry: Entry = { id: '1', projectId: null, projectName: '-', tags: [], description: 'work',
    start: '2026-09-10T18:00:00Z', end: '2026-09-10T19:00:31Z', billable: false };
  expect(entryInput(entry, 'job', 'user', 'Asia/Kolkata')).toMatchObject({ date: '2026-09-10', minutes: 61 });
  expect(inRange(entry, dateRange('today', 'Asia/Kolkata', '2026-09-11T12:00:00Z'))).toBe(false);
  expect(() => entryInput({ ...entry, end: entry.start }, 'job', 'user', 'UTC')).toThrow();
  expect(cleanText('\x1b[31mred\ntext')).toBe('red text');
});
test('midnight, month rollover, and fall daylight-saving boundary', () => {
  const midnight = dateRange('today', 'UTC', '2026-09-11T00:00:00Z');
  expect(midnight.firstDate).toBe(midnight.lastDate);
  expect(dateRange('yesterday', 'UTC', '2026-01-01T12:00:00Z').firstDate).toBe('2025-12-31');
  const fall = dateRange('yesterday', 'America/New_York', '2026-11-02T12:00:00Z');
  expect((Date.parse(fall.end) - Date.parse(fall.start)) / 3600000).toBe(25);
});
