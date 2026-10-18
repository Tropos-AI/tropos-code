import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PairingView } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { createElement } = await import("react");
const { OwnerPicker } = await import("@/components/pages/settings/owner-picker");

const approved = (ids: string[]): PairingView["approved"] => ids.map((senderId) => ({ channel: "telegram", senderId, approvedAt: 1 }));

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

function mount(pairing: PairingView, handlers: Parameters<typeof mountAdminPage>[1] = {}) {
  let changed = 0;
  const Page = () => createElement(OwnerPicker, { pairing, onChanged: () => (changed += 1) });
  return mountAdminPage(Page, handlers).then((m) => ({ ...m, changed: () => changed }));
}

describe("OwnerPicker", () => {
  test("no owner with several approved senders: picker shown, /login explained as off until picked", async () => {
    const calls: unknown[] = [];
    const { changed } = await mount({ approved: approved(["u1", "u2"]), pending: [] }, { "pairing.setOwner": (p) => (calls.push(p), {}) });
    expect(screen.getByText(/Until you pick one, \/login is off\./)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Make owner" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Who is the owner?"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
    await waitFor(() => expect(calls).toEqual([{ channel: "telegram", senderId: "u2" }]));
    await waitFor(() => expect(changed()).toBe(1));
  });

  test("an owner set: shown with an Owner badge and a Change button", async () => {
    const calls: unknown[] = [];
    await mount({ approved: approved(["u1", "u2"]), pending: [], owner: { channel: "telegram", senderId: "u1" } }, { "pairing.setOwner": (p) => (calls.push(p), {}) });
    expect(screen.getByText("Owner", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("u1")).toBeTruthy();
    expect(screen.queryByText(/\/login is off/)).toBeNull();
    expect(screen.queryByLabelText("New owner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("New owner"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
    await waitFor(() => expect(calls).toEqual([{ channel: "telegram", senderId: "u2" }]));
  });

  test("Cancel closes the change form without a call", async () => {
    const calls: unknown[] = [];
    await mount({ approved: approved(["u1"]), pending: [], owner: { channel: "telegram", senderId: "u1" } }, { "pairing.setOwner": (p) => (calls.push(p), {}) });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New owner")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a refused change shows the error", async () => {
    await mount({ approved: approved(["u1"]), pending: [] }, { "pairing.setOwner": () => { throw new Error("not an approved sender"); } });
    fireEvent.change(screen.getByLabelText("Who is the owner?"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
    expect((await screen.findByText(/not an approved sender/)).closest("[role=alert]")).toBeTruthy();
  });

  test("nobody approved yet: asks for an approval first, no picker", async () => {
    await mount({ approved: [], pending: [] });
    expect(screen.getByText(/Approve a sender first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make owner" })).toBeNull();
  });
});
