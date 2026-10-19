// test/install/workflow-policy.test.ts
// R4.1: no code from the release tag runs where the signing key or a write token is available (spec §6.2).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../helpers/tmp";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = {
  permissions?: Record<string, string> | string;
  environment?: string;
  steps: Step[];
  container?: unknown;
  needs?: string | string[];
  env?: Record<string, string>;
  strategy?: unknown;
  "runs-on"?: string;
};
type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> };

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");
const text = (name: string) => readFile(join(WORKFLOWS, name), "utf8");
const load = async (name: string) => Bun.YAML.parse(await text(name)) as Workflow;
const PRIVILEGED = ["release.yml", "promote.yml", "channels-health.yml"];
const ALL = ["release-build.yml", ...PRIVILEGED, "ci.yml"];
const writes = (j: Job) => typeof j.permissions === "object" && Object.values(j.permissions).includes("write");
/** Jobs that hold a write token or a protected environment's secrets (release-signing, channels-write). */
const privileged = (j: Job) => writes(j) || j.environment !== undefined;
const runs = (j: Job) => j.steps.map((s) => s.run ?? "").join("\n");
const needsOf = (j: Job) => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);
const MAIN_CHECK = /^\s*'?\[ "\$GITHUB_REF" = "refs\/heads\/main" \]/;
const CHANNELS_REPO = "Tropos-AI/tropos-code-channels";

/** Shell builtins and syntax that run nothing by themselves. */
const BUILTINS = ["[", "echo", "exit", ":", "read", "for", "case", "umask"];

/**
 * The simple commands of a run script, each as "<command> <args…>" with quoted strings replaced by Q:
 * command substitutions become commands of their own; comments, keywords, assignments and redirections are dropped.
 * Scripts in policed jobs are kept simple enough for this. Anything it cannot see through — a nested `$(`, arithmetic
 * `$((`, backticks, process substitution `<(` / `>(`, or a heredoc — makes it throw, so the allow-list fails closed.
 */
function commandsOf(run: string): string[] {
  const out: string[] = [];
  let text = run
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  text = text.replace(/\$\(([^()]*)\)/g, (_m, inner: string) => {
    out.push(...commandsOf(inner));
    return "SUBST";
  });
  const opaque = /`|<\(|>\(|\$\(\(|\$\(|<</.exec(text);
  if (opaque) throw new Error(`run script has ${JSON.stringify(opaque[0])} the policy parser cannot see through: ${run}`);
  text = text.replace(/'[^']*'/g, "Q").replace(/"(?:[^"\\]|\\.)*"/g, "Q");
  text = text.replace(/^\s*(?:Q|[*\w./\\-]+)(?:\s*\|\s*(?:Q|[*\w./\\-]+))*\)\s*/gm, ""); // case patterns
  for (const seg of text.split(/;;|;|&&|\|\||\||\n|\{|\}|\bthen\b|\belse\b|\bdo\b/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^(if|elif|while|until|!|fi|done|esac)$/.test(words[0]!) || /^[A-Za-z_]\w*=/.test(words[0]!) || /^[0-9]*[<>]/.test(words[0]!))) words.shift();
    if (words.length) out.push(words.join(" "));
  }
  return out;
}

const MANIFEST_AWK = /^awk -v want=[a-z0-9-]+ -f scripts\/release\/manifest\.awk [\w./-]+( > \/dev\/null)?$/;
const MAIN_GUARD = { "[": true, echo: true, exit: true } as const;
/** Per job: command name → allowed (true) or the exact shapes allowed. Every policed job must be listed here. */
const ALLOW: Record<string, Record<string, true | RegExp[]>> = {
  "release.yml:prepare": {
    ...MAIN_GUARD,
    bun: [/^bun install --frozen-lockfile$/, /^bun scripts\/release\/check-provenance\.ts --out release-inputs\.zip >> Q$/, /^bun scripts\/release\/check-provenance\.ts --verify-inputs inputs$/, /^bun -e Q$/, /^bun scripts\/release\/notes\.ts Q notes\/release-notes\.md$/],
    sudo: [/^sudo apt-get install -y zstd unzip$/],
    mkdir: [/^mkdir (inputs|assets|notes)$/],
    unzip: [/^unzip -Z1 release-inputs\.zip >zip-names$/, /^unzip -Z release-inputs\.zip >zip-listing$/, /^unzip -q release-inputs\.zip -d inputs$/],
    read: true,
    case: true,
    for: true,
    grep: [/^grep -q Q zip-listing$/],
    cp: [/^cp Q Q$/, /^cp inputs\/install\.sh assets\/install\.sh$/],
    zstd: [/^zstd -19 --check -q -o Q Q$/, /^zstd -d -q -c Q >Q$/],
    cmp: [/^cmp Q Q$/],
    rm: [/^rm -f assets\/\.roundtrip$/],
    sh: [/^sh scripts\/release\/make-manifest\.sh Q Q Q assets > assets\/manifest\.json$/],
    date: [/^date -u \+%Y-%m-%dT%H:%M:%SZ$/],
    tr: [/^tr -d Q <assets\/manifest\.json >manifest\.bad$/, /^tr -d Q$/],
    tail: [/^tail -c 1 assets\/manifest\.json$/],
    od: [/^od -An -c$/],
    awk: [MANIFEST_AWK],
  },
  "release.yml:sign": {
    "[": true,
    echo: true,
    exit: true,
    umask: [/^umask 077$/],
    grep: [/^grep -Eq Q release\/allowed_signers$/],
    tr: [/^tr -d Q <to-sign\/manifest\.json >Q$/, /^tr -d Q$/],
    tail: [/^tail -c 1 to-sign\/manifest\.json$/],
    od: [/^od -An -c$/],
    awk: [MANIFEST_AWK],
    printf: [/^printf Q Q > Q$/],
    "ssh-keygen": [/^ssh-keygen -Y sign -f Q -n tropos-(manifest|installer) to-sign\/(manifest\.json|install\.sh)$/, /^ssh-keygen -Y verify -f release\/allowed_signers -I tropos-release -n tropos-(manifest|installer) -s to-sign\/(manifest\.json|install\.sh)\.sig < to-sign\/(manifest\.json|install\.sh)$/],
    rm: [/^rm -f Q$/],
  },
  "release.yml:draft": { "[": true, echo: true, exit: true, gh: [/^gh release (view|create|upload) /] },
  "release.yml:fetch-draft": { gh: [/^gh release download Q --repo Q --dir draft$/] },
  "release.yml:publish": { gh: [/^gh release edit Q --repo Q --draft=false --latest=false$/] },
  "release.yml:promote-latest": { ...MAIN_GUARD, bun: [/^bun scripts\/release\/promote\.ts latest Q$/] },
  "promote.yml:promote-stable": { ...MAIN_GUARD, bun: [/^bun scripts\/release\/promote\.ts stable Q$/] },
  "channels-health.yml:repair": { ...MAIN_GUARD, bun: [/^bun scripts\/release\/promote\.ts check --repair$/] },
};

describe("workflow policy (R4.1)", () => {
  test.each(ALL)("%s pins every action by full commit SHA", async (name) => {
    const wf = await load(name);
    for (const job of Object.values(wf.jobs)) for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  test("the workflows directory holds exactly the policed workflows", async () => {
    expect((await readdir(WORKFLOWS)).sort()).toEqual([...ALL].sort());
  });

  test.each(PRIVILEGED)("%s only runs from main and never on push or pull_request", async (name) => {
    const wf = await load(name);
    expect(Object.keys(wf.on).sort().every((t) => ["workflow_run", "workflow_dispatch", "schedule"].includes(t))).toBe(true);
    expect(wf.permissions).toEqual({});
  });

  test.each(PRIVILEGED)("every job in %s refuses refs other than main, itself or through a job it needs", async (name) => {
    const wf = await load(name);
    const guarded = (jobName: string, seen: Set<string> = new Set()): boolean => {
      if (seen.has(jobName)) return false;
      seen.add(jobName);
      const job = wf.jobs[jobName]!;
      if (MAIN_CHECK.test(job.steps[0]?.run ?? "")) return true;
      return needsOf(job).some((n) => guarded(n, seen));
    };
    for (const jobName of Object.keys(wf.jobs)) expect({ jobName, guarded: guarded(jobName) }).toEqual({ jobName, guarded: true });
    // Jobs that hold channels-write secrets check main themselves, first.
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      if (job.environment === "channels-write") expect({ jobName, first: job.steps[0]?.run }).toMatchObject({ jobName, first: expect.stringMatching(MAIN_CHECK) });
    }
  });

  test("only the sign job sees release-signing; it checks out main's release tooling only and runs no bun", async () => {
    const wf = await load("release.yml");
    const withEnv = Object.entries(wf.jobs).filter(([, j]) => j.environment === "release-signing").map(([n]) => n);
    expect(withEnv).toEqual(["sign"]);
    const sign = wf.jobs.sign!;
    expect(writes(sign)).toBe(false);
    for (const step of sign.steps) {
      // Release binaries are tropos-<os>-<arch>; the principal and namespaces (tropos-release, tropos-manifest, …) are data.
      expect(step.run ?? "").not.toMatch(/\bbun\b|\bnpm\b|\bnpx\b|\bnode\b|\btropos-(darwin|linux)[a-z0-9-]*|\.local\/bin\/tropos|\bsh\s+\S*install\.sh/);
      if (step.uses?.startsWith("actions/checkout@")) {
        expect(step.with?.ref).toBeUndefined();
        expect(String(step.with?.["sparse-checkout"])).toMatch(/scripts\/release/);
      }
    }
  });

  test.each(PRIVILEGED)("in %s, jobs with a write token or a protected environment (and prepare) run only allow-listed commands", async (name) => {
    const wf = await load(name);
    const policed = Object.entries(wf.jobs).filter(([n, j]) => privileged(j) || n === "prepare");
    expect(policed.map(([n]) => `${name}:${n}`).sort()).toEqual(Object.keys(ALLOW).filter((k) => k.startsWith(`${name}:`)).sort());
    for (const [jobName, job] of policed) {
      const allow = ALLOW[`${name}:${jobName}`]!;
      for (const cmd of commandsOf(runs(job))) {
        const rule = allow[cmd.split(" ")[0]!];
        if (rule === undefined || (rule !== true && !rule.some((re) => re.test(cmd)))) throw new Error(`${name}: job ${jobName} runs a command outside its allow-list: ${cmd}`);
      }
    }
  });

  test.each(PRIVILEGED)("in %s, privileged jobs download artifacts only to hand them to gh release (sign excepted, policed above)", async (name) => {
    const wf = await load(name);
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      if (!privileged(job) || jobName === "sign") continue;
      if (!job.steps.some((s) => s.uses?.startsWith("actions/download-artifact@"))) continue;
      const executables = commandsOf(runs(job)).filter((c) => !BUILTINS.includes(c.split(" ")[0]!));
      expect({ jobName, executables: executables.filter((c) => !c.startsWith("gh release ")) }).toEqual({ jobName, executables: [] });
    }
  });

  test.each([
    ["a nested substitution", 'echo "$(sh to-sign/install.sh "$(echo x)")"'],
    ["backticks", "echo `./to-sign/install.sh`"],
    ["process substitution (input)", "echo <(./x)"],
    ["process substitution (output)", "tee >(./x)"],
    ["arithmetic expansion", "echo $(( $(./x) + 1 ))"],
    ["a heredoc", "cat <<EOF\n./x\nEOF"],
  ])("the command parser fails closed on %s", (_what, script) => {
    expect(() => commandsOf(script)).toThrow("the policy parser cannot see through");
  });

  test("the command parser sees through substitutions, quotes, case patterns and redirections", () => {
    expect(commandsOf(`x=$(tail -c 1 f | od -An -c | tr -d ' ')\nif grep -q '^l' a; then echo "a; b"; exit 1; fi\ncase $n in\n  '' | */*) echo no ;;\nesac\nwhile IFS= read -r n; do :; done <f\n./evil.sh && bunx x`)).toEqual([
      "tail -c 1 f",
      "od -An -c",
      "tr -d Q",
      "grep -q Q a",
      "echo Q",
      "exit 1",
      "case $n in",
      "echo no",
      "read -r n",
      ":",
      "./evil.sh",
      "bunx x",
    ]);
  });

  test.each(PRIVILEGED)("%s checks out only the workflow's own commit of main, without persisting the token", async (name) => {
    const wf = await load(name);
    for (const job of Object.values(wf.jobs)) {
      for (const step of job.steps) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        expect(step.with?.ref).toBeUndefined();
        expect(step.with?.repository).toBeUndefined();
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
  });

  test("smoke jobs are read-only and get draft assets from fetch-draft (A12)", async () => {
    const wf = await load("release.yml");
    for (const [n, j] of Object.entries(wf.jobs)) if (n.startsWith("smoke-")) expect(writes(j)).toBe(false);
    expect(writes(wf.jobs["fetch-draft"]!)).toBe(true);
  });

  test("fetch-draft executes nothing: one authenticated download, then an artifact upload", async () => {
    const steps = (await load("release.yml")).jobs["fetch-draft"]!.steps;
    expect(steps.filter((s) => s.run !== undefined).map((s) => s.run!.trim())).toEqual(['gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir draft']);
    expect(steps.filter((s) => s.uses).map((s) => s.uses!.split("@")[0])).toEqual(["actions/upload-artifact"]);
  });

  test("release-build has no write permission and no secrets", async () => {
    const t = await text("release-build.yml");
    expect(t).not.toContain("secrets.");
    expect(t).not.toMatch(/:\s*write/);
  });

  test("release.yml, promote.yml and channels-health.yml share the channels concurrency group without cancelling", async () => {
    for (const name of PRIVILEGED) {
      const wf = (await load(name)) as Workflow & { concurrency?: { group: string; "cancel-in-progress": boolean } };
      expect(wf.concurrency).toEqual({ group: "channels", "cancel-in-progress": false });
    }
  });

  test.each(ALL)("%s never interpolates ${{ }} into a run script; values reach the shell through env", async (name) => {
    const wf = await load(name);
    for (const [jobName, job] of Object.entries(wf.jobs))
      for (const step of job.steps) if (step.run?.includes("${{")) throw new Error(`${name}: job ${jobName} interpolates an expression into run: ${step.run}`);
  });
});

describe("controller rulings (task 28)", () => {
  // Permissions ruling: contents: read on tropos-code everywhere except the jobs that write the draft, publish it,
  // or mark GitHub latest (promote.ts latest and check --repair do that themselves).
  const PERMISSIONS: Record<string, Record<string, Record<string, string>>> = {
    "release.yml": {
      prepare: { contents: "read", actions: "read" },
      sign: { contents: "read" },
      draft: { contents: "write" },
      "fetch-draft": { contents: "write" },
      "smoke-draft-native": { contents: "read" },
      "smoke-draft-musl": { contents: "read" },
      publish: { contents: "write" },
      previous: { contents: "read" },
      "smoke-public-native": { contents: "read" },
      "smoke-public-musl": { contents: "read" },
      "promote-latest": { contents: "write" },
    },
    "promote.yml": { "promote-stable": { contents: "read" } },
    "channels-health.yml": { check: { contents: "read" }, repair: { contents: "write" } },
  };
  const ENVIRONMENTS: Record<string, Record<string, string>> = {
    "release.yml": { sign: "release-signing", "promote-latest": "channels-write" },
    "promote.yml": { "promote-stable": "channels-write" },
    "channels-health.yml": { repair: "channels-write" },
  };
  const SECRETS: Record<string, string> = { "release-signing": "TROPOS_RELEASE_SIGNING_KEY", "channels-write": "CHANNELS_WRITE_TOKEN" };

  test.each(PRIVILEGED)("%s: every job's permissions are exactly the ruled set", async (name) => {
    const wf = await load(name);
    expect(Object.fromEntries(Object.entries(wf.jobs).map(([n, j]) => [n, j.permissions]))).toEqual(PERMISSIONS[name]!);
  });

  test.each(PRIVILEGED)("%s: protected environments are exactly the ruled set, and secrets appear only there", async (name) => {
    const wf = await load(name);
    const envs = Object.fromEntries(Object.entries(wf.jobs).flatMap(([n, j]) => (j.environment === undefined ? [] : [[n, j.environment]])));
    expect(envs).toEqual(ENVIRONMENTS[name]!);
    for (const [n, j] of Object.entries(wf.jobs)) {
      const used = [...new Set([...JSON.stringify(j).matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))];
      expect({ job: n, secrets: used }).toEqual({ job: n, secrets: j.environment ? [SECRETS[j.environment]!] : [] });
    }
  });

  test.each(PRIVILEGED)("%s: every channel write runs in channels-write with the channels repository and token (D1-B)", async (name) => {
    const wf = await load(name);
    let channelWriters = 0;
    for (const [n, j] of Object.entries(wf.jobs)) {
      for (const step of j.steps) {
        if (!/promote\.ts\s+(latest|stable|check\s+--repair)\b/.test(step.run ?? "")) continue;
        channelWriters++;
        const env = { ...j.env, ...step.env };
        expect({ job: n, environment: j.environment, repo: env.CHANNELS_REPOSITORY, token: env.CHANNELS_WRITE_TOKEN }).toEqual({
          job: n,
          environment: "channels-write",
          repo: CHANNELS_REPO,
          token: "${{ secrets.CHANNELS_WRITE_TOKEN }}",
        });
      }
    }
    expect(channelWriters).toBeGreaterThan(0);
  });

  test("promote.yml and channels-health's check hold contents: read; only the jobs that mark GitHub latest hold write", async () => {
    expect((await load("promote.yml")).jobs["promote-stable"]!.permissions).toEqual({ contents: "read" });
    const health = await load("channels-health.yml");
    expect(health.jobs.check!.permissions).toEqual({ contents: "read" });
    expect(runs(health.jobs.check!)).not.toMatch(/--repair/);
    const release = await load("release.yml");
    expect(runs(release.jobs["promote-latest"]!)).toMatch(/promote\.ts latest /);
  });

  test.each(ALL)("%s: no job container — musl jobs run actions on the host and Bun in docker run alpine:3.22 (D2)", async (name) => {
    const wf = await load(name);
    for (const [n, j] of Object.entries(wf.jobs)) {
      expect({ job: n, container: j.container }).toEqual({ job: n, container: undefined });
      if (!n.includes("musl")) continue;
      expect(runs(j)).toMatch(/docker run --rm [^\n]*alpine:3\.22/);
      const strategy = JSON.stringify(j.strategy);
      expect(strategy).toContain('"ubuntu-24.04"');
      expect(strategy).toContain('"ubuntu-24.04-arm"');
      if (/\bbun\b/.test(runs(j))) expect(runs(j)).toContain("https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/");
    }
  });

  test("every musl surface exists: release-build tests, both release smoke stages, CI", async () => {
    const musl = async (name: string) => Object.keys((await load(name)).jobs).filter((n) => n.includes("musl"));
    expect(await musl("release-build.yml")).toEqual(["test-musl"]);
    expect(await musl("release.yml")).toEqual(["smoke-draft-musl", "smoke-public-musl"]);
    expect(await musl("ci.yml")).toEqual(["installer-musl"]);
  });

  test("release.yml runs the manifest byte check before every manifest.awk run (ruling 1)", async () => {
    const wf = await load("release.yml");
    let checked = 0;
    for (const [n, j] of Object.entries(wf.jobs)) {
      for (const step of j.steps) {
        const lines = (step.run ?? "").split("\n");
        lines.forEach((line, i) => {
          if (!line.includes("manifest.awk") || line.trim().startsWith("#")) return;
          const file = /manifest\.awk\s+"?([^\s">]+)"?/.exec(line)?.[1];
          expect({ job: n, file }).toEqual({ job: n, file: expect.any(String) });
          const before = lines.slice(0, i);
          const tr = before.map((l) => new RegExp(`LC_ALL=C tr -d '\\\\012\\\\040-\\\\176' <"?${file!.replace(/[.$]/g, "\\$&")}"? >"?([^\\s"]+)"? \\|\\| exit 1`).exec(l)).find(Boolean);
          expect({ job: n, file, tr: Boolean(tr) }).toEqual({ job: n, file, tr: true });
          const bad = tr![1]!;
          expect(before.some((l) => l.includes(`[ ! -s "${bad}" ]`) && /\|\|\s*\{?\s*echo .*exit 1/.test(l))).toBe(true);
          checked++;
        });
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2); // prepare and sign
  });

  test("prepare unzips into a fresh directory behind the zip-slip guard, then verifies inputs, then writes the manifest (ruling 2)", async () => {
    const steps = (await load("release.yml")).jobs.prepare!.steps;
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s.run ?? ""));
    const unpack = at(/unzip -Z1 release-inputs\.zip/);
    const verify = at(/bun scripts\/release\/check-provenance\.ts --verify-inputs inputs\b/);
    const manifest = at(/make-manifest\.sh/);
    expect(unpack).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(unpack);
    expect(manifest).toBeGreaterThan(verify);
    expect(steps[unpack]!.run).toMatch(/^mkdir inputs$/m);
  });

  test("release-build collects assets from the repo root into a fresh directory and never test-builds (ruling 3)", async () => {
    const build = (await load("release-build.yml")).jobs.build!;
    const lines = runs(build).split("\n");
    const collect = lines.findIndex((l) => l.trim() === 'sh scripts/release/collect-assets.sh dist "${GITHUB_REF_NAME#v}" release-inputs');
    expect(collect).toBeGreaterThan(0);
    expect(lines.slice(0, collect).some((l) => l.trim() === "mkdir release-inputs")).toBe(true);
    expect(runs(build)).not.toMatch(/\bcd\b/);
    for (const s of build.steps) expect((s as Record<string, unknown>)["working-directory"]).toBeUndefined();
    for (const name of ["release-build.yml", "release.yml"]) expect(await text(name)).not.toContain("--test-build");
  });

  test.each([...PRIVILEGED, "release-build.yml"])("%s: setup-bun never uses its executable cache and never holds the token (fix 1)", async (name) => {
    const wf = await load(name);
    let seen = 0;
    for (const [n, j] of Object.entries(wf.jobs)) {
      for (const step of j.steps) {
        if (!step.uses?.startsWith("oven-sh/setup-bun@")) continue;
        seen++;
        expect({ job: n, with: step.with }).toEqual({ job: n, with: { "bun-version": "1.4.0", "no-cache": true, token: "" } });
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test.each(["release-build.yml", "ci.yml"])("%s: every musl Bun zip is checked against its pinned sha256 before unzip (fix 2)", async (name) => {
    const BUN_ZIP_SHA256: Record<string, string> = {
      "bun-linux-x64-musl": "83b5f12fd258dd8d4fdcaea65ede954366aa717dab399e20093ecab280d54e7a",
      "bun-linux-aarch64-musl": "576300ce33ff16ffcd455bf178c2f095f9df845c6cc3d0284ba1c96ca0e80473",
    };
    const wf = await load(name);
    let downloads = 0;
    for (const [n, j] of Object.entries(wf.jobs)) {
      const include = ((j.strategy as { matrix?: { include?: Array<Record<string, string>> } } | undefined)?.matrix?.include ?? []).filter((e) => e.bunzip);
      for (const e of include) expect({ job: n, zip: e.bunzip, sha: e.bunsha }).toEqual({ job: n, zip: e.bunzip!, sha: BUN_ZIP_SHA256[e.bunzip!]! });
      for (const step of j.steps) {
        const lines = (step.run ?? "").split("\n");
        lines.forEach((line, i) => {
          if (!/oven-sh\/bun\/releases\/download\/.*\.zip/.test(line)) return;
          downloads++;
          const check = lines.findIndex((l) => l.trim() === `printf '%s  %s\\n' "$BUNSHA" "$RUNNER_TEMP/bun.zip" | sha256sum -c -`);
          const unzip = lines.findIndex((l) => /^\s*unzip\b/.test(l));
          expect({ job: n, ordered: i < check && check < unzip, env: step.env?.BUNSHA }).toEqual({ job: n, ordered: true, env: "${{ matrix.bunsha }}" });
        });
      }
    }
    expect(downloads).toBeGreaterThan(0);
  });

  test("prepare's only inline code is the manifest parser from main's src/install/manifest (fix 4)", async () => {
    const lines = runs((await load("release.yml")).jobs.prepare!).split("\n").filter((l) => /\bbun -e\b/.test(l));
    expect(lines.map((l) => l.trim())).toEqual([`bun -e 'import { parseManifest } from "./src/install/manifest"; parseManifest(new Uint8Array(await Bun.file("assets/manifest.json").arrayBuffer()))'`]);
  });

  test("release.yml keeps the spec's stage order and never marks a release latest before promotion (fix 5)", async () => {
    const wf = await load("release.yml");
    expect((wf.jobs.prepare as Job & { if?: string }).if).toBe("github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'");
    expect(Object.fromEntries(Object.entries(wf.jobs).map(([n, j]) => [n, needsOf(j)]))).toEqual({
      prepare: [],
      sign: ["prepare"],
      draft: ["prepare", "sign"],
      "fetch-draft": ["prepare", "draft"],
      "smoke-draft-native": ["prepare", "fetch-draft"],
      "smoke-draft-musl": ["prepare", "fetch-draft"],
      publish: ["prepare", "smoke-draft-native", "smoke-draft-musl"],
      previous: ["prepare", "publish"],
      "smoke-public-native": ["prepare", "previous"],
      "smoke-public-musl": ["prepare", "previous"],
      "promote-latest": ["prepare", "smoke-public-native", "smoke-public-musl"],
    });
    const cmds = (job: string) => commandsOf(runs(wf.jobs[job]!));
    expect(cmds("draft").filter((c) => c.startsWith("gh release create "))).toEqual([expect.stringMatching(/ --draft --latest=false /)]);
    expect(cmds("publish")).toEqual([expect.stringMatching(/ --draft=false --latest=false$/)]);
  });

  test.each(PRIVILEGED)("%s: job and step conditions are exactly the ruled ones, and nothing continues on error (re-review)", async (name) => {
    const IFS: Record<string, Record<string, string | undefined>> = {
      "release.yml": { prepare: "github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'" },
      "promote.yml": {},
      "channels-health.yml": { check: "github.event_name == 'schedule' || !inputs.repair", repair: "github.event_name == 'workflow_dispatch' && inputs.repair" },
    };
    // Only the remove-the-key step (always) and the optional public gates b and c are conditional.
    const STEP_IFS: Record<string, string> = {
      "Remove the key file": "always()",
      "b) the published installer verifies the new release": "needs.previous.outputs.installer_tag != ''",
      "c) the stable binary installs the new release": "needs.previous.outputs.stable != ''",
    };
    const wf = await load(name);
    for (const [n, j] of Object.entries(wf.jobs) as Array<[string, Job & { if?: string; "continue-on-error"?: unknown }]>) {
      expect({ job: n, if: j.if, continueOnError: j["continue-on-error"] }).toEqual({ job: n, if: IFS[name]![n], continueOnError: undefined });
      for (const step of j.steps as Array<Step & { if?: string; "continue-on-error"?: unknown }>) {
        expect({ job: n, step: step.name, if: step.if, continueOnError: step["continue-on-error"] }).toEqual({
          job: n,
          step: step.name,
          if: step.name ? STEP_IFS[step.name] : undefined,
          continueOnError: undefined,
        });
      }
    }
  });

  test.each(PRIVILEGED)("%s uses only the four first-party actions, each at its pinned commit (re-review)", async (name) => {
    const ACTIONS: Record<string, string> = {
      "actions/checkout": "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
      "oven-sh/setup-bun": "0c5077e51419868618aeaa5fe8019c62421857d6",
      "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    };
    const wf = await load(name);
    for (const [n, j] of Object.entries(wf.jobs)) {
      for (const step of j.steps) {
        if (step.uses === undefined) continue;
        const [action, sha] = step.uses.split("@");
        expect({ job: n, action, sha }).toEqual({ job: n, action: action!, sha: ACTIONS[action!] ?? "not allowed in a privileged workflow" });
      }
    }
  });

  test("ci.yml keeps the shellcheck step and covers collect-assets.sh (ruling 4)", async () => {
    const wf = await load("ci.yml");
    const all = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => (s.run ?? "").trim()));
    expect(all).toContain("shellcheck -s sh install.sh scripts/release/make-manifest.sh scripts/release/collect-assets.sh");
  });

  test("release.yml documents that the channels repository must stay public where previous/smoke c read it (ruling 5)", async () => {
    const t = await text("release.yml");
    expect(t.match(/Tropos-AI\/tropos-code-channels must stay public/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

/** A stored (uncompressed) zip; `symlink` entries carry Unix mode 0120777 like `zip --symlinks` writes. */
function makeZip(entries: Array<{ name: string; data: string; symlink?: boolean }>): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.data);
    const crc = Bun.hash.crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 10, true);
    lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    local.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, (3 << 8) | 20, true);
    ch.setUint16(6, 10, true);
    ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(38, ((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...local, ...central, new Uint8Array(end.buffer)]));
}

describe.skipIf(!Bun.which("unzip"))("the prepare job's zip-slip guard (ruling 2)", () => {
  const INPUTS = ["install.sh", "SHA256SUMS", ...["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl"].map((p) => `tropos-${p}`)];
  let dir: string;
  afterEach(() => removeDir(dir));

  const guard = async () => {
    const steps = (await load("release.yml")).jobs.prepare!.steps;
    return steps.find((s) => /unzip -Z1 release-inputs\.zip/.test(s.run ?? ""))!.run!;
  };
  const runGuard = async (zip: Uint8Array, opts: { existingInputs?: boolean } = {}) => {
    dir = await makeTmpDir("tropos-zipslip-");
    const work = join(dir, "work");
    await mkdir(work);
    await writeFile(join(work, "release-inputs.zip"), zip);
    if (opts.existingInputs) await mkdir(join(work, "inputs"));
    const p = Bun.spawnSync(["sh", "-e", "-c", await guard()], { cwd: work, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: `${p.stdout}${p.stderr}`, work };
  };
  const good = () => INPUTS.map((name) => ({ name, data: `${name}\n` }));

  test("unpacks a well-formed archive into inputs/", async () => {
    const r = await runGuard(makeZip(good()));
    expect(r.code).toBe(0);
    expect((await readdir(join(r.work, "inputs"))).sort()).toEqual([...INPUTS].sort());
  });

  test.each([
    ["a parent-directory entry", { name: "../evil", data: "x" }],
    ["an absolute path", { name: "/tmp/evil", data: "x" }],
    ["a nested path", { name: "sub/tropos-linux-x64", data: "x" }],
    ["a backslash path", { name: "..\\evil", data: "x" }],
    ["a symlink", { name: "tropos-linux-x64", data: "/etc/passwd", symlink: true }],
  ])("refuses %s before extracting anything", async (_what, entry) => {
    const r = await runGuard(makeZip([...good().filter((e) => e.name !== entry.name), entry]));
    expect(r.code).not.toBe(0);
    expect(await readdir(join(r.work, "inputs"))).toEqual([]);
    expect(await Bun.file(join(dir, "evil")).exists()).toBe(false);
  });

  test("refuses to unpack into a directory that already exists", async () => {
    const r = await runGuard(makeZip(good()), { existingInputs: true });
    expect(r.code).not.toBe(0);
    expect(await readdir(join(r.work, "inputs"))).toEqual([]);
  });
});

describe("release.yml draft: only gh's \"release not found\" counts as no release (M1)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeDir(d);
  });

  /** Runs the draft step as Actions does (bash -e -o pipefail) against a stub gh that logs its calls. */
  const runDraft = async (view: { out: string; code: number }) => {
    const dir = await makeTmpDir("tropos-draft-");
    dirs.push(dir);
    const step = (await load("release.yml")).jobs.draft!.steps.find((st) => st.run !== undefined)!;
    await mkdir(join(dir, "bin"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "manifest.json"), "{}\n");
    const stub = `#!/bin/sh\necho "$*" >> "${join(dir, "calls")}"\nif [ "$2" = view ]; then\n  if [ "$VIEW_CODE" = 0 ]; then printf '%s\\n' "$VIEW_OUT"; else printf '%s\\n' "$VIEW_OUT" >&2; fi\n  exit "$VIEW_CODE"\nfi\n`;
    await writeFile(join(dir, "bin", "gh"), stub, { mode: 0o755 });
    const p = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], {
      cwd: dir,
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, TAG: "v1.0.0", GITHUB_REPOSITORY: "Tropos-AI/tropos-code", VIEW_OUT: view.out, VIEW_CODE: String(view.code) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const calls = (await Bun.file(join(dir, "calls")).text()).trim().split("\n").map((c) => c.split(" ").slice(0, 2).join(" "));
    return { code: p.exitCode, calls, stderr: p.stderr.toString() };
  };

  test("a missing release is created as a draft", async () => {
    expect(await runDraft({ out: "release not found", code: 1 })).toMatchObject({ code: 0, calls: ["release view", "release create"] });
  });

  test.each([
    ["an API outage", "HTTP 502: Bad Gateway (https://api.github.com/graphql)"],
    ["bad credentials", "HTTP 401: Bad credentials (https://api.github.com/graphql)"],
    ["a rate limit", "API rate limit exceeded for installation"],
  ])("%s fails the job and creates nothing", async (_what, out) => {
    const r = await runDraft({ out, code: 1 });
    expect(r.code).not.toBe(0);
    expect(r.calls).toEqual(["release view"]);
    expect(r.stderr).toContain(out);
  });

  test("an existing draft is completed; a published release is left alone; anything else fails", async () => {
    expect(await runDraft({ out: "true", code: 0 })).toMatchObject({ code: 0, calls: ["release view", "release upload"] });
    expect(await runDraft({ out: "false", code: 0 })).toMatchObject({ code: 0, calls: ["release view"] });
    expect((await runDraft({ out: "maybe", code: 0 })).code).not.toBe(0);
  });
});
