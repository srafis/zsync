export type Entry = { id: string; projectId: string | null; projectName: string; tags: string[]; description: string; start: string; end: string; billable: boolean };
export type Job = { id: string; name: string; projectName?: string };
export type LogInput = { jobId: string; employeeId: string; date: string; minutes: number; description: string; billable: boolean };
export type RemoteLog = LogInput & { id: string; locked?: boolean };
export type Destination = { listLogs(from: string, to: string): Promise<RemoteLog[]>; getLog(id: string): Promise<RemoteLog | null>; createLog(input: LogInput): Promise<string>; updateLog(id: string, input: LogInput): Promise<void> };
export type Config = { clockifyKey: string; clockifyWorkspaceId: string; clockifyUserId: string; zohoClientId: string; zohoClientSecret: string; zohoRefreshToken: string; zohoRegion: string; zohoDateFormat?: string; zohoEmployeeId: string; timezone: string; stateDir: string };
// A definite rejection is safe to retry after correcting its cause; transport failures are not.
export class RejectedWriteError extends Error {}
export function accountScope(config: Config): string {
  return JSON.stringify([config.clockifyWorkspaceId, config.clockifyUserId, config.zohoRegion, config.zohoClientId, config.zohoEmployeeId]);
}
