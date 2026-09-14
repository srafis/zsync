import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { entryInput } from './dates.ts';
import { findDeletions, deleteConfirmed } from './deletions.ts';
import type { Config, RemoteLog } from './types.ts';

const config = { clockifyWorkspaceId: 'workspace', clockifyUserId: 'user', zohoEmployeeId: 'employee' } as Config;
const input = entryInput({ id: 'entry', projectId: null, projectName: '', tags: [], description: 'Meeting', start: '2026-09-11T10:00:00Z', end: '2026-09-11T11:00:00Z', billable: false }, 'project', 'job', 'employee', 'UTC', { workspaceId: 'workspace', userId: 'user' });
const marker = createHash('sha256').update('\0entry').digest('hex');
const log: RemoteLog = { ...input, id: 'zoho', description: `${input.description}\n\n[zsync-source:${marker}]` };

test('deletion discovery rejects mismatched scope and requires a valid marker and confirmed absence', async () => {
  const absent = { async entryExists() { return false; } };
  expect(await findDeletions([log], absent, config)).toHaveLength(1);
  expect(await findDeletions([log], { async entryExists() { return true; } }, config)).toEqual([]);
  expect(await findDeletions([log], { async entryExists() { return null; } }, config)).toEqual([]);
  for (const changed of [
    { ...log, locked: true }, { ...log, employeeId: 'other' },
    { ...log, description: log.description.replace('"workspace"', '"other"') },
    { ...log, description: log.description.replace('"user"', '"other"') },
    { ...log, description: log.description.replace(marker, '0'.repeat(64)) },
    { ...log, description: 'Manual time log' },
  ]) expect(await findDeletions([changed], absent, config)).toEqual([]);
  await expect(findDeletions([log], { async entryExists() { throw new Error('Forbidden'); } }, config)).rejects.toThrow('Forbidden');
});

test('deletion rechecks source and destination; reconciles lost response without retrying', async () => {
  let current: RemoteLog | null = { ...log };
  let writes = 0;
  const destination = {
    async getLog() { return current; },
    async deleteLog() { writes++; current = null; throw new Error('Timeout'); },
  };
  const item = { log, entryId: 'entry' };
  await expect(deleteConfirmed(item, { async entryExists() { return true; } }, destination)).rejects.toThrow('exists');
  await expect(deleteConfirmed(item, { async entryExists() { return null; } }, destination)).rejects.toThrow('cannot be confirmed');
  current = { ...log, minutes: 20 };
  await expect(deleteConfirmed(item, { async entryExists() { return false; } }, destination)).rejects.toThrow('changed');
  expect(writes).toBe(0);
  current = { ...log };
  await deleteConfirmed(item, { async entryExists() { return false; } }, destination);
  expect(writes).toBe(1);
  current = { ...log };
  await expect(deleteConfirmed(item, { async entryExists() { return false; } }, { ...destination, async deleteLog() {} })).rejects.toThrow('not verified');
});

test('older YAML and JSON metadata still identify deletion candidates', async () => {
  const legacyYaml = { ...log, description: log.description.replace('workspaceId: "workspace"\nuserId: "user"\n', '') };
  const legacyJson = { ...log, description: JSON.stringify({ source: 'Clockify', entryId: 'entry' }) + `\n\n[zsync-source:${marker}]` };
  for (const legacy of [legacyYaml, legacyJson]) {
    expect(await findDeletions([legacy], { async entryExists() { return false; } }, config)).toHaveLength(1);
    expect(await findDeletions([legacy], { async entryExists() { return true; } }, config)).toEqual([]);
  }
});
