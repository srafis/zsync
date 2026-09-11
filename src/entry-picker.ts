import { MultiSelectPrompt } from '@clack/core';
import { symbol } from '@clack/prompts';
import width from 'fast-string-width';
import { styleText } from 'node:util';
import { cleanText, hhmm } from './dates.ts';
import type { Entry, LogInput } from './types.ts';

export type PickerRow = { entry: Entry; input: LogInput; status: 'new' | 'synced' | 'changed' | 'conflict'; reason?: string };
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function fitCell(text: string, size: number): string {
  const value = cleanText(text).replace(/[\u2028\u2029]/g, ' ');
  if (width(value) <= size) return value + ' '.repeat(Math.max(0, size - width(value)));
  let result = '';
  for (const { segment } of segments.segment(value)) {
    if (width(result + segment) > size - 1) break;
    result += segment;
  }
  return size > 0 ? result + '…' + ' '.repeat(Math.max(0, size - width(result) - 1)) : '';
}

export function entryTable(rows: PickerRow[], columns: number) {
  // Reserve the guide, checkbox, and one spare cell to avoid terminal auto-wrap.
  const available = Math.max(1, columns - 7);
  const fields: { title: string; size: number; value: (row: PickerRow) => string }[] = [
    { title: 'Time', size: 5, value: row => hhmm(row.input.minutes) },
    { title: 'Project', size: columns >= 100 ? 18 : 12, value: row => row.entry.projectName || '(no project)' },
  ];
  if (columns >= 90) fields.push({ title: 'Date', size: 10, value: row => row.input.date });
  if (columns >= 110) fields.push({ title: 'Tags', size: 14, value: row => row.entry.tags.join('/') || '—' });
  const used = fields.reduce((sum, field) => sum + field.size + 3, 0);
  fields.push({ title: 'Description', size: Math.max(1, available - used), value: row => row.entry.description || '—' });
  const line = (cells: string[]) => fitCell(cells.join(' │ '), available).trimEnd();
  return {
    header: line(fields.map(field => fitCell(field.title, field.size))),
    separator: line(fields.map(field => '─'.repeat(field.size))).replaceAll(' │ ', '─┼─'),
    labels: rows.map(row => line(fields.map(field => fitCell(field.value(row), field.size)))),
  };
}

export function pickEntries(rows: PickerRow[]): Promise<string[] | symbol> {
  return new MultiSelectPrompt({
    options: rows.map(row => ({ value: row.entry.id })),
    initialValues: rows.filter(row => row.status === 'new').map(row => row.entry.id),
    required: false,
    render() {
      const columns = process.stdout.columns || 80;
      const line = (text: string) => fitCell(text, Math.max(1, columns - 1)).trimEnd()
        .replace(/^[│└]/, guide => styleText('gray', guide));
      const mutedLine = (text: string) => {
        const clipped = fitCell(text, Math.max(1, columns - 1)).trimEnd();
        return styleText("gray", clipped.slice(0, 1)) + styleText("dim", clipped.slice(1));
      };
      const gap = styleText('gray', '│');
      const heading = (text: string) => `${symbol(this.state)}  ${fitCell(text, Math.max(0, columns - 4)).trimEnd()}`;
      if (this.state === 'submit') {
        const selected = rows.filter(row => this.value?.includes(row.entry.id));
        if (!selected.length) return gap;
        const table = entryTable(selected, columns);
        return [gap, heading('Selected entries'), gap,
          mutedLine(`│     ${table.header}`),
          mutedLine(`│     ${table.separator}`),
          ...table.labels.map(label => `${gap}   ${styleText('green', '◼')} ${styleText('dim', label)}`),
        ].join('\n');
      }
      if (this.state === 'cancel') return `${gap}\n${heading('Selection cancelled')}`;
      const table = entryTable(rows, columns);
      const count = Math.max(1, (process.stdout.rows || 24) - 13);
      const start = Math.max(0, Math.min(this.cursor - Math.floor(count / 2), rows.length - count));
      const selected = new Set(this.value ?? []);
      const visible = rows.slice(start, start + count).map((row, index) => {
        const focused = index + start === this.cursor;
        const checked = selected.has(row.entry.id);
        const check = styleText(checked ? 'green' : focused ? 'cyan' : 'dim', checked ? '◼' : '◻');
        const label = table.labels[index + start]!;
        return `${gap} ${focused ? styleText('cyan', '›') : ' '} ${check} ${focused ? label : styleText('dim', label)}`;
      });
      const focused = rows[this.cursor];
      return [gap, heading('Which entries do you want to sync?'), gap,
        mutedLine(`│     ${table.header}`),
        mutedLine(`│     ${table.separator}`), ...visible,
        gap, line(`│  ${selected.size}/${rows.length} selected · ${start + 1}–${Math.min(start + count, rows.length)} shown`),
        ...(focused?.reason ? [line(`│  ${focused.reason}`)] : []),
        mutedLine('└  ↑↓ move · Space toggle · Enter confirm · Esc cancel'),
      ].join('\n');
    },
  }).prompt().then(value => value ?? []);
}
