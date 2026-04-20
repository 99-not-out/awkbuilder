package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/coder/websocket"

	"github.com/99-not-out/awkbuilder/internal/lint"
	"github.com/99-not-out/awkbuilder/internal/program"
	"github.com/99-not-out/awkbuilder/internal/runner"
	"github.com/99-not-out/awkbuilder/internal/verify"
)

// maxSampleLines is how many leading lines of each input file are shipped
// with the "hello" greeting to power the FS picker & field labeller.
const maxSampleLines = 5

type Config struct {
	Inputs []string
	Limit  int
	Assets fs.FS // static frontend assets (already rooted, no "web/" prefix)
}

type Server struct {
	cfg Config
	mux *http.ServeMux
}

func New(cfg Config) http.Handler {
	s := &Server{cfg: cfg, mux: http.NewServeMux()}
	s.mux.Handle("/", http.FileServer(http.FS(cfg.Assets)))
	s.mux.HandleFunc("/ws", s.handleWS)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// Sample is the first few lines of an input file, shipped to the client
// so it can drive the FS picker / field labeller helpers.
type Sample struct {
	Filename string   `json:"filename"`
	Lines    []string `json:"lines"`
}

func readSamples(paths []string, maxPerFile int) []Sample {
	out := make([]Sample, 0, len(paths))
	for _, p := range paths {
		s := Sample{Filename: p}
		f, err := os.Open(p)
		if err != nil {
			out = append(out, s)
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() && len(s.Lines) < maxPerFile {
			s.Lines = append(s.Lines, sc.Text())
		}
		_ = f.Close()
		out = append(out, s)
	}
	return out
}

// Incoming WS message from the frontend.
type clientMsg struct {
	Type   string         `json:"type"`
	Source string         `json:"source,omitempty"` // raw-source escape hatch
	Model  *program.Model `json:"model,omitempty"`  // structured program
	Engine string         `json:"engine,omitempty"` // for verify
}

// Outgoing WS message to the frontend.
type serverMsg struct {
	Type string `json:"type"`

	// stdout/stderr
	Data string `json:"data,omitempty"`

	// done
	Code int `json:"code,omitempty"`

	// error
	Message string `json:"message,omitempty"`

	// hello
	Inputs  []string `json:"inputs,omitempty"`
	Limit   int      `json:"limit,omitempty"`
	Samples []Sample `json:"samples,omitempty"`
	Engines []string `json:"engines,omitempty"`

	// verify-result
	Verify *verify.Result `json:"verify,omitempty"`

	// record
	Filename string `json:"filename,omitempty"`
	FNR      int    `json:"fnr,omitempty"`
	NR       int    `json:"nr,omitempty"`
	Line     string `json:"line,omitempty"`

	// pattern / action-start / action-end. Block is not omitempty because
	// block 0 is a valid value.
	Block   int  `json:"block"`
	Matched bool `json:"matched,omitempty"`

	// compiled
	Source string       `json:"source,omitempty"`
	Argv   string       `json:"argv,omitempty"`
	Issues []lint.Issue `json:"issues,omitempty"`
}

// M1 hardcoded program used when the client sends {"type":"run"} with no source.
const defaultProgram = `BEGIN { print "--- run ---" }
{ printf "%s:%d (NR=%d) %s\n", FILENAME, FNR, NR, $0 }
END { print "--- total records:", NR, "---" }`

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"localhost", "127.0.0.1"},
	})
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}
	defer c.CloseNow()

	ctx := r.Context()

	// Greet the client with the inputs + a small sample of each file so
	// the UI can drive the FS picker / field labeller without a round trip.
	_ = writeJSON(ctx, c, serverMsg{
		Type:    "hello",
		Inputs:  s.cfg.Inputs,
		Limit:   s.cfg.Limit,
		Samples: readSamples(s.cfg.Inputs, maxSampleLines),
		Engines: verify.Detect(),
	})

	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		var msg clientMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			_ = writeJSON(ctx, c, serverMsg{Type: "error", Message: "bad json: " + err.Error()})
			continue
		}
		switch msg.Type {
		case "run":
			src, vars, ok := s.resolveProgram(ctx, c, msg)
			if !ok {
				continue
			}
			s.runProgram(ctx, c, src, vars)
		case "compile":
			s.resolveProgram(ctx, c, msg)
			// resolveProgram already emitted "compiled" or "error".
		case "verify":
			src, vars, ok := s.resolveProgram(ctx, c, msg)
			if !ok {
				continue
			}
			engine := msg.Engine
			if engine == "" {
				engine = "awk"
			}
			res := verify.Verify(ctx, verify.Request{
				Engine: engine,
				Source: src,
				Vars:   vars,
				Inputs: s.cfg.Inputs,
			})
			_ = writeJSON(ctx, c, serverMsg{Type: "verify-result", Verify: &res})
		default:
			_ = writeJSON(ctx, c, serverMsg{Type: "error", Message: "unknown type: " + msg.Type})
		}
	}
}

// resolveProgram turns an incoming clientMsg into (source, vars). It also
// emits a "compiled" message to the client so the UI can preview the text.
// If the message has neither Source nor Model, the hardcoded defaultProgram
// is used. Returns ok=false if an error was emitted and no run should follow.
func (s *Server) resolveProgram(ctx context.Context, c *websocket.Conn, msg clientMsg) (string, []string, bool) {
	var src string
	var vars []string
	var argv string

	switch {
	case msg.Model != nil:
		compiled, err := program.Compile(*msg.Model)
		if err != nil {
			_ = writeJSON(ctx, c, serverMsg{Type: "error", Message: "compile: " + err.Error()})
			return "", nil, false
		}
		src = compiled.Source
		vars = compiled.Vars
		argv = compiled.Argv
	case msg.Source != "":
		src = msg.Source
		argv = "awk -f program.awk"
	default:
		src = defaultProgram
		argv = "awk -f program.awk"
	}

	_ = writeJSON(ctx, c, serverMsg{
		Type:   "compiled",
		Source: src,
		Argv:   argv,
		Issues: lint.Lint(src),
	})
	return src, vars, true
}

func (s *Server) runProgram(ctx context.Context, c *websocket.Conn, src string, vars []string) {
	runner.Run(ctx, runner.Request{
		Source:            src,
		Vars:              vars,
		Inputs:            s.cfg.Inputs,
		MaxRecordsPerFile: s.cfg.Limit,
	}, func(ev runner.Event) {
		out := serverMsg{
			Type:     ev.Kind,
			Data:     ev.Data,
			Code:     ev.Code,
			Filename: ev.Filename,
			FNR:      ev.FNR,
			NR:       ev.NR,
			Line:     ev.Line,
			Block:    ev.Block,
			Matched:  ev.Matched,
		}
		if ev.Kind == "error" {
			out.Message = ev.Data
			out.Data = ""
		}
		_ = writeJSON(ctx, c, out)
	})
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.Write(writeCtx, websocket.MessageText, b)
}
