const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type HttpRetryReason = "network" | "status" | "timeout";

export interface HttpRetryEvent {
  readonly operation: string;
  readonly attempt: number;
  readonly nextAttempt: number;
  readonly delayMs: number;
  readonly reason: HttpRetryReason;
  readonly status?: number;
}

export interface HttpRequestPolicy {
  readonly operation: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (event: HttpRetryEvent) => void;
}

export class HttpTransportError extends Error {
  constructor(
    readonly operation: string,
    readonly reason: "network" | "timeout",
    readonly attempts: number,
    readonly originalError: unknown,
  ) {
    super(
      `${operation} failed after ${attempts} attempt${
        attempts === 1 ? "" : "s"
      }: ${reason}`,
    );
    this.name = "HttpTransportError";
  }
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveInteger(
  value: number | undefined,
  defaultValue: number,
  name: string,
): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result;
}

function retryAfterMilliseconds(
  response: Response,
  now = Date.now(),
): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (value === undefined || value === "") {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1_000), MAX_RETRY_DELAY_MS);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.min(Math.max(date - now, 0), MAX_RETRY_DELAY_MS);
}

function retryDelayMilliseconds(attempt: number, response?: Response): number {
  const retryAfter =
    response === undefined ? undefined : retryAfterMilliseconds(response);
  if (retryAfter !== undefined) {
    return retryAfter;
  }

  const exponential = Math.min(
    INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
  const jitterMultiplier = 0.8 + Math.min(Math.max(Math.random(), 0), 1) * 0.4;
  return Math.round(exponential * jitterMultiplier);
}

async function fetchOnce(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);

  if (upstreamSignal?.aborted === true) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, {
      once: true,
    });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetcher(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new HttpTransportError("HTTP request", "timeout", 1, error);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

export async function fetchWithPolicy(
  input: RequestInfo | URL,
  init: RequestInit,
  policy: HttpRequestPolicy,
): Promise<Response> {
  const timeoutMs = positiveInteger(
    policy.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxAttempts = positiveInteger(
    policy.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;

    try {
      response = await fetchOnce(fetch, input, init, timeoutMs);
    } catch (error) {
      if (init.signal?.aborted === true) {
        throw error;
      }

      const reason =
        error instanceof HttpTransportError && error.reason === "timeout"
          ? "timeout"
          : "network";
      if (attempt === maxAttempts) {
        throw new HttpTransportError(
          policy.operation,
          reason,
          attempt,
          error instanceof HttpTransportError ? error.originalError : error,
        );
      }

      const delayMs = retryDelayMilliseconds(attempt);
      policy.onRetry?.({
        operation: policy.operation,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        reason,
      });
      await defaultWait(delayMs);
      continue;
    }

    if (
      attempt === maxAttempts ||
      !RETRYABLE_STATUS_CODES.has(response.status)
    ) {
      return response;
    }

    const delayMs = retryDelayMilliseconds(attempt, response);
    policy.onRetry?.({
      operation: policy.operation,
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
      reason: "status",
      status: response.status,
    });
    await response.body?.cancel().catch(() => undefined);
    await defaultWait(delayMs);
  }

  throw new Error("HTTP retry loop ended unexpectedly");
}
