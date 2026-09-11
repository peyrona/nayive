// check-i18n - the dictionary invariants docs/i18n.md describes, as a tool.
//
// `es.json` is the reference. Every other dictionary must:
//
//   - hold exactly the same keys (no missing, no extra);
//   - have no blank value;
//   - use the same `{placeholders}` per key, as a set;
//   - keep every app name verbatim (they are never translated).
//
// Prints one line per problem and exits 1 if there was any, so it can go in front
// of `deploy.sh`. It reads nothing but the dictionary files.
//
//	go -C tools run ./check-i18n
//
// Placeholders are compared as a SET, not in order - a translation may
// legitimately reorder them ("{n} left" vs "quedan {n}").
//
// The app-name test matches on WORD BOUNDARIES, or "Calc" would fire on the
// Spanish "Calcula" and "Text" on "Texto". Go's regexp `\b` and `\w` only know
// ASCII letters, so an accented neighbour ("Calcá") would count as a boundary;
// both tests are written by hand with Unicode letters instead, the way the
// Python version (whose `\b` is Unicode-aware) behaved.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"nayive/tools/internal/repo"
)

const ref = "es"

var langs = []string{"es", "en", "pt", "fr", "de", "it", "la"}

// Never translated - see docs/i18n.md. A value that carries one of these in the
// reference must carry the same word in every language.
var appNames = []string{"Nayive", "Drive", "Planner", "Calendar", "Tasks", "Contacts",
	"Write", "Calc", "Text", "Photos", "Music", "Movies", "Trips",
	"Split", "Habits", "Games"}

var placeholder = regexp.MustCompile(`\{([\p{L}\p{N}_]+)\}`)

func main() {
	flag.Parse()
	dir := filepath.Join(repo.MustRoot("check-i18n"), "client", "apps", "shared", "i18n")
	os.Exit(run(dir))
}

func run(dir string) int {
	dicts := map[string]map[string]any{}
	failed := false
	for _, l := range langs {
		d, err := load(filepath.Join(dir, l+".json"))
		if err != nil {
			fmt.Printf("%s.json: cannot read - %v\n", l, err)
			failed = true
			continue
		}
		dicts[l] = d
	}
	if failed {
		return 1
	}

	refDict := dicts[ref]
	bad := 0

	fmt.Printf("%-4s %6s\n", "lang", "keys")
	for _, l := range langs {
		fmt.Printf("%-4s %6d\n", l, len(dicts[l]))
	}
	fmt.Println()

	for _, l := range langs {
		d := dicts[l]

		if l != ref {
			for _, k := range sortedKeys(refDict) {
				if _, ok := d[k]; !ok {
					fmt.Printf("%s: missing key %s\n", l, k)
					bad++
				}
			}
			for _, k := range sortedKeys(d) {
				if _, ok := refDict[k]; !ok {
					fmt.Printf("%s: key not in %s.json: %s\n", l, ref, k)
					bad++
				}
			}
		}

		for _, k := range sortedKeys(d) {
			v, isStr := d[k].(string)
			if !isStr || strings.TrimSpace(v) == "" {
				fmt.Printf("%s: blank value for %s\n", l, k)
				bad++
				continue
			}
			refV, inRef := refDict[k].(string)
			if _, present := refDict[k]; !present {
				continue
			}
			if !inRef {
				refV = "" // a non-string reference value is reported under es itself
			}
			want := placeholders(refV)
			got := placeholders(v)
			if strings.Join(want, "\x00") != strings.Join(got, "\x00") {
				fmt.Printf("%s: %s placeholders %s, expected %s\n", l, k, pyList(got), pyList(want))
				bad++
			}
			for _, name := range appNames {
				if hasWord(refV, name) && !hasWord(v, name) {
					fmt.Printf("%s: %s dropped the app name '%s'\n", l, k, name)
					bad++
				}
			}
		}
	}

	if bad == 0 {
		fmt.Println("\nOK - the dictionaries agree")
		return 0
	}
	fmt.Printf("\n%d problem(s)\n", bad)
	return 1
}

func load(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var d map[string]any
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	return d, nil
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys) // byte order = code-point order for UTF-8, like Python's sorted()
	return keys
}

// placeholders returns the distinct {names} in s, sorted.
func placeholders(s string) []string {
	set := map[string]bool{}
	for _, m := range placeholder.FindAllStringSubmatch(s, -1) {
		set[m[1]] = true
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// pyList prints a list the way the Python version did (['a', 'b']), or "none".
func pyList(xs []string) string {
	if len(xs) == 0 {
		return "none"
	}
	return "['" + strings.Join(xs, "', '") + "']"
}

// hasWord says whether name occurs in s as a whole word: the rune before and
// the rune after it (if any) are not word characters.
func hasWord(s, name string) bool {
	for from := 0; ; {
		i := strings.Index(s[from:], name)
		if i < 0 {
			return false
		}
		start := from + i
		end := start + len(name)
		before, _ := utf8.DecodeLastRuneInString(s[:start])
		after, _ := utf8.DecodeRuneInString(s[end:])
		if (start == 0 || !isWord(before)) && (end == len(s) || !isWord(after)) {
			return true
		}
		from = start + 1
	}
}

// isWord is Python's Unicode `\w`: a letter, a digit/number, or '_'.
func isWord(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_'
}
