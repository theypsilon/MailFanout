import { loadConfig, type FanoutConfig } from "./config";
import {
  messageContainsRequiredContent,
  REQUIRED_CONTENT,
} from "./content-filter";
import {
  getAuthenticatedAddress,
  getMessageContent,
  getRawMessage,
  GmailApiError,
  type GmailMessagePart,
  type GmailMessageReference,
  listInboxMessages,
  refreshAccessToken,
  sendRawMessage,
} from "./gmail";
import { createForwardMessage, MessageFormatError } from "./message";
import {
  elapsedMilliseconds,
  errorFields,
  type LogContext,
  logError,
  logInfo,
  logWarning,
  subjectForLog,
} from "./observability";
import type { Env, KVNamespace } from "./types";

const PROCESSED_KEY_PREFIX = "processed:";
const FORWARDED_MARKER = "1";
const FILTERED_MARKER = "0";
const DAILY_USAGE_KEY_PREFIX = "deliveries:";
const INBOX_CURSOR_KEY = "state:inbox-cursor";
const INBOX_CURSOR_START = "-";
const DAILY_USAGE_TTL_SECONDS = 3 * 24 * 60 * 60;
const KV_BULK_READ_LIMIT = 100;

interface CandidateSearchResult {
  readonly messages: GmailMessageReference[];
  readonly scanned: number;
  readonly processedSkipped: number;
  readonly cursorToSave?: string;
}

export interface FanoutResult {
  readonly scanned: number;
  readonly processedSkipped: number;
  readonly selected: number;
  readonly evaluated: number;
  readonly matched: number;
  readonly sent: number;
  readonly forwarded: number;
  readonly filtered: number;
  readonly deferred: number;
  readonly failed: number;
  readonly deliveryLimitReached: boolean;
}

export class FanoutRunError extends Error {
  constructor(
    readonly stage: string,
    readonly originalError: unknown,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : "Unknown fanout error",
    );
    this.name = "FanoutRunError";
  }
}

async function runStage<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new FanoutRunError(stage, error);
  }
}

function synchronousRunStage<T>(stage: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new FanoutRunError(stage, error);
  }
}

function processedKey(messageId: string): string {
  return `${PROCESSED_KEY_PREFIX}${messageId}`;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyUsageKey(): string {
  return `${DAILY_USAGE_KEY_PREFIX}${utcDate()}`;
}

async function dailyDeliveryUsage(
  kv: KVNamespace,
  usageKey: string,
): Promise<number> {
  const value = await kv.get(usageKey);
  if (value === null) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function findUnprocessedMessages(
  accessToken: string,
  kv: KVNamespace,
  limit: number,
  maximumScan: number,
): Promise<CandidateSearchResult> {
  const messages: GmailMessageReference[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let processedSkipped = 0;

  const unprocessedIn = async (
    pageMessages: GmailMessageReference[],
  ): Promise<GmailMessageReference[]> => {
    if (pageMessages.length === 0) {
      return [];
    }

    const markerKeys = pageMessages.map((message) =>
      processedKey(message.id),
    );
    const markers = await kv.get(markerKeys);
    const unprocessed: GmailMessageReference[] = [];

    for (const message of pageMessages) {
      if (seen.has(message.id)) {
        continue;
      }
      seen.add(message.id);

      const marker = markers.get(processedKey(message.id));
      if (marker === null || marker === undefined) {
        unprocessed.push(message);
      } else {
        processedSkipped += 1;
      }
    }

    return unprocessed;
  };

  const firstPageSize = Math.min(KV_BULK_READ_LIMIT, maximumScan);
  const [firstPage, storedCursorValue] = await Promise.all([
    listInboxMessages(accessToken, firstPageSize),
    kv.get(INBOX_CURSOR_KEY),
  ]);
  const storedCursor =
    storedCursorValue === null || storedCursorValue === INBOX_CURSOR_START
      ? undefined
      : storedCursorValue;

  scanned += firstPage.messages.length;
  const newestUnprocessed = await unprocessedIn(firstPage.messages);
  messages.push(...newestUnprocessed.slice(0, limit));

  if (messages.length === limit) {
    return { messages, scanned, processedSkipped };
  }

  let pageToken = storedCursor ?? firstPage.nextPageToken;
  let cursorToSave: string | undefined;
  let resetInvalidCursor = false;

  while (pageToken !== undefined && scanned < maximumScan) {
    const currentPageToken = pageToken;
    const pageSize = Math.min(KV_BULK_READ_LIMIT, maximumScan - scanned);
    let page;

    try {
      page = await listInboxMessages(
        accessToken,
        pageSize,
        currentPageToken,
      );
    } catch (error) {
      if (
        error instanceof GmailApiError &&
        error.status === 400 &&
        storedCursor !== undefined &&
        !resetInvalidCursor
      ) {
        resetInvalidCursor = true;
        pageToken = firstPage.nextPageToken;
        cursorToSave = INBOX_CURSOR_START;
        continue;
      }

      throw error;
    }

    scanned += page.messages.length;
    const pageUnprocessed = await unprocessedIn(page.messages);
    if (pageUnprocessed.length > 0) {
      messages.push(
        ...pageUnprocessed.slice(0, limit - messages.length),
      );

      if (currentPageToken !== storedCursor) {
        cursorToSave = currentPageToken;
      }
      break;
    }

    pageToken = page.nextPageToken;
    const nextCursor = pageToken ?? INBOX_CURSOR_START;
    if (nextCursor !== (storedCursor ?? INBOX_CURSOR_START)) {
      cursorToSave = nextCursor;
    }
  }

  if (
    firstPage.messages.length === 0 &&
    storedCursor !== undefined
  ) {
    cursorToSave = INBOX_CURSOR_START;
  }

  return { messages, scanned, processedSkipped, cursorToSave };
}

function shouldStopAfter(error: unknown): boolean {
  if (error instanceof GmailApiError) {
    return error.shouldStopRun;
  }

  return !(error instanceof MessageFormatError);
}

function gmailCredentials(config: FanoutConfig) {
  return {
    clientId: config.gmailClientId,
    clientSecret: config.gmailClientSecret,
    refreshToken: config.gmailRefreshToken,
  };
}

function messageSubject(payload: GmailMessagePart): string {
  return subjectForLog(
    payload.headers?.find(
      (header) => header.name?.toLowerCase() === "subject",
    )?.value,
  );
}

export async function runMailFanout(
  env: Env,
  logContext: LogContext,
): Promise<FanoutResult> {
  const config = synchronousRunStage("configuration", () =>
    loadConfig(env),
  );
  const accessToken = await runStage("oauth_refresh", () =>
    refreshAccessToken(gmailCredentials(config)),
  );
  const authenticatedAddress = await runStage("gmail_profile", () =>
    getAuthenticatedAddress(accessToken),
  );
  if (
    authenticatedAddress.toLowerCase() !==
    config.gmailAddress.toLowerCase()
  ) {
    throw new FanoutRunError(
      "gmail_profile_validation",
      new Error(
        "GMAIL_ADDRESS does not match the account authorized by GMAIL_REFRESH_TOKEN",
      ),
    );
  }
  logInfo("authentication_succeeded", logContext, {
    processingStage: "gmail_profile_validation",
  });

  const usageKey = dailyUsageKey();
  const usage = await runStage("daily_quota_read", () =>
    dailyDeliveryUsage(env.PROCESSED_EMAILS, usageKey),
  );
  const remainingDeliveries = Math.max(
    config.maxRecipientDeliveriesPerDay - usage,
    0,
  );
  const quotaMessageLimit = Math.floor(
    remainingDeliveries / config.recipients.length,
  );
  logInfo("delivery_quota_evaluated", logContext, {
    deliveryUsage: usage,
    deliveryLimit: config.maxRecipientDeliveriesPerDay,
    remainingDeliveries,
    recipientCount: config.recipients.length,
    forwardCapacity: quotaMessageLimit,
  });

  if (quotaMessageLimit === 0) {
    logWarning("delivery_quota_exhausted", logContext, {
      deliveryUsage: usage,
      deliveryLimit: config.maxRecipientDeliveriesPerDay,
      remainingDeliveries,
    });
  }

  const candidates = await runStage("inbox_scan", () =>
    findUnprocessedMessages(
      accessToken,
      env.PROCESSED_EMAILS,
      config.maxMessagesPerRun,
      config.maxInboxScanPerRun,
    ),
  );
  if (candidates.cursorToSave !== undefined) {
    const cursorToSave = candidates.cursorToSave;
    await runStage("inbox_cursor_write", () =>
      env.PROCESSED_EMAILS.put(INBOX_CURSOR_KEY, cursorToSave),
    );
    logInfo("inbox_cursor_saved", logContext, {
      cursorState:
        cursorToSave === INBOX_CURSOR_START
          ? "start"
          : "resume",
    });
  }
  logInfo("inbox_scan_completed", logContext, {
    scannedCount: candidates.scanned,
    processedSkippedCount: candidates.processedSkipped,
    selectedCount: candidates.messages.length,
    scanLimit: config.maxInboxScanPerRun,
    selectionLimit: config.maxMessagesPerRun,
    cursorSaved: candidates.cursorToSave !== undefined,
  });

  let sent = 0;
  let evaluated = 0;
  let matched = 0;
  let forwarded = 0;
  let filtered = 0;
  let deferred = 0;
  let failed = 0;

  for (const message of candidates.messages) {
    const messageStartedAt = Date.now();
    let processingStage = "message_content_download";
    let subject = "(unavailable)";
    let sentMessageId: string | undefined;

    try {
      const payload = await getMessageContent(accessToken, message.id);
      subject = messageSubject(payload);
      processingStage = "content_filter";
      const shouldForward = await messageContainsRequiredContent(
        accessToken,
        message.id,
        payload,
      );
      evaluated += 1;

      if (!shouldForward) {
        processingStage = "filtered_marker_write";
        await env.PROCESSED_EMAILS.put(
          processedKey(message.id),
          FILTERED_MARKER,
        );
        filtered += 1;
        logInfo("message_filtered", logContext, {
          messageId: message.id,
          subject,
          outcome: "filtered",
          reason: "required_content_missing",
          requiredContent: REQUIRED_CONTENT,
          previousState: "unprocessed",
          nextState: "filtered",
          markerStored: true,
          durationMs: elapsedMilliseconds(messageStartedAt),
        });
        continue;
      }
      matched += 1;

      if (sent >= quotaMessageLimit) {
        deferred += 1;
        logWarning("message_deferred", logContext, {
          messageId: message.id,
          subject,
          outcome: "deferred",
          reason: "daily_delivery_quota_exhausted",
          currentState: "unprocessed",
          markerStored: false,
          durationMs: elapsedMilliseconds(messageStartedAt),
        });
        continue;
      }

      processingStage = "raw_message_download";
      const raw = await getRawMessage(accessToken, message.id);
      processingStage = "message_encoding";
      const outgoing = createForwardMessage({
        raw,
        sender: config.gmailAddress,
        recipients: config.recipients,
        maximumBytes: config.maxMessageBytes,
      });
      processingStage = "gmail_send";
      logInfo("message_send_attempted", logContext, {
        messageId: message.id,
        subject,
        recipientCount: config.recipients.length,
        currentState: "unprocessed",
      });
      sentMessageId = await sendRawMessage(accessToken, outgoing);
      sent += 1;

      processingStage = "forwarded_marker_write";
      await env.PROCESSED_EMAILS.put(
        processedKey(message.id),
        FORWARDED_MARKER,
      );
      forwarded += 1;
      logInfo("message_forwarded", logContext, {
        messageId: message.id,
        subject,
        sentMessageId,
        outcome: "forwarded",
        previousState: "unprocessed",
        nextState: "forwarded",
        markerStored: true,
        recipientCount: config.recipients.length,
        durationMs: elapsedMilliseconds(messageStartedAt),
      });
    } catch (error) {
      failed += 1;
      const sentWithoutMarker =
        sentMessageId !== undefined &&
        processingStage === "forwarded_marker_write";
      const stopsRun = shouldStopAfter(error);

      logError(
        sentWithoutMarker
          ? "message_sent_without_marker"
          : "message_processing_failed",
        logContext,
        {
          messageId: message.id,
          subject,
          sentMessageId,
          outcome: "failed",
          processingStage,
          currentState: "unprocessed",
          markerStored: false,
          retryExpected: true,
          duplicateRisk: sentWithoutMarker,
          stopsRun,
          gmailStatus:
            error instanceof GmailApiError ? error.status : undefined,
          durationMs: elapsedMilliseconds(messageStartedAt),
          ...errorFields(error),
        },
      );

      if (sentWithoutMarker) {
        logWarning("duplicate_delivery_risk", logContext, {
          messageId: message.id,
          subject,
          sentMessageId,
          reason: "gmail_send_succeeded_but_kv_marker_failed",
        });
      }

      if (stopsRun) {
        break;
      }
    }
  }

  if (sent > 0) {
    const updatedUsage = usage + sent * config.recipients.length;
    await runStage("daily_quota_write", () =>
      env.PROCESSED_EMAILS.put(usageKey, String(updatedUsage), {
        expirationTtl: DAILY_USAGE_TTL_SECONDS,
      }),
    );
    logInfo("delivery_quota_updated", logContext, {
      previousDeliveryUsage: usage,
      currentDeliveryUsage: updatedUsage,
      deliveryLimit: config.maxRecipientDeliveriesPerDay,
    });
  }

  return {
    scanned: candidates.scanned,
    processedSkipped: candidates.processedSkipped,
    selected: candidates.messages.length,
    evaluated,
    matched,
    sent,
    forwarded,
    filtered,
    deferred,
    failed,
    deliveryLimitReached: deferred > 0,
  };
}
