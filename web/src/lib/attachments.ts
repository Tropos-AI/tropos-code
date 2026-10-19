// web/src/lib/attachments.ts — files the composer attaches: images (scaled down in the browser first) and text or code
// files, read into the shape the transcript shows and turned into the prompt RPC's wire format. The server checks
// everything again (src/attachments/validate.ts); these checks only spare the user a round trip.
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_TEXT_ATTACHMENT_BYTES,
  type Attachment,
  type ImageMediaType,
  type PromptAttachment,
} from "@core/attachments/attachments";

const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // In chunks: String.fromCharCode with a few million arguments overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function toPromptAttachment(a: Attachment): PromptAttachment {
  if (a.kind === "image") return { name: a.name, mediaType: a.mediaType, data: a.data };
  return { name: a.name, mediaType: "text/plain", data: bytesToBase64(new TextEncoder().encode(a.text)) };
}

export function pastedText(text: string, n: number): Attachment {
  return { kind: "text", name: `pasted-${n}.txt`, text };
}

export function imageSrc(a: Extract<Attachment, { kind: "image" }>): string {
  return `data:${a.mediaType};base64,${a.data}`;
}

const isSendableImage = (type: string): type is ImageMediaType => (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);

/** A canvas blob, or null where the browser can't encode that type. */
function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Scales an image down to MAX_IMAGE_DIMENSION on its long side, and re-encodes one that is still too heavy as JPEG.
 * Where the browser can't decode it (or in tests without a canvas) the file is kept as it is.
 */
async function downscale(file: File, type: ImageMediaType): Promise<{ blob: Blob; type: ImageMediaType }> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return { blob: file, type };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { blob: file, type };
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= MAX_IMAGE_BYTES) return { blob: file, type };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return { blob: file, type };
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // A GIF loses its animation when scaled; PNG and WebP keep their type while they fit.
    const keep = type === "image/gif" ? "image/png" : type;
    const kept = await canvasBlob(canvas, keep, 0.9);
    if (kept && kept.size <= MAX_IMAGE_BYTES && isSendableImage(kept.type)) return { blob: kept, type: kept.type };
    const jpeg = await canvasBlob(canvas, "image/jpeg", 0.85);
    return jpeg ? { blob: jpeg, type: "image/jpeg" } : { blob: file, type };
  } finally {
    bitmap.close();
  }
}

/** Reads one picked, dropped or pasted file. Rejects with an Error whose message is for the user. */
export async function readAttachment(file: File): Promise<Attachment> {
  const name = file.name || (file.type.startsWith("image/") ? "image" : "file.txt");
  if (file.type.startsWith("image/")) {
    if (!isSendableImage(file.type)) throw new Error(`${name}: only PNG, JPEG, GIF and WebP images can be sent.`);
    const { blob, type } = await downscale(file, file.type);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(`${name} is over ${MB(MAX_IMAGE_BYTES)}, even scaled down.`);
    return { kind: "image", name, mediaType: type, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
  }
  if (file.size > MAX_TEXT_ATTACHMENT_BYTES) throw new Error(`${name} is over ${MB(MAX_TEXT_ATTACHMENT_BYTES)}; attach a smaller file.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error(`${name} isn't a text file or an image.`);
  }
  if (text.includes("\0")) throw new Error(`${name} isn't a text file or an image.`);
  return { kind: "text", name, text };
}
