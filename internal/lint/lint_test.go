package lint

import (
	"strings"
	"testing"
)

func findRule(t *testing.T, src, rule string) Issue {
	t.Helper()
	for _, is := range Lint(src) {
		if is.Rule == rule {
			return is
		}
	}
	t.Fatalf("rule %q not flagged on source:\n%s", rule, src)
	return Issue{}
}

func assertNoRule(t *testing.T, src, rule string) {
	t.Helper()
	for _, is := range Lint(src) {
		if is.Rule == rule {
			t.Fatalf("rule %q unexpectedly flagged on:\n%s\nissue: %+v", rule, src, is)
		}
	}
}

func TestFlagsGensub(t *testing.T) {
	is := findRule(t, `{ print gensub(/x/, "y", 1) }`, "gawk/gensub")
	if is.Line != 1 {
		t.Errorf("line = %d", is.Line)
	}
}

func TestStringsAreIgnored(t *testing.T) {
	// "gensub" inside a string literal should not trip the rule.
	assertNoRule(t, `{ print "we use gensub() like this" }`, "gawk/gensub")
}

func TestCommentsAreIgnored(t *testing.T) {
	assertNoRule(t, `{ x = 1 } # gensub() is gawk-only`, "gawk/gensub")
}

func TestFlagsArrayOfArrays(t *testing.T) {
	findRule(t, `{ a[1][2] = 3 }`, "gawk/array-of-arrays")
}

func TestFlagsBeginfile(t *testing.T) {
	findRule(t, `BEGINFILE { print FILENAME }`, "gawk/beginfile")
}

func TestFlagsAtInclude(t *testing.T) {
	findRule(t, "@include \"lib.awk\"\n{ print }", "gawk/include")
}

func TestFlagsDeleteWholeArray(t *testing.T) {
	findRule(t, `END { delete counts }`, "gawk/delete-whole-array")
	// `delete counts[k]` is POSIX and must NOT fire.
	assertNoRule(t, `END { delete counts["a"] }`, "gawk/delete-whole-array")
}

func TestInfoSeverityForNextfile(t *testing.T) {
	is := findRule(t, `{ if (FNR > 3) nextfile }`, "posix2024/nextfile")
	if is.Severity != Info {
		t.Errorf("severity = %q, want info", is.Severity)
	}
}

func TestCleanProgramHasNoIssues(t *testing.T) {
	src := `BEGIN { FS=":" }
/nologin/ { n++ }
$7 ~ /bash/ { b++ }
END { printf "n=%d b=%d\n", n, b }`
	issues := Lint(src)
	for _, is := range issues {
		// length(array) info could fire since the "length" substring appears
		// in various forms; make sure our clean example has no warns.
		if is.Severity == Warn {
			t.Errorf("unexpected warn on clean source: %+v", is)
		}
	}
}

func TestLineNumbersAreAccurate(t *testing.T) {
	src := "BEGIN { x = 1 }\n{ y = gensub(/a/, \"b\", 1) }\nEND { print y }"
	is := findRule(t, src, "gawk/gensub")
	if is.Line != 2 {
		t.Errorf("line = %d, want 2", is.Line)
	}
	if !strings.Contains(is.Snippet, "gensub") {
		t.Errorf("snippet = %q", is.Snippet)
	}
}
