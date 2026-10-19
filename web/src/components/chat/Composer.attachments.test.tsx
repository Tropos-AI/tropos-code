import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent, waitFor, within } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { Composer } = await import("@/components/chat/Composer");
const { connectedStore, withProviders, IDLE } = await import("@/components/chat/chat-test-kit");

afterEach(() => cleanup());

function Harness() {
  const [value, setValue] = useState("");
  return createElement(Composer, { value, onValueChange: setValue });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = (name = "shot.png") => new File([PNG], name, { type: "image/png" });
const b64 = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64");
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

function mount() {
  const ctx = connectedStore();
  const view = render(withProviders(ctx.store, createElement(Harness)));
  const box = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
  const form = screen.getByRole("form", { name: "Message Tropos" });
  const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  const pick = async (...files: File[]) => {
    await act(async () => {
      fireEvent.change(fileInput, { target: { files } });
    });
  };
  const paste = (data: { files?: File[]; text?: string }) =>
    fireEvent.paste(box, { clipboardData: { files: data.files ?? [], items: [], types: data.files?.length ? ["Files"] : ["text/plain"], getData: () => data.text ?? "" } });
  return { ...ctx, box, form, fileInput, pick, paste };
}

const tray = () => screen.getByRole("list", { name: "Attachments" });

describe("Composer attachments", () => {
  test("the attach button picks images; a thumbnail shows, × removes it", async () => {
    const { pick } = mount();
    expect(screen.getByRole("button", { name: "Attach images or files" })).toBeTruthy();
    await pick(png());
    await waitFor(() => expect(screen.getByRole("img", { name: "shot.png" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  test("attachments alone can be sent; they go in the prompt RPC and the tray empties", async () => {
    const { socket, pick } = mount();
    const send = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    await pick(png());
    await waitFor(() => expect(send().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(send());
    });
    expect(socket.rpcs("prompt")[0]?.params).toEqual({ text: "", attachments: [{ name: "shot.png", mediaType: "image/png", data: b64(PNG) }] });
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  test("pasting an image from the clipboard attaches it instead of typing anything", async () => {
    const { box, paste } = mount();
    await act(async () => {
      paste({ files: [png("clip.png")] });
    });
    await waitFor(() => expect(screen.getByRole("img", { name: "clip.png" })).toBeTruthy());
    expect(box.value).toBe("");
  });

  test("dropping files on the composer attaches them; a text file becomes a file chip", async () => {
    const { form } = mount();
    await act(async () => {
      fireEvent.dragOver(form, { dataTransfer: { types: ["Files"], files: [] } });
    });
    expect(form.getAttribute("data-dragging")).toBe("true");
    await act(async () => {
      fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [png("drop.png"), new File(["a\nb\n"], "notes.md", { type: "text/markdown" })] } });
    });
    await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getByRole("img", { name: "drop.png" })).toBeTruthy();
    expect(within(tray()).getByText("notes.md")).toBeTruthy();
    expect(form.getAttribute("data-dragging")).toBe("false");
  });

  test("a big paste becomes a 'Pasted text' chip that opens a preview, is sent as pasted-1.txt, and the box stays empty", async () => {
    const { box, socket, paste } = mount();
    const text = lines(312);
    await act(async () => {
      paste({ text });
    });
    expect(box.value).toBe("");
    const chip = within(tray()).getByRole("button", { name: /Pasted text · 312 lines/ });
    fireEvent.click(chip);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/line 312/)).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.change(box, { target: { value: "summarise this", selectionStart: 14, selectionEnd: 14 } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(socket.rpcs("prompt")[0]?.params).toEqual({ text: "summarise this", attachments: [{ name: "pasted-1.txt", mediaType: "text/plain", data: b64(text) }] });
  });

  test("a short paste is typed as usual", async () => {
    const { paste } = mount();
    const event = paste({ text: "just a line" });
    expect(event).toBe(true); // not prevented
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  test("an unsupported file is refused with a toast; a ninth image too", async () => {
    const { store, pick } = mount();
    await pick(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
    await waitFor(() => expect(store.getState().toasts.at(-1)?.description).toContain("only PNG, JPEG, GIF and WebP"));
    await pick(...Array.from({ length: 9 }, (_, i) => png(`${i}.png`)));
    await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(8));
    expect(store.getState().toasts.at(-1)?.description).toContain("Up to 8 images");
  });

  test("while busy, a message with attachments queues with them", async () => {
    const { store, socket, box, pick } = mount();
    await act(async () => socket.deliver({ t: "state", state: { ...IDLE, busy: true } }));
    await pick(png());
    await waitFor(() => expect(screen.getByRole("img", { name: "shot.png" })).toBeTruthy());
    fireEvent.change(box, { target: { value: "later", selectionStart: 5, selectionEnd: 5 } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(store.getState().queue).toEqual([{ id: 1, text: "later", attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", data: b64(PNG) }] }]);
  });
});
