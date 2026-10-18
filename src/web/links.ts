// src/web/links.ts — the dashboard's address as Tropos prints and opens it. Always `localhost`: `127.0.0.1` is another
// origin with its own localStorage, so a link with that name would mean logging the same browser in twice.
import type { GatewayConfig } from "../gateway/config";
import { loginCodesFor, type LoginCodes } from "./login-codes";
import { DEFAULT_PORT } from "./protocol";

export function localDashboardUrl(port: number): string {
  return `http://localhost:${port}/`;
}

export function dashboardPort(config: GatewayConfig): number {
  return config.webPort ?? DEFAULT_PORT;
}

/** A link that logs in the browser opening it: a one-time key (2 minutes, once) in the fragment, which no HTTP request carries. */
export async function dashboardLoginLink(home: string, port: number, logins: LoginCodes = loginCodesFor(home)): Promise<string> {
  return `${localDashboardUrl(port)}#login=${await logins.issueOneTime()}`;
}
