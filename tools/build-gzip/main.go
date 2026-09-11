// build-gzip - write a `<file>.gz` sidecar beside every text asset under
// client/apps/ so the server never compresses anything at request time.
//
// The nayive server (server/go/static.go) sends `foo.js.gz` with
// `Content-Encoding: gzip` whenever the browser accepts gzip and the sidecar is
// at least as new as `foo.js`. This tool makes those sidecars. It is a deploy
// helper - deploy.sh and pack.sh run it automatically; run it by hand after
// editing an app if you want the local server to serve compressed files too:
//
//	go -C tools run ./build-gzip            # make / refresh the sidecars
//	go -C tools run ./build-gzip -clean     # delete every sidecar instead
//
// Rules:
//   - only the text-ish types (html css js mjs json svg ics vcf vtt txt md
//     webmanifest, plus the Write app's .aff/.dic dictionaries) of at least
//     minBytes - a tiny file gains nothing from compression;
//   - a sidecar is rewritten only when missing or older than its source, so
//     re-running is cheap and leaves untouched files' mtimes alone;
//   - a sidecar whose source is gone is deleted.
//
// The sidecar is stamped with its source's mtime + 1 s, so the server's
// "sidecar not older than source" test holds even on filesystems with coarse
// timestamps.
package main

import (
	"compress/gzip"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"nayive/tools/internal/repo"
)

// Compressible suffixes. Everything else (images, fonts, audio, wasm) is either
// already compressed or not worth it. `sw.js` is included: it is small but
// fetched on every visit.
var suffixes = map[string]bool{
	".html": true, ".css": true, ".js": true, ".mjs": true, ".json": true, ".svg": true,
	".ics": true, ".vcf": true, ".vtt": true, ".txt": true, ".md": true,
	".webmanifest": true, ".aff": true, ".dic": true,
}

const minBytes = 1400 // below ~one packet, gzip is a net loss

func main() {
	clean := flag.Bool("clean", false, "delete every sidecar instead")
	flag.Parse()
	apps := filepath.Join(repo.MustRoot("build-gzip"), "client", "apps")

	var err error
	if *clean {
		err = cleanAll(apps)
	} else {
		err = build(apps)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "build-gzip:", err)
		os.Exit(1)
	}
}

func build(apps string) error {
	made, kept, removed := 0, 0, 0

	// java: WalkDir reads a whole folder before visiting its entries, so a
	// sidecar written (or deleted) here is never visited by this same walk.
	err := filepath.WalkDir(apps, func(src string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		ext := suffix(name)

		if ext == ".gz" {
			// An orphan? (its source vanished) -> delete it.
			if !isFile(strings.TrimSuffix(src, ".gz")) {
				if err := os.Remove(src); err != nil {
					return err
				}
				removed++
			}
			return nil
		}
		if !suffixes[strings.ToLower(ext)] || strings.HasPrefix(name, ".") {
			return nil
		}
		st, err := os.Stat(src)
		if err != nil || !st.Mode().IsRegular() || st.Size() < minBytes {
			return nil
		}
		gz := src + ".gz"
		if gst, err := os.Stat(gz); err == nil && !gst.ModTime().Before(st.ModTime()) {
			kept++
			return nil // up to date
		}
		if err := compress(src, gz, st.ModTime()); err != nil {
			return err
		}
		made++
		return nil
	})
	if err != nil {
		return err
	}
	fmt.Printf("apps/: %d sidecar(s) written, %d up to date, %d orphan(s) removed\n", made, kept, removed)
	return nil
}

// compress streams src into gz at the best compression level, so a big file is
// never read whole into RAM, then stamps gz with the source's mtime + 1 s.
func compress(src, gz string, mtime time.Time) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(gz)
	if err != nil {
		return err
	}
	zw, _ := gzip.NewWriterLevel(out, gzip.BestCompression) // error only for a bad level
	zw.Name = filepath.Base(src)                            // the header names the source, as gzip(1) does
	zw.ModTime = time.Now()
	if _, err := io.Copy(zw, in); err != nil {
		out.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	// java: a zero time.Time leaves that timestamp alone - here the atime.
	return os.Chtimes(gz, time.Time{}, mtime.Add(time.Second))
}

func cleanAll(apps string) error {
	n := 0
	err := filepath.WalkDir(apps, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".gz") {
			if err := os.Remove(p); err != nil {
				return err
			}
			n++
		}
		return nil
	})
	if err != nil {
		return err
	}
	fmt.Printf("apps/: %d sidecar(s) deleted\n", n)
	return nil
}

// suffix is the file's final extension the way Python's Path.suffix sees it:
// a name that starts with its only dot (".bashrc", ".gz") has none, and neither
// does one that ends with a dot. filepath.Ext would call ".gz" an extension and
// treat a lone ".gz" file as an orphan sidecar.
func suffix(name string) string {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 || i == len(name)-1 {
		return ""
	}
	return name[i:]
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}
