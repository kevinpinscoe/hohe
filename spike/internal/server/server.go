// Package server is the spike's HTTP layer: a JSON API over the in-memory store, plus the
// embedded PWA. There is no app-layer authentication in the spike: network restriction in
// front of it is the only access boundary, and the data is synthetic.
package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/kevinpinscoe/hohe/spike/internal/plannerday"
	"github.com/kevinpinscoe/hohe/spike/internal/store"
)

// Settings are the server-authoritative planner settings the client copies for offline use.
type Settings struct {
	TimeZone string `json:"timeZone"`
	Rollover string `json:"rollover"`
	Revision int    `json:"revision"`
}

// Server wires the store to HTTP.
type Server struct {
	Store      *store.Store
	Settings   Settings
	Loc        *time.Location
	Roll       plannerday.Rollover
	Version    string
	Static     fs.FS
	Log        *slog.Logger
	AllowReset bool
}

const maxBody = 1 << 20

// Handler returns the routed handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"version": s.Version})
	})
	mux.HandleFunc("GET /api/state", s.state)
	mux.HandleFunc("POST /api/ops", s.ops)
	mux.HandleFunc("POST /api/conflicts/{id}/keep-server", s.keepServer)
	mux.HandleFunc("POST /api/admin/reset", s.reset)
	static := http.FileServerFS(s.Static)
	mux.Handle("GET /", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sw.js" || r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		static.ServeHTTP(w, r)
	}))
	return s.securityHeaders(mux)
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) day(t time.Time) string { return plannerday.Day(t, s.Loc, s.Roll) }

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	// Real function, not liveness: the store answers a snapshot and the planner day computes.
	s.Store.Snapshot()
	if s.day(time.Now()) == "" {
		http.Error(w, "planner day unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok\n"))
}

func (s *Server) state(w http.ResponseWriter, _ *http.Request) {
	tasks, conflicts, stats := s.Store.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"settings":         s.Settings,
		"serverPlannerDay": s.day(time.Now()),
		"serverTime":       time.Now().UTC().Format(time.RFC3339),
		"tasks":            tasks,
		"conflicts":        conflicts,
		"stats":            stats,
		"version":          s.Version,
		"syntheticOnly":    true,
	})
}

func (s *Server) ops(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Ops []store.Op `json:"ops"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return
	}
	if len(body.Ops) > 500 {
		http.Error(w, "too many operations in one batch", http.StatusRequestEntityTooLarge)
		return
	}
	res := s.Store.Apply(body.Ops)
	counts := map[string]int{}
	replayed := 0
	for _, x := range res {
		counts[x.Status]++
		if x.Replayed {
			replayed++
		}
	}
	// Status counts only: never the values, so the log carries no task text.
	s.Log.Info("ops", "batch", len(body.Ops), "statuses", counts, "replayed", replayed)
	writeJSON(w, http.StatusOK, map[string]any{"results": res})
}

func (s *Server) keepServer(w http.ResponseWriter, r *http.Request) {
	c, err := s.Store.KeepServer(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "unknown conflict", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) reset(w http.ResponseWriter, _ *http.Request) {
	if !s.AllowReset {
		http.Error(w, "reset disabled", http.StatusForbidden)
		return
	}
	s.Store.Reset(true)
	s.Log.Info("reset", "seed", true)
	writeJSON(w, http.StatusOK, map[string]bool{"reset": true})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
