# Evals

The scoreboard that tells us whether a change to Tropos makes it better. Every claim that Tropos
is better than another agent should point at a results file here.

## Private tasks

Each task in `tasks/<id>/` is a real fix from one of our repositories, turned into a problem:

- the agent starts from the fix's parent commit (`base`), as a fresh repository with no later history;
- it gets `prompt`, written like an issue report: the symptom, plus any names the tests need;
- when it finishes, the test files the fix added or changed (`hidden/`) are copied over its work and
  `verify` runs with the network off. The trial passes if `verify` exits 0.

Tasks marked `"split": "holdout"` are for measuring only. Don't look at their transcripts or tune
Tropos on them; if a change only helps on holdout tasks, it's noise.

Every trial runs in its own Docker container (`docker/Dockerfile`) as an unprivileged user, so
agents can run with permissions skipped without touching this machine. Tropos is built from the
current checkout for the container's architecture; Claude Code is pinned in the image.

```bash
bun scripts/eval.ts validate                       # every task fails at base and passes at the fix (free)
export ANTHROPIC_API_KEY=…                         # agents in containers can't use your local login
bun scripts/eval.ts run --agents tropos,claude --split dev
bun scripts/eval.ts run --agents tropos --task print-exit-codes --attempts 3 --effort medium
bun scripts/eval.ts report results/*.jsonl         # scoreboard across runs
```

Other providers run with Tropos alone (Claude Code only speaks Anthropic). The key comes from the
provider's variable or from a key saved with `/providers`, and is passed into the container:

```bash
bun scripts/eval.ts run --agents tropos --model deepseek/deepseek-flash --split dev
bun scripts/eval.ts tb --agents tropos --model openrouter/moonshotai/kimi-k3 --limit 5
```

`run` writes `results/<run-id>.jsonl` (one line per trial) and `results/<run-id>.md`. The run id
holds the date and the commit Tropos was built from, plus `-dirty` if `src/` had uncommitted
changes. The scoreboard has one row per agent and model, and reports pass rate, total cost and
cost per solved task, median time and turns, the share of tool calls that failed (Tropos only),
and diffs that edited tests or added `.skip`/`.only`.

With `--attempts 3` it also shows the noise: `attempt sd` is how far the pass rate moves between
attempts, in percentage points, and `mixed tasks` counts tasks some attempts solved and others
didn't. A change worth less than the attempt sd isn't one you can see yet.

### Adding a task

```bash
bun scripts/eval.ts new-task --from-commit <sha> --id <short-name> [--repo /path/to/repo] [--split holdout]
```

Then replace the `TODO` prompt: describe the problem as an issue would, never the fix, and end
with a `Requirements:` line naming any function, export or exact text the hidden tests rely on.
Check `setup` and `verify`, then run `validate --task <id>` until it reports `ok`. Good tasks
come from commits whose tests check behaviour rather than one exact implementation.

## Terminal-Bench 2.0

Run through [harbor](https://github.com/laude-institute/harbor) 0.24.0 (pinned and run with `uvx`,
so it needs `uv` and Docker; your own `harbor` install is not used). Tropos runs through
`terminal-bench/tropos_agent.py`, which uploads a Tropos binary built from this checkout; Claude
Code runs as harbor's built-in `claude-code` agent, pinned to the same version as above.

```bash
bun scripts/eval.ts tb --agents tropos,claude --limit 5     # wiring check, about 5% of a full run
bun scripts/eval.ts tb --agents tropos,claude --attempts 3  # all 89 tasks, three attempts each
```

Trials land in `results/<run-id>-tb.jsonl` with `split: "terminal-bench"`, in the same
format as the private tasks; harbor's full logs stay in `tb-jobs/` (not committed). Most task
images are linux/amd64. On Apple Silicon they run emulated: slower, so timeouts are likelier for
both agents. Use a native x64 machine for numbers you publish.
