// src/gateway/pool-attachments.test.ts — a chat's prompt with images, through the session pool.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { reply, textBlock } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { WebHost } from "../web/host";
import { UserFacingError } from "./errors";
import { SessionPool } from "./pool";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-pool-attachments");
});
afterEach(() => removeDir(dir));

function setup() {
  const runtime = fakeRuntime([() => reply([textBlock("a cat")])]);
  const pool = new SessionPool({
    statePath: join(dir, "sessions.json"),
    idleMs: 60_000,
    sweepEveryMs: 0,
    create: async () => ({ host: new WebHost(runtime), sessionId: () => "s1", close: async () => {} }),
  });
  return { pool, runtime };
}

const PNG = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])).toString("base64");

test("a photo from a chat reaches the model as an image block, with its caption", async () => {
  const { pool, runtime } = setup();
  const chat = await pool.open("telegram:1");
  expect(await chat.prompt("what is this?", [{ name: "photo.png", mediaType: "image/png", data: PNG }])).toBe("end_turn");
  const blocks = runtime.model.requests[0]!.messages[0]!.content as Array<{ type: string; text?: string }>;
  expect(blocks.map((b) => b.type)).toEqual(["text", "image", "text"]);
  expect(blocks.at(-1)!.text).toBe("what is this?");
});

test("a refused attachment rejects with a reason the chat can show", async () => {
  const { pool } = setup();
  const chat = await pool.open("telegram:1");
  const err = await chat.prompt("", [{ name: "x.png", mediaType: "image/png", data: Buffer.from("nope").toString("base64") }]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UserFacingError);
  expect((err as Error).message).toBe("x.png isn't a PNG, JPEG, GIF or WebP image.");
});
