// Package guard refuses persistent startup against an absent or incorrect data directory.
//
// It is the application's half of HOHE's storage guard. The host's half (outside the container) checks
// that the expected block device is mounted at the expected path and carries the PIM
// volume sentinel, before the container starts. This half checks, inside the container,
// that the data directory is a mount point and carries HOHE's own sentinel. HOHE never
// creates its database in a directory that lacks the sentinel, so it can never write to an
// empty mountpoint.
package guard

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SentinelFile is HOHE's own sentinel, in the root of its data directory.
const SentinelFile = ".hohe-data-sentinel"

// Config says what to check.
type Config struct {
	Dir               string
	SentinelID        string // the expected first line of the sentinel
	RequireMountpoint bool   // the data directory must itself be a mount point
	MountInfo         string // defaults to /proc/self/mountinfo
}

// Check returns nil only when the data directory is the expected one.
func Check(c Config) error {
	if c.SentinelID == "" {
		return errors.New("guard: no sentinel id configured; refusing persistent startup")
	}
	dir, err := filepath.Abs(c.Dir)
	if err != nil {
		return err
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("guard: data directory %s: %w", dir, err)
	}
	if !fi.IsDir() {
		return fmt.Errorf("guard: %s is not a directory", dir)
	}
	if c.RequireMountpoint {
		mi := c.MountInfo
		if mi == "" {
			mi = "/proc/self/mountinfo"
		}
		ok, err := isMountpoint(dir, mi)
		if err != nil {
			return fmt.Errorf("guard: reading mounts: %w", err)
		}
		if !ok {
			return fmt.Errorf("guard: %s is not a mount point; the HOHE volume is not mounted", dir)
		}
	}
	b, err := os.ReadFile(filepath.Join(dir, SentinelFile))
	if err != nil {
		return fmt.Errorf("guard: sentinel %s missing: the directory is not HOHE's provisioned data directory", filepath.Join(dir, SentinelFile))
	}
	got := strings.TrimSpace(strings.SplitN(string(b), "\n", 2)[0])
	if got != c.SentinelID {
		return fmt.Errorf("guard: sentinel says %q, expected %q", got, c.SentinelID)
	}
	return nil
}

func isMountpoint(dir, mountinfo string) (bool, error) {
	f, err := os.Open(mountinfo)
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		// Field 5 is the mount point, with spaces etc. octal-escaped.
		fields := strings.Fields(sc.Text())
		if len(fields) >= 5 && unescape(fields[4]) == dir {
			return true, nil
		}
	}
	return false, sc.Err()
}

func unescape(s string) string {
	r := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return r.Replace(s)
}

// Init writes the sentinel into an empty directory. It refuses a directory that already
// holds anything, so it can never adopt an existing database or a wrong volume.
func Init(dir, sentinelID string) error {
	if sentinelID == "" || strings.ContainsAny(sentinelID, "\n\r") {
		return errors.New("guard: a one-line sentinel id is required")
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(ents) > 0 {
		return fmt.Errorf("guard: %s is not empty; refusing to initialize it", dir)
	}
	return os.WriteFile(filepath.Join(dir, SentinelFile), []byte(sentinelID+"\n"), 0o444)
}
