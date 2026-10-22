---
name: corewars-pmars
description: Writing, assembling and battle-testing Redcode warriors for CoreWars with pMARS: batch battles, fixed placement series, win-rate thresholds, and tuning a design.
---
# CoreWars / Redcode with pMARS

## Running battles
- Batch form: `pmars -b -r <rounds> -f mine.red opp.red`. `-f` fixes the placement series. Use the same command the grader uses. Defaults: core size 8000 (`-s`), cycle limit 80000 (`-c`), max warrior length 100 instructions (`-l`), max processes 8000 (`-p`).
- The result line is `Results: W T L`. W, T and L count from the FIRST file on the command line. Swapping the order changes placement and the numbers. Confirm the ordering once with a known matchup before trusting it.
- A warrior longer than `-l` does not fail clearly: the battle prints `Results: 0 0 0`. If every result is zero, check the instruction count, then retry with a larger `-l` to confirm.
- Assembly warnings go to stderr. Read them once after an edit (a 1-round battle) before silencing stderr.
- Use absolute paths. pMARS resolves paths from the directory you launch it from.
- Time one 100-round battle first. In the observed runs it took about 0.1 s. Sweeps of hundreds of variants are practical when run in parallel (ThreadPoolExecutor sized to nproc) and in the background with nohup, so no tool call hits the timeout.

## Evaluator
- Write one script that runs the grader command for each opponent with absolute paths, parses `Results: (\\d+) (\\d+) (\\d+)` with a regex, and prints W/T/L with pass/fail against each threshold.
- Check the script on a warrior whose numbers you already know before using it. Empty or all-zero output means it is broken until shown otherwise.

## Redcode and generated code
- Addressing: `#` immediate, no prefix or `$` direct, `*` A-indirect, `@` B-indirect, `<` B-predecrement, `>` B-postincrement, `{` and `}` A-predecrement and A-postincrement. Modifiers: .A .B .AB .BA .F .X .I.
- `spl` creates a process. `dat #0,#0` ends the process that executes it. `jmp` to itself is a stable loop.
- Generating warriors from Python: `{` and `}` are Redcode operators, and str.format treats `}` as a closing brace and raises. Fill templates with str.replace on named placeholders instead.

## Method
- Before tuning, measure several candidate designs against every opponent with the grader's command. Candidates include simple classics, bundled samples, and the opponent files as-is. Use the strongest design that already passes several thresholds as the base, and tune its constants.
- Use a coarse sweep to find a region, then check the best few points with the full grader command before choosing one.
- A pass by a few wins is fragile. Report the margin, and say which conditions it depends on (placement series, pMARS version). If time allows, also check the warrior without `-f`.
- Leave the opponent files unchanged, and keep the final warrior in the project directory.