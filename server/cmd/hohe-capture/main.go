// Command hohe-capture adds a task to HOHE through its capture API. It is the helper a
// Claude Code session reached through /remote runs to capture by voice.
//
//	hohe-capture [--priority A|B|C] [--day YYYY-MM-DD] [--deadline YYYY-MM-DD] [--key KEY] TITLE...
//
// A title is the only required input; the task lands in the Task Dump. The optional fields
// are sent only when given: they are never inferred.
//
// Every run ends in exactly one of three outcomes, never mixed up:
//
//   - Captured (exit 0): the server's response confirms the task was accepted.
//   - Not captured (exit 1): the task definitely did not go in. Either the server refused it
//     with an error, or the request never reached the server (for example, the connection
//     could not be opened).
//   - Capture not confirmed (exit 3): the outcome is unknown. The request was sent, but no
//     confirming response came back (a timeout, a dropped connection, or a 5xx from a proxy
//     or the server). The server may have accepted the task.
//
// Network failures are retried automatically with the same idempotency key. After a failure,
// the key is printed: rerunning with --key KEY retries the same capture, and the server
// returns the original result if it already accepted it, so a retry never creates a duplicate.
//
// The server is HOHE_URL (or --url). The capture token is read from the file named by
// HOHE_CAPTURE_TOKEN_FILE (a secrets broker can inject one), or from HOHE_CAPTURE_TOKEN.
// It is never printed.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"os"
	"regexp"
	"strings"
	"time"
)

var dayRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

type request struct {
	Title          string `json:"title"`
	Priority       string `json:"priority,omitempty"`
	Day            string `json:"day,omitempty"`
	Deadline       string `json:"deadline,omitempty"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type response struct {
	TaskID   string `json:"taskId"`
	Title    string `json:"title"`
	Landed   string `json:"landed"`
	Replayed bool   `json:"replayed"`
	Error    string `json:"error"`
}

// Outcome of a run.
type Outcome int

const (
	Captured     Outcome = iota // confirmed by the server
	NotCaptured                 // definitely not accepted
	NotConfirmed                // unknown: sent, but not confirmed
)

// Exit codes per outcome.
var exitCode = map[Outcome]int{Captured: 0, NotCaptured: 1, NotConfirmed: 3}

// attemptResult is one HTTP attempt's classification.
type attemptResult struct {
	outcome   Outcome
	retryable bool
	resp      response
	detail    string
}

// config is everything run needs, so tests can drive it.
type config struct {
	base     string
	token    string
	client   *http.Client
	attempts int
	backoff  time.Duration
	out, err io.Writer
}

func main() {
	url := flag.String("url", os.Getenv("HOHE_URL"), "HOHE base URL")
	pri := flag.String("priority", "", "A, B or C (only if stated)")
	day := flag.String("day", "", "planned day YYYY-MM-DD (only if stated)")
	deadline := flag.String("deadline", "", "deadline YYYY-MM-DD (only if stated)")
	key := flag.String("key", "", "idempotency key (reuse the one printed by an earlier run)")
	flag.Parse()
	title := strings.TrimSpace(strings.Join(flag.Args(), " "))
	req := request{Title: title, Priority: strings.ToUpper(*pri), Day: *day, Deadline: *deadline, IdempotencyKey: *key}
	if err := validate(*url, req); err != nil {
		fmt.Fprintln(os.Stderr, "Not captured:", err)
		os.Exit(exitCode[NotCaptured])
	}
	tok, err := token()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Not captured:", err)
		os.Exit(exitCode[NotCaptured])
	}
	cfg := config{base: *url, token: tok, client: &http.Client{Timeout: 15 * time.Second},
		attempts: 3, backoff: 2 * time.Second, out: os.Stdout, err: os.Stderr}
	os.Exit(exitCode[run(cfg, req)])
}

func validate(base string, req request) error {
	if base == "" {
		return errors.New("no server: set HOHE_URL or --url")
	}
	if req.Title == "" {
		return errors.New("a title is required")
	}
	if req.Priority != "" && req.Priority != "A" && req.Priority != "B" && req.Priority != "C" {
		return errors.New("priority must be A, B or C")
	}
	for _, d := range []string{req.Day, req.Deadline} {
		if d != "" && !dayRE.MatchString(d) {
			return fmt.Errorf("%q is not YYYY-MM-DD", d)
		}
	}
	return nil
}

func token() (string, error) {
	if f := os.Getenv("HOHE_CAPTURE_TOKEN_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return "", fmt.Errorf("reading the capture token file: %w", err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	if t := os.Getenv("HOHE_CAPTURE_TOKEN"); t != "" {
		return strings.TrimSpace(t), nil
	}
	return "", errors.New("no capture token: set HOHE_CAPTURE_TOKEN_FILE")
}

func newKey() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// attempt sends the capture once and classifies the result. The request counts as sent
// once it has been fully written to the connection (httptrace WroteRequest without error):
// from then on, a failure is ambiguous.
func attempt(cfg config, body []byte) attemptResult {
	sent := false
	trace := &httptrace.ClientTrace{WroteRequest: func(i httptrace.WroteRequestInfo) {
		if i.Err == nil {
			sent = true
		}
	}}
	hr, err := http.NewRequest("POST", strings.TrimRight(cfg.base, "/")+"/api/capture", bytes.NewReader(body))
	if err != nil {
		return attemptResult{outcome: NotCaptured, detail: err.Error()}
	}
	hr = hr.WithContext(httptrace.WithClientTrace(hr.Context(), trace))
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("Authorization", "Bearer "+cfg.token)
	resp, err := cfg.client.Do(hr)
	if err != nil {
		if sent {
			return attemptResult{outcome: NotConfirmed, retryable: true,
				detail: "the request was sent but no response came back (" + err.Error() + ")"}
		}
		return attemptResult{outcome: NotCaptured, retryable: true,
			detail: "the request did not reach the server (" + err.Error() + ")"}
	}
	raw, rerr := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	resp.Body.Close()
	var r response
	_ = json.Unmarshal(raw, &r)
	switch {
	case rerr != nil:
		return attemptResult{outcome: NotConfirmed, retryable: true,
			detail: "the response was cut off (" + rerr.Error() + ")"}
	case resp.StatusCode == 200 && r.TaskID != "":
		return attemptResult{outcome: Captured, resp: r}
	case resp.StatusCode >= 500:
		// A proxy timeout (502/504) or a server error: the task may or may not have landed.
		return attemptResult{outcome: NotConfirmed, retryable: true,
			detail: fmt.Sprintf("the server answered HTTP %d without a confirmation", resp.StatusCode)}
	case resp.StatusCode == 200:
		return attemptResult{outcome: NotConfirmed, retryable: true,
			detail: "the server answered without a task id"}
	default:
		msg := r.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return attemptResult{outcome: NotCaptured, detail: "the server refused it: " + msg}
	}
}

// run performs the capture with retries and prints exactly one outcome.
func run(cfg config, req request) Outcome {
	if req.IdempotencyKey == "" {
		req.IdempotencyKey = newKey()
	}
	body, _ := json.Marshal(req)
	var last attemptResult
	everSent := false
	for i := 0; i < cfg.attempts; i++ {
		if i > 0 && cfg.backoff > 0 {
			time.Sleep(time.Duration(i) * cfg.backoff)
		}
		last = attempt(cfg, body)
		if last.outcome == NotConfirmed {
			everSent = true
		}
		if !last.retryable {
			break
		}
	}
	switch {
	case last.outcome == Captured:
		note := ""
		if last.resp.Replayed {
			note = " (already captured earlier with this key; not duplicated)"
		}
		fmt.Fprintf(cfg.out, "Captured: %q → %s%s\nTask id: %s\n", last.resp.Title, last.resp.Landed, note, last.resp.TaskID)
		return Captured
	case everSent && last.retryable:
		// Some attempt was sent without confirmation, and no later attempt settled it.
		fmt.Fprintf(cfg.err, "Capture not confirmed: %s.\nThe server may have accepted it. Retry with the same key, which cannot create a duplicate:\n  --key %s\n", last.detail, req.IdempotencyKey)
		return NotConfirmed
	default:
		fmt.Fprintf(cfg.err, "Not captured: %s.\n", last.detail)
		if last.retryable {
			fmt.Fprintf(cfg.err, "To retry, use the same key: --key %s\n", req.IdempotencyKey)
		}
		return NotCaptured
	}
}
