import { expect, test } from "bun:test";
import { GATEWAY_HELP, USAGE } from "./usage";

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
