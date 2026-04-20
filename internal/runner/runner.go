// Package runner wraps goawk: parse a source program, execute it against a
// set of input files, and stream both stdout output and structured trace
// events to a callback.
package runner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"sync"

	"github.com/99-not-out/goawkviz/interp"
	"github.com/99-not-out/goawkviz/parser"
)

// Event is emitted by Run. Kind names match the wire protocol and the
// trace-hook hooks in goawkviz:
//
//	"stdout"        — a line written by the awk program
//	"stderr"        — a line written to error output
//	"record"        — a new input record entered the pipeline
//	"pattern"       — a pattern-action block's pattern was evaluated
//	"action-start" — an action whose pattern matched began executing
//	"action-end"   — that action finished executing
//	"done"          — execution finished, Code is the exit status
//	"error"         — execution aborted, Data is the error message
type Event struct {
	Kind string `json:"kind"`

	// stdout/stderr/error
	Data string `json:"data,omitempty"`

	// record
	Filename string `json:"filename,omitempty"`
	FNR      int    `json:"fnr,omitempty"`
	NR       int    `json:"nr,omitempty"`
	Line     string `json:"line,omitempty"`

	// pattern / action-start / action-end. Block is intentionally not
	// omitempty because block 0 is a valid (and common) value.
	Block   int  `json:"block"`
	Matched bool `json:"matched,omitempty"`

	// done
	Code int `json:"code,omitempty"`
}

type Request struct {
	Source            string
	Inputs            []string
	Vars              []string
	MaxRecordsPerFile int
}

func Run(ctx context.Context, req Request, emit func(Event)) {
	prog, err := parser.ParseProgram([]byte(req.Source), nil)
	if err != nil {
		emit(Event{Kind: "error", Data: fmt.Sprintf("parse: %v", err)})
		return
	}

	// Serialise all callbacks so the emit function is safe to assume
	// single-threaded even though stdout/stderr pipes drain on goroutines.
	var mu sync.Mutex
	safeEmit := func(ev Event) {
		mu.Lock()
		emit(ev)
		mu.Unlock()
	}

	hook := &interp.TraceHook{
		OnRecordStart: func(filename string, fnr, nr int, line string) {
			safeEmit(Event{Kind: "record", Filename: filename, FNR: fnr, NR: nr, Line: line})
		},
		OnPatternEval: func(blockIdx int, matched bool) {
			safeEmit(Event{Kind: "pattern", Block: blockIdx, Matched: matched})
		},
		OnActionStart: func(blockIdx int) {
			safeEmit(Event{Kind: "action-start", Block: blockIdx})
		},
		OnActionEnd: func(blockIdx int) {
			safeEmit(Event{Kind: "action-end", Block: blockIdx})
		},
	}

	outR, outW := io.Pipe()
	errR, errW := io.Pipe()

	var wg sync.WaitGroup
	wg.Add(2)
	go streamLines(&wg, outR, "stdout", safeEmit)
	go streamLines(&wg, errR, "stderr", safeEmit)

	cfg := &interp.Config{
		Args:              req.Inputs,
		Output:            outW,
		Error:             errW,
		Vars:              req.Vars,
		TraceHook:         hook,
		MaxRecordsPerFile: req.MaxRecordsPerFile,
		NoExec:            true,
		Environ:           []string{},
	}

	code, execErr := interp.ExecProgram(prog, cfg)

	_ = outW.Close()
	_ = errW.Close()
	wg.Wait()

	if execErr != nil {
		safeEmit(Event{Kind: "error", Data: execErr.Error()})
		return
	}
	safeEmit(Event{Kind: "done", Code: code})
}

func streamLines(wg *sync.WaitGroup, r io.Reader, kind string, emit func(Event)) {
	defer wg.Done()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		emit(Event{Kind: kind, Data: sc.Text()})
	}
}
