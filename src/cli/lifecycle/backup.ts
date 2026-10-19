// src/cli/lifecycle/backup.ts — `tcode backup`: create, verify, restore and list archives of ~/.tropos.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BackupError, PARTS, createBackup, listBackups, parseParts, restoreBackup, verifyBackup, type ProgressFn } from "../../backup";
import type { LifecycleRun } from "./types";

const HELP = `Usage: tcode backup <command>

  create [--output <dir|file.tar.gz>] [--quick] [--no-sessions] [--no-secrets] [--include-workspace] [--verify] [--dry-run]
      Archive settings, gateway config, credentials, memory, skills, plugins, identity and sessions into
      ~/.tropos/backups/tropos-backup-<time>.tar.gz (mode 0600).
      --quick            leave out sessions, plugins and learning data
      --no-secrets       leave out credentials.json and secret values in settings.json / gateway.json
  verify <archive>        check every file against the manifest
  restore <archive> [--only <part>[,<part>]] [--dry-run] [--yes] [--trust-code]
      Verify, back up the current state, then write the files back. Parts: ${PARTS.join(", ")}.
      A backup that replaces files which can run code or let people in (hooks, MCP servers, skills, plugins, the
      pairing list, scheduled jobs, SOUL.md ...) is listed first and needs a separate confirmation; without a terminal
      it needs --trust-code as well as --yes. gateway/token, devices.json and login-codes.json are never restored.
  list                    archives in ~/.tropos/backups
`;

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

const run: LifecycleRun = async (argv, ctx) => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        quick: { type: "boolean" },
        "no-sessions": { type: "boolean" },
        "no-secrets": { type: "boolean" },
        "include-workspace": { type: "boolean" },
        verify: { type: "boolean" },
        "dry-run": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        "trust-code": { type: "boolean" },
        only: { type: "string", multiple: true },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    ctx.err(`tcode backup: ${(err as Error).message}\n${HELP}`);
    return 64;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help || !command) {
    ctx.out(HELP);
    return values.help ? 0 : 64;
  }
  const usage = (msg: string) => {
    ctx.err(`tcode backup: ${msg}\n`);
    return 64;
  };
  const progress: ProgressFn = (e) => {
    if (e.phase === "warn") ctx.err(`warning: ${e.message}\n`);
    else if (e.phase === "safety" || (e.phase === "verify" && e.done === undefined)) ctx.out(`${e.message}...\n`);
  };

  try {
    switch (command) {
      case "create": {
        if (args.length) return usage("create takes no arguments (use --output)");
        const dryRun = values["dry-run"] ?? false;
        const r = await createBackup({
          home: ctx.home,
          now: ctx.now,
          output: values.output ? resolve(ctx.cwd, values.output) : undefined,
          quick: values.quick,
          sessions: !values["no-sessions"],
          secrets: !values["no-secrets"],
          workspace: values["include-workspace"],
          verify: values.verify,
          dryRun,
          troposVersion: ctx.version,
          onProgress: progress,
        });
        for (const s of r.skipped) ctx.err(`skipped ${s.path}: ${s.reason}\n`);
        if (dryRun) {
          ctx.out(`Would back up ${r.fileCount} files (${mb(r.totalBytes)}) from ${ctx.home}:\n${r.files.map((f) => `  ${f}`).join("\n")}\n`);
          return 0;
        }
        ctx.out(`Backup written: ${r.archive} (${r.fileCount} files, ${mb(r.archiveBytes ?? 0)})${r.verified ? ", verified" : ""}\n`);
        if (values["no-secrets"]) ctx.out("Secrets were left out: restoring this backup will not bring back API keys or the bot token.\n");
        return 0;
      }
      case "verify": {
        if (args.length !== 1) return usage("verify needs one archive");
        const archive = resolve(ctx.cwd, args[0]!);
        const v = await verifyBackup({ archive, onProgress: progress });
        if (!v.ok) {
          ctx.err(`tcode backup: ${archive} failed verification:\n${v.problems.map((p) => `  - ${p}`).join("\n")}\n`);
          return 1;
        }
        ctx.out(`${archive}: ok (${v.files} files, created ${v.manifest?.createdAt})\n`);
        return 0;
      }
      case "restore": {
        if (args.length !== 1) return usage("restore needs one archive");
        const archive = resolve(ctx.cwd, args[0]!);
        const only = parseParts(values.only ?? []);
        const dryRun = values["dry-run"] ?? false;
        const plan = await restoreBackup({ archive, home: ctx.home, now: ctx.now, dryRun: true, only, onProgress: progress });
        ctx.out(`Restoring ${plan.restored.length} files from ${archive} into ${ctx.home}; ${plan.overwritten.length} existing files will be replaced.\n`);
        for (const w of plan.warnings) ctx.err(`warning: ${w}\n`);
        if (plan.risky.length) {
          ctx.out(
            `\nThis backup replaces files that can run code or let people in:\n${plan.risky.map((r) => `  ${r.path}  (${r.why})`).join("\n")}\nRestore it only if you made it or trust whoever did.\n\n`,
          );
        }
        if (dryRun) {
          ctx.out(`${plan.restored.map((f) => `  ${f.path}${plan.overwritten.includes(f.path) ? " (replaces)" : ""}`).join("\n")}\n`);
          return 0;
        }
        let trustCode = values["trust-code"] ?? false;
        if (!values.yes) {
          if (!ctx.interactive) {
            ctx.err("tcode backup: restore changes files; pass --yes to run it without a terminal.\n");
            return 64;
          }
          if (!(await ctx.confirm("Restore now? The current state is backed up first.", false))) {
            ctx.out("Cancelled.\n");
            return 1;
          }
        }
        if (plan.risky.length && !trustCode) {
          if (!ctx.interactive) {
            ctx.err("tcode backup: this backup contains files that can run code or let people in (listed above); pass --trust-code as well as --yes if you trust it.\n");
            return 1;
          }
          if (!(await ctx.confirm("Do you trust whoever made this backup with those files?", false))) {
            ctx.out("Cancelled. Nothing was restored.\n");
            return 1;
          }
          trustCode = true;
        }
        const r = await restoreBackup({ archive, home: ctx.home, now: ctx.now, only, trustCode, troposVersion: ctx.version, onProgress: progress });
        for (const w of r.warnings) if (!plan.warnings.includes(w)) ctx.err(`warning: ${w}\n`);
        if (r.safetyBackup) ctx.out(`Safety backup of the previous state: ${r.safetyBackup}\n`);
        ctx.out(`Restored ${r.restored.length} files.\n`);
        return 0;
      }
      case "list": {
        const list = await listBackups(ctx.home);
        if (values.json) {
          ctx.out(`${JSON.stringify(list)}\n`);
          return 0;
        }
        if (list.length === 0) ctx.out(`No backups in ${ctx.home}/backups. Make one with: tcode backup create\n`);
        for (const b of list) ctx.out(`${b.modifiedAt}  ${mb(b.bytes).padStart(9)}  ${b.path}\n`);
        return 0;
      }
      default:
        return usage(`unknown command "${command}"\n${HELP}`);
    }
  } catch (err) {
    if (err instanceof BackupError) {
      ctx.err(`tcode backup: ${err.message}\n${err.problems.slice(1, 8).map((p) => `  - ${p}\n`).join("")}`);
      return err.code === "usage" ? 64 : 1;
    }
    ctx.err(`tcode backup: ${(err as Error).message}\n`);
    return 1;
  }
};
export default run;
