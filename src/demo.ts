import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { openStore, prepare, commit } from './sync.ts';
import { accountScope } from './types.ts';
import { entryInput } from './dates.ts';
import type { Config, Destination, Entry, Job, RemoteLog } from './types.ts';

export async function demoServices() {
  const stateDir = await mkdtemp(join(tmpdir(), 'zsync-demo-'));
  const config: Config = { clockifyKey: 'demo', clockifyWorkspaceId: 'demo', clockifyUserId: 'demo',
    zohoClientId: 'demo', zohoClientSecret: 'demo', zohoRefreshToken: 'demo', zohoRegion: 'com',
    zohoEmployeeId: 'demo', timezone: 'UTC', stateDir };
  const end = Temporal.Now.instant();
  const entries: Entry[] = [{ id: 'demo-entry-1', projectId: 'demo-project', projectName: 'Example project',
    tags: ['Meeting'], description: 'Feature planning discussion', start: end.toZonedDateTimeISO('UTC').startOfDay().toInstant().toString(), end: end.toZonedDateTimeISO('UTC').startOfDay().add({ hours: 1 }).toInstant().toString(), billable: true }];
  entries.push({ ...entries[0]!, id: 'demo-entry-2', description: 'Already synced example', tags: [] });
  const logs = new Map<string, RemoteLog>();
  const zoho: Destination & { validate(): Promise<void>; listJobs(): Promise<Job[]> } = {
    async validate() {}, async listJobs() { return [{ id: 'demo-job', name: 'Example project' }]; },
    async listLogs() { return [...logs.values()].map(log => ({ ...log })); },
    async getLog(id) { const log = logs.get(id); return log ? { ...log } : null; },
    async createLog(input) { const id = `demo-log-${logs.size + 1}`; logs.set(id, { ...input, id }); return id; },
    async updateLog(id, input) { logs.set(id, { ...input, id }); },
  };
  const store = await openStore(stateDir, accountScope(config));
  try {
    await commit(store, zoho, await prepare(store, zoho, [{ key: entries[1]!.id, input: entryInput(entries[1]!, 'demo-job', 'demo', 'UTC') }]));
  } finally { await store.close(); }
  return { config, zoho, clockify: { async validate() {}, async listEntries() { return entries.map(entry => ({ ...entry })); } },
    cleanup: () => rm(stateDir, { recursive: true, force: true }) };
}
