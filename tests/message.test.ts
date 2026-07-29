import assert from "node:assert/strict";
import { test } from "node:test";
import { createForwardMessage, MessageFormatError } from "../src/message.ts";
import { decodeBase64Url, encodeBase64Url } from "./helpers.ts";

test("createForwardMessage preserves MIME content and uses Bcc", () => {
  const source = [
    "From: Original Sender <original@example.com>",
    "Reply-To: replies@example.com",
    "Subject: Build completed",
    "Message-ID: <message-1@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Original body",
  ].join("\r\n");

  const outgoing = decodeBase64Url(
    createForwardMessage({
      raw: encodeBase64Url(source),
      sender: "sender@gmail.com",
      recipients: ["one@example.com", "two@example.com"],
      maximumBytes: 100_000,
    }),
  );

  assert.match(outgoing, /^From: "replies@example.com via MailFanout"/);
  assert.match(outgoing, /\r\nBcc: one@example.com,\r\n two@example.com\r\n/);
  assert.doesNotMatch(outgoing, /\r\nTo:/);
  assert.match(outgoing, /\r\nReply-To: replies@example.com\r\n/);
  assert.match(outgoing, /\r\nSubject: Fwd: Build completed\r\n/);
  assert.match(
    outgoing,
    /\r\nX-MailFanout-Original-Message-ID: <message-1@example.com>\r\n/,
  );
  assert.match(
    outgoing,
    /\r\nContent-Type: text\/plain; charset=utf-8\r\n\r\nOriginal body$/,
  );
});

test("createForwardMessage rejects a message over the configured limit", () => {
  const source = "Subject: Too large\r\n\r\n0123456789";

  assert.throws(
    () =>
      createForwardMessage({
        raw: encodeBase64Url(source),
        sender: "sender@gmail.com",
        recipients: ["one@example.com"],
        maximumBytes: 5,
      }),
    MessageFormatError,
  );
});

test("createForwardMessage rejects a malformed message", () => {
  assert.throws(
    () =>
      createForwardMessage({
        raw: encodeBase64Url("Subject: Missing separator"),
        sender: "sender@gmail.com",
        recipients: ["one@example.com"],
        maximumBytes: 1_000,
      }),
    /header\/body separator/,
  );
});
