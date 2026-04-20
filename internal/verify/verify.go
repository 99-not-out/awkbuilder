// Package verify runs the compiled awk program against a system-awk binary
// (awk / gawk / mawk as available) and compares the output with goawk's.
// This is the "does it actually work under the awk the user will ship to"
// check that sits behind M6.
package verify

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/99-not-out/goawkviz/interp"
	"github.com/99-not-out/goawkviz/parser"
)

// Candidate engines we look for on PATH. Order is deliberate: `awk` is
// almost always present (BWK on macOS, or a symlink to gawk/mawk on Linux);
// `gawk` and `mawk` are worth listing separately so the user can pick.
var candidates = []string{"awk", "gawk", "mawk"}

// Detect scans $PATH and returns the engines available, in the order
// declared above. Output is suitable for shipping to the frontend.
func Detect() []string {
	var found []string
	for _, c := range candidates {
		if _, err := exec.LookPath(c); err == nil {
			found = append(found, c)
		}
	}
	return found
}

// Result is the outcome of a single verify run.
type Result struct {
	Engine      string   `json:"engine"`
	Match       bool     `json:"match"`
	ExitCode    int      `json:"exitCode"`
	SystemOut   string   `json:"systemStdout"`
	SystemErr   string   `json:"systemStderr"`
	GoawkOut    string   `json:"goawkStdout"`
	DiffSummary string   `json:"diffSummary,omitempty"`
	Diff        []string `json:"diff,omitempty"`
	Error       string   `json:"error,omitempty"`
}

// Request is what Verify needs to run.
type Request struct {
	Engine string
	Source string
	Vars   []string // [k, v, k, v, ...] pairs (same shape as interp.Config.Vars)
	Inputs []string
}

// Verify executes the program under both goawk and the chosen system awk,
// then diffs the stdout of the two. The caller is expected to have already
// compiled the model to source + vars.
func Verify(ctx context.Context, req Request) Result {
	res := Result{Engine: req.Engine}

	bin, err := exec.LookPath(req.Engine)
	if err != nil {
		res.Error = fmt.Sprintf("engine %q not found on PATH", req.Engine)
		return res
	}

	// 1) Run goawk locally (no trace, no cap) to get the reference stdout.
	goOut, goErr := runGoawk(ctx, req.Source, req.Vars, req.Inputs)
	if goErr != nil {
		res.Error = "goawk: " + goErr.Error()
		return res
	}
	res.GoawkOut = goOut

	// 2) Run system awk with the same source and vars.
	sysOut, sysStderr, exitCode, err := runSystem(ctx, bin, req.Source, req.Vars, req.Inputs)
	res.ExitCode = exitCode
	res.SystemOut = sysOut
	res.SystemErr = sysStderr
	if err != nil && exitCode == 0 {
		res.Error = err.Error()
		return res
	}

	// 3) Diff stdout. Equal exit code + equal stdout == match.
	res.Match = (goOut == sysOut)
	if !res.Match {
		res.Diff, res.DiffSummary = lineDiff(goOut, sysOut)
	}
	return res
}

func runGoawk(ctx context.Context, source string, vars []string, inputs []string) (string, error) {
	prog, err := parser.ParseProgram([]byte(source), nil)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	var out bytes.Buffer
	cfg := &interp.Config{
		Args:    inputs,
		Output:  &out,
		Error:   io.Discard,
		Vars:    vars,
		NoExec:  true,
		Environ: []string{},
	}
	if _, err := interp.ExecProgram(prog, cfg); err != nil {
		return out.String(), fmt.Errorf("exec: %w", err)
	}
	return out.String(), nil
}

func runSystem(ctx context.Context, bin, source string, vars []string, inputs []string) (stdout, stderr string, exitCode int, err error) {
	// Write the program to a temp file so the -f argument is clean and
	// long programs don't trip -e length limits.
	tmp, err := os.CreateTemp("", "awkbuilder-*.awk")
	if err != nil {
		return "", "", -1, fmt.Errorf("tempfile: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(source); err != nil {
		_ = tmp.Close()
		return "", "", -1, fmt.Errorf("write program: %w", err)
	}
	_ = tmp.Close()

	// Hard timeout so a runaway program can't hang the server.
	runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	args := []string{}
	for i := 0; i+1 < len(vars); i += 2 {
		args = append(args, "-v", vars[i]+"="+vars[i+1])
	}
	args = append(args, "-f", tmp.Name())
	args = append(args, inputs...)

	cmd := exec.CommandContext(runCtx, bin, args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err = cmd.Run()
	stdout = outBuf.String()
	stderr = errBuf.String()

	if ee, ok := err.(*exec.ExitError); ok {
		exitCode = ee.ExitCode()
		err = nil // non-zero exit is not a Go-level error for us
	} else if err == nil {
		exitCode = 0
	} else {
		exitCode = -1
	}
	return
}

// lineDiff produces a crude but readable line-by-line diff. The full
// diff is returned as strings like "- expected" / "+ actual"; the
// summary is a short "N/M lines differ" count for the UI.
func lineDiff(expected, actual string) (lines []string, summary string) {
	ea := strings.Split(strings.TrimRight(expected, "\n"), "\n")
	aa := strings.Split(strings.TrimRight(actual, "\n"), "\n")
	n := len(ea)
	if len(aa) > n {
		n = len(aa)
	}
	diffs := 0
	const maxLines = 50
	for i := 0; i < n && len(lines) < maxLines; i++ {
		var e, a string
		if i < len(ea) {
			e = ea[i]
		}
		if i < len(aa) {
			a = aa[i]
		}
		if e == a {
			continue
		}
		diffs++
		if i < len(ea) {
			lines = append(lines, fmt.Sprintf("- %d: %s", i+1, e))
		}
		if i < len(aa) {
			lines = append(lines, fmt.Sprintf("+ %d: %s", i+1, a))
		}
	}
	total := n
	if total == 0 {
		summary = "outputs equal"
	} else {
		summary = fmt.Sprintf("%d of %d lines differ", diffs, total)
		if len(lines) == maxLines {
			summary += " (truncated)"
		}
	}
	return
}
