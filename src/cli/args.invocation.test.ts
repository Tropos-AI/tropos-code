// src/cli/args.invocation.test.ts
import { describe, expect, test } from "bun:test";
import { CLI_CASES, parseOutcome } from "../../test/helpers/cli-cases";
import { CliError, matchSubcommand, parseCli, parseInvocation } from "./args";

describe("parseInvocation keeps every existing invocation (spec §12.2)", () => {
  for (const c of CLI_CASES) {
    const becomes = c.note.includes("(becomes a subcommand)");
    test(`${JSON.stringify(c.argv)} — ${becomes ? "subcommand" : "unchanged"}`, () => {
      expect(matchSubcommand(c.argv) !== null && c.argv[0] !== "--").toBe(becomes);
      if (becomes) return;
      const before = parseOutcome(c.argv);
      if (before.ok) {
        expect(parseInvocation(c.argv)).toEqual({ kind: "session", options: before.options });
      } else {
        const e = (() => {
          try {
            parseInvocation(c.argv);
          } catch (x) {
            return x as CliError;
          }
          throw new Error("expected a CliError");
        })();
        expect(e).toBeInstanceOf(CliError);
        expect(e.message.startsWith(before.error)).toBe(true);
      }
    });
  }
});

describe("subcommand shapes", () => {
  test.each([
    [["install"], { kind: "install", target: undefined, force: false }],
    [["install", "stable"], { kind: "install", target: "stable", force: false }],
    [["install", "latest", "--force"], { kind: "install", target: "latest", force: true }],
    [["install", "--force", "1.2.3"], { kind: "install", target: "1.2.3", force: true }],
    [["install", "--self", "--manifest", "/t/m.json", "--signature", "/t/m.sig"], { kind: "install-self", manifest: "/t/m.json", signature: "/t/m.sig" }],
    [["update"], { kind: "update", background: false, alias: "update" }],
    [["upgrade"], { kind: "update", background: false, alias: "upgrade" }],
    [["update", "--background"], { kind: "update", background: true, alias: "update" }],
    [["rollback"], { kind: "rollback" }],
    [["install", "-h"], { kind: "help", command: "install" }],
    [["upgrade", "--help"], { kind: "help", command: "upgrade" }],
  ])("%j", (argv, expected) => {
    expect(parseInvocation(argv as string[])).toEqual({ kind: "subcommand", command: expected as never });
  });

  test.each([
    [["install", "foo"]],
    [["install", "1.2"]],
    [["install", "1.2.3", "4.5.6"]],
    [["install", "--force", "--force"]],
    [["install", "--self"]],
    [["install", "--self", "--manifest", "", "--signature", "s"]],
    [["rollback", "now"]],
    [["update", "the", "readme"]],
    [["update", "-p"]],
    [["--", "install"]],
    [["--", "update"]],
  ])("%j is not a subcommand", (argv) => {
    expect(matchSubcommand(argv)).toBeNull();
    // Falls through to the old parser: a session, or its own CliError for unknown flags.
    try {
      expect(parseInvocation(argv).kind).toBe("session");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
    }
  });

  test("-- keeps argv unchanged for the existing parser (amendment A2)", () => {
    expect(parseInvocation(["--", "-p"])).toEqual({ kind: "session", options: parseCli(["--", "-p"]) });
  });

  test("a subcommand word with an unknown flag gets the existing error plus a hint", () => {
    expect(() => parseInvocation(["install", "--force", "--bogus"])).toThrow("For install, see tcode install --help.");
    expect(() => parseInvocation(["update", "--background", "-p"])).toThrow("For update, see tcode update --help.");
  });
});
