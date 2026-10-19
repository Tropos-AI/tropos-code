// web/src/components/chat/Attachments.tsx — images and files sent with a message: the composer's tray (thumbnails and
// "Pasted text · 312 lines" chips, each removable), the same set under a sent message, and the preview a chip opens.
import { useState } from "react";

import { lineCount, type Attachment } from "@core/attachments/attachments";

import { Modal } from "@/components/interior/modal";
import { Icon } from "@/components/ui/icon";
import { imageSrc } from "@/lib/attachments";
import { cn } from "@/lib/utils";

/** "Pasted text" for a big paste, else the file's name. */
function fileLabel(a: Extract<Attachment, { kind: "text" }>): string {
  return /^pasted-\d+\.txt$/.test(a.name) ? "Pasted text" : a.name;
}

function linesLabel(text: string): string {
  const n = lineCount(text);
  return `${n.toLocaleString()} ${n === 1 ? "line" : "lines"}`;
}

const CHIP_FOCUS = "outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]";

function FileChip({ attachment, onOpen, onRemove }: { attachment: Extract<Attachment, { kind: "text" }>; onOpen: () => void; onRemove?: () => void }) {
  const label = fileLabel(attachment);
  const lines = linesLabel(attachment.text);
  return (
    <span className="flex h-9 max-w-full items-center rounded-[10px] border border-rule bg-surface pl-1 pr-0.5 shadow-raised">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${label} · ${lines}: preview`}
        title={attachment.name}
        className={cn("flex h-8 min-w-0 items-center gap-1.5 rounded-[8px] px-1.5 text-[12.5px] text-ink hover:bg-paper-2", CHIP_FOCUS)}
      >
        <Icon name="file-text" size="sm" className="shrink-0 text-ink-3" />
        <span className="max-w-[22ch] truncate font-medium">{label}</span>
        <span className="shrink-0 text-ink-3 tabular-nums">· {lines}</span>
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          className={cn("grid size-8 shrink-0 place-items-center rounded-[8px] text-ink-3 hover:bg-paper-2 hover:text-ink", CHIP_FOCUS)}
        >
          <Icon name="x" size="sm" />
        </button>
      ) : null}
    </span>
  );
}

function Thumbnail({ attachment, size, onOpen, onRemove }: { attachment: Extract<Attachment, { kind: "image" }>; size: "sm" | "lg"; onOpen: () => void; onRemove?: () => void }) {
  return (
    <span className="group relative block">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`View ${attachment.name}`}
        className={cn(
          "block overflow-hidden rounded-[10px] border border-rule bg-paper-2 shadow-raised transition-transform duration-150 hover:-translate-y-px",
          CHIP_FOCUS,
          size === "sm" ? "size-14" : "size-24 sm:size-28",
        )}
      >
        <img src={imageSrc(attachment)} alt={attachment.name} className="size-full object-cover" draggable={false} />
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-ink text-paper shadow-[0_1px_2px_rgb(28_25_23/0.3)] outline-none hover:bg-[#292524] focus-visible:shadow-focus"
        >
          <Icon name="x" size="sm" className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/** The full image, or the file's text, in a dialog. */
export function AttachmentPreview({ attachment, onClose }: { attachment: Attachment | null; onClose: () => void }) {
  const description = attachment?.kind === "text" ? `${attachment.name} · ${linesLabel(attachment.text)}` : undefined;
  return (
    <Modal open={attachment !== null} onClose={onClose} title={attachment ? (attachment.kind === "text" ? fileLabel(attachment) : attachment.name) : ""} description={description} maxWidth={760}>
      {attachment?.kind === "text" ? (
        <pre className="scroll-quiet max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-rule bg-paper-2 p-3 font-mono text-[12.5px] leading-[1.55] text-ink">
          {attachment.text}
        </pre>
      ) : attachment?.kind === "image" ? (
        <img src={imageSrc(attachment)} alt={attachment.name} className="mx-auto max-h-[65vh] w-auto rounded-[10px] border border-rule" />
      ) : null}
    </Modal>
  );
}

type ListProps = {
  items: Array<{ key: string | number; attachment: Attachment }>;
  /** In the composer: each one can be removed. */
  onRemove?: (key: string | number) => void;
  label: string;
  size?: "sm" | "lg";
  className?: string;
};

/** A row of thumbnails and file chips; clicking one opens its preview. */
export function AttachmentList({ items, onRemove, label, size = "sm", className }: ListProps) {
  const [open, setOpen] = useState<Attachment | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <ul aria-label={label} className={cn("flex flex-wrap items-end gap-2", className)}>
        {items.map(({ key, attachment }) => (
          <li key={key} className="max-w-full">
            {attachment.kind === "image" ? (
              <Thumbnail attachment={attachment} size={size} onOpen={() => setOpen(attachment)} onRemove={onRemove ? () => onRemove(key) : undefined} />
            ) : (
              <FileChip attachment={attachment} onOpen={() => setOpen(attachment)} onRemove={onRemove ? () => onRemove(key) : undefined} />
            )}
          </li>
        ))}
      </ul>
      <AttachmentPreview attachment={open} onClose={() => setOpen(null)} />
    </>
  );
}
