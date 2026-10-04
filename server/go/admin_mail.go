// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// eMail and the admin panel: a user renamed or deleted (L1).
// =============================================================================
//
// The mail hub keeps every user's accounts in memory, passwords open, keyed
// by the user's NAME (MailHub.owners), and its poller and nightly purge walk
// that map. An admin rename or delete that leaves it alone keeps the old
// person's mail running under the old name: the purge re-creates
// homes/<old>/data/mail (a ghost home) and keeps expunging their Trash, and a
// NEW account given that name later opens the old person's mailboxes.
//
// So the panel tells the hub, here:
//
//   - delete-user: the user's connections close, and the name answers as GONE
//     (a tombstone, below) - before the home is removed.
//   - rename-user: the name answers as gone while the folder moves; then the
//     accounts answer under the new name, and the old one stays gone.
//   - create-user: a new person has the name - the tombstone goes, and their
//     mail is read from their own (empty) home.
//
// THE TOMBSTONE is a mailUser with no accounts whose four files are all
// marked damaged (errMailUserGone). The hub already never writes a file that
// is marked so (writeMailFile), and the purge skips a user whose trash or
// settings are (purgeAccount): a poll, purge or request that was already
// under way for the old name - it took the name before the admin acted -
// finds nothing it can write, and nothing it may expunge.

import "errors"

// errMailUserGone marks every file of a tombstone. A plain error, never an
// *fs.PathError: a read error is tried again (retryDamagedLocked), this never.
var errMailUserGone = errors.New("mail: the admin deleted or renamed this user")

// mailUserFiles are the files a tombstone marks: every one writeMailFile writes.
var mailUserFiles = []string{"accounts.json", "labels.json", "trash.json", "settings.json"}

// mailTombstone is what a deleted or renamed-away name answers with. Its maps
// are made: a request under way writes into them before it tries to save.
func mailTombstone() *mailUser {
	u := &mailUser{
		labels:  mailLabelsFile{Labels: []MailLabel{}, Tags: map[string]*mailTag{}},
		trash:   map[string]mailTrashEntry{},
		damaged: map[string]error{},
	}
	for _, f := range mailUserFiles {
		u.damaged[f] = errMailUserGone
	}
	return u
}

func isMailTombstone(u *mailUser) bool {
	return u != nil && errors.Is(u.damaged["accounts.json"], errMailUserGone)
}

// DropUser: the admin deletes `name`. Called BEFORE the home is removed, so
// nothing of the hub writes there in between. Their connections close.
func (h *MailHub) DropUser(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if u := h.owners[name]; u != nil {
		for _, a := range u.accts {
			go a.prov.Close()
		}
	}
	h.owners[name] = mailTombstone()
}

// BeginRename: the admin is about to rename `old`. Until finish is called the
// name answers as gone, so nothing is written under it while the folder moves.
// finish(newName) - the rename is done: the accounts, connections and all,
// answer under newName (read from its files when the hub held none); `old`
// stays gone. finish("") - it failed: all is as it was.
func (h *MailHub) BeginRename(old string) (finish func(name string)) {
	h.mu.Lock()
	held, had := h.owners[old]
	h.owners[old] = mailTombstone()
	h.mu.Unlock()

	return func(name string) {
		h.mu.Lock()
		defer h.mu.Unlock()
		if name == "" {
			if had {
				h.owners[old] = held
			} else {
				delete(h.owners, old)
			}
			return
		}
		// What the hub held under the new name is stale: a tombstone, or an
		// empty read of a home that was not there.
		if u := h.owners[name]; u != nil {
			for _, a := range u.accts {
				go a.prov.Close()
			}
		}
		if had && !isMailTombstone(held) {
			h.owners[name] = held
		} else {
			delete(h.owners, name)
		}
	}
}

// NameReused: the admin created a new account called `name`. Whatever the hub
// held under it - a tombstone, or a deleted person's accounts - goes; their
// mail is read from their own home when first asked.
func (h *MailHub) NameReused(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if u := h.owners[name]; u != nil {
		for _, a := range u.accts {
			go a.prov.Close()
		}
	}
	delete(h.owners, name)
}
