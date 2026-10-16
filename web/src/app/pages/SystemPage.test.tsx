import { afterEach, describe, expect, test } from "bun:test";

import type { BackupInfo, UpdateStatus } from "@core/web/admin/api";

import { mountAdmin, type AdminHandlers } from "@/components/admin/admin-test-kit";
import { stubClipboard, stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { SystemPage } = await import("@/app/pages/SystemPage");

const UPDATE: UpdateStatus = { current: "0.4.1", channel: "latest", latest: "0.5.0", available: true, checkedAt: "2026-10-14T10:00:00Z", autoUpdates: false };
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

afterEach(() => cleanup());

describe("SystemPage service", () => {
  test("shows the state, the unit and log paths, and restarts", async () => {
    stubMatchMedia();
    let restarted = false;
    const { socket } = await mountAdmin(SystemPage, handlers({ "service.restart": () => ((restarted = true), { manager: "launchd", installed: true, running: true, pid: 100 }) }));
    await screen.findByText("/Users/me/Library/LaunchAgents/dev.tropos.plist");
    expect(screen.getByText("/Users/me/.tropos/gateway/gateway.log")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await screen.findByText("Restarted. Running (pid 100).");
    expect(restarted).toBe(true);
    await waitFor(() => expect(socket.callsOf("service.status").length).toBe(2));
  });

  test("uninstalling the service asks first", async () => {
    stubMatchMedia();
    let removed = 0;
    const { socket } = await mountAdmin(SystemPage, handlers({ "service.uninstall": () => ((removed += 1), { removed: true }) }));
    const section = (await screen.findByRole("region", { name: /^Service/ })) as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: "Uninstall" }));
    expect(removed).toBe(0);
    expect(within(section).getByText(/Remove the service\?/)).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Cancel" }));
    expect(within(section).queryByText(/Remove the service\?/)).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Uninstall" }));
    fireEvent.click(within(section).getByRole("button", { name: "Remove service" }));
    await within(section).findByText(/Removed\. Tropos will no longer start at login/);
    expect(socket.callsOf("service.uninstall").length).toBe(1);
  });

  test("a failing service call shows the error in the live region", async () => {
    stubMatchMedia();
    await mountAdmin(SystemPage, handlers({ "service.restart": () => { throw new Error("launchctl failed"); } }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    const alert = await screen.findByText("launchctl failed");
    expect(alert.closest("[role=alert]")).toBeTruthy();
  });

  test("a section that cannot load shows a calm error with Retry while the others work", async () => {
    stubMatchMedia();
    await mountAdmin(SystemPage, handlers({ "service.status": () => { throw new Error("Not available in the demo."); } }));
    await screen.findByText("Couldn't load the service status");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(await screen.findByText("v0.4.1")).toBeTruthy();
  });
});

describe("SystemPage sandbox", () => {
  test("Pull image passes pull:true and reports the result", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(SystemPage, handlers({ "sandbox.check": (p) => ((p as { pull?: boolean } | undefined)?.pull ? { ok: true, docker: true, image: "tropos/sandbox:1", imagePresent: true } : { ok: false, docker: true, image: "tropos/sandbox:1", imagePresent: false }) }));
    await screen.findByText("Image missing");
    fireEvent.click(screen.getByRole("button", { name: "Pull image" }));
    await screen.findByText("The sandbox image tropos/sandbox:1 is ready.");
    expect(socket.callsOf("sandbox.check").at(-1)!.params).toEqual({ pull: true });
    expect(screen.getByText("Image present")).toBeTruthy();
  });
});

describe("SystemPage updates", () => {
  test("shows current vs latest; Update now confirms, runs and explains the restart", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(SystemPage, handlers({ "update.run": () => ({ ok: true, from: "0.4.1", to: "0.5.0", message: "Updated 0.4.1 to 0.5.0." }) }));
    await screen.findByText("Update available");
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(socket.callsOf("update.run").length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    await screen.findByText(/Updated 0\.4\.1 to 0\.5\.0\./);
    expect(screen.getByText(/runs after you restart the gateway/)).toBeTruthy();
    expect(socket.callsOf("update.run").length).toBe(1);
  });

  test("changes the channel, the auto-update switch and checks now", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(
      SystemPage,
      handlers({
        "update.setChannel": (p) => ({ ...UPDATE, channel: (p as { channel: "latest" | "stable" }).channel }),
        "update.setAuto": (p) => ({ ...UPDATE, autoUpdates: (p as { enabled: boolean }).enabled }),
        "update.check": () => ({ ...UPDATE, available: false, latest: "0.4.1" }),
      }),
    );
    const select = (await screen.findByLabelText("Release channel")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "stable" } });
    await waitFor(() => expect(socket.callsOf("update.setChannel")[0]?.params).toEqual({ channel: "stable" }));
    await waitFor(() => expect((screen.getByLabelText("Release channel") as HTMLSelectElement).value).toBe("stable"));
    const toggle = screen.getByRole("switch", { name: "Install updates automatically" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Install updates automatically" }).getAttribute("aria-checked")).toBe("true"));
    expect(socket.callsOf("update.setAuto")[0]!.params).toEqual({ enabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await screen.findByText("You are on the newest version.");
  });
});

describe("SystemPage backups", () => {
  test("creates a backup with the chosen options", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(SystemPage, handlers({ "backup.create": () => ({ ...BACKUP, name: "new.tar.gz" }) }));
    await screen.findByText(BACKUP.name);
    fireEvent.click(screen.getByLabelText(/Secrets/));
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await screen.findByText(/Created new\.tar\.gz/);
    expect(socket.callsOf("backup.create")[0]!.params).toEqual({ quick: false, sessions: true, secrets: true });
  });

  test("lists size and date, and verifies", async () => {
    stubMatchMedia();
    await mountAdmin(SystemPage, handlers({ "backup.verify": () => ({ ok: false, problems: ["credentials.json: checksum mismatch"] }) }));
    await screen.findByText("2.4 MB");
    fireEvent.click(screen.getByRole("button", { name: `Verify ${BACKUP.name}` }));
    await screen.findByText(/checksum mismatch/);
  });

  test("restore previews with a dry run, then restores only after confirming", async () => {
    stubMatchMedia();
    const calls: unknown[] = [];
    const { socket } = await mountAdmin(
      SystemPage,
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
    expect(socket.callsOf("backup.list").length).toBeGreaterThan(1);
    expect(screen.queryByText("Would restore")).toBeNull();
  });

  test("a backup with files that can run code shows them in a warning and only sends trustCode after a second confirm", async () => {
    stubMatchMedia();
    const calls: unknown[] = [];
    await mountAdmin(
      SystemPage,
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
    await mountAdmin(SystemPage, handlers({ "backup.restore": (p) => (calls.push(p), { restored: ["SOUL.md"], risky: [{ path: "SOUL.md", why: "instructions" }] }) }));
    fireEvent.click(await screen.findByRole("button", { name: `Restore ${BACKUP.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls).toEqual([{ name: BACKUP.name, dryRun: true }]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("delete asks first", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(SystemPage, handlers({ "backup.delete": () => ({ removed: true }) }));
    fireEvent.click(await screen.findByRole("button", { name: `Delete ${BACKUP.name}` }));
    expect(socket.callsOf("backup.delete").length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete backup" }));
    await screen.findByText(`Deleted ${BACKUP.name}.`);
    expect(socket.callsOf("backup.delete")[0]!.params).toEqual({ name: BACKUP.name });
  });

  test("an empty list says so", async () => {
    stubMatchMedia();
    await mountAdmin(SystemPage, handlers({ "backup.list": () => [] }));
    await screen.findByText(/No backups yet/);
  });
});

describe("SystemPage uninstall", () => {
  test("shows the three commands with copy buttons", async () => {
    stubMatchMedia();
    const written = stubClipboard();
    await mountAdmin(SystemPage, handlers());
    expect(await screen.findByText("tcode uninstall --all")).toBeTruthy();
    expect(screen.getByText("tcode uninstall --dry-run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy tcode uninstall --dry-run" }));
    await waitFor(() => expect(written).toEqual(["tcode uninstall --dry-run"]));
  });
});
