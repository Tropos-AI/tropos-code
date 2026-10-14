import { describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";
import { renderMarkdown, splitCodeBlocks } from "@/lib/markdown";

withDom();

describe("renderMarkdown", () => {
  test("renders GFM: headings, lists, inline code, fenced code, tables", () => {
    const html = renderMarkdown("# Title\n\n- one\n- `two`\n\n```ts\nconst a = 1 < 2;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li><code>two</code></li>");
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;');
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  test("strips script tags", () => {
    const html = renderMarkdown("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  test("strips event-handler attributes", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)"> <p onclick="steal()">hi</p>');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).toContain("hi");
  });

  test("drops javascript: links, in Markdown and in raw HTML", () => {
    const fromMarkdown = renderMarkdown("[click](javascript:alert(1))");
    const fromHtml = renderMarkdown('<a href="javascript:alert(1)">click</a> <a href="JaVaScRiPt:alert(2)">again</a>');
    for (const html of [fromMarkdown, fromHtml]) {
      expect(html.toLowerCase()).not.toContain("javascript:");
    }
  });

  test("links open in a new tab without opener or referrer", () => {
    const html = renderMarkdown("See [the docs](https://example.com/docs).");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("forbids forms, inputs, buttons, iframes and styles", () => {
    const html = renderMarkdown('<form action="/x"><input name="k"><button>go</button></form><iframe srcdoc="<b>x</b>"></iframe><style>body{display:none}</style><p style="color:red">kept</p>');
    for (const tag of ["<form", "<input", "<button", "<iframe", "<style"]) expect(html).not.toContain(tag);
    expect(html).not.toContain("style=");
    expect(html).toContain("kept");
  });

  test("task lists keep their state as glyphs instead of inputs", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).not.toContain("<input");
    expect(html).toContain("☑");
    expect(html).toContain("☐");
  });

  test("escapes text that only looks like HTML inside code", () => {
    const html = renderMarkdown("`<img src=x onerror=alert(1)>`");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });
});

describe("splitCodeBlocks", () => {
  test("cuts top-level fences out as plain code and keeps the Markdown around them", () => {
    const blocks = splitCodeBlocks("Intro **bold**\n\n```ts\nconst a = '<b>';\n```\n\nAfter.\n\n```\nplain\n```");
    expect(blocks).toEqual([
      { kind: "markdown", text: "Intro **bold**\n\n" },
      { kind: "code", lang: "ts", code: "const a = '<b>';" },
      { kind: "markdown", text: "After.\n\n" },
      { kind: "code", lang: "", code: "plain" },
    ]);
  });

  test("an unclosed fence while streaming is code up to the end", () => {
    expect(splitCodeBlocks("Run:\n\n```sh\nbun test")).toEqual([
      { kind: "markdown", text: "Run:\n\n" },
      { kind: "code", lang: "sh", code: "bun test" },
    ]);
  });

  test("text without code is one block; empty text is none", () => {
    expect(splitCodeBlocks("just text")).toEqual([{ kind: "markdown", text: "just text" }]);
    expect(splitCodeBlocks("")).toEqual([]);
  });
});
