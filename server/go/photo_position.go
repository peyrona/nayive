package main

// =============================================================================
// A photo as a position: the GPS inside a JPEG places its owner on a trip.
// =============================================================================
//
// When a user uploads a JPEG into the photo folder of one of their trips that
// has a public link, the position the camera wrote into it joins that trip's
// positions (positions.go), at the time the POSITION was taken:
//
//  1. the GPS time stamp - UTC, and the moment of the fix itself;
//  2. else DateTimeOriginal with its OffsetTimeOriginal;
//  3. else DateTimeOriginal on the clock of the stage it falls in (its tz);
//  4. else DateTimeOriginal on the owner's own clock.
//
// A photo with no time, or taken outside the trip's days, places nothing. One
// taken earlier and uploaded late still joins the route at its own time, and
// becomes "where I am now" only if the accuracy rule says so.
//
// Only the trip's OWN photo folder counts: a photo a friend sent, saved
// somewhere else, is not where the owner was.
//
// It runs after the upload has been answered; a failure here is only logged
// and never costs the upload.

import (
	"path/filepath"
	"strings"
	"time"
)

func isJPEGName(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return ext == ".jpg" || ext == ".jpeg"
}

// photoUploaded is called for every JPEG a user PUTs into their own home.
// `rel` is its home-relative path ("files/fotos/lisboa/IMG_1.jpg").
func (s *Server) photoUploaded(user, rel string, target Resolved) {
	defer func() {
		if v := recover(); v != nil {
			s.log.Error("reading a photo's position failed", "err", v)
		}
	}()

	parts := splitPath(rel)
	if len(parts) < 3 || parts[0] != "files" {
		return
	}
	// The cheap test first: is it inside a linked trip's photo folder at all?
	var trips []linkedTrip
	for _, lt := range s.linkedTrips(user) {
		dir := publicPhotoDir(lt.trip.PhotosDir)
		if dir != nil && len(parts) > len(dir) && hasPrefixSegments(parts, dir) {
			trips = append(trips, lt)
		}
	}
	if len(trips) == 0 {
		return
	}

	file, err := target.Open()
	if err != nil {
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	meta, err := readJPEGMeta(file, info.Size())
	if err != nil || !meta.HasGPS {
		return
	}

	acc := meta.Acc
	if acc <= 0 {
		acc = accPhoto
	}
	ownerLoc := Location(s.users.UserTZ("user", user))
	for _, lt := range trips {
		at, ok := photoTime(meta, lt.trip, ownerLoc)
		if !ok {
			continue
		}
		p := tripPosition{Lat: meta.Lat, Lon: meta.Lon, Acc: acc, At: at, Source: "photo"}
		if s.storePosition(user, lt, p) {
			s.log.Info("a photo placed its owner on a trip", "user", user)
		}
	}
}

// photoTime is when a photo's position was taken, as UNIX seconds.
func photoTime(m jpegMeta, trip publicTripFile, ownerLoc *time.Location) (int64, bool) {
	if !m.GPSTime.IsZero() {
		return m.GPSTime.Unix(), true
	}
	if len(m.Taken) < 19 {
		return 0, false
	}
	clock := m.Taken[:19]

	if m.Offset != "" {
		if t, err := time.Parse("2006:01:02 15:04:05-07:00", clock+m.Offset); err == nil {
			return t.Unix(), true
		}
	}

	// No offset: the local time of wherever the photo was taken. The stage that
	// day knows its time zone; failing that, the owner's.
	loc := ownerLoc
	day := strings.ReplaceAll(clock[:10], ":", "-")
	for _, st := range trip.Stages {
		if st.Tz == "" || st.StartDate == "" || day < st.StartDate || (st.EndDate != "" && day > st.EndDate) {
			continue
		}
		if stageLoc, err := time.LoadLocation(st.Tz); err == nil {
			loc = stageLoc
			break
		}
	}
	if loc == nil {
		loc = time.Local
	}
	t, err := time.ParseInLocation("2006:01:02 15:04:05", clock, loc)
	if err != nil || t.Year() < 2000 {
		return 0, false
	}
	return t.Unix(), true
}
