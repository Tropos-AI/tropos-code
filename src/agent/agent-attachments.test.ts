// src/agent/agent-attachments.test.ts — a user turn that carries images and text files.
import { describe, expect, test } from "bun:test";
import { FakeModel, reply, textBlock, type Step } from "../../test/helpers/fake-model";
import { makeToolContext } from "../../test/helpers/tool-context";
import type { Attachment } from "../attachments/attachments";
import { compileRules } from "../permissions/engine";
import type { MessageParam } from "../session/store";
import { Agent } from "./agent";
import type { AgentEvent } from "./events";

function harness(steps: Step[]) {
  const model = new FakeModel(steps);
  const events: AgentEvent[] = [];
  const persisted: MessageParam[] = [];
  const agent = new Agent({
    model,
    tools: [],
    system: "sys",
    config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: false }),
    permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/work", home: "/home/u", allowedDirs: ["/work"] }),
    askPermission: async () => ({ kind: "allow" }),
    contextText: async () => "<context>\nctx\n</context>",
    persist: async (m) => void persisted.push(m),
    toolContext: makeToolContext({ root: "/work" }),
    emit: (e) => void events.push(e),
  });
  return { agent, model, events, persisted };
}

const image: Attachment = { kind: "image", name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=" };
const pasted: Attachment = { kind: "text", name: "pasted-1.txt", text: "a\nb" };

describe("Agent with attachments", () => {
  test("files and images go into the user turn before the typed text, and are saved with it", async () => {
    const h = harness([() => reply([textBlock("I see it.")])]);
    expect(await h.agent.run("what is this?", new AbortController().signal, [image, pasted])).toBe("end_turn");
    const content = h.model.requests[0]!.messages[0]!.content as Array<{ type: string; text?: string; source?: unknown }>;
    expect(content.map((b) => b.type)).toEqual(["text", "text", "image", "text"]);
    expect(content[1]!.text).toBe('<attachment name="pasted-1.txt">\na\nb\n</attachment>');
    expect(content[2]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
    expect(content[3]!.text).toBe("what is this?");
    expect(h.persisted[0]).toEqual(h.agent.messages[0]!);
  });

  test("images alone (no text) send no empty text block", async () => {
    const h = harness([() => reply([textBlock("ok")])]);
    await h.agent.run("", new AbortController().signal, [image]);
    const content = h.model.requests[0]!.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(content.map((b) => b.type)).toEqual(["text", "image"]);
    expect(content.every((b) => b.type !== "text" || b.text)).toBe(true);
  });

  test("what the model says about the request (no vision, say) reaches the user as a notice", async () => {
    const h = harness([
      (_req, handlers) => {
        handlers.onNotice?.("This model can't see images.");
        return reply([textBlock("ok")]);
      },
    ]);
    await h.agent.run("look", new AbortController().signal, [image]);
    expect(h.events).toContainEqual({ type: "notice", level: "warn", text: "This model can't see images." });
  });
});
