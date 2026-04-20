// Package program defines the structured awk program model used by the
// awkbuilder UI, plus a one-way compiler that renders it to awk source.
//
// The UI edits Model values, sends them to the server, and the server
// calls Compile to get (source, vars) which it feeds to goawk and also
// shows the user for export as a "real" awk program.
package program

import (
	"fmt"
	"strconv"
	"strings"
)

// BlockKind distinguishes the three places an action can live.
type BlockKind string

const (
	KindBegin   BlockKind = "begin"
	KindPattern BlockKind = "pattern"
	KindEnd     BlockKind = "end"
)

// Block is one piece of the program. For BEGIN/END, Pattern is ignored.
type Block struct {
	Kind    BlockKind `json:"kind"`
	Pattern string    `json:"pattern,omitempty"`
	Action  string    `json:"action"`
}

// Flags are the special variables that are commonly set outside BEGIN
// via -v / -F at the command line. Empty string means "leave default".
type Flags struct {
	FS  string `json:"fs,omitempty"`
	OFS string `json:"ofs,omitempty"`
	RS  string `json:"rs,omitempty"`
	ORS string `json:"ors,omitempty"`
}

// Model is the full editable program.
type Model struct {
	Flags  Flags   `json:"flags"`
	Blocks []Block `json:"blocks"`
}

// Compiled is the compiler's output.
type Compiled struct {
	// Source is the awk program text, ready for `awk -f` or goawk's
	// ParseProgram. It does not include flag assignments; those travel
	// separately in Vars.
	Source string

	// Vars is a flat [name, value, name, value, ...] list ready to pass
	// as interp.Config.Vars. Populated from Flags (FS/OFS/RS/ORS) that
	// were non-empty.
	Vars []string

	// Argv is the equivalent shell invocation for the user to copy and
	// run in a terminal (without filenames — the UI appends those).
	// Example: `awk -F',' -v OFS=',' -f program.awk`.
	Argv string
}

// Compile renders a Model into awk source and the flag variables.
// Returns an error if the model is malformed (e.g. unknown block kind).
func Compile(m Model) (Compiled, error) {
	var body strings.Builder
	first := true
	writeBlock := func(header, action string) {
		if !first {
			body.WriteString("\n\n")
		}
		first = false
		body.WriteString(header)
		body.WriteString(" {")
		a := strings.TrimRight(action, "\n")
		if strings.Contains(a, "\n") {
			body.WriteString("\n")
			for _, ln := range strings.Split(a, "\n") {
				body.WriteString("    ")
				body.WriteString(ln)
				body.WriteString("\n")
			}
			body.WriteString("}")
		} else if a == "" {
			body.WriteString(" }")
		} else {
			body.WriteString(" ")
			body.WriteString(a)
			body.WriteString(" }")
		}
	}

	for i, b := range m.Blocks {
		switch b.Kind {
		case KindBegin:
			writeBlock("BEGIN", b.Action)
		case KindEnd:
			writeBlock("END", b.Action)
		case KindPattern:
			head := b.Pattern
			if strings.TrimSpace(head) == "" {
				// Empty pattern means match every record: render as no pattern.
				writeBlock("", b.Action)
			} else {
				writeBlock(head, b.Action)
			}
		default:
			return Compiled{}, fmt.Errorf("block %d: unknown kind %q", i, b.Kind)
		}
	}

	var vars []string
	if m.Flags.FS != "" {
		vars = append(vars, "FS", m.Flags.FS)
	}
	if m.Flags.OFS != "" {
		vars = append(vars, "OFS", m.Flags.OFS)
	}
	if m.Flags.RS != "" {
		vars = append(vars, "RS", m.Flags.RS)
	}
	if m.Flags.ORS != "" {
		vars = append(vars, "ORS", m.Flags.ORS)
	}

	return Compiled{
		Source: body.String(),
		Vars:   vars,
		Argv:   buildArgv(m.Flags),
	}, nil
}

func buildArgv(f Flags) string {
	var parts []string
	parts = append(parts, "awk")
	// Prefer -F over -v FS when only FS is set; it's idiomatic.
	if f.FS != "" {
		parts = append(parts, "-F"+shellQuote(f.FS))
	}
	if f.OFS != "" {
		parts = append(parts, "-v", "OFS="+shellQuoteVar(f.OFS))
	}
	if f.RS != "" {
		parts = append(parts, "-v", "RS="+shellQuoteVar(f.RS))
	}
	if f.ORS != "" {
		parts = append(parts, "-v", "ORS="+shellQuoteVar(f.ORS))
	}
	parts = append(parts, "-f", "program.awk")
	return strings.Join(parts, " ")
}

// shellQuote quotes a single argument for POSIX sh. Uses single quotes
// unless the value contains a single quote itself.
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if !strings.ContainsAny(s, " \t\n\"'\\$`|&;<>(){}*?#~") {
		return s
	}
	if !strings.Contains(s, "'") {
		return "'" + s + "'"
	}
	// Fall back to a double-quoted form, escaping the nasties.
	return strconv.Quote(s)
}

// shellQuoteVar quotes the value half of a `-v NAME=VALUE` assignment.
// The whole `-v` argument is a single shell word, so we quote the value
// with the same rules as shellQuote but expect to be concatenated.
func shellQuoteVar(s string) string {
	return shellQuote(s)
}
