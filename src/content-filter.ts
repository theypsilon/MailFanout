import {
  type GmailMessagePart,
  type GmailRequestOptions,
  getMessageAttachment,
} from "./gmail";
import { MessageFormatError } from "./message";

export const REQUIRED_CONTENT = "github.com";
export const FILTER_RULE_VERSION = 2;
const UTF8_DECODER = new TextDecoder();

export type RequiredContentMatch = "subject" | "body";

function subjectContainsRequiredContent(payload: GmailMessagePart): boolean {
  const subject = payload.headers?.find(
    (header) => header.name?.toLowerCase() === "subject",
  )?.value;

  return subject?.toLowerCase().includes(REQUIRED_CONTENT) ?? false;
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
    throw new MessageFormatError(
      "Gmail returned invalid base64url message content",
    );
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function partContainsRequiredContent(
  accessToken: string,
  messageId: string,
  part: GmailMessagePart,
  requestOptions?: GmailRequestOptions,
): Promise<boolean> {
  for (const child of part.parts ?? []) {
    if (
      await partContainsRequiredContent(
        accessToken,
        messageId,
        child,
        requestOptions,
      )
    ) {
      return true;
    }
  }

  const mimeType = part.mimeType?.toLowerCase();
  const isMessageBody =
    (mimeType === "text/plain" || mimeType === "text/html") &&
    (part.filename === undefined || part.filename === "");
  if (!isMessageBody) {
    return false;
  }

  let data = part.body?.data;
  const attachmentId = part.body?.attachmentId;
  if (data === undefined && attachmentId !== undefined) {
    data = await getMessageAttachment(
      accessToken,
      messageId,
      attachmentId,
      requestOptions,
    );
  }

  if (data === undefined || data === "") {
    return false;
  }

  return UTF8_DECODER.decode(decodeBase64Url(data))
    .toLowerCase()
    .includes(REQUIRED_CONTENT);
}

export async function findRequiredContentMatch(
  accessToken: string,
  messageId: string,
  payload: GmailMessagePart,
  requestOptions?: GmailRequestOptions,
): Promise<RequiredContentMatch | undefined> {
  if (subjectContainsRequiredContent(payload)) {
    return "subject";
  }

  return (await partContainsRequiredContent(
    accessToken,
    messageId,
    payload,
    requestOptions,
  ))
    ? "body"
    : undefined;
}
