const LOG_SCHEMA_VERSION = 1;
const SERVICE_NAME = "mail-fanout";

type LogValue = string | number | boolean | null | undefined;
type LogFields = Record<string, LogValue>;
type LogEvent =
  | "authentication_succeeded"
  | "delivery_quota_evaluated"
  | "delivery_quota_exhausted"
  | "delivery_quota_updated"
  | "duplicate_delivery_risk"
  | "http_request_retry"
  | "inbox_cursor_saved"
  | "inbox_scan_completed"
  | "message_deferred"
  | "message_delivery_uncertain"
  | "message_filtered"
  | "message_forwarded"
  | "message_marker_write_recovered"
  | "message_marker_write_retry"
  | "message_processing_failed"
  | "message_send_attempted"
  | "message_sent_without_marker"
  | "oauth_refresh_failed"
  | "run_completed"
  | "run_failed"
  | "run_started"
  | "state_write_retry";

export type RunTrigger = "cloudflare-cron" | "github-actions";

export interface LogContext {
  readonly runId: string;
  readonly trigger: RunTrigger;
  readonly externalRunId?: string;
}

function compact(
  fields: LogFields,
): Record<string, Exclude<LogValue, undefined>> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry) => entry[1] !== undefined),
  ) as Record<string, Exclude<LogValue, undefined>>;
}

function payload(
  severity: "INFO" | "WARNING" | "ERROR",
  event: LogEvent,
  context: LogContext,
  fields: LogFields,
) {
  return {
    ...compact(fields),
    schemaVersion: LOG_SCHEMA_VERSION,
    service: SERVICE_NAME,
    severity,
    event,
    runId: context.runId,
    trigger: context.trigger,
    ...(context.externalRunId === undefined
      ? {}
      : { externalRunId: context.externalRunId }),
  };
}

export function logInfo(
  event: LogEvent,
  context: LogContext,
  fields: LogFields = {},
): void {
  console.log(payload("INFO", event, context, fields));
}

export function logWarning(
  event: LogEvent,
  context: LogContext,
  fields: LogFields = {},
): void {
  console.warn(payload("WARNING", event, context, fields));
}

export function logError(
  event: LogEvent,
  context: LogContext,
  fields: LogFields = {},
): void {
  console.error(payload("ERROR", event, context, fields));
}

export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return {
      errorType: "UnknownError",
      errorMessage: String(error).slice(0, 1_000),
    };
  }

  return {
    errorType: error.name,
    errorMessage: error.message.replace(/\s+/g, " ").trim().slice(0, 1_000),
    errorStack: error.stack?.slice(0, 4_000),
  };
}

export function elapsedMilliseconds(startedAt: number): number {
  return Math.max(Date.now() - startedAt, 0);
}

export function subjectForLog(value: string | undefined): string {
  const sanitized = value?.replace(/\s+/g, " ").trim().slice(0, 300);
  return sanitized === undefined || sanitized === ""
    ? "(no subject)"
    : sanitized;
}
