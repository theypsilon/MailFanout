const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GmailCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export interface GmailMessageReference {
  readonly id: string;
  readonly threadId: string;
}

export interface GmailMessagePage {
  readonly messages: GmailMessageReference[];
  readonly nextPageToken?: string;
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

function errorDetails(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

async function gmailRequest<T>(
  accessToken: string,
  operation: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new GmailApiError(
      response.status,
      operation,
      errorDetails(await response.text()),
    );
  }

  return (await response.json()) as T;
}

export async function refreshAccessToken(
  credentials: GmailCredentials,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const result = (await response.json()) as TokenResponse;
  if (!response.ok || result.access_token === undefined) {
    const details =
      result.error_description ?? result.error ?? "No access token returned";
    throw new GmailApiError(
      response.status,
      "OAuth token refresh",
      errorDetails(details),
    );
  }

  return result.access_token;
}

export async function listInboxMessages(
  accessToken: string,
  maxResults: number,
  pageToken?: string,
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
  );

  return {
    messages: result.messages ?? [],
    nextPageToken: result.nextPageToken,
  };
}

export async function getAuthenticatedAddress(
  accessToken: string,
): Promise<string> {
  const result = await gmailRequest<ProfileResponse>(
    accessToken,
    "profile lookup",
    `${GMAIL_API_BASE}/profile`,
  );

  if (result.emailAddress === undefined) {
    throw new Error("Gmail did not return an address for the authenticated user");
  }

  return result.emailAddress;
}

export async function getRawMessage(
  accessToken: string,
  messageId: string,
): Promise<string> {
  const result = await gmailRequest<RawMessageResponse>(
    accessToken,
    "message download",
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=raw`,
  );

  if (result.raw === undefined) {
    throw new Error(`Gmail message ${messageId} did not contain raw content`);
  }

  return result.raw;
}

export async function sendRawMessage(
  accessToken: string,
  raw: string,
): Promise<string> {
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
  );

  if (result.id === undefined) {
    throw new Error("Gmail did not return an ID for the sent message");
  }

  return result.id;
}
