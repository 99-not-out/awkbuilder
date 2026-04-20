package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/99-not-out/awkbuilder/internal/server"
)

//go:embed all:web
var webFS embed.FS

func main() {
	port := flag.Int("port", 0, "port to listen on (0 = pick a free port)")
	noOpen := flag.Bool("no-open", false, "do not open the browser automatically")
	limit := flag.Int("limit", 0, "cap records read per input file (0 = no cap)")
	flag.Parse()

	inputs := flag.Args()

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	assets, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("embed sub: %v", err)
	}
	srv := &http.Server{Handler: server.New(server.Config{
		Inputs: inputs,
		Limit:  *limit,
		Assets: assets,
	})}

	url := fmt.Sprintf("http://%s/", ln.Addr().String())
	fmt.Printf("awkbuilder listening on %s\n", url)
	if len(inputs) > 0 {
		fmt.Printf("inputs: %v\n", inputs)
	}

	if !*noOpen {
		go openBrowser(url)
	}

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	fmt.Println("\nshutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		return
	}
	_ = cmd.Start()
}
