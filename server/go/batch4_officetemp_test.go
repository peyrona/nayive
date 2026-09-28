package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

// TestSweepOfficeTemp (S2-#46): the boot sweep takes a dead run's work and
// profile folders, and nothing else - not a live process's, not our own, not
// the old pid-less shape.
func TestSweepOfficeTemp(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Skipf("cannot run true: %v", err)
	}
	dead := strconv.Itoa(cmd.Process.Pid)
	live := strconv.Itoa(os.Getppid())
	self := strconv.Itoa(os.Getpid())

	gone := []string{"nayive-office-" + dead + "-123", "nayive-office-profile-" + dead + "-456"}
	kept := []string{
		"nayive-office-" + live + "-1", "nayive-office-profile-" + live + "-2",
		"nayive-office-" + self + "-3",
		"nayive-office-987654", "nayive-office-profile-987654", // before the pid was in the name
	}
	for _, name := range append(append([]string{}, gone...), kept...) {
		os.MkdirAll(filepath.Join(tmp, name, "user"), 0o700)
	}

	if n := SweepOfficeTemp(); n != len(gone) {
		t.Errorf("swept %d folders, want %d", n, len(gone))
	}
	for _, name := range gone {
		if _, err := os.Stat(filepath.Join(tmp, name)); !os.IsNotExist(err) {
			t.Errorf("%s survived the sweep", name)
		}
	}
	for _, name := range kept {
		if _, err := os.Stat(filepath.Join(tmp, name)); err != nil {
			t.Errorf("%s was swept: %v", name, err)
		}
	}

	// And the folders a run makes carry its pid, in the shape swept.
	if !officeTempRE.MatchString(officeTempPrefix("nayive-office-") + "42") {
		t.Error("officeTempPrefix and officeTempRE disagree")
	}
}
