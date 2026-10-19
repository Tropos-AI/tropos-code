// src/tools/setup/sources.test.ts
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { guardedFetch, hostProblem, parseSource, PRIVATE_HOST, privateHostProblem, subdirProblem } from "./sources";

test("a GitHub folder link becomes a shallow clone of the repo at that branch, and a file link its raw file", () => {
  expect(parseSource("https://github.com/acme/kit/tree/main/plugins/x")).toEqual({ kind: "git", url: "https://github.com/acme/kit.git", ref: "main", subdir: "plugins/x" });
  expect(parseSource("https://github.com/acme/kit/blob/v2/skills/pdf/SKILL.md")).toEqual({ kind: "file", url: "https://raw.githubusercontent.com/acme/kit/v2/skills/pdf/SKILL.md" });
  expect(parseSource("https://github.com/acme/kit")).toEqual({ kind: "git", url: "https://github.com/acme/kit.git" });
  expect(parseSource("https://github.com/acme/kit.git", "skills/a")).toEqual({ kind: "git", url: "https://github.com/acme/kit.git", subdir: "skills/a" });
});

test("other https URLs: a .md file is fetched, anything else is a git repo; file:// is a local repo; a path is a local folder", () => {
  expect(parseSource("https://example.com/s/SKILL.md")).toEqual({ kind: "file", url: "https://example.com/s/SKILL.md" });
  expect(parseSource("https://gitlab.com/a/b.git")).toEqual({ kind: "git", url: "https://gitlab.com/a/b.git" });
  expect(parseSource("file:///srv/repos/kit.git")).toEqual({ kind: "git", url: "file:///srv/repos/kit.git" });
  expect(parseSource("/Users/me/kit")).toEqual({ kind: "local", path: "/Users/me/kit" });
  expect(parseSource("~/kit")).toEqual({ kind: "local", path: join(homedir(), "kit") });
});

test("http, other schemes, credentials in the URL and hosts on this machine or network are refused", () => {
  for (const raw of ["http://example.com/x.git", "ftp://example.com/x", "ssh://git@x/y", "https://user:tok@github.com/a/b", "https://localhost/x.git", "https://127.0.0.1/x", "https://10.1.2.3/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://192.168.1.4/x", "https://printer.local/x", "relative/path"]) {
    expect({ raw, out: "problem" in parseSource(raw) }).toEqual({ raw, out: true });
  }
});

test("private hosts: loopback, private, link-local, CGNAT, unique-local and mapped addresses", () => {
  for (const host of ["localhost", "a.localhost", "127.0.0.2", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "metadata.google.internal"]) {
    expect({ host, bad: privateHostProblem(new URL(`https://${host}/`)) !== undefined }).toEqual({ host, bad: true });
  }
  for (const host of ["example.com", "172.32.0.1", "8.8.8.8", "[2606:4700::1111]"]) expect(privateHostProblem(new URL(`https://${host}/`))).toBeUndefined();
});

test("a folder inside the repo is relative and stays inside", () => {
  for (const bad of ["../x", "a/../../b", "/etc", "~/x", "a\\..\\b", ""]) expect({ bad, p: subdirProblem(bad) !== undefined }).toEqual({ bad, p: true });
  expect(subdirProblem("plugins/x")).toBeUndefined();
});

/** A stub DNS: every name listed resolves to its addresses; anything else doesn't resolve. */
const dns = (table: Record<string, string[]>) => async (host: string) => {
  const found = table[host];
  if (!found) throw new Error(`ENOTFOUND ${host}`);
  return found;
};
const DNS = dns({ "example.com": ["93.184.216.34", "2606:2800:220:1::1"], "rebind.example": ["93.184.216.34", "10.0.0.5"], "v6.example": ["fd12::1"], "loop.example": ["::1"], "meta.example": ["169.254.169.254"] });

test("the guarded fetch refuses a redirect hop to a private host before it is fetched", async () => {
  const seen: string[] = [];
  const inner = (async (url: string) => {
    seen.push(url);
    return new Response("", { status: 302, headers: { location: "https://169.254.169.254/latest" } });
  }) as unknown as typeof fetch;
  const f = guardedFetch(inner, DNS);
  await f("https://example.com/a", {});
  await expect(f("https://169.254.169.254/latest", {})).rejects.toThrow(/this computer or your local network/);
  await expect(f("https://meta.example/latest", {})).rejects.toThrow(/this computer or your local network/);
  expect(seen).toEqual(["https://example.com/a"]);
});

test("a name is looked up first: any private, loopback, link-local or unique-local address refuses it, and so does a name that doesn't resolve", async () => {
  expect(await hostProblem(new URL("https://example.com/x"), DNS)).toBeUndefined();
  for (const host of ["rebind.example", "v6.example", "loop.example", "meta.example"]) expect({ host, p: await hostProblem(new URL(`https://${host}/x`), DNS) }).toEqual({ host, p: PRIVATE_HOST });
  expect(await hostProblem(new URL("https://nowhere.example/x"), DNS)).toContain("couldn't find");
  // A literal address needs no lookup; a file:// URL the owner gave is local by design.
  expect(await hostProblem(new URL("https://8.8.8.8/x"), dns({}))).toBeUndefined();
  expect(await hostProblem(new URL("file:///srv/repo.git"), dns({}))).toBeUndefined();
});
