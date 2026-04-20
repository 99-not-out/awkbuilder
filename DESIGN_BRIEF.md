# Design brief — awkbuilder

Paste this whole document into a Claude Design session to seed it. Upload
`web/index.html`, `web/app.js`, and a screenshot of the running app as
context. The runtime contract section is load-bearing: Design should keep
the WS message shapes intact so the exported UI drops back into the
existing Go backend.

## The product

**awkbuilder** is a local developer tool that helps a user build, visualise,
and verify an awk program against real files, producing a POSIX awk script
they can run in a terminal without modification.

It's a single native Go CLI (`awkbuilder foo.log bar.csv`) that spins up
`http://127.0.0.1:…` and opens the browser. Everything runs locally; there
is no remote backend, account, or telemetry.

## Who it's for

Mid/senior engineers and SREs who *occasionally* write awk one-liners and
keep forgetting the finer points: field-separator syntax, NR vs FNR across
multiple files, which features are portable vs gawk-only. They are fluent
in regex and shell and do not want to be babysat, but they do want to stop
losing five minutes in a CLI trial-and-error loop every time they pick up
awk again.

## Information architecture (current)

The page has two halves on wide screens, single column on narrow:

- **Editor (left column)**
  - *FS helper* — FS preset buttons (whitespace / `,` / tab / `|` / `:` /
    `;` / `=`), custom FS input (regex supported), sample-file chooser,
    clickable char strip ("click a char to make it the FS"), live field
    chips `$1..$NF` labelled as they'd split under the current FS.
  - *Program* — an ordered list of blocks (BEGIN, pattern, END). Each
    pattern block has five mode tabs: **Always / Expression / Regex /
    Field~ / Range**, with structured inputs per mode, plus a live
    "sample matches" strip (green ✓ / grey · / yellow ? per sample line).
    Actions are plain textareas. Bottom row adds blocks or applies a
    template (count per key, sum last field, dedupe, skip-header, …).
  - *Other flags* — OFS / RS / ORS inputs.
  - *Compiled source* — the generated awk program + the export-ready
    shell invocation (`awk -F: -v OFS=, -f program.awk inputs…`).
  - *POSIX lint* — warnings for gawk-isms (gensub, asort, arrays-of-arrays,
    `delete arr`, BEGINFILE, FIELDWIDTHS, FPAT, `@include`, strftime, …)
    and info-level notes for POSIX-2024 features (nextfile, `length(array)`).

- **Results (right column)** — three tabs over a shared panel:
  - *Trace* — per-record timeline grouped by input file with sticky file
    dividers. Each row: FNR · NR · coloured dots (one per pattern block,
    green=fired, yellow=matched-no-body, grey=miss) · record text.
    Click a row to populate the detail panel below: FILENAME / NR / FNR /
    NF / FS / $0 / per-field table / per-block pattern status.
  - *Stdout* — stdout + stderr stream, coloured by stream.
  - *Verify* — match/differs badge, engine (awk/gawk/mawk), exit code,
    coloured diff (`-` = goawk expected, `+` = system awk actual).

- **Sticky top bar** — brand · connection dot · input summary · prev/next
  record stepper · exit badge · **Run** · **Verify** · engine dropdown.

## Pain points to solve

1. The FS helper and program section compete for visual weight. The
   program is the main creative activity; the FS helper is a setup step.
2. Pattern-mode tabs live inside every pattern block, so they repeat a
   lot. When a block is in "Always" mode, the inputs collapse to a single
   italic line, but the tab row still takes up a full row of chrome.
3. The match-preview dots ($1..$NF chips, sample-matches row) use the
   same dot vocabulary in two different places; users have reported
   conflating them.
4. The trace dot strip (matched vs fired) is dense but unlabelled in the
   timeline header; the legend only appears in tooltips.
5. Long record lines wrap awkwardly in the timeline; ideally one line per
   record with horizontal scroll on the line text.
6. The detail panel's "patterns" section repeats the same block source in
   every row; it should reference block index only, with hover/tooltip
   showing the source.
7. Nothing surfaces when Run is in-flight for a large input — no spinner
   in the trace column, no hint that records are streaming.
8. The export story ends at "copy the argv line" — a richer "here is the
   program, here is how to run it, here is a one-liner you can paste"
   card would be a natural end state.

## Must-keep constraints

- **Pure Lit + static HTML.** No build step. ESM from `./vendor/lit-all.min.js`.
- **Dark theme by default.** Terminal-adjacent tool; users stare at it
  for long sessions.
- **Monospace for all program/source/trace content.** System UI font for
  chrome (labels, buttons, summaries).
- **Keyboard-friendly.** At minimum, Run (Cmd/Ctrl+Enter), prev/next record
  (←/→ when trace tab is focused), tab-switch (⌘1/⌘2/⌘3).
- **Information density matters.** This is a power-user tool. Don't pad
  everything to breathe; an engineer wants to see their whole program +
  trace on one screen.

## Runtime contract (WS — do not break)

The frontend opens a WebSocket to `/ws` and exchanges JSON messages:

**Server → client**

- `{type:"hello", inputs:[...], limit:N, samples:[{filename, lines:[...]}], engines:["awk",...]}`
- `{type:"compiled", source:"…", argv:"awk -F… -f program.awk", issues:[{severity,rule,message,line,col,snippet}]}`
- `{type:"record", filename, fnr, nr, line}`
- `{type:"pattern", block, matched}`
- `{type:"action-start", block}` / `{type:"action-end", block}`
- `{type:"stdout", data}` / `{type:"stderr", data}`
- `{type:"done", code}` / `{type:"error", message}`
- `{type:"verify-result", verify:{engine, match, exitCode, systemStdout, systemStderr, goawkStdout, diffSummary, diff:[...], error}}`

**Client → server**

- `{type:"compile", model}` — preview only
- `{type:"run", model}` — execute and stream trace + stdout
- `{type:"verify", model, engine}` — run system awk, diff vs goawk

The `model` shape:
```json
{
  "flags": { "fs": "", "ofs": "", "rs": "", "ors": "" },
  "blocks": [
    { "kind": "begin"|"pattern"|"end",
      "pattern": "awk pattern string, canonical",
      "patternMode": "always"|"expr"|"regex"|"field"|"range",
      "action": "awk action body, no surrounding braces" }
  ]
}
```

`patternMode` is a UI hint only; the backend uses `pattern` as the source
of truth.

## Out of scope

- Parsing arbitrary hand-written awk programs back into the model.
- Multi-user / remote / account features.
- Visualising the action body itself (too open-ended — we only visualise
  structure, not arbitrary action logic).
- Styling so fancy it obscures which panel is the editor and which is the
  output.

## What I'd love from the design pass

- A clearer visual split between "building the program" (chrome-heavy,
  structured) and "running / exploring results" (data-heavy, monospace).
- Calmer pattern editor: maybe the mode is a dropdown rather than five
  tabs per block, so BEGIN/END and Always-mode patterns are visually
  quieter than active expression/regex patterns.
- A more honest trace row: file name is redundant after the sticky
  divider; the only things that matter per-row are FNR, the block dots,
  and the record text.
- An end-of-session "export" state: copy-to-clipboard, a small "ready to
  ship" card with the program + invocation + any POSIX lint warnings
  repeated inline.
- Take a position on empty/loading/error states so they don't feel like
  afterthoughts.
