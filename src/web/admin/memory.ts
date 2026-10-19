// src/web/admin/memory.ts — `memory.edit` / `memory.delete`: the owner changes or removes one note from the Memory page.
// The change is a ledger entry by "user" (so it shows up in Learned and can be undone), and a note that changed since
// the page loaded is refused rather than overwritten.
import { Ledger } from "../../learning/ledger";
import { NotesStore, type NotesTarget } from "../../memory/notes";
import type { MemoryTarget } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

const TARGETS: readonly MemoryTarget[] = ["memory", "user", "lessons", "heartbeat"];

function targetOf(value: unknown): NotesTarget {
  if (typeof value !== "string" || !(TARGETS as readonly string[]).includes(value)) throw new AdminError("That isn't a notes store.");
  return value as NotesTarget;
}

function indexOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new AdminError("That isn't a note.");
  return value;
}

function textOf(value: unknown): string {
  if (typeof value !== "string") throw new AdminError("The note's text is missing.");
  return value;
}

export function memoryHandlers(ctx: AdminContext): AdminHandlers {
  const store = () => new NotesStore(ctx.home, { ledger: new Ledger(ctx.home) });
  const settle = (result: { ok: boolean; error?: string }): { ok: true } => {
    if (!result.ok) throw new AdminError(result.error ?? "That note could not be changed.");
    return { ok: true };
  };
  return {
    async "memory.edit"(p) {
      return settle(await store().editAt(targetOf(p?.target), indexOf(p?.index), textOf(p?.expected), textOf(p?.content), "user"));
    },
    async "memory.delete"(p) {
      return settle(await store().editAt(targetOf(p?.target), indexOf(p?.index), textOf(p?.expected), null, "user"));
    },
  };
}
