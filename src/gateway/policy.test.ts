// src/gateway/policy.test.ts
import { describe, expect, test } from "bun:test";
import { decide, compileRules } from "../permissions/engine";
import { permissionContext } from "../cli/runtime";
import type { Autonomy } from "./config";
import type { AppContext } from "../cli/runtime";
import type { ExecBackend } from "../exec/backend";
import { CHANNEL_MODES, channelContext, chatRole, gatewayHosted, workspaceProblem } from "./policy";

const exec = { kind: "docker" } as ExecBackend;

function base(over: Partial<{ allow: string[]; ask: string[]; deny: string[] }> = {}): AppContext {
  const { rules } = compileRules({ allow: over.allow ?? [], ask: over.ask ?? [], deny: over.deny ?? [] });
  return {
    cwd: "/work/app",
    home: "/h/.tropos",
    rules,
    tools: ["Read", "Bash", "SessionSearch", "WebFetch", "mcp__gh__list"].map((name) => ({ name })),
    ext: { formatters: {}, lsp: {}, skills: [] },
    allowedDirs: ["/work/app", "/work/other"],
    settings: { learning: { review: true, interval: 10, flushAt: 0.8, curator: true } },
    origin: "local",
  } as unknown as AppContext;
}

describe("channelContext", () => {
  test("is marked as a channel origin with the sandbox backend", () => {
    const ctx = channelContext(base(), exec, { role: "guest" });
    expect(ctx.origin).toBe("channel");
    expect(ctx.exec).toBe(exec);
  });

  test("only the workspace is allowed, not the extra directories", () => {
    expect(channelContext(base(), exec, { role: "guest" }).allowedDirs).toEqual(["/work/app"]);
  });

  test("learning: the review stays on for the owner and is off for guests and scheduled runs; the curator is off in every chat", () => {
    expect(channelContext(base(), exec, { role: "owner" }).settings.learning).toMatchObject({ review: true, curator: false });
    for (const r of ["guest", "scheduled"] as const) expect(channelContext(base(), exec, { role: r }).settings.learning).toMatchObject({ review: false, curator: false });
  });

  test("the owner's allow rules don't carry over, so chat commands and writes ask", () => {
    const ctx = channelContext(base({ allow: ["Bash(npm:*)", "Edit", "Write"] }), exec, { role: "guest" });
    expect(ctx.rules.allow).toHaveLength(0);
    const permission = { mode: "default" as const, rules: ctx.rules, cwd: ctx.cwd, home: "/h", allowedDirs: ctx.allowedDirs, confine: true };
    expect(decide({ toolName: "Bash", kind: "exec", command: "npm test", paths: [] }, permission).behavior).toBe("ask");
    expect(decide({ toolName: "Edit", kind: "edit", paths: ["/work/app/a.ts"] }, permission).behavior).toBe("ask");
    expect(decide({ toolName: "Read", kind: "read", paths: ["/work/app/a.ts"] }, permission).behavior).toBe("allow");
  });

  test("the role is carried on the context", () => {
    expect(channelContext(base(), exec, { role: "owner" }).role).toBe("owner");
  });

  test("the owner's chat gets SessionSearch, never WebFetch; a guest and a scheduled run get neither", () => {
    const names = (role: "owner" | "guest" | "scheduled") => channelContext(base(), exec, { role }).tools.map((t) => t.name);
    expect(names("owner")).toEqual(["Read", "Bash", "SessionSearch", "mcp__gh__list"]);
    expect(names("guest")).toEqual(["Read", "Bash", "mcp__gh__list"]);
    expect(names("scheduled")).toEqual(["Read", "Bash", "mcp__gh__list"]);
  });

  test("guests and scheduled runs don't get the store tools, which could never succeed there; the owner keeps them", () => {
    const stores = ["Memory", "DailyNote", "SkillManage", "AgentManage", "Identity"];
    const withStores = { ...base(), tools: ["Read", ...stores].map((name) => ({ name })) } as unknown as AppContext;
    const names = (role: "owner" | "guest" | "scheduled") => channelContext(withStores, exec, { role }).tools.map((t) => t.name);
    expect(names("owner")).toEqual(["Read", ...stores]);
    expect(names("guest")).toEqual(["Read"]);
    expect(names("scheduled")).toEqual(["Read"]);
  });

  test("formatters and language servers, which run on the host, are off", () => {
    const b = base();
    const ctx = channelContext(b, exec, { role: "guest" });
    expect(ctx.ext.formatters).toBeNull();
    expect(ctx.ext.lsp).toBeNull();
    expect(b.ext.formatters).not.toBeNull();
  });

  test("the base context is left alone", () => {
    const b = base({ allow: ["WebFetch"] });
    channelContext(b, exec, { role: "guest" });
    expect(b.rules.ask).toHaveLength(0);
    expect(b.rules.allow).toHaveLength(1);
    expect(b.tools).toHaveLength(5);
    expect(b.allowedDirs).toHaveLength(2);
    expect(b.settings.learning.review).toBe(true);
  });

  test("MCP tools ask, however the owner's rules read", () => {
    const ctx = channelContext(base({ allow: ["mcp__gh__list"], ask: [] }), exec, { role: "guest" });
    const permission = { mode: "default" as const, rules: { ...ctx.rules, allow: compileRules({ allow: ["mcp__gh__list"], ask: [], deny: [] }).rules.allow }, cwd: ctx.cwd, home: "/h", allowedDirs: ctx.allowedDirs, confine: true };
    expect(decide({ toolName: "mcp__gh__list", kind: "exec", paths: [] }, permission).behavior).toBe("ask");
  });

  test("a chat always asks before TroposSetup, even at autonomous with an allow rule for it", () => {
    const ctx = channelContext(base(), exec, { role: "owner", autonomy: () => ({ level: "autonomous", testCommands: [] }) });
    const permission = { ...permissionContext(ctx, "default"), home: "/h" };
    const allowed = { ...permission, rules: { ...permission.rules, allow: compileRules({ allow: ["TroposSetup"], ask: [], deny: [] }).rules.allow } };
    expect(decide({ toolName: "TroposSetup", kind: "exec", paths: [], target: "setup:model.set" }, allowed).behavior).toBe("ask");
  });

  test("the autonomy policy reaches the permission context and stays live", () => {
    let level: Autonomy = "balanced";
    const ctx = channelContext(base(), exec, { role: "owner", autonomy: () => ({ level, testCommands: [] }) });
    expect(ctx.autonomy!().level).toBe("balanced");
    expect(permissionContext(ctx, "default").autonomy).toEqual({ level: "balanced", testCommands: [] });
    level = "ask";
    expect(ctx.autonomy!().level).toBe("ask");
    expect(permissionContext(ctx, "default").autonomy?.level).toBe("ask");
    // Without a policy, a chat asks as before.
    expect(channelContext(base(), exec, { role: "owner" }).autonomy).toBeUndefined();
  });

  test("no chat tool can write gateway.json, even for the owner at autonomous", () => {
    const ctx = channelContext(base(), exec, { role: "owner", autonomy: () => ({ level: "autonomous", testCommands: [] }) });
    const permission = { ...permissionContext(ctx, "default"), home: "/h" };
    expect(permission.confine).toBe(true);
    expect(permission.allowedDirs).toEqual(["/work/app"]);
    for (const toolName of ["Write", "Edit"]) {
      expect(decide({ toolName, kind: "edit", paths: ["/h/.tropos/gateway.json"] }, permission).behavior).toBe("deny");
    }
    // The same level lets a write inside the project through.
    expect(decide({ toolName: "Write", kind: "edit", paths: ["/work/app/a.ts"] }, permission).behavior).toBe("allow");
  });

  test("a deny rule of the user's still denies", () => {
    const ctx = channelContext(base({ deny: ["Read(.env)"] }), exec, { role: "guest" });
    const permission = { mode: "default" as const, rules: ctx.rules, cwd: ctx.cwd, home: "/h", allowedDirs: ctx.allowedDirs, confine: true };
    expect(decide({ toolName: "Read", kind: "read", paths: ["/work/app/.env"] }, permission).behavior).toBe("deny");
  });
});

test("a chat can never be in bypass or accept-edits mode", () => {
  expect(CHANNEL_MODES).toEqual(["default", "plan"]);
});

test("a gateway-hosted runtime (the dashboard's chat) never runs the curator itself; the rest of learning and the base stay", () => {
  const b = base();
  const hosted = gatewayHosted(b);
  expect(hosted.settings.learning).toMatchObject({ review: true, interval: 10, curator: false });
  expect(b.settings.learning.curator).toBe(true);
  expect(hosted.rules).toBe(b.rules);
});

describe("workspaceProblem", () => {
  const userHome = "/Users/me";
  const tropos = "/Users/me/.tropos";
  test("a project directory is fine, even under the home directory", () => {
    expect(workspaceProblem("/Users/me/code/app", tropos, userHome)).toBeUndefined();
    expect(workspaceProblem("/srv/app", tropos, userHome)).toBeUndefined();
  });
  test("the home directory, its parents and the root would put ~/.ssh and ~/.tropos in the container", () => {
    expect(workspaceProblem("/Users/me", tropos, userHome)).toMatch(/home directory/);
    expect(workspaceProblem("/Users", tropos, userHome)).toMatch(/home directory/);
    expect(workspaceProblem("/", tropos, userHome)).toMatch(/root/);
  });
  test("Tropos's own data directory is never a workspace", () => {
    expect(workspaceProblem(tropos, "/Users/me/.tropos", userHome)).toBeDefined();
    expect(workspaceProblem("/Users/me/.tropos/projects/x", tropos, userHome)).toMatch(/data directory/);
  });
});

describe("chatRole", () => {
  test("project keys are scheduled; the owner's private chat is owner; others and groups are guests", async () => {
    const pairing = { isOwner: async (c: string, s: string) => c === "telegram" && s === "7" };
    expect(await chatRole("project:app", pairing)).toBe("scheduled");
    // A scheduled run of a job made in a guest's chat runs as a guest.
    expect(await chatRole("project:app:guest", pairing)).toBe("guest");
    expect(await chatRole("telegram:7", pairing)).toBe("owner");
    expect(await chatRole("telegram:8", pairing)).toBe("guest");
    expect(await chatRole("telegram:-1007", pairing)).toBe("guest");
  });
});
