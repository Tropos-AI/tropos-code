// src/permissions/readonly.test.ts
import { describe, expect, test } from "bun:test";
import { isReadOnlyCommand, pathsStayInside } from "./readonly";

const READ_ONLY = ["ls", "ls -la src", "cat README.md", "head -n 20 a.ts | wc -l", "rg -n TODO src", "grep -rn foo .",
  "git status", "git status --short", "git diff HEAD~1 -- src", "git log --oneline -20", "git show HEAD:package.json",
  "git --no-pager log -5", "git branch -a", "git rev-parse --abbrev-ref HEAD", "git ls-files", "git blame src/a.ts",
  "pwd", "echo hi", "wc -l src/*.ts", "find src -name '*.ts'", "fd test", "cd src && ls", "tree -L 2", "git diff 2>&1",
  "ls >/dev/null 2>&1", "sort a.txt | uniq -c", "jq .version package.json", "stat package.json", "du -sh src", "which bun", "diff a.txt b.txt"];
const NOT_READ_ONLY = ["", "rm a", "touch a", "echo hi > a.txt", "cat a >> b", "git commit -m x", "git push", "git checkout main",
  "git branch -D old", "git branch new", "git -c core.pager=sh log", "git -C /tmp status", "git diff --output=/tmp/x",
  "git log --ext-diff", "git stash", "git config user.name x", "find . -delete", "find . -exec rm {} ;", "find . -fprint out",
  "fd -x rm", "rg --pre ./x foo", "sort -o out a", "sort --output=out a", "uniq a b", "tree -o out", "sed -i s/a/b/ f",
  "awk '{print}' f", "xargs rm", "env ls", "FOO=1 ls", "ls $(pwd)", "ls `pwd`", "cat <<EOF\nx\nEOF", "echo $HOME", "./ls",
  "/bin/ls", "bash -c ls", "python -c 'print(1)'", "npm test", "bun test", "curl https://example.com", "ls; rm a",
  "cat a | tee b", "date -s 2020-01-01", "git diff *", "less a"];
test.each(READ_ONLY)("read-only: %p", (c) => expect(isReadOnlyCommand(c)).toBe(true));
test.each(NOT_READ_ONLY)("not read-only: %p", (c) => expect(isReadOnlyCommand(c)).toBe(false));
test("pathsStayInside", () => {
  const ok = (c: string) => pathsStayInside(c, "/w/app", "/home/u", ["/w/app"]);
  expect(ok("cat src/a.ts")).toBe(true);
  expect(ok("cat /w/app/a.ts")).toBe(true);
  expect(ok("ls >/dev/null")).toBe(true);
  expect(ok("cat ~/.ssh/id_rsa")).toBe(false);
  expect(ok("ls /etc")).toBe(false);
  expect(ok("rg x ../other")).toBe(false);
});

describe("isReadOnlyCommand — options the shell or getopt can disguise", () => {
  // getopt_long accepts any unique prefix of a long option: `sort --out=x` writes x.
  test.each(["sort --out=x a", "sort --co=gzip a", "date --se=2020-01-01", "git diff --outp=/tmp/x", "git log --ext", "rg --pre=./x foo",
    "fd --exec rm", "fd --exec-batch rm", "file --compile -m x"])("abbreviated long option: %p", (c) => expect(isReadOnlyCommand(c)).toBe(false));
  // Short options bundle: `-ro out` is `-r -o out`.
  test.each(["sort -ro out a", "sort -oout a", "fd -Hx rm", "fd -X rm", "tree -ao out", "tree -R", "date -us 2020", "file -C -m x",
    "git grep -O vim x", "git grep -nOvim x"])("bundled short option: %p", (c) => expect(isReadOnlyCommand(c)).toBe(false));
  test.each(["find . '-delete'", 'find . "-exec" rm {} +', "find . -del\\ete", "sort '-o' out a", "git status '--output=x'"])(
    "quoted forbidden option: %p",
    (c) => expect(isReadOnlyCommand(c)).toBe(false),
  );
  // Brace expansion turns `{-o,x}` into `-o x`; a glob can expand to a file named like an option.
  test.each(["sort {-o,out} a", "git status {--output=x,}", "find . {-delete,}", "sort * ", "fd ?", "find [a] -name x", "uniq *", "file *",
    "git log ^main"])("expansion that can yield an option: %p", (c) => expect(isReadOnlyCommand(c)).toBe(false));
  test.each(["uniq - out", "uniq -- -c out", "date 0101", "date 202001010000", "git remote show origin", "git tag v1", "git tag -l 'v*'",
    "git reflog expire", "git worktree add x", "git stash pop", "git branch --list x", "git", "git --no-pager", "git -p log",
    "git --git-dir=/x log", "git st"])("refused form: %p", (c) => expect(isReadOnlyCommand(c)).toBe(false));
  test.each(["sort -rn a", "uniq -c a", "date", "date +%Y-%m-%d", "date -u +%s", "tree", "fd -e ts", "rg --pretty x", "file a.png",
    "git remote", "git remote -v", "git tag", "git tag -l", "git stash list", "git stash show -p", "git reflog", "git reflog show",
    "git worktree list", "git -P diff", "git branch --show-current", "git branch -vv --no-color", "git log --no-ext-diff",
    "git grep -n foo", "cat <a.txt", "ls 2>/dev/null", "ls &>/dev/null", "echo hi >&2", "cat a b | sort | uniq"])(
    "allowed: %p",
    (c) => expect(isReadOnlyCommand(c)).toBe(true),
  );
});

describe("isReadOnlyCommand — redirects and command words", () => {
  test.each(["ls > /dev/null", "ls 1>&2", "ls >>/dev/null", "echo hi>a.txt", "cat <a>b", "cat <", "cat <>/dev/null", ">/dev/null ls",
    "<a.txt cat", "LS", "'ls'", "l\\s", "ls -la", "cat '$x'", "time ls", "command ls", "nice ls", "git;"])("refused: %p", (c) =>
    expect(isReadOnlyCommand(c)).toBe(false),
  );
});

describe("pathsStayInside — escapes", () => {
  const ok = (c: string) => pathsStayInside(c, "/w/app", "/home/u", ["/w/app"]);
  test.each([
    "cat ~root/.ssh/id_rsa", "cat ~+/x", "cat ~-/x", "cat ~", "cat <../x", "cat </etc/passwd", "ls 2>/tmp/x", "rg --file=/etc/x y",
    "rg -f/etc/x y", "rg --file=~/x y", "rg --glob=../x y", "cat src/../../x", "cat {/etc,x}/passwd", "cat {..,x}/y", "cat .?/x",
    "cat .*/x", "cat [.][.]/x", "cat =ls", "cat $HOME/x", "cat `pwd`/x", "cd && cat .ssh/id_rsa", "cd", "cd -", "cd -P", "cd ~",
    "cd +1", "cd app other", "cd .. && ls", "cd /etc", "cd ''", "cat $(pwd)", "/bin/cat a",
  ])("refused: %p", (c) => expect(ok(c)).toBe(false));
  test.each([
    "ls", "", "cat a.ts b.ts", "cat src/*.ts", "cat ./src/a.ts", "cat src/../a.ts", "cd src/deep && ls",
    "rg --glob=src/x y", "rg -n TODO src", "ls 2>&1", "ls >&2", "ls &>/dev/null", "cat <src/a.ts", "git diff HEAD~1..HEAD -- src",
    "git show HEAD:package.json", "cat /w/app", "cat /w/app/./src/../a.ts", "ls > /dev/null",
  ])("stays inside: %p", (c) => expect(ok(c)).toBe(true));
  test("after a cd, `..` must stay inside from every directory the shell can be in", () => {
    // The cd may fail (`;`, `||`), so both the old and the new directory count; this errs towards asking.
    expect(ok("cd src && cat ../../x")).toBe(false);
    expect(ok("cd src && cat ../a.ts")).toBe(false);
    expect(ok("cd src && cat a.ts")).toBe(true);
  });
  test("a cwd outside the allowed directories makes every relative word escape", () => {
    expect(pathsStayInside("cat a", "/elsewhere", "/home/u", ["/w/app"])).toBe(false);
  });
  test("`~user` is refused even when the process runs inside the project", () => {
    // Left unexpanded, `~root/x` would resolve against the process's own directory.
    const here = process.cwd();
    expect(pathsStayInside("cat ~root/.ssh/id_rsa", here, "/home/u", [here])).toBe(false);
    expect(pathsStayInside("cat ~+/x", here, "/home/u", [here])).toBe(false);
  });
  test("any allowed directory will do", () => {
    expect(pathsStayInside("cat /w/lib/a.ts", "/w/app", "/home/u", ["/w/app", "/w/lib"])).toBe(true);
  });
});
