import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { OnboardError } from "./engine";
import { enablePhoneAccess, phoneStatus } from "./phone";
import { fakeService, fakeTailscale, testDeps } from "./testing";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("phone-");
});
afterEach(() => removeDir(home));
const gatewayJson = async () => JSON.parse(await readFile(join(home, "gateway.json"), "utf8"));
const signedIn = () => fakeTailscale({ installed: true, running: true, dnsName: "mac.tail1.ts.net" });

test("phoneStatus combines Tailscale and remoteAccess", async () => {
  expect(await phoneStatus(testDeps(home))).toEqual({ installed: false, running: false, enabled: false });
  const deps = testDeps(home, { runner: signedIn() });
  expect(await phoneStatus(deps)).toEqual({ installed: true, running: true, dnsName: "mac.tail1.ts.net", enabled: false });
  await enablePhoneAccess(deps);
  expect(await phoneStatus(deps)).toEqual({ installed: true, running: true, dnsName: "mac.tail1.ts.net", enabled: true, url: "https://mac.tail1.ts.net/" });
});

test("enablePhoneAccess serves the dashboard port, saves remoteAccess, returns a code", async () => {
  const ts = signedIn();
  const r = await enablePhoneAccess(testDeps(home, { runner: ts }));
  expect(ts.served).toEqual([4317]);
  expect(r).toEqual({ url: "https://mac.tail1.ts.net/", httpsPort: 443, code: "123456" });
  expect((await gatewayJson()).remoteAccess).toEqual({ tailscale: true, httpsPort: 443, hostname: "mac.tail1.ts.net" });
});

test("enablePhoneAccess refuses plainly when Tailscale isn't signed in, and writes nothing", async () => {
  const ts = fakeTailscale({ installed: true, running: false });
  const err = await enablePhoneAccess(testDeps(home, { runner: ts })).catch((e) => e);
  expect(err).toBeInstanceOf(OnboardError);
  expect(err.message).toBe("Tailscale isn't signed in on this computer yet. Open Tailscale, sign in, then try again.");
  expect(ts.served).toEqual([]);
  expect(await readFile(join(home, "gateway.json"), "utf8").catch(() => null)).toBeNull();
});

test("a running gateway is restarted so the new address is allowed", async () => {
  const service = fakeService({ installed: true, running: true });
  let restarts = 0;
  service.restart = async () => void restarts++;
  await enablePhoneAccess(testDeps(home, { runner: signedIn(), service }));
  expect(restarts).toBe(1);
});
