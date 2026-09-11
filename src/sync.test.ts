import { test, expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commit, openStore, prepare, type Destination, type LogInput, type RemoteLog } from "./sync";

const input: LogInput = {
  jobId: "job-1",
  employeeId: "employee-1",
  date: "2026-09-11",
  minutes: 60,
  description: "Build sync engine",
  billable: true,
};

class MockDestination implements Destination {
  logs: RemoteLog[] = [];
  creates = 0;
  updates = 0;
  loseCreateResponse = false;
  loseUpdateResponse = false;

  async listLogs(from: string, to: string): Promise<RemoteLog[]> {
    return this.logs.filter((log) => log.date >= from && log.date <= to).map((log) => ({ ...log }));
  }

  async getLog(id: string): Promise<RemoteLog | null> {
    const log = this.logs.find((candidate) => candidate.id === id);
    return log ? { ...log } : null;
  }

  async createLog(value: LogInput): Promise<string> {
    this.creates += 1;
    const id = `remote-${this.creates}`;
    this.logs.push({ ...value, id });
    if (this.loseCreateResponse) throw new Error("request timed out");
    return id;
  }

  async updateLog(id: string, value: LogInput): Promise<void> {
    this.updates += 1;
    const index = this.logs.findIndex((log) => log.id === id);
    if (index < 0) throw new Error("missing remote log");
    this.logs[index] = { ...value, id };
    if (this.loseUpdateResponse) throw new Error("update request timed out");
  }
}

async function testDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "synczc-test-"));
}


test('Zoho metadata is authoritative across machines and OAuth clients; deleted logs become new', async () => {
  const a = await testDirectory(), b = await testDirectory();
  const first = await openStore(a, 'client-a'), second = await openStore(b, 'client-b');
  const destination = new MockDestination();
  const entry = { ...input, workItem: 'Meeting', description: JSON.stringify({ source: 'Clockify', entryId: 'entry-1', tags: ['call'] }) };
  try {
    await commit(first, destination, await prepare(first, destination, [{ key: 'entry-1', input: entry }]));
    expect((await prepare(second, destination, [{ key: 'entry-1', input: entry }]))[0]?.status).toBe('skip');
    const changed = { ...entry, workItem: 'Updated meeting' };
    const plan = await prepare(second, destination, [{ key: 'entry-1', input: changed }]);
    expect(plan[0]?.status).toBe('update');
    expect((await commit(second, destination, plan))[0]?.status).toBe('updated');
    expect(destination.creates).toBe(1);
    destination.logs = [];
    expect((await prepare(first, destination, [{ key: 'entry-1', input: entry }]))[0]?.status).toBe('create');
    expect(await readdir(a)).toEqual([]);
    expect(await readdir(b)).toEqual([]);
  } finally { await first.close(); await second.close(); await rm(a, { recursive: true }); await rm(b, { recursive: true }); }
});

test('duplicate source metadata and locked logs conflict; changed plans never write', async () => {
  const directory = await testDirectory(), store = await openStore(directory, 'scope');
  const destination = new MockDestination();
  try {
    await commit(store, destination, await prepare(store, destination, [{ key: 'entry', input }]));
    destination.logs.push({ ...destination.logs[0]!, id: 'duplicate' });
    expect((await prepare(store, destination, [{ key: 'entry', input }]))[0]?.status).toBe('conflict');
    destination.logs.pop(); destination.logs[0]!.locked = true;
    expect((await prepare(store, destination, [{ key: 'entry', input }]))[0]?.status).toBe('conflict');
    destination.logs[0]!.locked = false;
    const plan = await prepare(store, destination, [{ key: 'entry', input: { ...input, minutes: 61 } }]);
    destination.logs[0]!.minutes = 62;
    expect((await commit(store, destination, plan))[0]?.status).toBe('failed');
    expect(destination.updates).toBe(0);
  } finally { await store.close(); await rm(directory, { recursive: true }); }
});

test('lost create response reconciles from Zoho without a local ledger', async () => {
  const directory = await testDirectory(), store = await openStore(directory, 'scope');
  const destination = new MockDestination();
  destination.loseCreateResponse = true;
  try {
    const plan = await prepare(store, destination, [{ key: 'entry', input }]);
    expect((await commit(store, destination, plan))[0]?.status).toBe('created');
    expect((await prepare(store, destination, [{ key: 'entry', input }]))[0]?.status).toBe('skip');
    expect(destination.creates).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  } finally { await store.close(); await rm(directory, { recursive: true }); }
});

test('old ledger and lock are ignored; only job preferences are migrated', async () => {
  const { createHash } = await import('node:crypto');
  const directory = await testDirectory();
  const hash = createHash('sha256').update('scope').digest('hex').slice(0, 32);
  await writeFile(join(directory, 'synczc.lock'), 'stale');
  await writeFile(join(directory, `synczc-state-${hash}.json`), JSON.stringify({ scope: 'scope', mappings: { project: 'job' }, ledger: { entry: { remoteId: 'deleted' } }, pending: { entry: {} } }));
  const store = await openStore(directory, 'scope');
  try {
    expect(store.mappings.project).toBe('job');
    expect((await prepare(store, new MockDestination(), [{ key: 'entry', input }]))[0]?.status).toBe('create');
    await store.saveMappings();
    const saved = JSON.parse(await readFile(join(directory, `synczc-preferences-${hash}.json`), 'utf8'));
    expect(saved).toEqual({ scope: 'scope', mappings: { project: 'job' } });
  } finally { await store.close(); await rm(directory, { recursive: true }); }
});
