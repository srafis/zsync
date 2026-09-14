# zsync

Copy selected Clockify time entries to Zoho People.

zsync runs in an interactive terminal. It reads completed entries for one Clockify user and workspace. You choose the entries to create or update in Zoho People. It can also find entries deleted from Clockify and offer the related Zoho logs for deletion. It runs only when you start it.

## Install

You need:

- Node.js 22 or newer
- An interactive terminal
- A Clockify account with time entries
- A Zoho People account with Time Tracker access and at least one assigned job

Install the published package:

```sh
npm i -g @srafis/zsync
```

Check the installation:

```sh
zsync --help
```

To try zsync without credentials, run:

```sh
zsync --demo
```

The demo uses fictional entries and sends no requests to Clockify or Zoho People.

## Set up your accounts

Follow the [Clockify setup guide](docs/clockify-setup.md) and the [Zoho People setup guide](docs/zoho-setup.md) to create the required credentials.

Before you configure zsync, collect these values:

- A Clockify API key, user ID, and workspace ID
- A Zoho client ID and client secret
- Access to Zoho People Time Tracker
- A Zoho job assigned to your employee record

Use the same Clockify user and workspace that own the entries you want to sync. zsync checks both values before it reads your time entries.

## Configure zsync

Set the required values in the terminal where you will run zsync:

```sh
export CLOCKIFY_API_KEY='your-clockify-api-key'
export CLOCKIFY_USER_ID='your-clockify-user-id'
export CLOCKIFY_WORKSPACE_ID='your-clockify-workspace-id'
export ZOHO_CLIENT_ID='your-zoho-client-id'
export ZOHO_CLIENT_SECRET='your-zoho-client-secret'
```

The example uses a POSIX shell. In PowerShell, set each variable with `$env:NAME = 'value'`.

Keep these values private. Do not commit them to a repository. The published command reads environment variables from its process. It does not read a project `.env` file.

### Optional variables


| Variable             | Use                                                                             | Default                                           |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `ZOHO_REGION`        | Zoho data center code: `com`, `eu`, `in`, `au`, `cn`, `jp`, `ca`, `sa`, or `uk` | Saved region, otherwise `com`                     |
| `ZSYNC_TIMEZONE`     | Time zone used for entry dates, such as `Asia/Kolkata`                          | System time zone                                  |
| `ZOHO_DATE_FORMAT`   | Date format used by your Zoho organization                                      | `yyyy-MM-dd`                                      |
| `ZSYNC_STATE_DIR`    | Folder for saved authentication and job mappings                                | See [Saved files](#saved-files)                   |
| `ZOHO_REFRESH_TOKEN` | Use an existing Zoho refresh token                                              | Saved token                                       |
| `ZOHO_EMPLOYEE_ID`   | Set the Zoho employee record ID, also called `ERECNO`                           | Saved ID, otherwise looked up after authorization |


Supported values for `ZOHO_DATE_FORMAT` are `yyyy-MM-dd`, `dd-MM-yyyy`, `MM-dd-yyyy`, `yyyy/MM/dd`, `dd/MM/yyyy`, and `MM/dd/yyyy`.

Set `ZOHO_REGION` for a non-US Zoho data center. For example:

```sh
export ZOHO_REGION='in'
```



## Authorize Zoho People

Run zsync after you set the required variables:

```sh
zsync
```

On the first run, zsync:

1. Opens your browser for Zoho authorization.
2. Waits for Zoho to send the result to `http://localhost:8765/callback`.
3. Finds your Zoho People employee record from your email address.
4. Asks for your numeric employee record ID, `ERECNO`, if the lookup fails.
5. Saves the refresh token and employee record ID for later runs.

If the browser does not open, copy the URL shown in the terminal and open it yourself. Port 8765 must be free. The authorization step times out after five minutes.

To authorize again, run:

```sh
zsync --connect
```

Reconnecting keeps saved job mappings for the same account.

## Sync your time

Track time in Clockify and stop any timers you want to sync. Then run:

```sh
zsync
```

Use the prompts in this order:

1. Choose Today, Yesterday, This week, Last week, or This month.
2. Use the arrow keys to move through the entries. Press Space to select or clear an entry. Press Enter to continue. Press Esc to cancel.
3. Choose a Zoho job for each Clockify project that has no saved match. zsync selects a unique project or job with the same name when it can.
4. Review the create, update, and delete counts.
5. Choose Yes to write the changes.

New, changed, and deleted entries start selected. Unchanged entries that zsync already synced are not selected. Changed entries show `[updated]` before the description. Deleted entries show `[deleted]`.

The final prompt defaults to Yes when it only creates or updates entries. It defaults to No when it includes a deletion. zsync makes no Zoho changes before this final confirmation. It may save job mappings before you confirm.

Weeks start on Monday. Today, This week, and This month end at the time you start zsync. zsync uses `ZSYNC_TIMEZONE` for local dates.

## What zsync copies


| Clockify data                                                                | Zoho People result                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| Description                                                                  | Work Item                                            |
| Project                                                                      | The Zoho job you select or zsync matches             |
| Duration                                                                     | Hours, rounded to the nearest minute                 |
| Start date                                                                   | Work date in your configured time zone               |
| Billable flag                                                                | Billing status                                       |
| Entry ID, project, tags, timestamps, billing flag, workspace ID, and user ID | Readable metadata in Description, with a sync marker |


Only completed entries are included. zsync creates duration-based logs. It does not create Zoho projects or jobs.

An entry belongs to the local date of its start time. If an entry crosses midnight, zsync copies the full duration to that start date. Entries longer than 24 hours or entries that round to less than one minute must be corrected in Clockify first.

## Run a sync again

zsync writes readable source metadata and a marker such as `[zsync-source:...]` in each Zoho log description. It uses this data to find the log that belongs to a Clockify entry. Keep the metadata and marker in the description.

If a Clockify entry changed, select its `[updated]` row. zsync then writes the current Clockify values to the matching Zoho log. A Zoho log that you entered by hand has no source metadata, so zsync does not treat it as a match. If you delete a synced Zoho log, its Clockify entry appears as new on the next run.

Before each write, zsync checks both services again. It verifies the result after the write. A run can finish with both successful and failed entries. If a result is uncertain, inspect Zoho People before you retry it.

## Review deleted entries

Before it shows the selection table, zsync checks synced Zoho logs in the selected date range. If the source entry no longer exists in Clockify, the Zoho log appears with `[deleted]` and is selected by default.

You can clear a deletion to keep the Zoho log. zsync checks each selected deletion and its Clockify source again before it deletes the log. It does not offer an entry that still exists in Clockify, even if the entry moved to another date. It also excludes manual, locked, and ambiguous Zoho logs.

An authentication or lookup error stops deletion review. zsync does not count that error as a deletion. Deletion review also runs when the selected period has no completed Clockify entries.

zsync applies creates and updates before deletions. A failed operation does not undo operations that already succeeded.

## Limits and safety

- Sync works from Clockify to Zoho People. It does not copy Zoho edits back to Clockify or submit or approve timesheets.
- Locked or approved Zoho logs, and multiple Zoho logs for one Clockify entry, are conflicts. Clear those entries or fix the logs before you continue.
- If you move a synced entry outside the selected date range, include the old Zoho log date in a later run when you clean it up.
- Run one sync at a time. zsync does not coordinate runs from different terminals or machines.
- zsync uses `api.clockify.me`. Clockify regional API endpoints are not supported.
- Zoho attendance rules, date rules, and job permissions can reject a write.



## Saved files

zsync stores authentication and job mappings on your computer. It stores them per account.


| System  | Default folder                                    |
| ------- | ------------------------------------------------- |
| Linux   | `$XDG_DATA_HOME/zsync`, or `~/.local/share/zsync` |
| macOS   | `~/Library/Application Support/zsync`             |
| Windows | `%APPDATA%/zsync`, with a local AppData fallback  |


The authentication file contains a refresh token and employee record ID. zsync creates it with owner-only permissions (`0600`). It does not save the Zoho client secret. Set `ZSYNC_STATE_DIR` to use another folder.

## Troubleshooting

- `Missing required environment variable`: set all five required variables in the current terminal.
- `Clockify API key does not belong to CLOCKIFY_USER_ID`: use the user ID that belongs to the API key.
- `No eligible Zoho jobs`: ask your Zoho People administrator to assign an active job to your employee record.
- `Port 8765 may be in use`: stop the other local process and run zsync again.
- `Zoho authorization expired or was revoked`: run `zsync --connect`.



## Development

The published package does not need Bun. Use Bun only when you run the source checkout.

```sh
git clone https://github.com/srafis/zoho-clockify-sync.git
cd zoho-clockify-sync
bun install
bun run dev --demo
```

For a real source run, copy `.env.example` to `.env`, fill in the values, and run:

```sh
bun run dev
```

Run the checks with:

```sh
bun run typecheck
bun test
bun run build
bun pm pack
```

The build creates `dist/zsync.js`, a Node.js 22 or newer executable. Tests use fictional API responses and do not create real time logs.