package main

// =============================================================================
// /api/translate/model - the Language app's window on Mozilla's model files.
// =============================================================================
//
//	GET /api/translate/model?f=<attachment location>   the file, streamed as is
//	GET /api/translate/config                          the admin's engines + dictionaries
//	PUT /api/translate/config                          the admin saves them (admin only)
//
// The Language app (client/apps/language) translates on the device with
// Bergamot, the engine inside Firefox Translations. Its models (es->en,
// en->zh...) are listed by Mozilla's Remote Settings, which the browser reads
// directly (it sends CORS headers), but the files themselves live on
// firefox-settings-attachments.cdn.mozilla.net, which sends NO CORS header: a
// page cannot read them. So the server fetches them for it - nothing more.
//
// No copy is kept here: the answer streams through (32 KB at a time, so no RAM
// to speak of) and the browser keeps the file in its own cache. The locations
// carry a content id, so the answer may be cached for good.
//
// NOT AN OPEN PROXY: only GET, only that one host, only paths shaped like a
// translations-models attachment, through the bookmarks' guarded dialer
// (public internet only), at most trMax bytes. The answer always goes back as
// application/octet-stream with a sandbox CSP.

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	trHost    = "https://firefox-settings-attachments.cdn.mozilla.net/"
	trMax     = 256 << 20 // bytes: the biggest model today is ~60 MB
	trTimeout = 10 * time.Minute
)

// trPath is the only shape of path we ask for: a model, lexicon or vocabulary
// of the translations-models collection.
var trPath = regexp.MustCompile(`^main-workspace/translations-models/[0-9A-Za-z-]+\.(bin|spm)$`)

var trClient = &http.Client{
	Timeout: trTimeout,
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 8 * time.Second, Control: bmControl}).DialContext,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		MaxIdleConns:          4,
		IdleConnTimeout:       60 * time.Second,
	},
	// The CDN answers straight away; a redirect would lead somewhere unchecked.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// trGet is the one outbound GET; a variable so the tests can swap the internet.
var trGet = func(ctx context.Context, u string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Nayive/1.0 (Language app; https://github.com/peyrona/nayive)")
	return trClient.Do(req)
}

func (s *Server) apiTranslate(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	switch r.PathValue("what") {
	case "model":
		s.trModel(w, r)
	case "config":
		s.trConfig(w, r, sess)
	default:
		sendError(w, r, http.StatusNotFound, "no such translate call")
	}
}

// trModel streams one of Mozilla's model files.
func (s *Server) trModel(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, "use GET", http.MethodGet) {
		return
	}
	f := cleanQuery(r).Get("f")
	if !trPath.MatchString(f) {
		sendError(w, r, http.StatusBadRequest, "not a model file")
		return
	}

	resp, err := trGet(r.Context(), trHost+f)
	if err != nil {
		sendError(w, r, http.StatusBadGateway, "the model server did not answer")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		sendError(w, r, http.StatusBadGateway, "the model server said "+strconv.Itoa(resp.StatusCode))
		return
	}
	if resp.ContentLength > trMax {
		sendError(w, r, http.StatusBadGateway, "file too big")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	if resp.ContentLength > 0 {
		h.Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, trMax))
}

// THE ADMIN'S SETTINGS: which engines and dictionaries every account uses,
// and how (score, timeout, server address...). Only the admin changes them
// (admin.html, "Language" tab); every account reads them when the app opens.
// The file is config/language.json; the shape is the app's own (engines,
// custom, dictionaries - client/apps/language/settings.js), checked there in
// full. Here only the outline is checked, so a stray PUT cannot store junk.
// A person's own choices (languages, Local mode) stay in their browser.

const trConfigMax = 64 << 10 // bytes: a handful of engines is ~2 KB

var trConfigMu sync.Mutex // one write at a time

func (s *Server) trConfigFile() string {
	return filepath.Join(s.cfg.ConfigDir, "language.json")
}

func (s *Server) trConfig(w http.ResponseWriter, r *http.Request, sess Session) {
	if !allowMethod(w, r, "use GET or PUT", http.MethodGet, http.MethodPut) {
		return
	}
	if r.Method == http.MethodGet {
		raw, err := os.ReadFile(s.trConfigFile())
		if err != nil || !json.Valid(raw) {
			raw = []byte("{}") // nothing saved yet: the app's own defaults
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw)
		return
	}

	if sess.Role != "admin" {
		sendError(w, r, http.StatusForbidden, "solo el administrador")
		return
	}
	if r.ContentLength > trConfigMax {
		sendError(w, r, http.StatusRequestEntityTooLarge, "petición demasiado grande")
		return
	}
	var body struct {
		Engines      map[string]map[string]any `json:"engines"`
		Custom       []map[string]any          `json:"custom"`
		Dictionaries map[string]map[string]any `json:"dictionaries"`
	}
	if !readJSONBody(w, r, &body) {
		return
	}
	if body.Engines == nil {
		body.Engines = map[string]map[string]any{}
	}
	if body.Custom == nil {
		body.Custom = []map[string]any{}
	}
	if body.Dictionaries == nil {
		body.Dictionaries = map[string]map[string]any{}
	}

	trConfigMu.Lock()
	err := atomicWriteJSON(s.trConfigFile(), body, 4)
	trConfigMu.Unlock()
	if err != nil {
		s.log.Error("language settings not saved", "err", err)
		sendError(w, r, http.StatusInternalServerError, "not saved")
		return
	}
	sendJSON(w, r, http.StatusOK, map[string]any{"ok": true})
}
