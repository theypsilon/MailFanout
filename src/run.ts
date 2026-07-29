import { FanoutRunError, runMailFanout } from "./fanout";
import {
  elapsedMilliseconds,
  errorFields,
  type LogContext,
  logError,
  logInfo,
  logWarning,
  type RunTrigger,
} from "./observability";
import type { Env } from "./types";

export type FanoutRunOutcome =
  | "success"
  | "partial_failure"
  | "completed_with_deferred_messages";

export interface FanoutInvocation {
  readonly trigger: RunTrigger;
  readonly scheduledTime: number;
  readonly cron?: string;
  readonly externalRunId?: string;
  readonly runId?: string;
}

export interface FanoutExecution {
  readonly outcome: FanoutRunOutcome;
  readonly failed: number;
}

export async function executeMailFanout(
  env: Env,
  invocation: FanoutInvocation,
): Promise<FanoutExecution> {
  const startedAt = Date.now();
  const logContext: LogContext = {
    runId: invocation.runId ?? crypto.randomUUID(),
    trigger: invocation.trigger,
    externalRunId: invocation.externalRunId,
  };

  logInfo("run_started", logContext, {
    cron: invocation.cron,
    scheduledTime: new Date(invocation.scheduledTime).toISOString(),
  });

  try {
    const result = await runMailFanout(env, logContext);
    const outcome: FanoutRunOutcome =
      result.failed > 0
        ? "partial_failure"
        : result.deferred > 0
          ? "completed_with_deferred_messages"
          : "success";
    const fields = {
      outcome,
      scannedCount: result.scanned,
      processedSkippedCount: result.processedSkipped,
      staleFilteredDiscoveredCount: result.staleFilteredDiscovered,
      selectedCount: result.selected,
      evaluatedCount: result.evaluated,
      matchedCount: result.matched,
      processedCount: result.forwarded + result.filtered,
      pendingSelectedCount:
        result.selected - result.forwarded - result.filtered,
      sentCount: result.sent,
      forwardedCount: result.forwarded,
      filteredCount: result.filtered,
      deferredCount: result.deferred,
      failedCount: result.failed,
      deliveryLimitReached: result.deliveryLimitReached,
      durationMs: elapsedMilliseconds(startedAt),
    };

    if (outcome === "success") {
      logInfo("run_completed", logContext, fields);
    } else {
      logWarning("run_completed", logContext, fields);
    }

    return { outcome, failed: result.failed };
  } catch (error) {
    const originalError =
      error instanceof FanoutRunError ? error.originalError : error;
    logError("run_failed", logContext, {
      outcome: "failed",
      processingStage:
        error instanceof FanoutRunError ? error.stage : "unknown",
      durationMs: elapsedMilliseconds(startedAt),
      ...errorFields(originalError),
    });
    throw error;
  }
}
