package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func atAcc(at int64, acc float64) tripPosition {
	return tripPosition{Lat: 41.158, Lon: -8.629, Acc: acc, At: at}
}

// TestMergePositionAccuracyRule is the owner's rule for "where I am now": of two
// positions close in time, the more accurate; otherwise the newer.
func TestMergePositionAccuracyRule(t *testing.T) {
	base := time.Now().Unix() - 6*3600
	min := int64(60)

	cases := []struct {
		name    string
		have    []tripPosition
		add     tripPosition
		wantAt  int64
		wantAcc float64
	}{
		{"the first position", nil, atAcc(base, 30), base, 30},
		{"newer, close, less accurate: ours stays", []tripPosition{atAcc(base, 20)}, atAcc(base+10*min, 300), base, 20},
		{"newer, close, more accurate: it wins", []tripPosition{atAcc(base, 300)}, atAcc(base+10*min, 20), base + 10*min, 20},
		{"newer, close, as accurate: the newer", []tripPosition{atAcc(base, 20)}, atAcc(base+10*min, 20), base + 10*min, 20},
		{"newer, not close, much rougher: the newer", []tripPosition{atAcc(base, 20)}, atAcc(base+45*min, 900), base + 45*min, 900},
		{"an older photo, close, more accurate: it wins", []tripPosition{atAcc(base, 500)}, atAcc(base-20*min, 15), base - 20*min, 15},
		{"an older photo, not close: ours stays", []tripPosition{atAcc(base, 500)}, atAcc(base-2*3600, 15), base, 500},
		{"a rough one is not dropped when ours is rougher", []tripPosition{atAcc(base, 2000)}, atAcc(base+5*min, 300), base + 5*min, 300},
	}
	for _, tc := range cases {
		var doc positionsDoc
		for _, p := range tc.have {
			mergePosition(&doc, p)
		}
		mergePosition(&doc, tc.add)
		if doc.Latest == nil || doc.Latest.At != tc.wantAt || doc.Latest.Acc != tc.wantAcc {
			t.Errorf("%s: now = %+v, want at %d acc %v", tc.name, doc.Latest, tc.wantAt, tc.wantAcc)
		}
	}
}

func TestMergePositionRoute(t *testing.T) {
	base := time.Now().Unix() - 6*3600
	var doc positionsDoc

	// A steady stream - one equal reading a minute, for an hour - keeps one route
	// point per 15 minutes, while "now" follows the last reading.
	for i := int64(0); i < 60; i++ {
		mergePosition(&doc, atAcc(base+i*60, 10))
	}
	if n := len(doc.Positions); n != 4 {
		t.Errorf("an hour of readings left %d route points, want 4", n)
	}
	if doc.Latest.At != base+59*60 {
		t.Errorf("now is at %d, want the last reading", doc.Latest.At)
	}

	// A more accurate reading inside a stretch takes that stretch's place.
	mergePosition(&doc, atAcc(base+2*60, 3))
	if len(doc.Positions) != 4 || doc.Positions[0].Acc != 3 {
		t.Errorf("route %+v: the 3 m reading should replace the first point", doc.Positions)
	}

	// A late photo from an hour earlier becomes a point of its own.
	mergePosition(&doc, atAcc(base-3600, 15))
	if len(doc.Positions) != 5 || doc.Positions[0].At != base-3600 {
		t.Errorf("route %+v: the earlier photo should be the first point", doc.Positions)
	}
}

func TestRouteForShow(t *testing.T) {
	base := time.Now().Unix() - 6*3600
	route := []tripPosition{
		atAcc(base, 20),
		atAcc(base+10*60, 900),   // rough, and a better one 10 min before: hidden
		atAcc(base+3*3600, 900),  // rough, but nothing better near it: shown
		atAcc(base+3*3600+60, 0), // unknown counts as 1000 m, and the 900 m one is right there: hidden
	}
	shown := routeForShow(route)
	if len(shown) != 2 || shown[1].At != base+3*3600 {
		t.Errorf("shown %+v", shown)
	}
}

// TestPositionsFileFromBefore - a positions.json written before accuracy and
// "latest" existed still reads, as phone positions.
func TestPositionsFileFromBefore(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, tripPositionsFile),
		[]byte(`{"positions":[{"lat":41.2,"lon":-8.6,"at":200},{"lat":41.1,"lon":-8.6,"place":"Porto","at":100}]}`), 0o644)
	doc := readPositionsDoc(dir)
	if len(doc.Positions) != 2 || doc.Positions[0].At != 100 {
		t.Fatalf("positions %+v", doc.Positions)
	}
	if doc.Latest == nil || doc.Latest.At != 200 || sourceOf(*doc.Latest) != "phone" || accOf(*doc.Latest) != accUnknown {
		t.Errorf("latest %+v", doc.Latest)
	}
}
