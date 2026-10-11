package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestClientLogEndToEnd: a signed-in page's report lands as one JSON line;
// without a session nothing is written.
func TestClientLogEndToEnd(t *testing.T) {
	srv, ts, client := newTestServer(t)
	body := `{"app":"calc","kind":"error","message":"x is undefined","source":"/apps/calc/calc.js",
	          "line":12,"col":3,"browser":"Firefox 131","touch":true,"w":390,"h":844}`

	if code, _ := callJSON(t, client, "POST", ts.URL+"/api/clientlog", body); code != http.StatusUnauthorized {
		t.Fatalf("no session = %d, want 401", code)
	}
	signIn(t, client, ts.URL, "ana", "abc")
	if code, raw := callJSON(t, client, "POST", ts.URL+"/api/clientlog", body); code != http.StatusNoContent {
		t.Fatalf("report = %d, want 204: %s", code, raw)
	}
	if code, _ := callJSON(t, client, "GET", ts.URL+"/api/clientlog", ""); code != http.StatusMethodNotAllowed {
		t.Fatalf("GET = %d, want 405", code)
	}

	raw, err := os.ReadFile(srv.clientLog.path)
	if err != nil {
		t.Fatalf("log file: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d: %s", len(lines), raw)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &got); err != nil {
		t.Fatalf("not JSON: %v: %s", err, lines[0])
	}
	if got["user"] != "ana" || got["browser"] != "Firefox 131" || got["touch"] != true || got["line"] != 12.0 {
		t.Fatalf("wrong line: %s", lines[0])
	}
}

// TestClientLogLimits: the same error once an hour, at most clientLogPerHour
// lines per account, long fields cut, and a fresh hour starts over.
func TestClientLogLimits(t *testing.T) {
	c := NewClientLog(t.TempDir())
	clock := time.Date(2026, 10, 11, 10, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return clock }
	var written []string
	c.write = func(_ string, line []byte) error { written = append(written, string(line)); return nil }

	same := clientReport{Message: "boom", Source: "a.js", Line: 1}
	if ok, _ := c.Add("ana", same); !ok {
		t.Fatal("first report not written")
	}
	if ok, _ := c.Add("ana", same); ok {
		t.Fatal("same error written twice in one hour")
	}
	if ok, _ := c.Add("beto", same); !ok {
		t.Fatal("another account's same error was dropped")
	}

	for i := 2; i <= clientLogPerHour+5; i++ {
		c.Add("ana", clientReport{Message: "boom", Source: "a.js", Line: i})
	}
	n := 0
	for _, l := range written {
		if strings.Contains(l, `"user":"ana"`) {
			n++
		}
	}
	if n != clientLogPerHour {
		t.Fatalf("ana wrote %d lines, want the cap %d", n, clientLogPerHour)
	}

	clock = clock.Add(time.Hour)
	if ok, _ := c.Add("ana", same); !ok {
		t.Fatal("a new hour did not start over")
	}

	written = nil
	c.Add("ana", clientReport{Message: strings.Repeat("é", 1000)})
	var got clientReport
	json.Unmarshal([]byte(written[0]), &got)
	if len(got.Message) > 500 || !strings.HasSuffix(got.Message, "é") {
		t.Fatalf("message not cut cleanly: %d bytes", len(got.Message))
	}
}

// TestClientLogRolls: past clientLogMaxSize the file moves to .1.
func TestClientLogRolls(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "client-errors.log")
	big := []byte(strings.Repeat("x", clientLogMaxSize-10) + "\n")
	if err := appendRolling(path, big); err != nil {
		t.Fatal(err)
	}
	if err := appendRolling(path, []byte(strings.Repeat("y", 20)+"\n")); err != nil {
		t.Fatal(err)
	}
	old, _ := os.Stat(path + ".1")
	cur, _ := os.Stat(path)
	if old == nil || cur == nil || old.Size() != int64(len(big)) || cur.Size() != 21 {
		t.Fatalf("roll failed: old=%v cur=%v", old, cur)
	}
}
