package main

// =============================================================================
// /api/journey - a trip's Journey map, for its owner.
// =============================================================================
//
// Trips shows a trip on two maps: the Plan (its stages, drawn by the page from
// trip.json) and the Journey - where the owner really went: the positions kept
// for the trip (positions.go), the photos of its photo folder and "where I am
// now". The Journey is built by buildTripView, the same code a public link uses
// (api_public.go), so the owner sees exactly what a link's visitor would - and
// the trip needs no link for it.
//
//	GET /api/journey?trip=<dir>                      -> the trip, as publicTrip
//	GET /api/journey/{photo|thumb}/<name>?trip=<dir> -> one photo / its thumbnail
//
// <dir> is the trip's folder name under data/trips/ - one plain segment. Only
// the signed-in user's own trips: a trip shared with them has no Journey here.

import (
	"net/http"
	"strings"
)

// journeyTarget is the signed-in user, their trip folder for ?trip= and its
// trip.json - or false after answering.
func (s *Server) journeyTarget(w http.ResponseWriter, r *http.Request) (string, string, publicTripFile, bool) {
	var trip publicTripFile
	sess, ok := s.requireSession(w, r)
	if !ok {
		return "", "", trip, false
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "el administrador no tiene viajes")
		return "", "", trip, false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET")
		return "", "", trip, false
	}
	w.Header().Set("Cache-Control", "no-cache")

	root, file := "", ""
	if dir := r.URL.Query().Get("trip"); dir != "" && !strings.HasPrefix(dir, ".") &&
		!strings.ContainsAny(dir, "/\\\x00") {
		root = s.ownerFile(sess.User, []string{"data", "trips", dir})
		file = s.ownerFile(sess.User, []string{"data", "trips", dir, "trip.json"})
	}
	if root == "" || file == "" || !loadJSONFile(file, &trip) {
		sendError(w, r, http.StatusNotFound, "no existe ese viaje")
		return "", "", trip, false
	}
	return sess.User, root, trip, true
}

// apiJourney answers GET /api/journey?trip=<dir>.
func (s *Server) apiJourney(w http.ResponseWriter, r *http.Request) {
	user, root, trip, ok := s.journeyTarget(w, r)
	if !ok {
		return
	}
	sendJSON(w, r, http.StatusOK, s.buildTripView(user, lastSegment(root), root, trip, s.ownerNow(user)))
}

// apiJourneyFile answers GET /api/journey/{photo|thumb}/<name>?trip=<dir>.
func (s *Server) apiJourneyFile(w http.ResponseWriter, r *http.Request) {
	user, root, _, ok := s.journeyTarget(w, r)
	if !ok {
		return
	}
	s.serveTripPhoto(w, r, user, root)
}
