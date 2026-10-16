// src/gateway/chat-exec.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { ExecBackend } from "../exec/backend";
import { confinementAvailable } from "../exec/confined";
import { chatBackend } from "./chat-exec";
import { gatewayConfigSchema, type GatewayConfig } from "./config";
import { SandboxUnavailableError } from "./errors";

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

function input(over: { config: GatewayConfig } & Partial<Parameters<typeof chatBackend>[0]>) {
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

test("docker: a docker problem fails closed, as before", async () => {
  const promise = chatBackend(input({ config: config({ backend: "docker" }), dockerCheck: async () => "Docker isn't running", override: () => ({ kind: "local" }) as ExecBackend }));
  await expect(promise).rejects.toBeInstanceOf(SandboxUnavailableError);
  await expect(promise).rejects.toThrow("Docker isn't running");
});

test("docker: with Docker up, the container backend (or the test's), confined", async () => {
  const docker = await chatBackend(input({ config: config({ backend: "docker" }) }));
  expect(docker).toMatchObject({ backend: { kind: "docker" }, confined: true });
  await docker.backend.close();
  const fake = { kind: "local" } as ExecBackend;
  expect(await chatBackend(input({ config: config({ backend: "docker" }), override: () => fake }))).toEqual({ backend: fake, confined: true });
});

test("host: Docker's answer doesn't matter", async () => {
  let asked = false;
  const fake = { kind: "local" } as ExecBackend;
  const got = await chatBackend(input({ config: config({ backend: "host" }), dockerCheck: async () => ((asked = true), "Docker isn't installed"), override: () => fake }));
  expect(got).toEqual({ backend: fake, confined: true });
  expect(asked).toBe(false);
});

const canConfine = process.platform === "darwin" || (process.platform === "linux" && (await confinementAvailable()) !== null);

test.skipIf(!canConfine)("host with confinement: the confined backend, confined", async () => {
  const got = await chatBackend(input({ config: config({ backend: "host" }) }));
  expect(got.backend.kind).toBe("confined");
  expect(got.confined).toBe(true);
  await got.backend.close();
});

test.skipIf(!canConfine)("host: a project that can't be confined fails closed with the reason", async () => {
  // A link where the per-sandbox cache goes would widen what a command may write: confinement refuses it.
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "elsewhere"), join(home, "sandbox-cache"));
  const promise = chatBackend(input({ config: config({ backend: "host" }) }));
  await expect(promise).rejects.toBeInstanceOf(SandboxUnavailableError);
  await expect(promise).rejects.toThrow("sandbox cache");
});

test("host without confinement: the host with the allowlisted env, not confined", async () => {
  const got = await chatBackend(input({ config: config({ backend: "host" }), confinement: async () => null }));
  expect(got.backend.kind).toBe("local");
  expect(got.confined).toBe(false);
  const r = await collect(got.backend.spawn({ shell: "/bin/sh", script: 'echo "${SECRET-unset}|$PWD"', cwd: workspace, env: { SECRET: "passed" } }));
  expect(r).toEqual({ out: `unset|${workspace}\n`, code: 0 });
});
