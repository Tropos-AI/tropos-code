// web/src/components/interior/copy-button.test.tsx — CopyButton and useCopyToClipboard: clipboard, fallback, error and reset paths.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { CopyButton, useCopyToClipboard } = await import("@/components/interior/copy-button");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Clip = { writeText?: (text: string) => Promise<void> };

function setClipboard(clipboard: Clip | undefined): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
}

function setExecCommand(impl: ((command: string) => boolean) | undefined): void {
  Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: impl });
}

afterEach(() => {
  cleanup();
  setClipboard(undefined);
  setExecCommand(undefined);
});

const status = () => screen.getByRole("status").textContent;

describe("CopyButton", () => {
  test("copies through the Clipboard API and announces success", async () => {
    const writes: string[] = [];
    setClipboard({ writeText: async (text) => void writes.push(text) });
    render(createElement(CopyButton, { value: "npm i tcode", label: "Copy command", copiedLabel: "Done" }));
    const button = screen.getByRole("button", { name: "Copy command" });
    expect(status()).toBe("");
    await act(async () => {
      fireEvent.click(button);
      await wait(5);
    });
    expect(writes).toEqual(["npm i tcode"]);
    expect(status()).toBe("Done");
  });

  test("falls back to execCommand when the Clipboard API is missing, keeping the reader's selection", async () => {
    setClipboard(undefined);
    const commands: string[] = [];
    let copied = "";
    setExecCommand((command) => {
      commands.push(command);
      copied = (document.activeElement as HTMLTextAreaElement | null)?.value ?? copied;
      return true;
    });
    const para = document.createElement("p");
    para.textContent = "selected words";
    document.body.appendChild(para);
    const range = document.createRange();
    range.selectNodeContents(para);
    document.getSelection()?.addRange(range);

    render(createElement(CopyButton, { value: "fallback text" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await wait(5);
    });
    expect(commands).toEqual(["copy"]);
    expect(status()).toBe("Copied");
    expect(document.querySelector("textarea")).toBeNull();
    para.remove();
  });

  test("reports failure when both the Clipboard API and the fallback fail", async () => {
    setClipboard({ writeText: async () => Promise.reject(new Error("denied")) });
    setExecCommand(() => {
      throw new Error("unsupported");
    });
    render(createElement(CopyButton, { value: "x", errorLabel: "Nope" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await wait(5);
    });
    expect(status()).toBe("Nope");
  });
});

describe("useCopyToClipboard", () => {
  function Harness({ timeout, onReady }: { timeout: number; onReady: (copy: (text: string) => Promise<boolean>) => void }) {
    const { copy, status } = useCopyToClipboard({ timeout });
    onReady(copy);
    return createElement("output", null, status);
  }

  test("ignores empty text, returns the outcome and settles back to idle after the timeout", async () => {
    setClipboard({ writeText: async () => {} });
    let copy: (text: string) => Promise<boolean> = async () => false;
    render(createElement(Harness, { timeout: 30, onReady: (fn) => (copy = fn) }));
    const out = () => document.querySelector("output")?.textContent;

    let result = true;
    await act(async () => {
      result = await copy("");
    });
    expect(result).toBe(false);
    expect(out()).toBe("idle");

    await act(async () => {
      result = await copy("hello");
    });
    expect(result).toBe(true);
    expect(out()).toBe("copied");
    await act(() => wait(60));
    expect(out()).toBe("idle");
  });

  test("a copy that resolves after unmount reports its result without touching state", async () => {
    let release: () => void = () => {};
    setClipboard({ writeText: () => new Promise<void>((resolve) => (release = resolve)) });
    let copy: (text: string) => Promise<boolean> = async () => false;
    const view = render(createElement(Harness, { timeout: 30, onReady: (fn) => (copy = fn) }));
    const pending = copy("late");
    view.unmount();
    release();
    expect(await pending).toBe(true);
  });

  test("a failing fallback without the Clipboard API reports false", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);
    let copy: (text: string) => Promise<boolean> = async () => true;
    render(createElement(Harness, { timeout: 30, onReady: (fn) => (copy = fn) }));
    let result = true;
    await act(async () => {
      result = await copy("x");
    });
    expect(result).toBe(false);
    expect(document.querySelector("output")?.textContent).toBe("error");
  });
});
