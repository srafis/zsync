# zsync

Keep tracking time in Clockify and sync your entries to Zoho People when you're ready.

zsync is a terminal app for people who want to keep using their personal Clockify workspace while maintaining their work timesheet in Zoho. It offers another way to log time alongside the Zoho Chrome extension: use the Clockify interface you already know, then choose which completed entries to copy across.

Each run lets you select a period, pick new, changed or deleted entries, map Clockify projects to Zoho jobs, and confirm the sync. Nothing runs in the background.

## Get started

You need Bun, an interactive terminal, a Clockify account, and access to Zoho People's time tracker with an assigned job.

From this repository:

```sh
bun install
bun run dev --demo
```

The demo uses fictional entries and makes no network requests. It lets you try the selection and confirmation flow before connecting your accounts.

## Connect your accounts

### 1. Configure Clockify

Use the API key for your own Clockify account, along with your user ID and the workspace ID you want to sync. The configured user must match the account that owns the API key. zsync syncs that user's entries only.

### 2. Configure Zoho

Create a server-based OAuth client for your Zoho data center and register this redirect URI exactly:

```text
http://localhost:8765/callback
```

You need the client's ID and secret. Your Zoho role must allow Time Tracker API access, and you need an eligible, assigned job to receive entries.

### 3. Set your credentials

Export these five variables in your terminal, replacing the placeholders:

```sh
export CLOCKIFY_API_KEY='your-clockify-api-key'
export CLOCKIFY_USER_ID='your-clockify-user-id'
export CLOCKIFY_WORKSPACE_ID='your-clockify-workspace-id'
export ZOHO_CLIENT_ID='your-zoho-client-id'
export ZOHO_CLIENT_SECRET='your-zoho-client-secret'
```

For local Bun runs, you can also put these values in a project `.env` file. Keep credentials out of version control. The built Node executable expects exported environment variables.

If your Zoho account uses a data center other than `people.zoho.com`, set its region before connecting. For example, for `people.zoho.in`:

```sh
export ZOHO_REGION='in'
```

### 4. Authorize Zoho

```sh
bun run dev
```

On the first run, zsync opens your browser for Zoho authorization. It uses a temporary local listener on port 8765, which must be available. Authorization expires after five minutes if you don't finish it.

zsync requests these scopes:

- `ZOHOPEOPLE.timetracker.ALL`
- `ZOHOPEOPLE.forms.READ`
- `AaaServer.profile.READ`

After authorization, it looks up your People employee record using your email. If that lookup is unavailable, it asks for your numeric employee record ID, `ERECNO`. This is different from your displayed employee number.

The refresh token and employee record ID are saved locally for later runs. To authorize again:

```sh
bun run dev --connect
```

Reconnecting preserves your saved job mappings.

## Sync your time

Track time in Clockify as usual, stop any timers you want to sync, then run:

```sh
bun run dev
```

1. Choose Today, Yesterday, This week, Last week, or This month.
2. Use the arrow keys to move through entries and Space to select or deselect them. Press Enter to continue.
3. Choose a Zoho job for each unmapped Clockify project. zsync remembers your choices. An exact, unique match with a Zoho project or job name is selected automatically.
4. Review your selection and submit the final Yes/No prompt. Yes is selected initially, but you still have to confirm it.

New, changed and deleted entries start selected. Changed rows show a yellow `[updated]` label before their description and update the existing Zoho log when confirmed. Unchanged synced entries start unselected and are skipped if selected.

The final confirmation lists how many Zoho logs will be created, updated and deleted. It defaults to No if any deletions are selected. Cancelling before confirmation makes no Zoho changes. Job mappings may already have been saved locally.

## What gets copied

| Clockify field                                         | Zoho field or behavior                                    |
| ------------------------------------------------------ | --------------------------------------------------------- |
| Description                                            | Work Item                                                 |
| Project                                                | The Zoho job you selected or matched                      |
| Duration                                               | Hours, rounded to the nearest minute                      |
| Start date                                             | Work date in your configured timezone                     |
| Billable flag                                          | Billing status                                            |
| Entry ID, project, tags, start/end times, billing flag | Readable YAML metadata in Description, with a sync marker |

Only completed entries are included. Weeks start on Monday, and current periods end at the time you start the CLI.

Entries belong to their local start date. A timer that crosses midnight is copied whole to that date. Entries longer than 24 hours or shorter than the duration that rounds to one minute must be corrected in Clockify first.

zsync creates duration-based logs. The original start and end timestamps are retained in metadata. It does not create Zoho projects or jobs.

## Running sync again

zsync writes readable YAML metadata in the Zoho log's Description and recognizes entries by a sync marker derived from their Clockify ID. Existing JSON descriptions are still recognized; selecting one updates it to YAML. Keep that metadata intact so later runs can find the existing log. Recognition works across machines and OAuth clients without a local sync ledger.

Selecting a changed entry overwrites differing Zoho fields with the Clockify values. Older marker-only logs are also recognized within their original account scope; selecting them updates their Work Item and metadata to the current format.

A manually entered Zoho log without sync metadata is not treated as a match, even if its title and duration are identical. Deleting a synced Zoho log makes its Clockify entry appear new again.

Before writing, zsync checks for changes in both services. It verifies each write afterward and attempts to reconcile an uncertain response without blindly repeating the write. If an entry remains `uncertain`, inspect it in Zoho before retrying. Failures are reported per entry, and failed or uncertain results produce a nonzero exit status. A run can partially succeed.

## Review deleted entries

Before showing the combined sync table, zsync checks synced Zoho logs dated within your selected period. For each eligible log, it looks up the Clockify entry by ID, regardless of date. A moved entry or running timer that still exists is not offered for deletion. For a Clockify workspace-mismatch response, zsync checks the complete paginated user entry list without date filters. Only confirmed absence becomes a deletion candidate. Authentication errors and other failed lookups stop discovery rather than counting as deletions.

If Clockify confirms an entry is absent, its Zoho log appears in the same checkbox table as new and changed entries, labelled with a red `[deleted]` before its description. Deletion rows start checked. Deselect any logs you want to keep and review the create/update/delete counts at the final confirmation. The app rechecks each selected log and its Clockify source before deleting, then verifies that the Zoho log is gone. Deletions are not retried automatically after an uncertain response.

Logs need Clockify source metadata, an entry ID and a valid sync marker. Explicit workspace/user IDs must match your configuration. Older JSON and YAML logs without workspace/user IDs are checked against the currently configured Clockify workspace, so use the workspace you originally synced them from. Manual logs and locked logs are excluded.

Deletion review also runs when the selected period has no completed Clockify entries. After confirmation, the app applies creations and updates, then deletions. A failure does not roll back successful operations. A deletion failure is reported per entry and produces a nonzero exit status.

## Limits to know

- Sync runs one way, from Clockify to Zoho. It does not copy Zoho edits back or submit or approve timesheets.
- Locked or approved logs and multiple Zoho logs identifying the same Clockify entry are conflicts. Resolve them or deselect those entries before continuing.
- Lookup covers the selected entries' date span. If you move a previously synced entry to a date outside that span, reconcile its old Zoho log before syncing again.
- Run one sync at a time. There is no protection against simultaneous runs across terminals or machines.
- Clockify regional API endpoints are not supported. The app uses `api.clockify.me`.
- Zoho attendance, leave, date restrictions, and job permissions still apply and may cause a write to be rejected.

For your first real sync, select a few entries and check the resulting logs in Zoho.

## Optional configuration

| Variable             | Purpose                                                                    | Default                           |
| -------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| `ZOHO_REGION`        | Zoho data center: `com`, `eu`, `in`, `au`, `cn`, `jp`, `ca`, `sa`, or `uk` | Saved region, otherwise `com`     |
| `ZSYNC_TIMEZONE`     | IANA timezone, such as `Asia/Kolkata`                                      | System timezone                   |
| `ZOHO_DATE_FORMAT`   | Date format used by your Zoho organization                                 | `yyyy-MM-dd`                      |
| `ZSYNC_STATE_DIR`    | Directory for saved authentication and job mappings                        | Platform-specific directory below |
| `ZOHO_REFRESH_TOKEN` | Override the saved refresh token                                           | Saved token                       |
| `ZOHO_EMPLOYEE_ID`   | Override the saved employee record ID, `ERECNO`                            | Saved employee ID                 |

Supported date formats are `yyyy-MM-dd`, `dd-MM-yyyy`, `MM-dd-yyyy`, `yyyy/MM/dd`, `dd/MM/yyyy`, and `MM/dd/yyyy`.

Authentication and job preferences are stored per account. The authentication file contains a refresh token and is created with owner-only file permissions, `0600`. Client secrets are not saved by zsync.

Default storage locations:

- Linux: `$XDG_DATA_HOME/zsync`, or `~/.local/share/zsync`
- macOS: `~/Library/Application Support/zsync`
- Windows: `%APPDATA%/zsync`, with a local AppData fallback

## Development

Use Bun for dependency installation, development, and checks:

```sh
bun install
bun run dev --help
bun run typecheck
bun test
bun run build
bun pm pack
```

The build produces `dist/zsync.js`, a Node 22+ executable exposed as `zsync` by the `@srafis/zsync` package. Bun is used for development; the built executable can run without it.

Tests use fictional API responses and do not create real time logs.

### Publishing

The GitHub Actions workflow in `.github/workflows/publish.yml` tests, builds, and publishes the package on pushes to `main`. Configure the repository's `NPM_TOKEN` Actions secret with permission to publish `@srafis/zsync` and bypass 2FA for CI.

CI adds the workflow run number to the patch version in `package.json`. It does not commit that version change. Republishing the same version is tolerated. Change the major or minor version in `package.json` when needed.
