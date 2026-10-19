import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LazyMotion, domMax } = await import("motion/react");
const { MessageUser } = await import("@/components/chat/MessageUser");

afterEach(() => cleanup());

const mount = (props: Parameters<typeof MessageUser>[0]) => render(createElement(LazyMotion, { features: domMax, strict: true }, createElement(MessageUser, props)));

describe("MessageUser", () => {
  test("shows the images and files sent with the message; a file opens its preview", async () => {
    mount({
      text: "what are these?",
      attachments: [
        { kind: "image", name: "chart.png", mediaType: "image/png", data: "QUJD" },
        { kind: "text", name: "pasted-1.txt", text: "a\nb\nc" },
      ],
    });
    const message = screen.getByRole("article", { name: "You" });
    const img = within(message).getByRole("img", { name: "chart.png" }) as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,QUJD");
    expect(within(message).getByText("what are these?")).toBeTruthy();
    fireEvent.click(within(message).getByRole("button", { name: /Pasted text · 3 lines/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/a\s+b\s+c/)).toBeTruthy();
  });

  test("images alone show no empty bubble", () => {
    mount({ text: "", attachments: [{ kind: "image", name: "image 1", mediaType: "image/jpeg", data: "QUJD" }] });
    const message = screen.getByRole("article", { name: "You" });
    expect(within(message).getByRole("img", { name: "image 1" })).toBeTruthy();
    expect(message.querySelector("[data-bubble]")).toBeNull();
  });

  test("plain text renders as before", () => {
    mount({ text: "/review a.ts" });
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
