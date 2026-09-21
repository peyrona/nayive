package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestSearchSpec runs the advanced search over a small real tree: name rules
// (all / any), kinds (folders, extensions), the date window, and what the
// parser refuses.
func TestSearchSpec(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	old := now.AddDate(0, 0, -40)
	mk := func(rel string, dir bool, when time.Time) {
		p := filepath.Join(root, rel)
		if dir {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
		} else if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, when, when); err != nil {
			t.Fatal(err)
		}
	}
	mk("Facturas", true, now)
	mk("Facturas/Factura luz.pdf", false, now)
	mk("Facturas/Factura gas.PDF", false, old)
	mk("Facturas/factura taller - borrador.docx", false, now)
	mk("Facturas/Resumen: facturas.xlsx", false, now)
	mk("IMG_0001.jpg", false, old)
	mk(".oculto.pdf", false, now)
	mk("Facturas", true, now) // the files above touched the folder: put its date back

	run := func(raw string) []string {
		t.Helper()
		v, err := url.ParseQuery(raw)
		if err != nil {
			t.Fatal(err)
		}
		q := Query{}
		for k, vs := range v {
			q[k] = vs
		}
		sp, err := parseSearchSpec(q)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		nodes, _ := SearchBy([]SearchRoot{{Dir: root, Prefix: "files"}}, 100, sp.keep)
		out := []string{}
		for _, n := range nodes {
			out = append(out, n.Path)
		}
		sort.Strings(out)
		return out
	}
	same := func(raw string, want ...string) {
		t.Helper()
		got := run(raw)
		if len(got) != len(want) {
			t.Fatalf("%s: got %v, want %v", raw, got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("%s: got %v, want %v", raw, got, want)
			}
		}
	}

	since := itoa64(now.AddDate(0, 0, -30).Unix())

	same("name=has:factura&name=not:borrador",
		"files/Facturas", "files/Facturas/Factura gas.PDF", "files/Facturas/Factura luz.pdf", "files/Facturas/Resumen: facturas.xlsx")
	same("name=has:factura&name=not:borrador&ext=pdf",
		"files/Facturas/Factura gas.PDF", "files/Facturas/Factura luz.pdf")
	same("name=has:factura&ext=pdf&since="+since, "files/Facturas/Factura luz.pdf")
	same("name=starts:img_&name=ends:.xlsx&any=1", "files/Facturas/Resumen: facturas.xlsx", "files/IMG_0001.jpg")
	same("name=is:img_0001.jpg", "files/IMG_0001.jpg")
	same("name=has:resumen: f", "files/Facturas/Resumen: facturas.xlsx") // the text may hold a ":"
	same("folders=1", "files/Facturas")
	same("folders=1&ext=jpg", "files/Facturas", "files/IMG_0001.jpg")
	same("until="+since, "files/Facturas/Factura gas.PDF", "files/IMG_0001.jpg")
	same("name=has:factura&name=has:", // an empty rule is dropped, not "matches all"
		"files/Facturas", "files/Facturas/Factura gas.PDF", "files/Facturas/Factura luz.pdf",
		"files/Facturas/Resumen: facturas.xlsx", "files/Facturas/factura taller - borrador.docx")

	for _, bad := range []string{"", "name=has:", "name=like:x", "name=x", "since=abc", "since=-5"} {
		v, _ := url.ParseQuery(bad)
		q := Query{}
		for k, vs := range v {
			if len(vs) > 0 && vs[0] != "" {
				q[k] = vs
			}
		}
		if _, err := parseSearchSpec(q); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}

// TestBiggest - the n largest files of the WHOLE tree, biggest first, never a
// folder, never what the listings hide (dot-folders like .trash, dot-files,
// temp files, symlinks). More files than n must not change the answer: the walk
// is not cut short the way a search's is.
func TestBiggest(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string, size int) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 30; i++ {
		mk(filepath.Join("small", "f"+strconv.Itoa(i)+".txt"), 10+i)
	}
	mk("Videos/boda.mp4", 5000)
	mk("Videos/deep/er/clip.mov", 3000)
	mk("doc.pdf", 4000)
	mk(".trash/huge.bin", 9000)
	mk(".hidden.bin", 8000)
	mk("big.123.4.tmp", 7000)
	if err := os.Symlink(filepath.Join(root, "Videos/boda.mp4"), filepath.Join(root, "link.mp4")); err != nil {
		t.Fatal(err)
	}

	got := Biggest([]SearchRoot{{Dir: root, Prefix: "files"}}, 4)
	want := []string{"files/Videos/boda.mp4", "files/doc.pdf", "files/Videos/deep/er/clip.mov", "files/small/f29.txt"}
	if len(got) != len(want) {
		t.Fatalf("got %d nodes, want %d: %+v", len(got), len(want), got)
	}
	for i, n := range got {
		if n.Path != want[i] {
			t.Errorf("#%d = %s, want %s", i, n.Path, want[i])
		}
		if n.Nodes != nil || n.Size == nil {
			t.Errorf("%s: not a file node", n.Path)
		}
	}
	if *got[0].Size != 5000 {
		t.Errorf("size = %d, want 5000", *got[0].Size)
	}
	if n := len(Biggest([]SearchRoot{{Dir: root, Prefix: "files"}}, 0)); n != 0 {
		t.Errorf("n=0 gave %d nodes", n)
	}
}

// TestBiggestRoute - GET ?big=<n> answers a user from their files/ only (never
// data/, where Chat and Trips keep theirs), and ?stat=disk says whose it is.
func TestBiggestRoute(t *testing.T) {
	srv, ts, client := newTestServer(t)
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	for rel, size := range map[string]int{
		"files/a.mp4": 3000, "files/sub/b.jpg": 2000, "files/c.txt": 10,
		"data/chat/media/huge.jpg": 9000,
	} {
		p := filepath.Join(home, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	signIn(t, client, ts.URL, "ana", "abc")

	get := func(q string) (int, map[string]any) {
		resp := do(t, client, "GET", ts.URL+"/api/files?"+q, nil, nil)
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	code, out := get("big=2")
	if code != http.StatusOK {
		t.Fatalf("?big=2 = %d", code)
	}
	nodes, _ := out["nodes"].([]any)
	paths := []string{}
	for _, n := range nodes {
		paths = append(paths, n.(map[string]any)["path"].(string))
	}
	if strings.Join(paths, ",") != "files/a.mp4,files/sub/b.jpg" {
		t.Errorf("?big=2 = %v", paths)
	}
	for _, bad := range []string{"big=0", "big=abc"} {
		if code, _ := get(bad); code != http.StatusBadRequest {
			t.Errorf("?%s = %d, want 400", bad, code)
		}
	}
	if _, st := get("stat=disk"); st["user"] != "ana" {
		t.Errorf("?stat=disk user = %v", st["user"])
	}
}
