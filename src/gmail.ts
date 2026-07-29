import { fetchWithPolicy, type HttpRetryEvent } from "./http";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_HTTP_TIMEOUT_MS = 20_000;
const SAFE_REQUEST_MAX_ATTEMPTS = 3;

export interface GmailCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export interface GmailRequestOptions {
  readonly onRetry?: (event: HttpRetryEvent) => void;
}

export interface GmailMessageReference {
  readonly id: string;
  readonly threadId: string;
}

export interface GmailMessagePage {
  readonly messages: GmailMessageReference[];
  readonly nextPageToken?: string;
}

export interface GmailMessagePart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: {
    readonly name?: string;
    readonly value?: string;
  }[];
  readonly body?: {
    readonly attachmentId?: string;
    readonly data?: string;
    readonly size?: number;
  };
  readonly parts?: GmailMessagePart[];
}

interface TokenResponse {
  readonly access_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface RawMessageResponse {
  readonly id?: string;
  readonly raw?: string;
}

interface FullMessageResponse {
  readonly id?: string;
  readonly payload?: GmailMessagePart;
}

interface AttachmentResponse {
  readonly data?: string;
}

interface SentMessageResponse {
  readonly id?: string;
}

interface ProfileResponse {
  readonly emailAddress?: string;
}

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    operation: string,
    details: string,
  ) {
    super(`Gmail ${operation} failed (${status}): ${details}`);
    this.name = "GmailApiError";
  }

  get shouldStopRun(): boolean {
    return (
      this.status === 401 ||
      this.status === 403 ||
      this.status === 429 ||
      this.status >= 500
    );
  }
}

export type GmailOAuthRecovery =
  | "reauthorize_gmail"
  | "repair_oauth_client"
  | "retry_automatically";

const REAUTHORIZATION_ERRORS = new Set(["access_denied", "invalid_grant"]);
const CLIENT_CONFIGURATION_ERRORS = new Set([
  "deleted_client",
  "invalid_client",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
]);

export class GmailOAuthError extends Error {
  readonly recovery: GmailOAuthRecovery;

  constructor(
    readonly status: number,
    readonly code: string,
    details: string,
  ) {
    super(`Gmail OAuth token refresh failed (${code}): ${details}`);
    this.name = "GmailOAuthError";
    this.recovery = REAUTHORIZATION_ERRORS.has(code)
      ? "reauthorize_gmail"
      : CLIENT_CONFIGURATION_ERRORS.has(code)
        ? "repair_oauth_client"
        : "retry_automatically";
  }

  get requiresOperatorAction(): boolean {
    return this.recovery !== "retry_automatically";
  }
}

export class GmailDeliveryUncertainError extends Error {
  readonly status?: number;

  constructor(readonly originalError: unknown) {
    super(
      "Gmail message delivery could not be confirmed; the request may have succeeded",
    );
    this.name = "GmailDeliveryUncertainError";
    this.status =
      originalError instanceof GmailApiError ? originalError.status : undefined;
  }
}

function errorDetails(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

async function gmailRequest<T>(
  accessToken: string,
  operation: string,
  url: string,
  init?: RequestInit,
  options?: GmailRequestOptions,
  maxAttempts = SAFE_REQUEST_MAX_ATTEMPTS,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetchWithPolicy(
    url,
    {
      ...init,
      headers,
    },
    {
      operation: `Gmail ${operation}`,
      timeoutMs: GMAIL_HTTP_TIMEOUT_MS,
      maxAttempts,
      onRetry: options?.onRetry,
    },
  );
  const responseText = await response.text();

  if (!response.ok) {
    throw new GmailApiError(
      response.status,
      operation,
      errorDetails(responseText || response.statusText || "Unknown error"),
    );
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new GmailApiError(
      response.status,
      operation,
      "Gmail returned an invalid JSON response",
    );
  }
}

export async function refreshAccessToken(
  credentials: GmailCredentials,
  options?: GmailRequestOptions,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetchWithPolicy(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    {
      operation: "Gmail OAuth token refresh",
      timeoutMs: GMAIL_HTTP_TIMEOUT_MS,
      maxAttempts: SAFE_REQUEST_MAX_ATTEMPTS,
      onRetry: options?.onRetry,
    },
  );
  const responseText = await response.text();
  let result: TokenResponse;

  try {
    result = JSON.parse(responseText) as TokenResponse;
  } catch {
    throw new GmailApiError(
      response.status,
      "OAuth token refresh",
      "Google returned an invalid JSON response",
    );
  }

  if (!response.ok || result.access_token === undefined) {
    const details =
      result.error_description ?? result.error ?? "No access token returned";
    throw new GmailOAuthError(
      response.status,
      result.error ?? "invalid_token_response",
      errorDetails(details),
    );
  }

  return result.access_token;
}

export async function listInboxMessages(
  accessToken: string,
  maxResults: number,
  pageToken?: string,
  options?: GmailRequestOptions,
): Promise<GmailMessagePage> {
  const parameters = new URLSearchParams({
    labelIds: "INBOX",
    maxResults: String(maxResults),
    includeSpamTrash: "false",
  });

  if (pageToken !== undefined) {
    parameters.set("pageToken", pageToken);
  }

  const result = await gmailRequest<{
    messages?: GmailMessageReference[];
    nextPageToken?: string;
  }>(
    accessToken,
    "inbox listing",
    `${GMAIL_API_BASE}/messages?${parameters.toString()}`,
    undefined,
    options,
  );

  return {
    messages: result.messages ?? [],
    nextPageToken: result.nextPageToken,
  };
}

export async function getAuthenticatedAddress(
  accessToken: string,
  options?: GmailRequestOptions,
): Promise<string> {
  const result = await gmailRequest<ProfileResponse>(
    accessToken,
    "profile lookup",
    `${GMAIL_API_BASE}/profile`,
    undefined,
    options,
  );

  if (result.emailAddress === undefined) {
    throw new Error(
      "Gmail did not return an address for the authenticated user",
    );
  }

  return result.emailAddress;
}

export async function getRawMessage(
  accessToken: string,
  messageId: string,
  options?: GmailRequestOptions,
): Promise<string> {
  const result = await gmailRequest<RawMessageResponse>(
    accessToken,
    "message download",
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=raw`,
    undefined,
    options,
  );

  if (result.raw === undefined) {
    throw new Error(`Gmail message ${messageId} did not contain raw content`);
  }

  return result.raw;
}

export async function getMessageContent(
  accessToken: string,
  messageId: string,
  options?: GmailRequestOptions,
): Promise<GmailMessagePart> {
  const result = await gmailRequest<FullMessageResponse>(
    accessToken,
    "message content download",
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=full`,
    undefined,
    options,
  );

  if (result.payload === undefined) {
    throw new Error(`Gmail message ${messageId} did not contain a payload`);
  }

  return result.payload;
}

export async function getMessageAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
  options?: GmailRequestOptions,
): Promise<string> {
  const result = await gmailRequest<AttachmentResponse>(
    accessToken,
    "message attachment download",
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(
      messageId,
    )}/attachments/${encodeURIComponent(attachmentId)}`,
    undefined,
    options,
  );

  if (result.data === undefined) {
    throw new Error(`Gmail attachment ${attachmentId} did not contain data`);
  }

  return result.data;
}

export async function sendRawMessage(
  accessToken: string,
  raw: string,
  options?: GmailRequestOptions,
): Promise<string> {
  try {
    const result = await gmailRequest<SentMessageResponse>(
      accessToken,
      "message send",
      `${GMAIL_API_BASE}/messages/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      },
      options,
      1,
    );

    if (result.id === undefined) {
      throw new Error("Gmail did not return an ID for the sent message");
    }

    return result.id;
  } catch (error) {
    if (
      error instanceof GmailApiError &&
      error.status !== 408 &&
      error.status < 500
    ) {
      throw error;
    }

    throw new GmailDeliveryUncertainError(error);
  }
}
