#!/usr/bin/env node
import { main } from './src/cli.ts';
import { cleanText } from './src/dates.ts';

main().catch(error => {
  let message = error instanceof Error ? error.message : 'Sync failed.';
  for (const name of ['CLOCKIFY_API_KEY', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN']) {
    const value = process.env[name];
    if (value) message = message.split(value).join('[redacted]');
  }
  console.error(cleanText(message));
  process.exitCode = 1;
});
