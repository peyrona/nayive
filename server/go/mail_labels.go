package main

// =============================================================================
// eMail: what Nayive keeps about mail itself - labels, the Trash's clock and
// the settings. Provider-independent: the same for IMAP today, JMAP tomorrow.
// =============================================================================
//
// FILES, beside accounts.json in homes/<user>/data/mail/ (0600, the server's
// alone - isServerData keeps Drive out):
//
//	labels.json    {"labels": [{id,name,color}], "tags": {"<acct>|<message-id>": tag}}
//	trash.json     {"<acct>|<message-id>": {"at", "from"}}
//	settings.json  {"trashDays": 30}
//
// A MESSAGE is known by its Message-ID header: it stays the same when the
// message moves between trays, where the provider's own address (the ref)
// does not. The few without one get a made-up "h:" name from their sender,
// date and subject (mailHashID). A tag also keeps a copy of the row (who,
// subject, date, read or not) and where the message was last seen, so a
// label's list shows at once, with no call to the mail server; opening one
// that moved finds it again by its Message-ID (api_mail.go), and one that is
// nowhere any more (deleted on the phone, Gmail's own Trash emptied) loses
// its tag. A Message-ID is not always unique: a mail to yourself sits in the
// Inbox AND in Sent. So the tag keeps one ref per tray (Refs) - each list
// notes its own copy, no flip-flop - and deleting one copy for good drops
// only that ref; the labels go with the last one.
//
// THE TRASH. Deleting moves a message to the account's own Trash folder;
// trash.json says when, and from which tray (so "Restore" puts it back
// there). What reaches the Trash some other way (deleted on the phone) gets
// the time the purge first sees it. The purge (RunPurge) deletes for good
// whatever has been there longer than the user's trashDays. Gmail empties its
// Trash after 30 days by itself, whatever this says.

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	mailTrashDaysDefault = 30
	mailPurgeEvery       = 6 * time.Hour
	mailMaxLabels        = 100
)

// mailLabelColors: the eight a label can have (the app cycles through them).
// The 3rd was amber (#f9a825) until 2026-09-26: too close to the orange next
// to it; labels saved with it are moved to the yellow when read.
var mailLabelColors = []string{"#e53935", "#fb8c00", "#fdd835", "#43a047", "#00897b", "#1e88e5", "#8e24aa", "#6d4c41"}

var mailLabelColorsOld = map[string]string{"#f9a825": "#fdd835"}

var (
	errMailLabelDup  = errors.New("mail: a label with that name already exists")
	errMailLabelBad  = errors.New("mail: a label needs a name (up to 40 characters)")
	errMailLabelNone = errors.New("mail: no such label")
	errMailLabelMany = errors.New("mail: too many labels")
)

type MailLabel struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type mailTag struct {
	Labels  []string            `json:"labels"`
	Ref     string              `json:"ref"`            // the copy a label's list opens
	Refs    map[MailRole]string `json:"refs,omitempty"` // every copy seen, one per tray
	From    []MailAddr          `json:"from,omitempty"`
	To      []MailAddr          `json:"to,omitempty"`
	Subject string              `json:"subject,omitempty"`
	Date    time.Time           `json:"date"`
	Unread  bool                `json:"unread,omitempty"` // as last seen
}

func refRole(ref string) MailRole {
	r, _ := parseMailRef(ref)
	return r.Role
}

// see notes a copy of the message at `ref` (read or not); true when the tag
// changed. The copy to open moves only within its own tray, so two copies in
// two trays never take turns.
func (t *mailTag) see(ref string, seen bool) bool {
	role, dirty := refRole(ref), false
	if role == "" {
		return false
	}
	if t.Refs == nil {
		t.Refs = map[MailRole]string{}
	}
	if t.Refs[role] != ref {
		t.Refs[role], dirty = ref, true
	}
	if t.Ref == "" || refRole(t.Ref) == role {
		if t.Ref != ref {
			t.Ref, dirty = ref, true
		}
		if t.Unread != !seen {
			t.Unread, dirty = !seen, true
		}
	}
	return dirty
}

// drop forgets the copy at `ref` (deleted for good); true when no copy is
// left, so the tag itself can go.
func (t *mailTag) drop(ref string) bool {
	if role := refRole(ref); t.Refs[role] == ref {
		delete(t.Refs, role)
	}
	if t.Ref == ref {
		t.Ref = ""
		for _, r := range mailRoles {
			if x := t.Refs[r]; x != "" {
				t.Ref = x
				break
			}
		}
	}
	return t.Ref == "" && len(t.Refs) == 0
}

type mailLabelsFile struct {
	Labels []MailLabel         `json:"labels"`
	Tags   map[string]*mailTag `json:"tags"`
}

type mailTrashEntry struct {
	At   time.Time `json:"at"`
	From MailRole  `json:"from,omitempty"`
}

type MailSettings struct {
	TrashDays  int  `json:"trashDays"`
	ShowImages bool `json:"showImages"` // pictures from the internet shown at once (the sender may learn it was opened)
}

func mailKey(acct, mid string) string { return acct + "|" + mid }

// mailHashID names a message that has no Message-ID.
func mailHashID(s MailSummary) string {
	from := ""
	if len(s.From) > 0 {
		from = s.From[0].Addr
	}
	sum := sha1.Sum([]byte(from + "\x00" + strconv.FormatInt(s.Date.Unix(), 10) + "\x00" + s.Subject))
	return "h:" + hex.EncodeToString(sum[:10])
}

// -----------------------------------------------------------------------------
// the files
// -----------------------------------------------------------------------------

// writeMailFile writes one of the user's mail files, 0600, atomically.
func (h *MailHub) writeMailFile(user, name string, v any) error {
	dir := h.dir(user)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(v, "", "    ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, fmt.Sprintf("%s.%d.%d.tmp", name, os.Getpid(), tmpCounter.Add(1)))
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// loadExtrasLocked reads labels, trash and settings into a fresh mailUser.
func (h *MailHub) loadExtrasLocked(name string, u *mailUser) {
	loadJSONFile(filepath.Join(h.dir(name), "labels.json"), &u.labels)
	if u.labels.Tags == nil {
		u.labels.Tags = map[string]*mailTag{}
	}
	if u.labels.Labels == nil {
		u.labels.Labels = []MailLabel{}
	}
	for i, l := range u.labels.Labels {
		if c, old := mailLabelColorsOld[l.Color]; old {
			u.labels.Labels[i].Color = c
		}
	}
	u.trash = map[string]mailTrashEntry{}
	loadJSONFile(filepath.Join(h.dir(name), "trash.json"), &u.trash)
	u.settings = MailSettings{TrashDays: mailTrashDaysDefault}
	loadJSONFile(filepath.Join(h.dir(name), "settings.json"), &u.settings)
	u.settings.TrashDays = clampTrashDays(u.settings.TrashDays)
}

func clampTrashDays(n int) int {
	if n < 1 {
		return mailTrashDaysDefault
	}
	if n > 365 {
		return 365
	}
	return n
}

func (h *MailHub) saveLabelsLocked(user string, u *mailUser) error {
	return h.writeMailFile(user, "labels.json", u.labels)
}

func (h *MailHub) saveTrashLocked(user string, u *mailUser) error {
	return h.writeMailFile(user, "trash.json", u.trash)
}

// -----------------------------------------------------------------------------
// labels
// -----------------------------------------------------------------------------

func (h *MailHub) Labels(user string) []MailLabel {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]MailLabel{}, h.userLocked(user).labels.Labels...)
}

func cleanLabelName(name string) (string, bool) {
	name = strings.Join(strings.Fields(name), " ")
	return name, name != "" && utf8.RuneCountInString(name) <= 40
}

func (h *MailHub) AddLabel(user, name, color string) (MailLabel, error) {
	name, ok := cleanLabelName(name)
	if !ok {
		return MailLabel{}, errMailLabelBad
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	if len(u.labels.Labels) >= mailMaxLabels {
		return MailLabel{}, errMailLabelMany
	}
	max := 0
	for _, l := range u.labels.Labels {
		if strings.EqualFold(l.Name, name) {
			return MailLabel{}, errMailLabelDup
		}
		if k, _ := strconv.Atoi(strings.TrimPrefix(l.ID, "l")); k > max {
			max = k
		}
	}
	if !contains(mailLabelColors, color) {
		color = mailLabelColors[len(u.labels.Labels)%len(mailLabelColors)]
	}
	l := MailLabel{ID: "l" + strconv.Itoa(max+1), Name: name, Color: color}
	u.labels.Labels = append(u.labels.Labels, l)
	if err := h.saveLabelsLocked(user, u); err != nil {
		u.labels.Labels = u.labels.Labels[:len(u.labels.Labels)-1]
		return MailLabel{}, err
	}
	return l, nil
}

func (h *MailHub) EditLabel(user, id string, name, color *string) (MailLabel, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	i := -1
	for k, l := range u.labels.Labels {
		if l.ID == id {
			i = k
		}
	}
	if i < 0 {
		return MailLabel{}, errMailLabelNone
	}
	l := u.labels.Labels[i]
	if name != nil {
		n, ok := cleanLabelName(*name)
		if !ok {
			return MailLabel{}, errMailLabelBad
		}
		for _, o := range u.labels.Labels {
			if o.ID != id && strings.EqualFold(o.Name, n) {
				return MailLabel{}, errMailLabelDup
			}
		}
		l.Name = n
	}
	if color != nil && contains(mailLabelColors, *color) {
		l.Color = *color
	}
	before := u.labels.Labels[i]
	u.labels.Labels[i] = l
	if err := h.saveLabelsLocked(user, u); err != nil {
		u.labels.Labels[i] = before
		return MailLabel{}, err
	}
	return l, nil
}

// DeleteLabel removes a label from the list and from every message.
func (h *MailHub) DeleteLabel(user, id string) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	i := -1
	for k, l := range u.labels.Labels {
		if l.ID == id {
			i = k
		}
	}
	if i < 0 {
		return false, nil
	}
	beforeLabels := u.labels.Labels
	beforeTags := map[string][]string{} // key -> its labels before, to undo a failed save
	u.labels.Labels = append(u.labels.Labels[:i:i], u.labels.Labels[i+1:]...)
	gone := map[string]*mailTag{}
	for key, t := range u.labels.Tags {
		if !contains(t.Labels, id) {
			continue
		}
		beforeTags[key] = append([]string{}, t.Labels...)
		t.Labels = removeString(append([]string{}, t.Labels...), id)
		if len(t.Labels) == 0 {
			gone[key] = t
			delete(u.labels.Tags, key)
		}
	}
	if err := h.saveLabelsLocked(user, u); err != nil {
		u.labels.Labels = beforeLabels
		for key, t := range gone {
			u.labels.Tags[key] = t
		}
		for key, labels := range beforeTags {
			u.labels.Tags[key].Labels = labels
		}
		return true, err
	}
	return true, nil
}

func removeString(list []string, s string) []string {
	out := list[:0]
	for _, x := range list {
		if x != s {
			out = append(out, x)
		}
	}
	return out
}

// Tag adds and removes labels on some messages of one account.
func (h *MailHub) Tag(user, acct string, rows []MailSummary, add, remove []string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	known := map[string]bool{}
	for _, l := range u.labels.Labels {
		known[l.ID] = true
	}
	for _, id := range add {
		if !known[id] {
			return errMailLabelNone
		}
	}
	for _, r := range rows {
		key := mailKey(acct, r.MessageID)
		t := u.labels.Tags[key]
		if t == nil {
			t = &mailTag{}
		}
		t.From, t.To, t.Subject, t.Date = r.From, r.To, r.Subject, r.Date
		t.see(r.Ref, r.Seen)
		for _, id := range add {
			if !contains(t.Labels, id) {
				t.Labels = append(t.Labels, id)
			}
		}
		for _, id := range remove {
			t.Labels = removeString(t.Labels, id)
		}
		if len(t.Labels) == 0 {
			delete(u.labels.Tags, key)
		} else {
			u.labels.Tags[key] = t
		}
	}
	return h.saveLabelsLocked(user, u)
}

// TagKnown adds and removes labels on messages known only by their
// Message-ID - rows of a label's list whose message moved since, so the
// mail server could not name them: the tag itself is changed. Answers each
// one's labels now (missing: no tag, nothing to change).
func (h *MailHub) TagKnown(user, acct string, mids []string, add, remove []string) (map[string][]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	for _, id := range add {
		known := false
		for _, l := range u.labels.Labels {
			known = known || l.ID == id
		}
		if !known {
			return nil, errMailLabelNone
		}
	}
	out := map[string][]string{}
	dirty := false
	for _, mid := range mids {
		key := mailKey(acct, mid)
		t := u.labels.Tags[key]
		if t == nil {
			continue
		}
		for _, id := range add {
			if !contains(t.Labels, id) {
				t.Labels, dirty = append(t.Labels, id), true
			}
		}
		for _, id := range remove {
			if contains(t.Labels, id) {
				t.Labels, dirty = removeString(t.Labels, id), true
			}
		}
		if len(t.Labels) == 0 {
			delete(u.labels.Tags, key)
		}
		out[mid] = append([]string{}, t.Labels...)
	}
	if !dirty {
		return out, nil
	}
	return out, h.saveLabelsLocked(user, u)
}

// DropTag forgets a message that is nowhere any more (a label's row that
// opened to "gone", and Find looked in every tray): its labels go.
func (h *MailHub) DropTag(user, acct, mid string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	key := mailKey(acct, mid)
	if u.labels.Tags[key] == nil {
		return
	}
	delete(u.labels.Tags, key)
	if err := h.saveLabelsLocked(user, u); err != nil {
		h.log.Warn("mail: saving labels", "user", user, "err", err)
	}
}

// noteSeen: messages were marked read or unread here; tags follow, so a
// label's list shows them right.
func (h *MailHub) noteSeen(user, acct string, refs []MailRef, seen bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	if len(u.labels.Tags) == 0 {
		return
	}
	want := map[string]bool{}
	for _, r := range refs {
		want[r.String()] = true
	}
	dirty := false
	for key, t := range u.labels.Tags {
		if strings.HasPrefix(key, acct+"|") && want[t.Ref] && t.Unread != !seen {
			t.Unread, dirty = !seen, true
		}
	}
	if dirty {
		if err := h.saveLabelsLocked(user, u); err != nil {
			h.log.Warn("mail: saving labels", "user", user, "err", err)
		}
	}
}

// annotate puts each row's labels on it and notes where tagged ones are now
// (a message moved on another device is found again for free).
func (h *MailHub) annotate(user, acct string, rows []MailSummary) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	if len(u.labels.Tags) == 0 {
		return
	}
	dirty := false
	for i := range rows {
		t := u.labels.Tags[mailKey(acct, rows[i].MessageID)]
		if t == nil {
			continue
		}
		rows[i].Labels = append([]string{}, t.Labels...)
		if t.see(rows[i].Ref, rows[i].Seen) {
			dirty = true
		}
	}
	if dirty {
		if err := h.saveLabelsLocked(user, u); err != nil {
			h.log.Warn("mail: saving labels", "user", user, "err", err)
		}
	}
}

// LabelRows is every message with a label, of every account, newest first,
// from labels.json alone.
func (h *MailHub) LabelRows(user, id string) []MailSummary {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	out := []MailSummary{}
	for key, t := range u.labels.Tags {
		if !contains(t.Labels, id) {
			continue
		}
		acct, mid, _ := strings.Cut(key, "|")
		if t.Ref == "" {
			continue
		}
		out = append(out, MailSummary{Ref: t.Ref, MessageID: mid, From: t.From, To: t.To, Subject: t.Subject,
			Date: t.Date, Seen: !t.Unread, Labels: append([]string{}, t.Labels...), Account: acct})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date.After(out[j].Date) })
	return out
}

// moveTag notes a tagged message's new place (a move this server made).
func (h *MailHub) moveTags(user, acct string, rows []MailSummary, moved map[string]MailRef) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	dirty := false
	for _, r := range rows {
		t := u.labels.Tags[mailKey(acct, r.MessageID)]
		if t == nil {
			continue
		}
		if to, ok := moved[r.Ref]; ok {
			t.drop(r.Ref)
			t.see(to.String(), r.Seen)
			dirty = true
		}
	}
	if dirty {
		if err := h.saveLabelsLocked(user, u); err != nil {
			h.log.Warn("mail: saving labels", "user", user, "err", err)
		}
	}
}

// -----------------------------------------------------------------------------
// the Trash
// -----------------------------------------------------------------------------

// noteTrashed: these rows are going to the Trash now, from where they are.
func (h *MailHub) noteTrashed(user, acct string, rows []MailSummary) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	now := time.Now().UTC().Truncate(time.Second)
	for _, r := range rows {
		ref, ok := parseMailRef(r.Ref)
		if !ok || ref.Role == RoleTrash {
			continue
		}
		u.trash[mailKey(acct, r.MessageID)] = mailTrashEntry{At: now, From: ref.Role}
	}
	if err := h.saveTrashLocked(user, u); err != nil {
		h.log.Warn("mail: saving trash.json", "user", user, "err", err)
	}
}

// trashFrom is where a message in the Trash came from (Inbox when unknown).
func (h *MailHub) trashFrom(user, acct, mid string) MailRole {
	h.mu.Lock()
	defer h.mu.Unlock()
	if e, ok := h.userLocked(user).trash[mailKey(acct, mid)]; ok && e.From != "" && e.From != RoleTrash {
		return e.From
	}
	return RoleInbox
}

// forget drops what Nayive knows of messages that left the Trash - restored
// (labels stay) or deleted for good (that copy's ref goes, and the labels
// with the last copy).
func (h *MailHub) forget(user, acct string, rows []MailSummary, labelsToo bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	tagsDirty := false
	for _, row := range rows {
		key := mailKey(acct, row.MessageID)
		delete(u.trash, key)
		if t := u.labels.Tags[key]; labelsToo && t != nil {
			if t.drop(row.Ref) {
				delete(u.labels.Tags, key)
			}
			tagsDirty = true
		}
	}
	if err := h.saveTrashLocked(user, u); err != nil {
		h.log.Warn("mail: saving trash.json", "user", user, "err", err)
	}
	if tagsDirty {
		if err := h.saveLabelsLocked(user, u); err != nil {
			h.log.Warn("mail: saving labels", "user", user, "err", err)
		}
	}
}

func (h *MailHub) Settings(user string) MailSettings {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.userLocked(user).settings
}

func (h *MailHub) SetSettings(user string, s MailSettings) (MailSettings, error) {
	s.TrashDays = clampTrashDays(s.TrashDays)
	h.mu.Lock()
	defer h.mu.Unlock()
	u := h.userLocked(user)
	before := u.settings
	u.settings = s
	if err := h.writeMailFile(user, "settings.json", s); err != nil {
		u.settings = before
		return before, err
	}
	return s, nil
}

// purgeAccount deletes for good what has been in one account's Trash longer
// than the user's days - or everything, for "Empty Trash" (all). It answers
// how many went.
func (h *MailHub) purgeAccount(ctx context.Context, user string, a *mailAcct, all bool) (int, error) {
	rows, err := a.prov.Scan(ctx, RoleTrash)
	if err != nil {
		return 0, err
	}
	h.mu.Lock()
	u := h.userLocked(user)
	days := u.settings.TrashDays
	now := time.Now().UTC().Truncate(time.Second)
	present := map[string]bool{}
	var doomed []MailRef
	var doomedRows []MailSummary
	for _, r := range rows {
		key := mailKey(a.ID, r.MessageID)
		present[key] = true
		e, ok := u.trash[key]
		if !ok {
			e = mailTrashEntry{At: now} // came in some other way: its clock starts now
			u.trash[key] = e
		}
		if all || now.Sub(e.At) >= time.Duration(days)*24*time.Hour {
			if ref, ok := parseMailRef(r.Ref); ok {
				doomed = append(doomed, ref)
				doomedRows = append(doomedRows, r)
			}
		}
	}
	for key := range u.trash { // left the Trash some other way
		if strings.HasPrefix(key, a.ID+"|") && !present[key] {
			delete(u.trash, key)
		}
	}
	if err := h.saveTrashLocked(user, u); err != nil {
		h.log.Warn("mail: saving trash.json", "user", user, "err", err)
	}
	h.mu.Unlock()

	if len(doomed) == 0 {
		return 0, nil
	}
	err = a.prov.Expunge(ctx, doomed)
	failed := mailFailed(err)
	if err != nil && failed == nil {
		return 0, err
	}
	done := mailDone(doomedRows, failed)
	h.forget(user, a.ID, done, true)
	return len(done), nil
}

// mailDone is the rows the provider did not name as refused.
func mailDone(rows []MailSummary, failed map[string]bool) []MailSummary {
	if failed == nil {
		return rows
	}
	var out []MailSummary
	for _, r := range rows {
		if !failed[r.Ref] {
			out = append(out, r)
		}
	}
	return out
}

// emptySpam deletes for good everything in one account's Spam ("Empty
// Spam"): no clock there, and the labels of what goes, go with it.
func (h *MailHub) emptySpam(ctx context.Context, user, acct string, prov MailProvider) (int, error) {
	rows, err := prov.Scan(ctx, RoleSpam)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	var refs []MailRef
	var doomed []MailSummary
	for _, r := range rows {
		if ref, ok := parseMailRef(r.Ref); ok {
			refs = append(refs, ref)
			doomed = append(doomed, r)
		}
	}
	err = prov.Expunge(ctx, refs)
	failed := mailFailed(err)
	if err != nil && failed == nil {
		return 0, err
	}
	done := mailDone(doomed, failed)
	h.forget(user, acct, done, true)
	return len(done), nil
}

// RunPurge empties every account's Trash of what is older than its owner's
// days: a first pass soon after start, then every mailPurgeEvery.
func (h *MailHub) RunPurge(ctx context.Context) {
	wait := 2 * time.Minute
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = mailPurgeEvery
		type job struct {
			user string
			a    *mailAcct
		}
		var jobs []job
		h.mu.Lock()
		for name, u := range h.owners {
			for _, a := range u.accts {
				if !errors.Is(a.err, errMailKey) { // no password until it is typed again
					jobs = append(jobs, job{name, a})
				}
			}
		}
		h.mu.Unlock()
		for _, j := range jobs {
			c, cancel := context.WithTimeout(ctx, 5*time.Minute)
			n, err := h.purgeAccount(c, j.user, j.a, false)
			cancel()
			if err != nil {
				h.log.Debug("mail: purge failed", "user", j.user, "account", j.a.ID, "err", err)
			} else if n > 0 {
				h.log.Info("mail: trash purged", "user", j.user, "account", j.a.ID, "deleted", n)
			}
		}
	}
}
