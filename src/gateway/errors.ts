// src/gateway/errors.ts

/** An error whose message is safe and useful to show to the person in the chat (no paths, no secrets). */
export class UserFacingError extends Error {}

/** A `/name` that is neither a custom command nor a user-invocable skill. */
export class UnknownCommandError extends UserFacingError {}

/** The sandbox a chat's commands must run in is not available; the session is not started. */
export class SandboxUnavailableError extends UserFacingError {
  constructor(detail: string) {
    super(`The sandbox isn't available, so I can't start a session: ${detail}`);
  }
}

/** The chat's sender is no longer approved: no session starts for them, and nothing is said. */
export class SenderNotApprovedError extends Error {
  constructor() {
    super("This sender is no longer approved.");
  }
}
