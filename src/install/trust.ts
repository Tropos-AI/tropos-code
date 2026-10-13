// src/install/trust.ts
import allowedSigners from "../../release/allowed_signers" with { type: "text" };
import { parseAllowedSigners, type TrustedKey } from "./sshsig";

export const SIGNER_PRINCIPAL = "tropos-release";
export const NAMESPACE_MANIFEST = "tropos-manifest";
export const NAMESPACE_INSTALLER = "tropos-installer";

/** release/allowed_signers, embedded at build time. There is no runtime override (spec §4.2). */
export const ALLOWED_SIGNERS_TEXT: string = allowedSigners;

/** Empty until the key ceremony; an empty set makes every verification fail closed. */
export const TRUSTED_KEYS: readonly TrustedKey[] = Object.freeze(parseAllowedSigners(ALLOWED_SIGNERS_TEXT));
