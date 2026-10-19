// src/ui/transcript-attachments.test.ts — the user's images and files in the transcript, live and from a saved session.
import { describe, expect, test } from "bun:test";
import type { Attachment } from "../attachments/attachments";
import type { MessageParam } from "../session/store";
import { addUser, emptyTranscript, historyToTranscript } from "./transcript";

const image: Attachment = { kind: "image", name: "shot.png", mediaType: "image/png", data: "QUJD" };

describe("user attachments in the transcript", () => {
  test("addUser keeps the attachments on the row; none means no field", () => {
    expect(addUser(emptyTranscript, "look", [image]).done[0]).toMatchObject({ kind: "user", text: "look", attachments: [image] });
    expect(addUser(emptyTranscript, "plain").done[0]).not.toHaveProperty("attachments");
  });

  test("a saved turn shows its typed text with its files and images, not the file's text as a message", () => {
    const history: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "<context>x</context>" },
          { type: "text", text: '<attachment name="pasted-1.txt">\nline 1\nline 2\n</attachment>' },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          { type: "text", text: "what is this?" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "A chart." }] },
    ];
    const t = historyToTranscript(history);
    expect(t.done.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(t.done[0]).toMatchObject({
      kind: "user",
      text: "what is this?",
      attachments: [
        { kind: "text", name: "pasted-1.txt", text: "line 1\nline 2" },
        { kind: "image", name: "image 1", mediaType: "image/png", data: "QUJD" },
      ],
    });
  });

  test("a turn of images alone is still a user row", () => {
    const t = historyToTranscript([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }] }]);
    expect(t.done).toEqual([expect.objectContaining({ kind: "user", text: "", attachments: [{ kind: "image", name: "image 1", mediaType: "image/jpeg", data: "QUJD" }] })]);
  });
});
