import Anthropic from "@anthropic-ai/sdk";

export interface DescribedError {
  message: string;
  retryable: boolean;
}

/** Turns SDK errors into one-line messages. Matches on error classes, never on message text. */
export function describeError(err: unknown): DescribedError {
  if (err instanceof Anthropic.AuthenticationError) {
    return { message: "Authentication failed. Set ANTHROPIC_API_KEY or run `ant auth login`, then try again.", retryable: false };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { message: `This API key can't use that model or feature: ${err.message}`, retryable: false };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { message: "Rate limited by the API, even after retrying. Wait a moment and send your message again.", retryable: true };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { message: `The API rejected the request: ${err.message}`, retryable: false };
  }
  if (err instanceof Anthropic.InternalServerError) {
    return { message: `The API is having trouble (${err.status}), even after retrying. Send your message again shortly.`, retryable: true };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { message: `Could not reach the API: ${err.message}. Check your connection and try again.`, retryable: true };
  }
  if (err instanceof Anthropic.APIError) {
    return { message: `API error${err.status ? ` ${err.status}` : ""}: ${err.message}`, retryable: (err.status ?? 0) >= 500 };
  }
  // The SDK throws a plain Error (no class to match) when no credentials can be found.
  if (err instanceof Error && err.message.startsWith("Could not resolve authentication method")) {
    return { message: "No API credentials found. Set ANTHROPIC_API_KEY or run `ant auth login`, then try again.", retryable: false };
  }
  if (err instanceof Error) return { message: err.message, retryable: false };
  return { message: String(err), retryable: false };
}
