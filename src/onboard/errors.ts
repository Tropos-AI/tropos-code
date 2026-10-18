// src/onboard/errors.ts — kept apart from the engine so the helpers the engine itself calls (autonomy, phone) can
// subclass it without an import cycle.

/** A message meant for the person running setup, shown as it is (no stack, no jargon). */
export class OnboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardError";
  }
}
