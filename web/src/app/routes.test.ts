import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { EXTENSIONS_TABS, PAGES, redirectHash, SETTINGS_TABS, STATUS_TABS } from "@/app/routes";
import { withDom } from "@/test-setup";

withDom();
const { renderHook, cleanup } = await import("@testing-library/react");
const { useRoute } = await import("@/app/routes");
const { useHashTab } = await import("@/app/use-hash-tab");

describe("redirectHash", () => {
  test.each([
    ["#/mcp", "#/extensions/mcp"],
    ["#/hooks", "#/extensions/hooks"],
    ["#/plugins", "#/extensions/plugins"],
    ["#/logs", "#/status/logs"],
    ["#/usage", "#/status/usage"],
    ["#/channels", "#/settings/channels"],
    ["#/system", "#/settings/service"],
    ["#/config", "#/settings/advanced"],
    ["#/settings/providers", "#/settings/models"],
    ["#/settings/model", "#/settings/models"],
    ["#/settings/about", "#/settings/service"],
  ])("%s → %s", (from, to) => expect(redirectHash(from)).toBe(to));

  test.each(["#/settings/phone", "#/settings", "#/settings/models", "#/extensions/hooks", "#/status/logs", "#/chat", "", "#/nope"])("current hash %p is not redirected", (hash) =>
    expect(redirectHash(hash)).toBeNull(),
  );
});

describe("pages and tabs", () => {
  test("nine navigable pages plus Setup, and the tab ids other code relies on", () => {
    expect(PAGES.map((p) => p.id)).toEqual(["chat", "projects", "cron", "skills", "agents", "memory", "extensions", "status", "settings", "setup"]);
    expect(PAGES.filter((p) => "nav" in p && p.nav === false).map((p) => p.id)).toEqual(["setup"]);
    expect(SETTINGS_TABS).toEqual(["models", "autonomy", "channels", "phone", "suggestions", "service", "backups", "advanced"]);
    expect(STATUS_TABS).toEqual(["health", "logs", "usage"]);
    expect(EXTENSIONS_TABS).toEqual(["mcp", "hooks", "plugins"]);
  });
});

describe("useRoute", () => {
  beforeEach(() => window.history.replaceState(null, "", "#/chat"));
  afterEach(() => cleanup());

  test("a legacy hash is replaced in history, not pushed", () => {
    window.history.replaceState(null, "", "#/config");
    const replace = spyOn(window.history, "replaceState");
    const push = spyOn(window.history, "pushState");
    const { result } = renderHook(() => useRoute());
    expect(replace).toHaveBeenCalledWith(null, "", "#/settings/advanced");
    expect(push).not.toHaveBeenCalled();
    expect(result.current[0]).toBe("settings");
    expect(window.location.hash).toBe("#/settings/advanced");
    replace.mockRestore();
    push.mockRestore();
  });

  test("a legacy hash typed while the app is open is redirected too", async () => {
    const { result } = renderHook(() => useRoute());
    const { act } = await import("@testing-library/react");
    await act(async () => {
      window.location.hash = "#/usage";
      window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    });
    expect(window.location.hash).toBe("#/status/usage");
    expect(result.current[0]).toBe("status");
  });
});

describe("useHashTab", () => {
  afterEach(() => cleanup());

  test("reads the tab from the hash, falls back, and writes with replaceState", async () => {
    window.history.replaceState(null, "", "#/status/logs");
    const { result } = renderHook(() => useHashTab("status", STATUS_TABS, "health"));
    expect(result.current[0]).toBe("logs");
    const { act } = await import("@testing-library/react");
    act(() => result.current[1]("usage"));
    expect(result.current[0]).toBe("usage");
    expect(window.location.hash).toBe("#/status/usage");
  });

  test("an unknown tab, another page's tab, or a legacy hash resolve sensibly", () => {
    window.history.replaceState(null, "", "#/status/nope");
    expect(renderHook(() => useHashTab("status", STATUS_TABS, "health")).result.current[0]).toBe("health");
    window.history.replaceState(null, "", "#/logs");
    expect(renderHook(() => useHashTab("status", STATUS_TABS, "health")).result.current[0]).toBe("logs");
    window.history.replaceState(null, "", "#/settings/about");
    expect(renderHook(() => useHashTab("settings", SETTINGS_TABS, "models")).result.current[0]).toBe("service");
  });
});
