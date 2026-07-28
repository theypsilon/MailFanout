export interface KVNamespace {
  get(key: string): Promise<string | null>;
  get(keys: string[]): Promise<Map<string, string | null>>;
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
    },
  ): Promise<void>;
}

export interface Env {
  readonly PROCESSED_EMAILS: KVNamespace;
  readonly GMAIL_ADDRESS?: string;
  readonly FORWARD_RECIPIENTS?: string;
  readonly GMAIL_CLIENT_ID?: string;
  readonly GMAIL_CLIENT_SECRET?: string;
  readonly GMAIL_REFRESH_TOKEN?: string;
  readonly MAX_MESSAGES_PER_RUN?: string;
  readonly MAX_INBOX_SCAN_PER_RUN?: string;
  readonly MAX_RECIPIENT_DELIVERIES_PER_DAY?: string;
  readonly MAX_MESSAGE_BYTES?: string;
}

export interface CronEvent {
  readonly cron: string;
  readonly scheduledTime: number;
}
