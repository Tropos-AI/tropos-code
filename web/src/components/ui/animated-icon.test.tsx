// web/src/components/ui/animated-icon.test.tsx — Cojeev icons: static glyphs and treatments, control feedback, AnimatedIcon presets, StateChevron, motion settings.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent, waitFor } = await import("@testing-library/react");
const { createElement, createRef } = await import("react");
const { AnimatedIcon, CojeevIcon, StateChevron, isKnownIcon } = await import("@/components/ui/animated-icon");
const { ICON_NAMES } = await import("@/components/ui/icon-names");
const { frameData, frameSteps } = await import("motion");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Lets the shortest (80 ms) motions run, where nothing is asserted on how far they got. */
const SETTLE = 200;
/**
 * The duration (s) of motions a test checks while they play: far above timer jitter, so "still playing" right after the
 * trigger holds on a loaded CI machine. Whether a motion has painted or finished is polled (`until`), never slept on.
 */
const MOTION_S = 0.4;
/** Retries until the frame loop or a timer has done its work (up to 3 s). Keep assertions cheap: it may run many times. */
const until = (assertion: () => void) => waitFor(assertion, { timeout: 3000 });

const STEPS = ["setup", "read", "resolveKeyframes", "preUpdate", "update", "preRender", "render", "postRender"] as const;

/**
 * Motion's frame loop keeps the requestAnimationFrame of the first window it saw. `bun test` shares modules across
 * files, so once an earlier DOM test file has closed that window Motion never ticks again. This file drives Motion's
 * frame steps itself (harmless when the real loop also runs). Test-only.
 */
function pumpFrames(): () => void {
  const id = setInterval(() => {
    if (frameData.isProcessing) return;
    const now = performance.now();
    frameData.delta = Math.max(1, Math.min(now - frameData.timestamp, 40));
    frameData.timestamp = now;
    frameData.isProcessing = true;
    try {
      for (const step of STEPS) frameSteps[step].process(frameData);
    } finally {
      frameData.isProcessing = false;
    }
  }, 16);
  return () => clearInterval(id);
}
let stopFrames = () => {};

/** happy-dom never reports intersections; this one says every observed element is on screen. */
class VisibleObserver {
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
  observe() {
    this.callback([{ isIntersecting: true }]);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const realObserver = globalThis.IntersectionObserver;

/** Swaps the saved motion settings and tells mounted icons to reload them. */
async function settings(values: { motion?: unknown; flow?: unknown; morph?: unknown }) {
  const put = (key: string, value: unknown) => (value === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)));
  put("v-motion", values.motion);
  put("v-flow-v1", values.flow);
  put("v-morph-cfg-v3", values.morph);
  await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "v-motion" })));
}

beforeEach(() => {
  stopFrames = pumpFrames();
  globalThis.IntersectionObserver = VisibleObserver as unknown as typeof IntersectionObserver;
  window.IntersectionObserver = globalThis.IntersectionObserver;
});

afterEach(async () => {
  localStorage.clear();
  // Reload the defaults while something still listens, then unmount.
  const probe = render(createElement(CojeevIcon, { name: "x" }));
  await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: null })));
  probe.unmount();
  cleanup();
  stopFrames();
  globalThis.IntersectionObserver = realObserver;
  window.IntersectionObserver = realObserver;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

const svgOf = (root: ParentNode = document) => root.querySelector("svg[data-slot=icon]") as SVGSVGElement;

describe("CojeevIcon", () => {
  test("renders a decorative 24-unit svg for known names and aliases, and refuses unknown names", () => {
    expect(isKnownIcon("close")).toBe(true);
    expect(isKnownIcon("definitely-not-an-icon")).toBe(false);
    const view = render(createElement(CojeevIcon, { name: "close", size: "sm", className: "extra", strokeWidth: 3 }));
    const svg = svgOf();
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("class")).toContain("extra");
    expect(svg.getAttribute("class")).toContain("-sm");
    expect(svg.querySelectorAll("path").length).toBe(2);
    view.unmount();

    const errors = console.error;
    console.error = () => {};
    try {
      expect(() => render(createElement(CojeevIcon, { name: "definitely-not-an-icon" }))).toThrow("Unknown Cojeev icon: definitely-not-an-icon");
    } finally {
      console.error = errors;
    }
  });

  test("duotone adds a tinted accent layer per part; organic bends straight strokes and uses authored silhouettes", () => {
    const view = render(createElement(CojeevIcon, { name: "calendar", treatment: "duotone", tone: "blue" }));
    const accents = svgOf().querySelectorAll("[data-icon-accent]");
    expect(accents.length).toBe(4);
    expect((accents[2] as SVGElement).style.fill).toBe("var(--v-blue)");
    expect((accents[0] as SVGElement).style.fill).toBe("none");
    view.unmount();

    const minus = render(createElement(CojeevIcon, { name: "minus", treatment: "organic", tone: "pink" }));
    const line = svgOf().querySelector("path[data-icon-organic-line]")!;
    expect(line.getAttribute("d")).toMatch(/^M5 12 Q12 11\.680 19 12$/);
    expect((svgOf().querySelector("[data-icon-ink]") as SVGElement).style.color).toBe("var(--v-pink)");
    minus.unmount();

    const cpu = render(createElement(CojeevIcon, { name: "cpu", treatment: "organic" }));
    expect(svgOf().querySelector("path")!.getAttribute("d")).toMatch(/^M12 20 Q12\.320 21 12 22$/);
    cpu.unmount();

    render(createElement(CojeevIcon, { name: "check", treatment: "organic" }));
    expect(svgOf().querySelector("path")!.getAttribute("data-icon-organic-source")).toContain("Q");
  });

  test("forwards object and callback refs", () => {
    const ref = createRef<SVGSVGElement>();
    const view = render(createElement(CojeevIcon, { name: "x", ref }));
    expect(ref.current).toBe(svgOf());
    view.unmount();
    expect(ref.current).toBeNull();

    const seen: Array<SVGSVGElement | null> = [];
    const cb = render(createElement(CojeevIcon, { name: "x", ref: (node: SVGSVGElement | null) => void seen.push(node) }));
    cb.unmount();
    expect(seen).toEqual([expect.anything(), null]);

    let cleaned = false;
    const withCleanup = render(createElement(CojeevIcon, { name: "x", ref: () => () => void (cleaned = true) }));
    withCleanup.unmount();
    expect(cleaned).toBe(true);
  });
});

describe("icon feedback from the owning control", () => {
  function mount(name: string, extra: Record<string, unknown> = {}, wrap: "button" | "label" = "button") {
    const icon = createElement(CojeevIcon, { name, feedbackDuration: MOTION_S, ...extra });
    const view =
      wrap === "label"
        ? render(createElement("label", null, createElement("input", { type: "checkbox", "aria-label": "agree" }), icon, "Agree"))
        : render(createElement("button", { type: "button" }, icon, "Do it"));
    const control = (wrap === "label" ? view.container.querySelector("label") : screen.getByRole("button")) as HTMLElement;
    return { view, control, svg: svgOf(view.container) };
  }

  test("hover plays one motion and restores the glyph; touch, leave and blur end it", async () => {
    const { control, svg } = mount("copy");
    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "touch" }));
    expect(svg.dataset.iconFeedback).toBeUndefined();

    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBe("hover");
    const part = () => svg.querySelector("[data-icon-part='0']")!;
    await until(() => expect(/^translate\(/.test(part().getAttribute("transform") ?? "")).toBe(true));
    await until(() => expect(svg.dataset.iconFeedback).toBeUndefined());
    expect(part().hasAttribute("transform")).toBe(false);

    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "mouse" }));
    await act(async () => void fireEvent.pointerLeave(control));
    expect(svg.dataset.iconFeedback).toBeUndefined();

    await act(async () => void fireEvent.focusIn(control));
    expect(svg.dataset.iconFeedback).toBe("focus");
    await act(async () => void fireEvent.focusOut(control, { relatedTarget: svg }));
    expect(svg.dataset.iconFeedback).toBe("focus");
    await act(async () => void fireEvent.focusOut(control, { relatedTarget: document.body }));
    expect(svg.dataset.iconFeedback).toBeUndefined();
  });

  test("Enter presses once (its synthetic click is swallowed); a mouse click presses; a hidden tab stops it", async () => {
    const { control, svg } = mount("check", { feedbackEase: "settle" });
    await act(async () => void fireEvent.keyDown(control, { key: "a" }));
    expect(svg.dataset.iconFeedback).toBeUndefined();
    await act(async () => void fireEvent.keyDown(control, { key: "Enter", repeat: true }));
    expect(svg.dataset.iconFeedback).toBeUndefined();
    await act(async () => void fireEvent.keyDown(control, { key: "Enter" }));
    expect(svg.dataset.iconFeedback).toBe("press");
    await act(async () => {
      fireEvent.keyUp(control, { key: "x" });
      fireEvent.keyUp(control, { key: "Enter" });
      fireEvent.click(control);
    });
    // The draw motion dashes the check stroke while it plays.
    await until(() => expect(svg.querySelector("path")!.hasAttribute("stroke-dasharray")).toBe(true));
    await until(() => expect(svg.dataset.iconFeedback).toBeUndefined());

    await act(async () => void fireEvent.click(control));
    expect(svg.dataset.iconFeedback).toBe("press");
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(svg.dataset.iconFeedback).toBe("press");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(svg.dataset.iconFeedback).toBeUndefined();
    // Hidden tabs are not eligible at all.
    await act(async () => void fireEvent.click(control));
    expect(svg.dataset.iconFeedback).toBeUndefined();
  });

  test("disabled controls and quiet ancestors get no feedback; disabling mid-motion stops it", async () => {
    const { control, svg } = mount("trash-2", { feedbackEase: "linear" });
    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBe("hover");
    await act(async () => {
      control.setAttribute("aria-disabled", "true");
      await wait(10);
    });
    expect(svg.dataset.iconFeedback).toBeUndefined();
    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBeUndefined();
    control.removeAttribute("aria-disabled");

    control.setAttribute("data-motion", "off");
    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBeUndefined();
  });

  test("a label owns the icon's feedback and follows its input's disabled state", async () => {
    const { control, svg, view } = mount("bell", { feedbackEase: [0.2, 0.8, 0.2, 1] }, "label");
    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBe("hover");
    await until(() => expect(svg.dataset.iconFeedback).toBeUndefined());
    (view.container.querySelector("input") as HTMLInputElement).disabled = true;
    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBeUndefined();
  });

  test("feedback={false} and draw-on-mount leave the control alone; draw traces the glyph once", async () => {
    const { control, svg } = mount("copy", { feedback: false });
    await act(async () => void fireEvent.pointerEnter(control, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBeUndefined();
    cleanup();

    const drawn = render(createElement(CojeevIcon, { name: "check", draw: true }));
    const stroke = () => svgOf(drawn.container).querySelector("path")!;
    await until(() => expect(stroke().hasAttribute("stroke-dashoffset")).toBe(true));
    await until(() => expect(stroke().hasAttribute("stroke-dashoffset")).toBe(false));
  });
});

describe("AnimatedIcon", () => {
  test("every shipped glyph animates when forced active, then restores", async () => {
    const view = render(
      createElement(
        "div",
        null,
        ICON_NAMES.map((name) => createElement(AnimatedIcon, { key: name, name, active: true, duration: 0.08, amplitude: 1.2 })),
        createElement(AnimatedIcon, { key: "organic", name: "message-square", treatment: "organic", active: true, duration: 0.08 }),
      ),
    );
    const icons = view.container.querySelectorAll("[data-slot=animated-icon]");
    expect(icons.length).toBe(ICON_NAMES.length + 1);
    expect(icons[0]!.getAttribute("data-animated")).toBe("true");
    expect(icons[0]!.getAttribute("data-preset")).toBe("semantic");
    await act(() => wait(SETTLE));
  });

  test("each preset paints its own motion", async () => {
    const presets = ["draw", "spin", "tremor", "bounce", "validation", "pulse"] as const;
    const view = render(
      createElement(
        "div",
        null,
        presets.map((preset) => createElement(AnimatedIcon, { key: preset, name: preset === "bounce" ? "settings" : "arrow-right", preset, active: true, duration: 0.08, ease: preset === "pulse" ? "settle" : preset === "spin" ? "linear" : "gentle" })),
        createElement(AnimatedIcon, { key: "loader", name: "loader", active: true }),
        createElement(AnimatedIcon, { key: "none", name: "x", preset: "none", active: true }),
        createElement(AnimatedIcon, { key: "silent", name: "x", active: true, amplitude: 0 }),
        createElement(AnimatedIcon, { key: "nan", name: "x", active: true, amplitude: Number.NaN, duration: Number.NaN }),
      ),
    );
    const icons = Array.from(view.container.querySelectorAll("[data-slot=animated-icon]"));
    expect(icons.map((el) => el.getAttribute("data-preset"))).toEqual([...presets, "semantic", "none", "semantic", "semantic"]);
    expect(icons[7]!.hasAttribute("data-animated")).toBe(false);
    expect(icons[8]!.hasAttribute("data-animated")).toBe(false);
    // Spin loops while active, so once a frame has painted it stays rotated.
    await until(() => expect(/^rotate\(/.test(icons[1]!.querySelector("[data-icon-part=glyph]")!.getAttribute("transform") ?? "")).toBe(true));
    await act(() => wait(SETTLE));
  });

  test("hover, focus, presses and clicks replay the motion inside a control", async () => {
    render(createElement("button", { type: "button" }, createElement(AnimatedIcon, { name: "send", duration: MOTION_S }), "Send"));
    const button = screen.getByRole("button");
    const host = button.querySelector("[data-slot=animated-icon]")!;
    const animated = () => host.getAttribute("data-animated") === "true";
    expect(animated()).toBe(false);

    await act(async () => void fireEvent.pointerEnter(button, { pointerType: "touch" }));
    expect(animated()).toBe(false);
    await act(async () => void fireEvent.pointerEnter(button, { pointerType: "mouse" }));
    expect(animated()).toBe(true);
    await act(async () => void fireEvent.pointerLeave(button));
    expect(animated()).toBe(false);

    await act(async () => void fireEvent.focusIn(button));
    expect(animated()).toBe(true);
    await act(async () => void fireEvent.focusOut(button, { relatedTarget: host }));
    expect(animated()).toBe(true);
    await act(async () => void fireEvent.focusOut(button, { relatedTarget: null }));
    expect(animated()).toBe(false);

    // A right-button press does nothing; a primary press replays, its click is swallowed.
    await act(async () => void fireEvent.pointerDown(button, { button: 2 }));
    expect(host.hasAttribute("data-icon-replay")).toBe(false);
    await act(async () => {
      fireEvent.pointerDown(button, { button: 0 });
      window.dispatchEvent(new Event("pointerup"));
      fireEvent.click(button);
    });
    expect(host.getAttribute("data-icon-replay")).toBe("1");
    expect(animated()).toBe(true);
    await until(() => expect(animated()).toBe(false));

    // A cancelled press, then a bare click (e.g. assistive tech) replays.
    await act(async () => {
      fireEvent.pointerDown(button, { button: 0 });
      window.dispatchEvent(new Event("pointercancel"));
      fireEvent.click(button);
    });
    expect(host.getAttribute("data-icon-replay")).toBe("3");

    // Keyboard: Enter replays once; repeats and other keys do not.
    await act(async () => {
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      fireEvent.keyDown(button, { key: "a" });
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "b" });
      window.dispatchEvent(new Event("blur"));
    });
    expect(host.getAttribute("data-icon-replay")).toBe("4");
    await act(() => wait(20));
    await act(async () => void fireEvent.click(button));
    expect(host.getAttribute("data-icon-replay")).toBe("5");
  });

  test("a disabled control blocks replays and stops any running motion", async () => {
    render(createElement("button", { type: "button" }, createElement(AnimatedIcon, { name: "plus", duration: 0.08 }), "Add"));
    const button = screen.getByRole("button") as HTMLButtonElement;
    const host = button.querySelector("[data-slot=animated-icon]")!;
    await act(async () => void fireEvent.pointerEnter(button, { pointerType: "mouse" }));
    expect(host.getAttribute("data-animated")).toBe("true");
    await act(async () => {
      button.setAttribute("data-disabled", "");
      await wait(10);
    });
    expect(host.hasAttribute("data-animated")).toBe(false);
    await act(async () => void fireEvent.keyDown(button, { key: " " }));
    await act(async () => void fireEvent.focusIn(button));
    expect(host.hasAttribute("data-icon-replay")).toBe(false);
  });

  test("inside a label, the associated input is watched too", async () => {
    const view = render(createElement("label", null, createElement("input", { type: "checkbox" }), createElement(AnimatedIcon, { name: "check", duration: 0.08 })));
    const label = view.container.querySelector("label")!;
    await act(async () => void fireEvent.pointerEnter(label, { pointerType: "mouse" }));
    expect(label.querySelector("[data-slot=animated-icon]")!.getAttribute("data-animated")).toBe("true");
  });
});

describe("StateChevron", () => {
  test("controlled: rotates by `open` and direction; forwards refs", () => {
    const ref = createRef<HTMLSpanElement>();
    const view = render(createElement(StateChevron, { open: true, ref, className: "chev" }));
    const chevron = view.container.querySelector("[data-slot=state-chevron]")!;
    expect(ref.current).toBe(chevron as HTMLSpanElement);
    expect(chevron.getAttribute("data-open")).toBe("true");
    expect(chevron.getAttribute("class")).toBe("v-state-chevron chev");
    expect(chevron.querySelector("svg")!.getAttribute("data-icon-name")).toBe("chevron-down");

    const seen: unknown[] = [];
    view.rerender(createElement(StateChevron, { open: false, direction: "right", ref: (node: HTMLSpanElement | null) => void seen.push(node) }));
    expect(view.container.querySelector("svg")!.getAttribute("data-icon-name")).toBe("chevron-right");
    expect(view.container.querySelector("[data-slot=state-chevron]")!.getAttribute("data-open")).toBe("false");
    expect(seen.length).toBeGreaterThan(0);
  });

  test("uncontrolled: follows the nearest trigger's aria-expanded / data-state", async () => {
    const view = render(createElement("button", { type: "button", "aria-expanded": "false" }, createElement(StateChevron)));
    const trigger = screen.getByRole("button");
    const open = () => view.container.querySelector("[data-slot=state-chevron]")!.getAttribute("data-open");
    expect(open()).toBe("false");
    await act(async () => {
      trigger.setAttribute("aria-expanded", "true");
      await wait(10);
    });
    expect(open()).toBe("true");
    await act(async () => {
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("data-state", "open");
      await wait(10);
    });
    expect(open()).toBe("true");
    cleanup();

    const loose = render(createElement(StateChevron));
    expect(loose.container.querySelector("[data-slot=state-chevron]")!.getAttribute("data-open")).toBe("false");
  });
});

describe("motion settings", () => {
  test("mode off quiets every icon; flow variants and saved profiles load from storage, corrupt data is ignored", async () => {
    render(createElement("button", { type: "button" }, createElement(CojeevIcon, { name: "copy", feedbackDuration: 0.08 }), createElement(AnimatedIcon, { name: "x", duration: 0.08 })));
    const button = screen.getByRole("button");
    const svg = svgOf(button);

    await settings({ motion: { v: 3, mode: "off", cats: { buttons: false, icons: "nope" } } });
    expect(document.documentElement.dataset.flow).toBe("off");
    await act(async () => void fireEvent.pointerEnter(button, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBeUndefined();
    expect(button.querySelector("[data-slot=animated-icon]")!.hasAttribute("data-animated")).toBe(false);
    await act(async () => void fireEvent.pointerLeave(button));

    await settings({
      motion: { v: 3, mode: "subtle", cats: {} },
      flow: { variant: "jelly", hover: false, speed: 2, intensity: -1, hoverStrength: Number.NaN },
      morph: { cfg: { grain: 0.2, rest: "yes", quality: Number.POSITIVE_INFINITY }, TIER: { pill: { amp: 0.01, reach: "far" }, tile: "bad" } },
    });
    expect(document.documentElement.dataset.flow).toBe("jelly");
    expect(document.documentElement.dataset.flowHover).toBe("off");
    expect(document.documentElement.style.getPropertyValue("--flow-speed")).toBe("2");
    expect(document.documentElement.style.getPropertyValue("--flow-intensity")).toBe("0");
    await act(async () => void fireEvent.pointerEnter(button, { pointerType: "mouse" }));
    expect(svg.dataset.iconFeedback).toBe("hover");
    await act(async () => void fireEvent.pointerLeave(button));

    // Unknown variant, a profile with nothing usable, and unparseable JSON all fall back to defaults.
    await settings({ motion: "{not json", flow: { variant: "warp" }, morph: { nothing: true } });
    expect(document.documentElement.dataset.flow).toBe("glide");
    await settings({ motion: [1, 2], flow: "null", morph: { TIER: {} } });
    expect(document.documentElement.dataset.flow).toBe("glide");

    // Other storage keys are ignored; engine events reload too.
    localStorage.setItem("v-flow-v1", JSON.stringify({ variant: "ripple" }));
    await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" })));
    expect(document.documentElement.dataset.flow).toBe("glide");
    await act(async () => void window.dispatchEvent(new Event("v-flow")));
    expect(document.documentElement.dataset.flow).toBe("ripple");
    localStorage.setItem("v-flow-v1", JSON.stringify({ variant: "halo" }));
    await act(async () => void window.dispatchEvent(new Event("v-motion-change")));
    expect(document.documentElement.dataset.flow).toBe("halo");
  });
});
