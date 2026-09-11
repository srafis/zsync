import { accountScope } from './types.ts';
import { createHash } from 'node:crypto';
import type { Config, Destination, RemoteLog } from './types.ts';

export type Deletion = { log: RemoteLog; entryId: string };
type Source = { entryExists(id: string): Promise<boolean | null> };
type DeleteDestination = Pick<Destination, 'getLog'> & { deleteLog(id: string): Promise<void> };

// Only our fixed, JSON-quoted YAML fields are read here; arbitrary YAML is not accepted.
function field(description: string, name: string): string | undefined {
  try {
    const metadata = JSON.parse(description.replace(/\n\n\[zsync-source:[a-f0-9]{64}\]$/, ''));
    return typeof metadata?.[name] === 'string' ? metadata[name] : undefined;
  } catch { /* Read our fixed YAML format below. */ }
  if (name === 'source' && description.startsWith('source: Clockify\n')) return 'Clockify';
  const lines = description.split('\n').filter(line => line.startsWith(`${name}: `));
  if (lines.length !== 1) return undefined;
  try {
    const value = JSON.parse(lines[0]!.slice(name.length + 2));
    return typeof value === 'string' && value ? value : undefined;
  } catch { return undefined; }
}

export async function findDeletions(logs: RemoteLog[], source: Source, config: Config): Promise<Deletion[]> {
  const candidates: Deletion[] = [];
  for (const log of logs) {
    if (log.locked || log.employeeId !== config.zohoEmployeeId ||
        field(log.description, 'source') !== 'Clockify' ||
        (field(log.description, 'workspaceId') !== undefined && field(log.description, 'workspaceId') !== config.clockifyWorkspaceId) ||
        (field(log.description, 'userId') !== undefined && field(log.description, 'userId') !== config.clockifyUserId)) continue;
    const entryId = field(log.description, 'entryId');
    if (!entryId) continue;
    const markers = ['', accountScope(config)].map(scope => createHash('sha256').update(scope).update('\0').update(entryId).digest('hex'));
    if (!markers.some(marker => log.description.endsWith(`\n\n[zsync-source:${marker}]`))) continue;
    if (await source.entryExists(entryId) === false) candidates.push({ log: { ...log }, entryId });
  }
  return candidates;
}

export async function deleteConfirmed(item: Deletion, source: Source, destination: DeleteDestination): Promise<void> {
  const current = await destination.getLog(item.log.id);
  if (!current) throw new Error('Zoho entry is already absent; refresh the list.');
  if (current.locked || JSON.stringify(current) !== JSON.stringify(item.log))
    throw new Error('Zoho entry changed after review; refresh the list.');
  if (await source.entryExists(item.entryId) !== false) throw new Error('Clockify entry exists or its deletion cannot be confirmed; deletion cancelled.');
  let failure: unknown;
  try { await destination.deleteLog(item.log.id); } catch (error) { failure = error; }
  // Read back even after a timeout. Never retry a deletion automatically.
  if (await destination.getLog(item.log.id) !== null)
    throw failure ?? new Error('Deletion was not verified. Check Zoho before retrying.');
}
