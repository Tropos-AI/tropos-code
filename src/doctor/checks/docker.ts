// src/doctor/checks/docker.ts — the sandbox needs a reachable Docker daemon and its image.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "../types";
import { finding, isRecord } from "../util";

export const DEFAULT_IMAGE = "alpine:3.22";

/** The sandbox image from gateway.json; read raw so a config problem is the gateway check's to report. */
export async function sandboxImage(home: string): Promise<string> {
  try {
    const json: unknown = JSON.parse(await readFile(join(home, "gateway.json"), "utf8"));
    const image = isRecord(json) && isRecord(json.sandbox) ? json.sandbox.image : undefined;
    return typeof image === "string" && image ? image : DEFAULT_IMAGE;
  } catch {
    return DEFAULT_IMAGE;
  }
}

export const dockerCheck: Check = {
  id: "docker.daemon",
  area: "docker",
  title: "Docker and the sandbox image",
  async run(env) {
    const info = await env.runner.exec("docker", ["info", "--format", "{{.ServerVersion}}"], 8_000);
    if (info.error?.includes("not found")) {
      return [finding("docker.daemon", "warn", "Docker is not installed", { detail: "Only the gateway needs it: chat commands run in a Docker sandbox." })];
    }
    if (info.code !== 0) {
      return [finding("docker.daemon", "warn", "Docker is installed but the daemon is not reachable", { detail: (info.error ?? info.stderr.trim().split("\n")[0]) || "start Docker Desktop or the docker service" })];
    }
    const out = [finding("docker.daemon", "ok", `Docker daemon reachable (server ${info.stdout.trim() || "unknown"})`)];
    const image = await sandboxImage(env.home);
    const have = await env.runner.exec("docker", ["image", "inspect", "--format", "{{.Id}}", image], 8_000);
    out.push(
      have.code === 0
        ? finding("docker.image", "ok", `Sandbox image ${image} is present`)
        : finding("docker.image", "warn", `Sandbox image ${image} is not present`, { detail: `The first chat session would have to download it. Fix: docker pull ${image}`, fixable: true, data: { image } }),
    );
    return out;
  },
  async fix(f, env) {
    const image = String(f.data?.image ?? "");
    if (!image || image.startsWith("-")) return { ok: false, message: "no image to pull" };
    const r = await env.runner.exec("docker", ["pull", image], 600_000);
    return r.code === 0 ? { ok: true, message: `pulled ${image}` } : { ok: false, message: (r.error ?? r.stderr.trim().split("\n").pop()) || "docker pull failed" };
  },
};
