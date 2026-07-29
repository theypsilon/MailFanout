import {
  errorFields,
  type LogContext,
  logError,
  logWarning,
} from "../src/observability.ts";
import { executeMailFanout } from "../src/run.ts";
import type { Env } from "../src/types.ts";
import { CloudflareKvNamespace } from "./cloudflare-kv.ts";

interface NodeRuntime {
  readonly process: {
    readonly env: Record<string, string | undefined>;
    exitCode?: number;
  };
}

const runtime = globalThis as unknown as NodeRuntime;
const environment = runtime.process.env;
const logContext: LogContext = {
  runId: crypto.randomUUID(),
  trigger: "github-actions",
  externalRunId: environment.GITHUB_RUN_ID,
};

function required(name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Missing required variable or secret: ${name}`);
  }
  return value;
}

let executionStarted = false;

try {
  const env: Env = {
    PROCESSED_EMAILS: new CloudflareKvNamespace({
      accountId: required("CLOUDFLARE_ACCOUNT_ID"),
      namespaceId: required("CLOUDFLARE_KV_NAMESPACE_ID"),
      apiToken: required("CLOUDFLARE_API_TOKEN"),
      onRetry(event) {
        logWarning("http_request_retry", logContext, {
          dependency: "cloudflare-kv-rest",
          operation: event.operation,
          failedAttempt: event.attempt,
          nextAttempt: event.nextAttempt,
          retryDelayMs: event.delayMs,
          reason: event.reason,
          httpStatus: event.status,
        });
      },
    }),
    GMAIL_ADDRESS: environment.GMAIL_ADDRESS,
    FORWARD_RECIPIENTS: environment.FORWARD_RECIPIENTS,
    GMAIL_CLIENT_ID: environment.GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET: environment.GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN: environment.GMAIL_REFRESH_TOKEN,
    MAX_MESSAGES_PER_RUN: environment.MAX_MESSAGES_PER_RUN,
    MAX_INBOX_SCAN_PER_RUN: environment.MAX_INBOX_SCAN_PER_RUN,
    MAX_RECIPIENT_DELIVERIES_PER_DAY:
      environment.MAX_RECIPIENT_DELIVERIES_PER_DAY,
    MAX_MESSAGE_BYTES: environment.MAX_MESSAGE_BYTES,
  };

  executionStarted = true;
  const execution = await executeMailFanout(env, {
    trigger: "github-actions",
    scheduledTime: Date.now(),
    externalRunId: environment.GITHUB_RUN_ID,
    runId: logContext.runId,
  });

  if (execution.outcome === "partial_failure") {
    runtime.process.exitCode = 1;
  }
} catch (error) {
  if (!executionStarted) {
    logError("run_failed", logContext, {
      outcome: "failed",
      processingStage: "github_environment",
      ...errorFields(error),
    });
    runtime.process.exitCode = 1;
  } else {
    throw error;
  }
}
