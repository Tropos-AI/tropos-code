// src/web/host-attachments.test.ts — a prompt RPC that carries images and text files.
import { describe, expect, test } from "bun:test";
import { reply, textBlock } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { MAX_IMAGES } from "../attachments/attachments";
import { WebHost } from "./host";
import { parseClientMessage } from "./server";
import type { ServerMessage } from "./protocol";

const PNG = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])).toString("base64");
const image = (name = "shot.png") => ({ name, mediaType: "image/png", data: PNG });
const textFile = (text: string, name = "pasted-1.txt") => ({ name, mediaType: "text/plain", data: Buffer.from(text).toString("base64") });

function setup(steps = [() => reply([textBlock("ok")])]) {
  const runtime = fakeRuntime(steps);
  const host = new WebHost(runtime);
  const seen: ServerMessage[] = [];
  host.attach((m) => seen.push(m));
  return { runtime, host, seen };
}

type Block = { type: string; text?: string; source?: { data?: string } };
const firstTurn = (runtime: ReturnType<typeof setup>["runtime"]) => runtime.model.requests[0]!.messages[0]!.content as Block[];

describe("prompt with attachments", () => {
  test("images and files reach the model in the user turn", async () => {
    const { host, runtime } = setup();
    expect(await host.call("prompt", { text: "look", attachments: [image(), textFile("a\nb")] })).toBe("end_turn");
    const blocks = firstTurn(runtime);
    expect(blocks.map((b) => b.type)).toEqual(["text", "text", "image", "text"]);
    expect(blocks[1]!.text).toContain('<attachment name="pasted-1.txt">');
    expect(blocks[2]!.source!.data).toBe(PNG);
    expect(blocks[3]!.text).toBe("look");
  });

  test("attachments alone are enough to send; nothing at all is not", async () => {
    const { host, runtime } = setup();
    expect(await host.call("prompt", { text: "", attachments: [image()] })).toBe("end_turn");
    expect(firstTurn(runtime).map((b) => b.type)).toEqual(["text", "image"]);
    await expect(host.call("prompt", { text: " ", attachments: [] })).rejects.toThrow("Nothing to send.");
  });

  test("a bad type, too big or too many is refused with a reason, before any turn starts", async () => {
    const { host, runtime } = setup();
    await expect(host.call("prompt", { text: "x", attachments: [{ name: "x.png", mediaType: "image/png", data: Buffer.from("<svg/>").toString("base64") }] })).rejects.toThrow(
      "x.png isn't a PNG, JPEG, GIF or WebP image.",
    );
    await expect(host.call("prompt", { text: "x", attachments: Array.from({ length: MAX_IMAGES + 1 }, () => image()) })).rejects.toThrow(`Up to ${MAX_IMAGES} images`);
    await expect(host.call("prompt", { text: "x", attachments: [textFile("a".repeat(1024 * 1024 + 1), "big.txt")] })).rejects.toThrow("big.txt is too big");
    expect(runtime.model.requests).toHaveLength(0);
    expect(host.state().busy).toBe(false);
  });

  test("a key pasted into a text file is sealed like one typed in the message", async () => {
    const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
    const { host, runtime, seen } = setup();
    const otherTab: ServerMessage[] = [];
    host.attach((m) => otherTab.push(m));
    await host.call("prompt", { text: "deploy", attachments: [textFile(`TOKEN=${TOKEN}`)] }, (m) => seen.push(m));
    expect(JSON.stringify(runtime.model.requests)).not.toContain(TOKEN);
    expect(JSON.stringify(otherTab)).not.toContain(TOKEN);
  });

  test("other tabs see the message with its attachments", async () => {
    const { host } = setup();
    const otherTab: ServerMessage[] = [];
    host.attach((m) => otherTab.push(m));
    await host.call("prompt", { text: "look", attachments: [image()] }, () => {});
    const user = otherTab.find((m) => m.t === "user");
    expect(user).toEqual({ t: "user", text: "look", attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", data: PNG }] });
  });

  test("an @specialist message with images goes to the main agent, which can see them", async () => {
    const runtime = fakeRuntime([() => reply([textBlock("ok")])], { directCall: () => ({ call: { name: "Agent", input: { description: "d", prompt: "look", subagent_type: "reviewer" } }, reply: () => "direct" }) });
    const host = new WebHost(runtime);
    await host.call("prompt", { text: "@reviewer look", attachments: [image()] });
    expect(runtime.model.requests).toHaveLength(1);
  });
});

describe("message size", () => {
  test("a logged-in tab may send a prompt with large images; a socket that hasn't logged in may not", () => {
    const big = JSON.stringify({ t: "rpc", id: 1, method: "prompt", params: { text: "x", attachments: [{ name: "a.png", mediaType: "image/png", data: "A".repeat(6 * 1024 * 1024) }] } });
    expect(parseClientMessage(big, { authed: true })).toMatchObject({ t: "rpc", method: "prompt" });
    expect(parseClientMessage(big)).toBeNull();
  });
});
