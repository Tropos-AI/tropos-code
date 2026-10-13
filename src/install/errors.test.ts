// src/install/errors.test.ts
import { describe, expect, test } from "bun:test";
import { EXIT_CODES, InstallError, describeError, exitCodeFor, fromFsError } from "./errors";

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

  test("maps any error raised by a system call to local, not to a raw exit 1", () => {
    for (const [code, syscall] of [["EIO", "read"], ["EMFILE", "open"], ["ENOENT", "open"], ["EISDIR", "read"]]) {
      const mapped = fromFsError(Object.assign(new Error(`${code}: boom`), { code, syscall }), "reading x");
      expect(mapped).toBeInstanceOf(InstallError);
      expect(exitCodeFor(mapped)).toBe(73);
      expect((mapped as InstallError).message).toBe(`reading x: ${code}: boom`);
    }
  });

  test("leaves other errors unchanged", () => {
    const e = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(fromFsError(e, "x")).toBe(e);
    const plain = new TypeError("not a filesystem error");
    expect(fromFsError(plain, "x")).toBe(plain);
  });

  test("describeError never throws", () => {
    expect(describeError(new Error("m"))).toBe("m");
    expect(describeError("s")).toBe("s");
    expect(describeError({ toString() { throw new Error("x"); } })).toBe("unknown error");
  });
});
