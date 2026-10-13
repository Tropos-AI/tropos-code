// src/install/env.ts
/** The only variables background updates and health checks receive (spec §11, amendment A8). */
export const ENV_ALLOW_LIST: readonly string[] = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TROPOS_HOME",
];

export function minimalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (ENV_ALLOW_LIST.includes(name) || name.startsWith("LC_"))) out[name] = value;
  }
  return out;
}
