# MailFanout

A minimal scheduled [Cloudflare Worker](https://developers.cloudflare.com/workers/) written in TypeScript. It runs once per hour and writes `Hello, World!` to the Worker logs. It does not expose an HTTP API.

The same POC task is also scheduled with GitHub Actions. Both schedulers call the shared `helloWorld()` function in `src/hello.ts`.

## Deploy from GitHub with Cloudflare

1. Push this repository to GitHub.
2. In the Cloudflare dashboard, open **Workers & Pages**.
3. Select **Create application**, then **Import a repository**.
4. Choose this repository and use these settings:
   - Worker name: `mail-fanout`
   - Production branch: `main`
   - Root directory: leave blank
   - Build command: leave blank
   - Deploy command: `npx wrangler deploy`
5. Select **Save and Deploy**.

Cloudflare will deploy every new commit pushed to the production branch. The Cron Trigger is created automatically from `wrangler.jsonc`.

## Schedule

The default expression is:

```text
0 * * * *
```

This means once per hour, on the hour. Cloudflare Cron Triggers always use UTC. Change `triggers.crons` in `wrangler.jsonc` to use another schedule.

The GitHub Actions workflow in `.github/workflows/cron.yml` uses the same hourly UTC schedule. It can also be triggered manually from the repository's **Actions** tab.

The GitHub workflow executes the shared task on a GitHub-hosted runner; it does not invoke the deployed Cloudflare Worker and does not need Cloudflare credentials.
