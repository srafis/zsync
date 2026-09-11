import { homedir } from "node:os";
import { join } from "node:path";
import { RejectedWriteError } from "./types.ts";
import type { Config, Destination, Entry, Job, LogInput, RemoteLog } from "./types.ts";

const CLOCKIFY_API = "https://api.clockify.me/api/v1";
const PAGE_SIZE = 200;
const MAX_MINUTES = 24 * 60;
const REQUEST_TIMEOUT_MS = 30_000;
const ZOHO_WRITE_INTERVAL_MS = 3_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;
type ApiOptions = { fetch?: Fetcher; sleep?: Sleep; timeoutMs?: number };
type RecordValue = Record<string, unknown>;
type RateState = { lastAt: number; queue: Promise<void> };

export const ZOHO_REGIONS: Record<string, { accounts: string; people: string }> = {
  com: { accounts: "accounts.zoho.com", people: "people.zoho.com" },
  eu: { accounts: "accounts.zoho.eu", people: "people.zoho.eu" },
  in: { accounts: "accounts.zoho.in", people: "people.zoho.in" },
  au: { accounts: "accounts.zoho.com.au", people: "people.zoho.com.au" },
  cn: { accounts: "accounts.zoho.com.cn", people: "people.zoho.com.cn" },
  jp: { accounts: "accounts.zoho.jp", people: "people.zoho.jp" },
  ca: { accounts: "accounts.zohocloud.ca", people: "people.zohocloud.ca" },
  sa: { accounts: "accounts.zoho.sa", people: "people.zoho.sa" },
  uk: { accounts: "accounts.zoho.uk", people: "people.zoho.uk" },
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueString(value: unknown, name: string, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context}: ${name} is missing or malformed`);
  return value;
}

function valueId(value: unknown, name: string, context: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new Error(`${context}: ${name} is missing or malformed`);
  }
  return String(value);
}

function safeError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) if (secret.length > 1) result = result.replaceAll(secret, "[redacted]");
  return result.replace(/(Zoho-oauthtoken|Bearer|X-Api-Key)\s+[^\s,}]+/gi, "$1 [redacted]");
}

function responseMessage(body: unknown): string {
  if (!isRecord(body)) return "malformed response";
  const response = isRecord(body.response) ? body.response : body;
  const parts: string[] = [];
  if (typeof response.message === "string") parts.push(response.message);
  if (Array.isArray(response.errors)) {
    for (const error of response.errors) {
      if (!isRecord(error)) continue;
      const code = error.code ?? error.errorCode;
      const message = typeof error.message === "string" ? error.message : "unknown error";
      parts.push(code === undefined ? message : `${String(code)}: ${message}`);
    }
  }
  return parts.join("; ") || "request failed";
}

type RawResponse = { body: unknown; status: number };

async function fetchRaw(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  label: string,
  secrets: readonly string[],
  timeoutMs: number,
  write: boolean,
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { body, status: response.status };
  } catch (error) {
    const suffix = write ? "; write outcome may be uncertain, do not retry blindly" : "";
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms${suffix}`);
    throw new Error(`${label} failed: ${redact(safeError(error), secrets)}${suffix}`);
  } finally {
    clearTimeout(timer);
  }
}

function requireHttp(result: RawResponse, label: string, secrets: readonly string[], write = false): unknown {
  if (result.status < 200 || result.status >= 300) {
    const definiteRejection = write && [400, 401, 403, 404, 429].includes(result.status);
    const suffix = write && !definiteRejection ? "; write outcome may be uncertain, do not retry blindly" : "";
    const message = `${label} failed (HTTP ${result.status}): ${redact(responseMessage(result.body), secrets)}${suffix}`;
    if (definiteRejection) throw new RejectedWriteError(message);
    throw new Error(message);
  }
  return result.body;
}

function queryUrl(base: string, path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `${base}${path}?${query}`;
}

function envValue(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
  return timezone;
}

const ZOHO_DATE_FORMATS = new Set(["yyyy-MM-dd", "dd-MM-yyyy", "MM-dd-yyyy", "yyyy/MM/dd", "dd/MM/yyyy", "MM/dd/yyyy"]);

function dateFormat(value: string): string {
  if (!ZOHO_DATE_FORMATS.has(value)) throw new Error(`Invalid ZOHO_DATE_FORMAT ${value}; use yyyy-MM-dd, dd-MM-yyyy, or MM-dd-yyyy`);
  return value;
}

function formatDate(value: string, format: string): string {
  const [year, month, day] = value.split("-");
  return format.replace("yyyy", year!).replace("MM", month!).replace("dd", day!);
}

function defaultStateDir(env: Record<string, string | undefined>): string {
  const home = homedir();
  if (process.platform === "win32") return join(env.APPDATA ?? env.LOCALAPPDATA ?? join(home, "AppData", "Roaming"), "zsync");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "zsync");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "zsync");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const region = (env.ZOHO_REGION?.trim() || "").toLowerCase();
  if (region && !ZOHO_REGIONS[region]) throw new Error(`Unsupported ZOHO_REGION ${region}; use a supported Zoho data-center code`);
  const timezone = validateTimezone(env.ZSYNC_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return {
    clockifyKey: envValue(env, "CLOCKIFY_API_KEY"),
    clockifyWorkspaceId: envValue(env, "CLOCKIFY_WORKSPACE_ID"),
    clockifyUserId: envValue(env, "CLOCKIFY_USER_ID"),
    zohoClientId: envValue(env, "ZOHO_CLIENT_ID"),
    zohoClientSecret: envValue(env, "ZOHO_CLIENT_SECRET"),
    zohoRefreshToken: env.ZOHO_REFRESH_TOKEN?.trim() || "",
    zohoRegion: region,
    zohoDateFormat: dateFormat(env.ZOHO_DATE_FORMAT?.trim() || "yyyy-MM-dd"),
    zohoEmployeeId: env.ZOHO_EMPLOYEE_ID?.trim() || "",
    timezone,
    stateDir: env.ZSYNC_STATE_DIR?.trim() || defaultStateDir(env),
  };
}

async function clockifyRequest(
  fetcher: Fetcher,
  config: Config,
  path: string,
  params: Record<string, string> = {},
  options: ApiOptions = {},
): Promise<unknown> {
  const result = await fetchRaw(
    fetcher,
    queryUrl(CLOCKIFY_API, path, params),
    { headers: { "X-Api-Key": config.clockifyKey } },
    `Clockify ${path}`,
    [config.clockifyKey],
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    false,
  );
  return requireHttp(result, `Clockify ${path}`, [config.clockifyKey]);
}

async function clockifyPages(
  fetcher: Fetcher,
  config: Config,
  path: string,
  params: Record<string, string>,
  options: ApiOptions,
): Promise<RecordValue[]> {
  const rows: RecordValue[] = [];
  for (let page = 1; ; page += 1) {
    const body = await clockifyRequest(fetcher, config, path, { ...params, page: String(page), "page-size": String(PAGE_SIZE) }, options);
    if (!Array.isArray(body) || !body.every(isRecord)) throw new Error(`Clockify ${path}: expected an array of objects`);
    rows.push(...body);
    if (body.length < PAGE_SIZE) return rows;
  }
}

function isoMilliseconds(value: string, name: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid ${name} timestamp`);
  return milliseconds;
}

export function createClockify(config: Config, options: ApiOptions = {}) {
  const fetcher = options.fetch ?? fetch;

  async function validate(): Promise<void> {
    const user = await clockifyRequest(fetcher, config, "/user", {}, options);
    if (!isRecord(user) || valueId(user.id, "id", "Clockify user") !== config.clockifyUserId) {
      throw new Error("Clockify API key does not belong to CLOCKIFY_USER_ID");
    }
    const workspace = await clockifyRequest(fetcher, config, `/workspaces/${encodeURIComponent(config.clockifyWorkspaceId)}`, {}, options);
    if (!isRecord(workspace) || valueId(workspace.id, "id", "Clockify workspace") !== config.clockifyWorkspaceId) {
      throw new Error("CLOCKIFY_WORKSPACE_ID was not returned by Clockify");
    }
  }

  async function listEntries(startISO: string, endISO: string): Promise<Entry[]> {
    const rangeStart = isoMilliseconds(startISO, "start");
    const rangeEnd = isoMilliseconds(endISO, "end");
    if (rangeEnd <= rangeStart) throw new Error("Clockify entry range must end after it starts");

    const [projects, tags, rawEntries] = await Promise.all([
      clockifyPages(fetcher, config, `/workspaces/${encodeURIComponent(config.clockifyWorkspaceId)}/projects`, {}, options),
      clockifyPages(fetcher, config, `/workspaces/${encodeURIComponent(config.clockifyWorkspaceId)}/tags`, {}, options),
      clockifyPages(
        fetcher,
        config,
        `/workspaces/${encodeURIComponent(config.clockifyWorkspaceId)}/user/${encodeURIComponent(config.clockifyUserId)}/time-entries`,
        // Clockify can interpret these filters in the account timezone despite Z.
        // Cover every UTC offset, then enforce the exact instant range below.
        { start: new Date(rangeStart - 86400_000).toISOString(), end: new Date(rangeEnd + 86400_000).toISOString() },
        options,
      ),
    ]);
    const projectNames = new Map<string, string>();
    for (const project of projects) projectNames.set(valueId(project.id, "id", "Clockify project"), valueString(project.name, "name", "Clockify project"));
    const tagNames = new Map<string, string>();
    for (const tag of tags) tagNames.set(valueId(tag.id, "id", "Clockify tag"), valueString(tag.name, "name", "Clockify tag"));

    const entries: Entry[] = [];
    for (const raw of rawEntries) {
      if (raw.userId !== undefined && valueId(raw.userId, "userId", "Clockify time entry") !== config.clockifyUserId) {
        throw new Error("Clockify returned a time entry for a different user");
      }
      const interval = raw.timeInterval;
      if (interval === null) continue;
      if (!isRecord(interval)) throw new Error("Clockify time entry has no valid time interval");
      const start = valueString(interval.start, "start", "Clockify time entry");
      if (interval.end === null) continue;
      const end = valueString(interval.end, "end", "Clockify time entry");
      const startMs = isoMilliseconds(start, "Clockify entry start");
      const endMs = isoMilliseconds(end, "Clockify entry end");
      if (endMs <= startMs) throw new Error("Clockify returned a non-positive time entry");
      if (startMs < rangeStart || startMs >= rangeEnd) continue;
      const minutes = Math.round((endMs - startMs) / 60_000);
      if (minutes < 1 || minutes > MAX_MINUTES) throw new Error("Clockify entry duration must round to 1-1440 minutes");
      if (typeof raw.projectId !== "string" && raw.projectId !== null) throw new Error("Clockify time entry projectId is malformed");
      const tagIds = raw.tagIds === null ? [] : raw.tagIds;
      if (!Array.isArray(tagIds) || !tagIds.every((tagId) => typeof tagId === "string")) throw new Error("Clockify time entry tagIds is malformed");
      if (typeof raw.billable !== "boolean") throw new Error("Clockify time entry billable is malformed");
      entries.push({
        id: valueId(raw.id, "id", "Clockify time entry"),
        projectId: raw.projectId,
        projectName: raw.projectId === null ? "" : projectNames.get(raw.projectId) ?? raw.projectId,
        tags: tagIds.map((tagId) => tagNames.get(tagId) ?? tagId),
        description: raw.description === undefined || raw.description === null ? "" : typeof raw.description === "string" ? raw.description : valueString(raw.description, "description", "Clockify time entry"),
        start,
        end,
        billable: raw.billable,
      });
    }
    return entries;
  }

  async function entryExists(id: string): Promise<boolean | null> {
    if (!id) throw new Error("Clockify entry ID is required");
    const path = `/workspaces/${encodeURIComponent(config.clockifyWorkspaceId)}/time-entries/${encodeURIComponent(id)}`;
    const result = await fetchRaw(fetcher, `${CLOCKIFY_API}${path}`, { headers: { "X-Api-Key": config.clockifyKey } }, "Clockify entry lookup", [config.clockifyKey], options.timeoutMs ?? REQUEST_TIMEOUT_MS, false);
    // A workspace mismatch alone is ambiguous. Confirm absence against the
    // complete user list, without date or running-timer filters.
    if (result.status === 400 && isRecord(result.body) &&
        result.body.message === "Time entry doesn't belong to Workspace") {
      await validate();
      const entries = await clockifyPages(fetcher, config,
        `/workspaces/${encodeURIComponent(config.clockifyWorkspaceId)}/user/${encodeURIComponent(config.clockifyUserId)}/time-entries`, {}, options);
      const ids = entries.map(entry => {
        if (entry.userId !== undefined && String(entry.userId) !== config.clockifyUserId)
          throw new Error("Clockify returned an entry for a different user");
        return valueId(entry.id, "id", "Clockify entry");
      });
      return ids.includes(id);
    }
    if (result.status === 404) {
      await validate();
      return false;
    }
    const body = requireHttp(result, "Clockify entry lookup", [config.clockifyKey]);
    if (!isRecord(body) || body.id !== id) throw new Error("Clockify entry lookup returned an unexpected entry");
    return true;
  }

  return { validate, listEntries, entryExists };
}

function validDate(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${name} is not a real calendar date`);
  return value;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateChunks(from: string, to: string): Array<[string, string]> {
  validDate(from, "from date");
  validDate(to, "to date");
  if (from > to) throw new Error("Zoho log range must end on or after it starts");
  const chunks: Array<[string, string]> = [];
  for (let start = from; start <= to;) {
    const end = addDays(start, 27) < to ? addDays(start, 27) : to;
    chunks.push([start, end]);
    start = addDays(end, 1);
  }
  return chunks;
}

function zohoStatus(body: unknown, label: string, secrets: readonly string[], write = false): RecordValue {
  if (!isRecord(body) || !isRecord(body.response)) throw new Error(`${label}: malformed response`);
  const response = body.response;
  if (String(response.status) !== "0") {
    const message = `${label}: ${redact(responseMessage(body), secrets)}`;
    if (write && String(response.status) === "1") throw new RejectedWriteError(message);
    throw new Error(message);
  }
  return response;
}

function formBody(fields: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
}

function boolValue(value: unknown): boolean {
  return value === true || value === "true";
}

function rateLimit<T>(state: RateState, interval: number, sleep: Sleep, operation: () => Promise<T>): Promise<T> {
  const run = state.queue.then(async () => {
    const wait = Math.max(0, state.lastAt + interval - Date.now());
    if (wait) await sleep(wait);
    state.lastAt = Date.now();
    return operation();
  });
  state.queue = run.then(() => undefined, () => undefined);
  return run;
}

function minutesFromHours(value: unknown, context: string): number {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${context}: hours is missing or malformed`);
  const text = String(value);
  const match = /^(\d+):([0-5]\d)$/.exec(text);
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : Number.isFinite(Number(text)) ? Math.round(Number(text) * 60) : NaN;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_MINUTES) throw new Error(`${context}: hours is outside 0-24 hours`);
  return minutes;
}

function parseZohoDate(value: unknown, format: string, context: string, dbValue?: unknown): string {
  if (typeof dbValue === "string") {
    const dbDate = /^(\d{4}-\d{2}-\d{2})/.exec(dbValue)?.[1];
    if (dbDate) return validDate(dbDate, `${context} workDate`);
  }
  if (typeof value !== "string") throw new Error(`${context}: workDate is missing or malformed`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validDate(value, `${context} workDate`);
  const escaped = format.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped.replace("yyyy", "(\\d{4})").replace("MM", "(\\d{2})").replace("dd", "(\\d{2})")}$`).exec(value);
  if (!match) throw new Error(`${context}: workDate does not match ZOHO_DATE_FORMAT ${format}`);
  const values = Object.fromEntries((format.match(/yyyy|MM|dd/g) ?? []).map((token, index) => [token, match[index + 1]]));
  return validDate(`${values.yyyy!}-${values.MM!}-${values.dd!}`, `${context} workDate`);
}

function remoteLog(raw: RecordValue, config: Config, context: string): RemoteLog {
  const employeeId = valueId(raw.erecno, "erecno", context);
  if (employeeId !== config.zohoEmployeeId) throw new Error(`${context}: Zoho returned a log for a different employee`);
  const billing = raw.billingStatus ?? raw.billableStatus ?? raw.jobBillableStatus;
  let billable: boolean;
  if (typeof billing === "string") {
    const normalized = billing.toLowerCase().replaceAll(" ", "-");
    if (normalized === "billable" || normalized === "1") billable = true;
    else if (normalized === "non-billable" || normalized === "nonbillable" || normalized === "0") billable = false;
    else throw new Error(`${context}: billingStatus is malformed`);
  } else if (typeof billing === "number" && (billing === 0 || billing === 1)) billable = billing === 1;
  else throw new Error(`${context}: billingStatus is missing or malformed`);
  const totalSeconds = typeof raw.totaltime === "number" ? raw.totaltime : Number(raw.totaltime);
  const minutes = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.round(totalSeconds / 60) : minutesFromHours(raw.hours, context);
  if (minutes < 0 || minutes > MAX_MINUTES) throw new Error(`${context}: duration is outside 0-24 hours`);
  const description = raw.description === undefined || raw.description === null ? "" : typeof raw.description === "string" ? raw.description : valueString(raw.description, "description", context);
  const workItem = raw.taskName ?? "";
  if (typeof workItem !== "string") throw new Error(`${context}: taskName is malformed`);
  const approvalStatus = typeof raw.approvalStatus === "string" ? raw.approvalStatus.toLowerCase() : raw.approvalStatus;
  const editAllowed = typeof raw.isEditAllowed === "string" ? raw.isEditAllowed.toLowerCase() : raw.isEditAllowed;
  const locked = raw.locked === true || raw.locked === "true" || approvalStatus === "approved" ||
    approvalStatus === "pending" || editAllowed === false || editAllowed === "false";
  return {
    id: valueId(raw.timelogId, "timelogId", context),
    jobId: valueId(raw.jobId, "jobId", context),
    employeeId,
    date: parseZohoDate(raw.workDate, config.zohoDateFormat ?? "yyyy-MM-dd", context, raw.db_workDate),
    minutes,
    workItem,
    description,
    billable,
    ...(locked === undefined ? {} : { locked }),
  };
}

function logFields(input: LogInput, config: Config): Record<string, string> {
  if (input.employeeId !== config.zohoEmployeeId) throw new Error("Zoho log employeeId does not match configured employee");
  validDate(input.date, "log date");
  if (!input.jobId || !Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_MINUTES) {
    throw new Error("Zoho log requires a job and 1-1440 whole minutes");
  }
  if (typeof input.description !== "string" || input.description.length > 15_000) throw new Error("Zoho log description is malformed or too long");
  if (input.workItem !== undefined && typeof input.workItem !== "string") throw new Error("Zoho workItem is malformed");
  if (typeof input.billable !== "boolean") throw new Error("Zoho log billable is malformed");
  const format = dateFormat(config.zohoDateFormat ?? "yyyy-MM-dd");
  return {
    user: input.employeeId,
    jobId: input.jobId,
    workDate: formatDate(input.date, format),
    dateFormat: format,
    hours: `${String(Math.floor(input.minutes / 60)).padStart(2, "0")}:${String(input.minutes % 60).padStart(2, "0")}`,
    billingStatus: input.billable ? "billable" : "non-billable",
    workItem: input.workItem ?? "",
    description: input.description,
  };
}

export function createZoho(config: Config, options: ApiOptions = {}): Destination & { validate(): Promise<void>; listJobs(): Promise<Job[]>; deleteLog(id: string): Promise<void> } {
  const region = ZOHO_REGIONS[config.zohoRegion.toLowerCase()];
  if (!region) throw new Error(`Unsupported Zoho region ${config.zohoRegion}`);
  const { accounts, people } = region;
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const secrets = [config.zohoClientId, config.zohoClientSecret, config.zohoRefreshToken];
  const zohoFormat = dateFormat(config.zohoDateFormat ?? "yyyy-MM-dd");
  const apiBase = `https://${people}/people/api`;
  let access: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;

  async function refreshAccessToken(): Promise<string> {
    const result = await fetchRaw(
      fetcher,
      `https://${accounts}/oauth/v2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({ refresh_token: config.zohoRefreshToken, client_id: config.zohoClientId, client_secret: config.zohoClientSecret, grant_type: "refresh_token" }),
      },
      "Zoho OAuth token refresh",
      secrets,
      timeoutMs,
      false,
    );
    const body = requireHttp(result, "Zoho OAuth token refresh", secrets);
    if (!isRecord(body)) throw new Error("Zoho OAuth token refresh returned malformed data");
    const token = valueString(body.access_token, "access_token", "Zoho OAuth token refresh");
    secrets.push(token);
    const expiresIn = Number(body.expires_in ?? 3600);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("Zoho OAuth token refresh returned malformed expiry");
    access = { token, expiresAt: Date.now() + Math.max(1, expiresIn - 60) * 1000 };
    return token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt > Date.now()) return access.token;
    if (refreshing) return refreshing;
    const pending = refreshAccessToken();
    refreshing = pending;
    try {
      return await pending;
    } finally {
      if (refreshing === pending) refreshing = undefined;
    }
  }

  async function zohoRequest(path: string, init: RequestInit = {}, write = false, allowNotFound = false): Promise<unknown | null> {
    const request = async (token: string): Promise<RawResponse> => fetchRaw(
      fetcher,
      `${apiBase}${path}`,
      { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Zoho-oauthtoken ${token}` } },
      `Zoho ${path}`,
      secrets,
      timeoutMs,
      write,
    );
    let result = await request(await accessToken());
    if (result.status === 401 && !write) {
      access = undefined;
      result = await request(await accessToken());
    }
    if (allowNotFound && result.status === 404) return null;
    return requireHttp(result, `Zoho ${path}`, secrets, write);
  }

  async function zohoPage(path: string, params: Record<string, string>): Promise<RecordValue> {
    const body = await zohoRequest(queryUrl("", path, params));
    return zohoStatus(body, `Zoho ${path}`, secrets);
  }

  const jobsRate: RateState = { lastAt: 0, queue: Promise.resolve() };
  const logsRate: RateState = { lastAt: 0, queue: Promise.resolve() };

  async function listJobs(): Promise<Job[]> {
    const jobs: Job[] = [];
    for (let index = 0; ; ) {
      const response = await rateLimit(jobsRate, ZOHO_WRITE_INTERVAL_MS, sleep, () => zohoPage("/timetracker/getjobs", {
        assignedTo: config.zohoEmployeeId,
        jobStatus: "in-progress",
        dateFormat: zohoFormat,
        sIndex: String(index),
        limit: String(PAGE_SIZE),
      }));
      if (!Array.isArray(response.result) || !response.result.every(isRecord)) throw new Error("Zoho getjobs returned malformed result");
      for (const raw of response.result) {
        const status = typeof raw.jobStatus === "string" ? raw.jobStatus.toLowerCase() : "";
        if (status.includes("completed") || status.includes("inactive")) continue;
        const job: Job = { id: valueId(raw.jobId, "jobId", "Zoho job"), name: valueString(raw.jobName, "jobName", "Zoho job") };
        if (raw.projectName !== undefined) {
          if (typeof raw.projectName !== "string") throw new Error("Zoho job projectName is malformed");
          job.projectName = raw.projectName;
        }
        jobs.push(job);
      }
      if (!boolValue(response.isNextAvailable) || response.result.length === 0) return jobs;
      index += response.result.length;
    }
  }

  async function listLogs(from: string, to: string): Promise<RemoteLog[]> {
    const logs: RemoteLog[] = [];
    for (const [chunkFrom, chunkTo] of dateChunks(from, to)) {
      for (let index = 0; ; ) {
        const response = await rateLimit(logsRate, 600, sleep, () => zohoPage("/timetracker/gettimelogs", {
          user: config.zohoEmployeeId,
          jobId: "all",
          fromDate: formatDate(chunkFrom, zohoFormat),
          toDate: formatDate(chunkTo, zohoFormat),
          dateFormat: zohoFormat,
          billingStatus: "all",
          sIndex: String(index),
          limit: String(PAGE_SIZE),
        }));
        if (!Array.isArray(response.result) || !response.result.every(isRecord)) throw new Error("Zoho gettimelogs returned malformed result");
        logs.push(...response.result.map((raw) => remoteLog(raw, config, "Zoho time log")));
        if (!boolValue(response.isNextAvailable) || response.result.length === 0) break;
        index += response.result.length;
      }
    }
    return logs;
  }

  async function getLog(id: string): Promise<RemoteLog | null> {
    if (!id) throw new Error("Zoho timelog id is required");
    const body = await rateLimit(logsRate, 600, sleep, () => zohoRequest(queryUrl("", "/timetracker/gettimelogdetails", { timelogId: id }), {}, false, true));
    if (body === null) return null;
    const response = zohoStatus(body, "Zoho gettimelogdetails", secrets);
    if (!Array.isArray(response.result) || !response.result.every(isRecord)) throw new Error("Zoho gettimelogdetails returned malformed result");
    if (response.result.length === 0) return null;
    if (response.result.length !== 1) throw new Error("Zoho gettimelogdetails returned more than one log");
    const log = remoteLog(response.result[0]!, config, "Zoho time log");
    if (log.id !== id) throw new Error("Zoho gettimelogdetails returned a different timeLogId");
    return log;
  }

  const writesRate: RateState = { lastAt: 0, queue: Promise.resolve() };

  async function writeLog(path: string, fields: Record<string, string>, expectedId?: string): Promise<void | string> {
    const body = await zohoRequest(
      path,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: formBody(fields) },
      true,
    );
    const response = zohoStatus(body, `Zoho ${path}`, secrets, true);
    if (!Array.isArray(response.result) || !response.result.every(isRecord)) throw new Error(`Zoho ${path} returned malformed result; write outcome may be uncertain`);
    const id = valueId(response.result[0]?.timeLogId, "timeLogId", `Zoho ${path}`);
    if (expectedId !== undefined && id !== expectedId) throw new Error(`Zoho ${path} returned a different timeLogId; write outcome may be uncertain`);
    return expectedId === undefined ? id : undefined;
  }

  async function createLog(input: LogInput): Promise<string> {
    const fields = logFields(input, config);
    return rateLimit(writesRate, ZOHO_WRITE_INTERVAL_MS, sleep, async () => {
      const id = await writeLog("/timetracker/addtimelog", fields);
      if (typeof id !== "string") throw new Error("Zoho addtimelog returned no timeLogId; write outcome may be uncertain");
      return id;
    });
  }

  async function updateLog(id: string, input: LogInput): Promise<void> {
    if (!id) throw new Error("Zoho timelog id is required");
    await rateLimit(writesRate, ZOHO_WRITE_INTERVAL_MS, sleep, () => writeLog("/timetracker/edittimelog", { timeLogId: id, ...logFields(input, config) }, id));
  }

  async function deleteLog(id: string): Promise<void> {
    if (!id) throw new Error("Zoho timelog id is required");
    await rateLimit(writesRate, ZOHO_WRITE_INTERVAL_MS, sleep, async () => {
      const body = await zohoRequest(queryUrl("", "/timetracker/deletetimelog", { timeLogId: id }), {}, true);
      zohoStatus(body, "Zoho deletetimelog", secrets, true);
    });
  }

  return { validate: async () => { await listJobs(); }, listJobs, listLogs, getLog, createLog, updateLog, deleteLog };
}
