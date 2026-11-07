// Package config reads HOHE's runtime configuration: a JSON file, rendered by the
// deployment and mounted read-only. It holds hashes, never raw secrets.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"

	"github.com/kevinpinscoe/hohe/server/internal/auth"
)

// Config is the runtime configuration.
type Config struct {
	Listen string `json:"listen"`
	// DataDir holds hohe.sqlite3 and sessions.sqlite3.
	DataDir string `json:"dataDir"`
	// Persistent turns on the storage guard. Off only for local development and tests.
	Persistent        bool   `json:"persistent"`
	SentinelID        string `json:"sentinelId"`
	RequireMountpoint bool   `json:"requireMountpoint"`
	// LoginPasswordBcrypt is the bcrypt hash of the login password.
	LoginPasswordBcrypt string              `json:"loginPasswordBcrypt"`
	CaptureTokens       []auth.CaptureToken `json:"captureTokens"`
	// PublicOrigin is the site's origin, e.g. https://hohe.example.com. Requests that
	// carry a different Origin are refused.
	PublicOrigin string `json:"publicOrigin"`
	// SecureCookies must be true behind HTTPS. Off only for local development.
	SecureCookies bool `json:"secureCookies"`
	// SessionDays is the sliding session lifetime.
	SessionDays int `json:"sessionDays"`
}

var hexSHA256 = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// Load reads and validates the file.
func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := &Config{Listen: ":8080", DataDir: "/data", SessionDays: 90}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return c, c.Validate()
}

// Validate checks the configuration.
func (c *Config) Validate() error {
	if c.DataDir == "" {
		return errors.New("config: dataDir is required")
	}
	if c.Persistent && c.SentinelID == "" {
		return errors.New("config: persistent mode needs sentinelId")
	}
	if c.LoginPasswordBcrypt == "" || !auth.ValidHash(c.LoginPasswordBcrypt) {
		return errors.New("config: loginPasswordBcrypt must be a bcrypt hash")
	}
	seen := map[string]bool{}
	for _, t := range c.CaptureTokens {
		if t.Name == "" || seen[t.Name] || !hexSHA256.MatchString(t.SHA256) {
			return fmt.Errorf("config: capture token %q needs a unique name and a hex sha256", t.Name)
		}
		seen[t.Name] = true
	}
	if c.PublicOrigin != "" {
		u, err := url.Parse(c.PublicOrigin)
		if err != nil || u.Scheme == "" || u.Host == "" || u.Path != "" {
			return errors.New("config: publicOrigin must look like https://host")
		}
	}
	if c.SessionDays < 1 || c.SessionDays > 400 {
		return errors.New("config: sessionDays must be 1–400")
	}
	return nil
}
