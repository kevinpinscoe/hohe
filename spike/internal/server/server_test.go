package server

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kevinpinscoe/hohe/spike/internal/plannerday"
	"github.com/kevinpinscoe/hohe/spike/internal/store"
	"github.com/kevinpinscoe/hohe/spike/web"
)

func testServer(t *testing.T, allowReset bool) *httptest.Server {
	t.Helper()
	loc, _ := time.LoadLocation("America/New_York")
	roll, _ := plannerday.ParseRollover("03:00")
	st := store.New(func(at time.Time) string { return plannerday.Day(at, loc, roll) })
	st.Reset(true)
	static, err := fs.Sub(web.Static, "static")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: st, Loc: loc, Roll: roll, Version: "test", Static: static,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), AllowReset: allowReset,
		Settings: Settings{TimeZone: "America/New_York", Rollover: "03:00", Revision: 1}}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func post(t *testing.T, url string, body any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(body)
	r, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("POST %s: %d", url, r.StatusCode)
	}
	var out map[string]any
	_ = json.NewDecoder(r.Body).Decode(&out)
	return out
}

func TestHealthVersionAndStatic(t *testing.T) {
	ts := testServer(t, false)
	for path, want := range map[string]string{"/healthz": "ok", "/version": `"test"`, "/": "HOHE", "/manifest.webmanifest": "standalone", "/sw.js": "hohe-spike-shell"} {
		r, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != 200 || !strings.Contains(string(b), want) {
			t.Errorf("%s: %d %q", path, r.StatusCode, b[:min(len(b), 80)])
		}
		if csp := r.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'self'") {
			t.Errorf("%s: CSP %q", path, csp)
		}
	}
}

func TestOpsReplayOverHTTP(t *testing.T) {
	ts := testServer(t, false)
	batch := map[string]any{"ops": []map[string]any{{"id": "op-1", "deviceId": "d", "type": "capture", "value": "Synthetic"}}}
	first := post(t, ts.URL+"/api/ops", batch)["results"].([]any)[0].(map[string]any)
	again := post(t, ts.URL+"/api/ops", batch)["results"].([]any)[0].(map[string]any)
	if first["status"] != "applied" || again["replayed"] != true || again["status"] != "applied" {
		t.Fatalf("first=%v again=%v", first, again)
	}
}

func TestConflictAndKeepServer(t *testing.T) {
	ts := testServer(t, false)
	post(t, ts.URL+"/api/ops", map[string]any{"ops": []map[string]any{{"id": "a", "type": "edit", "taskId": "seed-1", "field": "title", "value": "Desk", "baseRevision": 1}}})
	res := post(t, ts.URL+"/api/ops", map[string]any{"ops": []map[string]any{{"id": "b", "type": "edit", "taskId": "seed-1", "field": "title", "value": "Phone", "baseRevision": 1}}})
	r := res["results"].([]any)[0].(map[string]any)
	if r["status"] != "conflict" {
		t.Fatalf("want conflict: %v", r)
	}
	sr, err := http.Get(ts.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	sb, _ := io.ReadAll(sr.Body)
	sr.Body.Close()
	if strings.Contains(string(sb), `"heldOps":null`) || !strings.Contains(string(sb), `"heldOps":[]`) {
		t.Fatalf("/api/state heldOps must be [] for a conflict with no held edits: %s", sb)
	}
	c := post(t, ts.URL+"/api/conflicts/"+r["conflictId"].(string)+"/keep-server", nil)
	if c["status"] != "resolved-server" {
		t.Fatalf("keep server: %v", c)
	}
}

func TestResetDisabledAndBodyLimits(t *testing.T) {
	ts := testServer(t, false)
	r, _ := http.Post(ts.URL+"/api/admin/reset", "application/json", nil)
	if r.StatusCode != http.StatusForbidden {
		t.Errorf("reset allowed: %d", r.StatusCode)
	}
	r, _ = http.Post(ts.URL+"/api/ops", "application/json", strings.NewReader("not json"))
	if r.StatusCode != http.StatusBadRequest {
		t.Errorf("bad body: %d", r.StatusCode)
	}
}
