# Set up Clockify

zsync needs a Clockify API key, user ID, and workspace ID.

Use the same user, API key, and workspace. zsync reads entries for that user only.

## Create an API key

1. Sign in to Clockify.
2. Open [Manage API keys](https://app.clockify.me/manage-api-keys).
3. Click the `GENERATE NEW` button, give it a name, and click `GENERATE`.
4. Copy the key and save it in your shell configuration file:

   ```sh
   export CLOCKIFY_API_KEY="..."
   ```

> [!NOTE]
> Clockify does not show the API key again after you close the window.

See Clockify's [API and webhook settings](https://clockify.me/help/administration/api-webhook-settings) for the current menu names.

## Find your user ID and workspace ID

Make sure `CLOCKIFY_API_KEY` is set in the current shell. This command also requires `jq`:

```sh
curl -sS -H "X-Api-Key: $CLOCKIFY_API_KEY" \
  https://api.clockify.me/api/v1/user |
jq -r '"export CLOCKIFY_USER_ID=\"\(.id)\"\nexport CLOCKIFY_WORKSPACE_ID=\"\(.defaultWorkspace)\""'
```

Example expected output:

```sh
export CLOCKIFY_USER_ID="..."
export CLOCKIFY_WORKSPACE_ID="..."
```

Store these in your shell configuration file (`~/.bashrc`/`~/.zshrc`).
