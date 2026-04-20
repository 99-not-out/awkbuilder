package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

func testHandler() http.Handler {
	return New(Config{
		Assets: fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>ok</title>")},
		},
	})
}

func TestServesIndex(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if !strings.Contains(string(body), "<title>ok</title>") {
		t.Fatalf("unexpected body: %q", body)
	}
}

// Verify the WS "run" flow: the server runs the supplied awk source,
// emits stdout lines, then a "done" message.
func TestWSRunBeginProgram(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	wsURL := "ws" + srv.URL[len("http"):] + "/ws"
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	// Expect a "hello" greeting first.
	if got := readMsg(t, ctx, c); got["type"] != "hello" {
		t.Fatalf("want hello, got %v", got)
	}

	// Ask the server to run a BEGIN-only program (no input files needed).
	req := map[string]string{"type": "run", "source": `BEGIN { print "hello-awk" }`}
	b, _ := json.Marshal(req)
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}

	var sawStdout, sawCompiled bool
	for {
		m := readMsg(t, ctx, c)
		switch m["type"] {
		case "compiled":
			sawCompiled = true
		case "stdout":
			if m["data"] == "hello-awk" {
				sawStdout = true
			}
		case "done":
			if !sawCompiled {
				t.Fatalf("done without compiled message; last: %v", m)
			}
			if !sawStdout {
				t.Fatalf("done without stdout line; last msg: %v", m)
			}
			return
		case "error":
			t.Fatalf("got error: %v", m)
		}
	}
}

// Verify the structured-model path: sending {type:"run", model:{...}}
// compiles to awk source, applies FS via Vars, and runs.
func TestWSRunModel(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	wsURL := "ws" + srv.URL[len("http"):] + "/ws"
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	_ = readMsg(t, ctx, c) // hello

	req := map[string]any{
		"type": "run",
		"model": map[string]any{
			"flags": map[string]string{"fs": ","},
			"blocks": []map[string]any{
				{"kind": "begin", "action": `print "start"`},
			},
		},
	}
	b, _ := json.Marshal(req)
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}

	var sawCompiled, sawStdout bool
	for {
		m := readMsg(t, ctx, c)
		switch m["type"] {
		case "compiled":
			sawCompiled = true
			src, _ := m["source"].(string)
			if !strings.Contains(src, `BEGIN { print "start" }`) {
				t.Fatalf("compiled.source = %q", src)
			}
			argv, _ := m["argv"].(string)
			if !strings.Contains(argv, "-F,") {
				t.Fatalf("compiled.argv = %q", argv)
			}
		case "stdout":
			if m["data"] == "start" {
				sawStdout = true
			}
		case "done":
			if !sawCompiled {
				t.Fatal("done without compiled")
			}
			if !sawStdout {
				t.Fatalf("done without expected stdout; last: %v", m)
			}
			return
		case "error":
			t.Fatalf("got error: %v", m)
		}
	}
}

func readMsg(t *testing.T, ctx context.Context, c *websocket.Conn) map[string]any {
	t.Helper()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return m
}
