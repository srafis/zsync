# Set up Zoho People

zsync needs a Zoho OAuth client, Time Tracker API access, and a job assigned to your employee record.

## Create an OAuth client

1. Open the [Zoho People OAuth instructions](https://www.zoho.com/people/api/oauth-steps.html).
2. Open the Zoho API Console from that page.
3. Create a server-based application. Zoho may call this client type Web-based.
4. Choose the data center that contains your Zoho People account.
5. Register this redirect URI exactly:

   ```text
   http://localhost:8765/callback
   ```

6. Copy the client ID and client secret. Use them as `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET`.

zsync opens a local callback on port 8765 during the first authorization. The redirect URI must match exactly, including the scheme, port, and path.

## Request the required scopes

zsync requests these scopes during authorization:

```text
ZOHOPEOPLE.timetracker.ALL,ZOHOPEOPLE.forms.READ,AaaServer.profile.READ
```

`ZOHOPEOPLE.timetracker.ALL` lets zsync read and change time logs and list assigned jobs. The forms and profile scopes let it find your employee record from your email address.

See Zoho's [OAuth scopes](https://www.zoho.com/people/api/scopes.html) page for scope details.

## Check your Zoho access

Your Zoho People role must allow Time Tracker API access. Your employee record must have an eligible, assigned job. Ask your People administrator if zsync reports that no jobs are available.

If zsync cannot find your employee record by email, it asks for the numeric `ERECNO`. This is the employee record ID. It is different from the employee number shown in the People interface. You can also set it with `ZOHO_EMPLOYEE_ID`.

## Keep credentials safe

Do not commit the client ID, client secret, or refresh token to a repository. zsync saves the Zoho refresh token locally after authorization. It does not save the client secret.
