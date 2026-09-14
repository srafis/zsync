import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { RejectedWriteError } from "./types";
import type { Destination, LogInput, RemoteLog } from "./types";
export type { Destination, LogInput, RemoteLog } from "./types";

export type PlanItem = {
  key: string;
  input: LogInput;
  status: "create" | "update" | "skip" | "conflict";
  reason?: string;
  remoteId?: string;
};

export type CommitResult = {
  key: string;
  status: "created" | "updated" | "skipped" | "failed" | "uncertain";
  message?: string;
};

export type Store = {
  projectMappings: Record<string, string>;
  saveMappings(): Promise<void>;
  close(): Promise<void>;
};

const MARKER_RE = /\n\n\[zsync-source:([a-f0-9]{64})\]$/;
type StoreContext = { scope: string; closed: boolean };

type PreparedPlan = {
  context: StoreContext;
  from: string;
  to: string;
  logs: RemoteLog[];
  remoteToken: string;
  planToken: string;
};

const contexts = new WeakMap<Store, StoreContext>();
const preparedPlans = new WeakMap<PlanItem[], PreparedPlan>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateInput(value: unknown, label: string, minimumMinutes = 1): asserts value is LogInput {
  if (!isRecord(value) || typeof value.projectId !== "string" || !value.projectId ||
      typeof value.jobId !== "string" || !value.jobId ||
      typeof value.employeeId !== "string" || !value.employeeId || !isDate(value.date) ||
      typeof value.minutes !== "number" || !Number.isInteger(value.minutes) || value.minutes < minimumMinutes || value.minutes > 1440 ||
      (value.workItem !== undefined && typeof value.workItem !== "string") ||
      typeof value.description !== "string" || typeof value.billable !== "boolean") {
    throw new Error(`${label} is not a valid log input`);
  }
}

function validateRemote(value: unknown, label: string): asserts value is RemoteLog {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error(`${label} is not a valid remote log`);
  }
  const locked = value.locked;
  validateInput(value, label, 0);
  if (locked !== undefined && typeof locked !== "boolean") {
    throw new Error(`${label}.locked is not a boolean`);
  }
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !key) throw new Error("Sync entry keys must be non-empty strings");
}

function markerFor(scope: string, key: string): string {
  return createHash("sha256").update(scope).update("\0").update(key).digest("hex");
}

function markerIn(description: string): string | undefined {
  return description.match(MARKER_RE)?.[1];
}

function withoutMarker(description: string): string {
  return description.replace(MARKER_RE, "");
}

function markedInput(input: LogInput, marker: string): LogInput {
  return { ...input, description: `${withoutMarker(input.description)}\n\n[zsync-source:${marker}]` };
}

function comparable(input: LogInput | RemoteLog): LogInput {
  return {
    projectId: input.projectId,
    jobId: input.jobId,
    employeeId: input.employeeId,
    date: input.date,
    minutes: input.minutes,
    workItem: input.workItem ?? "",
    description: withoutMarker(input.description),
    billable: input.billable,
  };
}

function sameFields(left: LogInput | RemoteLog, right: LogInput | RemoteLog): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function samePlannedFields(remote: RemoteLog, input: LogInput): boolean {
  if (input.projectId === "__unmapped__" || input.jobId === "__unmapped__") return false;
  return sameFields(remote, input);
}

function remoteSnapshot(logs: RemoteLog[]): string {
  return JSON.stringify(
    [...logs]
      .map((log) => ({
        projectId: log.projectId,
        jobId: log.jobId,
        employeeId: log.employeeId,
        date: log.date,
        minutes: log.minutes,
        workItem: log.workItem ?? "",
        description: log.description,
        billable: log.billable,
        id: log.id,
        locked: log.locked ?? false,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function uniqueLogs(logs: RemoteLog[]): RemoteLog[] {
  const byId = new Map<string, RemoteLog>();
  for (const log of logs) byId.set(log.id, log);
  return [...byId.values()];
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") void cleanupError;
    }
    throw error;
  }
}

function contextFor(store: Store): StoreContext {
  const context = contexts.get(store);
  if (!context || context.closed) throw new Error("Sync store is closed");
  return context;
}

export async function openStore(directory: string, scope: string): Promise<Store> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 32);
  const path = join(directory, `zsync-project-preferences-${hash}.json`);
  let projectMappings: Record<string, string> = {};
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; text = ""; }
  if (text) {
    let data: any;
    try { data = JSON.parse(text); } catch { throw new Error(`Invalid project preferences at ${path}`); }
    if (data.scope !== scope || !isRecord(data.projectMappings) || Object.values(data.projectMappings).some(v => typeof v !== "string" || !v))
      throw new Error(`Invalid project preferences at ${path}`);
    projectMappings = { ...data.projectMappings };
  }
  const context = { scope, closed: false };
  const store: Store = {
    projectMappings,
    saveMappings: async () => { contextFor(store); await writeAtomic(path, { scope, projectMappings: store.projectMappings }); },
    close: async () => { context.closed = true; },
  };
  contexts.set(store, context);
  return store;
}

function matches(log: RemoteLog, key: string, scope: string): boolean {
  try {
    const metadata = JSON.parse(withoutMarker(log.description));
    if (metadata.source === "Clockify" && typeof metadata.entryId === "string") return metadata.entryId === key;
  } catch { /* Older logs contain only the marker. */ }
  return markerIn(log.description) === markerFor("", key) || markerIn(log.description) === markerFor(scope, key);
}

async function fetchLogs(destination: Destination, from: string, to: string): Promise<RemoteLog[]> {
  const logs = await destination.listLogs(from, to);
  if (!Array.isArray(logs)) throw new Error("Destination returned an invalid log list");
  for (const [index, log] of logs.entries()) validateRemote(log, `Destination log ${index}`);
  return uniqueLogs(logs);
}

async function getLog(destination: Destination, id: string): Promise<RemoteLog | null> {
  const log = await destination.getLog(id);
  if (log !== null) validateRemote(log, `Destination log ${id}`);
  return log;
}

function dateRange(inputs: Array<{ input: LogInput }>): [string, string] {
  const dates = inputs.map(({ input }) => input.date).sort();
  return [dates[0]!, dates[dates.length - 1]!];
}

function planToken(scope: string, items: PlanItem[]): string {
  return JSON.stringify(items.map((item) => ({
    key: item.key,
    input: { ...item.input },
    status: item.status,
    reason: item.reason,
    remoteId: item.remoteId,
    marker: markerFor(scope, item.key),
  })));
}

function planFor(
  context: StoreContext,
  allLogs: RemoteLog[],
  key: string,
  input: LogInput,
): PlanItem {
  const marked = allLogs.filter(log => log.employeeId === input.employeeId && matches(log, key, context.scope));
  if (marked.length > 1) return { key, input: { ...input }, status: "conflict", reason: "multiple destination logs identify this Clockify entry" };
  const remote = marked[0];
  if (!remote) return { key, input: { ...input }, status: "create" };
  const remoteId = remote.id;
  if (remote.locked) return { key, input: { ...input }, status: "conflict", remoteId, reason: "destination log is locked or approved" };
  return {
    key,
    input: { ...input },
    status: samePlannedFields(remote, input) ? "skip" : "update",
    remoteId,
  };
}

export async function prepare(
  store: Store,
  destination: Destination,
  inputs: Array<{ key: string; input: LogInput }>,
): Promise<PlanItem[]> {
  const context = contextFor(store);
  const seen = new Set<string>();
  for (const [index, item] of inputs.entries()) {
    if (!isRecord(item)) throw new Error(`Input ${index} is invalid`);
    assertKey(item.key);
    if (seen.has(item.key)) throw new Error(`Duplicate sync entry key: ${item.key}`);
    seen.add(item.key);
    validateInput(item.input, `Input ${item.key}`);
  }
  if (!inputs.length) {
    return [];
  }

  const [from, to] = dateRange(inputs);
  const logs = await fetchLogs(destination, from, to);
  const allLogs = [...logs];
  const items = inputs.map(({ key, input }) => planFor(context, allLogs, key, input));
  preparedPlans.set(items, {
    context,
    from,
    to,
    logs: uniqueLogs(allLogs),
    remoteToken: remoteSnapshot(allLogs),
    planToken: planToken(context.scope, items),
  });
  return items;
}

function failed(items: PlanItem[], message: string): CommitResult[] {
  return items.map((item) => ({ key: item.key, status: "failed", message }));
}

async function recheck(
  destination: Destination,
  plan: PreparedPlan,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const current = await fetchLogs(destination, plan.from, plan.to);
    const currentIds = new Set(current.map((log) => log.id));
    for (const expected of plan.logs) {
      if (!currentIds.has(expected.id)) {
        const log = await getLog(destination, expected.id);
        if (log) current.push(log);
      }
    }
    if (remoteSnapshot(uniqueLogs(current)) !== plan.remoteToken) {
      return { ok: false, message: "destination changed after planning; prepare again" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `could not recheck destination: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function readback(destination: Destination, id: string, input: LogInput, marker: string): Promise<RemoteLog | null> {
  const log = await getLog(destination, id);
  return log && markerIn(log.description) === marker && sameFields(log, input) ? log : null;
}

async function reconcileCreate(
  destination: Destination,
  input: LogInput,
  marker: string,
): Promise<{ log: RemoteLog | null; message?: string }> {
  try {
    const logs = await fetchLogs(destination, input.date, input.date);
    const marked = logs.filter((log) => markerIn(log.description) === marker);
    if (marked.length !== 1) {
      return { log: null, message: marked.length ? "multiple destination logs have this source marker" : "create outcome is unresolved; no source marker was found" };
    }
    const verified = await readback(destination, marked[0]!.id, input, marker);
    return verified ? { log: verified, message: "reconciled after an uncertain create response" } : { log: null, message: "source marker found but readback did not verify the requested log" };
  } catch (error) {
    return { log: null, message: `create outcome is unresolved: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function commit(store: Store, destination: Destination, items: PlanItem[]): Promise<CommitResult[]> {
  const context = contextFor(store);
  if (!items.length) return [];
  const plan = preparedPlans.get(items);
  if (!plan || plan.context !== context) return failed(items, "plan was not prepared by this store");
  if (plan.planToken !== planToken(context.scope, items)) return failed(items, "plan was mutated after prepare; prepare again");
  const checked = await recheck(destination, plan);
  if (!checked.ok) return failed(items, checked.message);

  const results: CommitResult[] = [];
  for (const item of items) {
    if (item.status === "conflict") {
      results.push({ key: item.key, status: "failed", message: item.reason ?? "unresolved conflict" });
      continue;
    }
    if (item.status === "skip") {
      results.push({ key: item.key, status: "skipped" });
      continue;
    }

    const marker = markerFor("", item.key);
    const wireInput = markedInput(item.input, marker);
    const operation = item.status;
    const remoteId = item.remoteId;
    if (operation === "update" && !remoteId) {
      results.push({ key: item.key, status: "failed", message: "update has no destination log ID" });
      continue;
    }
    if (operation === "create") {
      let createdId: string | undefined;
      try {
        createdId = await destination.createLog(wireInput);
        if (!createdId) throw new Error("destination returned no log ID");
        const verified = await readback(destination, createdId, item.input, marker);
        if (!verified) throw new Error("create readback did not match");
      } catch (error) {
        if (error instanceof RejectedWriteError) {
          results.push({ key: item.key, status: "failed", message: error.message });
          continue;
        }
        const reconciled = await reconcileCreate(destination, item.input, marker);
        if (!reconciled.log) {
          results.push({ key: item.key, status: "uncertain", message: reconciled.message ?? (error instanceof Error ? error.message : String(error)) });
          continue;
        }
        createdId = reconciled.log.id;
      }
      results.push({ key: item.key, status: "created" });
      continue;
    }

    try {
      await destination.updateLog(remoteId!, wireInput);
      const verified = await readback(destination, remoteId!, item.input, marker);
      if (!verified) throw new Error("update readback did not match");
      results.push({ key: item.key, status: "updated" });
    } catch (error) {
      if (error instanceof RejectedWriteError) {
        results.push({ key: item.key, status: "failed", message: error.message });
        continue;
      }
      try {
        const reconciled = await readback(destination, remoteId!, item.input, marker);
        if (reconciled) {
          results.push({ key: item.key, status: "updated", message: "reconciled after an uncertain update response" });
          continue;
        }
      } catch {
        // The write outcome remains uncertain; do not retry it in this run.
      }
      results.push({ key: item.key, status: "uncertain", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
