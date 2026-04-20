// Package lint flags non-POSIX constructs in an awk program so the user
// knows which parts may fail under the awk they'll ship to.
//
// The rules are intentionally conservative: false positives over false
// negatives. Strings and comments are stripped before matching to keep
// "print \"gensub\"" from tripping the gensub rule.
package lint

import (
	"regexp"
	"strings"
)

type Severity string

const (
	Warn Severity = "warn"
	Info Severity = "info"
)

// Issue is a single linter finding.
type Issue struct {
	Severity Severity `json:"severity"`
	Rule     string   `json:"rule"`
	Message  string   `json:"message"`
	Line     int      `json:"line"` // 1-based line in the compiled source
	Col      int      `json:"col"`  // 1-based column of the match start
	Snippet  string   `json:"snippet,omitempty"`
}

type rule struct {
	id       string
	severity Severity
	pattern  *regexp.Regexp
	message  string
}

var rules = []rule{
	{"gawk/gensub", Warn,
		regexp.MustCompile(`\bgensub\s*\(`),
		"gensub() is a gawk extension; BWK and mawk don't provide it (use gsub/sub/substr instead)"},
	{"gawk/asort", Warn,
		regexp.MustCompile(`\b(asort|asorti)\s*\(`),
		"asort/asorti are gawk extensions; not in POSIX"},
	{"gawk/strftime", Warn,
		regexp.MustCompile(`\bstrftime\s*\(`),
		"strftime() is a gawk extension"},
	{"gawk/systime", Warn,
		regexp.MustCompile(`\bsystime\s*\(`),
		"systime() is a gawk extension"},
	{"gawk/mktime", Warn,
		regexp.MustCompile(`\bmktime\s*\(`),
		"mktime() is a gawk extension"},
	{"gawk/beginfile", Warn,
		regexp.MustCompile(`\bBEGINFILE\b`),
		"BEGINFILE is a gawk extension (use FNR==1 instead)"},
	{"gawk/endfile", Warn,
		regexp.MustCompile(`\bENDFILE\b`),
		"ENDFILE is a gawk extension"},
	{"gawk/fieldwidths", Warn,
		regexp.MustCompile(`\bFIELDWIDTHS\b`),
		"FIELDWIDTHS is a gawk extension for fixed-width fields"},
	{"gawk/fpat", Warn,
		regexp.MustCompile(`\bFPAT\b`),
		"FPAT is a gawk extension"},
	{"gawk/include", Warn,
		regexp.MustCompile(`(?m)^\s*@include\b`),
		"@include is a gawk extension; POSIX awk has no include mechanism"},
	{"gawk/array-of-arrays", Warn,
		regexp.MustCompile(`\w+\[[^\]]+\]\s*\[`),
		"arrays-of-arrays (a[i][j]) are a gawk extension; POSIX uses subscript concatenation a[i,j]"},
	// Terminator excludes identifier chars so \w* can't backtrack into a
	// false match on things like "delete counts[...]".
	{"gawk/delete-whole-array", Warn,
		regexp.MustCompile(`(?m)\bdelete[ \t]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*$|[ \t]*[^[A-Za-z0-9_ \t])`),
		"`delete arr` (without an index) is a gawk extension; POSIX requires deleting specific keys"},
	// Informational: supported by modern awks but not strictly classical.
	{"posix2024/nextfile", Info,
		regexp.MustCompile(`\bnextfile\b`),
		"nextfile is in POSIX 2024 and supported by BWK/gawk/mawk; very old awks may not have it"},
	{"posix2024/length-array", Info,
		regexp.MustCompile(`\blength\s*\(\s*[A-Za-z_]\w*\s*\)`),
		"length(array) is POSIX 2024; older BWK reports length of the string form instead — verify against your target awk"},
}

// Lint scans the source and returns any rule violations it finds.
// Each issue's Line/Col refer to the original source's line/column.
func Lint(source string) []Issue {
	cleaned := stripCommentsAndStrings(source)
	var issues []Issue
	for _, r := range rules {
		for _, loc := range r.pattern.FindAllStringIndex(cleaned, -1) {
			line, col := offsetToLineCol(cleaned, loc[0])
			issues = append(issues, Issue{
				Severity: r.severity,
				Rule:     r.id,
				Message:  r.message,
				Line:     line,
				Col:      col,
				Snippet:  lineAt(source, line),
			})
		}
	}
	return issues
}

// stripCommentsAndStrings returns source with comments blanked out and
// string-literal contents replaced by spaces. Byte offsets are preserved
// so Lint's line/col calculations remain accurate for the original source.
func stripCommentsAndStrings(source string) string {
	b := make([]byte, len(source))
	inStr := false
	inComment := false
	escape := false
	for i := 0; i < len(source); i++ {
		c := source[i]
		if c == '\n' {
			b[i] = '\n'
			inStr = false
			inComment = false
			escape = false
			continue
		}
		if inComment {
			b[i] = ' '
			continue
		}
		if inStr {
			if escape {
				escape = false
				b[i] = ' '
				continue
			}
			if c == '\\' {
				escape = true
				b[i] = ' '
				continue
			}
			if c == '"' {
				inStr = false
				b[i] = '"'
				continue
			}
			b[i] = ' '
			continue
		}
		if c == '#' {
			inComment = true
			b[i] = ' '
			continue
		}
		if c == '"' {
			inStr = true
			b[i] = '"'
			continue
		}
		b[i] = c
	}
	return string(b)
}

func offsetToLineCol(s string, off int) (line, col int) {
	if off < 0 {
		return 1, 1
	}
	if off > len(s) {
		off = len(s)
	}
	line = 1
	lineStart := 0
	for i := 0; i < off; i++ {
		if s[i] == '\n' {
			line++
			lineStart = i + 1
		}
	}
	col = off - lineStart + 1
	return
}

func lineAt(s string, line int) string {
	if line < 1 {
		return ""
	}
	cur := 1
	start := 0
	for i := 0; i < len(s); i++ {
		if cur == line {
			end := strings.IndexByte(s[i:], '\n')
			if end < 0 {
				return s[i:]
			}
			return s[i : i+end]
		}
		if s[i] == '\n' {
			cur++
			start = i + 1
		}
	}
	if cur == line {
		return s[start:]
	}
	return ""
}
