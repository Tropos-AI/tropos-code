// web/src/lib/markdown.ts — the ONLY place the web app turns text into HTML.
// Model and tool output are untrusted: Markdown is rendered with marked, then sanitized with DOMPurify before any of it
// reaches the DOM. Components render the result with dangerouslySetInnerHTML only through this function.
import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";
import { Marked } from "marked";

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Forms are forbidden below, so GFM task-list checkboxes become plain glyphs instead of being dropped.
    checkbox({ checked }) {
      return checked ? '<span class="task-box" data-checked="true">☑</span> ' : '<span class="task-box">☐</span> ';
    },
  },
});

const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "button", "iframe", "textarea", "select", "option", "object", "embed"],
  FORBID_ATTR: ["style"],
  ALLOW_DATA_ATTR: false,
};

let purifier: Purifier | null = null;

/** One DOMPurify instance per window, created on first use so importing this module never needs a DOM. */
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  // Every surviving link opens in a new tab without handing the opener (or the referrer) to the target.
  instance.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  purifier = instance;
  return instance;
}

/** Renders untrusted Markdown to sanitized HTML for the `.prose-chat` column. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return getPurifier().sanitize(html, PURIFY_CONFIG);
}

/** A reply cut into rendered Markdown and fenced code, so code blocks can be React-rendered with a copy button. */
export type MarkdownBlock = { kind: "markdown"; text: string } | { kind: "code"; lang: string; code: string };

/**
 * Splits Markdown at its top-level code blocks. Code stays plain text (rendered as React text nodes, never HTML); the
 * rest goes through renderMarkdown. Code nested in lists or quotes stays inside its Markdown block.
 */
export function splitCodeBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let pending = "";
  for (const token of marked.lexer(text)) {
    if (token.type === "code") {
      if (pending.trim()) blocks.push({ kind: "markdown", text: pending.replace(/^\n+/, "") });
      pending = "";
      const lang = typeof token.lang === "string" ? (token.lang.split(/\s/)[0] ?? "") : "";
      blocks.push({ kind: "code", lang, code: String(token.text ?? "") });
    } else {
      pending += token.raw;
    }
  }
  if (pending.trim()) blocks.push({ kind: "markdown", text: pending.replace(/^\n+/, "") });
  return blocks;
}
