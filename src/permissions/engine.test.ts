// src/permissions/engine.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { PLAN_MODE_REASON, compileRules, decide, inGitControlDir, suggestRule, type PermissionContext, type PermissionRequest } from "./engine";

const cwd = "/work/app";
function ctx(over: Partial<PermissionContext> & { allow?: string[]; ask?: string[]; deny?: string[] } = {}): PermissionContext {
  const { rules } = compileRules({ allow: over.allow ?? [], ask: over.ask ?? [], deny: over.deny ?? [] });
  return { mode: over.mode ?? "default", rules, cwd, home: "/home/u", allowedDirs: over.allowedDirs ?? [cwd] };
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
