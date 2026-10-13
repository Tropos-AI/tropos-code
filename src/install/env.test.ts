// src/install/env.test.ts
import { describe, expect, test } from "bun:test";
import { minimalEnv } from "./env";

describe("minimalEnv", () => {
  test("keeps only the allow-list (spec §11, amendment A8)", () => {
    const env = minimalEnv({
      HOME: "/h",
      PATH: "/bin",
      TMPDIR: "/t",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      XDG_DATA_HOME: "/d",
      XDG_STATE_HOME: "/s",
      HTTPS_PROXY: "http://p",
      https_proxy: "http://p",
      NO_PROXY: "x",
      SSL_CERT_FILE: "/c",
      SSL_CERT_DIR: "/cd",
      TROPOS_HOME: "/th",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      DEEPSEEK_API_KEY: "secret",
      SHELL: "/bin/zsh",
    });
    expect(env).toEqual({
      HOME: "/h",
      PATH: "/bin",
      TMPDIR: "/t",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      XDG_DATA_HOME: "/d",
      XDG_STATE_HOME: "/s",
      HTTPS_PROXY: "http://p",
      https_proxy: "http://p",
      NO_PROXY: "x",
      SSL_CERT_FILE: "/c",
      SSL_CERT_DIR: "/cd",
      TROPOS_HOME: "/th",
    });
  });
});
