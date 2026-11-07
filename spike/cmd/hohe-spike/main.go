// Command hohe-spike is the HOHE Phase 2 technical spike: a minimal Go API with
// in-memory synthetic data, serving a minimal PWA. It is not the HOHE application.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kevinpinscoe/hohe/spike/internal/plannerday"
	"github.com/kevinpinscoe/hohe/spike/internal/server"
	"github.com/kevinpinscoe/hohe/spike/internal/store"
	"github.com/kevinpinscoe/hohe/spike/web"
)

// version is set at build time: -ldflags "-X main.version=<source commit>".
var version = "dev"

// Config is read from a JSON file (default /config/config.json). Every key is optional.
type Config struct {
	ListenAddr    string `json:"listen_addr"`
	TimeZone      string `json:"time_zone"`
	Rollover      string `json:"rollover"`
	SeedSynthetic *bool  `json:"seed_synthetic"`
	AllowReset    *bool  `json:"allow_reset"`
	LogLevel      string `json:"log_level"`
}

func defaults() Config {
	t := true
	return Config{ListenAddr: ":8080", TimeZone: "America/New_York", Rollover: "03:00",
		SeedSynthetic: &t, AllowReset: &t, LogLevel: "info"}
}

func loadConfig(path string) (Config, error) {
	c := defaults()
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	var f Config
	if err := json.Unmarshal(b, &f); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	if f.ListenAddr != "" {
		c.ListenAddr = f.ListenAddr
	}
	if f.TimeZone != "" {
		c.TimeZone = f.TimeZone
	}
	if f.Rollover != "" {
		c.Rollover = f.Rollover
	}
	if f.SeedSynthetic != nil {
		c.SeedSynthetic = f.SeedSynthetic
	}
	if f.AllowReset != nil {
		c.AllowReset = f.AllowReset
	}
	if f.LogLevel != "" {
		c.LogLevel = f.LogLevel
	}
	return c, nil
}

func main() { os.Exit(run()) }

func run() int {
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.BoolVar(showVersion, "v", false, "print the version and exit")
	health := flag.Bool("healthcheck", false, "probe /healthz on the local listener and exit 0 if healthy")
	cfgPath := flag.String("config", "/config/config.json", "path to config.json (optional)")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return 0
	}
	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		return 2
	}
	if *health {
		return healthcheck(cfg.ListenAddr)
	}

	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	loc, err := time.LoadLocation(cfg.TimeZone)
	if err != nil {
		log.Error("time zone", "err", err)
		return 2
	}
	roll, err := plannerday.ParseRollover(cfg.Rollover)
	if err != nil {
		log.Error("rollover", "err", err)
		return 2
	}
	static, err := fs.Sub(web.Static, "static")
	if err != nil {
		log.Error("static", "err", err)
		return 2
	}
	st := store.New(func(t time.Time) string { return plannerday.Day(t, loc, roll) })
	st.Reset(*cfg.SeedSynthetic)
	srv := &server.Server{Store: st, Loc: loc, Roll: roll, Version: version, Static: static, Log: log,
		AllowReset: *cfg.AllowReset,
		Settings:   server.Settings{TimeZone: cfg.TimeZone, Rollover: roll.String(), Revision: 1}}

	hs := &http.Server{Addr: cfg.ListenAddr, Handler: srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 120 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() { errc <- hs.ListenAndServe() }()
	log.Info("SERVER STARTED", "addr", cfg.ListenAddr, "version", version, "time_zone", cfg.TimeZone,
		"rollover", roll.String(), "storage", "in-memory, synthetic only")
	select {
	case err := <-errc:
		log.Error("listen", "err", err)
		return 1
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := hs.Shutdown(sctx); err != nil {
		log.Error("shutdown", "err", err)
		return 1
	}
	log.Info("SERVER STOPPED")
	return 0
}

func healthcheck(addr string) int {
	if len(addr) > 0 && addr[0] == ':' {
		addr = "127.0.0.1" + addr
	}
	c := http.Client{Timeout: 4 * time.Second}
	resp, err := c.Get("http://" + addr + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthcheck: status", resp.StatusCode)
		return 1
	}
	return 0
}
