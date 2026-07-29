import { fetchWithPolicy, type HttpRetryEvent } from "../src/http.ts";
import type { KVNamespace } from "../src/types.ts";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const BULK_READ_LIMIT = 100;
const MINIMUM_EXPIRATION_TTL_SECONDS = 60;
const HTTP_TIMEOUT_MS = 15_000;
const HTTP_MAX_ATTEMPTS = 3;

interface ApiError {
  readonly code?: number;
  readonly message?: string;
}

interface ApiEnvelope<T> {
  readonly success?: boolean;
  readonly result?: T;
  readonly errors?: ApiError[];
}

interface BulkGetResult {
  readonly values?: Record<string, unknown>;
}

export interface CloudflareKvOptions {
  readonly accountId: string;
  readonly namespaceId: string;
  readonly apiToken: string;
  readonly onRetry?: (event: HttpRetryEvent) => void;
}

export class CloudflareKvApiError extends Error {
  readonly status: number;

  constructor(status: number, operation: string, details: string) {
    super(`Cloudflare KV ${operation} failed (${status}): ${details}`);
    this.name = "CloudflareKvApiError";
    this.status = status;
  }
}

function apiErrorDetails(
  envelope: ApiEnvelope<unknown> | undefined,
  fallback: string,
): string {
  const details = envelope?.errors
    ?.map((error) =>
      error.code === undefined
        ? error.message
        : `${error.code}: ${error.message ?? "Unknown error"}`,
    )
    .filter((value): value is string => value !== undefined)
    .join("; ");

  return (details || fallback).replace(/\s+/g, " ").trim().slice(0, 500);
}

export class CloudflareKvNamespace implements KVNamespace {
  private readonly namespaceUrl: string;
  private readonly authorization: string;
  private readonly onRetry?: (event: HttpRetryEvent) => void;

  constructor(options: CloudflareKvOptions) {
    this.namespaceUrl =
      `${CLOUDFLARE_API_BASE}/accounts/` +
      `${encodeURIComponent(options.accountId)}/storage/kv/namespaces/` +
      encodeURIComponent(options.namespaceId);
    this.authorization = `Bearer ${options.apiToken}`;
    this.onRetry = options.onRetry;
  }

  get(key: string): Promise<string | null>;
  get(keys: string[]): Promise<Map<string, string | null>>;
  async get(
    keyOrKeys: string | string[],
  ): Promise<string | null | Map<string, string | null>> {
    const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
    const values = await this.bulkGet(keys);

    return typeof keyOrKeys === "string"
      ? (values.get(keyOrKeys) ?? null)
      : values;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const url = new URL(
      `${this.namespaceUrl}/values/${encodeURIComponent(key)}`,
    );
    const expirationTtl = options?.expirationTtl;

    if (expirationTtl !== undefined) {
      if (
        !Number.isSafeInteger(expirationTtl) ||
        expirationTtl < MINIMUM_EXPIRATION_TTL_SECONDS
      ) {
        throw new Error(
          "Cloudflare KV expirationTtl must be an integer of at least 60 seconds",
        );
      }
      url.searchParams.set("expiration_ttl", String(expirationTtl));
    }

    await this.request<unknown>("write", url, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: value,
    });
  }

  private async bulkGet(keys: string[]): Promise<Map<string, string | null>> {
    if (keys.length > BULK_READ_LIMIT) {
      throw new Error(
        `Cloudflare KV bulk reads support at most ${BULK_READ_LIMIT} keys`,
      );
    }

    if (keys.length === 0) {
      return new Map();
    }

    const result = await this.request<BulkGetResult>(
      "bulk read",
      `${this.namespaceUrl}/bulk/get`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          keys,
          type: "text",
          withMetadata: false,
        }),
      },
    );
    const responseValues = result.values ?? {};
    const values = new Map<string, string | null>();

    for (const key of keys) {
      if (!Object.hasOwn(responseValues, key)) {
        values.set(key, null);
        continue;
      }

      const value = responseValues[key];
      if (value === null) {
        values.set(key, null);
        continue;
      }
      if (typeof value !== "string") {
        throw new CloudflareKvApiError(
          200,
          "bulk read",
          `Cloudflare returned a non-text value for key ${key}`,
        );
      }
      values.set(key, value);
    }

    return values;
  }

  private async request<T>(
    operation: string,
    input: string | URL,
    init: RequestInit,
  ): Promise<T> {
    let response: Response;

    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", this.authorization);
      response = await fetchWithPolicy(
        input,
        { ...init, headers },
        {
          operation: `Cloudflare KV ${operation}`,
          timeoutMs: HTTP_TIMEOUT_MS,
          maxAttempts: HTTP_MAX_ATTEMPTS,
          onRetry: this.onRetry,
        },
      );
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new CloudflareKvApiError(0, operation, details);
    }

    const responseText = await response.text();
    let envelope: ApiEnvelope<T> | undefined;

    if (responseText !== "") {
      try {
        envelope = JSON.parse(responseText) as ApiEnvelope<T>;
      } catch {
        throw new CloudflareKvApiError(
          response.status,
          operation,
          "Cloudflare returned an invalid JSON response",
        );
      }
    }

    if (!response.ok || envelope?.success !== true) {
      throw new CloudflareKvApiError(
        response.status,
        operation,
        apiErrorDetails(envelope, response.statusText || "Unknown error"),
      );
    }

    if (envelope.result === undefined) {
      throw new CloudflareKvApiError(
        response.status,
        operation,
        "Cloudflare returned no result",
      );
    }

    return envelope.result;
  }
}
