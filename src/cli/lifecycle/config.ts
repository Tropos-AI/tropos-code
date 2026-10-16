// src/cli/lifecycle/config.ts — `tcode config`: read and change settings.json / gateway.json safely (spec §2.3).
import { parseArgs } from "node:util";
import { CONFIG_FILE_NAMES, ConfigStoreError, configFile, getAt, jsonSchemaOf, readConfigRaw, redact, redactAt, setAt, unsetAt, updateConfigFile, validateConfigFile, type ConfigFile, type ConfigFileName } from "../../config/store";
import type { LifecycleRun } from "./types";

const HELP = `Usage: tcode config <command> [--file settings|gateway]

  show [--json]            print the file (secrets masked)
  get <dot.path> [--json] [--reveal]
                           print one value
  set <dot.path> <value>   change a value (JSON, else a string); validated, with a backup of the old file
  unset <dot.path>         remove a key
  path                     where the file lives
  validate                 check the file; exit 1 with the reason when it is invalid
  schema                   print the JSON Schema of the file

--file picks settings.json (default) or gateway.json.
`;

const show = (v: unknown) => (v === undefined ? "(unset)" : JSON.stringify(v));

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const run: LifecycleRun = async (argv, ctx) => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { file: { type: "string" }, json: { type: "boolean" }, reveal: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
  } catch (err) {
    ctx.err(`tcode config: ${(err as Error).message}\n${HELP}`);
    return 64;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help || command === undefined) {
    ctx.out(HELP);
    return values.help ? 0 : 64;
  }
  if (values.file !== undefined && !(CONFIG_FILE_NAMES as readonly string[]).includes(values.file)) {
    ctx.err(`tcode config: --file must be settings or gateway, not "${values.file}"\n`);
    return 64;
  }
  const names: readonly ConfigFileName[] = values.file ? [values.file as ConfigFileName] : ["settings"];
  const file: ConfigFile = configFile(ctx.home, names[0]!);
  const usage = (msg: string) => {
    ctx.err(`tcode config: ${msg}\n`);
    return 64;
  };

  try {
    switch (command) {
      case "show": {
        if (args.length) return usage("show takes no arguments");
        const data = redact(await readConfigRaw(file));
        ctx.out(values.json ? `${JSON.stringify(data)}\n` : `# ${file.path}\n${JSON.stringify(data, null, 2)}\n`);
        return 0;
      }
      case "get": {
        if (args.length !== 1) return usage("get needs one dot.path");
        const value = getAt(await readConfigRaw(file), args[0]!);
        if (value === undefined) {
          ctx.err(`tcode config: ${args[0]} is not set in ${file.path}\n`);
          return 1;
        }
        const shown = values.reveal ? value : redactAt(args[0]!, redact(value));
        ctx.out(typeof shown === "string" && !values.json ? `${shown}\n` : `${JSON.stringify(shown, null, typeof shown === "object" ? 2 : 0)}\n`);
        return 0;
      }
      case "set":
      case "unset": {
        const isSet = command === "set";
        if (args.length !== (isSet ? 2 : 1)) return usage(isSet ? "set needs a dot.path and a value" : "unset needs one dot.path");
        const path = args[0]!;
        const next = isSet ? parseValue(args[1]!) : undefined;
        const result = await updateConfigFile(file, (draft) => (isSet ? setAt(draft, path, next) : unsetAt(draft, path)));
        const before = redactAt(path, getAt(result.before, path));
        const after = redactAt(path, getAt(result.after, path));
        if (!result.changed) {
          ctx.out(`${path} is already ${show(after)}; ${file.path} unchanged.\n`);
          return 0;
        }
        ctx.out(`${file.path}: ${path}\n  before: ${show(before)}\n  after:  ${show(after)}\n`);
        if (result.backup) ctx.out(`Previous file kept as ${result.backup}\n`);
        return 0;
      }
      case "path": {
        const list = values.file ? [file] : CONFIG_FILE_NAMES.map((n) => configFile(ctx.home, n));
        ctx.out(values.file ? `${file.path}\n` : list.map((f) => `${f.label}: ${f.path}`).join("\n") + "\n");
        return 0;
      }
      case "validate": {
        const targets = (values.file ? names : CONFIG_FILE_NAMES).map((n) => configFile(ctx.home, n));
        let failed = false;
        for (const f of targets) {
          const reason = await validateConfigFile(f);
          if (reason) {
            failed = true;
            ctx.err(`tcode config: ${f.path}: ${reason}\n`);
          } else ctx.out(`${f.path}: ok\n`);
        }
        return failed ? 1 : 0;
      }
      case "schema":
        ctx.out(`${JSON.stringify(jsonSchemaOf(file), null, 2)}\n`);
        return 0;
      default:
        return usage(`unknown command "${command}"\n${HELP}`);
    }
  } catch (err) {
    ctx.err(`tcode config: ${err instanceof ConfigStoreError ? err.message : (err as Error).message}\n`);
    return 1;
  }
};
export default run;
