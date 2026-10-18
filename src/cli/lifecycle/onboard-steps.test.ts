import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootstrapPending, loadIdentity } from "../../context/identity";
import { listProjects } from "../../gateway/projects";
import { addScannedProjects } from "../../onboard/projects-scan";
import { readOnboardingFlags } from "../../onboard/flags";
import { cleanupWizardIO, wizardIO, type TestWizardIO } from "./onboard-test-kit";
import { autonomyStep, identityStep, projectsStep } from "./onboard-steps";

afterEach(cleanupWizardIO);

const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 86_400_000;
const read = (io: TestWizardIO, name: string) => readFile(join(io.home, name), "utf8");
/** A git repository under the fake user home whose last git activity was `daysAgo` days before the wizard's clock. */
async function repo(io: TestWizardIO, rel: string, daysAgo: number): Promise<void> {
  const git = join(io.root, "home", rel, ".git");
  await mkdir(git, { recursive: true });
  const head = join(git, "HEAD");
  await writeFile(head, "ref: refs/heads/main\n");
  const t = new Date(NOW - daysAgo * DAY);
  await utimes(head, t, t);
}
const gatewayChat = async (io: TestWizardIO) => JSON.parse(await read(io, "gateway.json")).chat;

describe("identityStep", () => {
  test("Enter takes the first suggestion", async () => {
    const io = await wizardIO([""]);
    expect(await identityStep(io)).toBe("next");
    expect(await loadIdentity(io.home)).toMatchObject({ name: "Tropos", emoji: "🧭", vibe: "calm, direct, gets things done" });
    expect(await bootstrapPending(io.home)).toBe(false);
    expect(io.out()).toContain("1. 🧭 Tropos: calm, direct, gets things done");
  });

  test("a typed name keeps the suggested emoji and vibe; a refused value is asked again", async () => {
    const io = await wizardIO(["4", "(tbd)", "Ada", "", ""]);
    expect(await identityStep(io)).toBe("next");
    expect(io.out().match(/looks like a placeholder/g)).toHaveLength(1);
    expect(await loadIdentity(io.home)).toMatchObject({ name: "Ada", emoji: "🧭", vibe: "calm, direct, gets things done" });
  });

  test("a wrong emoji or a long vibe is refused in plain words, then accepted when fixed", async () => {
    const io = await wizardIO(["4", "Ada", "abc", "🦊", "x".repeat(121), "quick and kind"]);
    expect(await identityStep(io)).toBe("next");
    expect(io.out()).toContain("emoji must be a single emoji");
    expect(io.out()).toContain("at most 120 characters");
    expect(await loadIdentity(io.home)).toMatchObject({ name: "Ada", emoji: "🦊", vibe: "quick and kind" });
  });

  test("s leaves the first-chat ritual pending", async () => {
    const io = await wizardIO(["s"]);
    expect(await identityStep(io)).toBe("skip");
    expect(await bootstrapPending(io.home)).toBe(true);
    expect(io.out()).toContain("Skipped. I'll ask for a name in our first chat.");
  });

  test("b goes back", async () => {
    expect(await identityStep(await wizardIO(["b"]))).toBe("back");
  });

  test("--quick skips: naming is personal", async () => {
    const io = await wizardIO([], {}, { quick: true });
    expect(await identityStep(io)).toBe("skip");
    expect(io.questions).toEqual([]);
    expect(await bootstrapPending(io.home)).toBe(true);
  });
});

describe("projectsStep", () => {
  test("recent repos are ticked; numbers toggle; Enter adds the ticked ones", async () => {
    const io = await wizardIO(["2", ""]);
    await repo(io, "code/new", 2);
    await repo(io, "code/old", 60);
    expect(await projectsStep(io)).toBe("next");
    const text = io.out();
    expect(text).toContain("Looking in ~/Desktop, ~/Documents");
    expect(text).toMatch(/\[x\] 1\. new {2}~\/code\/new {2}\(2 days ago\)/);
    expect(text).toMatch(/\[ \] 2\. old/);
    expect((await listProjects(io.home)).map((p) => p.name).sort()).toEqual(["Default workspace", "new", "old"]);
  });

  test("typing a number again unticks it", async () => {
    const io = await wizardIO(["1", ""]);
    await repo(io, "code/new", 2);
    expect(await projectsStep(io)).toBe("next");
    expect((await listProjects(io.home)).map((p) => p.name)).toEqual(["Default workspace"]);
  });

  test("a wrong number is explained and asked again; one already added shows (added)", async () => {
    const io = await wizardIO(["9", ""]);
    await repo(io, "code/new", 2);
    await addScannedProjects(io.home, [join(io.root, "home", "code", "new")], join(io.root, "home"));
    expect(await projectsStep(io)).toBe("next");
    expect(io.out()).toContain("Type numbers from 1 to 1");
    expect(io.out()).toContain("(added)");
  });

  test("nothing found says so and moves on", async () => {
    const io = await wizardIO([]);
    expect(await projectsStep(io)).toBe("next");
    expect(io.out().replace(/\n│  /g, " ")).toContain("No git repositories found. Your default workspace is ready; add projects later with `tcode projects add <path>`.");
    expect(io.questions).toEqual([]);
  });

  test("s skips and b goes back", async () => {
    const skip = await wizardIO(["/skip"]);
    await repo(skip, "code/new", 2);
    expect(await projectsStep(skip)).toBe("skip");
    const back = await wizardIO(["/back"]);
    await repo(back, "code/new", 2);
    expect(await projectsStep(back)).toBe("back");
  });

  test("--quick adds the recent repos without asking", async () => {
    const io = await wizardIO([], {}, { quick: true });
    await repo(io, "code/new", 2);
    await repo(io, "code/old", 60);
    expect(await projectsStep(io)).toBe("next");
    expect(io.questions).toEqual([]);
    expect((await listProjects(io.home)).map((p) => p.name).sort()).toEqual(["Default workspace", "new"]);
  });
});

describe("autonomyStep", () => {
  test("Enter keeps Balanced on a confined machine and saves host; each choice comes with its risk", async () => {
    const io = await wizardIO([""]);
    expect(await autonomyStep(io)).toBe("next");
    expect(await gatewayChat(io)).toMatchObject({ autonomy: "balanced", backend: "host" });
    expect(io.out()).toContain("Asks before every edit and command.");
    expect(io.out()).toContain("Runs any command in the project without asking");
    expect((await readOnboardingFlags(io.home)).autonomyChosen).toBe(true);
  });

  test("an existing Docker install is asked first; n keeps docker and the level picked", async () => {
    const io = await wizardIO(["n", "1"]);
    await mkdir(io.home, { recursive: true });
    await writeFile(join(io.home, "gateway.json"), JSON.stringify({ chat: { autonomy: "ask", backend: "docker" } }));
    expect(await autonomyStep(io)).toBe("next");
    expect(io.out()).toContain("instead of Docker?");
    expect(await gatewayChat(io)).toMatchObject({ autonomy: "ask", backend: "docker" });
  });

  test("an existing Docker install moves to this computer on y", async () => {
    const io = await wizardIO(["y", "2"]);
    await mkdir(io.home, { recursive: true });
    await writeFile(join(io.home, "gateway.json"), JSON.stringify({ chat: { autonomy: "ask", backend: "docker" } }));
    expect(await autonomyStep(io)).toBe("next");
    expect(await gatewayChat(io)).toMatchObject({ autonomy: "balanced", backend: "host" });
  });

  test("--advanced asks for the backend as a choice", async () => {
    const io = await wizardIO(["2", "1"], {}, { advanced: true });
    expect(await autonomyStep(io)).toBe("next");
    expect(io.out()).toContain("1. This computer");
    expect(io.out()).toContain("2. Docker");
    expect(await gatewayChat(io)).toMatchObject({ autonomy: "ask", backend: "docker" });
  });

  test("without a sandbox it shows the bubblewrap command, then needs an explicit yes; no saves Ask", async () => {
    const io = await wizardIO(["", "2", "n"], { confinement: async () => null, which: (c) => (c === "apt-get" ? "/usr/bin/apt-get" : null) });
    expect(await autonomyStep(io)).toBe("next");
    expect(io.out()).toContain("sudo apt-get install bubblewrap");
    expect(io.out()).toContain("Chats will ask before every edit and command until a sandbox is available.");
    expect((await gatewayChat(io)).autonomy).toBe("ask");
  });

  test("without a sandbox and without an installer it asks for the full-access consent at once; yes saves it", async () => {
    const io = await wizardIO(["", "y"], { confinement: async () => null });
    expect(await autonomyStep(io)).toBe("next");
    expect(io.questions.some((q) => q.includes("without a sandbox anyway"))).toBe(true);
    expect(io.out()).toContain("They would have your full access.");
    expect(await gatewayChat(io)).toMatchObject({ autonomy: "balanced", backend: "host", allowUnconfined: true });
  });

  test("Enter re-checks for the sandbox after installing it", async () => {
    let calls = 0;
    const io = await wizardIO(["", "1", "1"], { confinement: async () => (calls++ < 2 ? null : "sandbox-exec"), which: (c) => (c === "apt-get" ? "/usr/bin/apt-get" : null) });
    expect(await autonomyStep(io)).toBe("next");
    expect(io.questions.some((q) => q.includes("without a sandbox anyway"))).toBe(false);
    expect(await gatewayChat(io)).toMatchObject({ autonomy: "balanced", backend: "host" });
  });

  test("--quick saves Balanced without asking; without a sandbox it saves Ask instead of assuming consent", async () => {
    const io = await wizardIO([], {}, { quick: true });
    expect(await autonomyStep(io)).toBe("next");
    expect(io.questions).toEqual([]);
    expect(await gatewayChat(io)).toMatchObject({ autonomy: "balanced", backend: "host" });
    const bare = await wizardIO([], { confinement: async () => null }, { quick: true });
    expect(await autonomyStep(bare)).toBe("next");
    expect((await gatewayChat(bare)).autonomy).toBe("ask");
  });

  test("s skips and b goes back", async () => {
    expect(await autonomyStep(await wizardIO(["s"]))).toBe("skip");
    expect(await autonomyStep(await wizardIO(["b"]))).toBe("back");
  });
});
