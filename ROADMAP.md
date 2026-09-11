# synczc roadmap

Build an interactive CLI that copies selected, completed Clockify entries into
Zoho People time logs. Clockify is the source of truth. Repeated runs should
recognize existing logs and avoid duplicates.

Use Bun, TypeScript, and `@clack/prompts`. Develop, install dependencies, build,
and test with Bun. The requested public command is `npx synczc`; verify package
runtime compatibility before release rather than assuming npx provides Bun.

## Implementation status

Implemented and tested locally. The packed executable runs on Node 22 without Bun.
Automated checks use fictional responses; real-account validation and publication
remain pending. Entries are copied whole to their local start date, without splitting.
Changed plans stop with instructions to rerun and review. Rate-limited requests fail
with an actionable error; uncertain writes are never automatically retried.

## User flow

1. Run `npx synczc`.
2. Select a date range, with Today selected by default:
   - Today
   - Yesterday
   - This week
   - Last week
   - This month
3. Fetch Clockify entries and determine their sync status.
4. Select entries with a multiselect showing Project, Tags, HH:MM, Description,
   and sync status. Include the date for ranges spanning multiple days.
   Unsynced entries start checked; previously synced entries start unchecked.
5. Resolve missing Zoho job mappings for selected entries and remember them.
6. Show the planned creates, updates, and skips. Ask “Do you want to commit?”
   with Yes selected by default. Require an explicit submission to proceed.
7. Commit the selection and report verified results, for example
   “✅ 10/10 entries synced.” Show individual failures when only part succeeds.

Cancellation or No exits without writing to Zoho. An empty selection exits cleanly.

## 1. Configuration and authentication

- [x] Read exported credentials from the process environment. Do not parse or
      source `~/.zshrc`; users launch the CLI from a shell where exports are loaded.
- [x] Support `CLOCKIFY_API_KEY`, `CLOCKIFY_USER_ID`, and
      `CLOCKIFY_WORKSPACE_ID`. Validate the configured identity and workspace.
- [x] Support `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and a documented
      `ZOHO_REFRESH_TOKEN` setup. Client ID and secret alone cannot authorize
      access to a user's timesheets.
- [x] Resolve the Zoho accounts/API region, People employee identity, and OAuth
      scopes needed to read jobs and read/create/update time logs.
- [x] Verify current official API schemas, pagination, permission requirements,
      time-log precision, and update restrictions before implementing requests.
- [x] Never print credentials, OAuth tokens, or authorization headers. Keep
      credentials out of tracked files and persisted sync state.

Done when both accounts can be read and missing configuration produces actionable,
redacted errors without creating any time logs.

## 2. Date ranges and Clockify entry selection

- [x] Resolve and display the user's timezone. Use calendar boundaries in that
      timezone, with Monday as the start of the week.
- [x] Treat Today, This week, and This month as beginning at their calendar
      boundary and ending now. Yesterday and Last week are complete periods.
- [x] Fetch every required page, including project and tag names for display.
- [x] Exclude running timers and explain their exclusion. Validate completed
      intervals and reject malformed or negative durations.
- [x] Define handling for entries crossing midnight or range boundaries before
      writing logs. If Zoho requires daily segments, give each segment a stable
      identity and ensure selecting another range cannot duplicate it.
- [x] Display duration as HH:MM and document how seconds are converted to Zoho's
      supported precision. Do not silently lose duration through truncation.
- [x] Build the Clack range selector and entry multiselect. Handle empty results,
      narrow terminals, cancellation, and terminal control characters in API text.

Done when the picker shows the complete eligible set for each range and clearly
identifies entries previously synced, changed, or needing attention.

## 3. Zoho job mapping and duplicate prevention

- [x] Fetch eligible Zoho People jobs. Match a Clockify project only when the
      destination is unambiguous; otherwise ask the user to select a job.
- [x] Handle entries without a Clockify project by asking for a destination job.
      Do not create Zoho projects or jobs implicitly.
- [x] Persist mappings and a sync ledger in the user's application-data directory,
      scoped to the Clockify workspace/user and Zoho region/OAuth client/employee.
- [x] Key ledger entries by Clockify entry ID. Store the Zoho log ID and last
      verified content snapshot. Keep project-to-job mappings separately.
- [x] Persist state atomically and prevent concurrent local sync processes from
      writing the same entries. Never silently reset a corrupt ledger.
- [x] Investigate a destination-side source-ID marker or idempotency mechanism.
      A local ledger alone cannot prevent duplicates after a write succeeds but
      the response or local save is lost.
- [x] Record pending writes before sending them. After a timeout or crash, locate
      and verify the destination log before another create. If the outcome cannot
      be resolved safely, require reconciliation instead of blindly retrying.
- [x] Label existing matches as synced and leave them unchecked. If selected,
      skip unchanged logs and update changed logs using their existing Zoho IDs.
- [x] Detect destination edits, missing logs, duplicate markers, and locked or
      approved records. Flag conflicts instead of overwriting or recreating silently.
- [x] Explain the boundary for pre-existing manually entered Zoho logs: never
      assume matching descriptions and durations prove identity. Require explicit
      reconciliation where overlap is suspected.

Done when reruns create no extra logs, selected changes update the same destination,
and uncertain writes remain blocked until their outcome is known.

## 4. Commit and results

- [x] Prepare the selected creates, updates, and skips before asking to commit.
- [x] Show any duration adjustments, split entries, or unresolved conflicts in the
      preview. Resolve mapping questions before this final confirmation.
- [x] Recheck affected source and destination records before writing; if the plan
      changed since confirmation, stop and present the revised plan.
- [x] Write sequentially with request timeouts and rate-limit handling. Retry
      writes only when their outcome is known to be safe to retry.
- [x] Refresh expired access tokens without exposing them. Preserve successful
      progress if subsequent requests fail.
- [x] Read back each written log and verify its job, employee, date, duration,
      description, and supported billing fields before recording success.
- [x] Report created, updated, unchanged, failed, and uncertain results separately.
      Return a nonzero exit status for failed or unresolved work.

Done when declining commits changes nothing upstream, partial success is accurately
reported, and rerunning after a failure safely resumes the remaining work.

## 5. Tests and package release

- [x] Use `bun test` with mocked API responses for date boundaries, fractional
      timezone offsets, daylight-saving changes, midnight crossings, and pagination.
- [x] Cover duplicate prevention, changed entries, wrong-account state, concurrent
      runs, expired tokens, and a successful remote create followed by a lost response.
- [x] Exercise the picker, cancellation, and confirmation flow in a terminal.
- [ ] Run an explicitly authorized end-to-end check with disposable entries in
      both services. Verify a second run adds no duplicates.
- [x] Add concise setup documentation and an example environment file containing
      placeholders only. Document OAuth setup, mappings, state location, precision,
      supported regions, and recovery from uncertain writes.
- [x] Verify npm package-name availability for `synczc` and configure its bin entry.
      Prefer a Node-compatible artifact built with Bun for the requested `npx`
      experience; test the package in an environment without Bun installed.
- [ ] Publish only when explicitly requested. Until then, validate the packaged CLI
      locally using Bun tooling.

## Outside the first release

No nightly scheduler, two-way sync, automatic deletion, automatic timesheet
submission/approval, web dashboard, or other Zoho products. Cross-machine concurrent
use is unsupported unless destination-side uniqueness is verified.

## References

- [Clockify API](https://docs.clockify.me/)
- [Zoho People time-log creation](https://www.zoho.com/people/api/timesheet/add-timelogs.html)
- [Clack](https://github.com/bombshell-dev/clack)
