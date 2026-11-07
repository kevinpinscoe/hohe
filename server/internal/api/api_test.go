package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/kevinpinscoe/hohe/server/internal/app"
	"github.com/kevinpinscoe/hohe/server/internal/auth"
	"github.com/kevinpinscoe/hohe/server/internal/config"
	"github.com/kevinpinscoe/hohe/server/internal/store"
)

const password = "a long synthetic test password"
const captureToken = "synthetic-capture-token-for-tests"

type env struct {
	t   *testing.T
	srv *httptest.Server
	c   *http.Client
	now time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.OpenSessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, now: time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC)}
	svc, err := app.New(db, func() time.Time { return e.now })
	if err != nil {
		t.Fatal(err)
	}
	h, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	cfg := &config.Config{DataDir: dir, LoginPasswordBcrypt: string(h), SessionDays: 90,
		CaptureTokens: []auth.CaptureToken{{Name: "claude-remote", SHA256: auth.Hash(captureToken)}}}
	static := fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>HOHE</title>")}, "sw.js": {Data: []byte("//")}}
	s := &Server{Svc: svc, Sessions: sess, Cfg: cfg, Static: static, Build: Build{Version: "test", Commit: "abc"}}
	e.srv = httptest.NewServer(s.Handler())
	t.Cleanup(func() { e.srv.Close(); db.Close(); sess.Close() })
	jar, _ := cookiejar.New(nil)
	e.c = &http.Client{Jar: jar}
	return e
}

func (e *env) do(method, path string, body any, hdr map[string]string) (int, map[string]any, string) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := e.c.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return resp.StatusCode, m, string(raw)
}

var client = map[string]string{ClientHeader: "1"}

func (e *env) login() {
	e.t.Helper()
	if code, _, raw := e.do("POST", "/api/login", map[string]string{"password": password, "device": "test"}, client); code != 200 {
		e.t.Fatalf("login: %d %s", code, raw)
	}
}

func TestPublicEndpoints(t *testing.T) {
	e := newEnv(t)
	code, m, _ := e.do("GET", "/healthz", nil, nil)
	if code != 200 || m["ok"] != true || m["rolloverCurrent"] != true {
		t.Fatalf("healthz: %d %v", code, m)
	}
	if code, m, _ := e.do("GET", "/version", nil, nil); code != 200 || m["commit"] != "abc" {
		t.Fatalf("version: %d %v", code, m)
	}
	if code, _, raw := e.do("GET", "/", nil, nil); code != 200 || !strings.Contains(raw, "HOHE") {
		t.Fatalf("shell: %d", code)
	}
	if code, _, raw := e.do("GET", "/plan/today", nil, nil); code != 200 || !strings.Contains(raw, "HOHE") {
		t.Fatalf("client route fallback: %d", code)
	}
}

func TestLoginRequired(t *testing.T) {
	e := newEnv(t)
	for _, p := range []string{"/api/state", "/api/export", "/api/history?task=x"} {
		if code, _, _ := e.do("GET", p, nil, nil); code != 401 {
			t.Errorf("%s without login: %d", p, code)
		}
	}
	if code, _, _ := e.do("POST", "/api/sync", map[string]any{"deviceId": "d", "ops": []any{}}, client); code != 401 {
		t.Errorf("sync without login: %d", code)
	}
	if code, _, _ := e.do("POST", "/api/login", map[string]string{"password": "wrong"}, client); code != 401 {
		t.Error("wrong password accepted")
	}
}

func TestCSRFDefences(t *testing.T) {
	e := newEnv(t)
	if code, _, _ := e.do("POST", "/api/login", map[string]string{"password": password}, nil); code != 403 {
		t.Errorf("login without client header: %d", code)
	}
	e.login()
	if code, _, _ := e.do("POST", "/api/sync", map[string]any{"deviceId": "d", "ops": []any{}}, nil); code != 403 {
		t.Errorf("sync without client header: %d", code)
	}
}

func TestSyncStateAndLogout(t *testing.T) {
	e := newEnv(t)
	e.login()
	code, _, raw := e.do("GET", "/api/state", nil, nil)
	if code != 200 {
		t.Fatalf("state: %d", code)
	}
	for _, k := range []string{`"tasks":[]`, `"placements":[]`, `"conflicts":[]`} {
		if !strings.Contains(raw, k) {
			t.Errorf("empty list must encode as []: missing %s", k)
		}
	}
	ops := []map[string]any{
		{"id": "o1", "type": "create", "title": "Water the synthetic ferns", "letter": "A", "day": "2026-11-03"},
		{"id": "o2", "type": "capture", "title": "Call the imaginary dentist"},
	}
	code, m, raw := e.do("POST", "/api/sync", map[string]any{"deviceId": "phone", "ops": ops}, client)
	if code != 200 {
		t.Fatalf("sync: %d %s", code, raw)
	}
	res := m["results"].([]any)
	if len(res) != 2 || res[0].(map[string]any)["status"] != "applied" {
		t.Fatalf("results: %v", res)
	}
	// A replay of the same batch is applied once.
	_, m, _ = e.do("POST", "/api/sync", map[string]any{"deviceId": "phone", "ops": ops}, client)
	r0 := m["results"].([]any)[0].(map[string]any)
	if r0["replayed"] != true {
		t.Fatalf("replay not recognized: %v", r0)
	}
	if n := len(m["state"].(map[string]any)["tasks"].([]any)); n != 2 {
		t.Fatalf("replay duplicated tasks: %d", n)
	}
	if code, _, _ := e.do("POST", "/api/logout", nil, client); code != 200 {
		t.Fatal("logout")
	}
	if code, _, _ := e.do("GET", "/api/state", nil, nil); code != 401 {
		t.Fatal("session survived logout")
	}
}

func TestCaptureAPI(t *testing.T) {
	e := newEnv(t)
	bearer := map[string]string{"Authorization": "Bearer " + captureToken}
	body := map[string]any{"title": "Call Sarah", "idempotencyKey": "k1"}
	code, m, raw := e.do("POST", "/api/capture", body, bearer)
	if code != 200 || m["landed"] != "Task Dump" || m["title"] != "Call Sarah" || m["taskId"] == "" {
		t.Fatalf("capture: %d %s", code, raw)
	}
	id := m["taskId"]
	code, m, _ = e.do("POST", "/api/capture", body, bearer)
	if code != 200 || m["replayed"] != true || m["taskId"] != id {
		t.Fatalf("retry created a duplicate: %v", m)
	}
	code, m, _ = e.do("POST", "/api/capture", map[string]any{"title": "call Sarah", "priority": "B", "day": "2026-11-07", "idempotencyKey": "k2"}, bearer)
	if code != 200 || m["landed"] != "B on 2026-11-07" {
		t.Fatalf("explicit fields: %v", m)
	}
	if code, _, _ := e.do("POST", "/api/capture", body, map[string]string{"Authorization": "Bearer wrong"}); code != 401 {
		t.Fatal("bad capture token accepted")
	}
	if code, _, _ := e.do("POST", "/api/capture", map[string]any{"title": "x"}, bearer); code != 400 {
		t.Fatal("capture without idempotency key accepted")
	}
	if code, _, _ := e.do("POST", "/api/capture", map[string]any{"title": " ", "idempotencyKey": "k3"}, bearer); code != 400 {
		t.Fatal("empty title accepted")
	}
	// A capture token is not a login.
	if code, _, _ := e.do("GET", "/api/state", nil, bearer); code != 401 {
		t.Fatal("capture token opened the API")
	}
	e.login()
	_, st, _ := e.do("GET", "/api/state", nil, nil)
	if n := len(st["state"].(map[string]any)["tasks"].([]any)); n != 2 {
		t.Fatalf("tasks after captures: %d", n)
	}
}

func TestSecurityHeaders(t *testing.T) {
	e := newEnv(t)
	resp, err := http.Get(e.srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for _, h := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"} {
		if resp.Header.Get(h) == "" {
			t.Errorf("missing %s", h)
		}
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Error("healthz must not be cached")
	}
}

func TestOriginCheckWhenConfigured(t *testing.T) {
	s := &Server{Cfg: &config.Config{PublicOrigin: "https://hohe.example"}}
	called := false
	fn := s.mutating(func(w http.ResponseWriter, r *http.Request) { called = true })
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/sync", nil)
	req.Header.Set(ClientHeader, "1")
	req.Header.Set("Origin", "https://evil.example")
	fn(rec, req)
	if called || rec.Code != 403 {
		t.Fatal("cross-origin request passed")
	}
	req.Header.Set("Origin", "https://hohe.example")
	rec = httptest.NewRecorder()
	fn(rec, req)
	if !called {
		t.Fatal("same-origin request refused")
	}
}
