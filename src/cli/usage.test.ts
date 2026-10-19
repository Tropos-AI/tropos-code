import { expect, test } from "bun:test";
import { GATEWAY_HELP, INSTALL_HELP, UPDATE_HELP, USAGE } from "./usage";

test("update help says a running background service is restarted onto the new version", () => {
  expect(UPDATE_HELP).toContain("A running background service is restarted so it runs the new version.");
});

test("help is grouped Start · Everyday · Setup and care · Advanced, and hides the aliases", () => {
  const order = ["Start:", "Everyday:", "Setup and care:", "Advanced:"].map((h) => USAGE.indexOf(h));
  expect(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
  for (const gone of ["tcode web", "gateway status", "gateway logs", "upgrade", "tcode install"]) expect(USAGE).not.toContain(gone);
  expect(USAGE.split("\n").filter((l) => /\btropos\b/.test(l) && /another name|works too/.test(l))).toHaveLength(1);
  expect(USAGE).toContain("tcode update [--version <v>]");
});

test("every command the help lists is documented under its group", () => {
  const advanced = USAGE.slice(USAGE.indexOf("Advanced:"), USAGE.indexOf("Options:"));
  for (const word of ["gateway [--no-web]", "gateway install|uninstall|start|stop|restart", "pairing approve|list|revoke", "reset", "security audit", "migrate openclaw|hermes", "tcode -- <prompt>"]) {
    expect(advanced).toContain(word);
  }
  const start = USAGE.slice(USAGE.indexOf("Start:"), USAGE.indexOf("Everyday:"));
  expect(start).toContain("tcode dashboard [--code]");
});

test("gateway help no longer lists status or logs, and documents --dev", () => {
  expect(GATEWAY_HELP).not.toContain("tcode gateway status");
  expect(GATEWAY_HELP).not.toContain("tcode gateway logs");
  expect(GATEWAY_HELP).toContain("--dev");
});

test("gateway help describes the real defaults: the OS sandbox and the autonomy level, Docker only for guests", () => {
  expect(GATEWAY_HELP).not.toContain("Docker container that sees only");
  expect(GATEWAY_HELP).not.toContain("every edit or command asks you first");
  expect(GATEWAY_HELP).not.toContain("make sure Docker is running");
  expect(GATEWAY_HELP).toContain("sandbox-exec");
  expect(GATEWAY_HELP).toContain("bwrap");
  expect(GATEWAY_HELP).toContain("balanced");
  expect(GATEWAY_HELP).toContain("guests");
});

test("install help names the command link the installer manages, ~/.local/bin/tcode", () => {
  expect(INSTALL_HELP).toContain("~/.local/bin/tcode");
  expect(INSTALL_HELP).not.toContain("~/.local/bin/tropos");
  expect(INSTALL_HELP).not.toContain("active tropos");
});
