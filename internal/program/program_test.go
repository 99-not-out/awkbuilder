package program

import (
	"strings"
	"testing"
)

func TestCompileEmpty(t *testing.T) {
	got, err := Compile(Model{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != "" {
		t.Errorf("source = %q, want empty", got.Source)
	}
	if len(got.Vars) != 0 {
		t.Errorf("vars = %v, want empty", got.Vars)
	}
	if got.Argv != "awk -f program.awk" {
		t.Errorf("argv = %q", got.Argv)
	}
}

func TestCompileBasicBlocks(t *testing.T) {
	m := Model{
		Flags: Flags{FS: ",", OFS: ";"},
		Blocks: []Block{
			{Kind: KindBegin, Action: `print "start"`},
			{Kind: KindPattern, Pattern: "$3 > 10", Action: `print $1, $3`},
			{Kind: KindPattern, Pattern: "", Action: "count++"},
			{Kind: KindEnd, Action: `print "total:", count`},
		},
	}
	got, err := Compile(m)
	if err != nil {
		t.Fatal(err)
	}

	wantSrc := `BEGIN { print "start" }

$3 > 10 { print $1, $3 }

 { count++ }

END { print "total:", count }`
	if got.Source != wantSrc {
		t.Errorf("source mismatch:\n--got--\n%s\n--want--\n%s", got.Source, wantSrc)
	}

	if strings.Join(got.Vars, "|") != "FS|,|OFS|;" {
		t.Errorf("vars = %v", got.Vars)
	}

	if !strings.Contains(got.Argv, "-F, -v OFS=';'") {
		t.Errorf("argv = %q", got.Argv)
	}
}

func TestCompileMultilineAction(t *testing.T) {
	m := Model{
		Blocks: []Block{
			{Kind: KindPattern, Pattern: "NR==1", Action: "a = 1\nb = 2\nprint a+b"},
		},
	}
	got, _ := Compile(m)
	if !strings.Contains(got.Source, "NR==1 {\n    a = 1\n    b = 2\n    print a+b\n}") {
		t.Errorf("multiline action not indented:\n%s", got.Source)
	}
}

func TestCompileRejectsUnknownKind(t *testing.T) {
	m := Model{Blocks: []Block{{Kind: "oops", Action: "print"}}}
	if _, err := Compile(m); err == nil {
		t.Fatal("expected error for unknown kind")
	}
}
