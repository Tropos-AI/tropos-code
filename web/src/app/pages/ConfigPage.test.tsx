import { afterEach, describe, expect, test } from "bun:test";

import type { ConfigView } from "@core/web/admin/api";

import { mountAdmin, type AdminHandlers } from "@/components/admin/admin-test-kit";
import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, configure } = await import("@testing-library/react");
// The full suite runs this beside heavy tests: the default 1 s waitFor is too tight for a form this size under load.
configure({ asyncUtilTimeout: 5000 });
const { ConfigPanel } = await import("@/app/pages/ConfigPage");
const { describeField, errorLocation, getAtPath } = await import("@/components/admin/schema-utils");

const SETTINGS_SCHEMA = {
  type: "object",
  properties: {
    model: { type: "string", description: "The model new sessions start with." },
    maxTurns: { type: "integer", minimum: 1, maximum: 100, description: "Turn limit." },
    autoCompact: { type: "boolean", default: true, description: "Compact long chats." },
    effort: { anyOf: [{ type: "string", enum: ["low", "medium", "high"] }, { type: "null" }], description: "Thinking effort." },
    version: { type: "string", readOnly: true, description: "Written by the installer." },
    permissions: {
      type: "object",
      description: "What the agent may do.",
      properties: { allow: { type: "array", items: { type: "string" }, description: "Allowed rules." } },
    },
    env: { type: "object", additionalProperties: { type: "string" }, description: "Environment for commands." },
    hooks: { type: "object", additionalProperties: {}, description: "Hook definitions." },
  },
};

function view(over: Partial<ConfigView["value"]> = {}, file: ConfigView["file"] = "settings", schema: Record<string, unknown> = SETTINGS_SCHEMA): ConfigView {
  return {
    file,
    path: `/home/me/.tropos/${file}.json`,
    schema,
    value: { model: "claude-opus", maxTurns: 20, version: "0.5.2", permissions: { allow: ["Bash(git status)"] }, env: { PATH_EXTRA: "/opt/bin", TOKEN: "••••" }, hooks: { PreToolUse: [] }, ...over },
  };
}

function setHandler(current: ConfigView, calls: Array<{ path: string; value: unknown }> = []): AdminHandlers {
  return {
    "config.get": () => current,
    "config.set": (p) => {
      const { path, value } = p as { path: string; value: unknown };
      calls.push({ path, value });
      return { ...current, value: { ...current.value, [path]: value } };
    },
  };
}

afterEach(() => cleanup());

describe("schema-utils", () => {
  test("classifies the common shapes", () => {
    const root = SETTINGS_SCHEMA as Record<string, unknown>;
    const props = (root["properties"] as Record<string, Record<string, unknown>>);
    expect(describeField(props["model"]!, root).kind).toBe("string");
    expect(describeField(props["maxTurns"]!, root)).toMatchObject({ kind: "integer", min: 1, max: 100 });
    expect(describeField(props["effort"]!, root)).toMatchObject({ kind: "enum", options: ["low", "medium", "high"], description: "Thinking effort." });
    expect(describeField(props["permissions"]!, root).kind).toBe("object");
    expect(describeField(props["env"]!, root)).toMatchObject({ kind: "record", valueKind: "string" });
    expect(describeField(props["hooks"]!, root).kind).toBe("json");
    expect(describeField(props["version"]!, root).readOnly).toBe(true);
    expect(describeField({ $ref: "#/$defs/x" }, { $defs: { x: { type: "boolean" } } }).kind).toBe("boolean");
    expect(describeField({ anyOf: [{ type: "string" }, { type: "number" }] }, {}).kind).toBe("json");
  });

  test("finds a line in parse errors", () => {
    expect(errorLocation("Unexpected token } in JSON at position 8", "{\n  \"a\": }\n")).toEqual({ line: 2, column: 7 });
    expect(errorLocation("expected , at line 4 column 2", "")).toEqual({ line: 4, column: 2 });
    expect(errorLocation("model must be a string", "")).toBeNull();
    expect(getAtPath({ a: { b: 1 } }, "a.b")).toBe(1);
  });
});

describe("ConfigPanel form", () => {
  test("renders a control for each kind with its description, and no input for read-only fields", async () => {
    stubMatchMedia();
    await mountAdmin(ConfigPanel, setHandler(view()));
    expect(await screen.findByText("The model new sessions start with.")).toBeTruthy();
    expect((screen.getByLabelText("model") as HTMLInputElement).value).toBe("claude-opus");
    const turns = screen.getByLabelText("maxTurns") as HTMLInputElement;
    expect([turns.type, turns.min, turns.max]).toEqual(["number", "1", "100"]);
    expect(screen.getByRole("switch", { name: "autoCompact" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("effort").tagName).toBe("SELECT");
    expect(screen.getByRole("list", { name: "allow entries" })).toBeTruthy();
    expect(screen.getByLabelText("env name 1")).toBeTruthy();
    expect(screen.getByLabelText("hooks").tagName).toBe("TEXTAREA");
    expect(screen.getByText("read-only")).toBeTruthy();
    expect(screen.getByText("0.5.2").tagName).toBe("P");
    expect(screen.getByText("/home/me/.tropos/settings.json")).toBeTruthy();
    expect(screen.getByText("Not saved in this session")).toBeTruthy();
  });

  test("saves a text field on blur, once, and reports Saved", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    await mountAdmin(ConfigPanel, setHandler(view(), calls));
    const input = (await screen.findByLabelText("model")) as HTMLInputElement;
    fireEvent.blur(input);
    expect(calls).toEqual([]);
    fireEvent.change(input, { target: { value: "claude-sonnet" } });
    fireEvent.blur(input);
    await screen.findByText("Saved");
    expect(calls).toEqual([{ path: "model", value: "claude-sonnet" }]);
    expect(screen.getByText(/Last saved/)).toBeTruthy();
  });

  test("Enter saves a number as a number", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    await mountAdmin(ConfigPanel, setHandler(view(), calls));
    const input = (await screen.findByLabelText("maxTurns")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toEqual([{ path: "maxTurns", value: 50 }]));
  });

  test("a value outside min/max is refused in the browser", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    await mountAdmin(ConfigPanel, setHandler(view(), calls));
    const input = (await screen.findByLabelText("maxTurns")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "500" } });
    fireEvent.blur(input);
    await screen.findByText("Must be at most 100.");
    expect(calls).toEqual([]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe("500");
  });

  test("a server refusal shows next to the field and keeps the typed value", async () => {
    stubMatchMedia();
    const handlers = setHandler(view());
    handlers["config.set"] = () => {
      throw new Error("model: unknown model 'nope'");
    };
    await mountAdmin(ConfigPanel, handlers);
    const input = (await screen.findByLabelText("model")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.blur(input);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("unknown model 'nope'");
    expect(input.value).toBe("nope");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
  });

  test("switches, selects and chip lists save immediately", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    await mountAdmin(ConfigPanel, setHandler(view(), calls));
    fireEvent.click(await screen.findByRole("switch", { name: "autoCompact" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ path: "autoCompact", value: false }));
    fireEvent.change(screen.getByLabelText("effort"), { target: { value: "high" } });
    await waitFor(() => expect(calls.at(-1)).toEqual({ path: "effort", value: "high" }));
    const add = screen.getByLabelText("allow");
    fireEvent.change(add, { target: { value: "Read(src/**)" } });
    fireEvent.keyDown(add, { key: "Enter" });
    await waitFor(() => expect(calls.at(-1)).toEqual({ path: "permissions.allow", value: ["Bash(git status)", "Read(src/**)"] }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Bash(git status)" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ path: "permissions.allow", value: [] }));
  });

  test("Reset sends null for the field", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    await mountAdmin(ConfigPanel, setHandler(view(), calls));
    fireEvent.click(await screen.findByRole("button", { name: "Reset model to default" }));
    await waitFor(() => expect(calls).toEqual([{ path: "model", value: null }]));
  });

  test("key/value rows send only what changed and never the masked value", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    await mountAdmin(ConfigPanel, setHandler(view(), calls));
    const save = await screen.findByRole("button", { name: "Save env" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("env value 2") as HTMLInputElement).placeholder).toContain("set");
    fireEvent.change(screen.getByLabelText("env value 1"), { target: { value: "/usr/bin" } });
    fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
    fireEvent.change(screen.getByLabelText("env name 3"), { target: { value: "NEW_VAR" } });
    fireEvent.change(screen.getByLabelText("env value 3"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save env" }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls).toEqual([
      { path: "env.PATH_EXTRA", value: "/usr/bin" },
      { path: "env.NEW_VAR", value: "1" },
    ]);
  });

  test("a row without a name is refused and the rows stay", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    await mountAdmin(ConfigPanel, setHandler(view(), calls));
    fireEvent.click(await screen.findByRole("button", { name: "Add entry" }));
    fireEvent.change(screen.getByLabelText("env value 3"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save env" }));
    await screen.findByText("Every row needs a name.");
    expect(calls).toEqual([]);
    expect((screen.getByLabelText("env value 3") as HTMLInputElement).value).toBe("x");
  });

  test("the JSON fallback validates before sending", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    await mountAdmin(ConfigPanel, setHandler(view(), calls));
    const area = (await screen.findByLabelText("hooks")) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "{ nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save hooks" }));
    await screen.findByText(/Not valid JSON/);
    expect(calls).toEqual([]);
    fireEvent.change(area, { target: { value: '{"PostToolUse":[]}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save hooks" }));
    await waitFor(() => expect(calls).toEqual([{ path: "hooks", value: { PostToolUse: [] } }]));
  });

  test("secrets are write-only: empty leaves the value alone, typing replaces", async () => {
    stubMatchMedia();
    const calls: Array<{ path: string; value: unknown }> = [];
    const schema = { type: "object", properties: { telegram: { type: "object", properties: { botToken: { type: "string", description: "Bot token." } } } } };
    const current = { file: "gateway" as const, path: "/g.json", schema, value: { telegram: { botToken: "••••" } } };
    await mountAdmin(ConfigPanel, { ...setHandler(current, calls), "config.get": () => current });
    fireEvent.click(await screen.findByRole("tab", { name: "Gateway" }));
    await screen.findByLabelText("botToken");
    const input = screen.getByLabelText("botToken") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(input.placeholder).toContain("••••");
    fireEvent.blur(input);
    expect(calls).toEqual([]);
    fireEvent.change(input, { target: { value: "123:abc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toEqual([{ path: "telegram.botToken", value: "123:abc" }]));
  });

  test("an unavailable server shows a calm error with Retry", async () => {
    stubMatchMedia();
    let fail = true;
    await mountAdmin(ConfigPanel, { "config.get": () => { if (fail) throw new Error("Not available in the demo."); return view(); } });
    await screen.findByText("Not available in the demo.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("model");
  });
});

describe("ConfigPanel raw mode", () => {
  const RAW = '{\n  "model": "claude-opus"\n}\n';

  async function openRaw(extra: AdminHandlers = {}) {
    stubMatchMedia();
    const mounted = await mountAdmin(ConfigPanel, { ...setHandler(view()), "config.raw": () => ({ text: RAW, path: "/home/me/.tropos/settings.json" }), ...extra });
    fireEvent.click(await screen.findByRole("radio", { name: "Raw JSON" }));
    const area = (await screen.findByLabelText("settings.json")) as HTMLTextAreaElement;
    return { ...mounted, area };
  }

  test("loads the text and saves through config.apply", async () => {
    const applied: unknown[] = [];
    const { area } = await openRaw({ "config.apply": (p) => (applied.push(p), view({ model: "claude-haiku" })) });
    expect(area.value).toBe(RAW);
    expect((screen.getByRole("button", { name: "Validate & save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(area, { target: { value: '{ "model": "claude-haiku" }' } });
    fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
    await screen.findByText(/Saved to \/home\/me\/\.tropos\/settings\.json/);
    expect(applied).toEqual([{ file: "settings", text: '{ "model": "claude-haiku" }' }]);
  });

  test("invalid JSON is caught in the browser with its line, and nothing is sent", async () => {
    const { area, socket } = await openRaw();
    fireEvent.change(area, { target: { value: '{\n  "model": \n}' } });
    fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Not valid JSON");
    expect(alert.textContent).toContain("Your text is still here");
    expect(socket.callsOf("config.apply").length).toBe(0);
    expect(area.value).toBe('{\n  "model": \n}');
  });

  test("a server refusal with a line number is shown with that line", async () => {
    const { area } = await openRaw({ "config.apply": () => { throw new Error("maxTurns must be a number, at line 3"); } });
    fireEvent.change(area, { target: { value: '{\n  "a": 1,\n  "maxTurns": "x"\n}' } });
    fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Line 3.");
    expect(alert.textContent).toContain("maxTurns must be a number");
    expect(area.value).toContain('"maxTurns": "x"');
  });

  test("an unsaved raw edit survives a trip to the form", async () => {
    const { area } = await openRaw();
    fireEvent.change(area, { target: { value: '{ "edited": true }' } });
    fireEvent.click(screen.getByRole("radio", { name: "Form" }));
    await screen.findByLabelText("model");
    fireEvent.click(screen.getByRole("radio", { name: "Raw JSON" }));
    expect(((await screen.findByLabelText("settings.json")) as HTMLTextAreaElement).value).toBe('{ "edited": true }');
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect((screen.getByLabelText("settings.json") as HTMLTextAreaElement).value).toBe(RAW));
  });
});
