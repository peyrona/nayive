package main

// =============================================================================
// /api/push - this user's devices: native OS notifications.
// =============================================================================
//
//	GET    -> {"vapid_public", "window_minutes", "subscribed", "count"}
//	POST   -> save {"subscription"?, "window_minutes"?, "lang"?}
//	DELETE -> ?endpoint=...   forget one device
//
// Regular users only: the admin has no calendar and no home directory, so
// per-user reminders do not apply to that account.
//
// NOTE WHAT GET DOES NOT RETURN. The old bot-token API handed the live token
// straight back to the browser so the field could be pre-filled - a secret
// round-tripping through the DOM for cosmetic reasons. Here the page needs no
// secret at all: it reads its OWN subscription from
// registration.pushManager.getSubscription(), and the only key we send is the
// VAPID PUBLIC one. An endpoint is a capability to notify that user, so it is
// never returned and never logged.

import (
	"encoding/json"
	"net/http"
)

// pushRequest is the body of POST /api/push. Both shapes arrive here: a whole
// subscription, or just a new window.
type pushRequest struct {
	Subscription *struct {
		Endpoint string   `json:"endpoint"`
		Keys     PushKeys `json:"keys"`
	} `json:"subscription"`
	// java: RAW, not *int - see pushFile in users.go. A typed field would also
	// have made `"window_minutes": "25"` fail the whole request with "bad
	// JSON", where the Python's int("25") accepts it.
	WindowMinutes json.RawMessage `json:"window_minutes"`
	Lang          string          `json:"lang"`
	Label         string          `json:"label"`
}

func (s *Server) apiPush(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden,
			"los avisos son por usuario; entra como usuario")
		return
	}
	user := sess.User

	// Say plainly when the crypto cannot start, instead of handing the browser
	// a key it cannot use. (In the Python this was the "python3-cryptography is
	// missing" path; here the only way to fail is an unreadable vapid.json.)
	vapidPublic, err := s.push.PublicKey()
	if err != nil {
		sendError(w, r, http.StatusServiceUnavailable, err.Error())
		return
	}

	switch r.Method {
	case http.MethodGet:
		cfg := s.users.UserPush(user)
		sendJSON(w, r, http.StatusOK, map[string]any{
			"vapid_public":   vapidPublic,
			"window_minutes": cfg.WindowMinutes,
			"subscribed":     s.users.HasPushSub(user, queryValue(r, "endpoint")),
			"count":          len(cfg.Subs),
		})

	case http.MethodDelete:
		s.users.RemovePushSub(user, queryValue(r, "endpoint"))
		cfg := s.users.UserPush(user)
		s.log.Info("push: device removed", "user", user, "left", len(cfg.Subs))
		sendJSON(w, r, http.StatusOK, map[string]any{
			"message":        "ok",
			"subscribed":     false,
			"window_minutes": cfg.WindowMinutes,
			"count":          len(cfg.Subs),
		})

	case http.MethodPost:
		s.pushSave(w, r, user)

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET, POST o DELETE")
	}
}

func (s *Server) pushSave(w http.ResponseWriter, r *http.Request, user string) {
	var body pushRequest
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}

	// TWO SHAPES ON ONE ROUTE. {"window_minutes": N} alone changes just the
	// lead time - that has to work on a device with notifications switched OFF,
	// which is exactly when a user goes looking for the setting.
	if body.Subscription == nil {
		if body.WindowMinutes == nil {
			sendError(w, r, http.StatusBadRequest, "falta la suscripcion")
			return
		}
		if _, ok := s.users.SetPushWindow(user, body.WindowMinutes); !ok {
			sendError(w, r, http.StatusInternalServerError, "sin carpeta de usuario")
			return
		}
		cfg := s.users.UserPush(user)
		sendJSON(w, r, http.StatusOK, map[string]any{
			"message":        "ok",
			"window_minutes": cfg.WindowMinutes,
			"subscribed":     s.users.HasPushSub(user, queryValue(r, "endpoint")),
			"count":          len(cfg.Subs),
		})
		return
	}

	res := s.users.AddPushSub(user, body.Subscription.Endpoint,
		body.Subscription.Keys.P256dh, body.Subscription.Keys.Auth,
		body.Lang, body.Label, body.WindowMinutes)

	switch res {
	case "invalid":
		sendError(w, r, http.StatusBadRequest, "suscripcion no valida")
		return
	case "no-home":
		sendError(w, r, http.StatusInternalServerError, "sin carpeta de usuario")
		return
	}

	cfg := s.users.UserPush(user)
	s.log.Info("push: device registered", "result", res, "user", user, "total", len(cfg.Subs))
	sendJSON(w, r, http.StatusOK, map[string]any{
		"message":        "ok",
		"subscribed":     true,
		"window_minutes": cfg.WindowMinutes,
		"count":          len(cfg.Subs),
	})
}
