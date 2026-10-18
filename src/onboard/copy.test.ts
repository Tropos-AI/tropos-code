import { afterEach, expect, test } from "bun:test";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { saveIdentity } from "../context/identity";
import { BOTFATHER_STEPS, BOTFATHER_URL, IDENTITY_SUGGESTIONS, RISK_NOTICE, WELCOME_LINES, exampleAsks } from "./copy";

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

test("exampleAsks gives three, the first naming the project when there is one", () => {
  expect(exampleAsks("app")).toHaveLength(3);
  expect(exampleAsks("app")[0]).toBe("What changed in app this week?");
  expect(exampleAsks()).toHaveLength(3);
  expect(exampleAsks()[0]).not.toContain("undefined");
});

test("the Telegram, welcome and notice copy", () => {
  expect(BOTFATHER_URL).toBe("https://t.me/BotFather");
  expect(BOTFATHER_STEPS).toHaveLength(3);
  expect(WELCOME_LINES).toHaveLength(3);
  expect(RISK_NOTICE[2]).toContain("inside its own sandbox");
  expect(RISK_NOTICE.join(" ")).not.toContain("Docker");
});
