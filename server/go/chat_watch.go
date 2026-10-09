package main

// =============================================================================
// Chat "watch together" - a YouTube video that plays for everybody at once.
// =============================================================================
//
// Whoever sent a message with a YouTube link may press "Play for everyone":
// every page with that chat open then plays the same video at the same moment
// (a virtual karaoke). Only that sender moves it - play, pause, a jump - and
// every other page follows. The video itself comes from YouTube; this server
// only carries where it is: which video, playing or not, at what second, and
// when (server ms) that was true. Each page works out "now" from that.
//
// Memory only, like "typing": nothing reaches the disk, a restart forgets it.
//
//	POST conv/<c>/watch {"msg","video","state":"play"|"pause"|"stop","pos"}
//
// The wait carries "watch" (conv -> state) and "now" (server ms), which lets a
// page set its clock to the server's.

import (
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	chatWatchIdle = 30 * time.Minute // paused this long: gone
	chatWatchMax  = 4 * time.Hour    // whatever happens, gone after this
)

// A YouTube video id: 11 URL-safe characters.
var ytIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

type chatWatch struct {
	Msg     int64   `json:"msg"`     // the message with the link
	Video   string  `json:"video"`   // YouTube id
	By      string  `json:"by"`      // the participant who moves it
	Playing bool    `json:"playing"` // running, or paused at Pos
	Pos     float64 `json:"pos"`     // seconds into the video at At
	At      int64   `json:"at"`      // server ms when Pos was true

	started time.Time
	touched time.Time
}

// chatWatchSet: POST conv/<c>/watch. Caller holds h.mu (inside `in`).
func (s *Server) chatWatchSet(w http.ResponseWriter, r *http.Request, a chatActor, c *chatConv, conv string,
	body chatWatchReq) {
	o := a.o
	cur := o.watch[conv]
	if body.State == "stop" {
		if cur != nil && cur.By != a.pid {
			sendError(w, r, http.StatusForbidden, "solo quien lo puso puede pararlo")
			return
		}
		if cur != nil {
			delete(o.watch, conv)
			o.changed(false)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if body.State != "play" && body.State != "pause" {
		sendError(w, r, http.StatusBadRequest, "estado no válido")
		return
	}
	if !ytIDRe.MatchString(body.Video) || body.Pos < 0 || body.Pos > 24*3600 {
		sendError(w, r, http.StatusBadRequest, "vídeo no válido")
		return
	}
	// The same video from the same message: only the one who put it on moves it.
	// Anything else is a new start, which needs the sender's own message that
	// holds that very video - and replaces whatever played before.
	if cur == nil || cur.Msg != body.Msg || cur.Video != body.Video {
		m := c.byID[body.Msg]
		if m == nil || m.Deleted || m.From != a.pid {
			sendError(w, r, http.StatusForbidden, "solo quien envió el enlace puede ponerlo")
			return
		}
		if !strings.Contains(m.Text, body.Video) {
			sendError(w, r, http.StatusBadRequest, "ese vídeo no está en el mensaje")
			return
		}
		if cur != nil && cur.By != a.pid {
			sendError(w, r, http.StatusConflict, "ya hay otro vídeo puesto")
			return
		}
		cur = &chatWatch{Msg: body.Msg, Video: body.Video, By: a.pid, started: time.Now()}
		if o.watch == nil {
			o.watch = map[string]*chatWatch{}
		}
		o.watch[conv] = cur
		s.chat.sweepOnce.Do(func() { go s.chat.sweep() })
	} else if cur.By != a.pid {
		sendError(w, r, http.StatusForbidden, "solo quien lo puso puede moverlo")
		return
	}
	cur.Playing = body.State == "play"
	cur.Pos = body.Pos
	cur.At = nowMs()
	cur.touched = time.Now()
	o.changed(false)
	w.WriteHeader(http.StatusNoContent)
}

type chatWatchReq struct {
	Msg   int64   `json:"msg"`
	Video string  `json:"video"`
	State string  `json:"state"`
	Pos   float64 `json:"pos"`
}

// watchFor are the videos playing in the conversations `pid` takes part in.
func (o *chatOwner) watchFor(pid string) map[string]*chatWatch {
	out := map[string]*chatWatch{}
	for conv, cw := range o.watch {
		if o.isMember(conv, pid) {
			out[conv] = cw
		}
	}
	return out
}

// watchTick drops a video left paused, or on too long. True when one went.
// Caller holds h.mu.
func (o *chatOwner) watchTick(now time.Time) bool {
	moved := false
	for conv, cw := range o.watch {
		if now.Sub(cw.started) > chatWatchMax || (!cw.Playing && now.Sub(cw.touched) > chatWatchIdle) {
			delete(o.watch, conv)
			moved = true
		}
	}
	return moved
}
