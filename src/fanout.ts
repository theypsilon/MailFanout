import { loadConfig, type FanoutConfig } from "./config";
import {
  getAuthenticatedAddress,
  getRawMessage,
  GmailApiError,
  type GmailMessageReference,
  listInboxMessages,
  refreshAccessToken,
  sendRawMessage,
} from "./gmail";
import { createForwardMessage, MessageFormatError } from "./message";
import type { Env, KVNamespace } from "./types";

const PROCESSED_KEY_PREFIX = "processed:";
const DAILY_USAGE_KEY_PREFIX = "deliveries:";
const INBOX_CURSOR_KEY = "state:inbox-cursor";
const INBOX_CURSOR_START = "-";
const DAILY_USAGE_TTL_SECONDS = 3 * 24 * 60 * 60;
const KV_BULK_READ_LIMIT = 100;

interface CandidateSearchResult {
  readonly messages: GmailMessageReference[];
  readonly scanned: number;
  readonly cursorToSave?: string;
}

export interface FanoutResult {
  readonly scanned: number;
  readonly selected: number;
  readonly forwarded: number;
  readonly failed: number;
  readonly deliveryLimitReached: boolean;
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
    return { messages, scanned };
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

  return { messages, scanned, cursorToSave };
}

function errorSummary(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 1_000)
    : "Unknown error";
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

export async function runMailFanout(env: Env): Promise<FanoutResult> {
  const config = loadConfig(env);
  const accessToken = await refreshAccessToken(gmailCredentials(config));
  const authenticatedAddress = await getAuthenticatedAddress(accessToken);
  if (
    authenticatedAddress.toLowerCase() !==
    config.gmailAddress.toLowerCase()
  ) {
    throw new Error(
      "GMAIL_ADDRESS does not match the account authorized by GMAIL_REFRESH_TOKEN",
    );
  }

  const usageKey = dailyUsageKey();
  const usage = await dailyDeliveryUsage(env.PROCESSED_EMAILS, usageKey);
  const remainingDeliveries = Math.max(
    config.maxRecipientDeliveriesPerDay - usage,
    0,
  );
  const quotaMessageLimit = Math.floor(
    remainingDeliveries / config.recipients.length,
  );
  const messageLimit = Math.min(
    config.maxMessagesPerRun,
    quotaMessageLimit,
  );

  if (messageLimit === 0) {
    console.warn("Mail fanout daily recipient-delivery limit reached", {
      usage,
      limit: config.maxRecipientDeliveriesPerDay,
    });
    return {
      scanned: 0,
      selected: 0,
      forwarded: 0,
      failed: 0,
      deliveryLimitReached: true,
    };
  }

  const candidates = await findUnprocessedMessages(
    accessToken,
    env.PROCESSED_EMAILS,
    messageLimit,
    config.maxInboxScanPerRun,
  );
  if (candidates.cursorToSave !== undefined) {
    await env.PROCESSED_EMAILS.put(
      INBOX_CURSOR_KEY,
      candidates.cursorToSave,
    );
  }

  let forwarded = 0;
  let failed = 0;

  for (const message of candidates.messages) {
    try {
      const raw = await getRawMessage(accessToken, message.id);
      const outgoing = createForwardMessage({
        raw,
        sender: config.gmailAddress,
        recipients: config.recipients,
        maximumBytes: config.maxMessageBytes,
      });
      const sentMessageId = await sendRawMessage(accessToken, outgoing);

      try {
        await env.PROCESSED_EMAILS.put(processedKey(message.id), "1");
      } catch (error) {
        console.error(
          "Message was sent, but its processed marker could not be saved",
          {
            sourceMessageId: message.id,
            sentMessageId,
            error: errorSummary(error),
          },
        );
        throw error;
      }

      forwarded += 1;
      console.log("Forwarded Gmail message", {
        sourceMessageId: message.id,
        sentMessageId,
      });
    } catch (error) {
      failed += 1;
      console.error("Could not forward Gmail message", {
        sourceMessageId: message.id,
        error: errorSummary(error),
      });

      if (shouldStopAfter(error)) {
        break;
      }
    }
  }

  if (forwarded > 0) {
    await env.PROCESSED_EMAILS.put(
      usageKey,
      String(usage + forwarded * config.recipients.length),
      { expirationTtl: DAILY_USAGE_TTL_SECONDS },
    );
  }

  return {
    scanned: candidates.scanned,
    selected: candidates.messages.length,
    forwarded,
    failed,
    deliveryLimitReached: quotaMessageLimit < config.maxMessagesPerRun,
  };
}
