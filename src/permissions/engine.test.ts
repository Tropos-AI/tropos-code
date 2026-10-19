// src/permissions/engine.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { Autonomy } from "../gateway/config";
import { troposStorePaths } from "../learning/stores";
import { createSkillManageTool } from "../memory/skill-manage";
import { PLAN_MODE_REASON, compileRules, decide, inGitControlDir, isProjectSettingsFile, isStoreSave, suggestRule, type PermissionContext, type PermissionRequest } from "./engine";

const cwd = "/work/app";
function ctx(over: Partial<PermissionContext> & { allow?: string[]; ask?: string[]; deny?: string[] } = {}): PermissionContext {
  const { allow = [], ask = [], deny = [], ...rest } = over;
  const { rules } = compileRules({ allow, ask, deny });
  return { mode: "default", cwd, home: "/home/u", allowedDirs: [cwd], ...rest, rules };
}
const bash = (command: string): PermissionRequest => ({ toolName: "Bash", kind: "exec", command, paths: [] });
const edit = (path: string): PermissionRequest => ({ toolName: "Edit", kind: "edit", paths: [path] });
const write = (path: string): PermissionRequest => ({ toolName: "Write", kind: "edit", paths: [path] });
const read = (path: string): PermissionRequest => ({ toolName: "Read", kind: "read", paths: [path] });

describe("compileRules", () => {
  test("collects invalid rules instead of throwing", () => {
    const { rules, invalid } = compileRules({ allow: ["Read", "Bash("], ask: [], deny: [] });
    expect(rules.allow).toHaveLength(1);
    expect(invalid).toEqual(["Bash("]);
  });
});

describe("decide — defaults", () => {
  test("reads inside the project are allowed", () => {
    expect(decide(read("/work/app/a.ts"), ctx())).toEqual({ behavior: "allow" });
  });
  test("meta tools are allowed", () => {
    expect(decide({ toolName: "TodoWrite", kind: "meta", paths: [] }, ctx())).toEqual({ behavior: "allow" });
  });
  test("edits ask in default mode with a suggestion", () => {
    expect(decide(edit("/work/app/src/a.ts"), ctx())).toEqual({ behavior: "ask", suggestion: "Edit(src/**)" });
  });
  test("bash asks with a prefix suggestion", () => {
    expect(decide(bash("bun test src/cli"), ctx())).toEqual({ behavior: "ask", suggestion: "Bash(bun test:*)" });
  });
});

describe("decide — modes", () => {
  test("acceptEdits allows edits inside the project but not bash", () => {
    expect(decide(write("/work/app/x.ts"), ctx({ mode: "acceptEdits" }))).toEqual({ behavior: "allow" });
    expect(decide(bash("ls"), ctx({ mode: "acceptEdits" })).behavior).toBe("ask");
  });
  test("acceptEdits still asks outside the project", () => {
    expect(decide(edit("/etc/hosts"), ctx({ mode: "acceptEdits" })).behavior).toBe("ask");
  });
  test("plan mode denies edits and exec but allows reads", () => {
    expect(decide(edit("/work/app/a.ts"), ctx({ mode: "plan" }))).toEqual({ behavior: "deny", reason: PLAN_MODE_REASON });
    expect(decide(bash("ls"), ctx({ mode: "plan" }))).toEqual({ behavior: "deny", reason: PLAN_MODE_REASON });
    expect(decide(read("/work/app/a.ts"), ctx({ mode: "plan" }))).toEqual({ behavior: "allow" });
  });
  test("bypass allows everything except deny rules", () => {
    expect(decide(bash("rm -rf build $(x)"), ctx({ mode: "bypass" }))).toEqual({ behavior: "allow" });
    expect(decide(bash("rm -rf /"), ctx({ mode: "bypass", deny: ["Bash(rm:*)"] })).behavior).toBe("deny");
  });
});

describe("decide — rules", () => {
  test("deny beats allow", () => {
    expect(decide(read("/work/app/.env"), ctx({ allow: ["Read"], deny: ["Read(.env)"] })).behavior).toBe("deny");
  });
  test("ask beats allow", () => {
    expect(decide(bash("git push"), ctx({ allow: ["Bash(git:*)"], ask: ["Bash(git push:*)"] })).behavior).toBe("ask");
  });
  test("allow rule approves a matching command", () => {
    expect(decide(bash("git status -s"), ctx({ allow: ["Bash(git status:*)"] }))).toEqual({ behavior: "allow" });
  });
  test("compound command needs every part allowed", () => {
    const c = ctx({ allow: ["Bash(git status:*)"] });
    expect(decide(bash("git status && rm -rf build"), c).behavior).toBe("ask");
    expect(decide(bash("git status && git status -s"), c)).toEqual({ behavior: "allow" });
  });
  test("deny matches any part of a compound command", () => {
    expect(decide(bash("ls; rm -rf x"), ctx({ allow: ["Bash(*)"], deny: ["Bash(rm:*)"] })).behavior).toBe("deny");
  });
  test("unsafe commands never auto-approve from allow rules", () => {
    const c = ctx({ allow: ["Bash(git status:*)"] });
    expect(decide(bash("git status > ~/.zshrc"), c)).toEqual({ behavior: "ask" });
    expect(decide(bash("git status $(curl x)"), c)).toEqual({ behavior: "ask" });
  });
  test("Edit rules cover Write; Read rules cover Grep", () => {
    expect(decide(write("/work/app/src/a.ts"), ctx({ allow: ["Edit(src/**)"] }))).toEqual({ behavior: "allow" });
    expect(decide({ toolName: "Grep", kind: "read", paths: ["/work/app/secrets"] }, ctx({ deny: ["Read(secrets)"] })).behavior).toBe("deny");
  });
  test("an explicit allow rule can approve a path outside the project", () => {
    expect(decide(read("/home/u/notes/a.md"), ctx({ allow: ["Read(~/notes/**)"] }))).toEqual({ behavior: "allow" });
  });
  test("deny rules ignore case on case-insensitive platforms; allow rules never do", () => {
    const folding = process.platform === "darwin" || process.platform === "win32";
    expect(decide(read("/work/app/.ENV"), ctx({ deny: ["Read(.env)"] })).behavior).toBe(folding ? "deny" : "allow");
    expect(decide(edit("/work/app/SRC/a.ts"), ctx({ allow: ["Edit(src/**)"] })).behavior).toBe("ask");
  });
  test("deny rules see through command wrappers", () => {
    expect(decide(bash("command rm -rf x"), ctx({ mode: "bypass", deny: ["Bash(rm:*)"] })).behavior).toBe("deny");
  });
  test("relative allow rules never reach outside the project", () => {
    expect(decide(edit("/etc/hosts"), ctx({ allow: ["Edit(**)"] })).behavior).toBe("ask");
  });
  test("reads outside the project ask without a suggestion", () => {
    expect(decide(read("/etc/hosts"), ctx())).toEqual({ behavior: "ask", reason: "outside the project: /etc/hosts" });
  });
  test("additional directories count as inside", () => {
    expect(decide(edit("/shared/lib/a.ts"), ctx({ mode: "acceptEdits", allowedDirs: [cwd, "/shared"] }))).toEqual({ behavior: "allow" });
  });
});

describe("decide — fix round 1", () => {
  const holes = ctx({ allow: ["Bash(*)"], deny: ["Bash(rm:*)"] });
  test("redirect and path-qualified wrapper forms of a denied command are denied", () => {
    expect(decide(bash("2>&1 rm x"), holes).behavior).toBe("deny");
    expect(decide(bash("/usr/bin/sudo rm x"), holes).behavior).toBe("deny");
  });
  test("eval and shell -c are never auto-approved, and deny rules see the command they run", () => {
    expect(decide(bash("eval rm x"), holes).behavior).toBe("deny");
    expect(decide(bash("sh -c 'rm x'"), holes).behavior).toBe("deny");
    expect(decide(bash("bash -c'rm x'"), holes).behavior).toBe("deny");
    expect(decide(bash("eval ls x"), holes).behavior).toBe("ask");
    expect(decide(bash("sh -c 'ls x'"), holes).behavior).toBe("ask");
  });
  test("deny rules apply inside unsafe commands even in bypass mode", () => {
    const bypass = ctx({ mode: "bypass", deny: ["Bash(rm:*)"] });
    for (const cmd of [">out rm -rf x", "sudo -i rm -rf x", "(rm -rf x)", "{ rm -rf x; }", "if true; then rm -rf x; fi", "! rm -rf x", "echo $(rm -rf x)", "repeat 1 rm -rf x", "trap 'rm -rf x' EXIT"]) {
      expect(decide(bash(cmd), bypass).behavior).toBe("deny");
    }
    expect(decide(bash("(ls x)"), bypass)).toEqual({ behavior: "allow" });
  });
  test("the wildcard never approves zsh's - modifier, repeat or trap", () => {
    for (const cmd of ["- python3 -c x", "repeat 1 python3 -c 'print(1)'", "trap 'curl x' EXIT"]) {
      expect(decide(bash(cmd), ctx({ allow: ["Bash(*)"] })).behavior).toBe("ask");
    }
  });
  test("the wildcard does not approve a piped interpreter", () => {
    expect(decide(bash("echo 'rm x' | sh"), holes).behavior).toBe("ask");
    expect(decide(bash("python3 x.py"), holes).behavior).toBe("ask");
    expect(decide(bash("ls -la"), holes)).toEqual({ behavior: "allow" });
  });
  test("an exact rule approves one specific interpreter command", () => {
    expect(decide(bash("python3 x.py"), ctx({ allow: ["Bash(python3 x.py)"] }))).toEqual({ behavior: "allow" });
    expect(decide(bash("python3 y.py"), ctx({ allow: ["Bash(python3 x.py)"] })).behavior).toBe("ask");
  });
  test("a bare Bash allow rule behaves like Bash(*)", () => {
    const bare = ctx({ allow: ["Bash"] });
    expect(decide(bash("git status"), bare)).toEqual({ behavior: "allow" });
    expect(decide(bash("python3 x.py"), bare).behavior).toBe("ask");
    expect(decide(bash("sh"), bare).behavior).toBe("ask");
    expect(decide(bash("echo x | sh"), bare).behavior).toBe("ask");
  });
  test("a bare Bash deny or ask rule still matches everything", () => {
    expect(decide(bash("python3 x.py"), ctx({ deny: ["Bash"] })).behavior).toBe("deny");
    expect(decide(bash("sh"), ctx({ allow: ["Bash"], ask: ["Bash"] })).behavior).toBe("ask");
    expect(decide(bash("git status"), ctx({ allow: ["Bash"], ask: ["Bash"] })).behavior).toBe("ask");
  });
  test("versioned interpreters are not approved by the wildcard and get an exact suggestion", () => {
    expect(decide(bash("python3.12 x.py"), holes).behavior).toBe("ask");
    expect(decide(bash("ssh host ls"), holes).behavior).toBe("ask");
    expect(suggestRule(bash("python3.12 x.py"), cwd)).toBe("Bash(python3.12 x.py)");
    expect(suggestRule(bash("bun test x"), cwd)).toBe("Bash(bun test:*)");
  });
  test("bypass beats ask rules", () => {
    expect(decide(bash("git push"), ctx({ mode: "bypass", ask: ["Bash(git push:*)"] }))).toEqual({ behavior: "allow" });
  });
  test("a bare allow rule never approves a path outside the project", () => {
    expect(decide(read("/etc/hosts"), ctx({ allow: ["Read"] }))).toEqual({ behavior: "ask", reason: "outside the project: /etc/hosts" });
    expect(decide(read("/etc/hosts"), ctx({ allow: ["Read(/etc/**)"] }))).toEqual({ behavior: "allow" });
    expect(decide(read("/work/app/a.ts"), ctx({ allow: ["Read"] }))).toEqual({ behavior: "allow" });
    expect(decide(edit("/work/app/a.ts"), ctx({ allow: ["Edit"] }))).toEqual({ behavior: "allow" });
    expect(decide(edit("/etc/hosts"), ctx({ allow: ["Edit"] })).behavior).toBe("ask");
  });
  test("a bare deny rule still applies everywhere", () => {
    expect(decide(read("/etc/hosts"), ctx({ deny: ["Read"] })).behavior).toBe("deny");
  });
});

describe("decide — final review fixes", () => {
  const deny = ctx({ allow: ["Bash(*)"], deny: ["Bash(rm:*)"] });
  test("deny rules see through path-qualified command words", () => {
    expect(decide(bash("/bin/rm -rf x"), deny).behavior).toBe("deny");
    expect(decide(bash("./rm -rf x"), deny).behavior).toBe("deny");
    expect(decide(bash("sudo /bin/rm -rf x"), deny).behavior).toBe("deny");
    expect(decide(bash("/bin/rm -rf x"), ctx({ mode: "bypass", deny: ["Bash(rm:*)"] })).behavior).toBe("deny");
    expect(decide(bash('"/bin/rm" -rf x'), deny).behavior).toBe("deny");
  });
  test("an allow rule for rm does not approve a path-qualified rm", () => {
    expect(decide(bash("/bin/rm x"), ctx({ allow: ["Bash(rm:*)"] })).behavior).toBe("ask");
    expect(decide(bash("rm x"), ctx({ allow: ["Bash(rm:*)"] }))).toEqual({ behavior: "allow" });
  });
  test("the wildcard does not approve zsh precommand modifiers wrapping a code runner", () => {
    expect(decide(bash("noglob python3 -c x"), ctx({ allow: ["Bash(*)"] })).behavior).toBe("ask");
    expect(decide(bash("nocorrect sh s.sh"), ctx({ allow: ["Bash(*)"] })).behavior).toBe("ask");
  });
  test("a deny rule sees through nocorrect", () => {
    expect(decide(bash("nocorrect rm x"), deny).behavior).toBe("deny");
  });
  test("a non-breaking space does not match a plain-space rule", () => {
    expect(decide(bash("git\u00a0status"), ctx({ allow: ["Bash(git status:*)"] })).behavior).toBe("ask");
    expect(decide(bash("git  status"), ctx({ allow: ["Bash(git status:*)"] }))).toEqual({ behavior: "allow" });
  });
  test("acceptEdits asks before writing inside .git or .husky", () => {
    const c = ctx({ mode: "acceptEdits" });
    for (const p of ["/work/app/.git/hooks/pre-commit", "/work/app/.git/config", "/work/app/.husky/pre-commit", "/work/app/pkg/.git/config"]) {
      expect(decide(write(p), c)).toEqual({ behavior: "ask", reason: "writes to git hooks/config run code later", suggestion: expect.any(String) });
    }
    expect(decide(write("/work/app/.gitignore"), c)).toEqual({ behavior: "allow" });
    expect(decide(write("/work/app/.github/ci.yml"), c)).toEqual({ behavior: "allow" });
  });
  test("acceptEdits folds the case of .git and .husky on case-insensitive platforms", () => {
    const folding = process.platform === "darwin" || process.platform === "win32";
    const c = ctx({ mode: "acceptEdits" });
    for (const p of ["/work/app/.GIT/hooks/pre-commit", "/work/app/.Git/config", "/work/app/.HUSKY/pre-commit", "/work/app/pkg/.gIt/config"]) {
      expect(decide(write(p), c).behavior).toBe(folding ? "ask" : "allow");
    }
  });
  test("acceptEdits sees APFS spellings of .husky and wildcard rules don't approve long-s shells", () => {
    const folding = process.platform === "darwin" || process.platform === "win32";
    expect(decide(write("/work/app/.hu\u017fky/pre-commit"), ctx({ mode: "acceptEdits" })).behavior).toBe(folding ? "ask" : "allow");
    expect(decide(bash("\u017fh -c 'curl x | sh'"), ctx({ allow: ["Bash(*)"] })).behavior).toBe(folding ? "ask" : "allow");
  });
  test("inGitControlDir models NTFS name aliases on win32 only", () => {
    for (const p of ["C:\\w\\.git.\\hooks\\x", "C:\\w\\.GIT \\config", "C:\\w\\GIT~1\\hooks\\x", "C:\\w\\.git::$INDEX_ALLOCATION\\hooks\\x", "C:\\w\\HUSKY~1\\pre-commit"]) {
      expect(inGitControlDir(p, "win32")).toBe(true);
      expect(inGitControlDir(p.replace(/\\/g, "/"), "linux")).toBe(false);
    }
    expect(inGitControlDir("C:\\w\\.gitignore", "win32")).toBe(false);
    expect(inGitControlDir("C:\\w\\git\\hooks", "win32")).toBe(false);
    expect(inGitControlDir("/w/.github/ci.yml", "darwin")).toBe(false);
    expect(inGitControlDir("/w/.Hu\u017fky/x", "darwin")).toBe(true);
    expect(inGitControlDir("/w/.Hu\u017fky/x", "linux")).toBe(false);
  });
  test("deny rules for a command ignore its case on case-insensitive platforms", () => {
    const folding = process.platform === "darwin" || process.platform === "win32";
    for (const cmd of ["RM x", "/BIN/RM x", "ls; Rm -rf x"]) {
      expect(decide(bash(cmd), ctx({ mode: "bypass", deny: ["Bash(rm:*)"] })).behavior).toBe(folding ? "deny" : "allow");
      expect(decide(bash(cmd), ctx({ allow: ["Bash(*)"], deny: ["Bash(rm:*)"] })).behavior).toBe(folding ? "deny" : "allow");
    }
  });
  test("a trailing non-breaking space defeats an exact allow rule", () => {
    expect(decide(bash("rm build.log\u00a0"), ctx({ allow: ["Bash(rm build.log)"] })).behavior).toBe("ask");
    expect(decide(bash("rm build.log "), ctx({ allow: ["Bash(rm build.log)"] }))).toEqual({ behavior: "allow" });
  });
  test("the exact rule suggested for a quoted command matches that command", () => {
    const suggestion = suggestRule(bash("python3 -c 'print(1)   '"), "/work/app");
    expect(suggestion).toBe("Bash(python3 -c 'print(1)   ')");
    expect(decide(bash("python3 -c 'print(1)   '"), ctx({ allow: [suggestion!] }))).toEqual({ behavior: "allow" });
  });
  test("broad Edit rules never approve writes inside .git or .husky, in any mode", () => {
    for (const mode of ["default", "acceptEdits"] as const) {
      for (const rule of ["Edit(**)", "Edit", "Edit(/work/app/**)", "Write(**)"]) {
        for (const p of ["/work/app/.git/hooks/pre-commit", "/work/app/.husky/pre-commit", "/work/app/sub/.git/config"]) {
          expect(decide(write(p), ctx({ mode, allow: [rule] })).behavior).toBe("ask");
        }
        // .HUSKY is the same folder only where the filesystem folds case; on Linux it is an ordinary one.
        const folding = process.platform === "darwin" || process.platform === "win32";
        expect(decide(write("/work/app/.HUSKY/pre-commit"), ctx({ mode, allow: [rule] })).behavior).toBe(folding ? "ask" : "allow");
        expect(decide(write("/work/app/src/a.ts"), ctx({ mode, allow: [rule] }))).toEqual({ behavior: "allow" });
      }
    }
  });
  test("a rule that names .git or .husky still approves writes there", () => {
    for (const rule of ["Edit(.git/hooks/**)", "Edit(**/.husky/**)", "Edit(/work/app/.git/**)"]) {
      const target = rule.includes("husky") ? "/work/app/.husky/pre-commit" : "/work/app/.git/hooks/pre-commit";
      expect(decide(write(target), ctx({ allow: [rule] }))).toEqual({ behavior: "allow" });
    }
  });
  test("an explicit allow rule still approves a write inside .git", () => {
    const c = ctx({ mode: "acceptEdits", allow: ["Edit(.husky/**)"] });
    expect(decide(write("/work/app/.husky/pre-commit"), c)).toEqual({ behavior: "allow" });
  });
});

describe("decide — symlinks", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await makeTmpDir();
    await mkdir(join(dir, "outside"));
    await mkdir(join(dir, "proj"));
    await symlink(join(dir, "outside"), join(dir, "proj", "link"));
  });
  afterAll(() => removeDir(dir));

  test("symlinked dir counts as outside once the path is canonicalized", async () => {
    const { resolveToolPath } = await import("../tools/paths");
    const target = resolveToolPath("link/new-file.ts", join(dir, "proj"));
    const c: PermissionContext = { ...ctx({ mode: "acceptEdits" }), cwd: join(dir, "proj"), allowedDirs: [join(dir, "proj")] };
    expect(decide(edit(target), c).behavior).toBe("ask");
  });
});

describe("suggestRule", () => {
  test("bash prefixes", () => {
    expect(suggestRule(bash("ls"), cwd)).toBe("Bash(ls:*)");
    expect(suggestRule(bash("cat notes.txt"), cwd)).toBe("Bash(cat:*)");
    expect(suggestRule(bash("git commit -m x"), cwd)).toBe("Bash(git commit:*)");
  });
  test("no suggestion for compound or unsafe commands", () => {
    expect(suggestRule(bash("a && b"), cwd)).toBeUndefined();
    expect(suggestRule(bash("echo x > f"), cwd)).toBeUndefined();
  });
  test("interpreters and code runners get an exact rule, never a prefix", () => {
    expect(suggestRule(bash("python3 evil.py"), cwd)).toBe("Bash(python3 evil.py)");
    expect(suggestRule(bash("bash script.sh"), cwd)).toBe("Bash(bash script.sh)");
    expect(suggestRule(bash("/bin/bash  script.sh"), cwd)).toBe("Bash(/bin/bash script.sh)");
    expect(suggestRule(bash("node"), cwd)).toBe("Bash(node)");
  });
  test("no exact rule for a very long interpreter command", () => {
    expect(suggestRule(bash(`python3 ${"a".repeat(200)}`), cwd)).toBeUndefined();
  });
  test("no suggestion when assignments, redirects or wrappers lead the command", () => {
    expect(suggestRule(bash("sudo -u root ls"), cwd)).toBeUndefined();
    expect(suggestRule(bash("FOO=1 git status"), cwd)).toBeUndefined();
    expect(suggestRule(bash("2>&1 rm x"), cwd)).toBeUndefined();
    expect(suggestRule(bash("env FOO=1 ls"), cwd)).toBeUndefined();
  });
  test("ordinary commands keep the prefix rule", () => {
    expect(suggestRule(bash("git status"), cwd)).toBe("Bash(git status:*)");
  });
  test("a dash-led second word gets the exact command rule, not a one-word prefix", () => {
    expect(suggestRule(bash("git -c core.pager=id log"), cwd)).toBe("Bash(git -c core.pager=id log)");
    expect(suggestRule(bash("git  -C  /tmp status"), cwd)).toBe("Bash(git -C /tmp status)");
    expect(suggestRule(bash(`git -c ${"a".repeat(200)}`), cwd)).toBeUndefined();
    expect(suggestRule(bash("git status"), cwd)).toBe("Bash(git status:*)");
    expect(suggestRule(bash("ls -la"), cwd)).toBe("Bash(ls -la)");
  });
  test("edit at project root", () => {
    expect(suggestRule(edit("/work/app/a.ts"), cwd)).toBe("Edit(**)");
  });
});

describe("decide — bounded work", () => {
  test("a pathological command is decided quickly, and deny/ask rules fail closed", () => {
    const c = ctx({ allow: ["Bash(*)"], deny: ["Bash(nice:*)", "Bash(rm:*)"] });
    for (const cmd of ["(" + "nice ".repeat(20000) + "ls)", "sudo -u root ".repeat(20000) + "ls", "ls " + ">".repeat(20000)]) {
      const start = performance.now();
      expect(decide(bash(cmd), c).behavior).toBe("deny");
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
  test("everyday commands are unaffected by the work allowance", () => {
    const c = ctx({ allow: ["Bash(*)"], deny: ["Bash(rm:*)"] });
    expect(decide(bash("git status && ls -la | wc -l"), c)).toEqual({ behavior: "allow" });
    expect(decide(bash("sudo rm -rf build"), c).behavior).toBe("deny");
  });
});

describe("decide — targets, network and MCP tools", () => {
  const fetchReq = (domain: string): PermissionRequest => ({ toolName: "WebFetch", kind: "net", paths: [], target: `domain:${domain}` });
  const mcp = (name: string): PermissionRequest => ({ toolName: name, kind: "exec", paths: [] });

  test("network tools ask with a target rule suggestion, even in acceptEdits", () => {
    expect(decide(fetchReq("bun.sh"), ctx({ mode: "acceptEdits" }))).toEqual({ behavior: "ask", suggestion: "WebFetch(domain:bun.sh)" });
  });
  test("network tools may run in plan mode", () => {
    expect(decide(fetchReq("bun.sh"), ctx({ mode: "plan", allow: ["WebFetch(domain:bun.sh)"] }))).toEqual({ behavior: "allow" });
  });
  test("target patterns glob and ignore case", () => {
    expect(decide(fetchReq("Docs.Python.org"), ctx({ allow: ["WebFetch(domain:*.python.org)"] }))).toEqual({ behavior: "allow" });
    expect(decide(fetchReq("python.org.evil.com"), ctx({ allow: ["WebFetch(domain:*.python.org)"] })).behavior).toBe("ask");
    expect(decide(fetchReq("x.io"), ctx({ allow: ["WebFetch"], deny: ["WebFetch(domain:x.io)"] })).behavior).toBe("deny");
  });
  test("a bare rule allows every target", () => {
    expect(decide(fetchReq("x.io"), ctx({ allow: ["WebFetch"] }))).toEqual({ behavior: "allow" });
  });
  test("a server rule covers all of its tools, and a trailing * is a prefix", () => {
    expect(decide(mcp("mcp__github__create_issue"), ctx({ allow: ["mcp__github"] }))).toEqual({ behavior: "allow" });
    expect(decide(mcp("mcp__github__create_issue"), ctx({ allow: ["mcp__github__*"] }))).toEqual({ behavior: "allow" });
    expect(decide(mcp("mcp__githubx__a"), ctx({ allow: ["mcp__github"] })).behavior).toBe("ask");
    expect(decide(mcp("mcp__github__delete_repo"), ctx({ allow: ["mcp__github"], deny: ["mcp__github__delete_*"] })).behavior).toBe("deny");
  });
  test("a target with a wildcard or parenthesis gets no rule suggestion", () => {
    expect(decide(fetchReq("*"), ctx())).toEqual({ behavior: "ask" });
    expect(decide({ toolName: "Skill", kind: "net", paths: [], target: "a)b" }, ctx())).toEqual({ behavior: "ask" });
  });
  test("patterned deny and ask rules still cover tools without paths, commands or targets", () => {
    expect(decide(mcp("mcp__github__delete_repo"), ctx({ allow: ["mcp__github"], deny: ["mcp__github__delete_repo(*)"] })).behavior).toBe("deny");
    expect(decide(mcp("mcp__github__x"), ctx({ allow: ["mcp__github"], ask: ["mcp__github(*)"] })).behavior).toBe("ask");
    expect(decide(mcp("mcp__github__x"), ctx({ allow: ["mcp__github__x(*)"] })).behavior).toBe("ask");
    // Kind-based matching doesn't reach them: a Read path rule leaves a pathless read tool alone.
    expect(decide({ toolName: "SessionSearch", kind: "read", paths: [] }, ctx({ deny: ["Read(.env)"] })).behavior).toBe("allow");
  });
  test("no rule suggestion for a folder whose name is a glob", () => {
    expect(decide(edit("/work/app/*/a.ts"), ctx())).toEqual({ behavior: "ask" });
    expect(decide(edit("/work/app/[a-z]/a.ts"), ctx())).toEqual({ behavior: "ask" });
  });
  test("an exec tool without command or paths suggests its own name", () => {
    expect(decide(mcp("mcp__db__query"), ctx())).toEqual({ behavior: "ask", suggestion: "mcp__db__query" });
  });
});

describe("decide — confine (sessions from a messaging channel)", () => {
  const confined = (over: Parameters<typeof ctx>[0] = {}): PermissionContext => ({ ...ctx(over), confine: true });
  test("a path outside the workspace is denied instead of asked about", () => {
    expect(decide(read("/etc/passwd"), confined())).toEqual({
      behavior: "deny",
      reason: "This session is confined to the workspace; /etc/passwd is outside it.",
    });
    expect(decide(edit("/home/u/.ssh/config"), confined()).behavior).toBe("deny");
  });
  test("bypass mode and allow rules don't lift it", () => {
    expect(decide(read("/etc/passwd"), confined({ mode: "bypass" })).behavior).toBe("deny");
    expect(decide(read("/etc/passwd"), confined({ allow: ["Read"] })).behavior).toBe("deny");
  });
  test("inside the workspace nothing changes", () => {
    expect(decide(read("/work/app/a.ts"), confined())).toEqual({ behavior: "allow" });
    expect(decide(edit("/work/app/src/a.ts"), confined()).behavior).toBe("ask");
  });
  test("an ask rule outranks an allow rule, so WebFetch and MCP can be forced to ask", () => {
    const rules = confined({ allow: ["WebFetch", "mcp__gh__list"], ask: ["WebFetch", "mcp__*"] });
    expect(decide({ toolName: "WebFetch", kind: "exec", paths: [], target: "domain:example.com" }, rules).behavior).toBe("ask");
    expect(decide({ toolName: "mcp__gh__list", kind: "exec", paths: [] }, rules).behavior).toBe("ask");
  });
  test("without confine the same path asks, as before", () => {
    expect(decide(read("/etc/passwd"), ctx()).behavior).toBe("ask");
  });
});

describe("decide — saving to Tropos's stores", () => {
  let home: string;
  let outside: string;
  let m: string;
  beforeAll(async () => {
    home = await makeTmpDir();
    outside = await makeTmpDir();
    m = join(home, "memories", "MEMORY.md");
  });
  afterAll(async () => {
    await removeDir(home);
    await removeDir(outside);
  });
  const owner = (over: Parameters<typeof ctx>[0] = {}) => ctx({ role: "owner", stores: { paths: troposStorePaths(home), askBeforeSaving: false }, ...over });
  const memory = (p: string): PermissionRequest => ({ toolName: "Memory", kind: "edit", paths: [p] });

  test("the owner's Memory save inside the store is allowed without asking", () => {
    expect(decide(memory(join(home, "memories", "MEMORY.md")), owner())).toEqual({ behavior: "allow" });
  });
  test("each store tool saving into its store is allowed for the owner", () => {
    const saves: PermissionRequest[] = [
      { toolName: "Memory", kind: "edit", paths: [join(home, "memories", "USER.md")] },
      { toolName: "SkillManage", kind: "edit", paths: [join(home, "skills", "deploy", "SKILL.md")] },
      { toolName: "SkillManage", kind: "edit", paths: [join(home, "skills-learned", "deploy", "SKILL.md")] },
      { toolName: "AgentManage", kind: "edit", paths: [join(home, "agents", "george.md")] },
      { toolName: "Identity", kind: "edit", paths: [join(home, "IDENTITY.md"), join(home, "identity.json")] },
      { toolName: "Identity", kind: "edit", paths: [join(home, "SOUL.md")] },
    ];
    for (const req of saves) expect(decide(req, owner())).toEqual({ behavior: "allow" });
    const notes = join(home, "projects", "p", "notes");
    const journal = owner({ stores: { paths: [...troposStorePaths(home), notes], askBeforeSaving: false } });
    expect(decide({ toolName: "DailyNote", kind: "edit", paths: [join(notes, "2026-10-16.md")] }, journal)).toEqual({ behavior: "allow" });
  });
  test("askBeforeSaving brings the prompt back", () => {
    expect(decide(memory(m), owner({ stores: { paths: troposStorePaths(home), askBeforeSaving: true } })).behavior).toBe("ask");
  });
  test("a guest or scheduled role, or no role, still asks", () => {
    expect(decide(memory(m), owner({ role: "guest" })).behavior).toBe("ask");
    expect(decide(memory(m), owner({ role: "scheduled" })).behavior).toBe("ask");
    expect(decide(memory(m), owner({ role: undefined })).behavior).toBe("ask");
    expect(decide(memory(m), owner({ stores: undefined })).behavior).toBe("ask");
  });
  test("another tool on the same path still asks (Write to MEMORY.md)", () => {
    expect(decide(write(m), owner()).behavior).toBe("ask");
  });
  test("a store tool aimed outside the stores still asks", () => {
    expect(decide(memory("/etc/x"), owner()).behavior).toBe("ask");
    // Every path must be in a store, not just one; the home itself (settings.json) is not a store.
    expect(decide({ toolName: "Identity", kind: "edit", paths: [join(home, "IDENTITY.md"), "/etc/x"] }, owner()).behavior).toBe("ask");
    expect(decide(memory(join(home, "settings.json")), owner()).behavior).toBe("ask");
    expect(decide(memory(join(home, "memories", "..", "settings.json")), owner()).behavior).toBe("ask");
    expect(isStoreSave({ toolName: "Memory", kind: "edit", paths: [] }, owner())).toBe(false);
  });
  test("confinement lets the owner's store save through and denies a guest's", () => {
    expect(decide(memory(m), owner({ confine: true })).behavior).toBe("allow");
    expect(decide(memory(m), owner({ confine: true, role: "guest" })).behavior).toBe("deny");
    // The carve-out covers the stores only: anything else outside the workspace is still denied.
    expect(decide(memory("/etc/x"), owner({ confine: true })).behavior).toBe("deny");
  });
  test("a deny rule or an ask rule still wins", () => {
    expect(decide(memory(m), owner({ deny: ["Memory"] })).behavior).toBe("deny");
    expect(decide(memory(m), owner({ ask: ["Memory"] })).behavior).toBe("ask");
    expect(decide(memory(m), owner({ confine: true, ask: ["Edit"] })).behavior).toBe("ask");
  });
  test("askBeforeSaving in the owner's chat asks, neither allowing nor denying", () => {
    expect(decide(memory(m), owner({ confine: true, stores: { paths: troposStorePaths(home), askBeforeSaving: true } })).behavior).toBe("ask");
  });
  test("SkillManage delete by the owner still asks", () => {
    const tool = createSkillManageTool({ home });
    const subject = (input: Record<string, unknown>) => tool.subject(input as never, "/");
    const del: PermissionRequest = { toolName: "SkillManage", kind: "edit", ...subject({ action: "delete", name: "deploy" }) };
    expect(isStoreSave(del, owner())).toBe(false);
    expect(decide(del, owner()).behavior).toBe("ask");
    expect(decide(del, owner({ confine: true })).behavior).toBe("deny");
    // Positive control: the same tool's create in the same folder is a save.
    const create: PermissionRequest = { toolName: "SkillManage", kind: "edit", ...subject({ action: "create", name: "deploy" }) };
    expect(decide(create, owner())).toEqual({ behavior: "allow" });
  });
  test("plan mode still refuses a store save", () => {
    expect(decide(memory(m), owner({ mode: "plan" }))).toEqual({ behavior: "deny", reason: PLAN_MODE_REASON });
  });
  test("a store folder that is a symlink out of the home is not a store save", async () => {
    await symlink(outside, join(home, "skills"));
    try {
      const req: PermissionRequest = { toolName: "SkillManage", kind: "edit", paths: [join(home, "skills", "x", "SKILL.md")] };
      expect(isStoreSave(req, owner())).toBe(false);
      expect(decide(req, owner()).behavior).toBe("ask");
      expect(decide(req, owner({ confine: true })).behavior).toBe("deny");
    } finally {
      await removeDir(join(home, "skills"));
    }
  });
  test("a file in a store that links out of the home is not a store save", async () => {
    await mkdir(join(home, "agents"), { recursive: true });
    await symlink(join(outside, "x.md"), join(home, "agents", "evil.md"));
    expect(isStoreSave({ toolName: "AgentManage", kind: "edit", paths: [join(home, "agents", "evil.md")] }, owner())).toBe(false);
  });
});

describe("decide — destructive exec", () => {
  const remove: PermissionRequest = { toolName: "TroposSetup", kind: "exec", paths: [], target: "setup:plugin.remove", destructive: true };
  test("removing what can't be brought back always asks: no allow rule or autonomy level approves it, and no rule is offered", () => {
    expect(decide(remove, ctx({ allow: ["TroposSetup"] }))).toEqual({ behavior: "ask", reason: "This can't be undone." });
    expect(decide(remove, { ...ctx({ allow: ["TroposSetup(setup:plugin.remove)"] }), autonomy: { level: "autonomous", testCommands: [] } })).toEqual({ behavior: "ask", reason: "This can't be undone." });
    expect(decide({ ...remove, destructive: false }, ctx({ allow: ["TroposSetup"] })).behavior).toBe("allow");
  });
  test("a deny rule still wins", () => {
    expect(decide(remove, ctx({ deny: ["TroposSetup"] })).behavior).toBe("deny");
  });
});

describe("decide — autonomy", () => {
  const auto =(level: Autonomy, testCommands: string[] = [], over: Parameters<typeof ctx>[0] = {}): PermissionContext => ({
    ...ctx(over),
    autonomy: { level, testCommands },
  });
  // Pinned tests take only paths that exist inside the project, so this one is on disk.
  let proj: string;
  beforeAll(async () => {
    proj = await makeTmpDir();
    await mkdir(join(proj, "src"));
    await writeFile(join(proj, "src", "a.test.ts"), "");
  });
  afterAll(() => removeDir(proj));

  test("ask changes nothing", () => expect(decide(edit("/work/app/src/a.ts"), auto("ask")).behavior).toBe("ask"));
  test("balanced: project edits run, test manifests and git control files ask", () => {
    expect(decide(edit("/work/app/src/a.ts"), auto("balanced"))).toEqual({ behavior: "allow" });
    expect(decide(edit("/work/app/packages/x/package.json"), auto("balanced")).behavior).toBe("ask");
    expect(decide(edit("/work/app/.git/hooks/pre-commit"), auto("autonomous")).behavior).toBe("ask");
    expect(decide(edit("/elsewhere/a.ts"), auto("autonomous")).behavior).toBe("ask");
  });
  test("autonomous: test manifests run too", () => expect(decide(edit("/work/app/package.json"), auto("autonomous"))).toEqual({ behavior: "allow" }));
  test("balanced: read-only commands and pinned tests run; installs, deletions and unknown commands ask", () => {
    expect(decide(bash("git status && rg foo src"), auto("balanced"))).toEqual({ behavior: "allow" });
    const inProj = { cwd: proj, allowedDirs: [proj] };
    expect(decide(bash("bun test src/a.test.ts"), auto("balanced", ["bun test"], inProj))).toEqual({ behavior: "allow" });
    expect(decide(bash("bun test"), auto("balanced")).behavior).toBe("ask");
    expect(decide(bash("npm install left-pad"), auto("balanced")).behavior).toBe("ask");
    expect(decide(bash("rm -rf build"), auto("balanced")).behavior).toBe("ask");
  });
  test("balanced: a pinned test is matched against the project, so a path that isn't there asks", () => {
    const inProj = { cwd: proj, allowedDirs: [proj] };
    expect(decide(bash("bun test src/missing.test.ts"), auto("balanced", ["bun test"], inProj)).behavior).toBe("ask");
    expect(decide(bash("bun test && git status"), auto("balanced", ["bun test"], inProj))).toEqual({ behavior: "allow" });
  });
  test("balanced: a read-only command that reaches outside the project asks", () => {
    expect(decide(bash("cat ~/.ssh/id_rsa"), auto("balanced")).behavior).toBe("ask");
    expect(decide(bash("ls /etc"), auto("balanced")).behavior).toBe("ask");
  });
  test("balanced: a command the parser can't model asks", () => {
    expect(decide(bash("cat $(echo a.ts)"), auto("balanced")).behavior).toBe("ask");
  });
  test("autonomous: any Bash runs; MCP and other exec tools still ask", () => {
    expect(decide(bash("npm install left-pad && rm -rf build"), auto("autonomous"))).toEqual({ behavior: "allow" });
    expect(decide({ toolName: "mcp__gh__x", kind: "exec", paths: [] }, auto("autonomous", [], { ask: ["mcp__*"] })).behavior).toBe("ask");
    expect(decide({ toolName: "mcp__gh__x", kind: "exec", paths: [] }, auto("autonomous")).behavior).toBe("ask");
    expect(decide({ toolName: "Cron", kind: "exec", paths: [] }, auto("autonomous")).behavior).toBe("ask");
  });
  test("deny rules, the user's ask rules and plan mode still win", () => {
    expect(decide(bash("rm x"), auto("autonomous", [], { deny: ["Bash(rm:*)"] })).behavior).toBe("deny");
    expect(decide(bash("git status"), auto("balanced", [], { ask: ["Bash(git:*)"] })).behavior).toBe("ask");
    expect(decide(edit("/work/app/a.ts"), auto("autonomous", [], { mode: "plan" })).behavior).toBe("deny");
  });
  test("confinement still denies paths outside the workspace", () => {
    expect(decide(edit("/home/u/.bashrc"), auto("autonomous", [], { confine: true })).behavior).toBe("deny");
  });
  test("balanced: relative paths resolve from the shell's working directory, inside the project", () => {
    const inSrc = (command: string): PermissionRequest => ({ ...bash(command), cwd: "/work/app/src" });
    expect(decide(inSrc("cat ../package.json"), auto("balanced"))).toEqual({ behavior: "allow" });
    expect(decide(inSrc("cat ../../outside"), auto("balanced")).behavior).toBe("ask");
    // From the project root the same word climbs out.
    expect(decide(bash("cat ../package.json"), auto("balanced")).behavior).toBe("ask");
    // A shell somewhere outside the project never counts as inside.
    expect(decide({ ...bash("cat a.ts"), cwd: "/elsewhere" }, auto("balanced")).behavior).toBe("ask");
  });
  test("balanced: a search that names a folder beside the project asks", () => {
    expect(decide(bash("rg x ../other"), auto("balanced")).behavior).toBe("ask");
  });
  test("the project's own Tropos settings (hooks run from them) ask at every level", () => {
    for (const path of ["/work/app/.tropos/settings.json", "/work/app/.tropos/settings.local.json", "/work/app/pkg/.tropos/settings.json"]) {
      expect(decide(edit(path), auto("autonomous")).behavior).toBe("ask");
      expect(decide(write(path), auto("balanced")).behavior).toBe("ask");
    }
    expect(decide(edit("/work/app/.tropos/TROPOS.md"), auto("balanced"))).toEqual({ behavior: "allow" });
  });
  test("isProjectSettingsFile folds names the way the filesystem compares them", () => {
    expect(isProjectSettingsFile("/w/.TROPOS/Settings.Json", "darwin")).toBe(true);
    expect(isProjectSettingsFile("/w/.TROPOS/Settings.Json", "linux")).toBe(false);
    expect(isProjectSettingsFile("C:\\w\\.tropos\\settings.local.json. ", "win32")).toBe(true);
    expect(isProjectSettingsFile("/w/settings.json", "linux")).toBe(false);
    expect(isProjectSettingsFile("/w/.tropos/settings.json.bak", "linux")).toBe(false);
  });
  test("saves to Tropos's stores keep their own rule: an owner who asked to be asked is asked", () => {
    const memory: PermissionRequest = { toolName: "Memory", kind: "edit", paths: ["/work/app/notes/MEMORY.md"] };
    const stores = { paths: ["/work/app/notes"], askBeforeSaving: true };
    expect(decide(memory, auto("autonomous", [], { role: "owner", stores })).behavior).toBe("ask");
  });
  test("saves to Tropos's stores keep their own rule: a guest's save inside the project still asks", () => {
    const memory: PermissionRequest = { toolName: "Memory", kind: "edit", paths: ["/work/app/notes/MEMORY.md"] };
    const stores = { paths: ["/work/app/notes"], askBeforeSaving: true };
    expect(decide(memory, auto("autonomous", [], { role: "guest", stores })).behavior).toBe("ask");
  });
});

describe("decide — the chief's own files", () => {
  const ws = "/home/u/.tropos/workspace";
  const own = [`${ws}/USER.md`, `${ws}/memory`];
  const base = { cwd: ws, allowedDirs: [ws], ownFiles: own, allow: ["Edit(**)"] };

  test("a confined session can't read or edit the chief's files", () => {
    const c = ctx({ ...base, confine: true, role: "owner" });
    const d = decide(read(`${ws}/USER.md`), c);
    expect(d).toEqual({ behavior: "deny", reason: `${ws}/USER.md is Tropos's own memory; only its memory tools may use it in this session.` });
    expect(decide({ toolName: "Grep", kind: "read", paths: [`${ws}/memory/2026-10-16.md`] }, c).behavior).toBe("deny");
    expect(decide(edit(`${ws}/USER.md`), c).behavior).toBe("deny");
  });
  test("a guest is denied even unconfined", () => {
    expect(decide(read(`${ws}/USER.md`), ctx({ ...base, role: "guest" })).behavior).toBe("deny");
    expect(decide(read(`${ws}/USER.md`), ctx({ ...base })).behavior).toBe("deny"); // no role: not the owner
  });
  test("the owner's terminal is asked, never auto-allowed by Edit(**) or accept-edits", () => {
    expect(decide(edit(`${ws}/USER.md`), ctx({ ...base, role: "owner" })).behavior).toBe("ask");
    expect(decide(edit(`${ws}/memory/x.md`), ctx({ ...base, mode: "acceptEdits", role: "owner" })).behavior).toBe("ask");
    expect(decide(read(`${ws}/USER.md`), ctx({ ...base, role: "owner" }))).toEqual({ behavior: "ask", reason: `Tropos's own file: ${ws}/USER.md` });
    expect(decide(edit(`${ws}/USER.md`), ctx({ ...base, role: "owner", autonomy: { level: "autonomous", testCommands: [] } })).behavior).toBe("ask");
  });
  test("a case variant on a case-insensitive disk is the same file", () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    expect(decide(read(`${ws}/user.md`), ctx({ ...base, confine: true, role: "owner" })).behavior).toBe("deny");
  });
  test("bypass lets the owner through; a deny rule and confinement still win", () => {
    expect(decide(edit(`${ws}/USER.md`), ctx({ ...base, role: "owner", mode: "bypass" })).behavior).toBe("allow");
    expect(decide(edit(`${ws}/USER.md`), ctx({ ...base, role: "guest", mode: "bypass" })).behavior).toBe("deny");
  });
  test("store tools are not affected by the guard", () => {
    const stores = { paths: [`${ws}/USER.md`], askBeforeSaving: false };
    const memory: PermissionRequest = { toolName: "Memory", kind: "edit", paths: [`${ws}/USER.md`] };
    expect(decide(memory, ctx({ ...base, role: "owner", stores })).behavior).toBe("allow");
  });
  test("other workspace files are untouched by the guard", () => {
    expect(decide(edit(`${ws}/app.ts`), ctx({ ...base, role: "owner" })).behavior).toBe("allow");
    expect(decide(read(`${ws}/app.ts`), ctx({ ...base, confine: true, role: "owner" })).behavior).toBe("allow");
  });
});

describe("decide — instruction files at the chief's workspace root", () => {
  const ws = "/home/u/.tropos/workspace";
  const instructionFiles = ["TROPOS.md", "TROPOS.local.md", "CLAUDE.md", "AGENTS.override.md"].map((n) => `${ws}/${n}`);
  const base = { cwd: ws, allowedDirs: [ws], instructionFiles, allow: ["Edit(**)"] };

  test("a guest, a scheduled run or a session with no role can't write them, whatever the rules or mode", () => {
    for (const name of ["TROPOS.md", "TROPOS.local.md", "CLAUDE.md", "AGENTS.override.md"]) {
      expect(decide(edit(`${ws}/${name}`), ctx({ ...base, role: "guest" }))).toEqual({ behavior: "deny", reason: `${ws}/${name} holds instructions for the owner's sessions; only the owner may change it.` });
    }
    expect(decide(edit(`${ws}/TROPOS.md`), ctx({ ...base, role: "scheduled", autonomy: { level: "autonomous", testCommands: [] } })).behavior).toBe("deny");
    expect(decide(edit(`${ws}/TROPOS.md`), ctx({ ...base, role: "guest", mode: "bypass" })).behavior).toBe("deny");
    expect(decide(edit(`${ws}/CLAUDE.md`), ctx({ ...base })).behavior).toBe("deny");
  });
  test("a path that reaches them through a link (a linked folder, or a file link) is the same file", async () => {
    const root = await makeTmpDir();
    try {
      const real = join(root, "workspace");
      await mkdir(real);
      await writeFile(join(real, "TROPOS.md"), "");
      await symlink(real, join(root, "alias"));
      await symlink(join(real, "TROPOS.md"), join(real, "notes.md"));
      const files = ["TROPOS.md", "TROPOS.local.md", "CLAUDE.md", "AGENTS.override.md"].map((n) => join(real, n));
      const c = ctx({ cwd: real, allowedDirs: [real, join(root, "alias")], instructionFiles: files, allow: ["Edit(**)"], role: "guest" });
      expect(decide(edit(join(root, "alias", "TROPOS.md")), c).behavior).toBe("deny");
      expect(decide(edit(join(root, "alias", "CLAUDE.md")), c).behavior).toBe("deny"); // missing: its real parent decides
      expect(decide(edit(join(real, "notes.md")), c).behavior).toBe("deny");
    } finally {
      await removeDir(root);
    }
  });

  test("reading them is not affected, and the owner writes them as any other file", () => {
    expect(decide(read(`${ws}/TROPOS.md`), ctx({ ...base, role: "guest" })).behavior).toBe("allow");
    expect(decide(edit(`${ws}/TROPOS.md`), ctx({ ...base, role: "owner" })).behavior).toBe("allow");
    expect(decide(edit(`${ws}/sub/TROPOS.md`), ctx({ ...base, role: "guest" })).behavior).toBe("allow");
  });
});
