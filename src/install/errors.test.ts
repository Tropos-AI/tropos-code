// src/install/errors.test.ts
import { describe, expect, test } from "bun:test";
import { EXIT_CODES, InstallError, exitCodeFor, fromFsError } from "./errors";

describe("install errors", () => {
  test("exit codes follow sysexits", () => {
    expect(EXIT_CODES).toEqual({ ok: 0, other: 1, usage: 64, integrity: 65, network: 69, local: 73, busy: 75 });
    expect(exitCodeFor(new InstallError("integrity", "x"))).toBe(65);
    expect(exitCodeFor(new InstallError("busy", "x"))).toBe(75);
    expect(exitCodeFor(new Error("x"))).toBe(1);
  });

  test("maps actionable filesystem errors to local", () => {
    for (const code of ["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "ELOOP", "ENOTDIR"]) {
      const mapped = fromFsError(Object.assign(new Error("boom"), { code }), "writing x");
      expect(mapped).toBeInstanceOf(InstallError);
      expect((mapped as InstallError).kind).toBe("local");
      expect((mapped as InstallError).message).toBe("writing x: boom");
    }
  });

  test("leaves other errors unchanged", () => {
    const e = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(fromFsError(e, "x")).toBe(e);
  });
});
