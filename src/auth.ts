import * as p from '@clack/prompts';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { ZOHO_REGIONS } from './api.ts';
import type { Config } from './types.ts';

const scopes = 'ZOHOPEOPLE.timetracker.ALL,ZOHOPEOPLE.forms.READ,AaaServer.profile.READ';
const redirect = 'http://localhost:8765/callback';
type SavedAuth = { region: string; refreshToken: string; employeeId: string };
function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error('Zoho setup cancelled.');
  return value as T;
}
export function authPath(config: Config): string {
  const key = createHash('sha256').update(JSON.stringify([config.zohoClientId, config.clockifyWorkspaceId, config.clockifyUserId])).digest('hex');
  return join(config.stateDir, `zoho-auth-${key}.json`);
}
export async function readAuth(config: Config): Promise<SavedAuth | undefined> {
  let text: string;
  try { text = await readFile(authPath(config), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let value: SavedAuth;
  try { value = JSON.parse(text); }
  catch { throw new Error('Saved Zoho authentication is invalid. Run zsync --connect to reconnect.'); }
  if (!value || !ZOHO_REGIONS[value.region] || typeof value.refreshToken !== 'string' || !value.refreshToken || typeof value.employeeId !== 'string')
    throw new Error('Saved Zoho authentication is invalid. Run zsync --connect to reconnect.');
  return value;
}
export async function saveAuth(config: Config, value: SavedAuth): Promise<void> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const path = authPath(config);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

// Never include response bodies or tokens in authentication errors.
async function request(url: string, init?: RequestInit): Promise<any> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error' }); }
  catch { throw new Error('Zoho authentication request failed. Check your connection and try again.'); }
  if (!response.ok) throw new Error(`Zoho authentication failed (HTTP ${response.status}). Check your region and client configuration.`);
  try { return await response.json(); }
  catch { throw new Error('Zoho returned an invalid authentication response.'); }
}
export function callbackCode(value: string, state: string): string {
  const url = new URL(value);
  if (url.origin !== new URL(redirect).origin || url.pathname !== '/callback' || url.searchParams.get('state') !== state)
    throw new Error('Authorization callback does not match this login attempt.');
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.has('error')) throw new Error('Zoho authorization was declined or returned no code.');
  return code;
}
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {}); // The URL is also displayed for manual opening.
  child.unref();
}

export async function listenForCallback(state: string, options: { port?: number; timeoutMs?: number; signal?: AbortSignal } = {}) {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach a handler before opening the browser, even if cancellation arrives immediately.
  void code.catch(() => {});
  let settled = false;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' || !req.url?.startsWith('/callback?')) {
      res.writeHead(404).end('Not found.'); return;
    }
    const url = new URL(req.url, redirect);
    if (settled || url.searchParams.get('state') !== state) {
      res.writeHead(400).end('This callback does not match the current login attempt.'); return;
    }
    try {
      const value = callbackCode(url.href, state);
      res.end('Authorization received. You can close this tab and return to zsync.');
      finish(undefined, value);
    } catch {
      res.writeHead(400).end('Authorization was declined. Return to zsync and try again.');
      finish(new Error('Zoho authorization was declined or returned no code.'));
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => finish(new Error('Zoho setup cancelled.'));
  function finish(error?: Error, value?: string) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    server.close();
    server.closeIdleConnections();
    if (error) rejectCode(error); else resolveCode(value!);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('Cannot open the Zoho callback listener. Port 8765 may be in use; close the other process and retry.')));
    server.listen(options.port ?? 8765, '127.0.0.1', resolve);
  });
  server.on('error', () => finish(new Error('Zoho callback listener failed. Please retry.')));
  timer = setTimeout(() => finish(new Error('Zoho sign-in timed out. Run zsync again to retry.')), options.timeoutMs ?? 300_000);
  options.signal?.addEventListener('abort', cancel, { once: true });
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const address = server.address();
  if (options.signal?.aborted) cancel();
  return { code, port: typeof address === 'object' && address ? address.port : 8765, cancel };
}

export async function connectZoho(config: Config, reconnect = false): Promise<Config> {
  const saved = reconnect ? undefined : await readAuth(config);
  const region = config.zohoRegion || saved?.region || 'com';
  const hosts = ZOHO_REGIONS[region];
  if (!hosts) throw new Error('Unsupported Zoho region.');
  const sameRegion = saved?.region === region;
  let refreshToken = reconnect ? '' : config.zohoRefreshToken || (sameRegion ? saved?.refreshToken : '') || '';
  let employeeId = reconnect ? '' : config.zohoEmployeeId || (sameRegion && !config.zohoRefreshToken ? saved?.employeeId : '') || '';
  if (refreshToken && employeeId) return { ...config, zohoRegion: region, zohoRefreshToken: refreshToken, zohoEmployeeId: employeeId };
  let accessToken: string;
  if (!refreshToken) {
    let code: string;
      const state = randomBytes(32).toString('hex');
      const url = `https://${hosts.accounts}/oauth/v2/auth?${new URLSearchParams({ client_id: config.zohoClientId,
        response_type: 'code', scope: scopes, redirect_uri: redirect, access_type: 'offline', prompt: 'consent', state })}`;
      const listener = await listenForCallback(state);
      try {
        p.log.info(`Complete sign-in in your browser.\n\n${url}`);
        openBrowser(url);
        code = await listener.code;
      } finally { listener.cancel(); }
    const tokens = await request(`https://${hosts.accounts}/oauth/v2/token`, { method: 'POST', body: new URLSearchParams({
      client_id: config.zohoClientId, client_secret: config.zohoClientSecret, grant_type: 'authorization_code', code,
      redirect_uri: redirect,
    }) });
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token)
      throw new Error('Zoho did not issue tokens. Check the client type, region, redirect URI, and code expiry, then retry.');
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
  } else {
    const tokens = await request(`https://${hosts.accounts}/oauth/v2/token`, { method: 'POST', body: new URLSearchParams({
      client_id: config.zohoClientId, client_secret: config.zohoClientSecret, grant_type: 'refresh_token', refresh_token: refreshToken,
    }) });
    if (typeof tokens.access_token !== 'string') throw new Error('Zoho authorization expired or was revoked. Run zsync --connect.');
    accessToken = tokens.access_token;
  }
  await saveAuth(config, { region, refreshToken, employeeId });
  if (!employeeId) {
    try {
    const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };
    const profile = await request(`https://${hosts.accounts}/oauth/user/info`, { headers });
    const email = profile.Email || profile.email;
    if (typeof email !== 'string' || !email) throw new Error('Zoho did not return your email. Reconnect with the profile scope.');
    const records = await request(`https://${hosts.people}/api/forms/employee/getRecords?${new URLSearchParams({ searchParams: JSON.stringify({ searchField: 'EmailID', searchOperator: 'Is', searchText: email }) })}`, { headers });
    employeeId = employeeRecordId(records, email);
    } catch {
      p.log.warn('Automatic employee lookup was unavailable. Enter your Zoho People employee record ID (ERECNO), not your display employee number.');
      employeeId = answer(await p.text({ message: 'Employee record ID', validate: value => /^\d+$/.test(value?.trim() ?? '') ? undefined : 'Enter the numeric employee record ID.' })).trim();
    }
  }
  await saveAuth(config, { region, refreshToken, employeeId });
  p.log.success('Zoho connected. Authentication saved for future runs.');
  return { ...config, zohoRegion: region, zohoRefreshToken: refreshToken, zohoEmployeeId: employeeId };
}

export function employeeRecordId(data: unknown, email: string): string {
  const ids = new Set<string>();
  function visit(value: any, recordKey?: string): void {
    if (!value || typeof value !== 'object') return;
    const entries = Object.entries(value);
    const matches = entries.some(([key, v]) => /^(emailid|email|employeemailalias)$/i.test(key) && typeof v === 'string' && v.toLowerCase() === email.toLowerCase());
    if (matches && recordKey) ids.add(recordKey);
    if (matches && !recordKey) for (const [key, id] of entries) {
      if (/^(recordid|erecno|zoho_id)$/i.test(key) && typeof id === 'string' && /^\d+$/.test(id)) ids.add(id);
    }
    for (const [key, child] of entries) visit(child, /^\d{10,}$/.test(key) ? key : recordKey);
  }
  visit(data);
  if (ids.size !== 1) throw new Error('Could not identify one matching People employee. Set ZOHO_EMPLOYEE_ID to your employee record ID or ask your administrator to check employee API access.');
  return [...ids][0]!;
}
