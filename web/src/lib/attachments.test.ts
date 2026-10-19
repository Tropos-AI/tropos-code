import { describe, expect, test } from "bun:test";

import { MAX_IMAGE_BYTES, MAX_TEXT_ATTACHMENT_BYTES } from "@core/attachments/attachments";

import { pastedText, readAttachment, toPromptAttachment } from "@/lib/attachments";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const b64 = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64");

describe("readAttachment", () => {
  test("a PNG becomes an image attachment with its bytes in base64", async () => {
    const a = await readAttachment(new File([PNG], "shot.png", { type: "image/png" }));
    expect(a).toEqual({ kind: "image", name: "shot.png", mediaType: "image/png", data: b64(PNG) });
  });

  test("a text or code file becomes a text attachment", async () => {
    const a = await readAttachment(new File(["const x = 1;\n"], "app.ts", { type: "" }));
    expect(a).toEqual({ kind: "text", name: "app.ts", text: "const x = 1;\n" });
  });

  test("an image type we can't send, an oversized file and a binary file are refused with a reason", async () => {
    await expect(readAttachment(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }))).rejects.toThrow("logo.svg: only PNG, JPEG, GIF and WebP images can be sent.");
    await expect(readAttachment(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "huge.jpg", { type: "image/jpeg" }))).rejects.toThrow("huge.jpg is over 5 MB");
    await expect(readAttachment(new File(["a".repeat(MAX_TEXT_ATTACHMENT_BYTES + 1)], "big.log", { type: "text/plain" }))).rejects.toThrow("big.log is over 1 MB");
    await expect(readAttachment(new File([new Uint8Array([0, 1, 2, 3])], "a.bin", { type: "application/octet-stream" }))).rejects.toThrow("a.bin isn't a text file or an image.");
  });
});

describe("pastedText and toPromptAttachment", () => {
  test("a big paste is pasted-N.txt", () => {
    expect(pastedText("x\ny", 2)).toEqual({ kind: "text", name: "pasted-2.txt", text: "x\ny" });
  });

  test("on the wire, text goes as UTF-8 base64 and images as they are", () => {
    expect(toPromptAttachment({ kind: "text", name: "p.txt", text: "héllo" })).toEqual({ name: "p.txt", mediaType: "text/plain", data: b64("héllo") });
    expect(toPromptAttachment({ kind: "image", name: "a.png", mediaType: "image/png", data: "QUJD" })).toEqual({ name: "a.png", mediaType: "image/png", data: "QUJD" });
  });
});
