// src/install/urls.test.ts
import { describe, expect, test } from "bun:test";
import { RELEASE_URLS, githubReleaseUrls } from "./urls";

describe("release URLs", () => {
  test("production URLs", () => {
    expect(RELEASE_URLS.channel("latest")).toBe("https://github.com/Tropos-AI/tropos-code-channels/releases/download/channels/latest");
    expect(RELEASE_URLS.channel("stable.bak")).toBe("https://github.com/Tropos-AI/tropos-code-channels/releases/download/channels/stable.bak");
    expect(RELEASE_URLS.asset("1.2.3", "manifest.json")).toBe("https://github.com/Tropos-AI/tropos-code/releases/download/v1.2.3/manifest.json");
    expect(RELEASE_URLS.latestAsset("manifest.json")).toBe("https://github.com/Tropos-AI/tropos-code/releases/latest/download/manifest.json");
  });

  test("a separate channels repository", () => {
    const u = githubReleaseUrls({ channelsRepo: "o/channels" });
    expect(u.channel("latest")).toBe("https://github.com/o/channels/releases/download/channels/latest");
    expect(u.asset("1.0.0", "x")).toBe("https://github.com/Tropos-AI/tropos-code/releases/download/v1.0.0/x");
  });

  test("refuses to build URLs from non-versions or odd names", () => {
    expect(() => RELEASE_URLS.asset("../1.0.0", "x")).toThrow("not a version");
    expect(() => RELEASE_URLS.asset("1.0.0", "../x")).toThrow("bad asset name");
    expect(() => RELEASE_URLS.channel("latest/../x")).toThrow("bad channel slot");
  });
});
