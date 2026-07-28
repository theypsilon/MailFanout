import { isEmailAddress } from "./config";

const UTF8_DECODER = new TextDecoder();
const UTF8_ENCODER = new TextEncoder();
const CONTENT_HEADERS = new Set([
  "content-description",
  "content-disposition",
  "content-id",
  "content-language",
  "content-location",
  "content-transfer-encoding",
  "content-type",
]);

interface ParsedMessage {
  readonly headers: Map<string, string[]>;
  readonly body: Uint8Array;
}

export class MessageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageFormatError";
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new MessageFormatError("Gmail returned invalid base64url content");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function standardBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }

  return btoa(binary);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return standardBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function findBodyStart(bytes: Uint8Array): {
  headerEnd: number;
  bodyStart: number;
} {
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) {
      return { headerEnd: index, bodyStart: index + 2 };
    }

    if (
      index < bytes.length - 3 &&
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return { headerEnd: index, bodyStart: index + 4 };
    }
  }

  throw new MessageFormatError(
    "Gmail message did not contain a header/body separator",
  );
}

function parseHeaders(value: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  let currentName: string | undefined;

  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentName !== undefined) {
      const values = headers.get(currentName);
      if (values !== undefined) {
        values[values.length - 1] += ` ${line.trim()}`;
      }
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      currentName = undefined;
      continue;
    }

    currentName = line.slice(0, separator).trim().toLowerCase();
    const currentValues = headers.get(currentName) ?? [];
    currentValues.push(line.slice(separator + 1).trim());
    headers.set(currentName, currentValues);
  }

  return headers;
}

function parseMessage(raw: string, maximumBytes: number): ParsedMessage {
  const estimatedBytes = Math.floor((raw.length * 3) / 4);
  if (estimatedBytes > maximumBytes) {
    throw new MessageFormatError(
      `Gmail message exceeds the configured ${maximumBytes}-byte limit`,
    );
  }

  const bytes = decodeBase64Url(raw);
  if (bytes.length > maximumBytes) {
    throw new MessageFormatError(
      `Gmail message exceeds the configured ${maximumBytes}-byte limit`,
    );
  }

  const { headerEnd, bodyStart } = findBodyStart(bytes);
  const headerText = UTF8_DECODER.decode(bytes.subarray(0, headerEnd));

  return {
    headers: parseHeaders(headerText),
    body: bytes.subarray(bodyStart),
  };
}

function sanitizedHeaderValue(value: string, maximumLength = 768): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, maximumLength);
}

function subjectHeader(value: string): string {
  const sanitized = sanitizedHeaderValue(value) || "(no subject)";
  const forwarded = `Fwd: ${sanitized}`;

  if (/^[\x20-\x7e]*$/.test(forwarded)) {
    return forwarded;
  }

  const encoded = standardBase64(UTF8_ENCODER.encode(forwarded));
  const chunks = encoded.match(/.{1,52}/g) ?? [];
  return chunks.map((chunk) => `=?UTF-8?B?${chunk}?=`).join("\r\n ");
}

function firstHeader(
  headers: Map<string, string[]>,
  name: string,
): string | undefined {
  return headers.get(name)?.[0];
}

function replyAddress(headers: Map<string, string[]>): string | undefined {
  const source =
    firstHeader(headers, "reply-to") ?? firstHeader(headers, "from");
  if (source === undefined) {
    return undefined;
  }

  const match = source.match(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  );
  const address = match?.[0];
  return address !== undefined && isEmailAddress(address)
    ? address
    : undefined;
}

function senderHeader(sender: string, originalSender?: string): string {
  if (originalSender === undefined) {
    return sender;
  }

  const displayName = `${originalSender} via MailFanout`.replace(
    /(["\\])/g,
    "\\$1",
  );
  return `"${displayName}" <${sender}>`;
}

function originalContentHeaders(
  headers: Map<string, string[]>,
): string[] {
  const result: string[] = [];

  for (const [name, values] of headers) {
    if (!CONTENT_HEADERS.has(name)) {
      continue;
    }

    const displayName = name
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("-");

    for (const value of values) {
      result.push(`${displayName}: ${sanitizedHeaderValue(value, 900)}`);
    }
  }

  return result;
}

export interface ForwardMessageOptions {
  readonly raw: string;
  readonly sender: string;
  readonly recipients: string[];
  readonly maximumBytes: number;
}

export function createForwardMessage(
  options: ForwardMessageOptions,
): string {
  const message = parseMessage(options.raw, options.maximumBytes);
  const originalSubject =
    firstHeader(message.headers, "subject") ?? "(no subject)";
  const originalMessageId = firstHeader(message.headers, "message-id");
  const replyTo = replyAddress(message.headers);

  const headers = [
    `From: ${senderHeader(options.sender, replyTo)}`,
    `Bcc: ${options.recipients.join(",\r\n ")}`,
    ...(replyTo === undefined ? [] : [`Reply-To: ${replyTo}`]),
    `Subject: ${subjectHeader(originalSubject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
    ...(originalMessageId === undefined
      ? []
      : [
          `X-MailFanout-Original-Message-ID: ${sanitizedHeaderValue(
            originalMessageId,
            256,
          )}`,
        ]),
    ...originalContentHeaders(message.headers),
  ];

  const outgoingHeaders = UTF8_ENCODER.encode(
    `${headers.join("\r\n")}\r\n\r\n`,
  );
  const outgoing = new Uint8Array(
    outgoingHeaders.length + message.body.length,
  );
  outgoing.set(outgoingHeaders);
  outgoing.set(message.body, outgoingHeaders.length);

  return encodeBase64Url(outgoing);
}
