package main

// A small JMAP server for the tests: the session (capabilities and limits),
// Mailbox/get, Email/query (inMailbox, text, notKeyword, header - a text
// search, as the RFC says - after, AND; position or anchor), Email/get
// (bodies by RFC 8621's textBody/htmlBody/attachments algorithm, cut values),
// Email/set (keywords, mailboxIds whole or patched, destroy - and refusals),
// Email/import, Identity/get, EmailSubmission/set (onSuccessDestroyEmail),
// blob upload and download, back-references, the "using" rules, 429/503/404
// on demand. Bearer auth with `token`, or Basic with `user`/`pass`.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-message"
	gomail "github.com/emersion/go-message/mail"
)

type fakeEmail struct {
	id       string
	raw      []byte
	boxes    map[string]bool
	keywords map[string]bool
	received time.Time
}

type fakeSubmission struct {
	identity, emailID, from, account string
	rcpts                            []string
}

type fakeBox struct{ id, role string }

type fakeJMAP struct {
	t                 *testing.T
	token, user, pass string
	mu                sync.Mutex
	emails            map[string]*fakeEmail
	blobs             map[string][]byte
	n                 int
	subs              []fakeSubmission
	srv               *httptest.Server

	// what the server is like (tests change them before use)
	boxes                    []fakeBox
	maxGet, maxSet, maxCalls int  // 0: no limit
	noSub                    bool // no "submission" capability
	subAccount               string
	identities               []map[string]any
	bodyCap                  int // cut body values longer than this (0: maxBodyValueBytes)

	// what it does wrong, on demand
	refuseUpdate  map[string]string // email id -> SetError type
	refuseDestroy map[string]string
	importErr     string // Email/import answers notCreated with this type
	subErr        string // EmailSubmission/set answers notCreated with this type
	failGets      int    // the next n Email/get answer serverFail
	fail503       int    // the next n API requests answer 503 (Retry-After: 0)
	fail429       int    // the same, 429
	fail404       int    // the next n API requests answer 404
	uploadAnswer  []byte // the upload's answer instead of the blob's

	// what it saw
	sessionHits int
	usings      [][]string
	accounts    map[string]string // method -> accountId
}

var fakeBoxes = []fakeBox{
	{"mb-inbox", "inbox"}, {"mb-drafts", "drafts"}, {"mb-sent", "sent"}, {"mb-junk", "junk"}, {"mb-trash", "trash"}, {"mb-work", ""},
}

func newFakeJMAP(t *testing.T) *fakeJMAP {
	f := &fakeJMAP{t: t, token: "tok-123", user: "ana@fast.test", pass: "secreto",
		emails: map[string]*fakeEmail{}, blobs: map[string][]byte{},
		boxes: append([]fakeBox{}, fakeBoxes...), subAccount: "acc1",
		identities: []map[string]any{
			{"id": "id1", "email": "ana@fast.test", "name": "Ana"},
			{"id": "id2", "email": "*@fast.test", "name": "Fast"},
		},
		refuseUpdate: map[string]string{}, refuseDestroy: map[string]string{}, accounts: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeJMAP) newID(prefix string) string {
	f.n++
	return fmt.Sprintf("%s%d", prefix, f.n)
}

// add puts a raw message in a mailbox, as delivered mail.
func (f *fakeJMAP) add(raw string, box string, seen bool) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.newID("M")
	kw := map[string]bool{}
	if seen {
		kw["$seen"] = true
	}
	f.emails[id] = &fakeEmail{id: id, raw: []byte(strings.ReplaceAll(raw, "\n", "\r\n")), boxes: map[string]bool{box: true},
		keywords: kw, received: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(f.n) * time.Minute)}
	return id
}

func (f *fakeJMAP) authed(r *http.Request) bool {
	if r.Header.Get("Authorization") == "Bearer "+f.token {
		return true
	}
	u, p, ok := r.BasicAuth()
	return ok && u == f.user && p == f.pass
}

func (f *fakeJMAP) problem(w http.ResponseWriter, typ, detail string) {
	w.WriteHeader(http.StatusBadRequest)
	json.NewEncoder(w).Encode(map[string]any{"type": "urn:ietf:params:jmap:error:" + typ, "status": 400, "detail": detail})
}

func (f *fakeJMAP) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/.well-known/jmap" { // as the RFC says: to the session
		http.Redirect(w, r, "/jmap/session", http.StatusFound)
		return
	}
	if !f.authed(r) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch {
	case r.URL.Path == "/jmap/session":
		f.mu.Lock()
		f.sessionHits++
		core := map[string]any{"maxSizeUpload": 50 << 20}
		if f.maxGet > 0 {
			core["maxObjectsInGet"] = f.maxGet
		}
		if f.maxSet > 0 {
			core["maxObjectsInSet"] = f.maxSet
		}
		if f.maxCalls > 0 {
			core["maxCallsInRequest"] = f.maxCalls
		}
		caps := map[string]any{jmapCore: core, jmapMail: map[string]any{}}
		primary := map[string]string{jmapMail: "acc1"}
		if !f.noSub {
			caps[jmapSubmission] = map[string]any{}
			primary[jmapSubmission] = f.subAccount
		}
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{
			"apiUrl": "/jmap/api", "uploadUrl": "/jmap/upload/{accountId}/",
			"downloadUrl":     "/jmap/download/{accountId}/{blobId}/{name}?type={type}",
			"primaryAccounts": primary, "capabilities": caps,
		})
	case strings.HasPrefix(r.URL.Path, "/jmap/upload/acc1/"):
		raw, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		id := f.newID("B")
		f.blobs[id] = raw
		answer := f.uploadAnswer
		f.mu.Unlock()
		if answer != nil {
			w.Write(answer)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"blobId": id, "size": len(raw)})
	case strings.HasPrefix(r.URL.Path, "/jmap/download/acc1/"):
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/jmap/download/acc1/"), "/")
		f.mu.Lock()
		b, ok := f.blobs[parts[0]]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write(b)
	case r.URL.Path == "/jmap/api":
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case f.fail503 > 0:
			f.fail503--
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		case f.fail429 > 0:
			f.fail429--
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		case f.fail404 > 0:
			f.fail404--
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var req struct {
			Using       []string            `json:"using"`
			MethodCalls [][]json.RawMessage `json:"methodCalls"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		f.usings = append(f.usings, req.Using)
		if f.maxCalls > 0 && len(req.MethodCalls) > f.maxCalls {
			f.problem(w, "limit", "maxCallsInRequest")
			return
		}
		sub := contains(req.Using, jmapSubmission)
		if sub && f.noSub {
			f.problem(w, "unknownCapability", jmapSubmission)
			return
		}
		results := map[string]map[string]any{}
		var out [][]any
		for _, c := range req.MethodCalls {
			var name, id string
			var args map[string]any
			json.Unmarshal(c[0], &name)
			json.Unmarshal(c[1], &args)
			json.Unmarshal(c[2], &id)
			for k, v := range args { // back-references: "#ids" -> the ids of an earlier result
				if strings.HasPrefix(k, "#") {
					ref := v.(map[string]any)
					res, ok := results[ref["resultOf"].(string)]
					if !ok || res["__error"] != nil {
						args["__error"] = "invalidResultReference"
						continue
					}
					args[k[1:]] = res["ids"]
					delete(args, k)
				}
			}
			if a, ok := args["accountId"].(string); ok {
				f.accounts[name] = a
			}
			var res map[string]any
			switch {
			case args["__error"] != nil:
				res = map[string]any{"__error": args["__error"]}
			case jmapSends(name) && !sub:
				res = map[string]any{"__error": "unknownMethod"}
			default:
				res = f.method(name, args)
			}
			results[id] = res
			if e, bad := res["__error"]; bad {
				out = append(out, []any{"error", map[string]any{"type": e}, id})
			} else {
				out = append(out, []any{name, res, id})
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"methodResponses": out})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func strList(v any) []string {
	var out []string
	if l, ok := v.([]any); ok {
		for _, x := range l {
			out = append(out, fmt.Sprint(x))
		}
	}
	if l, ok := v.([]string); ok {
		out = l
	}
	return out
}

// fakeNode is one MIME entity, read whole.
type fakeNode struct {
	ctype, disp, name, cid string
	body                   []byte
	kids                   []*fakeNode
}

func fakeRead(e *message.Entity) *fakeNode {
	n := &fakeNode{}
	n.ctype, _, _ = e.Header.ContentType()
	n.ctype = strings.ToLower(n.ctype)
	if n.ctype == "" {
		n.ctype = "text/plain"
	}
	disp, dp, _ := e.Header.ContentDisposition()
	n.disp = strings.ToLower(disp)
	_, cp, _ := e.Header.ContentType()
	n.name = dp["filename"]
	if n.name == "" {
		n.name = cp["name"]
	}
	if n.name != "" {
		if d, err := (&mime.WordDecoder{}).DecodeHeader(n.name); err == nil {
			n.name = d
		}
	}
	n.cid = strings.Trim(e.Header.Get("Content-Id"), "<>")
	if mr := e.MultipartReader(); mr != nil {
		for {
			part, err := mr.NextPart()
			if err != nil {
				break
			}
			n.kids = append(n.kids, fakeRead(part))
		}
		return n
	}
	n.body, _ = io.ReadAll(e.Body)
	return n
}

// parsed is what Email/get needs out of a raw message.
type fakeParsed struct {
	h                  gomail.Header
	text               string // the first plain value (the preview, the search)
	textBody, htmlBody []map[string]any
	attachments        []map[string]any
	values             map[string]string
	e                  *fakeEmail
	f                  *fakeJMAP
	n                  int
	partOf             map[*fakeNode]map[string]any
}

func fakeMedia(t string) bool {
	return strings.HasPrefix(t, "image/") || strings.HasPrefix(t, "audio/") || strings.HasPrefix(t, "video/")
}

// part is a leaf as a JMAP EmailBodyPart (once per leaf).
func (p *fakeParsed) part(n *fakeNode) map[string]any {
	if m, ok := p.partOf[n]; ok {
		return m
	}
	p.n++
	id := fmt.Sprint(p.n)
	blob := fmt.Sprintf("%s-p%d", p.e.id, p.n)
	p.f.blobs[blob] = n.body
	m := map[string]any{"partId": id, "blobId": blob, "type": n.ctype, "size": len(n.body), "cid": n.cid, "disposition": n.disp}
	if n.cid == "" {
		m["cid"] = nil
	}
	if n.name != "" {
		m["name"] = n.name
	}
	if strings.HasPrefix(n.ctype, "text/") {
		p.values[id] = string(n.body)
		if n.ctype == "text/plain" && p.text == "" {
			p.text = string(n.body)
		}
	}
	p.partOf[n] = m
	return m
}

// structure is RFC 8621 4.1.4's parseStructure, word for word.
func (p *fakeParsed) structure(parts []*fakeNode, multipartType string, inAlternative bool,
	htmlBody, textBody, attachments *[]map[string]any) {
	textLength, htmlLength := -1, -1
	if textBody != nil {
		textLength = len(*textBody)
	}
	if htmlBody != nil {
		htmlLength = len(*htmlBody)
	}
	for i, part := range parts {
		isMultipart := strings.HasPrefix(part.ctype, "multipart/")
		isInline := part.disp != "attachment" &&
			(part.ctype == "text/plain" || part.ctype == "text/html" || fakeMedia(part.ctype)) &&
			(i == 0 || (multipartType != "related" && (fakeMedia(part.ctype) || part.name == "")))
		switch {
		case isMultipart:
			sub := strings.TrimPrefix(part.ctype, "multipart/")
			p.structure(part.kids, sub, inAlternative || sub == "alternative", htmlBody, textBody, attachments)
		case isInline:
			if multipartType == "alternative" {
				switch part.ctype {
				case "text/plain":
					*textBody = append(*textBody, p.part(part))
				case "text/html":
					*htmlBody = append(*htmlBody, p.part(part))
				default:
					*attachments = append(*attachments, p.part(part))
				}
				continue
			} else if inAlternative {
				if part.ctype == "text/plain" {
					htmlBody = nil
				}
				if part.ctype == "text/html" {
					textBody = nil
				}
			}
			if textBody != nil {
				*textBody = append(*textBody, p.part(part))
			}
			if htmlBody != nil {
				*htmlBody = append(*htmlBody, p.part(part))
			}
			if (textBody == nil || htmlBody == nil) && fakeMedia(part.ctype) {
				*attachments = append(*attachments, p.part(part))
			}
		default:
			*attachments = append(*attachments, p.part(part))
		}
	}
	if multipartType == "alternative" && textBody != nil && htmlBody != nil {
		if textLength == len(*textBody) && htmlLength != len(*htmlBody) {
			*textBody = append(*textBody, (*htmlBody)[htmlLength:]...)
		}
		if htmlLength == len(*htmlBody) && textLength != len(*textBody) {
			*htmlBody = append(*htmlBody, (*textBody)[textLength:]...)
		}
	}
}

func (f *fakeJMAP) parse(e *fakeEmail) fakeParsed {
	p := fakeParsed{e: e, f: f, values: map[string]string{}, partOf: map[*fakeNode]map[string]any{},
		textBody: []map[string]any{}, htmlBody: []map[string]any{}, attachments: []map[string]any{}}
	ent, err := message.Read(bytes.NewReader(e.raw))
	if ent == nil {
		f.t.Logf("fake jmap: %v", err)
		return p
	}
	p.h = gomail.Header{Header: ent.Header}
	root := fakeRead(ent)
	p.structure([]*fakeNode{root}, "mixed", false, &p.htmlBody, &p.textBody, &p.attachments)
	return p
}

func jmapAddrList(h gomail.Header, key string) []map[string]string {
	out := []map[string]string{}
	list, _ := h.AddressList(key)
	for _, a := range list {
		out = append(out, map[string]string{"name": a.Name, "email": a.Address})
	}
	return out
}

func (f *fakeJMAP) emailJSON(e *fakeEmail, values bool, capBytes int) map[string]any {
	p := f.parse(e)
	subject, _ := p.h.Subject()
	mid, _ := p.h.MessageID()
	refs, _ := p.h.MsgIDList("References")
	preview := strings.Join(strings.Fields(p.text), " ")
	if len(preview) > 100 {
		preview = preview[:100]
	}
	m := map[string]any{
		"id": e.id, "mailboxIds": e.boxes, "keywords": e.keywords, "size": len(e.raw),
		"receivedAt": e.received.Format(time.RFC3339), "messageId": []string{mid}, "references": refs,
		"from": jmapAddrList(p.h, "From"), "to": jmapAddrList(p.h, "To"), "cc": jmapAddrList(p.h, "Cc"),
		"bcc": jmapAddrList(p.h, "Bcc"), "replyTo": jmapAddrList(p.h, "Reply-To"), "subject": subject,
		"preview": preview, "hasAttachment": len(p.attachments) > 0, "attachments": p.attachments,
		"textBody": p.textBody, "htmlBody": p.htmlBody, "bodyValues": map[string]any{},
	}
	if mid == "" {
		m["messageId"] = nil
	}
	if values {
		bv := map[string]any{}
		for id, v := range p.values {
			cut := false
			if capBytes > 0 && len(v) > capBytes {
				v, cut = v[:capBytes], true
			}
			bv[id] = map[string]any{"value": v, "isTruncated": cut}
		}
		m["bodyValues"] = bv
	}
	return m
}

func (f *fakeJMAP) match(e *fakeEmail, filter map[string]any) bool {
	if filter == nil {
		return true
	}
	if op, ok := filter["operator"]; ok && op == "AND" {
		for _, c := range filter["conditions"].([]any) {
			if !f.match(e, c.(map[string]any)) {
				return false
			}
		}
		return true
	}
	if box, ok := filter["inMailbox"].(string); ok && !e.boxes[box] {
		return false
	}
	if kw, ok := filter["notKeyword"].(string); ok && e.keywords[kw] {
		return false
	}
	if after, ok := filter["after"].(string); ok {
		t, err := time.Parse(time.RFC3339, after)
		if err != nil || !e.received.After(t) {
			return false
		}
	}
	if text, ok := filter["text"].(string); ok {
		p := f.parse(e)
		subject, _ := p.h.Subject()
		if !strings.Contains(strings.ToLower(subject+" "+p.text), strings.ToLower(text)) {
			return false
		}
	}
	if hv := strList(filter["header"]); len(hv) == 2 {
		// "the text to look for in the header field value" (RFC 8621 4.4.1):
		// a search, so "<12@x>" is found inside "<412@x>" too
		p := f.parse(e)
		mid, _ := p.h.MessageID()
		if !strings.EqualFold(hv[0], "Message-ID") || !strings.Contains("<"+mid+">", strings.Trim(hv[1], "<>")) {
			return false
		}
	}
	return true
}

func (f *fakeJMAP) method(name string, args map[string]any) map[string]any {
	switch name {
	case "Mailbox/get":
		var list []map[string]any
		for _, b := range f.boxes {
			total, unread := 0, 0
			for _, e := range f.emails {
				if e.boxes[b.id] {
					total++
					if !e.keywords["$seen"] {
						unread++
					}
				}
			}
			m := map[string]any{"id": b.id, "totalEmails": total, "unreadEmails": unread}
			if b.role != "" {
				m["role"] = b.role
			} else {
				m["role"] = nil
			}
			list = append(list, m)
		}
		return map[string]any{"list": list}

	case "Email/query":
		filter, _ := args["filter"].(map[string]any)
		var hits []*fakeEmail
		for _, e := range f.emails {
			if f.match(e, filter) {
				hits = append(hits, e)
			}
		}
		sort.Slice(hits, func(i, j int) bool { return hits[i].received.After(hits[j].received) })
		pos, limit := 0, len(hits)
		if v, ok := args["position"].(float64); ok {
			pos = int(v)
		}
		if a, ok := args["anchor"].(string); ok {
			at := -1
			for i, e := range hits {
				if e.id == a {
					at = i
				}
			}
			if at < 0 {
				return map[string]any{"__error": "anchorNotFound"}
			}
			off, _ := args["anchorOffset"].(float64)
			pos = max(at+int(off), 0)
		}
		if v, ok := args["limit"].(float64); ok && int(v) < limit {
			limit = int(v)
		}
		ids := []string{}
		for i := pos; i < len(hits) && len(ids) < limit; i++ {
			ids = append(ids, hits[i].id)
		}
		return map[string]any{"ids": ids, "total": len(hits), "position": pos}

	case "Email/get":
		ids := strList(args["ids"])
		if f.maxGet > 0 && len(ids) > f.maxGet {
			return map[string]any{"__error": "requestTooLarge"}
		}
		if f.failGets > 0 {
			f.failGets--
			return map[string]any{"__error": "serverFail"}
		}
		values, _ := args["fetchTextBodyValues"].(bool)
		capBytes := 0
		if v, ok := args["maxBodyValueBytes"].(float64); ok {
			capBytes = int(v)
		}
		if f.bodyCap > 0 {
			capBytes = f.bodyCap
		}
		list, notFound := []any{}, []string{}
		for _, id := range ids {
			if e := f.emails[id]; e != nil {
				list = append(list, f.emailJSON(e, values, capBytes))
			} else {
				notFound = append(notFound, id)
			}
		}
		return map[string]any{"list": list, "notFound": notFound}

	case "Email/set":
		upd, _ := args["update"].(map[string]any)
		destroy := strList(args["destroy"])
		if f.maxSet > 0 && len(upd)+len(destroy) > f.maxSet {
			return map[string]any{"__error": "requestTooLarge"}
		}
		updated, notUpdated := map[string]any{}, map[string]any{}
		for id, patch := range upd {
			e := f.emails[id]
			if e == nil {
				notUpdated[id] = map[string]any{"type": "notFound"}
				continue
			}
			if typ := f.refuseUpdate[id]; typ != "" {
				notUpdated[id] = map[string]any{"type": typ, "description": "refused by the test"}
				continue
			}
			for k, v := range patch.(map[string]any) {
				switch {
				case strings.HasPrefix(k, "keywords/"):
					if v == nil {
						delete(e.keywords, k[len("keywords/"):])
					} else {
						e.keywords[k[len("keywords/"):]] = true
					}
				case strings.HasPrefix(k, "mailboxIds/"):
					if v == nil {
						delete(e.boxes, k[len("mailboxIds/"):])
					} else {
						e.boxes[k[len("mailboxIds/"):]] = true
					}
				case k == "mailboxIds":
					e.boxes = map[string]bool{}
					for b := range v.(map[string]any) {
						e.boxes[b] = true
					}
				}
			}
			updated[id] = nil
		}
		destroyed, notDestroyed := []string{}, map[string]any{}
		for _, id := range destroy {
			switch {
			case f.emails[id] == nil:
				notDestroyed[id] = map[string]any{"type": "notFound"}
			case f.refuseDestroy[id] != "":
				notDestroyed[id] = map[string]any{"type": f.refuseDestroy[id]}
			default:
				delete(f.emails, id)
				destroyed = append(destroyed, id)
			}
		}
		return map[string]any{"updated": updated, "destroyed": destroyed, "notUpdated": notUpdated, "notDestroyed": notDestroyed}

	case "Email/import":
		created, notCreated := map[string]any{}, map[string]any{}
		for k, v := range args["emails"].(map[string]any) {
			if f.importErr != "" {
				notCreated[k] = map[string]any{"type": f.importErr}
				continue
			}
			spec := v.(map[string]any)
			raw := f.blobs[spec["blobId"].(string)]
			id := f.newID("M")
			e := &fakeEmail{id: id, raw: raw, boxes: map[string]bool{}, keywords: map[string]bool{}, received: time.Now()}
			for b := range spec["mailboxIds"].(map[string]any) {
				e.boxes[b] = true
			}
			if kw, ok := spec["keywords"].(map[string]any); ok {
				for k := range kw {
					e.keywords[k] = true
				}
			}
			f.emails[id] = e
			created[k] = map[string]any{"id": id, "blobId": spec["blobId"]}
		}
		return map[string]any{"created": created, "notCreated": notCreated}

	case "Identity/get":
		list := []any{}
		for _, i := range f.identities {
			list = append(list, i)
		}
		return map[string]any{"list": list}

	case "EmailSubmission/set":
		created, notCreated := map[string]any{}, map[string]any{}
		for k, v := range args["create"].(map[string]any) {
			if f.subErr != "" {
				notCreated[k] = map[string]any{"type": f.subErr, "invalidRecipients": []string{"nobody@nowhere.test"}}
				continue
			}
			spec := v.(map[string]any)
			env := spec["envelope"].(map[string]any)
			var rcpts []string
			for _, r := range env["rcptTo"].([]any) {
				rcpts = append(rcpts, r.(map[string]any)["email"].(string))
			}
			acc, _ := args["accountId"].(string)
			f.subs = append(f.subs, fakeSubmission{identity: spec["identityId"].(string), emailID: spec["emailId"].(string),
				from: env["mailFrom"].(map[string]any)["email"].(string), rcpts: rcpts, account: acc})
			created[k] = map[string]any{"id": f.newID("S")}
			for _, ref := range strList(args["onSuccessDestroyEmail"]) {
				if ref == "#"+k {
					delete(f.emails, spec["emailId"].(string))
				}
			}
		}
		return map[string]any{"created": created, "notCreated": notCreated}
	}
	return map[string]any{"__error": "unknownMethod"}
}

// rawOf is a message's raw bytes, for checks.
func (f *fakeJMAP) rawOf(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.emails[id]; e != nil {
		return string(e.raw)
	}
	return ""
}
