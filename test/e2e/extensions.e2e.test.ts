// test/e2e/extensions.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockApi, type MockResponse } from "../helpers/mock-api";
import { makeTmpDir, removeDir } from "../helpers/tmp";

let dir: string;
let bin: string;
let home: string;
let project: string;

async function put(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

beforeAll(async () => {
  dir = await makeTmpDir();
  bin = join(dir, "tcode");
  home = join(dir, ".tropos-home");
  project = join(dir, "proj");
  await Bun.$`bun build.ts --outfile ${bin}`.quiet();
  await put(join(project, "notes.txt"), "the release is on friday\n");
  await put(join(project, ".tropos", "commands", "ask.md"), "---\ndescription: Ask about notes\n---\nAnswer $ARGUMENTS using @notes.txt");
  await put(join(home, "skills", "release", "SKILL.md"), "---\ndescription: How we cut a release\n---\nTag, then push.");
  await put(join(home, "agents", "scout.md"), "---\nname: scout\ndescription: Looks things up\ntools: Read\n---\nBe quick.");
  const log = join(dir, "hooks.log");
  await put(
    join(home, "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'hook: be brief'" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo 'no shell in tests' >&2; exit 2" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: `cat >> ${log}` }] }],
      },
    }),
  );
  // A repo trying to add a hook is ignored with a warning.
  await put(join(project, ".tropos", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "touch pwned" }] }] } }));
}, 120_000);
afterAll(() => removeDir(dir));

async function run(args: string[], script: MockResponse[]) {
  const api = startMockApi(script);
  try {
    const proc = Bun.spawn([bin, ...args], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: dir, TROPOS_HOME: home, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code, requests: api.requests };
  } finally {
    api.stop();
  }
}

const text = (t: string): MockResponse => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

describe("extensions through the compiled binary", () => {
  test("skills are listed, hooks add context, repo hooks are refused, SessionEnd runs", async () => {
    const r = await run(["-p", "hi"], [text("ok")]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("ignored hooks");
    const first = JSON.stringify(r.requests[0]!.body.messages[0]);
    expect(first).toContain("- release: How we cut a release");
    expect(first).toContain("hook: be brief");
    expect(r.requests[0]!.body.tools.map((t: { name: string }) => t.name)).toContain("Skill");
    expect(await readFile(join(dir, "hooks.log"), "utf8")).toContain('"reason":"exit"');
    expect(await Bun.file(join(project, "pwned")).exists()).toBe(false);
  });

  test("a custom command expands in print mode", async () => {
    const r = await run(["-p", "/ask when is the release?"], [text("Friday.")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Friday.\n");
    const sent = JSON.stringify(r.requests[0]!.body.messages[0]);
    expect(sent).toContain(`<command name=\\"/ask\\" args=\\"when is the release?\\" source=\\"project\\">`);
    expect(sent).toContain("the release is on friday");
  });

  test("the Skill tool loads a skill; a PreToolUse hook blocks Bash", async () => {
    const r = await run(
      ["-p", "release", "--allowed-tools", "Bash"],
      [
        {
          content: [
            { type: "tool_use", id: "t1", name: "Skill", input: { skill: "release" } },
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "git tag v1" } },
          ],
          stop_reason: "tool_use",
        },
        text("Done."),
      ],
    );
    expect(r.code).toBe(0);
    const results = r.requests[1]!.body.messages.at(-1).content;
    expect(results[0].content).toContain("Tag, then push.");
    expect(results[1]).toMatchObject({ is_error: true });
    expect(results[1].content).toContain("Blocked by a PreToolUse hook: no shell in tests");
  });

  test("a subagent runs with its own tools and returns its report", async () => {
    const r = await run(
      ["-p", "look it up", "--output-format", "json"],
      [
        { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "read notes", prompt: "Read notes.txt", subagent_type: "scout" } }], stop_reason: "tool_use" },
        { content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "notes.txt" } }], stop_reason: "tool_use" },
        text("Notes say friday."),
        text("The scout says friday."),
      ],
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ result: "The scout says friday." });
    const child = r.requests[1]!.body;
    expect(child.tools.map((t: { name: string }) => t.name)).toEqual(["Read"]);
    expect(child.system).toContain("# Agent: scout");
    const agentResult = r.requests[3]!.body.messages.at(-1).content[0];
    expect(agentResult.content).toContain("Notes say friday.");
    expect(agentResult.content).toContain("(scout · 1 tool use · 2 turns)");
  });
});
