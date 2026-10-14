// test/install/helpers/sh-runner.ts
// Runs a test copy of install.sh in a sandbox: PATH holds only links to the tools we allow (or shims),
// and the pinned-key and release-url blocks are replaced. The production script itself has no overrides.
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir } from "../../helpers/tmp";

export const INSTALL_SH = join(import.meta.dir, "../../../install.sh");

const TOOLS = ["sh", "awk", "curl", "wget", "cp", "chmod", "rm", "mktemp", "uname", "od", "tail", "wc", "tr", "cat", "grep", "sleep", "id", "basename", "sha256sum", "shasum", "ssh-keygen", "zstd", "ldd", "sysctl", "stty", "env", "printf", "ls", "perl"];

export const SHELLS: string[][] = [["sh"], ["dash"], ["bash", "--posix"], ["busybox", "ash"]].filter((s) => {
  if (!Bun.which(s[0]!)) return false;
  return s[0] !== "busybox" || Bun.spawnSync(["busybox", "ash", "-c", "true"]).exitCode === 0;
});

export function replaceBlock(text: string, name: string, body: string): string {
  const start = `# >>> ${name}`;
  const end = `# <<< ${name}`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < i) throw new Error(`install.sh has no ${name} block`);
  const lineEnd = text.indexOf("\n", i);
  return `${text.slice(0, lineEnd + 1)}${body}\n  ${text.slice(j)}`;
}

export function blockOf(text: string, name: string): string {
  const i = text.indexOf(`# >>> ${name}`);
  const j = text.indexOf(`# <<< ${name}`);
  return text.slice(text.indexOf("\n", i) + 1, j).replace(/\n\s*$/, "");
}

/** The fake tcode the installer hands off to: records its arguments and exits with $FAKE_EXIT. */
export function handoffBinary(version = "1.0.0"): string {
  // The final comment line lets the zstd corpus flip a byte without breaking the script.
  return `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Tropos Code)"; exit 0; fi\necho "$*" > "$HOME/handoff"\n[ -n "$FAKE_SIGNAL" ] && kill -9 $$\nexit \${FAKE_EXIT:-0}\n# zzzz\n`;
}

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  dir: string;
  home: string;
  bin: string;
  script: string;
  run(args?: string[], opts?: { env?: Record<string, string>; shell?: string[] }): Promise<ShResult>;
}

export async function makeSandbox(opts: { signers: string; base: string; shell?: string[]; hide?: string[]; shims?: Record<string, string>; home?: string }): Promise<Sandbox> {
  const dir = await makeTmpDir("tropos-sh-");
  const bin = join(dir, "bin");
  const home = opts.home ? join(dir, opts.home) : join(dir, "home");
  await mkdir(bin);
  await mkdir(home, { recursive: true });
  for (const tool of TOOLS) {
    if (opts.hide?.includes(tool)) continue;
    const real = Bun.which(tool);
    if (real) await symlink(real, join(bin, tool));
  }
  for (const [name, body] of Object.entries(opts.shims ?? {})) {
    await Bun.$`rm -f ${join(bin, name)}`;
    await writeFile(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }
  let text = await readFile(INSTALL_SH, "utf8");
  text = replaceBlock(text, "pinned-key", `  TROPOS_ALLOWED_SIGNERS='${opts.signers}'`);
  text = replaceBlock(
    text,
    "release-urls",
    `  TROPOS_RELEASES='${opts.base}/t/r/releases'\n  TROPOS_CHANNELS='${opts.base}/t/r/releases/download/channels'\n  TROPOS_PROTO='=http,https'`,
  );
  const script = join(dir, "install.sh");
  await writeFile(script, text);
  return {
    dir,
    home,
    bin,
    script,
    async run(args = [], runOpts = {}) {
      const shell = runOpts.shell ?? opts.shell ?? ["sh"];
      const shellPath = Bun.which(shell[0]!)!;
      const proc = Bun.spawn([shellPath, ...shell.slice(1), script, ...args], {
        cwd: dir,
        env: { PATH: bin, HOME: home, SHELL: "/bin/zsh", ...runOpts.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    },
  };
}
