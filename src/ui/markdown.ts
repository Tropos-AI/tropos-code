import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { sanitizeForTerminal } from "./terminal-safe";

const renderers = new Map<number, Marked>();

export function renderMarkdown(markdown: string, width = 80): string {
  let renderer = renderers.get(width);
  if (!renderer) {
    renderer = new Marked(markedTerminal({ width, reflowText: true, tab: 2 }));
    // marked-terminal emits OSC 8 hyperlinks when the terminal supports them, which lets a link
    // label show one URL while the escape sequence carries another. Always show the real target.
    renderer.use({
      renderer: {
        link(this: { parser: { parseInline(tokens: unknown): string } }, token: { href: string; tokens: unknown }): string {
          const text = this.parser.parseInline(token.tokens);
          return text === token.href || text === "" ? token.href : `${text} (${token.href})`;
        },
      },
    });
    renderers.set(width, renderer);
  }
  // Sanitize the input, not the output: the renderer's own SGR colouring must survive.
  return (renderer.parse(sanitizeForTerminal(markdown)) as string).trimEnd();
}
