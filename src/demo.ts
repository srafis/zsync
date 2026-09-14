import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { openStore, prepare, commit } from './sync.ts';
import { accountScope } from './types.ts';
import { entryInput } from './dates.ts';
import type { Config, Destination, Entry, Job, Project, RemoteLog } from './types.ts';

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
  const projects: Project[] = [{ id: 'demo-zoho-project', name: 'Example project' }];
  const jobs: Job[] = [
    { id: 'demo-meeting-job', name: 'Meeting', projectId: 'demo-zoho-project', projectName: 'Example project' },
    { id: 'demo-na-job', name: 'N/A', projectId: 'demo-zoho-project', projectName: 'Example project' },
  ];
  const zoho: Destination & { validate(): Promise<void>; listProjects(): Promise<Project[]>; listJobs(): Promise<Job[]>; createJob(name: string, projectId: string): Promise<Job>; deleteLog(id: string): Promise<void> } = {
    async deleteLog(id) { logs.delete(id); },
    async validate() {}, async listProjects() { return projects.map(project => ({ ...project })); },
    async listJobs() { return jobs.map(job => ({ ...job })); },
    async createJob(name, projectId) { const job = { id: `demo-job-${jobs.length + 1}`, name, projectId }; jobs.push(job); return job; },
    async listLogs() { return [...logs.values()].map(log => ({ ...log })); },
    async getLog(id) { const log = logs.get(id); return log ? { ...log } : null; },
    async createLog(input) { const id = `demo-log-${logs.size + 1}`; logs.set(id, { ...input, id }); return id; },
    async updateLog(id, input) { logs.set(id, { ...input, id }); },
  };
  const store = await openStore(stateDir, accountScope(config));
  try {
    await commit(store, zoho, await prepare(store, zoho, [{ key: entries[1]!.id, input: entryInput(entries[1]!, 'demo-zoho-project', 'demo-na-job', 'demo', 'UTC', { workspaceId: 'demo', userId: 'demo' }) }]));
    const deleted = { ...entries[0]!, id: 'demo-deleted', description: 'Deleted Clockify example' };
    await commit(store, zoho, await prepare(store, zoho, [{ key: deleted.id, input: entryInput(deleted, 'demo-zoho-project', 'demo-meeting-job', 'demo', 'UTC', { workspaceId: 'demo', userId: 'demo' }) }]));
  } finally { await store.close(); }
  return { config, zoho, clockify: { async entryExists(id: string) { return entries.some(entry => entry.id === id); }, async validate() {}, async listEntries() { return entries.map(entry => ({ ...entry })); } },
    cleanup: () => rm(stateDir, { recursive: true, force: true }) };
}
