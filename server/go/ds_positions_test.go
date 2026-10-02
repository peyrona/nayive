package main

// Data-safety seal (cleanup Phase 3, batch S1): a trip's positions.json that
// cannot be read or parsed is never replaced by the new point (F3).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// dsTripRoute makes ana's trip "t1" (today) with a 50-point route, and answers
// the trip folder and the route's bytes.
func dsTripRoute(t *testing.T, srv *Server) (string, []byte) {
	t.Helper()
	trip := filepath.Join(srv.cfg.HomesDir, "ana", "data", "trips", "t1")
	os.MkdirAll(trip, 0o755)
	today := time.Now().Format("2006-01-02")
	os.WriteFile(filepath.Join(trip, "trip.json"),
		[]byte(`{"id":"t1","destination":"Lisboa","startDate":"`+today+`","endDate":"`+today+`"}`), 0o644)
	var doc positionsDoc
	base := time.Now().Add(-2 * time.Hour).Unix()
	for i := 0; i < 50; i++ {
		doc.Positions = append(doc.Positions, tripPosition{Lat: 38.7 + float64(i)/1000, Lon: -9.1,
			At: base + int64(i)*60*20, Source: "gpslogger"})
	}
	raw, _ := json.Marshal(doc)
	return trip, raw
}

func dsNewPoint() []tripPosition {
	return []tripPosition{{Lat: 38.8, Lon: -9.2, Acc: 20, At: time.Now().Unix(), Source: "gpslogger"}}
}

// TestDS_F3_DamagedPositionsKeptAside: a route file that does not parse is
// moved aside whole (the admin can recover it), and the new point starts a
// fresh one - the old route is never replaced in place.
func TestDS_F3_DamagedPositionsKeptAside(t *testing.T) {
	srv, _, _ := newTestServer(t)
	trip, raw := dsTripRoute(t, srv)
	damaged := append(raw, '}') // one stray byte
	os.WriteFile(filepath.Join(trip, tripPositionsFile), damaged, 0o644)

	srv.recordPositions("ana", dsNewPoint())

	asides, _ := filepath.Glob(filepath.Join(trip, tripPositionsFile+".broken-*"))
	if len(asides) != 1 {
		t.Fatalf("damaged route not moved aside: %v", asides)
	}
	if kept, _ := os.ReadFile(asides[0]); string(kept) != string(damaged) {
		t.Errorf("the route aside is not the old file: %d bytes", len(kept))
	}
	if doc := readPositionsDoc(trip); len(doc.Positions) != 1 {
		t.Errorf("the fresh route has %d points, want the new one", len(doc.Positions))
	}
}

// TestDS_F3_UnreadablePositionsLeftAlone: a route file that cannot be read
// (EIO, EACCES - here a 000 file) is left exactly as it is; the point is not
// stored this time.
func TestDS_F3_UnreadablePositionsLeftAlone(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 000 file")
	}
	srv, _, _ := newTestServer(t)
	trip, raw := dsTripRoute(t, srv)
	path := filepath.Join(trip, tripPositionsFile)
	os.WriteFile(path, raw, 0o644)
	os.Chmod(path, 0o000)

	n := srv.recordPositions("ana", dsNewPoint())
	os.Chmod(path, 0o644)
	if n != 0 {
		t.Errorf("recordPositions stored %d point(s) over an unreadable route", n)
	}
	if after, _ := os.ReadFile(path); string(after) != string(raw) {
		t.Errorf("positions.json changed: %d bytes, had %d", len(after), len(raw))
	}
}
