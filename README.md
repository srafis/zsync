# synczc

An interactive Clockify → Zoho People time-log sync. Choose a period, select
entries, map projects to jobs, review the changes, and confirm. No scheduler.

## Run locally

```sh
bun install
bun run dev --help
bun run dev --demo
bun run dev
```

Develop and test with Bun. The package builds a Node 22+ executable for the planned
`npx synczc` command; Bun is not required to run the published artifact. The package
has not been published by this implementation.

```sh
bun run typecheck
bun test
bun run build
bun pm pack
```

## Credentials

Use the variables in [.env.example](.env.example). Export them in the shell before
running the CLI. Exports from `~/.zshrc` work when inherited by the process; the CLI
never reads or executes your shell configuration. Bun loads a project `.env` during
development; the built Node executable expects exported environment variables.

Clockify uses its global API endpoint; regional Clockify workspaces are not yet
supported. It requires an API key, workspace ID, and user ID. The configured user must
match the authenticated account. API keys are available in Clockify profile settings.

Zoho People requires an OAuth client ID, client secret, refresh token, region, and
employee record ID. Set `ZOHO_DATE_FORMAT` to the company date format when
Zoho returns non-ISO dates, for example `dd-MM-yyyy` or `MM/dd/yyyy`. The CLI must
not guess whether a date such as 04/05 means April 5 or May 4. Client credentials alone do not authorize access to timesheets.
Create a client in your region's Zoho API Console and authorize the People
`ZOHOPEOPLE.timetracker.ALL` scope, then exchange the authorization code for a refresh
token using Zoho's documented OAuth flow. Do this privately; do not paste tokens into
issues, logs, or screenshots. Use an employee record ID, also called ERECNO, rather
than assuming the visible employee number is the same value.

- [Zoho People OAuth setup](https://www.zoho.com/people/api/oauth-steps.html)
- [Zoho People time-log API](https://www.zoho.com/people/api/timesheet/add-timelogs.html)
- [Clockify API](https://docs.clockify.me/)

The CLI refreshes access tokens in memory. Sync state contains mappings and time-log
snapshots, but never stores OAuth credentials. Treat the state directory as private
because descriptions can contain work information.

## Selection and mapping

The range menu contains Today, Yesterday, This week, Last week, and This month.
Weeks start on Monday. Current periods stop at the time the CLI starts; completed
periods use local calendar boundaries. Set `SYNCZC_TIMEZONE` to an IANA timezone if
the machine's timezone differs from yours.

Completed entries are assigned to their **local start date**. An entry beginning
before midnight and ending afterward is copied whole to its start date. Entries
longer than 24 hours or rounding to zero minutes are rejected for correction in
Clockify. Running timers are excluded. Durations round to the nearest minute, and
the preview shows the duration sent to Zoho. Original Clockify tags appear in the
picker but are not copied into an unrelated Zoho field.

Unsynced entries start checked. Synced entries, including changed ones, start
unchecked. Selecting an unchanged entry skips it; selecting a changed entry updates
its existing Zoho log when safe. If a Clockify project has exactly one matching
Zoho project/job name, that job is used. Otherwise, select the job explicitly.
Mappings are remembered per account. No Zoho jobs or projects are created.

The entry table fits the terminal width and truncates long cells with an ellipsis.
Date appears from 90 columns and Tags from 110 columns. The selected rows remain visible above the final confirmation.

Use Space to toggle entries and Enter to continue. The final Yes/No prompt requires
submission even though Yes is initially selected. No and cancellation make no Zoho
writes; local job mappings may already have been saved.

## Reruns and recovery

Each synced log carries a source marker in its description. Keep that marker intact.
A scoped local ledger records the destination ID and last verified content. The
CLI checks destination state before writing and reads back changes before declaring
success. A local exclusive lock prevents two instances from sharing the ledger.

A network timeout does not prove that a create failed. Pending writes are saved
before requests; on a later run, the CLI looks for the source marker and verifies
the destination. If it cannot determine the outcome, it refuses another create.
Manual destination changes, missing mapped logs, duplicate markers, or approved/
locked logs can require reconciliation. Resolve conflicts in the source/destination
and rerun; do not delete the state directory merely to force a retry.

If a process crashes and leaves a lock, ensure no synczc process is running before
removing only the lock named in the error. Preserve the ledger and pending records.
Do not run against the same destination concurrently from different machines or
state directories. Destination-side uniqueness is not guaranteed by these APIs.
Pre-existing manual Zoho logs lack source IDs; apparent matches require explicit
reconciliation, not automatic adoption.

Clockify remains the source of truth. This tool does not delete destination logs,
submit or approve timesheets, or synchronize Zoho edits back to Clockify. Zoho
workspace rules can reject time outside attendance, leave, allowed dates, or job
permissions. Failures are reported per entry and cause a nonzero exit status.

## Before first real sync

Run `--demo` to inspect the flow without credentials or network calls. Then use a
small authorized selection and verify its destination in Zoho People. Live API
behavior and organization policies must be checked in your own account; automated
tests use fictional responses and never create actual time logs.

Default state directories are `~/.local/share/synczc` on Linux (or under
`XDG_DATA_HOME`), `~/Library/Application Support/synczc` on macOS, and
`%APPDATA%/synczc` on Windows. Changing the OAuth client or employee changes the
account scope; reconcile existing logs before using a different scope for the same
source entries. Supported Zoho region codes are `com`, `eu`, `in`, `au`, `cn`, `jp`,
`ca`, `sa`, and `uk`; availability and permissions depend on your People account.
