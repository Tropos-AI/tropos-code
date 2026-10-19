import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { BackupInfo, UpdateStatus } from "@core/web/admin/api";
import type { ProviderInfoView } from "@core/web/protocol";

import { mountPage, stubClipboard, stubMatchMedia, type MountedPage } from "@/components/pages/page-test-kit";
import { mountAdminPage, type AdminHandlers } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { createElement, Fragment } = await import("react");
const { SettingsPage } = await import("@/app/pages/SettingsPage");
const { redactKey } = await import("@/components/pages/settings/connect-form");
const { ui, useModelPickerOpen } = await import("@/lib/ui-store");

const SECRET = "sk-test-VERY-SECRET-123456";

function providers(): { list: ProviderInfoView[]; saved: Set<string> } {
  const saved = new Set(["openrouter"]);
  const base: ProviderInfoView[] = [
    { id: "anthropic", name: "Anthropic", keyRequired: false, keyURL: "https://platform.claude.com/settings/keys", keyEnv: ["ANTHROPIC_API_KEY"], noKeyNote: "ANTHROPIC_API_KEY or `ant auth login`", key: { kind: "env", name: "ANTHROPIC_API_KEY" } },
    { id: "openai", name: "OpenAI", keyRequired: true, keyURL: "https://platform.openai.com/api-keys", keyEnv: ["OPENAI_API_KEY"], key: null },
    { id: "openrouter", name: "OpenRouter", keyRequired: true, keyURL: "https://openrouter.ai/settings/keys", keyEnv: ["OPENROUTER_API_KEY"], key: null },
    { id: "ollama", name: "Ollama", keyRequired: false, keyURL: null, keyEnv: [], key: null },
  ];
  return {
    saved,
    get list() {
      return base.map((p) => (p.key?.kind === "env" ? p : { ...p, key: saved.has(p.id) ? { kind: "saved" as const } : null }));
    },
  };
}

function PickerProbe() {
  return createElement("output", { "aria-label": "picker" }, useModelPickerOpen() ? "open" : "closed");
}

function WithProbe() {
  return createElement(Fragment, null, createElement(SettingsPage), createElement(PickerProbe));
}

async function mountSettings(overrides: Parameters<typeof mountPage>[1] = {}): Promise<MountedPage & { state: ReturnType<typeof providers> }> {
  const state = providers();
  const mounted = await mountPage(WithProbe, {
    "providers.status": () => state.list,
    "providers.connect": (params) => {
      state.saved.add((params as { id: string }).id);
      return null;
    },
    "providers.disconnect": (id) => state.saved.delete(String(id)),
    "modelPrefs.get": () => ({ favorites: ["claude-opus-5-5"], recent: ["claude-opus-5-5", "openrouter/qwen/qwen3-coder"] }),
    "modelPrefs.toggleFavorite": () => true,
    ...overrides,
  });
  return { ...mounted, state };
}

/** Lets exit animations finish: two animation frames inside act(). */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

/** True when the key shows up anywhere in the DOM: markup, attributes or a live input value. */
function keyInDom(key: string): boolean {
  if (document.body.innerHTML.includes(key)) return true;
  return Array.from(document.querySelectorAll("input")).some((input) => input.value.includes(key));
}

function row(name: string): HTMLElement {
  return screen.getByText(name, { selector: "strong" }).closest("li")!;
}

beforeEach(() => {
  stubMatchMedia();
  window.history.replaceState(null, "", "#/settings");
  ui.closeModelPicker();
});
afterEach(() => cleanup());

describe("helpers", () => {
  test("redactKey hides a key inside an error message", () => {
    expect(redactKey(`bad key ${SECRET}`, SECRET)).toBe("bad key ••••");
  });
});

describe("Settings › Providers", () => {
  test("lists providers with how each is connected, never a key", async () => {
    await mountSettings();
    await screen.findByText("Anthropic", { selector: "strong" });
    expect(row("Anthropic").textContent).toContain("connected · ANTHROPIC_API_KEY");
    expect(row("Anthropic").textContent).toContain("in use");
    expect(row("OpenRouter").textContent).toContain("connected · saved key");
    expect(row("OpenAI").textContent).toContain("not connected");
    expect(row("Ollama").textContent).toContain("no key needed");
    expect(within(row("OpenRouter")).getByRole("button", { name: "Disconnect OpenRouter" })).toBeTruthy();
    expect(within(row("Anthropic")).queryByRole("button", { name: /Disconnect|Connect/ })).toBeNull();
    expect(within(row("Ollama")).queryByRole("button")).toBeNull();
  });

  test("connect: validates, sends the key once, clears it from the DOM and refreshes", async () => {
    const { socket, store } = await mountSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    const form = screen.getByRole("form", { name: "Connect OpenAI" });
    const field = within(form).getByLabelText("OpenAI API key") as HTMLInputElement;
    expect(field.type).toBe("password");

    // Empty submit: inline validation, no RPC.
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(form.textContent).toContain("Paste a key first.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(socket.callsOf("providers.connect")).toHaveLength(0);

    fireEvent.change(field, { target: { value: `  ${SECRET}  ` } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(keyInDom(SECRET)).toBe(false);
    await waitFor(() => expect(socket.callsOf("providers.connect")).toEqual([{ method: "providers.connect", params: { id: "openai", key: SECRET } }]));
    await waitFor(() => expect(row("OpenAI").textContent).toContain("connected · saved key"));
    await settle();
    expect(screen.queryByRole("form", { name: "Connect OpenAI" })).toBeNull();
    expect(socket.callsOf("providers.status").length).toBeGreaterThanOrEqual(2);
    expect(store.getState().toasts.map((t) => t.title)).toContain("Connected OpenAI");
    expect(keyInDom(SECRET)).toBe(false);
    // Only the connect frame carried the key.
    expect(socket.frames.filter((f) => f.includes(SECRET))).toHaveLength(1);
  });

  test("connect failure: the error is shown with the key redacted, and the field is empty", async () => {
    await mountSettings({
      "providers.connect": (params) => {
        throw new Error(`rejected key ${(params as { key: string }).key}`);
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    const form = screen.getByRole("form", { name: "Connect OpenAI" });
    fireEvent.change(within(form).getByLabelText("OpenAI API key"), { target: { value: SECRET } });
    await act(async () => {
      fireEvent.submit(form);
    });
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("rejected key ••••");
    expect(keyInDom(SECRET)).toBe(false);
    expect((within(form).getByLabelText("OpenAI API key") as HTMLInputElement).value).toBe("");
  });

  test("Cancel closes the form; Create a key opens the provider's page safely", async () => {
    await mountSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    const link = screen.getByRole("link", { name: /Create a key/ });
    expect(link.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(screen.queryByRole("form", { name: "Connect OpenAI" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect OpenAI" })).toBeTruthy();
  });

  test("disconnect removes a saved key and refreshes", async () => {
    const { socket, store } = await mountSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect OpenRouter" }));
    await waitFor(() => expect(row("OpenRouter").textContent).toContain("not connected"));
    expect(socket.callsOf("providers.disconnect")).toEqual([{ method: "providers.disconnect", params: "openrouter" }]);
    expect(store.getState().toasts.map((t) => t.title)).toContain("Disconnected OpenRouter");
    expect(within(row("OpenRouter")).getByRole("button", { name: "Connect OpenRouter" })).toBeTruthy();
  });

  test("a failed status load shows Retry", async () => {
    let calls = 0;
    await mountSettings({
      "providers.status": () => {
        calls += 1;
        if (calls === 1) throw new Error("credentials unreadable");
        return providers().list;
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("credentials unreadable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Anthropic", { selector: "strong" })).toBeTruthy();
  });
});

describe("Settings › Models & keys and About", () => {
  test("Model shows the session's model, opens the picker, and lists favourites and recent", async () => {
    const { socket } = await mountSettings();
    const panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("This session")).toBeTruthy();
    expect(screen.getByRole("status", { name: "picker" }).textContent).toBe("closed");
    fireEvent.click(within(panel).getByRole("button", { name: /Change model/ }));
    expect(screen.getByRole("status", { name: "picker" }).textContent).toBe("open");

    const favourites = await within(panel).findByRole("region", { name: "Favourites" });
    expect(favourites.textContent).toContain("claude-opus-5-5");
    expect(within(favourites).getByText("current")).toBeTruthy();
    const recent = within(panel).getByRole("region", { name: "Recent" });
    expect(recent.textContent).toContain("qwen/qwen3-coder");
    expect(recent.textContent).toContain("OpenRouter");
    fireEvent.click(within(recent).getByRole("button", { name: "Add openrouter/qwen/qwen3-coder to favourites" }));
    await waitFor(() => expect(socket.callsOf("modelPrefs.toggleFavorite")).toEqual([{ method: "modelPrefs.toggleFavorite", params: "openrouter/qwen/qwen3-coder" }]));
  });

  test("About shows version, cwd and session id with copy buttons", async () => {
    await mountSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Service & updates" }));
    expect(window.location.hash).toBe("#/settings/service");
    const panel = await screen.findByRole("tabpanel");
    expect(panel.textContent).toContain("0.5.0");
    expect(panel.textContent).toContain("/repo");
    expect(panel.textContent).toContain("6f1c2d9a-4b7e-4e21-9c3a-1d2e3f4a5b6c");
    for (const label of ["Copy the version", "Copy the working directory", "Copy the session id"]) {
      expect(within(panel).getByRole("button", { name: label })).toBeTruthy();
    }
    const docs = within(panel).getByRole("link", { name: /README/ });
    expect(docs.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

// ---------- the five tabs (what the old System, Config and Channels pages became) ----------


const UPDATE: UpdateStatus = { current: "0.5.0", channel: "latest", latest: "0.6.0", available: true, checkedAt: "2026-10-14T10:00:00Z", autoUpdates: false };
const BACKUP: BackupInfo = { name: "tropos-2026-10-14.tar.gz", path: "/b/x", size: 2_500_000, createdAt: "2026-10-14T10:00:00Z", secrets: false, sessions: true };

function handlers(over: AdminHandlers = {}): AdminHandlers {
  return {
    "service.status": () => ({ manager: "launchd", installed: true, running: true, pid: 99, unitPath: "/Users/me/Library/LaunchAgents/dev.tropos.plist", logPath: "/Users/me/.tropos/gateway/gateway.log" }),
    "sandbox.check": () => ({ ok: false, docker: true, image: "tropos/sandbox:1", imagePresent: false }),
    "update.status": () => UPDATE,
    "backup.list": () => [BACKUP],
    ...over,
  };
}


/** Opens Settings on one tab with admin answers (service, update, backups …). */
async function mountSettingsTab(tab: string, admin: AdminHandlers) {
  window.history.replaceState(null, "", `#/settings/${tab}`);
  return mountAdminPage(SettingsPage, admin, { "providers.status": () => [], "modelPrefs.get": () => ({ favorites: [], recent: [] }) });
}

describe("Settings › Service & updates › service", () => {
  test("shows the state, the unit and log paths, and restarts", async () => {
    stubMatchMedia();
    let restarted = false;
    const { socket } = await mountSettingsTab("service", handlers({ "service.restart": () => ((restarted = true), { manager: "launchd", installed: true, running: true, pid: 100 }) }));
    await screen.findByText("/Users/me/Library/LaunchAgents/dev.tropos.plist");
    expect(screen.getByText("/Users/me/.tropos/gateway/gateway.log")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await screen.findByText("Restarted. Running (pid 100).");
    expect(restarted).toBe(true);
    await waitFor(() => expect(socket.adminOf("service.status").length).toBe(2));
  });

  test("uninstalling the service asks first", async () => {
    stubMatchMedia();
    let removed = 0;
    const { socket } = await mountSettingsTab("service", handlers({ "service.uninstall": () => ((removed += 1), { removed: true }) }));
    const section = (await screen.findByRole("region", { name: /^Service/ })) as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: "Uninstall" }));
    expect(removed).toBe(0);
    expect(within(section).getByText(/Remove the service\?/)).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Cancel" }));
    expect(within(section).queryByText(/Remove the service\?/)).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Uninstall" }));
    fireEvent.click(within(section).getByRole("button", { name: "Remove service" }));
    await within(section).findByText(/Removed\. Tropos will no longer start at login/);
    expect(socket.adminOf("service.uninstall").length).toBe(1);
  });

  test("a failing service call shows the error in the live region", async () => {
    stubMatchMedia();
    await mountSettingsTab("service", handlers({ "service.restart": () => { throw new Error("launchctl failed"); } }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    const alert = await screen.findByText("launchctl failed");
    expect(alert.closest("[role=alert]")).toBeTruthy();
  });

  test("a section that cannot load shows a calm error with Retry while the others work", async () => {
    stubMatchMedia();
    await mountSettingsTab("service", handlers({ "service.status": () => { throw new Error("Not available in the demo."); } }));
    await screen.findByText("Couldn't load the service status");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(await screen.findByText("v0.5.0")).toBeTruthy();
  });
});

describe("Settings › Advanced › sandbox", () => {
  test("Pull image passes pull:true and reports the result", async () => {
    stubMatchMedia();
    const { socket } = await mountSettingsTab("advanced", handlers({ "sandbox.check": (p) => ((p as { pull?: boolean } | undefined)?.pull ? { ok: true, docker: true, image: "tropos/sandbox:1", imagePresent: true } : { ok: false, docker: true, image: "tropos/sandbox:1", imagePresent: false }) }));
    await screen.findByText("Image missing");
    fireEvent.click(screen.getByRole("button", { name: "Pull image" }));
    await screen.findByText("The sandbox image tropos/sandbox:1 is ready.");
    expect(socket.adminOf("sandbox.check").at(-1)!.params).toEqual({ pull: true });
    expect(screen.getByText("Image present")).toBeTruthy();
  });
});

describe("Settings › Service & updates › updates", () => {
  test("shows current vs latest; Update now confirms, runs and explains the restart", async () => {
    stubMatchMedia();
    const { socket } = await mountSettingsTab("service", handlers({ "update.run": () => ({ ok: true, from: "0.5.0", to: "0.6.0", message: "Updated 0.5.0 to 0.6.0." }) }));
    await screen.findByText("Update available");
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(socket.adminOf("update.run").length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    await screen.findByText(/Updated 0\.5\.0 to 0\.6\.0\./);
    expect(screen.getByText(/runs after you restart the gateway/)).toBeTruthy();
    expect(socket.adminOf("update.run").length).toBe(1);
  });

  test("changes the channel, the auto-update switch and checks now", async () => {
    stubMatchMedia();
    const { socket } = await mountSettingsTab("service",
      handlers({
        "update.setChannel": (p) => ({ ...UPDATE, channel: (p as { channel: "latest" | "stable" }).channel }),
        "update.setAuto": (p) => ({ ...UPDATE, autoUpdates: (p as { enabled: boolean }).enabled }),
        "update.check": () => ({ ...UPDATE, available: false, latest: "0.5.0" }),
      }),
    );
    const select = (await screen.findByLabelText("Release channel")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "stable" } });
    await waitFor(() => expect(socket.adminOf("update.setChannel")[0]?.params).toEqual({ channel: "stable" }));
    await waitFor(() => expect((screen.getByLabelText("Release channel") as HTMLSelectElement).value).toBe("stable"));
    const toggle = screen.getByRole("switch", { name: "Install updates automatically" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Install updates automatically" }).getAttribute("aria-checked")).toBe("true"));
    expect(socket.adminOf("update.setAuto")[0]!.params).toEqual({ enabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await screen.findByText("You are on the newest version.");
  });
});

describe("Settings › Backups › backups", () => {
  test("creates a backup with the chosen options", async () => {
    stubMatchMedia();
    const { socket } = await mountSettingsTab("backups", handlers({ "backup.create": () => ({ ...BACKUP, name: "new.tar.gz" }) }));
    await screen.findByText(BACKUP.name);
    fireEvent.click(screen.getByLabelText(/Secrets/));
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await screen.findByText(/Created new\.tar\.gz/);
    expect(socket.adminOf("backup.create")[0]!.params).toEqual({ quick: false, sessions: true, secrets: true });
  });

  test("lists size and date, and verifies", async () => {
    stubMatchMedia();
    await mountSettingsTab("backups", handlers({ "backup.verify": () => ({ ok: false, problems: ["credentials.json: checksum mismatch"] }) }));
    await screen.findByText("2.4 MB");
    fireEvent.click(screen.getByRole("button", { name: `Verify ${BACKUP.name}` }));
    await screen.findByText(/checksum mismatch/);
  });

  test("restore previews with a dry run, then restores only after confirming", async () => {
    stubMatchMedia();
    const calls: unknown[] = [];
    const { socket } = await mountSettingsTab("backups",
      handlers({
        "backup.restore": (p) => {
          calls.push(p);
          return (p as { dryRun?: boolean }).dryRun ? { restored: ["settings.json", "gateway.json"], risky: [] } : { restored: ["settings.json", "gateway.json"], risky: [], safetyBackup: "before-restore.tar.gz" };
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: `Restore ${BACKUP.name}` }));
    await screen.findByText("settings.json");
    expect(calls).toEqual([{ name: BACKUP.name, dryRun: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Restore now" }));
    await screen.findByText(/Restored 2 files.*before-restore\.tar\.gz/);
    expect(calls[1]).toEqual({ name: BACKUP.name });
    expect(socket.adminOf("backup.list").length).toBeGreaterThan(1);
    expect(screen.queryByText("Would restore")).toBeNull();
  });

  test("a backup with files that can run code shows them in a warning and only sends trustCode after a second confirm", async () => {
    stubMatchMedia();
    const calls: unknown[] = [];
    await mountSettingsTab("backups",
      handlers({
        "backup.restore": (p) => {
          calls.push(p);
          const risky = [{ path: "skills/x/SKILL.md", why: "a skill: instructions the agent follows" }];
          return (p as { dryRun?: boolean }).dryRun ? { restored: ["skills/x/SKILL.md", "memories/a.md"], risky } : { restored: ["skills/x/SKILL.md", "memories/a.md"], risky };
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: `Restore ${BACKUP.name}` }));
    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("can run code or let people in");
    expect(within(warning).getByText("skills/x/SKILL.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // The first confirm restores nothing.
    expect(calls).toEqual([{ name: BACKUP.name, dryRun: true }]);
    fireEvent.click(await screen.findByRole("button", { name: "I trust it, restore" }));
    await screen.findByText(/Restored 2 files/);
    expect(calls[1]).toEqual({ name: BACKUP.name, trustCode: true });
  });

  test("cancelling the trust question restores nothing", async () => {
    stubMatchMedia();
    const calls: unknown[] = [];
    await mountSettingsTab("backups", handlers({ "backup.restore": (p) => (calls.push(p), { restored: ["SOUL.md"], risky: [{ path: "SOUL.md", why: "instructions" }] }) }));
    fireEvent.click(await screen.findByRole("button", { name: `Restore ${BACKUP.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls).toEqual([{ name: BACKUP.name, dryRun: true }]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("delete asks first", async () => {
    stubMatchMedia();
    const { socket } = await mountSettingsTab("backups", handlers({ "backup.delete": () => ({ removed: true }) }));
    fireEvent.click(await screen.findByRole("button", { name: `Delete ${BACKUP.name}` }));
    expect(socket.adminOf("backup.delete").length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete backup" }));
    await screen.findByText(`Deleted ${BACKUP.name}.`);
    expect(socket.adminOf("backup.delete")[0]!.params).toEqual({ name: BACKUP.name });
  });

  test("an empty list says so", async () => {
    stubMatchMedia();
    await mountSettingsTab("backups", handlers({ "backup.list": () => [] }));
    await screen.findByText(/No backups yet/);
  });
});

describe("Settings › Advanced › uninstall", () => {
  test("shows the three commands with copy buttons", async () => {
    stubMatchMedia();
    const written = stubClipboard();
    await mountSettingsTab("advanced", handlers());
    expect(await screen.findByText("tcode uninstall --all")).toBeTruthy();
    expect(screen.getByText("tcode uninstall --dry-run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy tcode uninstall --dry-run" }));
    await waitFor(() => expect(written).toEqual(["tcode uninstall --dry-run"]));
  });
});

describe("Settings › tabs", () => {
  test("Models & keys, Autonomy, Channels & devices, Phone access, Suggestions, Service & updates, Backups and Advanced", async () => {
    stubMatchMedia();
    await mountSettingsTab("models", handlers());
    await screen.findAllByRole("tab");
    const names = ["Models & keys", "Autonomy", "Channels & devices", "Phone access", "Suggestions", "Service & updates", "Backups", "Advanced"];
    expect(screen.getAllByRole("tab").map((tab) => names.find((n) => tab.textContent === `${n}${n}`))).toEqual(names);
  });

  test("#/settings/advanced opens the raw config editor and the Docker sandbox", async () => {
    stubMatchMedia();
    await mountSettingsTab("advanced", handlers({ "config.get": () => { throw new Error("no config in this test"); } }));
    expect(await screen.findByRole("region", { name: /^Sandbox/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Advanced" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tablist", { name: "Config files" })).toBeTruthy();
  });

  test("a legacy hash lands on its tab", async () => {
    stubMatchMedia();
    window.history.replaceState(null, "", "#/settings/about");
    await mountAdminPage(SettingsPage, handlers(), { "providers.status": () => [], "modelPrefs.get": () => ({ favorites: [], recent: [] }) });
    expect(screen.getByRole("tab", { name: "Service & updates" }).getAttribute("aria-selected")).toBe("true");
  });

  test("Run setup again calls onboard.reopen and goes to #/setup", async () => {
    stubMatchMedia();
    const { socket } = await mountSettingsTab("service", handlers({ "onboard.reopen": () => ({ completed: false }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Run setup again" }));
    await waitFor(() => expect(window.location.hash).toBe("#/setup"));
    expect(socket.adminOf("onboard.reopen")).toHaveLength(1);
  });

  test("Run setup again stays put and shows the error when reopening fails", async () => {
    stubMatchMedia();
    await mountSettingsTab("service", handlers({ "onboard.reopen": () => { throw new Error("disk full"); } }));
    fireEvent.click(await screen.findByRole("button", { name: "Run setup again" }));
    expect((await screen.findByText("disk full")).closest("[role=alert]")).toBeTruthy();
    expect(window.location.hash).toBe("#/settings/service");
  });
});

describe("Settings › Advanced › Commands from chats run", () => {
  const VIEW = { level: "balanced", backend: "docker", confinement: null, unconfinedAccepted: false, unconfined: false, projects: [] } as const;

  test("switching to this computer without OS confinement asks for the run-unconfined consent first", async () => {
    stubMatchMedia();
    const calls: unknown[] = [];
    await mountSettingsTab("advanced", handlers({ "autonomy.get": () => VIEW, "autonomy.setBackend": (p) => (calls.push(p), { ...VIEW, backend: "host", unconfinedAccepted: true, unconfined: true }) }));
    const select = (await screen.findByLabelText("Where")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "host" } });
    expect(await screen.findByText("Commands would run without the OS sandbox")).toBeTruthy();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Run unconfined" }));
    await waitFor(() => expect(calls).toEqual([{ backend: "host", acceptUnconfined: true }]));
    await settle();
  });

  test("cancelling the consent sends nothing and the control never writes config", async () => {
    stubMatchMedia();
    const calls: unknown[] = [];
    const host = { ...VIEW, backend: "host" } as const;
    const { socket } = await mountSettingsTab("advanced", handlers({ "autonomy.get": () => VIEW, "autonomy.setBackend": (p) => (calls.push(p), host) }));
    const select = (await screen.findByLabelText("Where")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "host" } });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await settle();
    expect(calls).toEqual([]);
    expect(socket.adminOf("config.set")).toHaveLength(0);
  });

  test("with OS confinement the switch goes straight through", async () => {
    stubMatchMedia();
    const calls: unknown[] = [];
    const confined = { ...VIEW, confinement: "sandbox-exec" } as const;
    await mountSettingsTab("advanced", handlers({ "autonomy.get": () => confined, "autonomy.setBackend": (p) => (calls.push(p), { ...confined, backend: "host" }) }));
    fireEvent.change((await screen.findByLabelText("Where")) as HTMLSelectElement, { target: { value: "host" } });
    await waitFor(() => expect(calls).toEqual([{ backend: "host" }]));
  });
});
