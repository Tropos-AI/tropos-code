// src/agents/mention.ts
import { agentLabel } from "../extensions/agents";
import type { Specialist } from "./specialists";

export interface DirectCall {
  call: { name: "Agent"; input: { description: string; prompt: string; subagent_type: string } };
  reply(result: { text: string; isError: boolean }): string;
}

/** `@id message` at the start of a message; the id must be an active specialist, the message non-empty. */
export function parseMention(text: string, ids: string[]): { id: string; message: string } | null {
  const m = /^@([A-Za-z0-9_-]+)[,:]?\s+([\s\S]*\S)\s*$/.exec(text.trim());
  if (!m) return null;
  const id = ids.find((i) => i.toLowerCase() === m[1]!.toLowerCase());
  return id ? { id, message: m[2]! } : null;
}

/** The Agent call that hands the message to the specialist verbatim, and how its answer reads in the chat. */
export function mentionCall(text: string, specialists: Array<Pick<Specialist, "id" | "emoji">>): DirectCall | null {
  const mention = parseMention(text, specialists.map((s) => s.id));
  if (!mention) return null;
  const spec = specialists.find((s) => s.id === mention.id)!;
  const label = agentLabel({ name: spec.id, emoji: spec.emoji });
  let description = "";
  for (const word of mention.message.split(/\s+/).slice(0, 6)) {
    const next = description ? `${description} ${word}` : word;
    if (next.length > 60) break;
    description = next;
  }
  return {
    call: { name: "Agent", input: { description: description || spec.id, prompt: mention.message, subagent_type: spec.id } },
    reply: (r) => (r.isError ? `${label} couldn't finish:\n${r.text}` : `${label}:\n${r.text}`),
  };
}
