// src/attachments/attachments.ts — images and text files sent with a prompt: limits, the wire format, and how a text
// attachment reads in the conversation. No Node imports: the web app uses this too.

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Per image, after the browser's downscale; the Messages API's own limit. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The browser scales larger images down to this many pixels on the long side. */
export const MAX_IMAGE_DIMENSION = 2000;
export const MAX_IMAGES = 8;
export const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_TEXT_ATTACHMENTS = 8;
/** A paste longer than this (characters or lines) becomes an attachment instead of flooding the message box. */
export const BIG_PASTE_CHARS = 2000;
export const BIG_PASTE_LINES = 40;

/** One attachment as a prompt carries it: base64 bytes, what the sender says they are, and a file name. */
export interface PromptAttachment {
  name: string;
  mediaType: string;
  data: string;
}

/** An attachment that passed validation (src/attachments/validate.ts). */
export type Attachment = { kind: "image"; name: string; mediaType: ImageMediaType; data: string } | { kind: "text"; name: string; text: string };

/** The image type the bytes say, or null for anything else (SVG included: it can carry script). */
export function sniffImage(bytes: Uint8Array): ImageMediaType | null {
  const starts = (sig: number[], at = 0) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(ascii("GIF87a")) || starts(ascii("GIF89a"))) return "image/gif";
  if (starts(ascii("RIFF")) && starts(ascii("WEBP"), 8)) return "image/webp";
  return null;
}

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

export function isBigPaste(text: string): boolean {
  return text.length > BIG_PASTE_CHARS || lineCount(text) > BIG_PASTE_LINES;
}

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeAttr = (v: string) => v.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** How a text attachment reads in the user's message: a delimited file block. The caller neutralises the text. */
export function attachmentText(name: string, text: string): string {
  return `<attachment name="${escapeAttr(name)}">\n${text}\n</attachment>`;
}

const ATTACHMENT_BLOCK = /^<attachment name="([^"]*)">\n([\s\S]*)\n<\/attachment>$/;

/** The name and text of a block attachmentText made, or null for any other text. */
export function parseAttachmentText(text: string): { name: string; text: string } | null {
  const m = ATTACHMENT_BLOCK.exec(text);
  return m ? { name: unescapeAttr(m[1]!), text: m[2]! } : null;
}

/** What a model that can't see images gets in place of one. */
export function imageNote(name?: string): string {
  return `[image${name ? ` ${name}` : ""} omitted: this model can't see images]`;
}
