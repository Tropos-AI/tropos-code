# Security policy

Tropos Code runs code on people's computers and can be reached from Telegram and their phones, so we take security
reports seriously and thank everyone who sends one.

## Reporting a vulnerability

**Please report vulnerabilities privately, not in a public issue, pull request or discussion.**

Use GitHub's private vulnerability reporting: open
[Report a vulnerability](https://github.com/Tropos-AI/tropos-code/security/advisories/new) on this repository's
**Security** tab. Only the maintainers can see the report, and we can discuss it, prepare a fix and credit you in the
same private advisory.

Please include:

- what an attacker can do, and from where (a cloned repository, a Telegram message, a web page, a tampered download,
  another user on the same machine …);
- the steps to reproduce, with the Tropos Code version (`tcode --version`) and your operating system;
- the relevant output of `tcode status --json` or `tcode doctor --json`, with anything private removed;
- whether you have told anyone else.

Never include real API keys, bot tokens or personal data in a report.

## What happens next

We confirm that we received the report, investigate, and keep you updated in the advisory. When a fix is ready we
publish a signed release, then the advisory, with credit to you unless you prefer otherwise. Please give us
reasonable time to release the fix before you disclose the issue publicly.

## Scope

In scope: the `tcode` program and its background service, the dashboard, the Telegram channel, the sandbox for chat
commands, the permission engine, the installer (`install.sh`) and the update and signature checks.

Especially interesting: a guest or a scheduled run gaining the owner's powers; a chat command escaping its project or
reading secrets; a cloned repository granting itself permissions or running a program; a website reaching the
dashboard; a key leaking into a transcript, a log or a model request; an unsigned or tampered release being installed.

The threat model and the documented limits of the sandbox are in [docs/security.md](docs/security.md) and
[docs/autonomy-and-sandbox.md](docs/autonomy-and-sandbox.md#what-the-sandbox-does-not-protect). A behaviour listed
there as a known limit is not a vulnerability by itself, but a way around a protection that page describes is.

## Supported versions

Security fixes go into the newest release. Update with `tcode update` (background updates do this by themselves) to
stay protected.

## Verifying releases

Every release is signed with the Tropos release key; the installer and `tcode` check the signature and the binary's
SHA-256 before installing anything. Release key fingerprint: `SHA256:QY3xHG6gCBN84NfeYw1Vy1r5G0NpGTf0jDR02/QVLr8`.
How to verify a release yourself: [docs/install.md](docs/install.md#verify-the-installer-before-running-it).
