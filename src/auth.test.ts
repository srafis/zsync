import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authPath, callbackCode, connectZoho, employeeRecordId, readAuth, saveAuth } from './auth.ts';
import { loadConfig } from './api.ts';

test('five shell variables suffice; private saved auth completes subsequent runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zsync-auth-test-'));
  const config = loadConfig({ CLOCKIFY_API_KEY: 'key', CLOCKIFY_USER_ID: 'user', CLOCKIFY_WORKSPACE_ID: 'workspace',
    ZOHO_CLIENT_ID: 'client', ZOHO_CLIENT_SECRET: 'secret', ZSYNC_STATE_DIR: directory });
  try {
    expect(config.zohoRefreshToken).toBe('');
    expect(await readAuth(config)).toBeUndefined();
    await saveAuth(config, { region: 'in', refreshToken: 'private-token', employeeId: '123' });
    expect((await stat(authPath(config))).mode & 0o777).toBe(0o600);
    expect(await connectZoho(config)).toMatchObject({ zohoRegion: 'in', zohoRefreshToken: 'private-token', zohoEmployeeId: '123' });
    expect(await readAuth({ ...config, zohoClientId: 'different' })).toBeUndefined();
    await writeFile(authPath(config), 'corrupt-private-token');
    await expect(readAuth(config)).rejects.toThrow('Run zsync --connect');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('callback rejects wrong state, foreign redirect, and denied consent', () => {
  expect(callbackCode('http://localhost:8765/callback?state=one&code=code', 'one')).toBe('code');
  for (const url of ['http://localhost:8765/callback?state=two&code=code', 'https://evil.test/callback?state=one&code=code', 'http://localhost:8765/callback?state=one&error=denied'])
    expect(() => callbackCode(url, 'one')).toThrow();
});
test('employee discovery preserves large IDs and rejects ambiguous matches', () => {
  const data = { response: { result: [{ '759415000001146009': [{ EmailID: 'me@example.com', Zoho_ID: 759415000001146009 }] }] } };
  expect(employeeRecordId(data, 'ME@example.com')).toBe('759415000001146009');
  expect(() => employeeRecordId(data, 'someone@example.com')).toThrow();
  expect(() => employeeRecordId([{ EmailID: 'me@example.com', recordId: '123' }, { EmailID: 'me@example.com', recordId: '456' }], 'me@example.com')).toThrow();
});

test('loopback listener ignores foreign state, accepts callback, and closes', async () => {
  const { listenForCallback } = await import('./auth.ts');
  const listener = await listenForCallback('expected', { port: 0 });
  const base = `http://127.0.0.1:${listener.port}`;
  try {
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${base}/callback?state=wrong&code=secret`)).status).toBe(400);
    const response = await fetch(`${base}/callback?state=expected&code=secret`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('secret');
    expect(await listener.code).toBe('secret');
  } finally { listener.cancel(); }
});

test('callback listener handles denial, cancellation, and timeout', async () => {
  const { listenForCallback } = await import('./auth.ts');
  const denied = await listenForCallback('state', { port: 0 });
  await fetch(`http://127.0.0.1:${denied.port}/callback?state=state&error=access_denied`);
  await expect(denied.code).rejects.toThrow('declined');
  const cancelled = await listenForCallback('state', { port: 0 });
  cancelled.cancel();
  await expect(cancelled.code).rejects.toThrow('cancelled');
  const timeout = await listenForCallback('state', { port: 0, timeoutMs: 10 });
  await expect(timeout.code).rejects.toThrow('timed out');
});
