import { Marked, type RendererThis, type Tokens } from "marked";
import { markedTerminal } from "marked-terminal";
import { sanitizeForTerminal } from "./terminal-safe";

const renderers = new Map<number, Marked>();

// Each nesting level indents a list by this much, as marked-terminal does with `tab: 2`.
const LIST_INDENT = 2;

export function renderMarkdown(markdown: string, width = 80): string {
  let renderer = renderers.get(width);
  if (!renderer) {
    renderer = new Marked(markedTerminal({ width, reflowText: true, tab: LIST_INDENT }));
    // Lists are rendered here, not by marked-terminal: with marked 15 it leaves the inline markup of a list item as
    // typed (`**bold**`, backticks) and never wraps it, so a long item was cut wherever the terminal ran out of room.
    // The hanging indent of each list being rendered, so a nested list lines up under its parent item's text.
    const hangs: string[] = [];
    renderer.use({
      renderer: {
        // marked-terminal emits OSC 8 hyperlinks when the terminal supports them, which lets a link
        // label show one URL while the escape sequence carries another. Always show the real target.
        link(this: { parser: { parseInline(tokens: unknown): string } }, token: { href: string; tokens: unknown }): string {
          const text = this.parser.parseInline(token.tokens);
          return text === token.href || text === "" ? token.href : `${text} (${token.href})`;
        },
        // A tight list item's text carries inline tokens; render them. Plain text falls through to marked-terminal.
        text(this: RendererThis, token: Tokens.Text | Tokens.Escape): string | false {
          return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : false;
        },
        list(this: RendererThis, token: Tokens.List): string {
          const top = hangs.length === 0;
          const indent = hangs.at(-1) ?? " ".repeat(LIST_INDENT);
          const start = token.start === "" ? 1 : token.start;
          const markers = token.items.map((_, i) => (token.ordered ? `${start + i}.` : "*"));
          const markerWidth = Math.max(...markers.map((m) => m.length)) + 1;
          const hanging = indent + " ".repeat(markerWidth);
          hangs.push(hanging);
          try {
            const items = token.items.map((item, i) => {
              const lines: string[] = [];
              let first = true;
              const prefix = () => (first ? indent + markers[i]!.padEnd(markerWidth) : hanging);
              const add = (text: string) => {
                const wrapped = Bun.wrapAnsi(text, Math.max(20, width - hanging.length), { hard: true, trim: true });
                for (const line of wrapped.split("\n")) {
                  lines.push(prefix() + line);
                  first = false;
                }
              };
              const checkbox = item.task ? (item.checked ? "[X] " : "[ ] ") : "";
              let pending = checkbox;
              for (const child of item.tokens) {
                if (child.type === "list") {
                  // A nested list indents itself.
                  if (pending) add(pending.trimEnd());
                  pending = "";
                  if (first) lines.push(indent + markers[i]!);
                  first = false;
                  lines.push(this.parser.parse([child]).replace(/\n+$/, ""));
                } else if (child.type === "text" || child.type === "paragraph") {
                  if (item.loose && lines.length > 0) lines.push("");
                  const text = "tokens" in child && child.tokens ? this.parser.parseInline(child.tokens) : child.text;
                  add(pending + text);
                  pending = "";
                } else if (child.type !== "space") {
                  if (pending) add(pending.trimEnd());
                  pending = "";
                  for (const line of this.parser.parse([child]).replace(/\n+$/, "").split("\n")) {
                    lines.push(prefix() + line);
                    first = false;
                  }
                }
              }
              if (pending) add(pending.trimEnd());
              if (lines.length === 0) lines.push(indent + markers[i]!);
              return lines.join("\n");
            });
            const body = items.join(token.loose ? "\n\n" : "\n");
            return top ? `${body}\n\n` : body;
          } finally {
            hangs.pop();
          }
        },
      },
    });
    renderers.set(width, renderer);
  }
  // Sanitize the input, not the output: the renderer's own SGR colouring must survive.
  return (renderer.parse(sanitizeForTerminal(markdown)) as string).trimEnd();
}
