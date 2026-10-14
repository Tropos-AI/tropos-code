// web/src/components/chat/MessageAssistant.tsx — the agent's reply as sanitized Markdown. Fenced code is cut out and
// rendered by React (stone-900, with an Interior Copy Button); everything else goes through renderMarkdown, the app's
// only HTML source. While the reply streams, a periwinkle caret sits at the end of the text.
import { memo, useMemo } from "react";

import { CopyButton } from "@/components/interior/copy-button";
import { renderMarkdown, splitCodeBlocks } from "@/lib/markdown";

const MarkdownSegment = memo(function MarkdownSegment({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // renderMarkdown sanitizes with DOMPurify: the sanctioned use of innerHTML.
  return <div className="md-seg prose-chat" dangerouslySetInnerHTML={{ __html: html }} />;
});

export const CodeBlock = memo(function CodeBlock({ lang, code, streaming = false }: { lang: string; code: string; streaming?: boolean }) {
  return (
    <figure className="chat-code overflow-hidden rounded-[12px] bg-code shadow-[inset_0_0_0_1px_var(--code-rule),0_1px_2px_rgb(28_25_23/0.12)]">
      <figcaption className="flex h-9 items-center justify-between gap-3 border-b border-code-rule pl-4 pr-1.5">
        <span className="font-mono text-[11px] tracking-[0.08em] text-[#a8a29e] lowercase">{lang || "code"}</span>
        <CopyButton
          value={code}
          label="Copy code"
          className="h-7 gap-1.5 rounded-[7px] border-transparent bg-transparent px-2 text-[12px] text-[#d6d3d1] shadow-none hover:bg-white/10 focus-visible:border-accent-soft"
        />
      </figcaption>
      <pre className="scroll-quiet overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.65] text-code-ink">
        <code>
          {code}
          {streaming ? <span aria-hidden className="chat-caret" /> : null}
        </code>
      </pre>
    </figure>
  );
});

type Props = {
  text: string;
  /** The reply is still arriving: show the caret. */
  streaming?: boolean;
};

export const MessageAssistant = memo(function MessageAssistant({ text, streaming = false }: Props) {
  const blocks = useMemo(() => splitCodeBlocks(text), [text]);
  const last = blocks.at(-1);
  return (
    <div className="chat-md text-ink" data-streaming={streaming ? "true" : undefined}>
      {blocks.map((block, i) =>
        block.kind === "markdown" ? (
          <MarkdownSegment key={i} text={block.text} />
        ) : (
          <CodeBlock key={i} lang={block.lang} code={block.code} streaming={streaming && block === last} />
        ),
      )}
      {streaming && blocks.length === 0 ? <span aria-hidden className="chat-caret" /> : null}
    </div>
  );
});
