import { Temporal } from '@js-temporal/polyfill';
import type { Entry, LogInput } from './types.ts';

export const ranges = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' },
  { value: 'this-week', label: 'This week' }, { value: 'last-week', label: 'Last week' },
  { value: 'this-month', label: 'This month' },
] as const;
export type RangeName = typeof ranges[number]['value'];
export type Range = { start: string; end: string; firstDate: string; lastDate: string };

export function dateRange(name: RangeName, zone: string, now = Temporal.Now.instant().toString()): Range {
  const instant = Temporal.Instant.from(now);
  const today = instant.toZonedDateTimeISO(zone).toPlainDate();
  let first = today;
  let end = instant;
  if (name === 'yesterday') {
    first = today.subtract({ days: 1 });
    end = today.toZonedDateTime(zone).toInstant();
  } else if (name === 'this-week' || name === 'last-week') {
    first = today.subtract({ days: today.dayOfWeek - 1 });
    if (name === 'last-week') {
      end = first.toZonedDateTime(zone).toInstant();
      first = first.subtract({ days: 7 });
    }
  } else if (name === 'this-month') first = today.with({ day: 1 });
  return {
    start: first.toZonedDateTime(zone).toInstant().toString(), end: end.toString(),
    firstDate: first.toString(),
    lastDate: Temporal.PlainDate.compare(first, end.subtract({ nanoseconds: 1 }).toZonedDateTimeISO(zone).toPlainDate()) > 0
      ? first.toString() : end.subtract({ nanoseconds: 1 }).toZonedDateTimeISO(zone).toPlainDate().toString(),
  };
}

// Entries belong to their local start date, even when they end the next day.
// This keeps one stable source ID per log across overlapping date selections.
export function entryInput(entry: Entry, jobId: string, employeeId: string, zone: string, source?: { workspaceId: string; userId: string }): LogInput {
  const start = Temporal.Instant.from(entry.start);
  const end = Temporal.Instant.from(entry.end);
  const seconds = Number(end.epochNanoseconds - start.epochNanoseconds) / 1e9;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) {
    throw new Error(`Entry ${entry.id} must have a positive duration of at most 24 hours. Correct it in Clockify first.`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) throw new Error(`Entry ${entry.id} rounds to zero minutes. Adjust it in Clockify before syncing.`);
  return { jobId, employeeId, date: start.toZonedDateTimeISO(zone).toPlainDate().toString(), minutes,
    workItem: entry.description,
    description: [
      'source: Clockify',
      ...(source ? [`workspaceId: ${JSON.stringify(source.workspaceId)}`, `userId: ${JSON.stringify(source.userId)}`] : []),
      `entryId: ${JSON.stringify(entry.id)}`,
      'project:',
      `  id: ${JSON.stringify(entry.projectId)}`,
      `  name: ${JSON.stringify(entry.projectName)}`,
      `tags: ${JSON.stringify(entry.tags)}`,
      `start: ${JSON.stringify(entry.start)}`,
      `end: ${JSON.stringify(entry.end)}`,
      `billable: ${entry.billable}`,
    ].join('\n'),
    billable: entry.billable };
}

export function inRange(entry: Entry, range: Range): boolean {
  const start = Temporal.Instant.from(entry.start);
  return Temporal.Instant.compare(start, range.start) >= 0 && Temporal.Instant.compare(start, range.end) < 0;
}

export function hhmm(minutes: number): string {
  return `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`;
}

export function cleanText(text: string): string {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

