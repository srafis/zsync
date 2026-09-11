import { test, expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commit, openStore, prepare, type Destination, type LogInput, type RemoteLog } from "./sync";
import { RejectedWriteError } from "./types";

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

test("rerun unchanged skips the same remote log", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  const store = await openStore(directory, "account-a");
  try {
    const first = await prepare(store, destination, [{ key: "entry-1", input }]);
    expect(first[0]?.status).toBe("create");
    expect(first[0]?.input.description).toBe(input.description);
    expect((await commit(store, destination, first))[0]?.status).toBe("created");

    const second = await prepare(store, destination, [{ key: "entry-1", input }]);
    expect(second[0]?.status).toBe("skip");
    expect((await commit(store, destination, second))[0]?.status).toBe("skipped");
    expect(destination.creates).toBe(1);
    expect(destination.logs[0]?.description).toContain("[synczc-source:");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed input updates the existing remote ID", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  const store = await openStore(directory, "account-b");
  try {
    const first = await prepare(store, destination, [{ key: "entry-1", input }]);
    await commit(store, destination, first);
    const changed = { ...input, description: "Build the durable sync engine" };
    const plan = await prepare(store, destination, [{ key: "entry-1", input: changed }]);
    expect(plan[0]?.status).toBe("update");
    expect(plan[0]?.remoteId).toBe("remote-1");
    expect((await commit(store, destination, plan))[0]?.status).toBe("updated");
    expect(destination.creates).toBe(1);
    expect(destination.updates).toBe(1);
    expect(destination.logs[0]?.description).toContain(changed.description);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful update with a lost response reconciles and clears pending", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  const store = await openStore(directory, "account-b-pending");
  try {
    const first = await prepare(store, destination, [{ key: "entry-1", input }]);
    await commit(store, destination, first);
    destination.loseUpdateResponse = true;
    const changed = { ...input, description: "Update after lost response" };
    const plan = await prepare(store, destination, [{ key: "entry-1", input: changed }]);
    expect((await commit(store, destination, plan))[0]?.status).toBe("updated");
    destination.loseUpdateResponse = false;
    const rerun = await prepare(store, destination, [{ key: "entry-1", input: changed }]);
    expect(rerun[0]?.status).toBe("skip");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("lost create response is reconciled by its source marker", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  destination.loseCreateResponse = true;
  const store = await openStore(directory, "account-c");
  try {
    const plan = await prepare(store, destination, [{ key: "entry-1", input }]);
    const result = await commit(store, destination, plan);
    expect(result[0]?.status).toBe("created");
    expect(destination.creates).toBe(1);

    destination.loseCreateResponse = false;
    const rerun = await prepare(store, destination, [{ key: "entry-1", input }]);
    expect(rerun[0]?.status).toBe("skip");
    expect(destination.creates).toBe(1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two equal-duration entries use distinct markers without colliding", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  const store = await openStore(directory, "account-e");
  try {
    const plan = await prepare(store, destination, [
      { key: "entry-1", input },
      { key: "entry-2", input: { ...input, description: "Review sync engine" } },
    ]);
    expect(plan.map((item) => item.status)).toEqual(["create", "create"]);
    expect((await commit(store, destination, plan)).map((item) => item.status)).toEqual(["created", "created"]);
    const rerun = await prepare(store, destination, [
      { key: "entry-1", input },
      { key: "entry-2", input: { ...input, description: "Review sync engine" } },
    ]);
    expect(rerun.map((item) => item.status)).toEqual(["skip", "skip"]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutating a prepared plan is rejected before a write", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  const store = await openStore(directory, "account-f");
  try {
    const plan = await prepare(store, destination, [{ key: "entry-1", input }]);
    plan[0]!.input.description = "tampered";
    const result = await commit(store, destination, plan);
    expect(result[0]?.status).toBe("failed");
    expect(result[0]?.message).toContain("mutated");
    expect(destination.creates).toBe(0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("definite write rejection clears pending state for a safe retry", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  const originalCreate = destination.createLog.bind(destination);
  let reject = true;
  destination.createLog = async (value) => {
    if (reject) {
      reject = false;
      throw new RejectedWriteError("destination rejected the log");
    }
    return originalCreate(value);
  };
  const store = await openStore(directory, "account-g");
  try {
    const first = await prepare(store, destination, [{ key: "entry-1", input }]);
    expect((await commit(store, destination, first))[0]?.status).toBe("failed");
    const retry = await prepare(store, destination, [{ key: "entry-1", input }]);
    expect(retry[0]?.status).toBe("create");
    expect((await commit(store, destination, retry))[0]?.status).toBe("created");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt state and existing locks fail closed", async () => {
  const directory = await testDirectory();
  const lockPath = join(directory, "synczc.lock");
  await writeFile(lockPath, "not-json");
  await expect(openStore(directory, "account-d")).rejects.toThrow("remove the lock manually");
  await rm(lockPath);

  const store = await openStore(directory, "account-d");
  store.mappings.example = "remote-1";
  await store.saveMappings();
  await store.close();
  const stateFile = (await readdir(directory)).find((name) => name.startsWith("synczc-state-"));
  expect(stateFile).toBeDefined();
  await writeFile(join(directory, stateFile!), "{broken");
  await expect(openStore(directory, "account-d")).rejects.toThrow("was not reset");
  await rm(directory, { recursive: true, force: true });
});

test("pending creates survive restart and never retry until readback resolves", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  let store = await openStore(directory, "restart");
  const originalList = destination.listLogs.bind(destination);
  const originalCreate = destination.createLog.bind(destination);
  destination.createLog = async value => {
    await originalCreate(value);
    destination.listLogs = async () => { throw new Error("offline"); };
    throw new Error("lost response");
  };
  try {
    const plan = await prepare(store, destination, [{ key: "entry", input }]);
    expect((await commit(store, destination, plan))[0]?.status).toBe("uncertain");
    await store.close();
    store = await openStore(directory, "restart");
    destination.listLogs = async () => [];
    expect((await prepare(store, destination, [{ key: "entry", input }]))[0]?.status).toBe("conflict");
    destination.listLogs = originalList;
    const recovered = await prepare(store, destination, [{ key: "entry", input }]);
    expect(recovered[0]?.status).toBe("skip");
    expect((await commit(store, destination, recovered))[0]?.status).toBe("skipped");
    expect(destination.creates).toBe(1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual edits, deletion, and unmarked matches require reconciliation", async () => {
  const directory = await testDirectory();
  const destination = new MockDestination();
  const store = await openStore(directory, "conflicts");
  try {
    destination.logs.push({ ...input, id: "running", minutes: 0 });
    await commit(store, destination, await prepare(store, destination, [{ key: "entry", input }]));
    const saved = { ...destination.logs[1]! };
    destination.logs[1]!.minutes = 61;
    expect((await prepare(store, destination, [{ key: "entry", input }]))[0]?.reason).toContain("edited manually");
    destination.logs = [];
    expect((await prepare(store, destination, [{ key: "entry", input }]))[0]?.reason).toContain("missing");
    destination.logs = [saved, { ...input, id: "manual" }];
    expect((await prepare(store, destination, [{ key: "another", input }]))[0]?.reason).toContain("no source marker");
    destination.logs = [{ ...saved, locked: true }];
    expect((await prepare(store, destination, [{ key: "entry", input }]))[0]?.reason).toContain("locked");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent opens and state moved to a different account fail closed", async () => {
  const directory = await testDirectory();
  const store = await openStore(directory, "original-account");
  try {
    await expect(openStore(directory, "original-account")).rejects.toThrow("lock exists");
    await store.saveMappings();
    await store.close();
    const stateFile = (await readdir(directory)).find(name => name.startsWith("synczc-state-"))!;
    const path = join(directory, stateFile);
    const state = JSON.parse(await readFile(path, "utf8"));
    state.scope = "different-account";
    await writeFile(path, JSON.stringify(state));
    await expect(openStore(directory, "original-account")).rejects.toThrow();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
