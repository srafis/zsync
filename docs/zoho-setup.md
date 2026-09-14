# Set up Zoho People

zsync needs a Zoho OAuth client, Time Tracker API access, an active project assigned to your employee record, and permission to create and assign jobs.

## Create an OAuth client

1. Open the [Zoho API Console](https://api-console.zoho.com/add#web) in a browser where you are logged in to Zoho People.
2. Enter `@srafis/zsync` as the client name.
3. Set `http://localhost:8765` as the Homepage URL.
4. Set `http://localhost:8765/callback` as the Authorized Redirect URI.
5. Click the Create button.
6. Copy the client ID and client secret from the Client Secret tab.
7. Save them in your shell configuration file (`~/.bashrc` or `~/.zshrc`):

   ```sh
   export ZOHO_CLIENT_ID="..."
   export ZOHO_CLIENT_SECRET="..."
   ```

zsync opens a local callback on port 8765 during the first authorization. The redirect URI must match exactly, including the scheme, port, and path.

## Request the required scopes

zsync requests these scopes during authorization:

```text
ZOHOPEOPLE.timetracker.ALL,ZOHOPEOPLE.forms.READ,ZOHOPEOPLE.forms.CREATE,AaaServer.profile.READ
```

`ZOHOPEOPLE.timetracker.ALL` lets zsync read and change time logs and list assigned projects and jobs. `ZOHOPEOPLE.forms.CREATE` lets it create missing tag jobs under the selected project. The `ZOHOPEOPLE.forms.READ` and `AaaServer.profile.READ` scopes let it find your employee record from your email address.

See Zoho's [OAuth scopes](https://www.zoho.com/people/api/scopes.html) page for scope details.

## Check your Zoho access

Your Zoho People role must allow Time Tracker API access. Your employee record must have an eligible, assigned project and permission to create and assign jobs. Ask your People administrator if zsync reports that no projects are available or job creation is denied.

If zsync cannot find your employee record by email, it asks for the numeric `ERECNO`. This is the employee record ID. It is different from the employee number shown in the People interface. You can also set it with `ZOHO_EMPLOYEE_ID`.
