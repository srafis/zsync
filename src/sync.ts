import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
  mappings: Record<string, string>;
  saveMappings(): Promise<void>;
  close(): Promise<void>;
};

const VERSION = 1;
// ponytail: one directory lock; use per-scope locks only if parallel scopes become necessary.
const LOCK_NAME = "synczc.lock";
const MARKER_RE = /\n\n\[synczc-source:([a-f0-9]{64})\]$/;

type LedgerEntry = {
  remoteId: string;
  lastConfirmed: LogInput;
  marker: string;
};

type PendingEntry = {
  key: string;
  operation: "create" | "update";
  remoteId?: string;
  input: LogInput;
  marker: string;
  startedAt: string;
};

type PersistedState = {
  version: number;
  scope: string;
  mappings: Record<string, string>;
  ledger: Record<string, LedgerEntry>;
  pending: Record<string, PendingEntry>;
};

type StoreContext = {
  directory: string;
  scope: string;
  statePath: string;
  lockPath: string;
  lock: FileHandle;
  state: PersistedState;
  store: Store;
  closed: boolean;
};

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

function failState(path: string, detail: string): Error {
  return new Error(
    `Sync state at ${path} is corrupt (${detail}). Restore it or remove it only after manual recovery; it was not reset.`,
  );
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
  if (!isRecord(value) || typeof value.jobId !== "string" || !value.jobId ||
      typeof value.employeeId !== "string" || !value.employeeId || !isDate(value.date) ||
      typeof value.minutes !== "number" || !Number.isInteger(value.minutes) || value.minutes < minimumMinutes || value.minutes > 1440 ||
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
  return { ...input, description: `${withoutMarker(input.description)}\n\n[synczc-source:${marker}]` };
}

function comparable(input: LogInput | RemoteLog): LogInput {
  return {
    jobId: input.jobId,
    employeeId: input.employeeId,
    date: input.date,
    minutes: input.minutes,
    description: withoutMarker(input.description),
    billable: input.billable,
  };
}

function sameFields(left: LogInput | RemoteLog, right: LogInput | RemoteLog): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function samePlannedFields(remote: RemoteLog, input: LogInput): boolean {
  if (input.jobId !== "__unmapped__") return sameFields(remote, input);
  return sameFields(remote, { ...input, jobId: remote.jobId });
}

function remoteSnapshot(logs: RemoteLog[]): string {
  return JSON.stringify(
    [...logs]
      .map((log) => ({
        jobId: log.jobId,
        employeeId: log.employeeId,
        date: log.date,
        minutes: log.minutes,
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

function statePath(directory: string, scope: string): string {
  const scopeHash = createHash("sha256").update(scope).digest("hex").slice(0, 32);
  return join(directory, `synczc-state-${scopeHash}.json`);
}

function parseInput(value: unknown, label: string): LogInput {
  validateInput(value, label);
  return { ...value };
}

function parseState(value: unknown, path: string, scope: string): PersistedState {
  if (!isRecord(value) || value.version !== VERSION || value.scope !== scope ||
      !isRecord(value.mappings) || !isRecord(value.ledger) || !isRecord(value.pending)) {
    throw failState(path, "wrong version, scope, or shape");
  }

  const mappings: Record<string, string> = {};
  for (const [key, remoteId] of Object.entries(value.mappings)) {
    if (typeof remoteId !== "string" || !remoteId) throw failState(path, `invalid mapping for ${key}`);
    mappings[key] = remoteId;
  }

  const ledger: Record<string, LedgerEntry> = {};
  for (const [key, raw] of Object.entries(value.ledger)) {
    if (!isRecord(raw) || typeof raw.remoteId !== "string" || !raw.remoteId ||
        typeof raw.marker !== "string" || !/^[a-f0-9]{64}$/.test(raw.marker)) {
      throw failState(path, `invalid ledger entry for ${key}`);
    }
    ledger[key] = { remoteId: raw.remoteId, marker: raw.marker, lastConfirmed: parseInput(raw.lastConfirmed, `${path} ledger ${key}`) };
  }

  const pending: Record<string, PendingEntry> = {};
  for (const [key, raw] of Object.entries(value.pending)) {
    if (!isRecord(raw) || raw.key !== key || (raw.operation !== "create" && raw.operation !== "update") ||
        (raw.remoteId !== undefined && typeof raw.remoteId !== "string") ||
        typeof raw.marker !== "string" || !/^[a-f0-9]{64}$/.test(raw.marker) ||
        typeof raw.startedAt !== "string") {
      throw failState(path, `invalid pending entry for ${key}`);
    }
    pending[key] = {
      key,
      operation: raw.operation,
      ...(raw.remoteId ? { remoteId: raw.remoteId } : {}),
      input: parseInput(raw.input, `${path} pending ${key}`),
      marker: raw.marker,
      startedAt: raw.startedAt,
    };
  }

  return { version: VERSION, scope, mappings, ledger, pending };
}

async function readState(path: string, scope: string): Promise<PersistedState> {
  try {
    const text = await readFile(path, "utf8");
    try {
      return parseState(JSON.parse(text), path, scope);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Sync state at ")) throw error;
      throw failState(path, "invalid JSON");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: VERSION, scope, mappings: {}, ledger: {}, pending: {} };
    }
    throw error;
  }
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

async function save(context: StoreContext): Promise<void> {
  context.state.mappings = { ...context.store.mappings };
  await writeAtomic(context.statePath, context.state);
}

async function releaseLock(context: StoreContext): Promise<void> {
  context.closed = true;
  await context.lock.close();
  try {
    await unlink(context.lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function openStore(directory: string, scope: string): Promise<Store> {
  if (!directory || !scope) throw new Error("State directory and scope are required");
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, LOCK_NAME);
  let lock: FileHandle | undefined;
  try {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    await lock.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Sync state lock exists at ${lockPath}. Another sync may be running; if it is stale, verify that first and remove the lock manually.`);
    }
    if (lock) {
      await lock.close();
      try { await unlink(lockPath); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") void cleanupError;
      }
    }
    throw error;
  }

  const path = statePath(directory, scope);
  try {
    const state = await readState(path, scope);
    const store: Store = {
      mappings: state.mappings,
      saveMappings: async () => save(contextFor(store)),
      close: async () => {
        const context = contexts.get(store);
        if (!context || context.closed) return;
        await releaseLock(context);
      },
    };
    const context: StoreContext = { directory, scope, statePath: path, lockPath, lock: lock!, state, store, closed: false };
    contexts.set(store, context);
    return store;
  } catch (error) {
    await lock.close();
    try { await unlink(lockPath); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") void cleanupError;
    }
    throw error;
  }
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

function collision(logs: RemoteLog[], input: LogInput, exceptId?: string): RemoteLog[] {
  return logs.filter((log) => log.id !== exceptId && !markerIn(log.description) && log.date === input.date && log.jobId === input.jobId && log.employeeId === input.employeeId && log.minutes === input.minutes);
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
  const marker = markerFor(context.scope, key);
  const ledger = context.state.ledger[key];
  const pending = context.state.pending[key];
  const mappedId = ledger?.remoteId ?? pending?.remoteId;

  const marked = allLogs.filter((log) => markerIn(log.description) === marker);
  if (marked.length > 1) {
    return { key, input: { ...input }, status: "conflict", reason: "multiple destination logs have this source marker" };
  }

  const mapped = mappedId ? allLogs.find((log) => log.id === mappedId) : undefined;
  const markedLog = marked[0];
  if (mapped && markedLog && mapped.id !== markedLog.id) {
    return { key, input: { ...input }, status: "conflict", remoteId: mapped.id, reason: "source marker and local mapping identify different destination logs" };
  }

  const remote = mapped ?? markedLog;
  const remoteId = remote?.id;
  if (pending && pending.marker !== marker) {
    return { key, input: { ...input }, status: "conflict", remoteId, reason: "pending state belongs to a different source marker" };
  }
  if (pending && !remote) {
    return { key, input: { ...input }, status: "conflict", reason: "previous write is unresolved; reconcile the destination before retrying" };
  }
  if (!remote && mappedId) {
    return { key, input: { ...input }, status: "conflict", remoteId: mappedId, reason: "mapped destination log is missing; it will not be recreated automatically" };
  }
  if (!remote) {
    const collisions = collision(allLogs, input);
    if (collisions.length) {
      return { key, input: { ...input }, status: "conflict", reason: "a destination log has the same date, job, employee, and duration but no source marker" };
    }
    return { key, input: { ...input }, status: "create" };
  }

  if (remote.locked) return { key, input: { ...input }, status: "conflict", remoteId, reason: "destination log is locked or approved" };
  if (markerIn(remote.description) !== marker) {
    return { key, input: { ...input }, status: "conflict", remoteId, reason: "mapped destination log is missing its source marker" };
  }
  const pendingMatchesRemote = pending !== undefined && sameFields(remote, pending.input);
  if (ledger && !sameFields(remote, ledger.lastConfirmed) && !pendingMatchesRemote) {
    return { key, input: { ...input }, status: "conflict", remoteId, reason: "destination log was edited manually since the last confirmed sync" };
  }
  if (collision(allLogs, input, remote.id).length) {
    return { key, input: { ...input }, status: "conflict", remoteId, reason: "another destination log collides with this source entry" };
  }
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
  const knownIds = new Set(allLogs.map((log) => log.id));
  for (const { key } of inputs) {
    const id = context.state.ledger[key]?.remoteId ?? context.state.pending[key]?.remoteId;
    if (id && !knownIds.has(id)) {
      const log = await getLog(destination, id);
      if (log) {
        allLogs.push(log);
        knownIds.add(log.id);
      }
    }
  }
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

async function recheckItem(
  destination: Destination,
  plan: PreparedPlan,
  item: PlanItem,
): Promise<string | undefined> {
  try {
    if (item.status === "update") {
      if (!item.remoteId) return "update has no destination log ID";
      const expected = plan.logs.find((log) => log.id === item.remoteId);
      const current = await getLog(destination, item.remoteId);
      if (!expected || !current || remoteSnapshot([expected]) !== remoteSnapshot([current])) {
        return "destination log changed after planning; prepare again";
      }
      return undefined;
    }
    if (item.status === "create") {
      const current = await fetchLogs(destination, item.input.date, item.input.date);
      if (current.some((log) => markerIn(log.description) === markerFor(plan.context.scope, item.key))) {
        return "destination already contains this source marker; prepare again";
      }
      if (collision(current, item.input).length) {
        return "a destination collision appeared after planning; prepare again";
      }
    }
    return undefined;
  } catch (error) {
    return `could not recheck destination log: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function beginPending(context: StoreContext, pending: PendingEntry): Promise<void> {
  context.state.pending[pending.key] = pending;
  try {
    await save(context);
  } catch (error) {
    delete context.state.pending[pending.key];
    throw error;
  }
}

async function clearPending(context: StoreContext, key: string): Promise<void> {
  const pending = context.state.pending[key];
  if (!pending) return;
  delete context.state.pending[key];
  try {
    await save(context);
  } catch (error) {
    context.state.pending[key] = pending;
    throw error;
  }
}

async function confirm(
  context: StoreContext,
  key: string,
  input: LogInput,
  remoteId: string,
): Promise<void> {
  const oldLedger = context.state.ledger[key];
  const oldPending = context.state.pending[key];
  context.state.ledger[key] = { remoteId, lastConfirmed: { ...input }, marker: markerFor(context.scope, key) };
  delete context.state.pending[key];
  try {
    await save(context);
  } catch (error) {
    if (oldLedger) context.state.ledger[key] = oldLedger;
    else delete context.state.ledger[key];
    if (oldPending) context.state.pending[key] = oldPending;
    else delete context.state.pending[key];
    throw error;
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
      const ledger = context.state.ledger[item.key];
      if (context.state.pending[item.key] || !ledger) {
        try {
          await confirm(context, item.key, item.input, item.remoteId!);
        } catch (error) {
          results.push({ key: item.key, status: "failed", message: `could not persist reconciliation: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
      }
      results.push({ key: item.key, status: "skipped" });
      continue;
    }

    const marker = markerFor(context.scope, item.key);
    const wireInput = markedInput(item.input, marker);
    const operation = item.status;
    const remoteId = item.remoteId;
    if (operation === "update" && !remoteId) {
      results.push({ key: item.key, status: "failed", message: "update has no destination log ID" });
      continue;
    }
    const itemCheck = await recheckItem(destination, plan, item);
    if (itemCheck) {
      results.push({ key: item.key, status: "failed", message: itemCheck });
      continue;
    }

    try {
      await beginPending(context, {
        key: item.key,
        operation,
        ...(remoteId ? { remoteId } : {}),
        input: { ...item.input },
        marker,
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      results.push({ key: item.key, status: "failed", message: `could not record pending write: ${error instanceof Error ? error.message : String(error)}` });
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
          try {
            await clearPending(context, item.key);
            results.push({ key: item.key, status: "failed", message: error.message });
          } catch (clearError) {
            results.push({ key: item.key, status: "uncertain", message: `write was rejected but pending state could not be cleared: ${clearError instanceof Error ? clearError.message : String(clearError)}` });
          }
          continue;
        }
        const reconciled = await reconcileCreate(destination, item.input, marker);
        if (!reconciled.log) {
          results.push({ key: item.key, status: "uncertain", message: reconciled.message ?? (error instanceof Error ? error.message : String(error)) });
          continue;
        }
        createdId = reconciled.log.id;
      }
      try {
        await confirm(context, item.key, item.input, createdId!);
        results.push({ key: item.key, status: "created" });
      } catch (error) {
        results.push({ key: item.key, status: "uncertain", message: `remote create was verified but local state could not be saved: ${error instanceof Error ? error.message : String(error)}` });
      }
      continue;
    }

    try {
      await destination.updateLog(remoteId!, wireInput);
      const verified = await readback(destination, remoteId!, item.input, marker);
      if (!verified) throw new Error("update readback did not match");
      await confirm(context, item.key, item.input, remoteId!);
      results.push({ key: item.key, status: "updated" });
    } catch (error) {
      if (error instanceof RejectedWriteError) {
        try {
          await clearPending(context, item.key);
          results.push({ key: item.key, status: "failed", message: error.message });
        } catch (clearError) {
          results.push({ key: item.key, status: "uncertain", message: `write was rejected but pending state could not be cleared: ${clearError instanceof Error ? clearError.message : String(clearError)}` });
        }
        continue;
      }
      try {
        const reconciled = await readback(destination, remoteId!, item.input, marker);
        if (reconciled) {
          await confirm(context, item.key, item.input, remoteId!);
          results.push({ key: item.key, status: "updated", message: "reconciled after an uncertain update response" });
          continue;
        }
      } catch {
        // The write outcome remains uncertain and the pending record is retained.
      }
      results.push({ key: item.key, status: "uncertain", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
