// web/src/components/interior/inline-validation.test.tsx — InlineValidation and useInlineValidation: validate after blur, debounced errors, reset.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { InlineValidation, useInlineValidation } = await import("@/components/interior/inline-validation");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  cleanup();
});

const email = (value: string) => (value.includes("@") ? null : "Enter a valid email");

function Field({ initial = "", hint, id }: { initial?: string; hint?: string; id?: string }) {
  const [value, setValue] = useState(initial);
  return createElement(InlineValidation, { label: "Email", value, onChange: setValue, validate: email, hint, id, debounce: 20, required: true });
}

describe("InlineValidation", () => {
  test("stays quiet until the first blur, then shows the error and links it to the field", async () => {
    render(createElement(Field, { hint: "We never share it" }));
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.getAttribute("aria-required")).toBe("true");
    const hintId = input.getAttribute("aria-describedby")!;
    expect(document.getElementById(hintId)?.textContent).toBe("We never share it");

    await act(async () => void fireEvent.change(input, { target: { value: "nope" } }));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("");

    await act(async () => void fireEvent.blur(input));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Enter a valid email");
    expect(input.getAttribute("aria-describedby")!.split(" ")).toHaveLength(2);
  });

  test("after the blur, a fix clears the error at once and a new mistake waits for the debounce", async () => {
    render(createElement(Field, { id: "mail" }));
    const input = screen.getByLabelText("Email");
    expect(input.id).toBe("mail");
    expect(input.getAttribute("aria-describedby")).toBeNull();

    await act(async () => void fireEvent.blur(input));
    // "" has no "@", so blurring the empty field already shows the error.
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await act(async () => void fireEvent.change(input, { target: { value: "a@b" } }));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("");

    await act(async () => void fireEvent.change(input, { target: { value: "ab" } }));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    await act(() => wait(50));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Enter a valid email");

    // Still wrong while already invalid: the error stays put.
    await act(async () => void fireEvent.change(input, { target: { value: "abc" } }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await act(() => wait(50));
    expect(screen.getByRole("status").textContent).toBe("Enter a valid email");
  });
});

describe("useInlineValidation", () => {
  type Api = ReturnType<typeof useInlineValidation>;

  function Harness({ value, onApi }: { value: string; onApi: (api: Api) => void }) {
    const api = useInlineValidation({ value, validate: (v) => (v === "bad" ? "Bad value" : null), debounce: 10 });
    onApi(api);
    return null;
  }

  test("commit validates now; an empty valid value is idle; reset returns to a clean, untouched state", async () => {
    let api = {} as Api;
    const view = render(createElement(Harness, { value: "", onApi: (a) => (api = a) }));
    expect(api.status).toBe("idle");
    expect(api.touched).toBe(false);

    await act(async () => api.commit());
    expect(api.touched).toBe(true);
    expect(api.status).toBe("idle");

    view.rerender(createElement(Harness, { value: "ok", onApi: (a) => (api = a) }));
    expect(api.status).toBe("valid");

    view.rerender(createElement(Harness, { value: "bad", onApi: (a) => (api = a) }));
    await act(async () => api.commit());
    expect(api.status).toBe("invalid");
    expect(api.error).toBe("Bad value");
    expect(api.fieldProps["aria-invalid"]).toBe(true);

    await act(async () => api.reset());
    expect(api.touched).toBe(false);
    expect(api.status).toBe("idle");
    expect(api.error).toBeNull();
    expect(api.message).toBe("");

    view.rerender(createElement(Harness, { value: "ok", onApi: (a) => (api = a) }));
    await act(async () => api.fieldProps.onBlur());
    expect(api.status).toBe("valid");
  });
});
