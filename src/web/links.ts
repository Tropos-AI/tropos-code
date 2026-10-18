// src/web/links.ts — the dashboard's address as Tropos prints and opens it. Always `127.0.0.1`, the address the server
// binds: `localhost` may resolve to ::1 first, where another local program could listen on the same port and catch a
// `#login=` key. One name everywhere also means one origin, so one localStorage and one login per browser.
import type { GatewayConfig } from "../gateway/config";
import { loginCodesFor, type LoginCodes } from "./login-codes";
import { DEFAULT_PORT } from "./protocol";

export function localDashboardUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export function dashboardPort(config: GatewayConfig): number {
  return config.webPort ?? DEFAULT_PORT;
}

/** A link that logs in the browser opening it: a one-time key (2 minutes, once) in the fragment, which no HTTP request carries. */
export async function dashboardLoginLink(home: string, port: number, logins: LoginCodes = loginCodesFor(home)): Promise<string> {
  return `${localDashboardUrl(port)}#login=${await logins.issueOneTime()}`;
}
