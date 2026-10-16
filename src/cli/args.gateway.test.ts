// src/cli/args.gateway.test.ts
import { describe, expect, test } from "bun:test";
import { CliError, parseInvocation, type GatewayCommand } from "./args";

describe("tcode gateway", () => {
  test("runs the gateway with the web UI by default", () => {
    const inv = parseInvocation(["gateway"]);
    expect(inv.kind).toBe("session");
    if (inv.kind === "session") expect(inv.options.gateway).toEqual({ web: true });
  });
  test("--workspace and --no-web, in either form", () => {
    for (const argv of [["gateway", "--workspace", "/w", "--no-web"], ["gateway", "--no-web", "--workspace=/w"]]) {
      const inv = parseInvocation(argv);
      if (inv.kind !== "session") throw new Error("expected a session");
      expect(inv.options.gateway).toEqual({ web: false, workspace: "/w" });
    }
  });
  test("takes no prompt and isn't print mode", () => {
    expect(() => parseInvocation(["gateway", "fix", "the", "bug"])).toThrow(CliError);
    expect(() => parseInvocation(["gateway", "-p", "x"])).toThrow(CliError);
    expect(() => parseInvocation(["gateway", "--workspace"])).toThrow(/needs a directory/);
  });
  test("install, uninstall and status are commands, not sessions", () => {
    expect(parseInvocation(["gateway", "install"])).toEqual({ kind: "gateway-command", command: { kind: "gateway-install" } });
    expect(parseInvocation(["gateway", "install", "--workspace", "/w"])).toEqual({ kind: "gateway-command", command: { kind: "gateway-install", workspace: "/w" } });
    expect(parseInvocation(["gateway", "uninstall"])).toEqual({ kind: "gateway-command", command: { kind: "gateway-uninstall" } });
    expect(parseInvocation(["gateway", "status"])).toEqual({ kind: "gateway-command", command: { kind: "gateway-status" } });
    expect(parseInvocation(["gateway", "--help"])).toEqual({ kind: "gateway-command", command: { kind: "help", command: "gateway" } });
    expect(() => parseInvocation(["gateway", "install", "--bogus"])).toThrow(CliError);
  });
});

describe("tcode gateway service commands", () => {
  test("start, stop, restart and logs are commands", () => {
    for (const word of ["start", "stop", "restart"]) {
      expect(parseInvocation(["gateway", word])).toEqual({ kind: "gateway-command", command: { kind: `gateway-${word}` as "gateway-start" } });
      expect(() => parseInvocation(["gateway", word, "--x"])).toThrow(CliError);
    }
    expect(parseInvocation(["gateway", "logs"])).toEqual({ kind: "gateway-command", command: { kind: "gateway-logs" } });
    expect(parseInvocation(["gateway", "logs", "-n", "5"])).toEqual({ kind: "gateway-command", command: { kind: "gateway-logs", lines: 5 } });
    expect(parseInvocation(["gateway", "logs", "--lines=7"])).toEqual({ kind: "gateway-command", command: { kind: "gateway-logs", lines: 7 } });
    expect(() => parseInvocation(["gateway", "logs", "-n", "x"])).toThrow(/usage/);
  });
});

describe("tcode projects", () => {
  test("list (also the bare word), add, remove and default", () => {
    const cmd = (command: GatewayCommand) => ({ kind: "gateway-command" as const, command });
    expect(parseInvocation(["projects"])).toEqual(cmd({ kind: "projects-list" }));
    expect(parseInvocation(["projects", "list"])).toEqual(cmd({ kind: "projects-list" }));
    expect(parseInvocation(["projects", "add", "/w/app"])).toEqual(cmd({ kind: "projects-add", path: "/w/app" }));
    expect(parseInvocation(["projects", "add", "/w/app", "--name", "My App"])).toEqual(cmd({ kind: "projects-add", path: "/w/app", name: "My App" }));
    expect(parseInvocation(["projects", "add", "--name=X", "app"])).toEqual(cmd({ kind: "projects-add", path: "app", name: "X" }));
    expect(parseInvocation(["projects", "remove", "app"])).toEqual(cmd({ kind: "projects-remove", id: "app" }));
    expect(parseInvocation(["projects", "default", "app"])).toEqual(cmd({ kind: "projects-default", id: "app" }));
    expect(parseInvocation(["projects", "--help"])).toEqual(cmd({ kind: "help", command: "projects" }));
  });
  test("malformed uses say how to use it", () => {
    for (const argv of [["projects", "add"], ["projects", "add", "a", "b"], ["projects", "add", "a", "--name"], ["projects", "remove"], ["projects", "wat"]]) {
      expect(() => parseInvocation(argv)).toThrow(/usage: tcode projects/);
    }
  });
  test("tcode -- projects is still a prompt", () => {
    const inv = parseInvocation(["--", "projects"]);
    expect(inv.kind).toBe("session");
  });
});

describe("tcode pairing", () => {
  test("approve, list and revoke", () => {
    expect(parseInvocation(["pairing", "approve", "telegram", "ABCD2345"])).toEqual({
      kind: "gateway-command",
      command: { kind: "pairing-approve", channel: "telegram", code: "ABCD2345" },
    });
    expect(parseInvocation(["pairing", "list"]).kind).toBe("gateway-command");
    expect(parseInvocation(["pairing", "revoke", "telegram", "42"])).toEqual({
      kind: "gateway-command",
      command: { kind: "pairing-revoke", channel: "telegram", senderId: "42" },
    });
  });
  test("a malformed pairing command says how to use it", () => {
    expect(() => parseInvocation(["pairing", "approve", "telegram"])).toThrow(/usage: tcode pairing/);
    expect(() => parseInvocation(["pairing", "nope"])).toThrow(/usage: tcode pairing/);
  });
  test("tcode -- gateway is still a prompt", () => {
    const inv = parseInvocation(["--", "gateway"]);
    expect(inv.kind).toBe("session");
    if (inv.kind === "session") expect(inv.options.prompt).toBe("gateway");
  });
});
