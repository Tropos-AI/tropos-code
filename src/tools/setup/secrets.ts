// src/tools/setup/secrets.ts — a per-session vault for keys and tokens the owner pastes into a chat. The text is
// sealed before anything stores, shows or sends it (model, transcript, search index, other tabs); the setup tool
// later takes the value by its placeholder ref.

import { PROVIDERS } from "../../providers/registry";

export type SecretKind = "telegram-token" | "api-key";

export const SECRET_TTL_MS = 30 * 60_000;
export const MAX_SECRETS = 10;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every provider's key prefixes (the registry's), and a few common ones besides (Stripe-style sk_, Hugging Face hf_). */
const PREFIXES = [...new Set([...PROVIDERS.flatMap((p) => p.keyPrefixes ?? []), "sk_", "hf_"])].sort((a, b) => b.length - a.length);

// Telegram: <bot id>:<35-ish chars>. API keys: a known prefix, or z.ai's <32 hex>.<16 chars>.
const PATTERNS: { kind: SecretKind; re: RegExp }[] = [
  { kind: "telegram-token", re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  { kind: "api-key", re: new RegExp(`(?<![A-Za-z0-9_-])(?:${PREFIXES.map(escape).join("|")})[A-Za-z0-9_-]{20,}`, "g") },
  { kind: "api-key", re: /(?<![A-Za-z0-9_.-])[a-f0-9]{32}\.[A-Za-z0-9]{16}(?![A-Za-z0-9_-])/g },
];

/** A token long and random enough to be a key whatever its vendor: 32+ characters, mixed case and digits, high entropy. */
const TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const MIN_ENTROPY_BITS = 4;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

function looksRandom(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && entropy(token) >= MIN_ENTROPY_BITS;
}

const LABEL: Record<SecretKind, string> = { "telegram-token": "a Telegram bot token", "api-key": "an API key" };

/** Where secrets sit in the text, in order, never overlapping. */
export function findSecrets(text: string): { start: number; end: number; kind: SecretKind }[] {
  const found: { start: number; end: number; kind: SecretKind }[] = [];
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length, kind });
  }
  for (const m of text.matchAll(TOKEN)) if (looksRandom(m[0])) found.push({ start: m.index, end: m.index + m[0].length, kind: "api-key" });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: typeof found = [];
  for (const f of found) if (!out.length || f.start >= out[out.length - 1]!.end) out.push(f);
  return out;
}

interface Held {
  value: string;
  kind: SecretKind;
  expires: number;
}

export class SecretVault {
  private readonly held = new Map<string, Held>();
  private next = 1;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Replaces each secret in `text` with a placeholder and keeps the value for this session only. */
  seal(text: string): { text: string; sealed: number } {
    const found = findSecrets(text);
    if (found.length === 0) return { text, sealed: 0 };
    this.sweep();
    let out = "";
    let at = 0;
    for (const f of found) {
      const ref = `secret:${this.next++}`;
      this.held.set(ref, { value: text.slice(f.start, f.end), kind: f.kind, expires: this.now() + SECRET_TTL_MS });
      // The oldest goes first when the vault is full.
      while (this.held.size > MAX_SECRETS) this.held.delete(this.held.keys().next().value as string);
      out += `${text.slice(at, f.start)}[${ref}: ${LABEL[f.kind]}, held by Tropos]`;
      at = f.end;
    }
    return { text: out + text.slice(at), sealed: found.length };
  }

  /** Hands the value out once; it is gone afterwards. */
  take(ref: string): { value: string; kind: SecretKind } | undefined {
    const h = this.live(ref);
    if (!h) return undefined;
    this.held.delete(ref);
    return { value: h.value, kind: h.kind };
  }

  /** What a ref holds, without handing the value out. */
  peek(ref: string): { kind: SecretKind } | undefined {
    const h = this.live(ref);
    return h ? { kind: h.kind } : undefined;
  }

  private live(ref: string): Held | undefined {
    const h = this.held.get(ref);
    if (!h) return undefined;
    if (h.expires < this.now()) {
      this.held.delete(ref);
      return undefined;
    }
    return h;
  }

  private sweep(): void {
    for (const ref of [...this.held.keys()]) this.live(ref);
  }
}
