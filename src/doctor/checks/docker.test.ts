import { afterEach, expect, test } from "bun:test";
import type { RunResult } from "../types";
import { fakeRunner, makeFixture, noDocker, runOne, type Fixture } from "../testing";
import { dockerCheck } from "./docker";

let fx: Fixture;
afterEach(() => fx?.close());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

function docker(over: { image?: boolean; daemon?: boolean } = {}) {
  const calls: string[][] = [];
  const exec = async (_cmd: string, args: string[]): Promise<RunResult> => {
    calls.push(args);
    if (args[0] === "info") return over.daemon === false ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" } : ok("27.1\n");
    if (args[0] === "image") return over.image === false ? { code: 1, stdout: "", stderr: "No such image" } : ok("sha256:abc\n");
    if (args[0] === "pull") return ok();
    return noDocker;
  };
  return { calls, runner: fakeRunner({ exec }) };
}

test("docker missing is a warning, not an error", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, dockerCheck);
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0]).toMatchObject({ level: "warn", message: "Docker is not installed" });
});

test("a daemon that is down is reported with Docker's reason", async () => {
  fx = await makeFixture();
  const d = docker({ daemon: false });
  const r = await runOne(fx, dockerCheck, { runner: d.runner });
  expect(r.findings[0]!.detail).toContain("Cannot connect");
  expect(d.calls.some((a) => a[0] === "image")).toBe(false);
});

test("daemon and image present is all ok", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, dockerCheck, { runner: docker().runner });
  expect(r.findings.map((f) => f.level)).toEqual(["ok", "ok"]);
});

test("the image comes from gateway.json; a missing one is pulled only with --fix", async () => {
  fx = await makeFixture();
  await fx.write("gateway.json", JSON.stringify({ sandbox: { image: "node:22-alpine" } }));
  const d = docker({ image: false });
  const plain = await runOne(fx, dockerCheck, { runner: d.runner });
  expect(plain.findings[1]).toMatchObject({ level: "warn", fixable: true });
  expect(plain.findings[1]!.message).toContain("node:22-alpine");
  expect(d.calls.some((a) => a[0] === "pull")).toBe(false);

  const fixed = await runOne(fx, dockerCheck, { runner: d.runner, fix: true });
  expect(d.calls).toContainEqual(["pull", "node:22-alpine"]);
  expect(fixed.summary.fixed).toBe(1);
});

test("fix 'safe' does not download anything", async () => {
  fx = await makeFixture();
  const d = docker({ image: false });
  await runOne(fx, dockerCheck, { runner: d.runner, fix: "safe" });
  expect(d.calls.some((a) => a[0] === "pull")).toBe(false);
});
