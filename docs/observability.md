# Observability

MailFanout emits structured logs with `schemaVersion`, `service`, `severity`,
`event`, `runId`, and `trigger` on every event. Use `runId` to correlate all
events produced by one invocation. GitHub-triggered events also include the
GitHub Actions run ID as `externalRunId`.

## Operational events

| Event | Severity | Meaning |
| --- | --- | --- |
| `run_started` | INFO | Cron invocation began. |
| `authentication_succeeded` | INFO | OAuth refresh and Gmail account validation succeeded. |
| `oauth_refresh_failed` | ERROR | OAuth refresh failed; inspect `recoveryAction` to distinguish automatic retry, Gmail reauthorization, and OAuth-client repair. |
| `http_request_retry` | WARNING | A safe Gmail or Cloudflare KV operation hit a timeout, network error, or retryable status and is being retried with bounded backoff. |
| `state_write_retry` | WARNING | An idempotent cursor, filtered marker, or delivery-usage write failed and is being retried with bounded backoff. |
| `delivery_quota_evaluated` | INFO | Current recipient-delivery budget was calculated. |
| `delivery_quota_exhausted` | WARNING | Matching messages cannot be sent until the budget resets. |
| `inbox_scan_completed` | INFO | Inbox discovery and KV deduplication completed. |
| `inbox_cursor_saved` | INFO | The resumable backlog cursor was persisted without exposing its value. |
| `message_filtered` | INFO | The subject and body lacked `github.com`, and the versioned filtered marker was saved. |
| `message_send_attempted` | INFO | A subject/body match is about to be submitted to Gmail; inspect `matchSource`. |
| `message_forwarded` | INFO | Gmail accepted the message and its forwarded marker was saved; inspect `matchSource`. |
| `message_marker_write_retry` | WARNING | Gmail accepted the message, but saving its forwarded marker failed and will be retried without resending. |
| `message_marker_write_recovered` | INFO | A retried forwarded-marker write succeeded; inspect `attemptsUsed`. |
| `message_deferred` | WARNING | A matching message remains unmarked for a later run. |
| `message_delivery_uncertain` | ERROR | Gmail send returned an ambiguous transport or server result. The message remains unmarked, may have been delivered, and will be retried. |
| `message_processing_failed` | ERROR | A message failed at the reported `processingStage`. |
| `message_sent_without_marker` | ERROR | Gmail sent the message, but KV did not record it. |
| `duplicate_delivery_risk` | WARNING | The next run may resend an already delivered message. |
| `delivery_quota_updated` | INFO | Recipient-delivery usage was persisted after sends. |
| `run_completed` | INFO/WARNING | Run summary; inspect `outcome` and counters. |
| `run_failed` | ERROR | The run terminated during the reported `processingStage`. |

## Recommended monitors

- Page immediately on `message_sent_without_marker`,
  `message_delivery_uncertain`, `duplicate_delivery_risk`,
  `oauth_refresh_failed`, or `run_failed`.
- Warn on `message_marker_write_retry`; page only if retries end in
  `message_sent_without_marker`.
- Alert on any `run_completed` event where `outcome = "partial_failure"`.
- Warn on repeated `delivery_quota_exhausted` events.
- Warn when `http_request_retry` occurs five or more times in 15 minutes.
- Warn when `state_write_retry` occurs; page if the enclosing run ultimately
  fails.
- Alert if neither `run_completed` nor `run_failed` appears for 15 minutes.
- Track `durationMs`, `failedCount`, `deferredCount`, `forwardedCount`,
  `filteredCount`, `matchedCount`, `processedSkippedCount`, and
  `pendingSelectedCount` over time for regressions and backlog growth.
- Track `staleFilteredDiscoveredCount` during filter-rule migrations. It should
  return to zero after messages marked by the previous rule are reevaluated.
- Investigate a sustained unexpected drop to zero `evaluatedCount` or
  `matchedCount`; alert thresholds should be based on normal mailbox volume.

Message IDs and sanitized subjects are intentionally logged for diagnosis.
OAuth credentials, refresh/access tokens, message bodies, and recipient
addresses must never be logged.

## Cloudflare alert setup

Workers Logs and 100% sampling are enabled in `wrangler.jsonc`. In Cloudflare,
open **Workers & Pages > Observability**, and create these queries and alerts:

| Alert | Filters | Condition |
| --- | --- | --- |
| Immediate failure | `$metadata.service = mail-fanout`, `severity = ERROR` | Count is greater than zero over 5 minutes. |
| OAuth operator action | `$metadata.service = mail-fanout`, `event = oauth_refresh_failed`, `requiresOperatorAction = true` | Count is greater than zero over 5 minutes. |
| Duplicate-delivery risk | `$metadata.service = mail-fanout`, `event` is `message_sent_without_marker`, `message_delivery_uncertain`, or `duplicate_delivery_risk` | Count is greater than zero over 5 minutes. |
| Partial run | `$metadata.service = mail-fanout`, `event = run_completed`, `outcome = partial_failure` | Count is greater than zero over 5 minutes. |
| Missing heartbeat | `$metadata.service = mail-fanout`, `event` is `run_completed` or `run_failed` | Count is less than one over 15 minutes. |
| Retry pressure | `$metadata.service = mail-fanout`, `event` is `http_request_retry` or `state_write_retry` | Count is at least five over 15 minutes. |
| Delivery quota | `$metadata.service = mail-fanout`, `event = delivery_quota_exhausted` | Count is greater than zero over 15 minutes. |

Configure a **Workers Observability** notification policy for both
`FIRING_FAILED` and `NORMAL` so responders see failures and recoveries. Send
the first five alerts to a paging destination; route retry and quota pressure
to a lower-urgency email destination. Trigger a test notification and record
the owner before declaring monitoring operational.

Save three investigation queries as well:

- Errors: filter on `$metadata.service = mail-fanout` and `severity = ERROR`,
  count, then group by `event`.
- Warnings: filter on `$metadata.service = mail-fanout` and
  `severity = WARNING`, count, then group by `event`.
- Run outcomes: filter on `$metadata.service = mail-fanout` and
  `event = run_completed`, count, then group by `outcome`.

Cloudflare documents structured-log querying in its
[Workers Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)
guide and notification delivery in
[Cloudflare Notifications](https://developers.cloudflare.com/notifications/get-started/).
