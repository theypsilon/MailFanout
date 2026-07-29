# GitHub Actions

The manually dispatched workflow runs the same mail fanout job as the
Cloudflare Cron Trigger and uses the same KV namespace for processed-message
state. It targets the GitHub `production` environment so its deployment can be
protected with required reviewers. The job runs only when dispatched from
`main`; dispatches from another branch are skipped.

## Required repository secrets

- `GMAIL_ADDRESS`
- `FORWARD_RECIPIENTS` (whitespace-separated addresses)
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `CLOUDFLARE_API_TOKEN`

Scope `CLOUDFLARE_API_TOKEN` to the account containing the namespace and grant
only `Workers KV Storage Read` and `Workers KV Storage Write`.

## Required repository variables

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`

`CLOUDFLARE_KV_NAMESPACE_ID` must identify the same namespace bound to the
Worker as `PROCESSED_EMAILS`.

Store the secrets and variables in the `production` environment when possible.
Repository-level values also work, but environment secrets can be protected by
required reviewers. Secrets are exposed only to the final fanout step, not to
checkout, Node setup, or dependency installation.

Before the first production dispatch:

1. In **Settings > Environments**, create `production`, add a required
   reviewer, and move the fanout secrets and variables into it.
2. Run the `Continuous integration` workflow once on `main`.
3. In **Settings > Rules > Rulesets**, protect `main`, require pull requests,
   and require the CI `verify` status check.
4. Keep the repository's default workflow token permission set to read-only.

The Cloudflare five-minute schedule remains enabled. GitHub concurrency
prevents overlapping GitHub workflow runs, but it cannot prevent a manual
GitHub run from overlapping a Cloudflare cron invocation. Workers KV is not an
atomic lock, so avoid manually dispatching the workflow while the scheduled
run is active.

The `Continuous integration` workflow validates formatting, linting, types,
tests, and a Wrangler dry-run on pull requests and pushes to `main`. Require its
`verify` job in the `main` branch protection rules before merging.
