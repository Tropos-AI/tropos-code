// src/install/build-flags.ts
declare const TROPOS_TEST_BUILD: boolean | undefined;
declare const TROPOS_TEST_SIGNERS: string | undefined;

/**
 * True only in binaries built with `bun build.ts --test-build` for the compiled e2e tests. Production builds
 * define TROPOS_TEST_BUILD as false, so every branch below is removed from them (amendment A3).
 */
export const IS_TEST_BUILD: boolean = typeof TROPOS_TEST_BUILD !== "undefined" && TROPOS_TEST_BUILD === true;

export function testBuildOverrides(env: NodeJS.ProcessEnv): { signers: string; base: string } | null {
  if (!IS_TEST_BUILD) return null;
  return { signers: typeof TROPOS_TEST_SIGNERS === "string" ? TROPOS_TEST_SIGNERS : "", base: env.TROPOS_TEST_RELEASES_BASE ?? "" };
}
