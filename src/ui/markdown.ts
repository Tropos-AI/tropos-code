import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

const renderers = new Map<number, Marked>();

export function renderMarkdown(markdown: string, width = 80): string {
  let renderer = renderers.get(width);
  if (!renderer) {
    renderer = new Marked(markedTerminal({ width, reflowText: true, tab: 2 }));
    renderers.set(width, renderer);
  }
  return (renderer.parse(markdown) as string).trimEnd();
}
