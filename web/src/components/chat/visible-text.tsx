// web/src/components/chat/visible-text.tsx — text with its invisible characters made visible. Bidi overrides, zero-width
// characters and control codes can make a command read differently from what runs (the "Trojan Source" trick), so in a
// permission prompt each one is drawn as a labelled chip, as the terminal does with ⟨U+202E⟩.

/** Bidi controls, zero-width and joiner characters, line/paragraph separators, BOM, soft hyphen, C0/C1 controls (except tab and newline). */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

export type TextPart = { kind: "text"; text: string } | { kind: "hidden"; code: string };

/** "U+202E" for one character. */
export function codePointLabel(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

export function hasHiddenChars(text: string): boolean {
  HIDDEN.lastIndex = 0;
  return HIDDEN.test(text);
}

/** Splits text into plain runs and the hidden characters between them. */
export function splitHidden(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(HIDDEN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
    parts.push({ kind: "hidden", code: codePointLabel(match[0]) });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** Renders `text` with each hidden character as a visible ⟨U+XXXX⟩ chip. */
export function VisibleText({ text }: { text: string }) {
  const parts = splitHidden(text);
  return (
    <>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          part.text
        ) : (
          <span
            key={i}
            title={`Hidden character ${part.code}`}
            className="mx-px inline-flex items-center rounded-[4px] border border-warn/30 bg-warn-wash px-1 align-[0.05em] font-mono text-[0.78em] leading-[1.35] text-warn"
          >
            ⟨{part.code}⟩
          </span>
        ),
      )}
    </>
  );
}
