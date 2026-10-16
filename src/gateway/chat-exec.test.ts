// src/gateway/chat-exec.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { ExecBackend } from "../exec/backend";
import { confinementAvailable } from "../exec/confined";
import { chatBackend, GUEST_NEEDS_DOCKER } from "./chat-exec";
import { gatewayConfigSchema, type GatewayConfig } from "./config";
import { SandboxUnavailableError } from "./errors";
import type { SessionRole } from "./types";

let dir: string;
let workspace: string;
let home: string;
let userHome: string;
beforeEach(async () => {
  dir = await makeTmpDir("chat-exec");
  workspace = join(dir, "app");
  home = join(dir, "home", ".tropos");
  userHome = join(dir, "home");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(async () => {
  await removeDir(dir);
});

const config = (chat: Partial<GatewayConfig["chat"]>): GatewayConfig => gatewayConfigSchema.parse({ chat });
const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: "/nowhere", SECRET: "s3cret" };

function input(over: { config: GatewayConfig; role: SessionRole } & Partial<Parameters<typeof chatBackend>[0]>) {
  return {
    workspace,
    home,
    userHome,
    env,
    confinement: async () => "sandbox-exec" as const,
    dockerCheck: async () => undefined,
    ...over,
  };
}

const collect = (child: ChildProcess) =>
  new Promise<{ out: string; code: number | null }>((resolve) => {
    let out = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.once("close", (code) => resolve({ out, code }));
  });

const fake = () => ({ kind: "local" }) as ExecBackend;
const DOCKER_DOWN = "Docker isn't running";

test("docker: a docker problem fails closed, as before", async () => {
  const promise = chatBackend(input({ config: config({ backend: "docker" }), role: "owner", dockerCheck: async () => DOCKER_DOWN, override: fake }));
  await expect(promise).rejects.toBeInstanceOf(SandboxUnavailableError);
  await expect(promise).rejects.toThrow(DOCKER_DOWN);
});

test("docker: with Docker up, the container backend (or the test's), confined", async () => {
  const docker = await chatBackend(input({ config: config({ backend: "docker" }), role: "owner" }));
  expect(docker).toMatchObject({ backend: { kind: "docker" }, confined: true });
  await docker.backend.close();
  const backend = fake();
  expect(await chatBackend(input({ config: config({ backend: "docker" }), role: "owner", override: () => backend }))).toEqual({ backend, confined: true });
});

test("host: Docker's answer doesn't matter to the owner", async () => {
  let asked = false;
  const backend = fake();
  const got = await chatBackend(input({ config: config({ backend: "host" }), role: "owner", dockerCheck: async () => ((asked = true), "Docker isn't installed"), override: () => backend }));
  expect(got).toEqual({ backend, confined: true });
  expect(asked).toBe(false);
});

const canConfine = process.platform === "darwin" || (process.platform === "linux" && (await confinementAvailable()) !== null);

test.skipIf(!canConfine)("host with confinement: the confined backend, confined", async () => {
  const got = await chatBackend(input({ config: config({ backend: "host" }), role: "owner" }));
  expect(got.backend.kind).toBe("confined");
  expect(got.confined).toBe(true);
  await got.backend.close();
});

test.skipIf(!canConfine)("host: a project that can't be confined fails closed with the reason", async () => {
  // A link where the per-sandbox cache goes would widen what a command may write: confinement refuses it.
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "elsewhere"), join(home, "sandbox-cache"));
  const promise = chatBackend(input({ config: config({ backend: "host" }), role: "owner" }));
  await expect(promise).rejects.toBeInstanceOf(SandboxUnavailableError);
  await expect(promise).rejects.toThrow("sandbox cache");
});

test("host without confinement, the owner's chat: the host with the allowlisted env, not confined", async () => {
  const got = await chatBackend(input({ config: config({ backend: "host" }), role: "owner", confinement: async () => null }));
  expect(got.backend.kind).toBe("local");
  expect(got.confined).toBe(false);
  const r = await collect(got.backend.spawn({ shell: "/bin/sh", script: 'echo "${SECRET-unset}|$PWD"', cwd: workspace, env: { SECRET: "passed" } }));
  expect(r).toEqual({ out: `unset|${workspace}\n`, code: 0 });
});

/**
 * Every role × confinement × Docker, without test backends. Guests (their chats and the jobs made there) approve their
 * own requests, so they get Docker or nothing; nobody but the owner's own chat ever gets the bare host, and a scheduled
 * run (nobody to approve) never does.
 */
describe("which backend each role gets", () => {
  type Want = "confined" | "docker" | "local" | "no-docker" | "no-confinement" | "docker-down";
  const cases: [SessionRole, "host" | "docker", boolean, boolean, boolean, Want][] = [
    // role, chat.backend, confinement available, Docker up, consented to unconfined, outcome
    ["owner", "host", true, true, false, "confined"],
    ["owner", "host", true, false, false, "confined"],
    ["owner", "host", false, true, false, "local"],
    ["owner", "host", false, false, false, "local"],
    ["owner", "host", false, false, true, "local"],
    ["owner", "docker", true, true, false, "docker"],
    ["owner", "docker", false, false, true, "docker-down"],
    ["scheduled", "host", true, true, false, "confined"],
    ["scheduled", "host", true, false, false, "confined"],
    ["scheduled", "host", false, true, true, "no-confinement"],
    ["scheduled", "host", false, false, false, "no-confinement"],
    ["scheduled", "docker", true, true, false, "docker"],
    ["scheduled", "docker", true, false, false, "docker-down"],
    ["guest", "host", true, true, true, "docker"],
    ["guest", "host", true, false, true, "no-docker"],
    ["guest", "host", false, true, true, "docker"],
    ["guest", "host", false, false, true, "no-docker"],
    ["guest", "docker", true, true, false, "docker"],
    ["guest", "docker", true, false, false, "no-docker"],
  ];
  for (const [role, backend, confinable, dockerUp, consented, want] of cases) {
    const name = `${role}, ${backend}, confinement ${confinable ? "yes" : "no"}, Docker ${dockerUp ? "up" : "down"}${consented ? ", consented" : ""}: ${want}`;
    test.skipIf(want === "confined" && !canConfine)(name, async () => {
      const promise = chatBackend(
        input({
          config: config({ backend, ...(consented ? { allowUnconfined: true } : {}) }),
          role,
          confinement: async () => (confinable ? "sandbox-exec" : null),
          dockerCheck: async () => (dockerUp ? undefined : DOCKER_DOWN),
        }),
      );
      if (want === "no-docker" || want === "no-confinement" || want === "docker-down") {
        await expect(promise).rejects.toBeInstanceOf(SandboxUnavailableError);
        if (want === "no-docker") await expect(promise).rejects.toThrow(`${GUEST_NEEDS_DOCKER} (${DOCKER_DOWN})`);
        if (want === "no-confinement") await expect(promise).rejects.toThrow("can't be confined on this machine");
        if (want === "docker-down") await expect(promise).rejects.toThrow(DOCKER_DOWN);
        return;
      }
      const got = await promise;
      try {
        expect(got.backend.kind).toBe(want);
        expect(got.confined).toBe(want !== "local");
      } finally {
        await got.backend.close();
      }
    });
  }
});
