import { describe, expect, test } from "bun:test";
import type { Config } from "./types.ts";
import { createClockify, createZoho, loadConfig } from "./api.ts";

const config: Config = {
  clockifyKey: "clockify-secret",
  clockifyWorkspaceId: "workspace",
  clockifyUserId: "user",
  zohoClientId: "client-id",
  zohoClientSecret: "client-secret",
  zohoRefreshToken: "refresh-secret",
  zohoRegion: "in",
  zohoEmployeeId: "employee",
  timezone: "Asia/Kolkata",
  stateDir: "/tmp/zsync-test",
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("configuration", () => {
  test("requires credentials and uses explicit local overrides", () => {
    const env = {
      CLOCKIFY_API_KEY: "key",
      CLOCKIFY_USER_ID: "user",
      CLOCKIFY_WORKSPACE_ID: "workspace",
      ZOHO_CLIENT_ID: "id",
      ZOHO_CLIENT_SECRET: "secret",
      ZOHO_REFRESH_TOKEN: "refresh",
      ZOHO_REGION: "EU",
      ZOHO_EMPLOYEE_ID: "employee",
      ZSYNC_TIMEZONE: "UTC",
      ZSYNC_STATE_DIR: "/tmp/custom",
    };
    const loaded = loadConfig(env);
    expect(loaded.zohoRegion).toBe("eu");
    expect(loaded.zohoDateFormat).toBe("yyyy-MM-dd");
    expect(loaded.timezone).toBe("UTC");
    expect(loaded.stateDir).toBe("/tmp/custom");
    expect(() => loadConfig({})).toThrow("CLOCKIFY_API_KEY");
    expect(() => loadConfig({ ...env, ZOHO_REGION: "invalid" })).toThrow("ZOHO_REGION");
    expect(() => loadConfig({ ...env, ZOHO_DATE_FORMAT: "bad" })).toThrow("ZOHO_DATE_FORMAT");
  });
});

describe("Clockify client", () => {
  test("maps hydrated names, paginates, and excludes running entries", async () => {
    const completed = (id: string) => ({ id, userId: "user", projectId: "project", tagIds: ["tag"], description: "work", billable: true, timeInterval: { start: "2026-09-10T10:00:00Z", end: "2026-09-10T11:00:00Z" } });
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/projects")) return json(url.includes("page=1") ? [{ id: "project", name: "Project name" }] : []);
      if (url.includes("/tags")) return json(url.includes("page=1") ? [{ id: "tag", name: "Tag name" }] : []);
      if (url.includes("page=1")) return json(Array.from({ length: 200 }, (_, index) => completed(`entry-${index}`)));
      return json([{ id: "running", userId: "user", projectId: "project", tagIds: [], description: "running", billable: false, timeInterval: { start: "2026-09-10T12:00:00Z", end: null } }]);
    };
    const entries = await createClockify(config, { fetch: fetcher }).listEntries("2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z");
    expect(entries).toHaveLength(200);
    expect(entries[0]).toMatchObject({ projectName: "Project name", tags: ["Tag name"] });
  });
});

describe("Zoho client", () => {
  test("refreshes once, paginates jobs and logs, and preserves descriptions", async () => {
    let tokenCalls = 0;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/v2/token")) {
        tokenCalls += 1;
        expect(init?.method).toBe("POST");
        return json({ access_token: "access", expires_in: 3600 });
      }
      if (url.includes("getjobs")) {
        const index = new URL(url).searchParams.get("sIndex");
        const rows = index === "0" ? Array.from({ length: 200 }, (_, i) => ({ jobId: `job-${i}`, jobName: `Job ${i}` })) : [{ jobId: "job-last", jobName: "Last job", projectName: "Project" }];
        return json({ response: { status: 0, result: rows, isNextAvailable: index === "0" } });
      }
      const index = new URL(url).searchParams.get("sIndex");
      const rows = [{ erecno: "employee", timelogId: index === "0" ? "log-1" : "log-2", jobId: "job-1", workDate: "2026-09-10", hours: "01:30", totaltime: 5400, billingStatus: "billable", description: "[zsync:entry-1] work" }];
      return json({ response: { status: 0, result: rows, isNextAvailable: false } });
    };
    const zoho = createZoho(config, { fetch: fetcher, sleep: async () => {} });
    expect((await zoho.listJobs())).toHaveLength(201);
    expect(await zoho.listLogs("2026-09-10", "2026-09-10")).toMatchObject([{ employeeId: "employee", minutes: 90, description: "[zsync:entry-1] work" }]);
    expect(tokenCalls).toBe(1);
  });

  test("uses documented form fields for single-shot writes and handles API errors in HTTP 200", async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/v2/token")) return json({ access_token: "access", expires_in: 3600 });
      calls.push({ url, method: init?.method, body: String(init?.body) });
      if (url.includes("edittimelog")) return json({ response: { status: 0, result: [{ timeLogId: "log-1" }] } });
      return json({ response: { status: 0, result: [{ timeLogId: "log-1" }] } });
    };
    const zoho = createZoho(config, { fetch: fetcher, sleep: async () => {} });
    const input = { employeeId: "employee", jobId: "job-1", date: "2026-09-10", minutes: 90, description: "[zsync:entry-1] work", billable: true };
    expect(await zoho.createLog(input)).toBe("log-1");
    await zoho.updateLog("log-1", input);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).not.toContain("refresh-secret");
    expect(calls[0]!.body).toContain("user=employee");
    expect(calls[0]!.body).toContain("jobId=job-1");
    expect(calls[0]!.body).toContain("hours=01%3A30");
    expect(calls[0]!.body).toContain("description=%5Bzsync%3Aentry-1%5D+work");
    const errorFetcher = async (input: string | URL | Request) => String(input).includes("/oauth/v2/token") ? json({ access_token: "access", expires_in: 3600 }) : json({ response: { status: 1, message: "Permission denied" } });
    const failing = createZoho(config, { fetch: errorFetcher, sleep: async () => {} });
    await expect(failing.createLog(input)).rejects.toThrow("Permission denied");
  });

  test("parses the configured company date format without guessing day/month order", async () => {
    const fetcher = async (input: string | URL | Request) => String(input).includes("/oauth/v2/token")
      ? json({ access_token: "access", expires_in: 3600 })
      : json({ response: { status: 0, result: [{ erecno: "employee", timelogId: "log-1", jobId: "job-1", workDate: "09/10/2026", hours: "01:00", billingStatus: "billable", description: "" }] } });
    const usDate = createZoho({ ...config, zohoDateFormat: "MM/dd/yyyy" }, { fetch: fetcher, sleep: async () => {} });
    const euDate = createZoho({ ...config, zohoDateFormat: "dd/MM/yyyy" }, { fetch: async (input) => String(input).includes("/oauth/v2/token") ? json({ access_token: "access", expires_in: 3600 }) : json({ response: { status: 0, result: [{ erecno: "employee", timelogId: "log-1", jobId: "job-1", workDate: "10/09/2026", hours: "01:00", billingStatus: "billable", description: "" }] } }), sleep: async () => {} });
    expect((await usDate.listLogs("2026-09-10", "2026-09-10"))[0]!.date).toBe("2026-09-10");
    expect((await euDate.listLogs("2026-09-10", "2026-09-10"))[0]!.date).toBe("2026-09-10");
  });
});

test("expired read token refreshes once; returned access tokens are redacted", async () => {
  let tokens = 0;
  let reads = 0;
  const zoho = createZoho(config, { sleep: async () => {}, fetch: async url => {
    if (String(url).includes("/oauth/v2/token")) return json({ access_token: `private-token-${++tokens}`, expires_in: 3600 });
    if (++reads === 1) return json({}, 401);
    return json({ response: { status: 1, message: "Invalid private-token-2" } });
  } });
  await expect(zoho.listJobs()).rejects.toThrow("Invalid [redacted]");
  expect(tokens).toBe(2);
  expect(reads).toBe(2);
});

test('Clockify timezone-shifted filters cannot omit entries inside the requested range', async () => {
  const rows = ['2026-09-10T17:00:00Z', '2026-09-11T11:00:00Z', '2026-09-11T13:00:00Z', '2026-09-11T19:00:00Z'].map((start, index) => ({
    id: String(index), userId: 'user', projectId: null, tagIds: [], description: '', billable: false,
    timeInterval: { start, end: new Date(Date.parse(start) + 3600000).toISOString() },
  }));
  const client = createClockify(config, { fetch: async input => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/time-entries')) return json([]);
    const shift = 5.5 * 3600000;
    const start = Date.parse(url.searchParams.get('start')!) - shift;
    const end = Date.parse(url.searchParams.get('end')!) - shift;
    return json(rows.filter(row => Date.parse(row.timeInterval.start) >= start && Date.parse(row.timeInterval.start) < end));
  } });
  expect((await client.listEntries('2026-09-10T18:30:00Z', '2026-09-11T17:00:00Z')).map(row => row.id)).toEqual(['1', '2']);
});

test('Zoho writes workItem separately and reads it from taskName', async () => {
  const title = 'Weekly meeting';
  const metadata = '{"entryId":"clockify-1"}';
  const zoho = createZoho(config, { sleep: async () => {}, fetch: async (url, init) => {
    if (String(url).includes('/oauth/v2/token')) return json({ access_token: 'token', expires_in: 3600 });
    if (init?.method === 'POST') {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('workItem')).toBe(title);
      expect(form.get('description')).toBe(metadata);
      return json({ response: { status: 0, result: [{ timeLogId: 'log' }] } });
    }
    return json({ response: { status: 0, result: [{ timelogId: 'log', erecno: 'employee', jobId: 'job', workDate: '2026-09-11', hours: '01:00', billingStatus: 'billable', taskName: title, description: metadata }] } });
  } });
  const input = { employeeId: 'employee', jobId: 'job', date: '2026-09-11', minutes: 60, billable: true, workItem: title, description: metadata };
  await zoho.createLog(input);
  await zoho.updateLog('log', input);
  expect(await zoho.getLog('log')).toMatchObject({ workItem: title, description: metadata });
});
