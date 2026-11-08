package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeHOHE is a capture API that remembers idempotency keys, like the real server.
type fakeHOHE struct {
	mu        sync.Mutex
	keys      map[string]string
	hits      int
	behaviour func(hit int, w http.ResponseWriter, r *http.Request) bool // true = handled
}

func newFake() *fakeHOHE { return &fakeHOHE{keys: map[string]string{}} }

func (f *fakeHOHE) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.hits++
	hit := f.hits
	f.mu.Unlock()
	var req request
	_ = json.NewDecoder(r.Body).Decode(&req)
	if r.Header.Get("Authorization") != "Bearer tok" {
		w.WriteHeader(401)
		io.WriteString(w, `{"error":"a valid capture token is required"}`)
		return
	}
	// The server accepts first, then the behaviour may lose the response.
	f.mu.Lock()
	id, replay := f.keys[req.IdempotencyKey]
	if !replay {
		id = "t" + string(rune('0'+len(f.keys)))
		f.keys[req.IdempotencyKey] = id
	}
	f.mu.Unlock()
	f.mu.Lock()
	b := f.behaviour
	f.mu.Unlock()
	if b != nil && b(hit, w, r) {
		return
	}
	json.NewEncoder(w).Encode(response{TaskID: id, Title: req.Title, Landed: "Task Dump", Replayed: replay})
}

func (f *fakeHOHE) setBehaviour(b func(int, http.ResponseWriter, *http.Request) bool) {
	f.mu.Lock()
	f.behaviour = b
	f.mu.Unlock()
}

func (f *fakeHOHE) tasks() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.keys) }

func cfgFor(base string, out, errw *bytes.Buffer) config {
	return config{base: base, token: "tok", client: &http.Client{Timeout: 300 * time.Millisecond},
		attempts: 3, out: out, err: errw}
}

func TestCaptured(t *testing.T) {
	f := newFake()
	s := httptest.NewServer(f)
	defer s.Close()
	var out, errw bytes.Buffer
	if got := run(cfgFor(s.URL, &out, &errw), request{Title: "Call the synthetic plumber", IdempotencyKey: "k1"}); got != Captured {
		t.Fatalf("outcome %v, stderr %s", got, errw.String())
	}
	if !strings.Contains(out.String(), "Captured: \"Call the synthetic plumber\" → Task Dump") {
		t.Fatalf("stdout %q", out.String())
	}
	// A rerun with the same key is confirmed as a replay, not a duplicate.
	out.Reset()
	run(cfgFor(s.URL, &out, &errw), request{Title: "Call the synthetic plumber", IdempotencyKey: "k1"})
	if !strings.Contains(out.String(), "not duplicated") || f.tasks() != 1 {
		t.Fatalf("replay: %q, tasks %d", out.String(), f.tasks())
	}
}

func TestRefusedIsNotCaptured(t *testing.T) {
	s := httptest.NewServer(newFake())
	defer s.Close()
	var out, errw bytes.Buffer
	cfg := cfgFor(s.URL, &out, &errw)
	cfg.token = "wrong"
	if got := run(cfg, request{Title: "x", IdempotencyKey: "k"}); got != NotCaptured {
		t.Fatalf("outcome %v", got)
	}
	if !strings.HasPrefix(errw.String(), "Not captured: the server refused it: a valid capture token is required") {
		t.Fatalf("stderr %q", errw.String())
	}
	if strings.Contains(errw.String(), "not confirmed") {
		t.Fatal("a definite refusal was worded as not confirmed")
	}
}

func TestUnreachableIsNotCaptured(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close() // nothing listens: the connection is refused before anything is sent
	var out, errw bytes.Buffer
	if got := run(cfgFor("http://"+addr, &out, &errw), request{Title: "x", IdempotencyKey: "kk"}); got != NotCaptured {
		t.Fatalf("outcome %v: %s", got, errw.String())
	}
	if !strings.Contains(errw.String(), "did not reach the server") || !strings.Contains(errw.String(), "--key kk") {
		t.Fatalf("stderr %q", errw.String())
	}
}

func TestTimeoutAfterAcceptanceIsNotConfirmed(t *testing.T) {
	f := newFake()
	// The server accepts the task, then never answers: every attempt times out.
	f.behaviour = func(hit int, w http.ResponseWriter, r *http.Request) bool {
		time.Sleep(time.Second)
		return true
	}
	s := httptest.NewServer(f)
	defer s.Close()
	var out, errw bytes.Buffer
	if got := run(cfgFor(s.URL, &out, &errw), request{Title: "Water the synthetic ferns", IdempotencyKey: "k-amb"}); got != NotConfirmed {
		t.Fatalf("outcome %v: %s", got, errw.String())
	}
	e := errw.String()
	if !strings.HasPrefix(e, "Capture not confirmed:") || !strings.Contains(e, "may have accepted") || !strings.Contains(e, "--key k-amb") {
		t.Fatalf("stderr %q", e)
	}
	if strings.Contains(e, "Not captured") || out.Len() != 0 {
		t.Fatal("an ambiguous timeout was reported as a definite outcome")
	}
	// It did land, exactly once, despite three attempts with the same key.
	if f.tasks() != 1 {
		t.Fatalf("tasks %d", f.tasks())
	}
	// The retry the message suggests confirms it without a duplicate.
	f.setBehaviour(nil)
	out.Reset()
	if got := run(cfgFor(s.URL, &out, &errw), request{Title: "Water the synthetic ferns", IdempotencyKey: "k-amb"}); got != Captured || f.tasks() != 1 {
		t.Fatalf("retry: %v, tasks %d", got, f.tasks())
	}
	if !strings.Contains(out.String(), "not duplicated") {
		t.Fatalf("retry stdout %q", out.String())
	}
}

func TestProxy504IsNotConfirmed(t *testing.T) {
	f := newFake()
	f.behaviour = func(hit int, w http.ResponseWriter, r *http.Request) bool {
		w.WriteHeader(504)
		return true
	}
	s := httptest.NewServer(f)
	defer s.Close()
	var out, errw bytes.Buffer
	if got := run(cfgFor(s.URL, &out, &errw), request{Title: "x", IdempotencyKey: "k504"}); got != NotConfirmed {
		t.Fatalf("outcome %v", got)
	}
	if !strings.Contains(errw.String(), "HTTP 504") {
		t.Fatalf("stderr %q", errw.String())
	}
}

func TestRecoveryWithinRetries(t *testing.T) {
	f := newFake()
	// First attempt: accepted, then the response is lost. Second attempt: replayed and confirmed.
	f.behaviour = func(hit int, w http.ResponseWriter, r *http.Request) bool {
		if hit == 1 {
			time.Sleep(time.Second)
			return true
		}
		return false
	}
	s := httptest.NewServer(f)
	defer s.Close()
	var out, errw bytes.Buffer
	if got := run(cfgFor(s.URL, &out, &errw), request{Title: "x", IdempotencyKey: "k-rec"}); got != Captured {
		t.Fatalf("outcome %v: %s", got, errw.String())
	}
	if f.tasks() != 1 || !strings.Contains(out.String(), "not duplicated") {
		t.Fatalf("tasks %d, stdout %q", f.tasks(), out.String())
	}
}

// scriptedTransport makes attempt 1 a real request that is sent and then times out, and
// every later attempt fail before anything is written (as a refused connection would).
type scriptedTransport struct {
	mu    sync.Mutex
	calls int
}

func (s *scriptedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	s.mu.Lock()
	s.calls++
	n := s.calls
	s.mu.Unlock()
	if n == 1 {
		return http.DefaultTransport.RoundTrip(r)
	}
	return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
}

func TestSentThenUnreachableStaysNotConfirmed(t *testing.T) {
	f := newFake()
	f.behaviour = func(hit int, w http.ResponseWriter, r *http.Request) bool {
		time.Sleep(time.Second)
		return true
	}
	s := httptest.NewServer(f)
	defer s.Close()
	var out, errw bytes.Buffer
	cfg := cfgFor(s.URL, &out, &errw)
	cfg.client.Transport = &scriptedTransport{}
	if got := run(cfg, request{Title: "x", IdempotencyKey: "k-mix"}); got != NotConfirmed {
		t.Fatalf("outcome %v: %s", got, errw.String())
	}
	if !strings.HasPrefix(errw.String(), "Capture not confirmed:") {
		t.Fatalf("an earlier sent attempt must keep the outcome not confirmed: %q", errw.String())
	}
}

func TestValidate(t *testing.T) {
	for _, c := range []struct {
		base string
		req  request
	}{
		{"", request{Title: "x"}},
		{"http://h", request{}},
		{"http://h", request{Title: "x", Priority: "D"}},
		{"http://h", request{Title: "x", Day: "Saturday"}},
	} {
		if validate(c.base, c.req) == nil {
			t.Errorf("accepted %+v", c)
		}
	}
	if validate("http://h", request{Title: "x", Priority: "B", Day: "2026-11-14"}) != nil {
		t.Error("rejected a valid request")
	}
}
