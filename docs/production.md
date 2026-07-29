# Production operating contract

## Capacity defaults

The Worker needs no optional Cloudflare environment variables. Its built-in
defaults are deliberately conservative:

| Control | Default | Purpose |
| --- | ---: | --- |
| Messages selected per run | 1 | Keeps worst-case five-minute marker, quota, and cursor writes within the Workers KV Free daily write allowance. |
| Inbox messages scanned per run | 250 | Keeps worst-case scheduled KV reads below the Free daily read allowance. |
| Recipient deliveries per UTC day | 400 | Leaves headroom below a standard Gmail account's published 500-message daily threshold. |
| Source message size | 20 MiB | Leaves encoding and header headroom for Gmail API submission. |
| Recipients | 50 maximum | Bounds fanout and per-message recipient exposure. |

At a five-minute cadence there are 288 runs per day. One processed-message
write, one daily-usage write, and one cursor write per run produce at most 864
writes during normal single-scheduler operation. A 250-message scan produces
at most 72,000 processed-key reads per day. The current Workers KV Free
allowances are 1,000 writes and 100,000 reads per day. Use a paid Workers plan
before raising either default or running sustained backlog recovery. See
Cloudflare's
[KV limits](https://developers.cloudflare.com/kv/platform/limits/) and
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

Gmail can apply additional dynamic anti-abuse limits. Gmail acceptance is not
proof that every recipient provider delivered the message. The published
consumer-account ceiling and recovery behavior are documented in
[Gmail sending limits](https://support.google.com/mail/answer/22839?hl=en).

## Gmail authorization boundary

Authorize only these scopes:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.send`

Do not grant `https://mail.google.com/` or `gmail.modify`; this Worker neither
deletes nor changes messages. Google classifies `gmail.readonly` as restricted
and `gmail.send` as sensitive, as listed in the
[Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

## State and delivery semantics

The service provides at-least-once forwarding:

- A filtered marker is written only after the subject and body were evaluated.
- A forwarded marker is written only after Gmail returned a sent-message ID.
- A failed or deferred message remains unmarked and is eligible for a later
  run.
- Safe reads, token refreshes, and idempotent KV writes use bounded retries.
- Gmail message submission is never retried inside one run because it is not
  idempotent.
- A timeout, network failure, malformed success response, HTTP 408, or Gmail
  5xx during submission is treated as uncertain. It remains unmarked and
  emits `message_delivery_uncertain` plus `duplicate_delivery_risk`.

`message_forwarded` means `accepted_by_gmail`, not delivered to every mailbox.
Provider bounces, spam placement, and recipient-side filtering are outside the
Gmail send API acknowledgement.

## Retention and privacy

Processed-message markers intentionally have no expiry. Expiring one while the
source message remains in Inbox would cause it to be evaluated and possibly
sent again. Values are one-character/version markers, and keys contain only
the Gmail message ID. Daily delivery counters expire after three days.

Review namespace growth annually. Delete processed markers only after the
corresponding Gmail messages have permanently left Inbox or after accepting
the replay risk. Never bulk-delete the namespace as routine maintenance.

Logs contain Gmail message IDs and sanitized subjects because they are needed
for incident response. They do not contain bodies, recipients, or credentials.
Restrict Cloudflare log access, use the shortest plan-supported retention that
meets operational needs, and treat subjects as potentially sensitive data.

## Deliverability

Use only recipients who expect the messages. Have each recipient allowlist the
Gmail sender, remove invalid recipients promptly, and review spam/bounce
signals after any recipient-list change. Do not use this service for marketing
or unsolicited bulk mail. The Gmail account remains the actual authenticated
`From` address; the original sender is presentation metadata and `Reply-To`.

Google's current
[email sender guidelines](https://support.google.com/mail/answer/81126?hl=en)
cover authentication, RFC 5322 formatting, TLS, spam rate, and unwanted mail.
No code change can guarantee that a recipient provider will avoid its spam
folder.

## Release and incident procedure

Before deployment, require `npm run verify` to pass and require the CI
`verify` job on `main`. Deploy from a reviewed commit, then confirm a
`run_completed` event for the deployed Worker version.

For an alert:

1. Correlate the incident by `runId` and inspect `processingStage`.
2. For `oauth_refresh_failed`, follow the `recoveryAction` in
   [gmail-oauth.md](gmail-oauth.md). No messages were processed by that run.
3. For `message_delivery_uncertain`, inspect Gmail Sent using the logged
   subject and message ID before manually triggering another run.
4. For KV quota errors, stop manual runs and move to a paid plan or wait for
   the UTC quota reset.
5. For repeated Gmail quota errors, leave messages unmarked and wait for
   Google's sending window to recover.
6. Record whether Gmail accepted the message separately from whether each
   recipient received it.

The concurrent Cloudflare/GitHub invocation limitation remains intentionally
outside this hardening pass. Gmail OAuth setup, monitoring, and recovery are
defined in [gmail-oauth.md](gmail-oauth.md).
