# zsync

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
`npx @srafis/zsync` command; Bun is not required to run the published artifact. The package
has not been published by this implementation.

After publication, run `npx @srafis/zsync`, or install with
`npm i -g @srafis/zsync` and run `zsync`.

## Publishing

The `publish.yml` GitHub Actions workflow tests and publishes every push to `main`.
Add a repository Actions secret named `NPM_TOKEN` containing an npm granular
access token with permission to publish `@srafis/zsync` and bypass 2FA for CI.
Keep the token in GitHub Secrets, never in this repository.

The release patch is the package.json patch plus the GitHub workflow run number
(starting at `0.1.1`). The version changes only in CI; no release commits are made.
Rerunning a published version skips publication. Bump the major/minor in
package.json when needed. The npm scope must belong to your account or organization.

The CLI uses the `zsync` state directory and `ZSYNC_*` overrides.

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

Only five shell exports are required: `CLOCKIFY_API_KEY`, `CLOCKIFY_USER_ID`,
`CLOCKIFY_WORKSPACE_ID`, `ZOHO_CLIENT_ID`, and `ZOHO_CLIENT_SECRET`.

On first run, browser authorization starts automatically. The default data center
is `people.zoho.com`; `ZOHO_REGION` remains an optional override.
Register `http://localhost:8765/callback` in your server-based OAuth client once.
The CLI starts a temporary loopback listener and opens the consent URL. After
authorization, the CLI continues automatically. The listener closes after the
callback, cancellation, or a five-minute timeout. Port 8765 must be available.

The CLI requests `ZOHOPEOPLE.timetracker.ALL`, `ZOHOPEOPLE.forms.READ`, and
`AaaServer.profile.READ`. It exchanges the code, looks up your People employee
record using your email, and saves the refresh token, region, and employee ID.
If employee lookup is unavailable, it asks for the numeric employee record ID
(ERECNO). Later runs reuse the saved authentication without additional exports.
Run `bun run dev --connect` to reconnect; saved job preferences are preserved.

Existing `ZOHO_REFRESH_TOKEN`, `ZOHO_REGION`, and `ZOHO_EMPLOYEE_ID` exports
remain optional overrides. Set `ZOHO_DATE_FORMAT` when your company returns
non-ISO dates, for example `dd-MM-yyyy` or `MM/dd/yyyy`.

- [Zoho People OAuth setup](https://www.zoho.com/people/api/oauth-steps.html)
- [Zoho People time-log API](https://www.zoho.com/people/api/timesheet/add-timelogs.html)
- [Clockify API](https://docs.clockify.me/)

The CLI refreshes access tokens in memory. Local preferences contain project/job mappings. A separate account-scoped authentication file stores the refresh token
with owner-only file permissions (0600); client secrets are never saved. Protect
the state directory because it now contains authentication and work information.

## Selection and mapping

The range menu contains Today, Yesterday, This week, Last week, and This month.
Weeks start on Monday. Current periods stop at the time the CLI starts; completed
periods use local calendar boundaries. Set `ZSYNC_TIMEZONE` to an IANA timezone if
the machine's timezone differs from yours.

Completed entries are assigned to their **local start date**. An entry beginning
before midnight and ending afterward is copied whole to its start date. Entries
longer than 24 hours or rounding to zero minutes are rejected for correction in
Clockify. Running timers are excluded. Durations round to the nearest minute, and
the preview shows the duration sent to Zoho. Clockify descriptions become Zoho
Work Items. Zoho Description stores JSON source metadata: the exact Clockify entry
ID, project name/ID, tags, original start/end timestamps, and billing flag, followed
by the existing sync marker. Metadata contains no credentials.

Older synced entries remain unchecked. Select one to move its title into Work Item
and replace its Description with metadata, updating the existing Zoho log. Selected entries overwrite differing destination fields with Clockify values.

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

Sync status comes from metadata in Zoho Description, using the exact Clockify
entry ID. Matching logs start unchecked; selecting a changed entry updates its
existing log. Deleting a Zoho log makes the Clockify entry new and checked again.
Duplicate source IDs and locked logs are conflicts. Unmarked manual logs do not
count as synced, even if their titles and durations match.

Only authentication and project/job preferences are stored locally. Existing
legacy state files supply job preferences only; their ledger, pending writes, and
lock are ignored. New writes store preferences in `zsync-preferences-*.json`.
Legacy marker-only logs are recognized with their original account scope; logs
containing the exact entry ID work across machines and OAuth clients.

The CLI rechecks Zoho before committing and verifies each write. A timed-out write
is reconciled using remote metadata, never blindly retried in the same run. If
verification remains uncertain, inspect Zoho before rerunning. No persistent pending
queue or concurrent-execution protection is provided.

Lookup covers the selected entries' date span. If a previously synced entry moves
to a different date outside that span, reconcile the old Zoho log before syncing
again. Do not run syncs simultaneously on multiple machines.

Clockify remains the source of truth. This tool does not delete destination logs,
submit or approve timesheets, or synchronize Zoho edits back to Clockify. Zoho
workspace rules can reject time outside attendance, leave, allowed dates, or job
permissions. Failures are reported per entry and cause a nonzero exit status.

## Before first real sync

Run `--demo` to inspect the flow without credentials or network calls. Then use a
small authorized selection and verify its destination in Zoho People. Live API
behavior and organization policies must be checked in your own account; automated
tests use fictional responses and never create actual time logs.

Default state directories are `~/.local/share/zsync` on Linux (or under
`XDG_DATA_HOME`), `~/Library/Application Support/zsync` on macOS, and
`%APPDATA%/zsync` on Windows. Changing the OAuth client or employee changes the
account scope for local preferences. Exact entry IDs in remote metadata still
identify synced entries across OAuth clients. Supported Zoho region codes are `com`, `eu`, `in`, `au`, `cn`, `jp`,
`ca`, `sa`, and `uk`; availability and permissions depend on your People account.
