import {
  GmailOAuthError,
  getAuthenticatedAddress,
  refreshAccessToken,
} from "../src/gmail.ts";

interface NodeRuntime {
  readonly process: {
    readonly env: Record<string, string | undefined>;
    exitCode?: number;
  };
}

const runtime = globalThis as unknown as NodeRuntime;
const environment = runtime.process.env;

function required(name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Missing required variable or secret: ${name}`);
  }
  return value;
}

try {
  const expectedAddress = required("GMAIL_ADDRESS");
  const requestOptions = {
    onRetry(event: {
      operation: string;
      attempt: number;
      nextAttempt: number;
      reason: string;
      status?: number;
    }) {
      console.warn({
        event: "oauth_check_retry",
        operation: event.operation,
        failedAttempt: event.attempt,
        nextAttempt: event.nextAttempt,
        reason: event.reason,
        httpStatus: event.status,
      });
    },
  };
  const accessToken = await refreshAccessToken(
    {
      clientId: required("GMAIL_CLIENT_ID"),
      clientSecret: required("GMAIL_CLIENT_SECRET"),
      refreshToken: required("GMAIL_REFRESH_TOKEN"),
    },
    requestOptions,
  );
  const authenticatedAddress = await getAuthenticatedAddress(
    accessToken,
    requestOptions,
  );

  if (authenticatedAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      "GMAIL_ADDRESS does not match the account authorized by GMAIL_REFRESH_TOKEN",
    );
  }

  console.log({
    event: "oauth_check_succeeded",
    authenticatedAddress,
  });
} catch (error) {
  console.error({
    event: "oauth_check_failed",
    errorType: error instanceof Error ? error.name : "UnknownError",
    errorMessage:
      error instanceof Error
        ? error.message.replace(/\s+/g, " ").trim().slice(0, 1_000)
        : String(error).slice(0, 1_000),
    oauthErrorCode: error instanceof GmailOAuthError ? error.code : undefined,
    recoveryAction:
      error instanceof GmailOAuthError ? error.recovery : undefined,
  });
  runtime.process.exitCode = 1;
}
