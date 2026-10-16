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

describe("isReadOnlyCommand — shell state and git config-driven execution", () => {
  // Builtins that change the shell's own state (variables, PATH lookups, limits, traps, options, cwd stack).
  test.each([
    "printf -v PATH /tmp", "printf -vPATH /tmp", "printf -v x hi", "printf * x", "export PATH=/tmp", "read x", "set -o noclobber", "alias ls=rm",
    "hash -p /tmp/x ls", "ulimit -n 1", "umask 000", "trap 'rm a' EXIT", "source x", ". x", "eval ls", "exec ls", "builtin cd /",
    "enable -n cd", "shopt -s dotglob", "typeset x=1", "declare x=1", "local x=1", "pushd src", "popd", "history -s rm", "fc -s",
    "unset PATH", "unalias ls", "setopt extendedglob", "unsetopt nomatch", "let x=1", "readonly x", "getopts a x", "bind x",
    "complete -r", "dirs -c", "disown", "kill 1", "shift", "autoload x", "zmodload x", "bindkey x y", "rehash", "emulate sh",
    "functions -c a b", "print -v x hi", "zle x", "vared x",
  ])("refused builtin: %p", (c) => expect(isReadOnlyCommand(c)).toBe(false));
  test.each(["printf hi", "printf '%s\\n' a b", "printf '%s' -v", "printf -- -v", "echo -n hi", "type ls", "which -a ls", "pwd -P"])(
    "allowed: %p",
    (c) => expect(isReadOnlyCommand(c)).toBe(true),
  );
  // --textconv runs the diff driver's program; -c / --config-env can point core.pager or diff.external anywhere.
  test.each(["git show --textconv HEAD:a.bin", "git diff --textconv", "git log -p --textconv", "git blame --textconv a", "git diff --textc",
    "git cat-file --textconv HEAD:a", "git diff --ext-diff", "git diff --ext", "git -c core.pager=sh log", "git -cdiff.external=x diff",
    "git --config-env=core.pager=X log", "git --output=x log", "git log --output=x", "git log --output x", "git log --outp=x"])(
    "refused git: %p",
    (c) => expect(isReadOnlyCommand(c)).toBe(false),
  );
  test.each(["git log -p --output-indicator-new=+", "git diff --output-indicator-old=- --output-indicator-context=' '", "git diff --text",
    "git diff --no-textconv", "git log --no-ext-diff"])("allowed git: %p", (c) => expect(isReadOnlyCommand(c)).toBe(true));
});

describe("isReadOnlyCommand — git options that only exist on some subcommands", () => {
  // `--text` is exact only where the diff options define it; elsewhere getopt reads it as an abbreviation of `--textconv`.
  test.each(["git cat-file --text HEAD:a", "git blame --text a", "git grep --text a", "git log --output-indicator-new=+ --textconv",
    "git cat-file --output-indicator-new=+ HEAD:a", "git blame --output-indicator-new=+ a"])("refused: %p", (c) =>
    expect(isReadOnlyCommand(c)).toBe(false),
  );
  test.each(["git diff --text", "git log -p --text", "git show --text HEAD", "git show --output-indicator-context=' ' HEAD"])("allowed: %p", (c) =>
    expect(isReadOnlyCommand(c)).toBe(true),
  );
});

describe("isReadOnlyCommand — git options that run configured programs", () => {
  // --filters runs clean/smudge drivers; signature checks run gpg.program; %G placeholders verify signatures too.
  test.each([
    "git cat-file --filters HEAD:a", "git cat-file --filt HEAD:a", "git cat-file --textconv HEAD:a", "git cat-file --batch",
    "git cat-file --batch-check", "git cat-file -x HEAD", "git log --show-signature", "git show --show-signature HEAD",
    "git log --show-sig", "git log --format='%G?'", "git log --pretty=format:%GS", "git show -s --format=%GK HEAD", "git log --format=%+GS", "git log --format=%-G?", "git log --format='% GG'", "git shortlog --format=%GG",
    "git verify-commit HEAD", "git verify-tag v1", "git notes show", "git notes add -m x", "git for-each-ref", "git tag -v v1",
    "git difftool", "git archive HEAD",
  ])("refused: %p", (c) => expect(isReadOnlyCommand(c)).toBe(false));
  test.each(["git cat-file -t HEAD", "git cat-file -s HEAD:a", "git cat-file -p HEAD:a", "git cat-file -e HEAD", "git cat-file blob HEAD:a",
    "git log --format=%H", "git log --show-notes", "git log --first-parent", "git branch --show-current"])("allowed: %p", (c) =>
    expect(isReadOnlyCommand(c)).toBe(true),
  );
});
