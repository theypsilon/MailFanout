import { FanoutRunError, runMailFanout } from "./fanout";
import {
  elapsedMilliseconds,
  errorFields,
  logError,
  logInfo,
  logWarning,
} from "./observability";
import type { CronEvent, Env } from "./types";

export default {
  async scheduled(controller: CronEvent, env: Env): Promise<void> {
    const startedAt = Date.now();
    const logContext = { runId: crypto.randomUUID() };

    logInfo("run_started", logContext, {
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
    });

    try {
      const result = await runMailFanout(env, logContext);
      const outcome =
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
  },
};
