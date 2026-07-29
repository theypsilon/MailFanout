# Gmail OAuth operations

## One-time production setup

This is a single-account personal-use integration. In the Google Cloud project
that owns the OAuth client:

1. Open **Google Auth Platform > Audience**.
2. Change **Publishing status** from **Testing** to **In production**. Testing
   grants that request Gmail scopes expire after seven days.
3. Under **Data Access**, keep only:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
4. Generate a fresh offline refresh token after publishing. Request
   `access_type=offline` and `prompt=consent`, then replace the token issued
   while the app was in Testing.
5. Validate the replacement before activating it:

   ```sh
   GMAIL_ADDRESS="account@gmail.com" \
   GMAIL_CLIENT_ID="..." \
   GMAIL_CLIENT_SECRET="..." \
   GMAIL_REFRESH_TOKEN="..." \
   npm run oauth:check
   ```

   The command prints the authenticated address but never the access or
   refresh token.
6. Store the validated token as the `GMAIL_REFRESH_TOKEN` secret in both the
   Cloudflare Worker and the GitHub `production` environment.

Google permits personal-use apps with fewer than 100 users to remain
unverified, although the one-time authorization flow displays an unverified
app warning. Verification becomes necessary if the integration is offered
more broadly. The app must still comply with the Google API Services User Data
Policy.

References:

- [Google OAuth audience and publishing status](https://support.google.com/cloud/answer/15549945?hl=en)
- [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Google personal-use verification exception](https://support.google.com/cloud/answer/13464323?hl=en)

## Normal lifecycle

Do not rotate a healthy Google refresh token on a timer. Google recommends
storing and continuing to use it while it remains valid, and issuing too many
tokens can invalidate older ones. Every five-minute Worker run already
performs an OAuth refresh and verifies that the authorized Gmail address
matches `GMAIL_ADDRESS`.

`authentication_succeeded` is the positive OAuth heartbeat.
`oauth_refresh_failed` is the actionable failure event:

| Recovery action | Meaning |
| --- | --- |
| `retry_automatically` | Temporary Google or network failure; bounded retries already ran and the next cron will try again. |
| `reauthorize_gmail` | The user grant expired or was revoked; generate a replacement refresh token. |
| `repair_oauth_client` | The OAuth client was deleted, disabled, or misconfigured; repair or replace the client credentials. |

The Worker never logs credentials or access tokens.

## Recovery and rotation

Google refresh tokens can stop working after revocation, six months of
inactivity, some Gmail-account password changes, OAuth client deletion, or
token-count limits.

When `oauth_refresh_failed` requires operator action:

1. Do not delete the old credentials yet.
2. Correct the OAuth client or complete the consent flow again with the same
   two scopes, `access_type=offline`, and `prompt=consent`.
3. Run `npm run oauth:check` against the proposed credentials.
4. Replace `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and
   `GMAIL_REFRESH_TOKEN` together in Cloudflare when the client changed;
   otherwise replace only `GMAIL_REFRESH_TOKEN`.
5. Update the matching GitHub `production` secrets.
6. Confirm the next Cloudflare invocation emits
   `authentication_succeeded` and `run_completed`.
7. Revoke the superseded grant only after both execution environments have
   been verified.

No email is marked processed when authentication fails, so normal processing
resumes after credential recovery.
