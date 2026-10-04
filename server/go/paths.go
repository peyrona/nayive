package main

// =============================================================================
// Path helpers - the segment arithmetic every sandbox check is built on.
// =============================================================================
//
// Go's path/filepath is string-based and has no equivalent of pathlib's
// `root in target.parents`, so the four operations that matter - split,
// resolve, "is inside", relative - live here, once, and nothing else
// re-implements them.
//
// THE RULE, in one sentence: compare PATH SEGMENTS, never string prefixes. A
// user's file called "EE.UU..txt" must not be mistaken for a traversal attempt,
// and "/home/alice-backup" must not count as inside "/home/alice".

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unicode"
)

// splitPath splits an API path into segments, dropping empty and "." ones.
// "a//b/./c" -> ["a", "b", "c"], "" -> [].
//
// This is the first half of what ResolvePath does; the ".." test is separate so
// callers can report a refusal differently from an empty path.
func splitPath(p string) []string {
	return cleanSegments(strings.Split(p, "/"))
}

// cleanSegments drops the empty and "." entries from an already-split path.
func cleanSegments(parts []string) []string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" && p != "." {
			out = append(out, p)
		}
	}
	return out
}

// hasDotDot reports whether any segment is "..". Checked AFTER percent-decoding,
// which is the whole point: "%2e%2e" would slip past a check done before.
//
// An API path is decoded ONCE, by the query parser (or the mux, for a path
// value), and never again: a second decode (removed 2026-09-28) made a name
// holding "%20" unreachable and put an upload named "a%2Fb.txt" into a folder
// a/.
func hasDotDot(parts []string) bool {
	for _, p := range parts {
		if p == ".." {
			return true
		}
	}
	return false
}

// hasSegment reports whether `parts` contains exactly this segment.
func hasSegment(parts []string, want string) bool {
	for _, p := range parts {
		if p == want {
			return true
		}
	}
	return false
}

// isInside reports whether `target` is `root` itself or lies underneath it.
// Both must already be absolute and symlink-resolved.
//
// java: filepath.Rel does the work: a relative path that neither is ".." nor
// starts with "../" means "inside".
func isInside(root, target string) bool {
	if root == target {
		return true
	}
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolveExisting makes a path absolute and follows every symlink, collapsing
// any leftover "..".
//
// java: filepath.EvalSymlinks FAILS when the path does not exist, and a PUT of
// a NEW file resolves a path whose last component is not there yet - plain
// EvalSymlinks would refuse every upload of a new file. This walks
// up to the deepest EXISTING ancestor, resolves that, and rejoins the rest -
// which is what the containment check actually needs, because the symlink that
// could escape has to exist to be followed.
func resolveExisting(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)

	var tail []string
	current := abs
	for {
		real, err := filepath.EvalSymlinks(current)
		if err == nil {
			// Rejoin whatever did not exist yet, in order.
			for i := len(tail) - 1; i >= 0; i-- {
				real = filepath.Join(real, tail[i])
			}
			return real, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			// Walked all the way to "/" and it does not exist: give up.
			return "", errors.New("cannot resolve " + path)
		}
		tail = append(tail, filepath.Base(current))
		current = parent
	}
}

// homeOwner is the user whose home an absolute path lies in
// ("homes/<user>/..."), or "" when it is outside homes/ (apps/, config/, the
// base dir itself).
//
// Used to keep the usage cache right whoever - the user or the admin - touched
// the file.
func homeOwner(homesDir, absPath string) string {
	homes, err := resolveExisting(homesDir)
	if err != nil {
		return ""
	}
	target, err := resolveExisting(absPath)
	if err != nil {
		return ""
	}
	rel, err := filepath.Rel(homes, target)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return ""
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) == 0 || parts[0] == "" {
		return ""
	}
	return parts[0]
}

// lastSegment is the final path component of an API path, used for a default
// share title.
func lastSegment(p string) string {
	parts := splitPath(p)
	if len(parts) == 0 {
		return p
	}
	return parts[len(parts)-1]
}

// contains is `x in list` for a small slice of strings.
//
// java: Go's stdlib has slices.Contains; this one predates its use here and
// costs nothing.
func contains(list []string, want string) bool {
	for _, x := range list {
		if x == want {
			return true
		}
	}
	return false
}

// ptrInt64 is the "give me a nullable number" helper. A JSON field that must be
// able to say `null` needs a pointer, and Go has no way to take the address of
// a literal.
func ptrInt64(n int64) *int64 { return &n }

// newShareID mirrors secrets.token_urlsafe(6): 6 random bytes, base64url.
func newShareID() string {
	raw := make([]byte, 6)
	rand.Read(raw)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// itoa64 is Long.toString.
func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

// isCrossDevice reports the EXDEV error os.Rename gives when the two paths sit
// on different filesystems.
func isCrossDevice(err error) bool {
	return errors.Is(err, syscall.EXDEV)
}

// absUnder makes a possibly-relative path absolute against `base`, which is how
// config/server.json's TLS paths are written.
func absUnder(base, p string) string {
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(base, p)
}

// quotePath percent-encodes a path for a Location header: everything unsafe
// EXCEPT "/", which stays readable (what urllib's quote() does).
//
// java: url.QueryEscape escapes the slashes too (and turns a space into "+"),
// so a redirect back to "/nayive/index.html" would arrive as
// "%2Fnayive%2Findex.html". The browser follows either, but the login page
// reads ?return= and shows it as a path.
func quotePath(p string) string {
	var out strings.Builder
	for _, b := range []byte(p) {
		safe := b == '/' || b == '_' || b == '.' || b == '-' || b == '~' ||
			(b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
		if safe {
			out.WriteByte(b)
		} else {
			out.WriteString(fmt.Sprintf("%%%02X", b))
		}
	}
	return out.String()
}

// oneLine is `s` fit for one line: every control character a space, at most
// `max` runes, trimmed (cleanDeviceName, cleanPlace).
func oneLine(s string, max int) string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if unicode.IsControl(r) {
			r = ' '
		}
		if n == max {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

// numberedName is "base (n)ext", or base+ext for n 0.
func numberedName(base, ext string, n int) string {
	if n == 0 {
		return base + ext
	}
	return base + " (" + strconv.Itoa(n) + ")" + ext
}

// claimName gives `try` up to `tries` names - base+ext, then "base (first)ext",
// "base (first+1)ext", ... - until one is taken (try nil) or try fails for
// another reason than fs.ErrExist. The name and try's last error: an
// fs.ErrExist one when every name was in use.
func claimName(base, ext string, first, tries int, try func(name string) error) (string, error) {
	var err error
	for k := 0; k < tries; k++ {
		n := 0
		if k > 0 {
			n = first + k - 1
		}
		name := numberedName(base, ext, n)
		if err = try(name); !errors.Is(err, fs.ErrExist) {
			if err != nil {
				return "", err
			}
			return name, nil
		}
	}
	return "", err
}
