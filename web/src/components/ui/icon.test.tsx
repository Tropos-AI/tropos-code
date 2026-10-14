// web/src/components/ui/icon.test.tsx — Icon: size and tone mapping, static vs animated glyphs, and the labelled (role="img") form.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { createElement } = await import("react");
const { Icon } = await import("@/components/ui/icon");

afterEach(() => {
  cleanup();
});

describe("Icon", () => {
  test("is decorative by default: a static svg at the md size", () => {
    const { container } = render(createElement(Icon, { name: "copy" }));
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("data-icon-name")).toBe("copy");
    expect(svg.getAttribute("class")).not.toMatch(/(^| )-(sm|lg)( |$)/);
    expect(container.querySelector("[data-slot=animated-icon]")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("maps sizes and tones onto the Cojeev slots", () => {
    const { container } = render(createElement(Icon, { name: "calendar", size: "lg", tone: "accent", treatment: "duotone", className: "mine", style: { opacity: 0.5 } }));
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("-lg");
    expect(svg.getAttribute("class")).toContain("mine");
    expect(svg.style.opacity).toBe("0.5");
    expect((svg.querySelector("[data-icon-accent]") as SVGElement).style.stroke).toBe("var(--v-blue)");
  });

  test("a motion preset renders the animated wrapper; `active` runs it", () => {
    const { container } = render(createElement(Icon, { name: "loader", size: "sm", tone: "ok", motion: "spin", active: true }));
    const host = container.querySelector("[data-slot=animated-icon]")!;
    expect(host.getAttribute("data-preset")).toBe("spin");
    expect(host.querySelector("svg")!.getAttribute("class")).toContain("-sm");
  });

  test("a label makes it a named image", () => {
    render(createElement(Icon, { name: "triangle-alert", tone: "warn", label: "Warning" }));
    const img = screen.getByRole("img", { name: "Warning" });
    expect(img.querySelector("svg")).not.toBeNull();
    cleanup();
    render(createElement(Icon, { name: "sparkles", tone: "violet", motion: "pulse", label: "New" }));
    expect(screen.getByRole("img", { name: "New" }).querySelector("[data-slot=animated-icon]")).not.toBeNull();
  });
});
