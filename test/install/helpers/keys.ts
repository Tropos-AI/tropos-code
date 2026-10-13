// test/install/helpers/keys.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllowedSigners, type TrustedKey } from "../../../src/install/sshsig";

export interface TestKey {
  name: string;
  privatePath: string;
  /** "tropos-release <type> <base64>" */
  signersLine: string;
  /** Empty for non-ed25519 keys, which Tropos never trusts. */
  trusted: TrustedKey[];
}

export async function makeTestKey(dir: string, name: string, type: "ed25519" | "ecdsa" = "ed25519"): Promise<TestKey> {
  const privatePath = join(dir, `${name}.key`);
  await Bun.$`ssh-keygen -q -t ${type} -N "" -C ${name} -f ${privatePath}`.quiet();
  const [keyType, b64] = (await readFile(`${privatePath}.pub`, "utf8")).trim().split(/\s+/);
  const signersLine = `tropos-release ${keyType} ${b64}`;
  return { name, privatePath, signersLine, trusted: type === "ed25519" ? parseAllowedSigners(signersLine) : [] };
}

let counter = 0;

/** Signs `data` with `ssh-keygen -Y sign` and returns the armored signature. */
export async function sshSign(key: TestKey, data: Uint8Array | string, namespace: string, dir: string, extra: string[] = []): Promise<string> {
  const file = join(dir, `to-sign-${process.pid}-${counter++}`);
  await writeFile(file, data);
  await Bun.$`ssh-keygen -Y sign -f ${key.privatePath} -n ${namespace} ${extra} ${file}`.quiet();
  return readFile(`${file}.sig`, "utf8");
}

export function allowedSignersText(...keys: TestKey[]): string {
  return keys.map((k) => k.signersLine).join("\n") + "\n";
}
