# Set up Clockify

zsync needs a Clockify API key, user ID, and workspace ID.

Use the same user, API key, and workspace together. zsync reads entries for that user only.

## Create an API key

1. Sign in to Clockify.
2. Open your account menu.
3. Select Preferences, then Advanced.
4. In the API Key section, select Generate.
5. Copy the key and store it in a safe place. Clockify does not show it again after you close the window.

See Clockify's [API and webhook settings](https://clockify.me/help/administration/api-webhook-settings) for the current menu names.

## Find your user ID

The user ID is different from the API key. The endpoint below returns the user for the API key:

```sh
curl -sS -H "X-Api-Key: $CLOCKIFY_API_KEY" https://api.clockify.me/api/v1/user
```

Use the `id` value in the response as `CLOCKIFY_USER_ID`. See Clockify's [user ID instructions](https://clockify.me/help/troubleshooting/how-to-find-userid-in-the-api) for other ways to find it.

## Find your workspace ID

Open the workspace in Clockify. Its URL contains `/workspaces/<workspace-id>`. Copy the value after `/workspaces/` and use it as `CLOCKIFY_WORKSPACE_ID`.

Use the workspace where you track the time. zsync uses the default Clockify API endpoint, `https://api.clockify.me/api/v1`. Clockify regional API endpoints are not supported.

## Keep the key safe

Do not commit the API key to a repository. If you delete the key in Clockify, zsync cannot access your entries until you create and configure a new one.
