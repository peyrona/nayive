package main

// =============================================================================
// /api/location - a Nayive page reports where its device is.
// =============================================================================
//
//	GET  -> {"due": true|false}        is a new position wanted right now?
//	POST -> {lat, lon, acc, place}     store one
//
// A web page cannot read GPS in the background, so nothing here pulls. A device
// where the owner ticked "send my location" asks GET every quarter of an hour
// while a Nayive page is open (shared/ui.js), and reads the GPS only when the
// answer is due. Reporting with Nayive closed is the OwnTracks app's job
// (owntracks.go).
//
// Due means: a trip of theirs with a PUBLIC LINK is on today (their own clock)
// and its "where I am now" is at least positionEvery old - or positionRetry old
// when it was rough. positions.go rounds and stores what arrives.

import (
	"net/http"
	"time"
)

const (
	positionEvery = time.Hour
	positionRetry = 15 * time.Minute // a rough "now" (worse than accRough) is asked for again sooner
)

type locationRequest struct {
	Lat   *float64 `json:"lat"`
	Lon   *float64 `json:"lon"`
	Acc   *float64 `json:"acc"` // metres, as the browser reported it
	Place string   `json:"place"`
}

func (s *Server) apiLocation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "el administrador no tiene viajes")
		return
	}

	switch r.Method {
	case http.MethodGet:
		sendJSON(w, r, http.StatusOK, map[string]bool{"due": len(s.tripsWantingPosition(sess.User)) > 0})

	case http.MethodPost:
		var body locationRequest
		if err := readJSON(w, r, &body); err != nil {
			sendBodyError(w, r, err)
			return
		}
		if body.Lat == nil || body.Lon == nil || !validLatLon(*body.Lat, *body.Lon) {
			sendError(w, r, http.StatusBadRequest, "posición no válida")
			return
		}
		if len(s.tripsWantingPosition(sess.User)) == 0 {
			sendError(w, r, http.StatusConflict, "ahora no hace falta")
			return
		}
		acc := accUnknown
		if body.Acc != nil && *body.Acc > 0 {
			acc = *body.Acc
		}
		saved := s.recordPosition(sess.User, tripPosition{
			Lat: *body.Lat, Lon: *body.Lon, Acc: acc, Place: body.Place,
			At: time.Now().Unix(), Source: "phone",
		})
		sendJSON(w, r, http.StatusOK, map[string]int{"saved": saved})

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET o POST")
	}
}

// tripsWantingPosition are the folders of this user's publicly linked trips
// that are on today and whose "where I am now" is due for a new reading.
func (s *Server) tripsWantingPosition(user string) []string {
	now := s.ownerNow(user)
	today := now.Format("2006-01-02")

	var out []string
	for _, lt := range s.linkedTrips(user) {
		if lt.trip.StartDate == "" || lt.trip.EndDate == "" || today < lt.trip.StartDate || today > lt.trip.EndDate {
			continue
		}
		if latest := readPositionsDoc(lt.root).Latest; latest != nil {
			age := now.Sub(time.Unix(latest.At, 0))
			if age < positionRetry || (age < positionEvery && accOf(*latest) <= accRough) {
				continue
			}
		}
		out = append(out, lt.root)
	}
	return out
}
