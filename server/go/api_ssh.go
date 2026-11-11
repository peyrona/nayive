package main

// =============================================================================
// /api/ssh/{what} - the Admin panel's SSH tab (ssh_term.go; its "confirm it
// is you" part is a Confirmer: confirm_passkey.go, confirm_totp.go).
// =============================================================================
//
//   GET  accounts this server's login accounts, the one Nayive runs as, its name
//   GET  status   which ways to confirm work at this address (passkeys, app, none)
//   GET  keys     the passkeys and the app, one list (names and dates only)
//   POST setup    write a one-time setup code to config/ (nothing set up yet)
//   POST begin    {mode:"get"|"create", code?, ticket?} -> a challenge
//   POST confirm  a passkey's answer -> {ticket}
//   POST register a new passkey (setup code or ticket) -> {ticket}
//   POST totp-begin {code?, ticket?} -> {secret, uri}: an app to add
//   POST totp-add   {code?, otp, name} -> {ticket}: its first code (the setup code again, if it was the gate)
//   POST totp       {otp} -> {ticket}: confirm with the app
//   POST remove   {ticket, id} (id "app": the app)
//   POST open     {ticket, user, password, cols, rows} -> {id}
//   GET  read     ?id=&from=N -> {next, data, ended?} (waits up to 25 s)
//   POST write    {id, data}
//   POST resize   {id, cols, rows}
//   POST close    {id}
//
// Every call: an admin session. Every POST: an Origin header equal to this
// page's own, so no other site can drive it.

import (
	"net"
	"net/http"
	"strconv"
)

var errSSHNeedPasskey = errConfirmFirst

func (s *Server) apiSSH(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role != "admin" {
		sendError(w, r, http.StatusForbidden, "solo el administrador")
		return
	}
	token := tokenFrom(r)
	origin := requestOrigin(r)
	what := r.PathValue("what")
	h := s.ssh
	rpID := r.Host // the passkeys' host name
	if hst, _, err := net.SplitHostPort(r.Host); err == nil {
		rpID = hst
	}

	if r.Method == http.MethodGet {
		switch what {
		case "status":
			st, err := h.Status(rpID)
			if err != nil {
				sendError(w, r, http.StatusInternalServerError, "can't read the passkeys")
				return
			}
			sendJSON(w, r, http.StatusOK, st)
		case "accounts":
			sendJSON(w, r, http.StatusOK, h.accounts())
		case "keys":
			keys, err := h.ListKeys()
			if err != nil {
				sendError(w, r, http.StatusInternalServerError, "can't read the passkeys")
				return
			}
			sendJSON(w, r, http.StatusOK, map[string]any{"keys": keys})
		case "read":
			t := h.find(token, r.URL.Query().Get("id"))
			if t == nil {
				sendJSON(w, r, http.StatusOK, sshRead{Ended: "Disconnected."})
				return
			}
			from, _ := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
			sendJSON(w, r, http.StatusOK, t.read(from, r.Context().Done()))
		default:
			sendError(w, r, http.StatusNotFound, "unknown")
		}
		return
	}
	if r.Method != http.MethodPost {
		sendError(w, r, http.StatusMethodNotAllowed, "use GET or POST")
		return
	}
	if r.Header.Get("Origin") != origin {
		sendError(w, r, http.StatusForbidden, "wrong origin")
		return
	}

	var body struct {
		passkeyRegistration
		Mode      string `json:"mode"`
		Signature string `json:"signature"`
		User      string `json:"user"`
		Password  string `json:"password"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
		Data      string `json:"data"`
		OTP       string `json:"otp"` // the app's 6-digit code ("code" is the setup code)
	}
	if err := readJSON(w, r, &body); err != nil {
		sendBodyError(w, r, err)
		return
	}
	refuse := func(err error) { sendError(w, r, http.StatusBadRequest, err.Error()) }

	switch what {
	case "setup":
		path, err := h.MakeSetupCode()
		if err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"file": path})

	case "begin":
		out, err := h.Begin(token, body.Mode, rpID, sess.User, body.Code, body.Ticket)
		if err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, out)

	case "confirm":
		ticket, err := h.Confirm(token, origin, passkeyAssertion{
			ID: body.ID, ClientData: body.ClientData, AuthData: body.AuthData, Signature: body.Signature,
		})
		if err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"ticket": ticket})

	case "register":
		ticket, err := h.Register(token, origin, body.passkeyRegistration)
		if err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"ticket": ticket})

	case "totp-begin":
		out, err := h.TOTPBegin(token, sess.User, rpID, body.Code, body.Ticket)
		if err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, out)

	case "totp-add":
		ticket, err := h.TOTPAdd(token, body.Code, body.OTP, body.Name)
		if err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"ticket": ticket})

	case "totp":
		ticket, err := h.TOTPConfirm(token, body.OTP)
		if err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"ticket": ticket})

	case "remove":
		if err := h.RemoveKey(token, body.Ticket, body.ID); err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})

	case "open":
		if !h.SpendTicket(token, body.Ticket) {
			refuse(errSSHNeedPasskey)
			return
		}
		t, err := h.Open(token, body.User, body.Password, body.Cols, body.Rows)
		body.Password = ""
		if err != nil {
			refuse(err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]string{"id": t.id})

	case "write", "resize", "close":
		t := h.find(token, body.ID)
		if t == nil {
			sendError(w, r, http.StatusGone, "Disconnected.")
			return
		}
		switch what {
		case "write":
			if len(body.Data) > sshMaxWrite {
				sendError(w, r, http.StatusRequestEntityTooLarge, "too much at once")
				return
			}
			if err := t.send(body.Data); err != nil {
				sendError(w, r, http.StatusGone, err.Error())
				return
			}
		case "resize":
			t.sess.WindowChange(clampDim(body.Rows, 24), clampDim(body.Cols, 80))
		case "close":
			h.CloseFor(token)
		}
		sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})

	default:
		sendError(w, r, http.StatusNotFound, "unknown")
	}
}
