// Command hohe is the HOHE server.
//
//	hohe serve --config /config/config.json       run the server
//	hohe healthcheck [--url URL]                   container health check
//	hohe snapshot --config FILE --out FILE         write a verified consistent snapshot
//	hohe verify-snapshot FILE                      check a snapshot's integrity and counts
//	hohe init-data --dir DIR --sentinel-id ID      write the sentinel into a new, empty data dir
//	hohe hash-password                             print a bcrypt hash of a password read on stdin
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/kevinpinscoe/hohe/server/internal/api"
	"github.com/kevinpinscoe/hohe/server/internal/app"
	"github.com/kevinpinscoe/hohe/server/internal/auth"
	"github.com/kevinpinscoe/hohe/server/internal/config"
	"github.com/kevinpinscoe/hohe/server/internal/guard"
	"github.com/kevinpinscoe/hohe/server/internal/store"
	"github.com/kevinpinscoe/hohe/server/web"
)

// Set at build time with -ldflags "-X main.version=… -X main.commit=…".
var (
	version = "dev"
	commit  = "unknown"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "healthcheck", "--healthcheck":
		err = healthcheck(os.Args[2:])
	case "snapshot":
		err = snapshot(os.Args[2:])
	case "verify-snapshot":
		err = verifySnapshot(os.Args[2:])
	case "init-data":
		err = initData(os.Args[2:])
	case "hash-password":
		err = hashPassword()
	case "version":
		fmt.Println(version, commit)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "hohe:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: hohe serve|healthcheck|snapshot|verify-snapshot|init-data|hash-password|version")
	os.Exit(2)
}

func openData(cfgPath string) (*config.Config, *store.Store, error) {
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return nil, nil, err
	}
	if cfg.Persistent {
		if err := guard.Check(guard.Config{Dir: cfg.DataDir, SentinelID: cfg.SentinelID, RequireMountpoint: cfg.RequireMountpoint}); err != nil {
			return nil, nil, fmt.Errorf("refusing persistent startup: %w", err)
		}
	}
	db, err := store.Open(cfg.DataDir)
	if err != nil {
		return nil, nil, err
	}
	return cfg, db, nil
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	cfgPath := fs.String("config", "/config/config.json", "config file")
	fs.Parse(args)
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, db, err := openData(*cfgPath)
	if err != nil {
		return err
	}
	defer db.Close()
	sessions, err := store.OpenSessions(cfg.DataDir)
	if err != nil {
		return err
	}
	defer sessions.Close()
	// A changed login password ends every session (the fingerprint is of the configured
	// bcrypt hash, never of the password).
	if reset, err := sessions.ResetIfCredentialChanged(auth.Hash(cfg.LoginPasswordBcrypt)); err != nil {
		return err
	} else if reset {
		log.Info("login credential changed or first start: all sessions ended")
	}
	svc, err := app.New(db, time.Now)
	if err != nil {
		return err
	}
	srv := &api.Server{Svc: svc, Sessions: sessions, Cfg: cfg, Static: web.Static(),
		Build: api.Build{Version: version, Commit: commit}, Log: log}
	hs := &http.Server{Addr: cfg.Listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 120 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		// Live rollover: check every minute; the ledger makes extra checks harmless.
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if days, err := svc.Tick(); err != nil {
					log.Error("rollover", "err", err)
				} else if len(days) > 0 {
					log.Info("rollover", "days", days)
				}
			}
		}
	}()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	log.Info("listening", "addr", cfg.Listen, "version", version, "commit", commit, "persistent", cfg.Persistent)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func healthcheck(args []string) error {
	fs := flag.NewFlagSet("healthcheck", flag.ExitOnError)
	url := fs.String("url", "http://127.0.0.1:8080/healthz", "health URL")
	fs.Parse(args)
	c := &http.Client{Timeout: 4 * time.Second}
	resp, err := c.Get(*url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var h app.Health
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil || resp.StatusCode != 200 || !h.OK {
		return fmt.Errorf("unhealthy: status %d", resp.StatusCode)
	}
	return nil
}

func snapshot(args []string) error {
	fs := flag.NewFlagSet("snapshot", flag.ExitOnError)
	cfgPath := fs.String("config", "/config/config.json", "config file")
	out := fs.String("out", "", "destination file (must not exist)")
	fs.Parse(args)
	if *out == "" {
		return errors.New("--out is required")
	}
	_, db, err := openData(*cfgPath)
	if err != nil {
		return err
	}
	defer db.Close()
	info, err := db.Snapshot(*out)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(info)
}

func verifySnapshot(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: hohe verify-snapshot FILE")
	}
	info, err := store.VerifySnapshot(args[0])
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(info)
}

func initData(args []string) error {
	fs := flag.NewFlagSet("init-data", flag.ExitOnError)
	dir := fs.String("dir", "", "the new, empty data directory")
	id := fs.String("sentinel-id", "", "sentinel id")
	fs.Parse(args)
	return guard.Init(*dir, *id)
}

// hashPassword reads one line on stdin and prints its bcrypt hash. The password is never
// echoed or logged.
func hashPassword() error {
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return errors.New("no password on stdin")
	}
	pw := strings.TrimRight(line, "\r\n")
	if len(pw) < 12 {
		return errors.New("password must be at least 12 characters")
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
	if err != nil {
		return err
	}
	if !auth.ValidHash(string(h)) {
		return errors.New("hash failed")
	}
	fmt.Println(string(h))
	return nil
}
