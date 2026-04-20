# PLAN — Visual AWK Builder (Spike B, revised)

## Goal

A local tool that helps build, visualize, and verify an awk program against real files, producing a POSIX-compliant awk script the user can then run in a terminal with no modifications.

## Constraints driving the design

- **Output:** must be a real awk program runnable under system `awk` (POSIX).
- **Inputs:** must read files directly from the local filesystem (paths, globs, stdin). No copy-paste.
- **Viz:** must show the *stream process* — per-record trace across multiple input files, honouring `FNR` vs `NR` vs `FILENAME`, block firing order, variable updates.

## Shape

Single native CLI:

    awkbuilder [files-or-globs...]

Launches a localhost HTTP + WebSocket server and opens the browser UI. All execution happens in the Go process. The browser only renders.

## Components

### 1. `awkbuilder` CLI (Go)

- Flags: input paths/globs, `--port`, `--no-open`, `--limit N` (cap records *per input file* while iterating on the program — see trace engine).
- Embeds the frontend assets via `embed.FS`.
- WebSocket API: build program, run + trace, verify, list files, export.

### 2. Forked goawk — the trace engine

- Fork of `github.com/benhoyt/goawk`, renamed in-tree to `github.com/99-not-out/goawkviz` and consumed as a normal module dependency (pinned via tag in `go.mod`).
- Add an optional `TraceHook` on `interp.Config`:
  - `OnRecordStart(filename, fnr, nr, line)`
  - `OnPatternEval(blockIdx, matched)`
  - `OnActionStart / OnActionEnd(blockIdx)`
  - `OnVarSet(name, old, new)`
  - `OnPrint(stream, text)`
- Events fan out to a channel → WebSocket → frontend.
- Zero overhead when the hook is nil.
- **Per-file record cap.** Config option `MaxRecordsPerFile`: when `FNR` reaches the cap inside a given file, the engine skips the rest of that file's records and moves to the next input (`FNR` resets, `FILENAME` advances, `NR` continues). Preferred over a pre-read `head -N` because `FNR`/`FILENAME` semantics stay correct and no extra I/O happens. `BEGIN` and `END` still fire as normal.

### 3. System-awk verifier

- Shell out to whichever of `awk`, `gawk`, `mawk` are on `$PATH`.
- Diff stdout/stderr/exit against the goawk trace-engine run.
- Separate POSIX-lint pass flags gawk-only constructs (`gensub`, `asort`, array-of-arrays, ...) in the user's source.

### 4. Frontend (browser)

- Framework TBD — lean Svelte or Lit; embed-friendly, small bundle.
- Panels:
  - **Inputs** — ordered file list read from disk; first N lines visible; drag to reorder (order matters for `NR`/`FNR`).
  - **Flags** — `FS`, `OFS`, `RS`, `ORS` pickers with live split preview on a sample line.
  - **Blocks** — ordered list: `BEGIN`, pattern/action pairs, `END`. Each block has a pattern field and a small code editor for the action.
  - **Trace timeline** — records grouped by file with visible boundaries; `FNR` resets, `NR` monotonic; click a record to see which blocks evaluated/fired and the variable delta.
  - **Variables** — `NR`, `FNR`, `FILENAME`, `NF`, `FS`, `$0`, `$1..$NF`, user vars, live as you scrub.
  - **Output** — stdout from goawk; "Verify against system awk" button → diff.
  - **Export** — writes `program.awk` and shows the exact shell invocation (e.g. `awk -F: -f program.awk logs/*.log`).

### 5. Helpers ("get the options right")

- **FS picker** — paste or pick a sample line, click between characters → derives `FS`; or choose a preset (whitespace / `,` / `\t` / regex). Live-labels `$1`, `$2`, ... on the sample.
- **Block templates** — counters, sums, dedup, filter, format; click to scaffold.
- **Pattern helpers** — regex, range `/a/,/b/`, `NR==N`, `FNR==1` (first line of each file).

## Milestones

M0–M2 is the actual spike. M3+ is product work that only makes sense if the spike proves out.

- **M0 — skeleton.** Go CLI serving a static page from `embed.FS`; WebSocket echo endpoint.
- **M1 — run goawk.** Vendor goawk, run a hardcoded program against provided files, stream stdout over WS.
- **M2 — trace hooks.** Patch goawk to emit the event list above. Render as a plain scrolling log first. *This is the load-bearing milestone — if the hook design is ugly or the perf is bad, everything downstream is affected.*
- **M3 — program model + source generation.** JSON model `{flags, blocks: [{pattern, action}...]}`. One-way: model → awk source.
- **M4 — trace timeline UI.** Per-record timeline with file-boundary dividers; variables panel driven by the event stream.
- **M5 — helpers.** FS picker, field labeller, block templates.
- **M6 — verify.** Shell-out to system awk, diff, surface.
- **M7 — POSIX lint.** Warnings on non-POSIX constructs.

## Open questions

1. **Fork strategy.** Maintain the `TraceHook` patch in our vendored tree, or propose upstream? Start vendored; re-evaluate after M2 once the API has settled.
  -- Do not propose anything upstream at this stage
  -- Fork already made at https://github.com/99-not-out/goawkviz

2. **Event volume.** 1M records × N blocks × M variables = a lot. Need sampling, windowing, and "step to next firing of block X" controls. Design before M4, not during.
  -- the tool should allow the number of records sampled to be limited (e.g. apply a head -N to each file first, or in the instrumentation allow a short circuit after N records from each file), so you can quickly get the program correct without having to process the entire input

3. **Action editor.** Plain textarea with a goawk-parse check, or a proper syntax-highlighted editor? Start plain; revisit only if it actively hurts.
  -- agree Start plain, syntax-highlighted editor once everything else works

4. **Pattern editor.** Free-form text, or structured widgets for the common patterns? Users already know awk pattern syntax — free-form default, structured helpers for the common few.
  -- agree

5. **Frontend framework.** Pick at M0 so M1 isn't blocked. Defaulting to Svelte unless there's a reason not to.
  -- agree

## Out of scope (first pass)

- Parsing existing awk programs back into the model (source → model). One-way only.
- File-watching / auto-re-run on change.
- Non-POSIX gawk extensions as first-class features (surfaced only as lint warnings).
- Remote or multi-user operation.
- Distribution polish (homebrew, signed binaries). `go install` is enough for the spike.

## Success criterion for the spike (M0–M2)

Given two input files, a small hand-edited JSON program model, and a browser tab open to the tool: a trace log streams in showing `FILENAME`, `FNR`, `NR`, which blocks matched per record, and variable mutations — all for a program that, when exported, produces the same stdout under system `awk`.
