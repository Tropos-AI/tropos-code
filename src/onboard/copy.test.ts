import { afterEach, expect, test } from "bun:test";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { saveIdentity } from "../context/identity";
import { IDENTITY_SUGGESTIONS } from "./copy";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(removeDir));
});
const tmpHome = async () => {
  const h = await makeTmpDir("copy-");
  homes.push(h);
  return h;
};

test("every identity suggestion is something saveIdentity accepts", async () => {
  for (const s of IDENTITY_SUGGESTIONS) expect((await saveIdentity(await tmpHome(), s)).ok).toBe(true);
});
