// src/install/flock.test.ts
import { describe, expect, test } from "bun:test";
import { InstallError } from "./errors";
import { libcCandidates, loadFlock } from "./flock";

describe("flock loading", () => {
  test("candidates per platform (decision D5)", () => {
    expect(libcCandidates("darwin", "arm64")).toEqual(["libSystem.B.dylib"]);
    expect(libcCandidates("linux", "x64")).toEqual(["libc.so.6", "/lib/ld-musl-x86_64.so.1", "/lib/libc.musl-x86_64.so.1"]);
    expect(libcCandidates("linux", "arm64")).toEqual(["libc.so.6", "/lib/ld-musl-aarch64.so.1", "/lib/libc.musl-aarch64.so.1"]);
  });

  test("loads on this machine", () => {
    expect(typeof loadFlock()).toBe("function");
  });

  test("no usable library is a local error", () => {
    expect(() => loadFlock(["/nonexistent/libc.so"])).toThrow(InstallError);
    expect(() => loadFlock(["/nonexistent/libc.so"])).toThrow("file locking is unavailable");
  });
});
