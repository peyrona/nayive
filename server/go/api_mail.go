package main

// =============================================================================
// /api/mail - the eMail app (signed-in users; the admin has no mail).
// =============================================================================
//
//	GET    unread                       {"n"}: the launcher's badge (every account's Inbox)
//	GET    providers                    {"providers": [...]}: the dialog's list (mail_presets.go)
//	GET    accounts                     {"accounts": [...]} - never a password
//	POST   accounts                     {"email","pass","name"?,"provider"?, "imapHost"?,"imapPort"?,
//	                                    "smtpHost"?,"smtpPort"?,"user"?}: tests the login, keeps it.
//	                                    A provider (picked, or known by the domain) needs no
//	                                    hosts; "other"/unknown without them -> 422 {"code":"hosts"};
//	                                    a provider that lets no app in (Microsoft) -> 422 "blocked"
//	DELETE accounts/<a>
//	PATCH  accounts/<a>                 {"pass"}: a new password, tried first; the account and its labels stay
//	GET    <a>/trays                    {"trays": [{role, unread, total, missing}]}
//	GET    <a>/list?tray=&q=&cursor=    a page, newest first: {"items","next"}
//	GET    <a>/msg/<ref>                one message (marked read); its HTML already cleaned
//	GET    <a>/att/<ref>/<part>         one attachment; ?inline=1: a picture, shown in place
//	GET    <a>/msg/<ref>?mid=<id>       ...and when it moved since: found again by its Message-ID
//	                                    (nowhere at all: 404 "gone", and its labels are dropped;
//	                                    only in a folder that is no tray: 404 "elsewhere", labels kept)
//	POST   <a>/set                      {"refs",["seen"],["flagged"],["tray"]} -> {"moved": {old: new}}
//	                                    tray "trash" starts its Trash clock (mail_labels.go)
//	POST   <a>/restore                  {"refs"} | {"mids"}: out of the Trash, each back where it was
//	POST   <a>/forget                   {"refs"}: delete for good (Trash only)
//	                                    (set, restore, forget: {"failed": [refs]} names the ones the
//	                                    server refused one by one; the rest were done)
//	POST   <a>/trash/empty              everything in the Trash, for good -> {"deleted"}
//	POST   <a>/spam/empty               everything in Spam, for good -> {"deleted"}
//	POST   <a>/labels                   {"refs","mids"?,"add":[ids],"remove":[ids]} -> {"items", "known"}
//	                                    mids (the refs' Message-IDs, same order): a ref the server no
//	                                    longer knows (a label's stale row) is changed by its tag -> known
//	POST   <a>/send                     multipart: "json" = MailOut (mail_compose.go) + "file" uploads
//	                                    -> {"ok","mid"}; "noCopy": sent, but no copy in Sent - its draft
//	                                    stays. One draft (its "mid") goes once: 409 "sent" within
//	                                    mailSentHold; 502 "unsure": no answer once it was handed over
//	POST   <a>/draft                    the same, into Drafts -> {"ref","mid","parts"} - never refused
//	                                    for an address that is not one yet: kept as typed (toRest...)
//	POST   <a>/draft/delete             {"ref"}: a draft, gone for good
//	GET    contacts                     {"contacts": [{name,email}]}: the "To" field's suggestions
//
// Nayive's own, for every account (mail_labels.go):
//
//	GET    labels                       {"labels": [{id,name,color}]}
//	POST   labels                       {"name","color"?} -> the label
//	PATCH  labels/<id>                  {"name"?,"color"?}
//	DELETE labels/<id>                  and off every message
//	GET    label/<id>                   {"items"}: its messages, every account, newest first
//	GET    settings | PUT settings      {"trashDays" (1-365), "showImages", "signature"}
//
// A failing mail server answers {"error","code"}: 502 "auth" (the password
// was refused) or "down" (no answer); 422 "rejected" (it answered no: its own
// words in "text"), "private" (a server on a private network); 413 "toobig";
// 409 "key" (the password must be typed again). A message that moved or went
// away is 404 {"code":"gone"}. Never 401: that one means "your Nayive session
// ended" to every app.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	netmail "net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func (s *Server) apiMail(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if sess.Role == "admin" {
		sendError(w, r, http.StatusForbidden, "el correo es por usuario; entra como usuario")
		return
	}
	user := sess.User
	rest := splitPath(r.PathValue("rest"))
	method := func(m string) bool {
		if r.Method != m {
			w.Header().Set("Allow", m)
			sendError(w, r, http.StatusMethodNotAllowed, "method not allowed")
			return false
		}
		return true
	}

	switch {
	case len(rest) == 1 && rest[0] == "unread":
		if method(http.MethodGet) {
			sendJSON(w, r, http.StatusOK, map[string]int{"n": s.mail.Unread(user)})
		}

	case len(rest) == 1 && rest[0] == "providers":
		if method(http.MethodGet) {
			sendJSON(w, r, http.StatusOK, map[string]any{"providers": mailPresets})
		}

	case len(rest) == 1 && rest[0] == "accounts":
		switch r.Method {
		case http.MethodGet:
			sendJSON(w, r, http.StatusOK, map[string]any{"accounts": s.mail.Accounts(user)})
		case http.MethodPost:
			s.mailAddAccount(w, r, user)
		default:
			w.Header().Set("Allow", "GET, POST")
			sendError(w, r, http.StatusMethodNotAllowed, "method not allowed")
		}

	case len(rest) == 2 && rest[0] == "accounts":
		switch r.Method {
		case http.MethodDelete:
			found, err := s.mail.Remove(user, rest[1])
			switch {
			case err != nil:
				s.mailSaveFail(w, r, user, "accounts (removing one)", err)
			case !found:
				sendError(w, r, http.StatusNotFound, "no such account")
			default:
				sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
			}
		case http.MethodPatch:
			s.mailNewPassword(w, r, user, rest[1])
		default:
			w.Header().Set("Allow", "DELETE, PATCH")
			sendError(w, r, http.StatusMethodNotAllowed, "method not allowed")
		}

	case len(rest) == 1 && rest[0] == "contacts":
		if method(http.MethodGet) {
			sendJSON(w, r, http.StatusOK, map[string]any{"contacts": s.mail.Contacts(user)})
		}

	case len(rest) >= 1 && (rest[0] == "labels" || rest[0] == "label" || rest[0] == "settings"):
		s.mailUserRoute(w, r, user, rest)

	case len(rest) >= 2:
		prov := s.mail.provider(user, rest[0])
		if prov == nil {
			sendError(w, r, http.StatusNotFound, "no such account")
			return
		}
		want := http.MethodGet
		switch rest[1] {
		case "set", "restore", "forget", "trash", "spam", "labels", "send", "draft":
			want = http.MethodPost
		}
		if !method(want) {
			return
		}
		s.mailAccountRoute(w, r, user, rest[0], prov, rest[1:])

	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}

func (s *Server) mailAccountRoute(w http.ResponseWriter, r *http.Request, user, acct string,
	prov MailProvider, rest []string) {
	ctx := r.Context()
	switch {
	case len(rest) == 1 && rest[0] == "trays":
		trays, err := prov.Trays(ctx)
		if err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"trays": trays})

	case len(rest) == 1 && rest[0] == "list":
		q := r.URL.Query()
		role, ok := validRole(q.Get("tray"))
		if !ok {
			role = RoleInbox
		}
		query := clipRunes(strings.TrimSpace(q.Get("q")), 200)
		page, err := prov.List(ctx, role, query, q.Get("cursor"))
		if err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		s.mail.annotate(user, acct, page.Items)
		sendJSON(w, r, http.StatusOK, page)

	case len(rest) == 2 && rest[0] == "msg":
		ref, ok := parseMailRef(rest[1])
		if !ok {
			sendError(w, r, http.StatusBadRequest, "bad message ref")
			return
		}
		msg, err := prov.Message(ctx, ref)
		if mid := r.URL.Query().Get("mid"); errors.Is(err, errMailGone) && mid != "" {
			// moved since that ref was taken (a label's list is only a memory)
			var at MailSummary
			if at, err = prov.Find(ctx, mid, nil); err == nil {
				if ref, ok = parseMailRef(at.Ref); ok {
					msg, err = prov.Message(ctx, ref)
				}
			} else if errors.Is(err, errMailGone) {
				// In none of the five trays. Its labels go only when the
				// server says it is NOWHERE: one archived on the phone
				// (Gmail's All Mail) or moved to a folder of its own keeps
				// them, and the app hears "elsewhere" (data-safety I3,
				// mail-chat #3). Cannot tell: kept.
				if an, ok := prov.(mailAnywhere); ok {
					var there bool
					if there, err = an.Anywhere(ctx, mid); err == nil {
						if there {
							err = errMailElsewhere
						} else {
							s.mail.DropTag(user, acct, mid)
							err = errMailGone
						}
					}
				}
			}
		}
		if err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		rows := []MailSummary{msg.MailSummary}
		s.mail.annotate(user, acct, rows)
		msg.Labels = rows[0].Labels
		if msg.HTML != "" {
			base := "/api/mail/" + url.PathEscape(acct) + "/att/" + url.PathEscape(msg.Ref) + "/"
			cids := map[string]string{}
			for _, p := range msg.Parts {
				if p.CID != "" {
					cids[strings.ToLower(p.CID)] = base + url.PathEscape(p.ID) + "?inline=1"
				}
			}
			msg.HTML = sanitizeMailHTML(msg.HTML, func(cid string) string {
				if c, err := url.PathUnescape(cid); err == nil {
					cid = c
				}
				return cids[strings.ToLower(cid)]
			})
		}
		s.mail.Refresh(user, acct) // it is read now: the badge follows
		sendJSON(w, r, http.StatusOK, msg)

	case len(rest) == 1 && (rest[0] == "set" || rest[0] == "restore" || rest[0] == "forget" || rest[0] == "labels"):
		s.mailChange(w, r, user, acct, prov, rest[0])

	case len(rest) == 1 && (rest[0] == "send" || rest[0] == "draft"):
		s.mailWrite(w, r, user, acct, prov, rest[0] == "draft")

	case len(rest) == 2 && rest[0] == "draft" && rest[1] == "delete":
		var in struct {
			Ref string `json:"ref"`
		}
		if err := readJSON(w, r, &in); err != nil {
			sendBodyError(w, r, err)
			return
		}
		ref, ok := parseMailRef(in.Ref)
		if !ok || ref.Role != RoleDrafts {
			sendError(w, r, http.StatusBadRequest, "not a draft")
			return
		}
		if err := prov.Expunge(ctx, []MailRef{ref}); err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})

	case len(rest) == 2 && rest[0] == "trash" && rest[1] == "empty":
		a := s.mail.account(user, acct)
		if a == nil {
			sendError(w, r, http.StatusNotFound, "no such account")
			return
		}
		n, err := s.mail.purgeAccount(ctx, user, a, true)
		if err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]int{"deleted": n})

	case len(rest) == 2 && rest[0] == "spam" && rest[1] == "empty":
		n, err := s.mail.emptySpam(ctx, user, acct, prov)
		if err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		sendJSON(w, r, http.StatusOK, map[string]int{"deleted": n})

	case len(rest) == 3 && rest[0] == "att":
		ref, ok := parseMailRef(rest[1])
		if !ok {
			sendError(w, r, http.StatusBadRequest, "bad message ref")
			return
		}
		part, data, err := prov.Attachment(ctx, ref, rest[2])
		if err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		s.mailSendPart(w, r, part, data)

	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}

// mailSendPart sends a part as a download - or, ?inline=1 and a picture, to
// be shown in place (a message's cid: images). Never as a page: whatever the
// sender called it, it cannot run here.
func (s *Server) mailSendPart(w http.ResponseWriter, r *http.Request, part MailPart, data []byte) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Cache-Control", "private, max-age=3600")
	ctype := strings.ToLower(part.Type)
	disp := "attachment"
	if r.URL.Query().Get("inline") == "1" && strings.HasPrefix(ctype, "image/") && ctype != "image/svg+xml" {
		disp = "inline"
	} else if ctype == "" || strings.HasPrefix(ctype, "text/") || strings.Contains(ctype, "html") ||
		strings.Contains(ctype, "xml") || strings.Contains(ctype, "javascript") {
		ctype = "application/octet-stream"
	}
	if d := mime.FormatMediaType(disp, map[string]string{"filename": part.Name}); d != "" {
		h.Set("Content-Disposition", d)
	} else {
		h.Set("Content-Disposition", disp)
	}
	h.Set("Content-Type", ctype)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// mailFail answers for a provider error (see the top).
func (s *Server) mailFail(w http.ResponseWriter, r *http.Request, user, acct string, err error) {
	code := mailErrCode(err)
	status := http.StatusBadGateway
	msg := "el servidor de correo no responde"
	switch code {
	case "gone":
		status, msg = http.StatusNotFound, "ese correo ya no está ahí"
	case "auth":
		msg = "el servidor de correo no acepta la contraseña"
	case "notray":
		status, msg = http.StatusConflict, "esa cuenta no tiene esa bandeja"
	case "rejected":
		status, msg = http.StatusUnprocessableEntity, "el servidor de correo lo rechazó"
	case "toobig":
		status, msg = http.StatusRequestEntityTooLarge, "el mensaje es demasiado grande para ese servidor"
	case "private":
		status, msg = http.StatusUnprocessableEntity, "ese servidor está en una red privada"
	case "key":
		status, msg = http.StatusConflict, "hay que escribir otra vez la contraseña de esta cuenta"
	case "smtp":
		msg = "se entra, pero no se puede enviar (servidor SMTP)"
	case "unsure":
		msg = "no se sabe si el correo salió: mira en Enviados"
	case "elsewhere":
		status, msg = http.StatusNotFound, "ese correo está en otra carpeta del servidor"
	}
	if errors.Is(err, context.Canceled) {
		return // the app left; nobody to tell
	}
	if code == "down" || code == "smtp" {
		s.log.Warn("mail: server call failed", "user", user, "account", acct, "err", err)
	}
	sendJSON(w, r, status, map[string]string{"error": msg, "code": code, "text": clipRunes(mailErrText(err), 300)})
}

// mailSaveFail answers for one of the user's mail files that could not be
// written: code "damaged" when that file failed to load (it is never written
// over, F4 - the app says to tell the administrator), else a plain 500.
func (s *Server) mailSaveFail(w http.ResponseWriter, r *http.Request, user, what string, err error) {
	s.log.Error("mail: saving "+what, "user", user, "err", err)
	if errors.Is(err, errDamaged) {
		sendJSON(w, r, http.StatusInternalServerError, map[string]string{
			"error": "no se pudo guardar: un archivo del correo está dañado (avisa al administrador)", "code": "damaged"})
		return
	}
	sendError(w, r, http.StatusInternalServerError, "no se pudo guardar")
}

// clipRunes cuts s to at most n bytes, never in the middle of a letter.
func clipRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func (s *Server) mailAddAccount(w http.ResponseWriter, r *http.Request, user string) {
	var in struct {
		Email    string `json:"email"`
		Pass     string `json:"pass"`
		Name     string `json:"name"`
		Provider string `json:"provider"`
		JMAPURL  string `json:"jmapUrl"`
		User     string `json:"user"`
		IMAPHost string `json:"imapHost"`
		IMAPPort int    `json:"imapPort"`
		SMTPHost string `json:"smtpHost"`
		SMTPPort int    `json:"smtpPort"`
	}
	if err := readJSON(w, r, &in); err != nil {
		sendBodyError(w, r, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	v, err := s.mail.Add(ctx, user, MailAccount{Email: in.Email, Pass: in.Pass, Name: in.Name, Provider: in.Provider, JMAPURL: in.JMAPURL, User: in.User,
		IMAPHost: in.IMAPHost, IMAPPort: in.IMAPPort, SMTPHost: in.SMTPHost, SMTPPort: in.SMTPPort})
	s.mailAccountAnswer(w, r, user, v, err)
}

// mailAccountAnswer: the answer to adding an account or giving it a new
// password - the account, or why not.
func (s *Server) mailAccountAnswer(w http.ResponseWriter, r *http.Request, user string, v MailAccountView, err error) {
	switch {
	case err == nil:
		sendJSON(w, r, http.StatusOK, v)
	case errors.Is(err, errMailBad):
		sendJSON(w, r, http.StatusBadRequest, map[string]string{"error": "faltan la dirección o la contraseña", "code": "bad"})
	case errors.Is(err, errMailBadURL):
		sendJSON(w, r, http.StatusBadRequest, map[string]string{"error": "esa dirección de servidor JMAP no vale", "code": "url"})
	case errors.Is(err, errMailBlocked):
		sendJSON(w, r, http.StatusUnprocessableEntity, map[string]string{"error": "ese proveedor no deja entrar con contraseña", "code": "blocked"})
	case errors.Is(err, errMailNeedHosts):
		sendJSON(w, r, http.StatusUnprocessableEntity, map[string]string{"error": "indica los servidores", "code": "hosts"})
	case errors.Is(err, errMailDup):
		sendJSON(w, r, http.StatusConflict, map[string]string{"error": "esa cuenta ya está", "code": "dup"})
	case errors.Is(err, errMailGone):
		sendError(w, r, http.StatusNotFound, "no such account")
	case errors.Is(err, errMailSendCheck): // before auth: a refused SMTP login is "cannot send"
		s.log.Warn("mail: an account logs in but cannot send", "user", user, "err", err)
		sendJSON(w, r, http.StatusBadGateway, map[string]string{"error": "se entra, pero no se puede enviar (servidor SMTP)", "code": "smtp",
			"text": clipRunes(mailErrText(err), 300)})
	case errors.Is(err, errMailAuth):
		sendJSON(w, r, http.StatusBadGateway, map[string]string{"error": "el servidor no acepta esa contraseña", "code": "auth"})
	case errors.Is(err, errMailPrivateNet):
		sendJSON(w, r, http.StatusUnprocessableEntity, map[string]string{"error": "ese servidor está en una red privada", "code": "private"})
	case errors.Is(err, errMailRejected):
		sendJSON(w, r, http.StatusUnprocessableEntity, map[string]string{"error": "el servidor de correo lo rechazó", "code": "rejected",
			"text": clipRunes(mailErrText(err), 300)})
	case errors.Is(err, errDamaged): // accounts.json failed to load: never written over (F4)
		sendJSON(w, r, http.StatusInternalServerError, map[string]string{"error": "no se pudo guardar: un archivo del correo está dañado (avisa al administrador)", "code": "damaged"})
	default:
		s.log.Warn("mail: adding an account failed", "user", user, "err", err)
		sendJSON(w, r, http.StatusBadGateway, map[string]string{"error": "no se pudo conectar con el servidor", "code": "down"})
	}
}

// mailNewPassword: PATCH accounts/<a> {"pass"}.
func (s *Server) mailNewPassword(w http.ResponseWriter, r *http.Request, user, id string) {
	var in struct {
		Pass string `json:"pass"`
	}
	if err := readJSON(w, r, &in); err != nil {
		sendBodyError(w, r, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	v, err := s.mail.SetPassword(ctx, user, id, in.Pass)
	s.mailAccountAnswer(w, r, user, v, err)
}

// mailChange: set, restore, forget and labels on some messages of one account.
func (s *Server) mailChange(w http.ResponseWriter, r *http.Request, user, acct string, prov MailProvider, what string) {
	var in struct {
		Refs    []string `json:"refs"`
		Mids    []string `json:"mids"`
		Seen    *bool    `json:"seen"`
		Flagged *bool    `json:"flagged"`
		Tray    string   `json:"tray"`
		Add     []string `json:"add"`
		Remove  []string `json:"remove"`
	}
	if err := readJSON(w, r, &in); err != nil {
		sendBodyError(w, r, err)
		return
	}
	if len(in.Refs)+len(in.Mids) > 1000 {
		sendError(w, r, http.StatusBadRequest, "too many messages at once")
		return
	}
	var refs []MailRef
	for _, x := range in.Refs {
		ref, ok := parseMailRef(x)
		if !ok {
			sendError(w, r, http.StatusBadRequest, "bad message ref")
			return
		}
		refs = append(refs, ref)
	}
	ctx := r.Context()
	fail := func(err error) { s.mailFail(w, r, user, acct, err) }
	// a partial refusal is an answer, not a failure: what was done is done
	partial := func(err error) (map[string]bool, bool) {
		failed := mailFailed(err)
		if err != nil && failed == nil {
			fail(err)
			return nil, false
		}
		return failed, true
	}
	failedList := func(failed map[string]bool) []string {
		out := []string{}
		for ref := range failed {
			out = append(out, ref)
		}
		return out
	}

	switch what {
	case "set":
		ch := MailChange{Seen: in.Seen, Flagged: in.Flagged}
		if in.Tray != "" {
			role, ok := validRole(in.Tray)
			if !ok {
				sendError(w, r, http.StatusBadRequest, "no such tray")
				return
			}
			ch.Move = role
		}
		var rows []MailSummary
		if ch.Move != "" { // who they are, for the Trash's clock and the labels
			var err error
			if rows, err = prov.Summaries(ctx, refs); err != nil {
				fail(err)
				return
			}
		}
		moved, err := prov.Set(ctx, refs, ch)
		failed, ok := partial(err)
		if !ok {
			return
		}
		rows = mailDone(rows, failed)
		if ch.Move == RoleTrash {
			s.mail.noteTrashed(user, acct, rows)
		} else if ch.Move != "" {
			var out []MailSummary
			for _, row := range rows {
				if ref, _ := parseMailRef(row.Ref); ref.Role == RoleTrash {
					out = append(out, row)
				}
			}
			if len(out) > 0 {
				s.mail.forget(user, acct, out, false)
			}
		}
		if ch.Seen != nil {
			var done []MailRef
			for _, ref := range refs {
				if !failed[ref.String()] {
					done = append(done, ref)
				}
			}
			s.mail.noteSeen(user, acct, done, *ch.Seen)
		}
		s.mail.moveTags(user, acct, rows, moved)
		s.mail.Refresh(user, acct)
		sendJSON(w, r, http.StatusOK, map[string]any{"moved": refStrings(moved), "failed": failedList(failed)})

	case "restore":
		var rows []MailSummary
		if len(in.Mids) > 0 { // an Undo: the refs in the Trash may not be known
			// One Message-ID asked n times (a mail to yourself deleted from
			// the Inbox and from Sent): its n newest copies in the Trash -
			// each ref once. Find alone gave the newest twice, counted two
			// restored for one, and the other copy was purged later
			// (data-safety I9, mail-chat #12).
			asked, order := map[string]int{}, []string{}
			for _, mid := range in.Mids {
				if asked[mid]++; asked[mid] == 1 {
					order = append(order, mid)
				}
			}
			all, _ := prov.(mailFinderAll)
			taken := map[string]bool{}
			for _, mid := range order {
				var hits []MailSummary
				if all != nil {
					hits, _ = all.FindAll(ctx, mid, RoleTrash)
				} else if row, err := prov.Find(ctx, mid, []MailRole{RoleTrash}); err == nil {
					hits = []MailSummary{row}
				}
				for _, row := range hits[:min(asked[mid], len(hits))] {
					if !taken[row.Ref] {
						taken[row.Ref] = true
						rows = append(rows, row)
					}
				}
			}
		} else {
			var err error
			if rows, err = prov.Summaries(ctx, refs); err != nil {
				fail(err)
				return
			}
		}
		groups := map[MailRole][]MailRef{}
		var back []MailSummary
		for _, row := range rows {
			ref, ok := parseMailRef(row.Ref)
			if !ok || ref.Role != RoleTrash {
				continue
			}
			to := s.mail.trashFrom(user, acct, row.MessageID)
			groups[to] = append(groups[to], ref)
			back = append(back, row)
		}
		moved := map[string]MailRef{}
		failed := map[string]bool{}
		for to, group := range groups {
			m, err := prov.Set(ctx, group, MailChange{Move: to})
			f, ok := partial(err)
			if !ok {
				return
			}
			for k := range f {
				failed[k] = true
			}
			for k, v := range m {
				moved[k] = v
			}
		}
		back = mailDone(back, failed)
		s.mail.forget(user, acct, back, false)
		s.mail.moveTags(user, acct, back, moved)
		s.mail.Refresh(user, acct)
		sendJSON(w, r, http.StatusOK, map[string]any{"moved": refStrings(moved), "restored": len(back), "failed": failedList(failed)})

	case "forget":
		for _, ref := range refs {
			if ref.Role != RoleTrash {
				sendError(w, r, http.StatusBadRequest, "only what is in the Trash can be deleted for good")
				return
			}
		}
		rows, err := prov.Summaries(ctx, refs)
		if err != nil {
			fail(err)
			return
		}
		failed, ok := partial(prov.Expunge(ctx, refs))
		if !ok {
			return
		}
		rows = mailDone(rows, failed)
		s.mail.forget(user, acct, rows, true)
		sendJSON(w, r, http.StatusOK, map[string]any{"deleted": len(rows), "failed": failedList(failed)})

	case "labels":
		rows, err := prov.Summaries(ctx, refs)
		if err != nil {
			fail(err)
			return
		}
		if err := s.mail.Tag(user, acct, rows, in.Add, in.Remove); err != nil {
			if errors.Is(err, errMailLabelNone) {
				sendError(w, r, http.StatusBadRequest, "no such label")
				return
			}
			s.mailSaveFail(w, r, user, "labels", err)
			return
		}
		// a ref the server no longer knows (a label's stale row): its tag,
		// found by the Message-ID the app sent beside it
		found := map[string]bool{}
		for _, row := range rows {
			found[row.Ref] = true
		}
		var lost []string
		for i, ref := range in.Refs {
			if !found[ref] && i < len(in.Mids) && in.Mids[i] != "" {
				lost = append(lost, in.Mids[i])
			}
		}
		known := map[string][]string{}
		if len(lost) > 0 {
			if known, err = s.mail.TagKnown(user, acct, lost, in.Add, in.Remove); err != nil {
				s.mailSaveFail(w, r, user, "labels", err)
				return
			}
		}
		s.mail.annotate(user, acct, rows)
		sendJSON(w, r, http.StatusOK, map[string]any{"items": rows, "known": known})
	}
}

func refStrings(m map[string]MailRef) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v.String()
	}
	return out
}

// mailUserRoute: labels, a label's messages, the settings.
func (s *Server) mailUserRoute(w http.ResponseWriter, r *http.Request, user string, rest []string) {
	labelErr := func(err error) {
		switch {
		case errors.Is(err, errMailLabelDup):
			sendJSON(w, r, http.StatusConflict, map[string]string{"error": "ya hay una etiqueta con ese nombre", "code": "dup"})
		case errors.Is(err, errMailLabelBad):
			sendJSON(w, r, http.StatusBadRequest, map[string]string{"error": "falta el nombre", "code": "bad"})
		case errors.Is(err, errMailLabelMany):
			sendJSON(w, r, http.StatusBadRequest, map[string]string{"error": "demasiadas etiquetas", "code": "many"})
		case errors.Is(err, errMailLabelNone):
			sendError(w, r, http.StatusNotFound, "no such label")
		default:
			s.mailSaveFail(w, r, user, "labels", err)
		}
	}
	var in struct {
		Name       *string `json:"name"`
		Color      *string `json:"color"`
		TrashDays  int     `json:"trashDays"`
		ShowImages *bool   `json:"showImages"`
		Signature  *string `json:"signature"`
	}
	body := func() bool {
		if err := readJSON(w, r, &in); err != nil {
			sendBodyError(w, r, err)
			return false
		}
		return true
	}
	switch {
	case len(rest) == 1 && rest[0] == "labels" && r.Method == http.MethodGet:
		sendJSON(w, r, http.StatusOK, map[string]any{"labels": s.mail.Labels(user), "colors": mailLabelColors})

	case len(rest) == 1 && rest[0] == "labels" && r.Method == http.MethodPost:
		if !body() {
			return
		}
		name, color := "", ""
		if in.Name != nil {
			name = *in.Name
		}
		if in.Color != nil {
			color = *in.Color
		}
		l, err := s.mail.AddLabel(user, name, color)
		if err != nil {
			labelErr(err)
			return
		}
		sendJSON(w, r, http.StatusOK, l)

	case len(rest) == 2 && rest[0] == "labels" && r.Method == http.MethodPatch:
		if !body() {
			return
		}
		l, err := s.mail.EditLabel(user, rest[1], in.Name, in.Color)
		if err != nil {
			labelErr(err)
			return
		}
		sendJSON(w, r, http.StatusOK, l)

	case len(rest) == 2 && rest[0] == "labels" && r.Method == http.MethodDelete:
		found, err := s.mail.DeleteLabel(user, rest[1])
		switch {
		case err != nil:
			labelErr(err)
		case !found:
			sendError(w, r, http.StatusNotFound, "no such label")
		default:
			sendJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
		}

	case len(rest) == 2 && rest[0] == "label" && r.Method == http.MethodGet:
		sendJSON(w, r, http.StatusOK, map[string]any{"items": s.mail.LabelRows(user, rest[1])})

	case len(rest) == 1 && rest[0] == "settings" && r.Method == http.MethodGet:
		sendJSON(w, r, http.StatusOK, s.mail.Settings(user))

	case len(rest) == 1 && rest[0] == "settings" && r.Method == http.MethodPut:
		if !body() {
			return
		}
		// what is left out stays as it was - merged under the hub's lock: two
		// devices saving two settings at once each keep theirs (I10)
		st, err := s.mail.PatchSettings(user, func(st *MailSettings) {
			if in.TrashDays != 0 {
				st.TrashDays = in.TrashDays
			}
			if in.ShowImages != nil {
				st.ShowImages = *in.ShowImages
			}
			if in.Signature != nil {
				st.Signature = *in.Signature
			}
		})
		if err != nil {
			s.mailSaveFail(w, r, user, "settings", err)
			return
		}
		sendJSON(w, r, http.StatusOK, st)

	default:
		sendError(w, r, http.StatusNotFound, "no such endpoint")
	}
}

// mailIDOK: a Message-ID to put in a header - "left@right", nothing that
// could break the header, and never Nayive's made-up "h:" names.
func mailIDOK(id string) bool {
	if id == "" || len(id) > 250 || strings.HasPrefix(id, "h:") || !strings.Contains(id, "@") {
		return false
	}
	return !strings.ContainsAny(id, " \t\r\n<>\"(),;:\\[]")
}

// mailWrite sends a message, or saves it as a draft.
func (s *Server) mailWrite(w http.ResponseWriter, r *http.Request, user, acct string, prov MailProvider, draft bool) {
	a := s.mail.account(user, acct)
	if a == nil {
		sendError(w, r, http.StatusNotFound, "no such account")
		return
	}
	code := func(status int, code, msg string) {
		sendJSON(w, r, status, map[string]string{"error": msg, "code": code})
	}
	r.Body = http.MaxBytesReader(w, r.Body, mailMaxAttach+(4<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			code(http.StatusRequestEntityTooLarge, "big", "los adjuntos pasan de 25 MB")
			return
		}
		sendError(w, r, http.StatusBadRequest, "bad form")
		return
	}
	defer r.MultipartForm.RemoveAll()
	var in MailOut
	if err := json.Unmarshal([]byte(r.FormValue("json")), &in); err != nil {
		sendError(w, r, http.StatusBadRequest, "bad json")
		return
	}
	ctx := r.Context()

	// the attachments, in this order: kept parts, Drive files, uploads
	var files []mailOutFile
	total := 0
	add := func(f mailOutFile) bool {
		total += len(f.Data)
		files = append(files, f)
		return total <= mailMaxAttach
	}
	draftMID := strings.Trim(in.MID, "<> ")
	kept := make([]*mailOutFile, len(in.Keep))
	var lost []int // kept parts whose draft is gone: found again below
	read := 0
	for i, k := range in.Keep {
		from := prov
		if k.Acct != "" && k.Acct != acct {
			if from = s.mail.provider(user, k.Acct); from == nil {
				sendError(w, r, http.StatusNotFound, "no such account")
				return
			}
		}
		ref, ok := parseMailRef(k.Ref)
		if !ok {
			sendError(w, r, http.StatusBadRequest, "bad message ref")
			return
		}
		part, data, err := from.Attachment(ctx, ref, k.Part)
		if errors.Is(err, errMailGone) && ref.Role == RoleDrafts && mailIDOK(draftMID) && k.Name != "" && k.Size > 0 {
			lost = append(lost, i)
			continue
		}
		if err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		kept[i] = &mailOutFile{Name: part.Name, Type: part.Type, Data: data}
		if read += len(data); read > mailMaxAttach {
			code(http.StatusRequestEntityTooLarge, "big", "los adjuntos pasan de 25 MB")
			return
		}
	}
	if len(lost) > 0 {
		if err := s.mailKeptAgain(ctx, user, acct, draftMID, in.Keep, lost, kept); err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
	}
	for _, f := range kept {
		if !add(*f) {
			code(http.StatusRequestEntityTooLarge, "big", "los adjuntos pasan de 25 MB")
			return
		}
	}
	for _, p := range in.Drive {
		if !strings.HasPrefix(p, "files/") && !strings.HasPrefix(p, "shared/") {
			sendError(w, r, http.StatusForbidden, "only files from Drive")
			return
		}
		res, ok := s.users.Resolve("user", user, p)
		if !ok {
			sendError(w, r, http.StatusNotFound, "no such file")
			return
		}
		f, err := res.Open()
		if err != nil {
			sendError(w, r, http.StatusNotFound, "no such file")
			return
		}
		data, err := io.ReadAll(io.LimitReader(f, mailMaxAttach+1))
		f.Close()
		if err != nil {
			sendError(w, r, http.StatusInternalServerError, "could not read the file")
			return
		}
		if !add(mailOutFile{Name: lastSegment(p), Data: data}) {
			code(http.StatusRequestEntityTooLarge, "big", "los adjuntos pasan de 25 MB")
			return
		}
	}
	if r.MultipartForm != nil {
		for _, fh := range r.MultipartForm.File["file"] {
			f, err := fh.Open()
			if err != nil {
				sendError(w, r, http.StatusBadRequest, "bad upload")
				return
			}
			data, err := io.ReadAll(f)
			f.Close()
			if err != nil {
				sendError(w, r, http.StatusBadRequest, "bad upload")
				return
			}
			if !add(mailOutFile{Name: fh.Filename, Type: fh.Header.Get("Content-Type"), Data: data}) {
				code(http.StatusRequestEntityTooLarge, "big", "los adjuntos pasan de 25 MB")
				return
			}
		}
	}

	// Message-IDs: a draft keeps its own across saves; the mail SENT gets a
	// new one (Gmail joins messages by Message-ID: the sent mail must never
	// be taken for the draft deleted after it). A made-up "h:" name (a mail
	// that had none) or anything that is not an id never goes out.
	mid := strings.Trim(in.MID, "<> ")
	if !draft || !mailIDOK(mid) {
		mid = newMailID(a.Email)
	}
	if in.InReplyTo = strings.Trim(in.InReplyTo, "<> "); !mailIDOK(in.InReplyTo) {
		in.InReplyTo = ""
	}
	var thread []string
	for _, ref := range in.References {
		if ref = strings.Trim(ref, "<> "); mailIDOK(ref) {
			thread = append(thread, ref)
		}
	}
	in.References = thread
	from := &netmail.Address{Name: a.Name, Address: a.Email}
	raw, rcpts, err := buildMail(from, in, files, mid, draft)
	if err != nil {
		if errors.Is(err, errMailBadAddr) || strings.Contains(err.Error(), "mail:") {
			code(http.StatusBadRequest, "addr", "hay una dirección que no es válida")
			return
		}
		s.log.Error("mail: building a message", "user", user, "err", err)
		sendError(w, r, http.StatusInternalServerError, "no se pudo preparar el mensaje")
		return
	}
	var old *MailRef
	if ref, ok := parseMailRef(in.DraftRef); ok && ref.Role == RoleDrafts {
		old = &ref
	}

	if draft {
		ref, parts, err := prov.SaveDraft(ctx, raw, mid, old)
		if errors.Is(err, errMailLeftover) { // saved; the old one stayed - an orphan, not a failure
			s.log.Warn("mail: draft saved, but the old one stayed", "user", user, "account", acct)
			err = nil
		}
		if err != nil {
			s.mailFail(w, r, user, acct, err)
			return
		}
		if parts == nil {
			parts = mailDraftParts(files)
		}
		sendJSON(w, r, http.StatusOK, map[string]any{"ref": ref.String(), "mid": mid, "parts": parts})
		return
	}

	if len(rcpts) == 0 {
		code(http.StatusBadRequest, "norcpt", "falta a quién enviarlo")
		return
	}
	var to []string
	for _, a := range rcpts {
		to = append(to, a.Address)
	}
	// the copy kept in Sent keeps the Bcc (only the sender sees it)
	copy := raw
	if strings.TrimSpace(in.Bcc) != "" {
		if c, _, err := buildMail(from, in, files, mid, true); err == nil {
			copy = c
		}
	}
	// One draft goes once: its Message-ID (the writer's own, the same in
	// every save) is held while it is being sent and for a while after. An
	// answer lost on the way brings the writer back "not sent"; Send again
	// then would send it twice (data-safety I6, mail-chat #13).
	guard := mailIDOK(draftMID)
	if guard && !s.mail.claimSend(user, acct, draftMID) {
		code(http.StatusConflict, "sent", "ese correo ya se envió hace un momento")
		return
	}
	held := guard // let go on every way out (a panic too) unless noted as sent
	defer func() {
		if held {
			s.mail.sendUndo(user, acct, draftMID)
		}
	}()
	sent := func() {
		if held {
			s.mail.sendDone(user, acct, draftMID)
			held = false
		}
	}
	noCopy := false
	if err := prov.Send(ctx, raw, copy, a.Email, to); err != nil {
		switch {
		case errors.Is(err, errMailNoCopy):
			noCopy = true
		case errors.Is(err, errMailUnsure): // it may have gone: held as sent, and its draft stays
			sent()
			s.log.Warn("mail: sent or not - no answer once it was handed over; its draft stays", "user", user, "account", acct, "err", err)
			s.mailFail(w, r, user, acct, err)
			return
		default: // not sent: let go (above)
			s.mailFail(w, r, user, acct, err)
			return
		}
	}
	sent()
	if noCopy {
		// The copy in Sent failed (a full mailbox, no Sent folder): its
		// draft is then the ONLY copy of what was written - it stays, and
		// the app says so (data-safety I5, mail-chat #5)
		s.log.Warn("mail: sent, but no copy in Sent - its draft stays", "user", user, "account", acct)
	} else if old != nil {
		// it has gone: the draft goes too, even if the app leaves now (a
		// draft left behind invites a second send)
		after, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		if err := prov.Expunge(after, []MailRef{*old}); err != nil {
			s.log.Warn("mail: sent, but its draft stayed", "user", user, "account", acct, "err", err)
		}
		cancel()
	}
	s.log.Info("mail: sent", "user", user, "account", acct, "to", len(to), "files", len(files))
	out := map[string]any{"ok": true, "mid": mid}
	if noCopy {
		out["noCopy"] = true
	}
	sendJSON(w, r, http.StatusOK, out)
}

// mailKeptAgain finds the kept files whose draft is gone (lost: their places
// in keep) in the NEWEST draft with this writer's Message-ID, into kept.
// Another device saved this draft again meanwhile, so the draft these files
// were kept from was replaced: every save and Send of this writer answered
// "gone" for good - its words could never reach the server again (data-safety
// I1, mail-chat #2). A file comes back only when that draft holds one under
// the same name and of the same size - its length in bytes, or the size the
// server lists for it (IMAP's is an estimate from the encoded length: what a
// writer holds after opening a draft) - exactly as many of them as this
// writer misses, each fitting one of its files only. Never another file of
// the same name of another size (the other device may have put its own
// "image.png" in place of ours); otherwise still "gone" (and the app mends it
// by itself, saying which file to add again). Only names and sizes are
// compared: two different files of one name and one size would pass.
func (s *Server) mailKeptAgain(ctx context.Context, user, acct, mid string, keep []mailKeepRef, lost []int, kept []*mailOutFile) error {
	byAcct := map[string][]int{}
	for _, i := range lost {
		a := keep[i].Acct
		if a == "" {
			a = acct
		}
		byAcct[a] = append(byAcct[a], i)
	}
	for a, idx := range byAcct {
		from := s.mail.provider(user, a)
		if from == nil {
			return errMailGone
		}
		row, err := from.Find(ctx, mid, []MailRole{RoleDrafts})
		if err != nil {
			return err
		}
		ref, ok := parseMailRef(row.Ref)
		if !ok {
			return errMailGone
		}
		msg, err := from.Message(ctx, ref)
		if err != nil {
			return err
		}
		names := map[string]bool{}
		for _, i := range idx {
			names[keep[i].Name] = true
		}
		type cand struct {
			file     *mailOutFile
			bytes    int64 // its real length
			listed   int64 // the size the server lists for it
			assigned bool
		}
		var cands []*cand
		for _, p := range msg.Parts {
			if p.Inline || !names[p.Name] {
				continue
			}
			part, data, err := from.Attachment(ctx, ref, p.ID)
			if err != nil {
				return err
			}
			cands = append(cands, &cand{file: &mailOutFile{Name: p.Name, Type: part.Type, Data: data},
				bytes: int64(len(data)), listed: p.Size})
		}
		// the writer's missing files by name and size, in their order
		groups, order := map[string][]int{}, []string{}
		for _, i := range idx {
			k := keep[i].Name + "\x00" + strconv.FormatInt(keep[i].Size, 10)
			if groups[k] == nil {
				order = append(order, k)
			}
			groups[k] = append(groups[k], i)
		}
		for _, k := range order {
			want := keep[groups[k][0]]
			var fit []*cand
			for _, c := range cands {
				if c.file.Name == want.Name && (c.bytes == want.Size || c.listed == want.Size) {
					fit = append(fit, c)
				}
			}
			if len(fit) != len(groups[k]) { // none, or not one for one: never a guess
				return errMailGone
			}
			for j, c := range fit {
				if c.assigned { // it fits two of the writer's files: no guess either
					return errMailGone
				}
				c.assigned = true
				kept[groups[k][j]] = c.file
			}
		}
	}
	return nil
}
