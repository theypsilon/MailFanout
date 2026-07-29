import type { Env } from "./types";

const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const MAX_RECIPIENTS = 50;

export interface FanoutConfig {
  readonly gmailAddress: string;
  readonly recipients: string[];
  readonly gmailClientId: string;
  readonly gmailClientSecret: string;
  readonly gmailRefreshToken: string;
  readonly maxMessagesPerRun: number;
  readonly maxInboxScanPerRun: number;
  readonly maxRecipientDeliveriesPerDay: number;
  readonly maxMessageBytes: number;
}

function required(env: Env, name: keyof Env): string {
  const value = env[name];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required variable or secret: ${name}`);
  }

  return value.trim();
}

function integerSetting(
  value: string | undefined,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }

  return parsed;
}

export function isEmailAddress(value: string): boolean {
  const separator = value.lastIndexOf("@");
  return (
    value.length <= 254 &&
    separator > 0 &&
    separator <= 64 &&
    EMAIL_PATTERN.test(value)
  );
}

export function loadConfig(env: Env): FanoutConfig {
  const gmailAddress = required(env, "GMAIL_ADDRESS");
  if (!isEmailAddress(gmailAddress)) {
    throw new Error("GMAIL_ADDRESS is not a valid email address");
  }

  const recipientValue = required(env, "FORWARD_RECIPIENTS");
  const recipients = [
    ...new Map(
      recipientValue
        .split(/\s+/)
        .filter(Boolean)
        .map((address) => [address.toLowerCase(), address] as const),
    ).values(),
  ];

  if (recipients.length === 0) {
    throw new Error(
      "FORWARD_RECIPIENTS must contain at least one email address",
    );
  }

  const invalidRecipient = recipients.find(
    (address) => !isEmailAddress(address),
  );
  if (invalidRecipient !== undefined) {
    throw new Error(
      "FORWARD_RECIPIENTS must be a whitespace-separated list of email addresses",
    );
  }

  if (recipients.length > MAX_RECIPIENTS) {
    throw new Error(
      `FORWARD_RECIPIENTS cannot contain more than ${MAX_RECIPIENTS} addresses`,
    );
  }

  if (
    recipients.some(
      (address) => address.toLowerCase() === gmailAddress.toLowerCase(),
    )
  ) {
    throw new Error("GMAIL_ADDRESS cannot also appear in FORWARD_RECIPIENTS");
  }

  return {
    gmailAddress,
    recipients,
    gmailClientId: required(env, "GMAIL_CLIENT_ID"),
    gmailClientSecret: required(env, "GMAIL_CLIENT_SECRET"),
    gmailRefreshToken: required(env, "GMAIL_REFRESH_TOKEN"),
    maxMessagesPerRun: integerSetting(
      env.MAX_MESSAGES_PER_RUN,
      "MAX_MESSAGES_PER_RUN",
      1,
      25,
    ),
    maxInboxScanPerRun: integerSetting(
      env.MAX_INBOX_SCAN_PER_RUN,
      "MAX_INBOX_SCAN_PER_RUN",
      250,
      5_000,
    ),
    maxRecipientDeliveriesPerDay: integerSetting(
      env.MAX_RECIPIENT_DELIVERIES_PER_DAY,
      "MAX_RECIPIENT_DELIVERIES_PER_DAY",
      400,
      10_000,
    ),
    maxMessageBytes: integerSetting(
      env.MAX_MESSAGE_BYTES,
      "MAX_MESSAGE_BYTES",
      20 * 1024 * 1024,
      30 * 1024 * 1024,
    ),
  };
}
