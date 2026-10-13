// src/config/settings.autoupdate.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { DEFAULT_SETTINGS, loadSettings, settingsPaths } from "./settings";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

describe("update settings (spec §11)", () => {
  test("defaults", () => {
    expect(DEFAULT_SETTINGS.autoUpdates).toBe(true);
    expect(DEFAULT_SETTINGS.autoUpdatesChannel).toBe("latest");
  });

  test("the user layer sets them", async () => {
    const paths = settingsPaths(join(dir, "proj"), join(dir, "home"));
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(paths.user, JSON.stringify({ autoUpdates: false, autoUpdatesChannel: "stable" }));
    const { settings } = await loadSettings(paths);
    expect(settings.autoUpdates).toBe(false);
    expect(settings.autoUpdatesChannel).toBe("stable");
  });

  test("a repo cannot set them (it could pin users to an old version)", async () => {
    const paths = settingsPaths(join(dir, "proj"), join(dir, "home"));
    await mkdir(join(dir, "proj", ".tropos"), { recursive: true });
    await writeFile(paths.project, JSON.stringify({ autoUpdates: false, autoUpdatesChannel: "stable" }));
    const { settings, warnings } = await loadSettings(paths);
    expect(settings.autoUpdates).toBe(true);
    expect(settings.autoUpdatesChannel).toBe("latest");
    expect(warnings.join("\n")).toContain("ignored autoUpdates, autoUpdatesChannel");
  });

  test("bad values are a settings error", async () => {
    const paths = settingsPaths(join(dir, "proj"), join(dir, "home"));
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(paths.user, JSON.stringify({ autoUpdatesChannel: "nightly" }));
    await expect(loadSettings(paths)).rejects.toThrow("autoUpdatesChannel");
  });
});
