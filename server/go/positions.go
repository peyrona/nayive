package main

// =============================================================================
// Trip positions: where the owner of a trip has been.
// =============================================================================
//
// Two sources feed them:
//
//	"photo"      a JPEG uploaded into the trip's photo folder: the position and
//	             time the camera wrote into it (photo_position.go)
//	"owntracks"  the OwnTracks app, from the background (owntracks.go)
//
// "phone" is read too, never written any more: the Share sheet's "send my
// location from this device" tick (and its /api/location) was removed on
// 2026-09-15, and positions.json files from before still hold its points.
//
// A position goes into data/trips/<dir>/positions.json of every trip of the
// owner whose days cover the moment it was TAKEN (on the owner's clock) - unless
// that trip was switched off in Trips ("track": false in its trip.json). No link
// is needed: the owner's Journey map (journey.go) shows them, and stopping a
// link keeps them.
//
//	{"positions": [...], "latest": {...}}
//
// `positions` is the route, one point per positionStep at most; `latest` is
// "where I am now". One rule - the owner's own - decides both:
//
//	of two positions close in time, keep the more accurate one;
//	otherwise the newer one wins.
//
// Nothing is thrown away just for being imprecise: a 300 m fix is better than
// nothing, and better than a 2 km one. The public page only hides a rough route
// point when a better one sits right next to it in time (routeForShow).
//
// Coordinates are rounded (roundCoord, ~100 m) BEFORE they are written: the
// exact spot never reaches the disk.

import (
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	positionStep   = 15 * time.Minute // the route keeps at most one point per this
	positionClose  = 30 * time.Minute // "close in time", for the accuracy rule
	positionFuture = 5 * time.Minute  // the clock skew a device may have
	positionsMax   = 2000             // the oldest route points go first
	placeMaxRunes  = 80

	// How imprecise (metres) a position counts as when its source said nothing.
	accPhoto   = 15.0   // a phone camera's GPS
	accApp     = 50.0   // OwnTracks
	accUnknown = 1000.0 // a browser, or a position stored before accuracy was kept
	accRough   = 100.0  // worse than this, a route point may give way to a better one
)

// positionsMu serialises every read-modify-write of a positions.json: an upload,
// the OwnTracks app and a browser may all report in the same second.
var positionsMu sync.Mutex

// tripPosition is one position, as stored.
type tripPosition struct {
	Lat    float64 `json:"lat"`
	Lon    float64 `json:"lon"`
	Acc    float64 `json:"acc,omitempty"` // metres; 0 = unknown
	Place  string  `json:"place,omitempty"`
	At     int64   `json:"at"`               // UNIX seconds: when it was TAKEN
	Source string  `json:"source,omitempty"` // "phone" | "photo" | "owntracks"; "" is an old "phone"
}

type positionsDoc struct {
	Positions []tripPosition `json:"positions"`
	Latest    *tripPosition  `json:"latest,omitempty"`
}

// accOf is how imprecise a position is, in metres.
func accOf(p tripPosition) float64 {
	if p.Acc > 0 {
		return p.Acc
	}
	return accUnknown
}

func sourceOf(p tripPosition) string {
	if p.Source == "" {
		return "phone"
	}
	return p.Source
}

// apart is the time between two UNIX-second stamps.
func apart(a, b int64) time.Duration {
	d := a - b
	if d < 0 {
		d = -d
	}
	return time.Duration(d) * time.Second
}

// mergePosition adds p - already rounded and checked - to doc.
func mergePosition(doc *positionsDoc, p tripPosition) {
	// The route. A point already within positionStep of p stands for that
	// stretch of time, and p replaces it only when STRICTLY more accurate: taking
	// the newer on a tie would let a steady stream of equal readings drag one
	// point along forever, and leave no route at all.
	near := -1
	for i := range doc.Positions {
		d := apart(p.At, doc.Positions[i].At)
		if d < positionStep && (near < 0 || d < apart(p.At, doc.Positions[near].At)) {
			near = i
		}
	}
	switch {
	case near < 0:
		doc.Positions = append(doc.Positions, p)
	case accOf(p) < accOf(doc.Positions[near]):
		doc.Positions[near] = p
	}
	sort.SliceStable(doc.Positions, func(i, j int) bool { return doc.Positions[i].At < doc.Positions[j].At })
	if n := len(doc.Positions); n > positionsMax {
		doc.Positions = doc.Positions[n-positionsMax:]
	}

	// "Where I am now".
	if cur := doc.Latest; cur != nil {
		if apart(p.At, cur.At) < positionClose {
			if accOf(p) > accOf(*cur) || (accOf(p) == accOf(*cur) && p.At < cur.At) {
				return // close in time, and not better
			}
		} else if p.At < cur.At {
			return // older, and not close: the newer one stays
		}
	}
	latest := p
	doc.Latest = &latest
}

// routeForShow is the route without the rough points that a more accurate one,
// close in time, already covers. `route` is sorted by time.
func routeForShow(route []tripPosition) []tripPosition {
	out := make([]tripPosition, 0, len(route))
	for i, p := range route {
		if accOf(p) > accRough && betterNearby(route, i) {
			continue
		}
		out = append(out, p)
	}
	return out
}

func betterNearby(route []tripPosition, i int) bool {
	p := route[i]
	for j := i - 1; j >= 0 && apart(p.At, route[j].At) < positionClose; j-- {
		if accOf(route[j]) < accOf(p) {
			return true
		}
	}
	for j := i + 1; j < len(route) && apart(route[j].At, p.At) < positionClose; j++ {
		if accOf(route[j]) < accOf(p) {
			return true
		}
	}
	return false
}

// readPositionsDoc is a trip's positions file: valid entries only, the route
// sorted by time. A file from before "latest" was kept gets its last point.
func readPositionsDoc(tripDir string) positionsDoc {
	var raw positionsDoc
	loadJSONFile(filepath.Join(tripDir, tripPositionsFile), &raw)

	doc := positionsDoc{Positions: []tripPosition{}}
	for _, p := range raw.Positions {
		if p.At > 0 && validLatLon(p.Lat, p.Lon) {
			doc.Positions = append(doc.Positions, p)
		}
	}
	sort.SliceStable(doc.Positions, func(i, j int) bool { return doc.Positions[i].At < doc.Positions[j].At })

	if l := raw.Latest; l != nil && l.At > 0 && validLatLon(l.Lat, l.Lon) {
		latest := *l
		doc.Latest = &latest
	} else if n := len(doc.Positions); n > 0 {
		latest := doc.Positions[n-1]
		doc.Latest = &latest
	}
	return doc
}

// -----------------------------------------------------------------------------
// storing
// -----------------------------------------------------------------------------

// trackedTrip is one trip of a user that keeps their positions.
type trackedTrip struct {
	root string // the trip folder, resolved
	trip publicTripFile
}

// trackedTrips are the user's own trips - every data/trips/<dir> with a
// trip.json - except those switched off in Trips ("track": false). Every path
// goes through ownerFile, so a symlink out of the home, or a trip in .trash, is
// never read or written.
func (s *Server) trackedTrips(user string) []trackedTrip {
	var out []trackedTrip
	base := s.ownerFile(user, []string{"data", "trips"})
	if base == "" {
		return out
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return out
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		root := s.ownerFile(user, []string{"data", "trips", name})
		file := s.ownerFile(user, []string{"data", "trips", name, "trip.json"})
		if root == "" || file == "" {
			continue
		}
		if info, err := os.Stat(root); err != nil || !info.IsDir() {
			continue
		}
		var trip publicTripFile
		if loadJSONFile(file, &trip) && (trip.Track == nil || *trip.Track) {
			out = append(out, trackedTrip{root: root, trip: trip})
		}
	}
	return out
}

// recordPosition stores p in every tracked trip of `owner` that covers it, and
// answers how many took it.
func (s *Server) recordPosition(owner string, p tripPosition) int {
	saved := 0
	for _, lt := range s.trackedTrips(owner) {
		if s.storePosition(owner, lt, p) {
			saved++
		}
	}
	return saved
}

// storePosition cleans p and merges it into one trip - when the trip's days
// cover the moment p was taken, on the owner's clock.
func (s *Server) storePosition(owner string, lt trackedTrip, p tripPosition) bool {
	p, ok := cleanPosition(p)
	if !ok {
		return false
	}
	taken := time.Unix(p.At, 0)
	if loc := Location(s.users.UserTZ("user", owner)); loc != nil {
		taken = taken.In(loc)
	}
	day := taken.Format("2006-01-02")
	if lt.trip.StartDate == "" || lt.trip.EndDate == "" || day < lt.trip.StartDate || day > lt.trip.EndDate {
		return false
	}

	positionsMu.Lock()
	defer positionsMu.Unlock()
	doc := readPositionsDoc(lt.root)
	mergePosition(&doc, p)
	if err := atomicWriteJSON(filepath.Join(lt.root, tripPositionsFile), doc, 1); err != nil {
		s.log.Error("cannot save a trip position", "err", err)
		return false
	}
	return true
}

// cleanPosition rounds p and tells whether it can be stored at all.
func cleanPosition(p tripPosition) (tripPosition, bool) {
	p.Lat, p.Lon = roundCoord(p.Lat), roundCoord(p.Lon)
	if !validLatLon(p.Lat, p.Lon) || p.At <= 0 || time.Unix(p.At, 0).After(time.Now().Add(positionFuture)) {
		return p, false
	}
	if math.IsNaN(p.Acc) || p.Acc < 0 {
		p.Acc = 0
	}
	p.Acc = math.Min(math.Ceil(p.Acc), 100000)
	p.Place = cleanPlace(p.Place)
	return p, true
}

// cleanPlace is a place name fit to show a stranger: one line, no control
// characters, not too long.
func cleanPlace(place string) string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(place) {
		if unicode.IsControl(r) {
			r = ' '
		}
		if n == placeMaxRunes {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}
