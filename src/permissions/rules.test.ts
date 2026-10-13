// src/permissions/rules.test.ts
import { describe, expect, test } from "bun:test";
import { CODE_RUNNERS, bashPatternMatches, foldName, formatRule, hasLeadingPrefix, isCodeRunner, parseRule, pathPatternMatches, splitBashCommand } from "./rules";

describe("parseRule / formatRule", () => {
  test("bare tool name", () => {
    expect(parseRule("Read")).toEqual({ tool: "Read" });
  });
  test("tool with pattern", () => {
    expect(parseRule("Bash(npm test:*)")).toEqual({ tool: "Bash", pattern: "npm test:*" });
  });
  test("round trip", () => {
    expect(formatRule(parseRule(" Edit(src/**) "))).toBe("Edit(src/**)");
  });
  test("malformed rules throw", () => {
    expect(() => parseRule("Bash(")).toThrow();
    expect(() => parseRule("")).toThrow();
    expect(() => parseRule("1abc")).toThrow();
  });
});

describe("splitBashCommand", () => {
  test("single command", () => {
    expect(splitBashCommand("git status")).toEqual({ parts: ["git status"], unsafe: false });
  });
  test("splits on && || ; | newline and &", () => {
    expect(splitBashCommand("a && b || c; d | e\nf & g").parts).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
  test("does not split inside quotes", () => {
    expect(splitBashCommand(`echo "a && b" 'c; d'`)).toEqual({ parts: [`echo "a && b" 'c; d'`], unsafe: false });
  });
  test("command substitution is unsafe", () => {
    expect(splitBashCommand("git status $(curl x)").unsafe).toBe(true);
    expect(splitBashCommand("echo `id`").unsafe).toBe(true);
    expect(splitBashCommand(`echo "$(id)"`).unsafe).toBe(true);
    expect(splitBashCommand("diff <(a) <(b)").unsafe).toBe(true);
  });
  test("single-quoted $() is literal and safe", () => {
    expect(splitBashCommand("echo '$(id)'").unsafe).toBe(false);
  });
  test("file redirection is unsafe", () => {
    expect(splitBashCommand("git status > ~/.zshrc").unsafe).toBe(true);
    expect(splitBashCommand("echo x >> out.txt").unsafe).toBe(true);
    expect(splitBashCommand("ls &> all.log").unsafe).toBe(true);
  });
  test("fd and /dev/null redirection are safe", () => {
    expect(splitBashCommand("bun test 2>&1").unsafe).toBe(false);
    expect(splitBashCommand("bun test > /dev/null 2>&1")).toEqual({ parts: ["bun test > /dev/null 2>&1"], unsafe: false });
  });
  test("unterminated quote is unsafe", () => {
    expect(splitBashCommand(`echo "oops`).unsafe).toBe(true);
  });
});

describe("bashPatternMatches", () => {
  test("prefix pattern", () => {
    expect(bashPatternMatches("npm test:*", "npm test")).toBe(true);
    expect(bashPatternMatches("npm test:*", "npm test -- --watch")).toBe(true);
    expect(bashPatternMatches("npm test:*", "npm testing")).toBe(false);
  });
  test("exact pattern with whitespace normalisation", () => {
    expect(bashPatternMatches("git status", "git   status")).toBe(true);
    expect(bashPatternMatches("git status", "git status -s")).toBe(false);
  });
  test("wildcard", () => {
    expect(bashPatternMatches("*", "anything at all")).toBe(true);
  });
});

describe("pathPatternMatches", () => {
  const cwd = "/work/app";
  const home = "/home/u";
  test("relative glob", () => {
    expect(pathPatternMatches("src/**", "/work/app/src/a/b.ts", cwd, home)).toBe(true);
    expect(pathPatternMatches("src/**", "/work/app/test/a.ts", cwd, home)).toBe(false);
  });
  test("plain file", () => {
    expect(pathPatternMatches(".env", "/work/app/.env", cwd, home)).toBe(true);
    expect(pathPatternMatches(".env", "/work/app/.env.local", cwd, home)).toBe(false);
  });
  test("plain directory covers its contents", () => {
    expect(pathPatternMatches("docs", "/work/app/docs/x.md", cwd, home)).toBe(true);
  });
  test("home and absolute patterns", () => {
    expect(pathPatternMatches("~/notes/**", "/home/u/notes/a.md", cwd, home)).toBe(true);
    expect(pathPatternMatches("/etc/**", "/etc/hosts", cwd, home)).toBe(true);
  });
});

describe("splitBashCommand: shell parser differentials (fix round 1)", () => {
  test("ANSI-C and locale quoting ($'...' / $\"...\") is unsafe", () => {
    expect(splitBashCommand(`git status $'\\'' ; rm -rf x #'`).unsafe).toBe(true);
    expect(splitBashCommand(`echo $"x"`).unsafe).toBe(true);
  });
  test("$ quote inside double quotes stays literal and safe", () => {
    expect(splitBashCommand(`echo "$'x'"`).unsafe).toBe(false);
  });
  test("comment at start of a word is unsafe", () => {
    expect(splitBashCommand("git status #'\nrm -rf x").unsafe).toBe(true);
    expect(splitBashCommand("#hello").unsafe).toBe(true);
    expect(splitBashCommand("ls;#x").unsafe).toBe(true);
  });
  test("mid-word # stays safe", () => {
    expect(splitBashCommand("curl http://x/#a").unsafe).toBe(false);
    expect(splitBashCommand("echo a#b").unsafe).toBe(false);
  });
  test("quoted # stays safe", () => {
    expect(splitBashCommand(`echo "#x" '#y'`).unsafe).toBe(false);
  });
  test("any unquoted parenthesis is unsafe", () => {
    expect(splitBashCommand("diff =(ls) b").unsafe).toBe(true);
    expect(splitBashCommand("(cd x && rm y)").unsafe).toBe(true);
    expect(splitBashCommand("ls *(e:'rm -rf x':)").unsafe).toBe(true);
  });
  test("quoted parentheses stay safe", () => {
    expect(splitBashCommand(`echo "(x)"`).unsafe).toBe(false);
    expect(splitBashCommand("echo '(x)'").unsafe).toBe(false);
  });
  test(">& must be followed by only digits or -", () => {
    expect(splitBashCommand("git status >&2/../../.zshrc").unsafe).toBe(true);
    expect(splitBashCommand("git status >&2x").unsafe).toBe(true);
    expect(splitBashCommand("git status >&file").unsafe).toBe(true);
    expect(splitBashCommand("bun test 2>&1").unsafe).toBe(false);
    expect(splitBashCommand("bun test >&-").unsafe).toBe(false);
    expect(splitBashCommand("bun test > /dev/null 2>&1").unsafe).toBe(false);
  });
  test(">& word stops at a control operator", () => {
    expect(splitBashCommand("git status >&2;ls")).toEqual({ parts: ["git status >&2", "ls"], unsafe: false });
  });
});

describe("pathPatternMatches: hardening (fix round 1)", () => {
  const cwd = "/work/app";
  const home = "/home/u";
  test("normalizes .. segments in the candidate path", () => {
    expect(pathPatternMatches("src/**", "/work/app/src/../../etc/passwd", cwd, home)).toBe(false);
  });
  test("cwd containing glob characters", () => {
    const bracketCwd = "/work/[app]";
    expect(pathPatternMatches(".env", "/work/[app]/.env", bracketCwd, home)).toBe(true);
    expect(pathPatternMatches("src/**", "/work/[app]/src/a.ts", bracketCwd, home)).toBe(true);
    expect(pathPatternMatches("src/**", "/work/a/src/a.ts", bracketCwd, home)).toBe(false);
  });
  test("case folding is off by default", () => {
    expect(pathPatternMatches(".env", "/work/app/.ENV", cwd, home)).toBe(false);
  });
});

describe("splitBashCommand: heredocs and herestrings (fix round 2)", () => {
  test("heredoc body with a quote cannot desync the scanner", () => {
    expect(splitBashCommand("git status <<X\n'\nX\nrm -rf y\n'").unsafe).toBe(true);
  });
  test("heredoc is unsafe", () => {
    expect(splitBashCommand("cat <<EOF\nhi\nEOF").unsafe).toBe(true);
    expect(splitBashCommand("cat <<-EOF\nhi\nEOF").unsafe).toBe(true);
    expect(splitBashCommand("cat <<<hello").unsafe).toBe(true);
  });
  test("single < input redirection stays safe", () => {
    expect(splitBashCommand("bun test < input.txt").unsafe).toBe(false);
  });
  test("quoted << stays safe", () => {
    expect(splitBashCommand(`echo "<<"`).unsafe).toBe(false);
    expect(splitBashCommand("echo '<<'").unsafe).toBe(false);
  });
});

describe("splitBashCommand: escaped redirects (fix round 3)", () => {
  test("escaped \\> followed by & is a plain argument, so the & still splits", () => {
    const { parts, unsafe } = splitBashCommand("git status \\>&zz1");
    expect(parts).toContain("zz1");
    expect(unsafe).toBe(false);
  });
  test("other escaped-redirect shapes also split", () => {
    expect(splitBashCommand("git status [\\>&zz1").parts).toContain("zz1");
    expect(splitBashCommand("git status zz1\\>\\>&zz1").parts).toContain("zz1");
    expect(splitBashCommand("git status <=\\>&zz1").parts).toContain("zz1");
  });
  test("real redirects keep their behavior", () => {
    expect(splitBashCommand("bun test 2>&1")).toEqual({ parts: ["bun test 2>&1"], unsafe: false });
    expect(splitBashCommand("ls &> all.log").unsafe).toBe(true);
  });
});

describe("pathPatternMatches: relative rules stay in cwd and folding is opt-in (fix round 3)", () => {
  const cwd = "/work/app";
  const home = "/home/u";
  test("relative patterns never match outside cwd", () => {
    expect(pathPatternMatches("**", "/etc/hosts", cwd, home)).toBe(false);
    expect(pathPatternMatches("src/**", "/work/other/src/a.ts", cwd, home)).toBe(false);
    expect(pathPatternMatches("../other/**", "/work/other/x", cwd, home)).toBe(false);
    expect(pathPatternMatches("../secret", "/work/secret", cwd, home)).toBe(false);
  });
  test("relative patterns still match inside cwd", () => {
    expect(pathPatternMatches("**", "/work/app/x", cwd, home)).toBe(true);
  });
});

describe("pathPatternMatches: restrict mode (fix round 4)", () => {
  const cwd = "/work/app";
  const home = "/home/u";
  const folds = process.platform === "darwin" || process.platform === "win32";
  test("allow rules never match a climbing relative pattern outside cwd", () => {
    expect(pathPatternMatches("../secrets/**", "/work/secrets/a", cwd, home)).toBe(false);
    expect(pathPatternMatches("../secrets/**", "/work/secrets/a", cwd, home, { restrict: false })).toBe(false);
  });
  test("restrict rules match a climbing relative pattern outside cwd", () => {
    expect(pathPatternMatches("../secrets/**", "/work/secrets/a", cwd, home, { restrict: true })).toBe(true);
    expect(pathPatternMatches("../secrets", "/work/secrets/a", cwd, home, { restrict: true })).toBe(true);
    expect(pathPatternMatches("../secrets/**", "/work/other/a", cwd, home, { restrict: true })).toBe(false);
  });
  test("restrict still matches inside cwd", () => {
    expect(pathPatternMatches("src/**", "/work/app/src/a", cwd, home, { restrict: true })).toBe(true);
    expect(pathPatternMatches(".env", "/work/app/.env", cwd, home, { restrict: true })).toBe(true);
  });
  test("restrict folds case on darwin/win32 only, on both sides including cwd scope", () => {
    expect(pathPatternMatches(".env", "/WORK/APP/.env", cwd, home, { restrict: true })).toBe(folds);
    expect(pathPatternMatches(".env", "/work/app/.ENV", cwd, home, { restrict: true })).toBe(folds);
    expect(pathPatternMatches("src/**", "/work/APP/src/a", cwd, home, { restrict: true })).toBe(folds);
    expect(pathPatternMatches("/Work/App/src/**", "/work/app/SRC/a", cwd, home, { restrict: true })).toBe(folds);
  });
  test("default (allow) never folds case", () => {
    expect(pathPatternMatches(".env", "/work/app/.ENV", cwd, home)).toBe(false);
    expect(pathPatternMatches(".env", "/WORK/APP/.env", cwd, home)).toBe(false);
    expect(pathPatternMatches("src/**", "/work/app/SRC/a.ts", cwd, home)).toBe(false);
    expect(pathPatternMatches(".env", "/work/app/.ENV", cwd, home, { restrict: false })).toBe(false);
  });
});

describe("bashPatternMatches: restrict mode strips wrappers (fix round 4)", () => {
  const r = { restrict: true };
  test.each([
    "command rm -rf x",
    "x= rm -rf x",
    'FOO=1 BAR="a b" rm x',
    "env -i FOO=1 rm x",
    "- rm x",
    "nohup rm x",
    "exec rm x",
    "builtin rm x",
    "noglob rm x",
    "time rm x",
    "env -u HOME -- rm x",
    "command exec nohup env FOO=1 rm x",
    "rm x",
  ])("restrict: rm:* matches %s", (cmd) => {
    expect(bashPatternMatches("rm:*", cmd, r)).toBe(true);
  });
  test("without restrict wrappers are not stripped", () => {
    expect(bashPatternMatches("rm:*", "command rm -rf x")).toBe(false);
    expect(bashPatternMatches("rm:*", "FOO=1 rm x", { restrict: false })).toBe(false);
    expect(bashPatternMatches("rm:*", "env -i FOO=1 rm x")).toBe(false);
  });
  test("restrict does not over-match unrelated commands", () => {
    expect(bashPatternMatches("rm:*", "command rmdir x", r)).toBe(false);
    expect(bashPatternMatches("rm:*", "FOO=rm echo x", r)).toBe(false);
    expect(bashPatternMatches("rm:*", "echo rm x", r)).toBe(false);
  });
  test("exact patterns also see through wrappers in restrict mode", () => {
    expect(bashPatternMatches("git push", "env GIT_X=1 git push", r)).toBe(true);
  });
});

describe("splitBashCommand: fd duplication, continuations, dynamic first words (fix round 4)", () => {
  test("<& is an fd duplication, not a background operator", () => {
    expect(splitBashCommand("git status <&0")).toEqual({ parts: ["git status <&0"], unsafe: false });
    expect(splitBashCommand("git status <&-")).toEqual({ parts: ["git status <&-"], unsafe: false });
  });
  test("<&WORD with a non-fd word is unsafe", () => {
    expect(splitBashCommand("git status <&file").unsafe).toBe(true);
    expect(splitBashCommand("git status <&2x").unsafe).toBe(true);
  });
  test("a word hidden behind &<& is never silently safe", () => {
    const { parts, unsafe } = splitBashCommand("git status &<&-zz2");
    expect(unsafe || parts.some((p) => p.split(/\s+/)[0] === "zz2")).toBe(true);
  });
  test("backslash-newline continuation is unsafe", () => {
    expect(splitBashCommand("git status \\\nzz1").unsafe).toBe(true);
    expect(splitBashCommand("r\\\nm x").unsafe).toBe(true);
  });
  test("escaped backslash before newline is not a continuation", () => {
    expect(splitBashCommand("echo a\\\\\nls").unsafe).toBe(false);
  });
  test("a first word containing $ or a backslash is unsafe", () => {
    expect(splitBashCommand("$2zz1").unsafe).toBe(true);
    expect(splitBashCommand("$CMD arg").unsafe).toBe(true);
    expect(splitBashCommand("\\rm x").unsafe).toBe(true);
    expect(splitBashCommand("FOO=1 $CMD x").unsafe).toBe(true);
    expect(splitBashCommand("ls && $CMD x").unsafe).toBe(true);
  });
  test("$ or backslash outside the first word stays safe", () => {
    expect(splitBashCommand("echo $HOME").unsafe).toBe(false);
    expect(splitBashCommand("FOO=$BAR git status").unsafe).toBe(false);
    expect(splitBashCommand("echo a\\ b").unsafe).toBe(false);
  });
});

describe("wrappers, reserved words and unmodelled command words (fix round 5)", () => {
  const r = { restrict: true };
  const unsafe = (c: string) => splitBashCommand(c).unsafe;

  test.each([
    `"rm" x`,
    `'rm' x`,
    `r''m x`,
    `/bin/r[m] x`,
    `r? x`,
    `{rm,x}`,
    `env -S 'rm x'`,
    `env -iS 'rm x'`,
    `env --split-string='rm x'`,
    `command $CMD x`,
    `env $CMD x`,
    `nohup \\rm x`,
    `! rm x`,
    `{ rm x; }`,
    `if true; then rm x; fi`,
    `while true; do rm x; done`,
    `for f in a; do rm x; done`,
    `[[ -f x ]] && rm x`,
    `sudo --weird rm x`,
    `sudo -i rm x`,
    `sudo -u $U rm x`,
    `nice -n $N rm x`,
    `timeout abc rm x`,
    `timeout $T rm x`,
    `command -v rm`,
    `nohup -x rm`,
    `=rm x`,
  ])("unsafe: %s", (cmd) => {
    expect(unsafe(cmd)).toBe(true);
  });

  test.each([
    "command -p rm x",
    "command -- rm x",
    "time -p rm x",
    "exec -a foo rm x",
    "exec -c rm x",
    "exec -cl rm x",
    "env -iu A rm x",
    "env -u A rm x",
    "env -uA rm x",
    "env --unset A -- rm x",
    "sudo -u root rm x",
    "sudo -g wheel -n rm x",
    "sudo -- rm x",
    "doas -u root rm x",
    "xargs -n 1 rm",
    "xargs -0 -I{} rm {}",
    "timeout 5 rm x",
    "timeout -s KILL 5s rm x",
    "nice -n 10 rm x",
    "nice -10 rm x",
    "ionice -c 3 rm x",
    "stdbuf -oL rm x",
    "setsid rm x",
    "caffeinate -i rm x",
    "unbuffer rm x",
    "sudo nice -n 1 timeout 5 env A=1 rm x",
  ])("modelled wrapper is safe and restrict-matches rm:*: %s", (cmd) => {
    expect(unsafe(cmd)).toBe(false);
    expect(bashPatternMatches("rm:*", cmd, r)).toBe(true);
    expect(bashPatternMatches("rm:*", cmd)).toBe(false);
  });

  test.each([`"rm" x`, `'rm' x`, `r''m x`, `\\rm x`, `"command" "rm" x`, `sudo "rm" x`])(
    "restrict strips quotes from the command word: %s",
    (cmd) => {
      expect(bashPatternMatches("rm:*", cmd, r)).toBe(true);
      expect(bashPatternMatches("rm:*", cmd)).toBe(false);
    },
  );

  test("wrappers do not over-match", () => {
    expect(bashPatternMatches("rm:*", "sudo -u root rmdir x", r)).toBe(false);
    expect(bashPatternMatches("rm:*", "timeout 5 echo rm", r)).toBe(false);
    expect(bashPatternMatches("rm:*", "sudo -u rm echo x", r)).toBe(false);
  });

  test("regressions stay safe", () => {
    for (const c of ["git status", "bun test 2>&1", "echo $HOME", "FOO=$BAR git status", "/bin/ls -la", "echo if", "echo '{x}'", "~/bin/tool a"]) {
      expect(unsafe(c)).toBe(false);
    }
  });
});

describe("leading redirects, eval/shell -c and path-qualified wrappers (carry-over fix)", () => {
  const r = { restrict: true };
  const unsafe = (c: string) => splitBashCommand(c).unsafe;

  test.each([
    "2>&1 rm x",
    ">/dev/null rm x",
    "</dev/null rm x",
    "FOO=1 2>&1 rm x",
    "sudo 2>&1 rm x",
    "> /dev/null rm x",
    "&>/dev/null rm x",
    "2>&1 >/dev/null FOO=1 rm x",
  ])("safe leading redirects are skipped: rm:* restrict-matches %s", (cmd) => {
    expect(unsafe(cmd)).toBe(false);
    expect(bashPatternMatches("rm:*", cmd, r)).toBe(true);
    expect(bashPatternMatches("rm:*", cmd)).toBe(false);
  });

  test.each([">file rm x", "> file rm x", "<file rm x", "2>err.log rm x", "sudo >file rm x"])(
    "unsafe leading redirect stays unsafe: %s",
    (cmd) => {
      expect(unsafe(cmd)).toBe(true);
    },
  );

  test("leading safe redirects do not over-match", () => {
    expect(bashPatternMatches("rm:*", "2>&1 echo rm x", r)).toBe(false);
    expect(bashPatternMatches("rm:*", ">/dev/null rmdir x", r)).toBe(false);
  });

  test.each([
    "eval rm x",
    "source x.sh",
    ". ./x.sh",
    "sh -c 'rm x'",
    `bash -c "rm x"`,
    "/bin/zsh -c 'rm x'",
    "dash -c 'rm x'",
    "ksh -c 'rm x'",
    "fish -c 'rm x'",
    "bash -lc 'rm x'",
    "bash -x -c 'rm x'",
    "sudo bash -c 'rm x'",
    "FOO=1 eval rm x",
    "command eval rm x",
  ])("unsafe: %s", (cmd) => {
    expect(unsafe(cmd)).toBe(true);
  });

  test.each(["bash script.sh", "sh ./build.sh --verbose", "/bin/bash script.sh arg", "./x.sh", "echo eval", "echo source x", "ls ."])(
    "stays safe: %s",
    (cmd) => {
      expect(unsafe(cmd)).toBe(false);
    },
  );

  test("path-qualified wrappers are recognised by basename", () => {
    expect(unsafe("/usr/bin/sudo rm x")).toBe(false);
    expect(bashPatternMatches("rm:*", "/usr/bin/sudo rm x", r)).toBe(true);
    expect(unsafe("/usr/bin/env FOO=1 rm x")).toBe(false);
    expect(bashPatternMatches("rm:*", "/usr/bin/env FOO=1 rm x", r)).toBe(true);
    expect(unsafe("/usr/bin/env -S 'rm x'")).toBe(true);
    expect(unsafe("/usr/bin/sudo --weird rm x")).toBe(true);
    expect(bashPatternMatches("rm:*", "/usr/bin/sudo rm x")).toBe(false);
  });
});

describe("shell -c attached values and code runners (fix round 1)", () => {
  const unsafe = (c: string) => splitBashCommand(c).unsafe;

  test.each([`bash -c'rm x'`, `bash -c"rm x"`, `sh -ec'x'`, `bash -c rm`, `zsh -xc 'rm x'`])("attached -c value is unsafe: %s", (cmd) => {
    expect(unsafe(cmd)).toBe(true);
  });

  test("CODE_RUNNERS lists interpreters and wrappers", () => {
    for (const w of ["sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", ".", "python", "python3", "node", "deno", "perl", "ruby", "php", "npx", "bunx", "pnpx", "uvx", "sudo", "doas", "env", "timeout", "nohup", "nice", "ionice", "stdbuf", "setsid", "caffeinate", "unbuffer", "command", "builtin", "exec", "xargs", "time"]) {
      expect(CODE_RUNNERS.has(w)).toBe(true);
    }
    expect(CODE_RUNNERS.has("git")).toBe(false);
  });

  test.each(["sh", "bash script.sh", "python3 x.py", "sudo ls", "/usr/bin/python3 x.py", "FOO=1 node x.js", "2>&1 perl x.pl", "env FOO=1 ls", "xargs rm", "npx tool"])(
    "the wildcard does not allow-match %s",
    (cmd) => {
      expect(bashPatternMatches("*", cmd)).toBe(false);
    },
  );

  test("prefix patterns do not allow-match code runners", () => {
    expect(bashPatternMatches("python:*", "python x.py")).toBe(false);
    expect(bashPatternMatches("python:*", "python")).toBe(false);
    expect(bashPatternMatches("bash:*", "bash script.sh")).toBe(false);
    expect(bashPatternMatches("sudo:*", "sudo ls")).toBe(false);
  });

  test("exact patterns still match code runners", () => {
    expect(bashPatternMatches("python x.py", "python x.py")).toBe(true);
    expect(bashPatternMatches("bash script.sh", "bash  script.sh")).toBe(true);
  });

  test("ordinary commands still match the wildcard and prefixes", () => {
    expect(bashPatternMatches("*", "ls -la")).toBe(true);
    expect(bashPatternMatches("*", "2>&1 ls")).toBe(true);
    expect(bashPatternMatches("git:*", "git status")).toBe(true);
  });

  test("restrict (deny/ask) matching is unaffected", () => {
    const r = { restrict: true };
    expect(bashPatternMatches("*", "sh", r)).toBe(true);
    expect(bashPatternMatches("python:*", "python x.py", r)).toBe(true);
    expect(bashPatternMatches("sudo:*", "sudo ls", r)).toBe(true);
    expect(bashPatternMatches("rm:*", "sudo rm x", r)).toBe(true);
  });

  test("hasLeadingPrefix detects assignments, redirects and wrappers", () => {
    expect(hasLeadingPrefix("FOO=1 git status")).toBe(true);
    expect(hasLeadingPrefix("2>&1 rm x")).toBe(true);
    expect(hasLeadingPrefix("sudo -u root ls")).toBe(true);
    expect(hasLeadingPrefix("git status")).toBe(false);
    expect(hasLeadingPrefix("python3 x.py")).toBe(false);
  });
});

describe("code-runner detection: more interpreters, versions and case (fix round 3)", () => {
  test("CODE_RUNNERS includes the extra interpreters but not everyday build tools", () => {
    for (const w of ["awk", "gawk", "mawk", "nawk", "python2", "pypy", "pypy3", "ipython", "pwsh", "powershell", "osascript", "lua", "luajit", "tclsh", "wish", "Rscript", "irb", "jshell", "expect", "ssh", "script", "nodejs", "tsx", "ts-node"]) {
      expect(CODE_RUNNERS.has(w)).toBe(true);
    }
    for (const w of ["bun", "npm", "pnpm", "yarn", "make"]) expect(CODE_RUNNERS.has(w)).toBe(false);
  });

  test.each(["python3.12 x.py", "nodejs x.js", "ruby3.3 x.rb", "node22 x.js", "perl5.34 x.pl", "awk '{print}' f", "ssh host ls", "tsx a.ts", "/usr/bin/python3.12 x.py", "Rscript x.R", "ts-node a.ts"])(
    "the wildcard does not allow-match %s",
    (cmd) => {
      expect(bashPatternMatches("*", cmd)).toBe(false);
    },
  );

  test("case is folded only on case-insensitive platforms", () => {
    const folding = process.platform === "darwin" || process.platform === "win32";
    expect(bashPatternMatches("*", "PYTHON3 x.py")).toBe(!folding);
    expect(isCodeRunner("PYTHON3")).toBe(folding);
    expect(isCodeRunner("rscript")).toBe(folding);
  });

  test.each(["bun test", "npm run build", "make", "git status", "pnpm install", "yarn build"])("the wildcard still matches %s", (cmd) => {
    expect(bashPatternMatches("*", cmd)).toBe(true);
  });

  test("everyday prefix rules still work", () => {
    expect(bashPatternMatches("bun test:*", "bun test x")).toBe(true);
    expect(bashPatternMatches("git:*", "git2 x")).toBe(false);
  });

  test("isCodeRunner handles paths and version suffixes", () => {
    expect(isCodeRunner("/usr/local/bin/python3.12")).toBe(true);
    expect(isCodeRunner("python3.12")).toBe(true);
    expect(isCodeRunner("git")).toBe(false);
    expect(isCodeRunner("")).toBe(false);
    expect(isCodeRunner("7")).toBe(false);
  });

  test("restrict matching is unaffected", () => {
    expect(bashPatternMatches("*", "python3.12 x.py", { restrict: true })).toBe(true);
  });
});

describe("final review fixes", () => {
  test("restrict mode reduces a path-qualified command word to its basename; allow mode does not", () => {
    for (const cmd of ["/bin/rm -rf x", "./rm -rf x", "sudo /bin/rm -rf x", "'/bin/rm' x"]) {
      expect(bashPatternMatches("rm:*", cmd, { restrict: true })).toBe(true);
      expect(bashPatternMatches("rm:*", cmd)).toBe(false);
    }
  });
  test("noglob and nocorrect are code runners and wrappers", () => {
    expect(bashPatternMatches("*", "noglob python3 -c x")).toBe(false);
    expect(bashPatternMatches("*", "nocorrect sh s.sh")).toBe(false);
    expect(bashPatternMatches("rm:*", "nocorrect rm x", { restrict: true })).toBe(true);
  });
  test("only shell whitespace is normalised before matching", () => {
    expect(bashPatternMatches("git status:*", "git status")).toBe(false);
    expect(bashPatternMatches("git status:*", "git \t status -s")).toBe(true);
  });
});

describe("restrict matching folds the command word's case", () => {
  const folding = process.platform === "darwin" || process.platform === "win32";
  test.each(["RM x", "Rm -rf x", "/BIN/RM x", "/bin/Rm x", "sudo RM x", "'RM' x", "SUDO rm x", "Command RM x"])("a deny rule for rm catches %s on case-insensitive platforms", (cmd) => {
    expect(bashPatternMatches("rm:*", cmd, { restrict: true })).toBe(folding);
  });
  test("an upper-case rule word matches a lower-case command on case-insensitive platforms", () => {
    expect(bashPatternMatches("Rscript:*", "rscript x.R", { restrict: true })).toBe(folding);
    expect(bashPatternMatches("RM -rf x", "rm -rf x", { restrict: true })).toBe(folding);
  });
  test("only the command word is folded, and allow rules never fold", () => {
    expect(bashPatternMatches("git push --force", "GIT push --force", { restrict: true })).toBe(folding);
    expect(bashPatternMatches("git push --force", "git push --FORCE", { restrict: true })).toBe(false);
    expect(bashPatternMatches("rm:*", "RM x")).toBe(false);
  });
});

describe("names fold the way APFS compares them", () => {
  const folding = process.platform === "darwin" || process.platform === "win32";
  test("foldName applies full Unicode case folding on case-insensitive platforms", () => {
    expect(foldName("\u017fh")).toBe(folding ? "sh" : "\u017fh");
    expect(foldName("\u212aill")).toBe(folding ? "kill" : "\u212aill");
    expect(foldName("\ufb06race")).toBe(folding ? "strace" : "\ufb06race");
    expect(foldName("RM")).toBe(folding ? "rm" : "RM");
    expect(foldName("\u017fh", false)).toBe("\u017fh");
    expect(foldName("\u017fh", true)).toBe("sh");
  });
  test("deny rules catch long-s, Kelvin-sign and ligature spellings", () => {
    expect(bashPatternMatches("sh:*", "\u017fh x", { restrict: true })).toBe(folding);
    expect(bashPatternMatches("kill:*", "\u212aill 1", { restrict: true })).toBe(folding);
    expect(bashPatternMatches("sudo:*", "\u017fudo ls", { restrict: true })).toBe(folding);
    expect(bashPatternMatches("rm:*", "\u017fudo rm x", { restrict: true })).toBe(folding);
    expect(bashPatternMatches("strace:*", "\ufb06race ls", { restrict: true })).toBe(folding);
  });
  test("the wildcard allow rule never approves a folded spelling of a code runner", () => {
    for (const cmd of ["\u017fh -c x", "ba\u017fh x.sh", "\u017fudo ls", "BASH x.sh"]) {
      expect(bashPatternMatches("*", cmd)).toBe(!folding);
    }
  });
  test("deny path rules catch folded spellings", () => {
    expect(pathPatternMatches("secrets/**", "/w/\u017fecrets/a", "/w", "/h", { restrict: true })).toBe(folding);
    expect(pathPatternMatches("secrets/**", "/w/\u017fecrets/a", "/w", "/h")).toBe(false);
  });
});

describe("deny rules for wrapper commands", () => {
  const folding = process.platform === "darwin" || process.platform === "win32";
  test.each(["sudo ls", "/usr/bin/sudo ls", "FOO=1 sudo ls", "env sudo ls", "'sudo' ls", "nice /usr/bin/sudo -u root ls"])(
    "Bash(sudo:*) catches %s",
    (cmd) => {
      expect(bashPatternMatches("sudo:*", cmd, { restrict: true })).toBe(true);
    },
  );
  test("folded spellings of a wrapper are caught on case-insensitive platforms", () => {
    expect(bashPatternMatches("sudo:*", "SUDO ls", { restrict: true })).toBe(folding);
    expect(bashPatternMatches("env:*", "nice ENV ls", { restrict: true })).toBe(folding);
  });
  test("the wrapped command is still caught", () => {
    expect(bashPatternMatches("ls:*", "/usr/bin/sudo -u root ls -la", { restrict: true })).toBe(true);
    expect(bashPatternMatches("ls:*", "sudo ls", {})).toBe(false);
  });
});
