import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudflareKvNamespace } from "../scripts/cloudflare-kv.ts";
import type { FanoutExecution } from "../src/run.ts";
import { executeMailFanout } from "../src/run.ts";
import type { Env, KVNamespace } from "../src/types.ts";
import { encodeBase64Url, jsonResponse, MemoryKv } from "./helpers.ts";

interface InboxMessage {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
}

type KvBackend = "cloudflare-rest" | "memory";
type SendBehavior = "accept" | "network-error";
type OAuthBehavior = "accept" | "revoked";

class FanoutWorld {
  readonly logs: Record<string, unknown>[] = [];
  readonly state = new Map<string, string>();
  readonly contentReads = new Map<string, number>();
  readonly rawReads = new Map<string, number>();
  readonly sentRaw: string[] = [];
  readonly settings: {
    MAX_RECIPIENT_DELIVERIES_PER_DAY?: string;
  } = {};
  readonly kv: KVNamespace;

  profileFailures = 0;
  oauthBehavior: OAuthBehavior = "accept";
  sendBehavior: SendBehavior = "accept";
  sendAttempts = 0;
  listRequests = 0;

  private readonly messages = new Map<string, InboxMessage>();
  private readonly pages: string[][] = [];
  private readonly memoryKv?: MemoryKv;
  private runCount = 0;

  constructor(readonly backend: KvBackend = "memory") {
    if (backend === "memory") {
      this.memoryKv = new MemoryKv(this.state);
      this.kv = this.memoryKv;
    } else {
      this.kv = new CloudflareKvNamespace({
        accountId: "account-id",
        namespaceId: "namespace-id",
        apiToken: "api-token",
      });
    }
  }

  setInboxPages(...pages: InboxMessage[][]): void {
    this.pages.length = 0;
    this.messages.clear();

    for (const page of pages) {
      this.pages.push(page.map((message) => message.id));
      for (const message of page) {
        this.messages.set(message.id, message);
      }
    }
  }

  markProcessed(messageId: string): void {
    this.state.set(this.processedKey(messageId), "processed");
  }

  failNextMarkerWrites(messageId: string, count: number): void {
    assert(this.memoryKv, "Marker failure injection requires memory KV");
    this.memoryKv.failNextPuts(this.processedKey(messageId), count);
  }

  wasProcessed(messageId: string): boolean {
    return this.state.has(this.processedKey(messageId));
  }

  events(name: string): Record<string, unknown>[] {
    return this.logs.filter((entry) => entry.event === name);
  }

  async run(): Promise<FanoutExecution> {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    this.runCount += 1;

    globalThis.fetch = this.fetch;
    const capture = (value?: unknown) => {
      if (typeof value === "object" && value !== null) {
        this.logs.push(value as Record<string, unknown>);
      }
    };
    console.log = capture;
    console.warn = capture;
    console.error = capture;

    const env: Env = {
      GMAIL_ADDRESS: "sender@gmail.com",
      FORWARD_RECIPIENTS: "one@example.com two@example.com",
      GMAIL_CLIENT_ID: "client-id",
      GMAIL_CLIENT_SECRET: "client-secret",
      GMAIL_REFRESH_TOKEN: "refresh-token",
      ...this.settings,
      PROCESSED_EMAILS: this.kv,
    };

    try {
      return await executeMailFanout(env, {
        trigger:
          this.backend === "cloudflare-rest"
            ? "github-actions"
            : "cloudflare-cron",
        scheduledTime: Date.UTC(2026, 6, 29, 12, this.runCount),
        runId: `scenario-run-${this.runCount}`,
      });
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  }

  private readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));

    if (url.hostname === "oauth2.googleapis.com") {
      if (this.oauthBehavior === "revoked") {
        return jsonResponse(
          {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          { status: 400 },
        );
      }
      return jsonResponse({ access_token: "access-token" });
    }

    if (url.hostname === "gmail.googleapis.com") {
      return this.gmailResponse(url, init);
    }

    if (url.hostname === "api.cloudflare.com") {
      return this.cloudflareResponse(url, init);
    }

    throw new Error(`Unexpected scenario request: ${url.toString()}`);
  };

  private gmailResponse(url: URL, init?: RequestInit): Response {
    if (url.pathname.endsWith("/profile")) {
      if (this.profileFailures > 0) {
        this.profileFailures -= 1;
        return jsonResponse({ error: "temporary" }, { status: 503 });
      }
      return jsonResponse({ emailAddress: "sender@gmail.com" });
    }

    if (url.pathname.endsWith("/messages/send")) {
      this.sendAttempts += 1;
      if (this.sendBehavior === "network-error") {
        throw new TypeError("connection reset");
      }

      const request = JSON.parse(String(init?.body)) as {
        raw?: string;
      };
      assert(request.raw !== undefined);
      this.sentRaw.push(request.raw);
      return jsonResponse({ id: `sent-${this.sendAttempts}` });
    }

    if (url.pathname.endsWith("/messages")) {
      this.listRequests += 1;
      const pageToken = url.searchParams.get("pageToken");
      const pageIndex =
        pageToken === null ? 0 : Number(pageToken.replace("page-", ""));
      const messageIds = this.pages[pageIndex] ?? [];
      const nextPageToken =
        pageIndex + 1 < this.pages.length ? `page-${pageIndex + 1}` : undefined;

      return jsonResponse({
        messages: messageIds.map((id) => ({
          id,
          threadId: `thread-${id}`,
        })),
        nextPageToken,
      });
    }

    const match = url.pathname.match(/\/messages\/([^/]+)$/);
    const messageId = match?.[1];
    const message =
      messageId === undefined
        ? undefined
        : this.messages.get(decodeURIComponent(messageId));
    assert(message, `Unknown scenario message: ${messageId}`);

    if (url.searchParams.get("format") === "full") {
      this.increment(this.contentReads, message.id);
      return jsonResponse({
        id: message.id,
        payload: {
          headers: [{ name: "Subject", value: message.subject }],
          mimeType: "text/plain",
          body: { data: encodeBase64Url(message.body) },
        },
      });
    }

    if (url.searchParams.get("format") === "raw") {
      this.increment(this.rawReads, message.id);
      return jsonResponse({
        id: message.id,
        raw: encodeBase64Url(
          [
            "From: Original <original@example.com>",
            `Subject: ${message.subject}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            message.body,
          ].join("\r\n"),
        ),
      });
    }

    throw new Error(`Unexpected Gmail scenario request: ${url.toString()}`);
  }

  private cloudflareResponse(url: URL, init?: RequestInit): Response {
    if (url.pathname.endsWith("/bulk/get")) {
      const request = JSON.parse(String(init?.body)) as {
        keys: string[];
      };
      const values = Object.fromEntries(
        request.keys
          .filter((key) => this.state.has(key))
          .map((key) => [key, this.state.get(key)]),
      );
      return jsonResponse({
        success: true,
        result: { values },
      });
    }

    const marker = "/values/";
    const markerIndex = url.pathname.indexOf(marker);
    if (init?.method === "PUT" && markerIndex >= 0) {
      const key = decodeURIComponent(
        url.pathname.slice(markerIndex + marker.length),
      );
      this.state.set(key, String(init.body));
      return jsonResponse({ success: true, result: {} });
    }

    throw new Error(
      `Unexpected Cloudflare scenario request: ${url.toString()}`,
    );
  }

  private processedKey(messageId: string): string {
    return `processed:${messageId}`;
  }

  private increment(values: Map<string, number>, key: string): void {
    values.set(key, (values.get(key) ?? 0) + 1);
  }
}

interface Scenario {
  readonly name: string;
  readonly backend?: KvBackend;
  readonly run: (world: FanoutWorld) => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    name: "fails loudly with an actionable event when OAuth is revoked",
    async run(world) {
      world.oauthBehavior = "revoked";
      world.setInboxPages([
        {
          id: "not-reached",
          subject: "github.com notification",
          body: "Body",
        },
      ]);

      await assert.rejects(world.run(), /expired or revoked/);

      assert.equal(world.listRequests, 0);
      assert.equal(world.sendAttempts, 0);
      assert.deepEqual(
        {
          oauthErrorCode: world.events("oauth_refresh_failed")[0]
            ?.oauthErrorCode,
          recoveryAction: world.events("oauth_refresh_failed")[0]
            ?.recoveryAction,
          requiresOperatorAction: world.events("oauth_refresh_failed")[0]
            ?.requiresOperatorAction,
          processingStage: world.events("run_failed")[0]?.processingStage,
        },
        {
          oauthErrorCode: "invalid_grant",
          recoveryAction: "reauthorize_gmail",
          requiresOperatorAction: true,
          processingStage: "oauth_refresh",
        },
      );
    },
  },
  {
    name: "forwards a subject match after a temporary Gmail failure",
    async run(world) {
      world.profileFailures = 1;
      world.setInboxPages([
        {
          id: "subject-match",
          subject: "Notification from GitHub.com",
          body: "No matching domain in the body",
        },
      ]);

      const execution = await world.run();

      assert.equal(execution.outcome, "success");
      assert.equal(world.sendAttempts, 1);
      assert.equal(world.wasProcessed("subject-match"), true);
      assert.equal(
        world.events("message_forwarded")[0]?.matchSource,
        "subject",
      );
      assert.equal(world.events("http_request_retry").length, 1);
    },
  },
  {
    name: "forwards a body match through the GitHub-compatible KV backend",
    backend: "cloudflare-rest",
    async run(world) {
      world.setInboxPages([
        {
          id: "body-match",
          subject: "Ordinary subject",
          body: "See https://github.com/example/repository",
        },
      ]);

      const execution = await world.run();

      assert.equal(execution.outcome, "success");
      assert.equal(world.sendAttempts, 1);
      assert.equal(world.wasProcessed("body-match"), true);
      assert.equal(world.events("message_forwarded")[0]?.matchSource, "body");
    },
  },
  {
    name: "filters an unrelated message once and skips it thereafter",
    async run(world) {
      world.setInboxPages([
        {
          id: "filtered",
          subject: "Ordinary message",
          body: "No matching domain",
        },
      ]);
      world.failNextMarkerWrites("filtered", 1);

      const firstRun = await world.run();
      const secondRun = await world.run();

      assert.equal(firstRun.outcome, "success");
      assert.equal(secondRun.outcome, "success");
      assert.equal(world.sendAttempts, 0);
      assert.equal(world.wasProcessed("filtered"), true);
      assert.equal(world.contentReads.get("filtered"), 1);
      assert.equal(world.events("message_filtered").length, 1);
      assert.equal(world.events("state_write_retry").length, 1);
      assert.equal(
        world.events("inbox_scan_completed").at(-1)?.processedSkippedCount,
        1,
      );
    },
  },
  {
    name: "defers a matching message when the delivery budget is exhausted",
    async run(world) {
      world.settings.MAX_RECIPIENT_DELIVERIES_PER_DAY = "1";
      world.setInboxPages([
        {
          id: "deferred",
          subject: "github.com notification",
          body: "Body",
        },
      ]);

      const execution = await world.run();

      assert.equal(execution.outcome, "completed_with_deferred_messages");
      assert.equal(world.sendAttempts, 0);
      assert.equal(world.wasProcessed("deferred"), false);
      assert.equal(world.events("message_deferred").length, 1);
    },
  },
  {
    name: "leaves an uncertain Gmail delivery unmarked and alertable",
    async run(world) {
      world.sendBehavior = "network-error";
      world.setInboxPages([
        {
          id: "uncertain",
          subject: "github.com alert",
          body: "Body",
        },
      ]);

      const execution = await world.run();

      assert.equal(execution.outcome, "partial_failure");
      assert.equal(world.sendAttempts, 1);
      assert.equal(world.wasProcessed("uncertain"), false);
      assert.equal(world.events("message_delivery_uncertain").length, 1);
      assert.equal(world.events("duplicate_delivery_risk").length, 1);
    },
  },
  {
    name: "recovers a forwarded-marker write without sending twice",
    async run(world) {
      world.setInboxPages([
        {
          id: "marker-retry",
          subject: "github.com notification",
          body: "Body",
        },
      ]);
      world.failNextMarkerWrites("marker-retry", 1);

      const execution = await world.run();

      assert.equal(execution.outcome, "success");
      assert.equal(world.sendAttempts, 1);
      assert.equal(world.wasProcessed("marker-retry"), true);
      assert.equal(world.events("message_marker_write_retry").length, 1);
      assert.equal(world.events("message_marker_write_recovered").length, 1);
    },
  },
  {
    name: "continues through a processed page to find older backlog",
    async run(world) {
      world.setInboxPages(
        [
          {
            id: "newest-processed",
            subject: "Already handled",
            body: "Body",
          },
        ],
        [
          {
            id: "older-pending",
            subject: "github.com backlog",
            body: "Body",
          },
        ],
      );
      world.markProcessed("newest-processed");

      const execution = await world.run();

      assert.equal(execution.outcome, "success");
      assert.equal(world.listRequests, 2);
      assert.equal(world.contentReads.has("newest-processed"), false);
      assert.equal(world.contentReads.get("older-pending"), 1);
      assert.equal(world.sendAttempts, 1);
      assert.equal(world.wasProcessed("older-pending"), true);
      assert.equal(world.events("inbox_cursor_saved").length, 1);
    },
  },
];

for (const scenario of scenarios) {
  test(scenario.name, { concurrency: false }, async () => {
    await scenario.run(new FanoutWorld(scenario.backend));
  });
}
