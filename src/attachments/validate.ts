// src/attachments/validate.ts — checks what a browser or a chat sent with a prompt, and turns it into the user turn's
// content blocks. Nothing from the sender is trusted: types come from the bytes, sizes and counts are capped.
import type Anthropic from "@anthropic-ai/sdk";
import { neutraliseHarnessTags } from "../context/tags";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TEXT_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENTS,
  attachmentText,
  sniffImage,
  type Attachment,
} from "./attachments";

/** A refused attachment; the message is for the person who sent it. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

type UserBlock = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_NAME = 120;
const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** The file name without folders or control characters, or `fallback` when nothing is left. */
function cleanName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(0, MAX_NAME) || fallback;
}

function decode(name: string, data: string, max: number): Uint8Array {
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw new AttachmentError(`${name} could not be read.`);
  // Checked before decoding, so an oversized one costs nothing.
  if (Math.floor((data.length * 3) / 4) - (data.match(/=+$/)?.[0].length ?? 0) > max) throw new AttachmentError(`${name} is too big (the limit is ${MB(max)}).`);
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.length === 0) throw new AttachmentError(`${name} is empty.`);
  return bytes;
}

/** Validates a prompt's attachments; throws AttachmentError with a reason the sender can act on. */
export function validateAttachments(raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachmentError("The attachments could not be read.");
  const out: Attachment[] = [];
  for (const item of raw) {
    const a = item as { name?: unknown; mediaType?: unknown; data?: unknown } | null;
    if (!a || typeof a !== "object" || typeof a.name !== "string" || typeof a.mediaType !== "string" || typeof a.data !== "string") {
      throw new AttachmentError("An attachment could not be read.");
    }
    if (a.mediaType.startsWith("image/")) {
      const name = cleanName(a.name, "image");
      const bytes = decode(name, a.data, MAX_IMAGE_BYTES);
      const mediaType = sniffImage(bytes);
      if (!mediaType) throw new AttachmentError(`${name} isn't a PNG, JPEG, GIF or WebP image.`);
      out.push({ kind: "image", name, mediaType, data: a.data });
    } else {
      const name = cleanName(a.name, "attachment.txt");
      const bytes = decode(name, a.data, MAX_TEXT_ATTACHMENT_BYTES);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new AttachmentError(`${name} isn't a text file.`);
      }
      if (text.includes("\0")) throw new AttachmentError(`${name} isn't a text file.`);
      out.push({ kind: "text", name, text });
    }
  }
  if (out.filter((a) => a.kind === "image").length > MAX_IMAGES) throw new AttachmentError(`Up to ${MAX_IMAGES} images per message.`);
  if (out.filter((a) => a.kind === "text").length > MAX_TEXT_ATTACHMENTS) throw new AttachmentError(`Up to ${MAX_TEXT_ATTACHMENTS} files per message.`);
  return out;
}

/** The user turn's blocks for its attachments: text files first, then images, all before the typed text. */
export function attachmentBlocks(attachments: Attachment[]): UserBlock[] {
  const blocks: UserBlock[] = [];
  for (const a of attachments) {
    // A pasted file is the user's, but it may hold text copied from anywhere: it must not pose as the harness.
    if (a.kind === "text") blocks.push({ type: "text", text: attachmentText(a.name, neutraliseHarnessTags(a.text)) });
  }
  for (const a of attachments) {
    if (a.kind === "image") blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } });
  }
  return blocks;
}
