import type { KVNamespace } from "../src/types.ts";

export class MemoryKv implements KVNamespace {
  private readonly putFailures = new Map<string, number>();

  constructor(readonly values = new Map<string, string>()) {}

  failNextPuts(key: string, count: number): void {
    this.putFailures.set(key, count);
  }

  get(key: string): Promise<string | null>;
  get(keys: string[]): Promise<Map<string, string | null>>;
  async get(
    keyOrKeys: string | string[],
  ): Promise<string | null | Map<string, string | null>> {
    if (typeof keyOrKeys === "string") {
      return this.values.get(keyOrKeys) ?? null;
    }

    return new Map(keyOrKeys.map((key) => [key, this.values.get(key) ?? null]));
  }

  async put(
    key: string,
    value: string,
    _options?: { expirationTtl?: number },
  ): Promise<void> {
    const remainingFailures = this.putFailures.get(key) ?? 0;
    if (remainingFailures > 0) {
      this.putFailures.set(key, remainingFailures - 1);
      throw new Error(`Temporary KV failure for ${key}`);
    }

    this.values.set(key, value);
  }
}

export function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    statusText: init?.statusText,
  });
}
