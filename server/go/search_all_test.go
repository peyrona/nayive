package main

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The launcher's search: contacts by any field (a phone by its digits),
// events by title / place / notes with the next start of a series, chats
// that hide what the owner's Chat hides; filters that a kind cannot test
// leave it out.
func TestSearchAll(t *testing.T) {
	srv, ts, client := newTestServer(t)
	data := filepath.Join(srv.cfg.HomesDir, "ana", "data")
	os.MkdirAll(filepath.Join(data, "chat", "conv", "d-p1"), 0o755)
	os.MkdirAll(filepath.Join(data, "chat", "conv", "d-p2"), 0o755)

	os.WriteFile(filepath.Join(data, "contacts.vcf"), []byte(strings.Join([]string{
		"BEGIN:VCARD", "VERSION:3.0", "UID:c1", "FN:José Müller", "TEL;TYPE=CELL:+34 669 81 65 18",
		"EMAIL:jose@x.es", "ORG:Acme;Ventas", "END:VCARD",
		"BEGIN:VCARD", "VERSION:3.0", "UID:c2", "FN:Ana Pérez", "NOTE:vecina del quinto", "END:VCARD",
		""}, "\r\n")), 0o644)

	now := time.Now()
	soon := now.Add(48 * time.Hour).UTC().Format("20060102T150405Z")
	past := now.AddDate(0, -2, 0).UTC().Format("20060102T150405Z")
	ev := func(uid, title, start, extra string) string {
		return "BEGIN:VEVENT\r\nUID:" + uid + "\r\nSUMMARY:" + title + "\r\nDTSTART" + start + "\r\n" + extra + "END:VEVENT\r\n"
	}
	os.WriteFile(filepath.Join(data, "calendar.ics"), []byte("BEGIN:VCALENDAR\r\n"+
		ev("e1", "Dentista", ":"+soon, "LOCATION:Calle Mayor 3\r\n")+
		ev("e2", "Cena", ":"+past, "DESCRIPTION:con José\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n")+
		ev("e3", "Gimnasio", ":"+past, "RRULE:FREQ=WEEKLY\r\n")+
		ev("e4", "Cumpleaños Ana", ";VALUE=DATE:20270514", "")+
		ev("e5", "Santo de Pepe", ";VALUE=DATE:19900319", "RRULE:FREQ=YEARLY\r\n")+
		"END:VCALENDAR\r\n"), 0o644)

	os.WriteFile(filepath.Join(data, "chat", "chat.json"), []byte(`{"me":{"name":"Ana"},
		"contacts":[{"id":"p1","name":"Pepe","created":1},{"id":"p2","name":"Luisa","created":1}],"groups":[]}`), 0o644)
	ms := func(d int) int64 { return now.AddDate(0, 0, d).UnixMilli() }
	month := func(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01") + ".json" }
	write := func(conv string, at int64, body string) {
		os.WriteFile(filepath.Join(data, "chat", "conv", conv, month(at)), []byte(body), 0o644)
	}
	long := strings.Repeat("palabra ", 60) + "factura del gas"
	write("d-p1", ms(0), `{"messages":[
		{"id":1,"rev":1,"at":`+itoa64(ms(0)-3000)+`,"from":"p1","kind":"text","text":"la factura de la luz"},
		{"id":2,"rev":2,"at":`+itoa64(ms(0)-2000)+`,"from":"o","kind":"text","text":"factura borrada","deleted":true},
		{"id":3,"rev":3,"at":`+itoa64(ms(0)-1000)+`,"from":"o","kind":"text","text":"`+long+`"}]}`)
	write("d-p2", ms(0), `{"messages":[{"id":1,"rev":1,"at":`+itoa64(ms(0))+`,"from":"p2","kind":"text","text":"factura vieja"}]}`)
	os.WriteFile(filepath.Join(data, "chat", "conv", "d-p2", "state.json"), []byte(`{"rev":1,"next":2,"read":{},"cleared":{"o":1}}`), 0o644)

	signIn(t, client, ts.URL, "ana", "abc")
	type answer struct {
		Contacts []ContactHit   `json:"contacts"`
		Events   []EventHit     `json:"events"`
		Chats    []ChatHit      `json:"chats"`
		More     map[string]any `json:"more"`
	}
	ask := func(q string) answer {
		var a answer
		jsonCall(t, client, "GET", ts.URL+"/api/search?"+q, "", http.StatusOK, &a)
		return a
	}
	has := func(text string) string { return "name=" + url.QueryEscape("has:"+text) }

	if a := ask(has("mueller")); len(a.Contacts) != 1 || a.Contacts[0].UID != "c1" || a.Contacts[0].Tel == "" {
		t.Errorf("umlaut spelt out: %+v", a.Contacts)
	}
	if a := ask(has("669816")); len(a.Contacts) != 1 || a.Contacts[0].Org != "Acme Ventas" {
		t.Errorf("phone digits: %+v", a.Contacts)
	}
	if a := ask(has("vecina") + "&" + "name=" + url.QueryEscape("not:perez")); len(a.Contacts) != 0 {
		t.Errorf("not: %+v", a.Contacts)
	}
	if a := ask(has("jose")); len(a.Contacts) != 1 || len(a.Events) != 1 || a.Events[0].UID != "e2" {
		t.Errorf("one word, two kinds: %+v %+v", a.Contacts, a.Events)
	}
	if a := ask(has("reminder")); len(a.Events) != 0 {
		t.Errorf("an alarm's text is not the event's: %+v", a.Events)
	}
	if a := ask(has("mayor")); len(a.Events) != 1 || a.Events[0].Where != "Calle Mayor 3" || a.Events[0].At == 0 {
		t.Errorf("by place: %+v", a.Events)
	}
	if a := ask(has("gimnasio")); len(a.Events) != 1 || !a.Events[0].Rep || a.Events[0].At < now.Unix() {
		t.Errorf("a series shows its next start: %+v", a.Events)
	}
	if a := ask(has("cumpleanos")); len(a.Events) != 1 || a.Events[0].Day != "2027-05-14" || a.Events[0].At != 0 {
		t.Errorf("all-day: %+v", a.Events)
	}
	// an all-day yearly series: its next day, not 1990
	nextSanto := time.Date(now.Year(), 3, 19, 0, 0, 0, 0, time.Local)
	if nextSanto.Before(now.Add(-24 * time.Hour)) {
		nextSanto = nextSanto.AddDate(1, 0, 0)
	}
	if a := ask(has("santo")); len(a.Events) != 1 || !a.Events[0].Rep || a.Events[0].Day != nextSanto.Format("2006-01-02") || a.Events[0].At != 0 {
		t.Errorf("all-day series: %+v, want %s", a.Events, nextSanto.Format("2006-01-02"))
	}
	// coming first, soonest first; then past, latest first
	if a := ask("in=events&name=" + url.QueryEscape("not:santo")); len(a.Events) != 4 || a.Events[2].UID != "e4" || a.Events[len(a.Events)-1].UID != "e2" {
		t.Errorf("order: %+v", a.Events)
	}

	// chats: no deleted message, nothing up to a chat's Cleared mark; the
	// long one shows the words found
	a := ask(has("factura"))
	if len(a.Chats) != 2 || a.Chats[0].ID != 3 || a.Chats[1].Text != "la factura de la luz" || a.Chats[1].Name != "Pepe" {
		t.Fatalf("chats: %+v", a.Chats)
	}
	if !strings.Contains(a.Chats[0].Text, "factura del gas") || !strings.HasPrefix(a.Chats[0].Text, "…") {
		t.Errorf("snippet: %q", a.Chats[0].Text)
	}
	// from: chats only (contacts and events left out)
	a = ask(has("factura") + "&from=pepe")
	if len(a.Chats) != 1 || a.Chats[0].From != "Pepe" || a.Contacts != nil || a.Events != nil {
		t.Errorf("from: %+v", a)
	}
	// a date: no contacts
	a = ask(has("factura") + "&since=" + itoa64(now.Add(-1500*time.Millisecond).Unix()))
	if a.Contacts != nil || len(a.Chats) != 1 {
		t.Errorf("since: %+v", a)
	}
	if a := ask(has("factura") + "&limit=1"); len(a.Chats) != 1 || a.More["chats"] != true {
		t.Errorf("limit: %+v", a)
	}
	if code, _ := callJSON(t, client, "GET", ts.URL+"/api/search?name=bad:x", ""); code != http.StatusBadRequest {
		t.Errorf("bad rule = %d", code)
	}
}
