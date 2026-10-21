// src/messages/send-tool.test.ts — the SendIMessage tool against a testkit chat.db behind a fake helper client; nothing is ever really sent
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRules, decide, PLAN_MODE_REASON, type PermissionContext } from "../permissions/engine";
import { toolKind, type AnyTool, type ToolContext, type ToolOutput } from "../tools/types";
import { SendLedger } from "./burst";
import type { HelperReply } from "./helper/client";
import { createSendTool, SEND_TOOL } from "./send-tool";
import { MessagesSource } from "./source";
import { buildAddressBook, buildChatDb, type ChatDbFixture, type FixtureMessage } from "./testkit";

const MARIA = "+306912345678";
const MARIA_CHAT = `iMessage;-;${MARIA}`;
const T0 = Date.UTC(2026, 9, 21, 12);

interface Call {
  action: string;
  args: string[];
  body?: string;
  timeoutMs?: number;
}
type SendHandler = (call: Call) => HelperReply | Promise<HelperReply>;

let root: string;
let fixture: ChatDbFixture;
let calls: Call[];
let onSend: SendHandler;
let clock: number;
let sleeps: number[];
let source: MessagesSource;
let client: { request: (action: string, args: string[], opts?: { body?: string; timeoutMs?: number }) => Promise<HelperReply> };
let onSleep: (() => void) | undefined;
let ledger: SendLedger;

function rebuild(): void {
  buildChatDb(join(root, "fixtures", "chat.db"), fixture);
}

/** What Messages does on a successful send: a row from you in the person's chat, stamped now. */
function record(extra: Partial<FixtureMessage> = {}, chat = MARIA_CHAT): void {
  const last = calls.at(-1)!;
  fixture.messages.push({ guid: `sent-${fixture.messages.length}`, chat, fromMe: true, text: last.body, at: clock, ...extra });
  rebuild();
}

const ok: HelperReply = { ok: true, lines: [] };

function makeSource(): MessagesSource {
  client = {
    async request(action: string, args: string[], opts: { body?: string; timeoutMs?: number } = {}): Promise<HelperReply> {
      if (action === "snapshot") {
        copyFileSync(join(root, "fixtures", "chat.db"), join(args[0]!, "chat.db"));
        return ok;
      }
      if (action === "contacts") {
        const dir = join(args[0]!, "contacts-0");
        mkdirSync(dir);
        copyFileSync(join(root, "fixtures", "book.abcddb"), join(dir, "AddressBook-v22.abcddb"));
        return { ok: true, lines: ["contacts-0/AddressBook-v22.abcddb"] };
      }
      const call: Call = { action, args, ...(opts.body !== undefined ? { body: opts.body } : {}), ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) };
      calls.push(call);
      return onSend(call);
    },
  };
  return new MessagesSource({ client: client as never, runDir: join(root, "run"), userHome: join(root, "home"), now: () => clock });
}

function makeTool(): AnyTool {
  return createSendTool({
    source,
    client: client as never,
    ledger,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      onSleep?.();
    },
  });
}

const ctx = { signal: new AbortController().signal } as unknown as ToolContext;
const text = (o: ToolOutput) => (typeof o.content === "string" ? o.content : JSON.stringify(o.content));
const sends = () => calls.filter((c) => c.action.startsWith("send-"));

function perms(over: Partial<PermissionContext> & { allow?: string[] } = {}): PermissionContext {
  const { allow = [], ...rest } = over;
  const { rules } = compileRules({ allow, ask: [], deny: [] });
  return { mode: "default", cwd: "/work", home: "/home/u", allowedDirs: ["/work"], ...rest, rules };
}

function decideFor(tool: AnyTool, input: Record<string, unknown>, c: PermissionContext) {
  return decide({ toolName: tool.name, kind: toolKind(tool), ...tool.subject(input as never, "/work") }, c);
}

/** Parses like the agent does, then runs; the same input object goes to subject and run. */
async function send(tool: AnyTool, raw: Record<string, unknown>): Promise<ToolOutput> {
  const parsed = tool.schema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.message);
  tool.subject(parsed.data, "/work");
  return tool.run(parsed.data, ctx);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "msg-send-"));
  mkdirSync(join(root, "run"));
  mkdirSync(join(root, "fixtures"));
  mkdirSync(join(root, "home"));
  buildAddressBook(join(root, "fixtures", "book.abcddb"), [{ first: "Maria", last: "Papadopoulou", phones: ["+30 691 234 5678"] }]);
  fixture = {
    chats: [
      { guid: MARIA_CHAT, handles: [MARIA] },
      { guid: "iMessage;+;chat1", displayName: "Family", handles: [MARIA, "+306900000001"] },
    ],
    messages: [{ guid: "m1", chat: MARIA_CHAT, handle: MARIA, text: "hi", at: T0 - 60_000 }],
  };
  rebuild();
  calls = [];
  sleeps = [];
  onSleep = undefined;
  clock = T0;
  ledger = new SendLedger();
  onSend = () => {
    record({ delivered: true });
    return ok;
  };
  source = makeSource();
});
afterEach(() => {
  source.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("SendIMessage — who it is for", () => {
  test("is an exec tool named SendIMessage", () => {
    const tool = makeTool();
    expect(tool.name).toBe(SEND_TOOL);
    expect(SEND_TOOL).toBe("SendIMessage");
    expect(toolKind(tool)).toBe("exec");
  });

  test("a number written with spaces and dashes targets its normalized form", () => {
    expect(makeTool().subject({ to: "+30 691-234 5678", text: "x" } as never, "/work").target).toBe(MARIA);
  });

  test("a number without its country code targets the handle Messages knows, and hits that allow rule", async () => {
    await source.with(() => 0);
    const tool = makeTool();
    expect(tool.subject({ to: "6912345678", text: "x" } as never, "/work").target).toBe(MARIA);
    expect(decideFor(tool, { to: "6912345678", text: "x" }, perms({ allow: [`SendIMessage(${MARIA})`] }))).toEqual({ behavior: "allow" });
    expect(decideFor(tool, { to: "00306912345678", text: "x" }, perms({ allow: [`SendIMessage(${MARIA})`] }))).toEqual({ behavior: "allow" });
  });

  test("a different number is still asked", () => {
    const d = decideFor(makeTool(), { to: "+306900000002", text: "x" }, perms({ allow: [`SendIMessage(${MARIA})`] }));
    expect(d.behavior).toBe("ask");
  });

  test("the autonomous level without a rule still asks", () => {
    const d = decideFor(makeTool(), { to: MARIA, text: "x" }, perms({ autonomy: { level: "autonomous", testCommands: [] } }));
    expect(d.behavior).toBe("ask");
  });

  test("plan mode denies", () => {
    expect(decideFor(makeTool(), { to: MARIA, text: "x" }, perms({ mode: "plan" }))).toEqual({ behavior: "deny", reason: PLAN_MODE_REASON });
  });

  test("\"don't ask again\" offers exactly this recipient", () => {
    expect(decideFor(makeTool(), { to: "+30 691 234 5678", text: "x" }, perms())).toEqual({ behavior: "ask", suggestion: `SendIMessage(${MARIA})` });
  });

  test("a group chat targets chat:<guid>; a one-to-one chat targets its handle", () => {
    const tool = makeTool();
    expect(tool.subject({ chat: "iMessage;+;chat1", text: "x" } as never, "/work").target).toBe("chat:iMessage;+;chat1");
    expect(tool.subject({ chat: MARIA_CHAT, text: "x" } as never, "/work").target).toBe(MARIA);
  });

  test("the input needs exactly one of to and chat, and 1 to 4000 characters of text", () => {
    const { schema } = makeTool();
    expect(schema.safeParse({ text: "x" }).success).toBe(false);
    expect(schema.safeParse({ to: MARIA, chat: MARIA_CHAT, text: "x" }).success).toBe(false);
    expect(schema.safeParse({ to: "  ", text: "x" }).success).toBe(false);
    expect(schema.safeParse({ to: MARIA, text: "" }).success).toBe(false);
    expect(schema.safeParse({ to: MARIA, text: "x".repeat(4001) }).success).toBe(false);
    expect(schema.safeParse({ to: MARIA, text: "x".repeat(4000) }).success).toBe(true);
    // Characters, not UTF-16 units: 4000 emoji are allowed.
    expect(schema.safeParse({ to: MARIA, text: "🙂".repeat(4000) }).success).toBe(true);
  });

  test("the summary and the prompt name the contact and the handle", async () => {
    await source.with(() => 0);
    const tool = makeTool();
    const input = { to: "6912345678", text: "Καλημέρα\nsee you" };
    expect(tool.summarize(input as never)).toBe(`Text Maria Papadopoulou (${MARIA})`);
    expect(tool.preview!(input as never)).toEqual({ header: `To Maria Papadopoulou (${MARIA})`, text: "Καλημέρα\nsee you" });
    expect(tool.summarize({ to: "+306900000002", text: "x" } as never)).toBe("Text +306900000002");
  });
});

describe("SendIMessage — sending", () => {
  test("the text reaches the helper byte-for-byte, as the body, with the send timeout", async () => {
    const body = 'She said "hi" \\ back\\slash\nline two\r\n"; do shell script "rm -rf ~" --\n😀👍🏽 Καλημέρα, τι κάνεις;';
    const out = await send(makeTool(), { to: MARIA, text: body });
    expect(sends()).toEqual([{ action: "send-handle", args: [MARIA, "iMessage"], body, timeoutMs: 180_000 }]);
    expect(Buffer.from(sends()[0]!.body!, "utf8").equals(Buffer.from(body, "utf8"))).toBe(true);
    expect(out.isError).toBeFalsy();
  });

  test("sends to the same handle the permission target named", async () => {
    await source.with(() => 0);
    const tool = makeTool();
    const parsed = tool.schema.parse({ to: "6912345678", text: "hello" });
    const target = tool.subject(parsed, "/work").target;
    await tool.run(parsed, ctx);
    expect(sends()[0]!.args[0]).toBe(target!);
  });

  test("the approved handle is sent to even when a snapshot taken meanwhile would spell it differently", async () => {
    // No snapshot yet: the target is the number as written. Sending takes one, which knows +306912345678.
    const tool = makeTool();
    const parsed = tool.schema.parse({ to: "6912345678", text: "hello" });
    expect(tool.subject(parsed, "/work").target).toBe("6912345678");
    await tool.run(parsed, ctx);
    expect(source.canonicalHandle("6912345678")).toBe(MARIA);
    expect(sends()[0]!.args[0]).toBe("6912345678");
  });

  test("a chat id sends to that chat", async () => {
    onSend = () => {
      record({ delivered: true }, "iMessage;+;chat1");
      return ok;
    };
    const out = await send(makeTool(), { chat: "iMessage;+;chat1", text: "dinner at 8" });
    expect(sends()).toEqual([{ action: "send-chat", args: ["iMessage;+;chat1"], body: "dinner at 8", timeoutMs: 180_000 }]);
    expect(out.summary).toBe("delivered");
  });

  test("a person whose chat is SMS gets an SMS", async () => {
    fixture.chats[0] = { guid: `SMS;-;${MARIA}`, handles: [MARIA], service: "SMS" };
    fixture.messages = [{ guid: "m1", chat: `SMS;-;${MARIA}`, handle: MARIA, text: "hi", at: T0 - 60_000 }];
    rebuild();
    onSend = () => {
      record({ delivered: true }, `SMS;-;${MARIA}`);
      return ok;
    };
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(sends().map((c) => c.args)).toEqual([[MARIA, "SMS"]]);
    expect(out.summary).toBe("delivered");
  });

  test("an unreachable iMessage handle is tried once more as SMS", async () => {
    onSend = (call) => {
      if (call.args[1] === "iMessage") return { ok: false, code: "-1728", message: "Can't get participant." };
      record({ delivered: true });
      return ok;
    };
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(sends().map((c) => c.args)).toEqual([
      [MARIA, "iMessage"],
      [MARIA, "SMS"],
    ]);
    expect(text(out)).toBe("Sent to Maria Papadopoulou: delivered.");
  });

  test("\"not registered\" also falls back to SMS, but only once", async () => {
    onSend = () => ({ ok: false, code: "-1700", message: "The handle is not registered with iMessage." });
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(sends()).toHaveLength(2);
    expect(out.isError).toBe(true);
  });
});

describe("SendIMessage — what chat.db shows afterwards", () => {
  test("delivered", async () => {
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(text(out)).toBe("Sent to Maria Papadopoulou: delivered.");
    expect(out.summary).toBe("delivered");
    expect(out.isError).toBeFalsy();
  });

  test("recorded but not delivered yet, after checking every second for 10 s", async () => {
    onSend = () => {
      record({ delivered: false });
      return ok;
    };
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(text(out)).toBe("Sent to Maria Papadopoulou; Messages shows it as not delivered yet.");
    expect(out.summary).toBe("not delivered yet");
    expect(out.isError).toBeFalsy();
    expect(sleeps.every((ms) => ms === 1000)).toBe(true);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  test("delivered on a later check", async () => {
    onSend = () => {
      record({ delivered: false });
      return ok;
    };
    // After the third check, Messages marks it delivered.
    onSleep = () => {
      if (sleeps.length !== 3) return;
      fixture.messages.at(-1)!.delivered = true;
      rebuild();
    };
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(out.summary).toBe("delivered");
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  test("not recorded: the helper said ok but no row appeared", async () => {
    onSend = () => ok;
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(text(out)).toBe("Messages didn't record the text, so it probably didn't go.");
    expect(out.summary).toBe("not recorded");
    expect(out.isError).toBe(true);
  });

  test("an identical text sent earlier doesn't count as this one", async () => {
    fixture.messages.push({ guid: "old", chat: MARIA_CHAT, fromMe: true, text: "hello", at: T0 - 5_000 });
    rebuild();
    onSend = () => ok;
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(out.summary).toBe("not recorded");
  });

  test("a helper error (Messages not signed in) gives not recorded with the error, and no SMS retry", async () => {
    onSend = () => ({ ok: false, code: "-1708", message: "Messages got an error: No account is signed in." });
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(sends()).toHaveLength(1);
    expect(text(out)).toStartWith("Messages didn't record the text, so it probably didn't go.");
    expect(text(out)).toContain("No account is signed in.");
    expect(out.summary).toBe("not recorded");
    expect(out.isError).toBe(true);
  });

  test("-1743 gives the Automation text", async () => {
    onSend = () => ({ ok: false, code: "-1743", message: "Not authorized to send Apple events to Messages." });
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(sends()).toHaveLength(1);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Privacy & Security, then Automation");
  });

  test("a timeout is never retried; chat.db decides, and the reply says it timed out", async () => {
    onSend = () => {
      record({ delivered: true });
      return { ok: false, code: "timeout", message: "Tropos Messages Helper didn't answer within 180 s (it took the request but didn't finish)." };
    };
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(sends()).toHaveLength(1);
    expect(out.summary).toBe("delivered");
    expect(text(out)).toContain("Sent to Maria Papadopoulou: delivered.");
    expect(text(out)).toContain("didn't answer within 180 s");
  });

  test("a timeout with nothing in chat.db is not recorded, still without a retry", async () => {
    onSend = () => ({ ok: false, code: "timeout", message: "Tropos Messages Helper didn't answer within 180 s (it never picked the request up)." });
    const out = await send(makeTool(), { to: MARIA, text: "hello" });
    expect(sends()).toHaveLength(1);
    expect(out.summary).toBe("not recorded");
    expect(text(out)).toContain("didn't answer within 180 s");
  });
});

describe("SendIMessage — burst guard", () => {
  test("past the limit the call asks again, whatever the allow rule says", () => {
    for (let i = 0; i < 5; i++) ledger.record(MARIA, T0 - i * 1000);
    const tool = makeTool();
    const subject = tool.subject({ to: MARIA, text: "x" } as never, "/work");
    expect(subject.askReason).toBeDefined();
    expect(decideFor(tool, { to: MARIA, text: "x" }, perms({ allow: [`SendIMessage(${MARIA})`] })).behavior).toBe("ask");
    expect(tool.subject({ to: "+306900000002", text: "x" } as never, "/work").askReason).toBeUndefined();
  });

  test("at the hard limit nothing is sent", async () => {
    for (let i = 0; i < 10; i++) ledger.record(MARIA, T0 - i * 1000);
    const out = await send(makeTool(), { to: MARIA, text: "x" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("Not sent");
    expect(sends()).toHaveLength(0);
  });

  test("a failed send still counts", async () => {
    onSend = () => ({ ok: false, code: "-1708", message: "No account is signed in." });
    const tool = makeTool();
    for (let i = 0; i < 5; i++) await send(tool, { to: MARIA, text: `try ${i}` });
    expect(tool.subject({ to: MARIA, text: "x" } as never, "/work").askReason).toBeDefined();
  });
});
