import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { gatewayConfigSchema } from "../gateway/config";
import { dashboardLoginLink, dashboardPort, localDashboardUrl, remoteHostHeader, remoteUrl } from "./links";
import { LoginCodes, loginCodesFor } from "./login-codes";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await removeDir(dir);
  dir = undefined;
});

test("the dashboard's address is always 127.0.0.1, the address the server binds (never localhost, which may be ::1)", () => {
  expect(localDashboardUrl(4317)).toBe("http://127.0.0.1:4317/");
  expect(localDashboardUrl(4318)).toBe("http://127.0.0.1:4318/");
});

test("dashboardPort is webPort from gateway.json, else 4317", () => {
  expect(dashboardPort(gatewayConfigSchema.parse({}))).toBe(4317);
  expect(dashboardPort(gatewayConfigSchema.parse({ webPort: 4555 }))).toBe(4555);
});

test("dashboardLoginLink carries a one-time key that the gateway's store redeems once", async () => {
  dir = await makeTmpDir("links-");
  const link = await dashboardLoginLink(dir, 4317);
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:4317\/#login=[A-Za-z0-9_-]{43}$/);
  const key = link.split("#login=")[1]!;
  // Another process (the gateway) reads the same file.
  expect(await loginCodesFor(dir).redeem(key)).toBe(true);
  expect(await loginCodesFor(dir).redeem(key)).toBe(false);
});

test("dashboardLoginLink uses the store it is given", async () => {
  dir = await makeTmpDir("links-");
  const logins = new LoginCodes({ path: join(dir, "elsewhere.json") });
  const link = await dashboardLoginLink(join(dir, "unused"), 4400, logins);
  expect(await logins.redeem(link.split("#login=")[1]!)).toBe(true);
});

test("remoteUrl and remoteHostHeader: only while phone access is on; the port shows unless it is 443", () => {
  const off = gatewayConfigSchema.parse({}).remoteAccess;
  expect(remoteUrl(off)).toBeNull();
  expect(remoteHostHeader(off)).toBeNull();
  const noName = { tailscale: true };
  expect(remoteUrl(noName)).toBeNull();
  const on443 = { tailscale: true, httpsPort: 443, hostname: "mac.tail1234.ts.net" };
  expect(remoteUrl(on443)).toBe("https://mac.tail1234.ts.net/");
  expect(remoteHostHeader(on443)).toBe("mac.tail1234.ts.net");
  const on8443 = { tailscale: true, httpsPort: 8443, hostname: "mac.tail1234.ts.net" };
  expect(remoteUrl(on8443)).toBe("https://mac.tail1234.ts.net:8443/");
  expect(remoteHostHeader(on8443)).toBe("mac.tail1234.ts.net:8443");
  expect(remoteHostHeader({ tailscale: false, httpsPort: 8443, hostname: "mac.tail1234.ts.net" })).toBeNull();
});
