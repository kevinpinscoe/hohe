// Package api is HOHE's HTTP interface: the JSON API, login, the capture API, health and
// version endpoints, and the embedded PWA.
//
// Access is layered. The vhost answers only on the tailnet; the app then requires a login
// session for everything except /healthz, /version, the login itself and the static shell,
// and the capture API requires a capture token instead.
//
// State-changing requests must carry the X-HOHE-Client header (which a cross-site form
// cannot send) and, when the browser sends an Origin, the configured origin. The session
// cookie is HttpOnly, Secure and SameSite=Strict.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/kevinpinscoe/hohe/server/internal/app"
	"github.com/kevinpinscoe/hohe/server/internal/auth"
	"github.com/kevinpinscoe/hohe/server/internal/config"
	"github.com/kevinpinscoe/hohe/server/internal/domain"
	"github.com/kevinpinscoe/hohe/server/internal/store"
)

// CookieName is the session cookie. The __Host- prefix pins it to this host, path / and
// Secure (browsers enforce it); without Secure (local development) a plain name is used.
const (
	CookieName    = "__Host-hohe_session"
	DevCookieName = "hohe_session"
	ClientHeader  = "X-HOHE-Client"
)

// Build identifies the running build.
type Build struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

// Server is the HTTP handler.
type Server struct {
	Svc      *app.Service
	Sessions *store.Sessions
	Cfg      *config.Config
	Limiter  *auth.Limiter
	Static   fs.FS
	Build    Build
	Log      *slog.Logger
	mux      *http.ServeMux
}

// Handler builds the routes.
func (s *Server) Handler() http.Handler {
	if s.Log == nil {
		s.Log = slog.Default()
	}
	if s.Limiter == nil {
		s.Limiter = auth.NewLimiter()
	}
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", s.healthz)
	m.HandleFunc("GET /version", s.version)
	m.HandleFunc("POST /api/login", s.mutating(s.login))
	m.HandleFunc("POST /api/logout", s.mutating(s.logout))
	m.HandleFunc("GET /api/session", s.session)
	m.HandleFunc("GET /api/state", s.authed(s.state))
	m.HandleFunc("POST /api/sync", s.mutating(s.authed(s.sync)))
	m.HandleFunc("GET /api/history", s.authed(s.history))
	m.HandleFunc("GET /api/export", s.authed(s.export))
	m.HandleFunc("POST /api/capture", s.capture)
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeErr(w, http.StatusNotFound, "not found") })
	if s.Static != nil {
		m.Handle("/", staticHandler(s.Static))
	}
	s.mux = m
	return s.headers(m)
}

func (s *Server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" || r.URL.Path == "/version" {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func decode(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request body: "+err.Error())
		return false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "bad request body: trailing data")
		return false
	}
	return true
}

// mutating refuses cross-site requests: the client header is required, and a browser
// Origin, when present, must be the configured one.
func (s *Server) mutating(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(ClientHeader) != "1" {
			writeErr(w, http.StatusForbidden, "missing "+ClientHeader+" header")
			return
		}
		if o := r.Header.Get("Origin"); o != "" && s.Cfg.PublicOrigin != "" && o != s.Cfg.PublicOrigin {
			writeErr(w, http.StatusForbidden, "cross-origin request refused")
			return
		}
		next(w, r)
	}
}

func (s *Server) cookieName() string {
	if s.Cfg.SecureCookies {
		return CookieName
	}
	return DevCookieName
}

func (s *Server) sessionTTL() time.Duration { return time.Duration(s.Cfg.SessionDays) * 24 * time.Hour }

func (s *Server) sessionHash(r *http.Request) string {
	c, err := r.Cookie(s.cookieName())
	if err != nil || c.Value == "" || len(c.Value) > 200 {
		return ""
	}
	return auth.Hash(c.Value)
}

func (s *Server) loggedIn(r *http.Request) bool {
	h := s.sessionHash(r)
	if h == "" {
		return false
	}
	now := s.Svc.Now()
	return s.Sessions.Touch(h, now, now.Add(s.sessionTTL())) == nil
}

func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.loggedIn(r) {
			writeErr(w, http.StatusUnauthorized, "login required")
			return
		}
		next(w, r)
	}
}

func (s *Server) setCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: s.cookieName(), Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: s.Cfg.SecureCookies, SameSite: http.SameSiteStrictMode})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
		Device   string `json:"device"`
	}
	if !decode(w, r, 4096, &req) {
		return
	}
	now := s.Svc.Now()
	switch err := s.Limiter.CheckPassword(s.Cfg.LoginPasswordBcrypt, req.Password, now); {
	case errors.Is(err, auth.ErrLocked):
		s.Log.Warn("login refused: locked out")
		writeErr(w, http.StatusTooManyRequests, err.Error())
		return
	case err != nil:
		s.Log.Warn("login failed")
		writeErr(w, http.StatusUnauthorized, "wrong password")
		return
	}
	tok := auth.NewToken()
	label := req.Device
	if len(label) > 60 {
		label = label[:60]
	}
	if err := s.Sessions.Create(auth.Hash(tok), label, now, now.Add(s.sessionTTL())); err != nil {
		s.Log.Error("session create", "err", err)
		writeErr(w, http.StatusInternalServerError, "could not create session")
		return
	}
	_ = s.Sessions.Prune(now)
	s.setCookie(w, tok, int(s.sessionTTL().Seconds()))
	s.Log.Info("login", "device", label)
	writeJSON(w, http.StatusOK, map[string]bool{"loggedIn": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if h := s.sessionHash(r); h != "" {
		_ = s.Sessions.Delete(h)
	}
	s.setCookie(w, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"loggedIn": false})
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"loggedIn": s.loggedIn(r), "build": s.Build})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Svc.Health())
}

func (s *Server) version(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Build)
}

func (s *Server) state(w http.ResponseWriter, r *http.Request) {
	v, err := s.Svc.View()
	if err != nil {
		s.Log.Error("state", "err", err)
		writeErr(w, http.StatusInternalServerError, "could not read state")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": v, "build": s.Build})
}

// SyncRequest is a batch of queued operations from one device.
type SyncRequest struct {
	DeviceID string      `json:"deviceId"`
	Ops      []domain.Op `json:"ops"`
}

func (s *Server) sync(w http.ResponseWriter, r *http.Request) {
	var req SyncRequest
	if !decode(w, r, 2<<20, &req) {
		return
	}
	if req.DeviceID == "" || len(req.DeviceID) > domain.MaxIDBytes {
		writeErr(w, http.StatusBadRequest, "deviceId is required")
		return
	}
	for i := range req.Ops {
		req.Ops[i].DeviceID = req.DeviceID
	}
	results, v, err := s.Svc.Sync(req.Ops)
	if errors.Is(err, app.ErrBatch) {
		writeErr(w, http.StatusRequestEntityTooLarge, err.Error())
		return
	}
	if err != nil {
		s.Log.Error("sync", "err", err)
		writeErr(w, http.StatusInternalServerError, "could not save; nothing in this batch was applied")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results, "state": v, "build": s.Build})
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("task")
	if id == "" || len(id) > domain.MaxIDBytes {
		writeErr(w, http.StatusBadRequest, "task is required")
		return
	}
	ev, err := s.Svc.History(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read history")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": ev})
}

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	ex, err := s.Svc.Export()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not export")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="hohe-export-`+time.Now().UTC().Format("20060102-1504")+`.json"`)
	writeJSON(w, http.StatusOK, ex)
}

// CaptureRequest is the capture API's body. A title is the only required field; the others
// are applied only when given.
type CaptureRequest struct {
	Title          string `json:"title"`
	Priority       string `json:"priority,omitempty"`
	Day            string `json:"day,omitempty"`
	Deadline       string `json:"deadline,omitempty"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func (s *Server) capture(w http.ResponseWriter, r *http.Request) {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	name := ""
	if ok {
		name = auth.CheckCapture(s.Cfg.CaptureTokens, strings.TrimSpace(tok))
	}
	if name == "" {
		writeErr(w, http.StatusUnauthorized, "a valid capture token is required")
		return
	}
	var req CaptureRequest
	if !decode(w, r, 16<<10, &req) {
		return
	}
	resp, err := s.Svc.Capture(app.CaptureRequest{TokenName: name, IdempotencyKey: req.IdempotencyKey, Title: req.Title,
		Priority: req.Priority, Day: req.Day, Deadline: req.Deadline})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.Log.Info("capture", "token", name, "task", resp.TaskID, "replayed", resp.Replayed)
	writeJSON(w, http.StatusOK, resp)
}

// staticHandler serves the PWA. Unknown non-asset paths get index.html (client routing).
// The service worker and the manifest are never cached by HTTP, so updates are found.
func staticHandler(root fs.FS) http.Handler {
	files := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(root, p); err != nil {
			if strings.Contains(p, ".") {
				http.NotFound(w, r)
				return
			}
			r = r.Clone(r.Context())
			r.URL.Path = "/"
			p = "index.html"
		}
		switch {
		case p == "index.html" || p == "sw.js" || p == "manifest.webmanifest":
			w.Header().Set("Cache-Control", "no-cache")
		case strings.HasPrefix(p, "assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		files.ServeHTTP(w, r)
	})
}
