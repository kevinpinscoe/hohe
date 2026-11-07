package guard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGuard(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{Dir: dir, SentinelID: "hohe-test-volume"}
	if err := Check(cfg); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("empty dir accepted: %v", err)
	}
	if err := Init(dir, "hohe-test-volume"); err != nil {
		t.Fatal(err)
	}
	if err := Check(cfg); err != nil {
		t.Fatal(err)
	}
	if err := Init(dir, "hohe-test-volume"); err == nil {
		t.Fatal("init of a non-empty dir accepted")
	}
	if err := Check(Config{Dir: dir, SentinelID: "other"}); err == nil {
		t.Fatal("wrong sentinel accepted")
	}
	if err := Check(Config{Dir: filepath.Join(dir, "absent"), SentinelID: "hohe-test-volume"}); err == nil {
		t.Fatal("absent dir accepted")
	}
	if err := Check(Config{Dir: dir}); err == nil {
		t.Fatal("no sentinel id accepted")
	}
}

func TestMountpoint(t *testing.T) {
	dir := t.TempDir()
	if err := Init(dir, "x"); err != nil {
		t.Fatal(err)
	}
	mi := filepath.Join(t.TempDir(), "mountinfo")
	line := "36 35 8:32 /hohe " + strings.ReplaceAll(dir, " ", `\040`) + " rw,relatime - ext4 /dev/sdc rw\n"
	os.WriteFile(mi, []byte("1 0 0:1 / / rw - overlay overlay rw\n"+line), 0o600)
	if err := Check(Config{Dir: dir, SentinelID: "x", RequireMountpoint: true, MountInfo: mi}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(mi, []byte("1 0 0:1 / / rw - overlay overlay rw\n"), 0o600)
	if err := Check(Config{Dir: dir, SentinelID: "x", RequireMountpoint: true, MountInfo: mi}); err == nil {
		t.Fatal("a directory that is not a mount point was accepted")
	}
}
