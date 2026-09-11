import { pickEntries } from "./entry-picker.ts";
import * as p from '@clack/prompts';
import { createClockify, createZoho, loadConfig } from './api.ts';
import { openStore, prepare, commit } from './sync.ts';
import { cleanText, dateRange, entryInput, inRange, ranges } from './dates.ts';
import type { RangeName } from './dates.ts';
import { accountScope } from './types.ts';
import type { Entry, Job } from './types.ts';

class Cancelled extends Error {}
function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Cancelled();
  return value as T;
}
async function busy<T>(message: string, action: () => Promise<T>): Promise<T> {
  const spinner = p.spinner({ withGuide: false });
  spinner.start(message);
  try { return await action(); }
  finally { spinner.clear(); }
}
function automaticJob(entry: Entry, jobs: Job[]): string | undefined {
  if (!entry.projectId) return undefined;
  const matches = jobs.filter(job => job.projectName === entry.projectName || job.name === entry.projectName);
  return matches.length === 1 ? matches[0]!.id : undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`synczc — sync selected Clockify entries to Zoho People\n\nUsage: synczc [--demo | --help | --version]\n\nChoose a date range, select entries, review mappings, then confirm.\nExisting logs are unchecked by default. No background automation.\n\nRequired environment:\n  CLOCKIFY_API_KEY, CLOCKIFY_USER_ID, CLOCKIFY_WORKSPACE_ID\n  ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN\n  ZOHO_EMPLOYEE_ID (employee record ID), ZOHO_REGION\nOptional: SYNCZC_TIMEZONE, SYNCZC_STATE_DIR, ZOHO_DATE_FORMAT\n\n--demo uses fictional data and never contacts either service.`);
    return;
  }
  if (argv.includes('--version')) { console.log('0.1.0'); return; }
  if (argv.some(arg => arg !== '--demo')) throw new Error('Unknown argument. Run synczc --help.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('synczc needs an interactive terminal. Run synczc --help for setup.');
  p.intro('synczc · Clockify → Zoho People');
  const demo = argv.includes('--demo') ? await import('./demo.ts').then(m => m.demoServices()) : undefined;
  const config = demo?.config ?? loadConfig();
  const clockify = demo?.clockify ?? createClockify(config);
  const zoho = demo?.zoho ?? createZoho(config);
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  try {
    if (demo) p.log.warn('Demo only: fictional entries; no external requests or writes.');
    const name = answer(await p.select<RangeName>({ message: 'Which entries do you want to sync?', options: [...ranges], initialValue: 'today' }));
    const range = dateRange(name, config.timezone);
    await busy('Checking accounts', async () => { await clockify.validate(); await zoho.validate(); });
    const entries = (await busy('Fetching Clockify entries', () => clockify.listEntries(range.start, range.end)))
      .filter(entry => inRange(entry, range)).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    if (!entries.length) { p.outro('No completed entries in this period.'); return; }
    const scope = accountScope(config);
    store = await openStore(config.stateDir, scope);
    const jobs = await busy('Fetching Zoho People jobs', () => zoho.listJobs());
    if (!jobs.length) throw new Error('No eligible Zoho jobs. Ask your People administrator to assign a job first.');
    const jobFor = (entry: Entry) => {
      const saved = store!.mappings[entry.projectId ?? '(no project)'];
      return jobs.some(job => job.id === saved) ? saved : automaticJob(entry, jobs);
    };
    const makeInputs = (items: Entry[]) => items.map(entry => ({ key: entry.id,
      input: entryInput(entry, jobFor(entry) ?? '__unmapped__', config.zohoEmployeeId, config.timezone) }));
    const initialPlan = await busy('Checking sync status', () => prepare(store!, zoho, makeInputs(entries)));
    const initialByKey = new Map(initialPlan.map(item => [item.key, item]));
    const selectedIds = answer(await pickEntries(entries.map(entry => {
      const item = initialByKey.get(entry.id)!;
      return { entry, input: item.input,
        status: item.status === "create" ? "new" : item.status === "skip" ? "synced" : item.status === "update" ? "changed" : "conflict",
        reason: item.reason ?? (!jobFor(entry) ? "Choose a Zoho job after selection" : undefined) };
    })));
    const selected = entries.filter(entry => selectedIds.includes(entry.id));
    if (!selected.length) { p.outro('Nothing selected. No Zoho changes.'); return; }
    for (const entry of selected) {
      const key = entry.projectId ?? '(no project)';
      if (!jobFor(entry)) {
        store.mappings[key] = answer(await p.select({ message: `Zoho job for ${cleanText(entry.projectName || 'entries without a project')}?`,
          options: jobs.map(job => ({ value: job.id, label: cleanText(`${job.projectName ? job.projectName + ' / ' : ''}${job.name}`), hint: job.id })) }));
      } else store.mappings[key] = jobFor(entry)!;
    }
    await store.saveMappings();
    const plan = await busy('Preparing commit', () => prepare(store!, zoho, makeInputs(selected)));
    const conflicts = plan.filter(item => item.status === 'conflict');
    if (conflicts.length) {
      for (const item of conflicts) p.log.error(`${item.key}: ${cleanText(item.reason ?? 'Needs reconciliation')}`);
      throw new Error('Resolve the conflicts or deselect those entries, then rerun. No selected logs were written.');
    }
    const confirmed = answer(await p.select({ message: 'Do you want to commit?', initialValue: true,
      options: [{ value: true, label: 'Yes' }, { value: false, label: 'No' }] }));
    if (!confirmed) { p.outro('Cancelled. No Zoho changes.'); return; }
    const fresh = await busy('Rechecking Clockify entries', () => clockify.listEntries(range.start, range.end));
    for (const entry of selected) {
      const current = fresh.find(item => item.id === entry.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(entry)) throw new Error(`Clockify entry ${entry.id} changed. Rerun to review the updated plan; no writes made.`);
    }
    const results = await busy('Syncing selected entries', () => commit(store!, zoho, plan));
    for (const result of results.filter(item => item.status === 'failed' || item.status === 'uncertain')) {
      p.log.error(`${result.key}: ${result.status} — ${cleanText(result.message ?? 'Check sync state before retrying.')}`);
    }
    if (results.some(item => item.status === 'failed' || item.status === 'uncertain')) process.exitCode = 1;
    const icons = { created: '✅', updated: '🔄', skipped: '⏭️', failed: '❌', uncertain: '⚠️' };
    p.outro(Object.entries(icons).flatMap(([status, icon]) => {
      const count = results.filter(item => item.status === status).length;
      return count ? [`${icon} ${count} ${status}`] : [];
    }).join(' · '));
  } catch (error) {
    if (error instanceof Cancelled) p.cancel('Cancelled. No further changes will be made.');
    else throw error;
  } finally {
    await store?.close();
    await demo?.cleanup();
  }
}
