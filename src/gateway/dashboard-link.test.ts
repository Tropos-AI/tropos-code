import { expect, test } from "bun:test";
import { dashboardLink } from "./dashboard-link";

test("links to the fixed port or the configured one, always on 127.0.0.1", () => {
  expect(dashboardLink({})).toBe("http://127.0.0.1:4317/");
  expect(dashboardLink({ webPort: 5000 }, "settings/autonomy")).toBe("http://127.0.0.1:5000/#/settings/autonomy");
});
