import { afterEach, describe, expect, test } from "bun:test";
import jsQR from "jsqr";

import { qrMatrix } from "@core/ui/qr";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { createElement } = await import("react");
const { QrCode } = await import("@/components/pages/settings/qr-code");

afterEach(() => cleanup());

const TEXT = "https://mac.tail1234.ts.net/";

describe("QrCode", () => {
  test("draws one path for the dark modules, sized to the matrix plus the quiet zone", () => {
    render(createElement(QrCode, { text: TEXT, label: "Phone address" }));
    const n = qrMatrix(TEXT).length;
    const svg = screen.getByRole("img", { name: "Phone address" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${n + 8} ${n + 8}`);
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.children).toHaveLength(1);
    const dark = qrMatrix(TEXT).flat().filter(Boolean).length;
    expect((svg.querySelector("path")!.getAttribute("d")!.match(/M/g) ?? []).length).toBe(dark);
  });

  test("scales to min(260px, 100%) and uses the theme's ink and surface", () => {
    render(createElement(QrCode, { text: TEXT, label: "Phone address" }));
    const svg = screen.getByRole("img", { name: "Phone address" });
    expect(svg.getAttribute("class")).toContain("w-[min(260px,100%)]");
    expect(svg.getAttribute("class")).toContain("bg-surface");
    expect(svg.querySelector("path")!.getAttribute("class")).toContain("fill-ink");
  });

  test("the picture scans back to the text", () => {
    render(createElement(QrCode, { text: TEXT, label: "Phone address" }));
    const svg = screen.getByRole("img", { name: "Phone address" });
    const size = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    const scale = 6;
    const px = size * scale;
    const data = new Uint8ClampedArray(px * px * 4).fill(255);
    for (const [, x, y] of svg.querySelector("path")!.getAttribute("d")!.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = ((Number(y) * scale + dy) * px + Number(x) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
    expect(jsQR(data, px, px)?.data).toBe(TEXT);
  });

  test("text that does not fit says so instead of drawing a broken code", () => {
    render(createElement(QrCode, { text: "x".repeat(400), label: "Phone address" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/too long for a QR code/)).toBeTruthy();
  });
});
