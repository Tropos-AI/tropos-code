import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, runOne, type Fixture } from "../testing";
import { mcpCheck } from "./mcp";

let fx: Fixture;
afterEach(() => fx?.close());

test("stdio commands are looked up on PATH; http and disabled servers are not", async () => {
  fx = await makeFixture();
  const bin = join(fx.root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "present-mcp"), "#!/bin/sh\n");
  await chmod(join(bin, "present-mcp"), 0o755);
  await fx.write(
    "settings.json",
    JSON.stringify({
      mcpServers: {
        here: { command: "present-mcp" },
        gone: { command: "absent-mcp" },
        web: { type: "http", url: "https://mcp.example.com/x?key=secret" },
        off: { command: "absent-too", disabled: true },
      },
    }),
  );
  const r = await runOne(fx, mcpCheck, { env: { ...fx.env, PATH: bin } });
  const level = (n: string) => r.findings.find((f) => f.id === `mcp.servers.${n}`)?.level;
  expect(level("here")).toBe("ok");
  expect(level("gone")).toBe("warn");
  expect(level("web")).toBe("ok");
  expect(level("off")).toBeUndefined();
  expect(JSON.stringify(r)).not.toContain("secret");
});

test("no servers, and unreadable settings (the settings check owns that)", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, mcpCheck)).findings[0]!.message).toContain("No MCP servers");
  await fx.write("settings.json", "{bad");
  expect((await runOne(fx, mcpCheck)).findings).toEqual([]);
});
