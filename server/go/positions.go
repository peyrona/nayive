package main

// =============================================================================
// Trip positions: where the owner of a publicly linked trip has been.
// =============================================================================
//
// Three sources feed them:
//
//	"phone"      a Nayive page open on a device that ticked "send my location"
//	             in the trip's Share sheet (api_location.go), about hourly
//	"photo"      a JPEG uploaded into the trip's photo folder: the position and
//	             time the camera wrote into it (photo_position.go)
//	"owntracks"  the OwnTracks app, from the background (owntracks.go)
//
// A position goes into data/trips/<dir>/positions.json of every linked trip
// whose days cover the moment it was TAKEN (on the owner's clock):
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

// linkedTrip is one trip of a user that has a live public link.
type linkedTrip struct {
	root string // the trip folder, resolved
	trip publicTripFile
}

func (s *Server) linkedTrips(user string) []linkedTrip {
	var out []linkedTrip
	for _, g := range s.shares.LinksByOwner(user) {
		grant := g
		root := s.shares.RootPath(&grant)
		if root == "" {
			continue
		}
		var trip publicTripFile
		if loadJSONFile(filepath.Join(root, "trip.json"), &trip) {
			out = append(out, linkedTrip{root: root, trip: trip})
		}
	}
	return out
}

// recordPosition stores p in every linked trip of `owner` that covers it, and
// answers how many took it.
func (s *Server) recordPosition(owner string, p tripPosition) int {
	saved := 0
	for _, lt := range s.linkedTrips(owner) {
		if s.storePosition(owner, lt, p) {
			saved++
		}
	}
	return saved
}

// storePosition cleans p and merges it into one linked trip - when the trip's
// days cover the moment p was taken, on the owner's clock.
func (s *Server) storePosition(owner string, lt linkedTrip, p tripPosition) bool {
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
