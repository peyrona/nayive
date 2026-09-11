// Package repo finds the Nayive repository root for the build tools.
//
// The Python tools found it from their own location (the parent of tools/). A
// `go run` binary lives in a temp folder, so the Go tools find it from the
// working directory instead: walk up until a folder holds client/apps. That
// is why they are run as `go -C tools run ./<tool>` - any folder inside the
// repo works.
//
// -root overrides the search, so a test can point a tool at a scratch copy.
package repo

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

// java: a package-level flag registers itself when the package is imported;
// every tool that imports repo gets -root for free. It is read after the
// tool's own flag.Parse().
var rootFlag = flag.String("root", "", "repo root (default: found by walking up from the working directory)")

// Root returns the repo root. Call it after flag.Parse().
func Root() (string, error) {
	if *rootFlag != "" {
		return filepath.Abs(*rootFlag)
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if st, err := os.Stat(filepath.Join(dir, "client", "apps")); err == nil && st.IsDir() {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("client/apps not found above the working directory (use -root)")
		}
		dir = parent
	}
}

// MustRoot is Root for a main(): on failure it says why and exits 1.
func MustRoot(tool string) string {
	root, err := Root()
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", tool, err)
		os.Exit(1)
	}
	return root
}
