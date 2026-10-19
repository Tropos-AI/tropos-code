// src/tools/setup/matrix.test.ts
import { expect, test } from "bun:test";
import { SETUP_ACTIONS, setupDecision } from "./matrix";

const LOCAL = { role: "owner", origin: "local" } as const;
const CHAT = { role: "owner", origin: "channel" } as const;

test("the owner may do every action locally; in a chat the doctor is read-only", () => {
  for (const a of SETUP_ACTIONS) expect(setupDecision(a, LOCAL).ok).toBe(true);
  for (const a of SETUP_ACTIONS) expect(setupDecision(a, CHAT).ok).toBe(a !== "doctor.fix");
});

test("guests and scheduled runs may do nothing", () => {
  for (const role of ["guest", "scheduled"] as const)
    for (const a of SETUP_ACTIONS)
      for (const origin of ["local", "channel"] as const) expect(setupDecision(a, { role, origin })).toEqual({ ok: false, reason: "Only the owner can change Tropos's setup." });
});

test("nothing that raises autonomy or touches access, pairing, rules, hooks or the sandbox is an action at all", () => {
  for (const a of SETUP_ACTIONS) expect(a).not.toMatch(/raise|remote|pair|permission|rule|hook|sandbox|confine|autonomy\.set/);
});

test("an action the tool does not know is refused", () => {
  expect(setupDecision("autonomy.raise" as never, LOCAL).ok).toBe(false);
});
