import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { sanitizeForTerminal } from "./terminal-safe";

const renderers = new Map<number, Marked>();

export function renderMarkdown(markdown: string, width = 80): string {
  let renderer = renderers.get(width);
  if (!renderer) {
    renderer = new Marked(markedTerminal({ width, reflowText: true, tab: 2 }));
    renderers.set(width, renderer);
  }
  // Sanitize the input, not the output: the renderer's own SGR colouring must survive.
  return (renderer.parse(sanitizeForTerminal(markdown)) as string).trimEnd();
}
