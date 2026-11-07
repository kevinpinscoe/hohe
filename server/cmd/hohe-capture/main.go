// Command hohe-capture adds a task to HOHE through its capture API. It is the helper a
// Claude Code session reached through /remote runs to capture by voice.
//
//	hohe-capture [--priority A|B|C] [--day YYYY-MM-DD] [--deadline YYYY-MM-DD] [--key KEY] TITLE...
//
// A title is the only required input; the task lands in the Task Dump. The optional fields
// are sent only when given: they are never inferred. Success is printed only after the
// server accepts the task. Network failures are retried with the same idempotency key, so
// a retry can never create a duplicate; the key is printed on failure so a manual rerun
// with --key reuses it.
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

func main() {
	url := flag.String("url", os.Getenv("HOHE_URL"), "HOHE base URL")
	pri := flag.String("priority", "", "A, B or C (only if stated)")
	day := flag.String("day", "", "planned day YYYY-MM-DD (only if stated)")
	deadline := flag.String("deadline", "", "deadline YYYY-MM-DD (only if stated)")
	key := flag.String("key", "", "idempotency key (reuse one printed by a failed run)")
	flag.Parse()
	title := strings.TrimSpace(strings.Join(flag.Args(), " "))
	if err := run(*url, request{Title: title, Priority: strings.ToUpper(*pri), Day: *day, Deadline: *deadline, IdempotencyKey: *key}); err != nil {
		fmt.Fprintln(os.Stderr, "NOT captured:", err)
		os.Exit(1)
	}
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

func run(base string, req request) error {
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
	tok, err := token()
	if err != nil {
		return err
	}
	if req.IdempotencyKey == "" {
		var b [12]byte
		rand.Read(b[:])
		req.IdempotencyKey = hex.EncodeToString(b[:])
	}
	body, _ := json.Marshal(req)
	c := &http.Client{Timeout: 15 * time.Second}
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		hr, _ := http.NewRequest("POST", strings.TrimRight(base, "/")+"/api/capture", bytes.NewReader(body))
		hr.Header.Set("Content-Type", "application/json")
		hr.Header.Set("Authorization", "Bearer "+tok)
		resp, err := c.Do(hr)
		if err != nil {
			last = err // network failure: retry with the same key
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
		var r response
		_ = json.Unmarshal(raw, &r)
		if resp.StatusCode >= 500 {
			last = fmt.Errorf("server error %d", resp.StatusCode)
			continue
		}
		if resp.StatusCode != 200 || r.TaskID == "" {
			msg := r.Error
			if msg == "" {
				msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
			}
			return errors.New(msg) // the server refused it: not retryable
		}
		note := ""
		if r.Replayed {
			note = " (already captured earlier; not duplicated)"
		}
		fmt.Printf("Captured: %q → %s%s\nTask id: %s\n", r.Title, r.Landed, note, r.TaskID)
		return nil
	}
	return fmt.Errorf("%v (retry with --key %s to avoid a duplicate)", last, req.IdempotencyKey)
}
