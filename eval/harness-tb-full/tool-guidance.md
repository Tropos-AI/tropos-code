# Using tools well

## Running commands
- A Bash call times out after 120 seconds unless you pass timeout_ms, which may be at most 600000; a killed call loses its output. For longer work (sweeps, downloads, batches), start it with nohup, write output to a log file, record the PID, and poll with short calls.
- Before a batch (a sweep, a generator, many trials, a loop over inputs), run one item end to end, time it and check its output. Fix errors on one item, and size the batch so the projected total fits the timeout.
- Check which programs exist in one call before depending on them (for example `command -v python3 perl node curl ps`). If one is missing, switch at once to one that is installed (python3 urllib when curl is absent, kill -0 PID when ps is absent) instead of retrying it. If the intended runtime is missing, say so in the final answer.
- When an install reports a package as missing or nothing new available, find the cause before working around it: apt-get update when the index is empty. Read the error before any retry.
- When pip refuses an install as externally-managed, check whether the module already imports, then install into an isolated target outside the project (pip install --target with PYTHONPATH, or a venv) before overriding the system protection. Say exactly what was installed and where.
- Run independent probes (versions, tools, file headers) in one response.
- The exit status of a pipeline or compound command is that of its last command. Don't put a command behind tail or head when you need its status: redirect the full output to a log, record $?, then read the log. Check a background launch's liveness in its own call.
- If a script changes directory, pass absolute paths to it.

## Files and data
- Glob patterns are relative to the search directory; absolute paths and ~ are rejected. For a file whose path you know, use Read, or ls in Bash.
- Edit and Write only work on files you have already Read in this session.
- Fetch each remote source once, save it under /tmp, and filter the saved copy. Before filtering parsed data, print one record's structure and handle null or missing fields explicitly.
- Before writing calls against a library version you have not inspected this session, grep its installed source for the signatures you will call.

## Checking results
- Write the expected results down before running a check, computed independently of the code, then compare the actual output with them item by item.
- A helper that prints nothing, or the same value for every case, is broken until shown otherwise. Before relying on a measurement tool, run it on a case with a known answer and confirm which number is which.
- A passing check counts only if it can fail. For a new check, break the behaviour it covers in a copy outside the project and confirm the check fails. Run such copies and distributed tests under `timeout N`.
- Before reporting an output file as done, read it back and check it against the format you were given: header, column names and order, row count, value ranges.
- Run the exact command the user will run, from the directory they will run it in, and check where its output lands. When a deliverable must build or run under several toolchains, build and run it under each one after the last edit. If the user names a toolchain version and the installed one differs, say so.
- When a change has no visible effect, confirm it reached the code that runs (disassemble the function or trace the call) before trying another variant. When a failure may come from the toolchain rather than your code, build and run a minimal program the same way and compare.
