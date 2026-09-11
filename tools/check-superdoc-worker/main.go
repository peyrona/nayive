// check-superdoc-worker - guard the pinned SuperDoc worker filename.
//
// apps/write/index.html pins the DOCX-engine Web Worker by name, because the
// bundle's own `import.meta.url` resolution can drift under some hosts (see
// apps/write/lib/superdoc/BUILD.md). The filename carries a content hash, so a
// rebuild of the bundle silently invalidates that line - and the first person to
// notice is a user whose editor never opens.
//
// This is cheap to check, so it runs as a PREBUILD_STEP in deploy.sh:
//
//	go -C tools run ./check-superdoc-worker
package main

import (
	"flag"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"nayive/tools/internal/repo"
)

// (?s) lets `.` span lines: the pin's name and its quoted value may sit on
// different lines.
var pin = regexp.MustCompile(`(?s)__SUPERDOC_V2_BROWSER_WORKER_URL__.*?'([^']+)'`)

func main() {
	flag.Parse()
	root := repo.MustRoot("check-superdoc-worker")
	index := filepath.Join(root, "client", "apps", "write", "index.html")
	assets := filepath.Join(root, "client", "apps", "write", "lib", "superdoc", "assets")
	os.Exit(run(index, assets))
}

func run(index, assets string) int {
	raw, err := os.ReadFile(index)
	if err != nil {
		fmt.Printf("check-superdoc-worker: %s is missing\n", index)
		return 1
	}

	m := pin.FindStringSubmatch(string(raw))
	if m == nil {
		fmt.Println("check-superdoc-worker: no __SUPERDOC_V2_BROWSER_WORKER_URL__ pin in write/index.html")
		return 1
	}
	pinned := path.Base(m[1]) // lib/superdoc/assets/browser-worker-entry-<hash>.js -> the file name

	var onDisk []string
	entries, _ := os.ReadDir(assets) // a missing folder = nothing on disk, reported below
	for _, e := range entries {
		name := e.Name()
		if ok, _ := filepath.Match("browser-worker-entry-*.js", name); ok && !strings.HasSuffix(name, ".gz") {
			onDisk = append(onDisk, name)
		}
	}
	sort.Strings(onDisk)

	if len(onDisk) == 0 {
		fmt.Printf("check-superdoc-worker: no browser-worker-entry-*.js in %s\n", assets)
		return 1
	}

	for _, name := range onDisk {
		if name == pinned {
			fmt.Printf("check-superdoc-worker: OK - %s\n", pinned)
			return 0
		}
	}

	fmt.Println("check-superdoc-worker: STALE PIN")
	fmt.Printf("  write/index.html pins : %s\n", pinned)
	fmt.Printf("  on disk               : %s\n", strings.Join(onDisk, ", "))
	fmt.Println("  Fix the __SUPERDOC_V2_BROWSER_WORKER_URL__ line in apps/write/index.html.")
	return 1
}
