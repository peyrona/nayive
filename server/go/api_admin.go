// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// /api/admin - the admin panel: users and the admin credentials.
// =============================================================================
//
// ACCESS, and it is unusual:
//
//   - while NO admin account exists -> open to anyone (GET + action=setup), so
//     the very first admin can be created without a login;
//   - once it exists                -> an admin session is required.
//
// That is why this route is not behind requireSession like every other one.

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// adminRequest is the body of every POST /api/admin. One struct for all the
// actions, because the panel sends one shape per action and they overlap.
//
// java: the POINTER fields are the ones whose ABSENCE matters. "quota" absent
// means "leave the quota alone"; "quota": null means "remove it". A plain
// float64 could not tell those apart, and the panel relies on the difference.
type adminRequest struct {
	Action   string  `json:"action"`
	Name     string  `json:"name"`
	NewName  string  `json:"new_name"`
	Password *string `json:"password"`
	// java: RawMessage, not *float64, so a hand-typed `"quota": "abc"` is OUR
	// error to report rather than one that fails the whole request. With a
	// typed field the answer would be a flat "bad JSON" rather than "cuota no
	// válida" - and the panel shows that message to the person who typed it.
	Quota    json.RawMessage `json:"quota"`
	PhotoMax json.RawMessage `json:"photo_max"`

	// set-extstore
	Mount     string   `json:"mount"`
	AlwaysExt []string `json:"always_ext"`
	NeverExt  []string `json:"never_ext"`
	MinMB     *float64 `json:"min_mb"`

	// set-sites
	SitesDir string `json:"sites_dir"`

	// raw keeps the object as it arrived, so "was this key present at all?" can
	// still be asked - encoding/json cannot tell an absent key from a null one
	// for a non-pointer field, and cannot tell either from a pointer that was
	// explicitly null.
	raw map[string]json.RawMessage
}

func (a *adminRequest) has(key string) bool {
	_, found := a.raw[key]
	return found
}

func (s *Server) apiAdmin(w http.ResponseWriter, r *http.Request) {
	configured := s.cfg.AdminIsConfigured()
	sess, signedIn := s.session(r)
	isAdmin := signedIn && sess.Role == "admin"

	if configured && !isAdmin {
		status := http.StatusUnauthorized
		if signedIn {
			status = http.StatusForbidden
		}
		sendError(w, r, status, "solo el administrador")
		return
	}

	switch r.Method {
	case http.MethodGet:
		// Open without a login only on a fresh install, as setup is: a wiped
		// server.json must not hand every user's name, quota and usage to
		// whoever asks first.
		if !configured && len(s.users.ListUserNames()) > 0 {
			sendError(w, r, http.StatusConflict, adminLostMessage)
			return
		}
		var adminName, sitesDir string
		var ext *ExternalStorage
		s.cfg.Read(func(c *ServerConfig) {
			if c.Admin != nil {
				adminName = c.Admin.Name
			}
			ext = c.ExternalStorage
			sitesDir = c.SitesDir
		})
		// An UNSET block answers as {} - not as a fully-populated object with
		// empty fields. The panel tells the two apart: {} means "never
		// configured" and leaves its form untouched.
		//
		// java: `any` holds either shape, which is the honest way to say that
		// this field is a struct OR an empty object. A *ExternalStorage would
		// marshal nil as `null`, which is a third thing again.
		var extOut any = map[string]any{}
		if ext != nil {
			extOut = ext
		}
		sendJSON(w, r, http.StatusOK, map[string]any{
			"configured":       configured,
			"admin":            map[string]string{"name": adminName},
			"external_storage": extOut,
			"sites_dir":        sitesDir,
			"users":            s.users.ListUsers(),
		})
		return

	case http.MethodPost:
		// falls through to the action switch below

	default:
		sendError(w, r, http.StatusMethodNotAllowed, "use GET or POST")
		return
	}

	var body adminRequest
	if err := readJSONKeepingRaw(w, r, &body, &body.raw); err != nil {
		sendBodyError(w, r, err)
		return
	}

	switch body.Action {
	case "setup":
		s.adminSetup(w, r, &body, configured)
	case "set-admin":
		if s.needAdmin(w, r, isAdmin) {
			s.adminSetCredentials(w, r, &body)
		}
	case "set-extstore":
		if s.needAdmin(w, r, isAdmin) {
			s.adminSetExtStore(w, r, &body)
		}
	case "set-sites":
		if s.needAdmin(w, r, isAdmin) {
			s.adminSetSites(w, r, &body)
		}
	case "create-user", "update-user":
		if s.needAdmin(w, r, isAdmin) {
			s.adminSaveUser(w, r, &body)
		}
	case "rename-user":
		if s.needAdmin(w, r, isAdmin) {
			s.adminRenameUser(w, r, &body)
		}
	case "delete-user":
		if s.needAdmin(w, r, isAdmin) {
			s.adminDeleteUser(w, r, &body)
		}
	default:
		sendError(w, r, http.StatusBadRequest, "acción desconocida")
	}
}

// adminLostMessage answers the open, no-login panel on a server that has users
// but no admin account.
const adminLostMessage = "ya existen usuarios; restaura el administrador editando config/server.json"

// needAdmin gates everything except "setup".
func (s *Server) needAdmin(w http.ResponseWriter, r *http.Request, isAdmin bool) bool {
	if !isAdmin {
		sendError(w, r, http.StatusUnauthorized, "not signed in")
		return false
	}
	return true
}

// adminSetup creates the admin account on a fresh install - no session needed.
func (s *Server) adminSetup(w http.ResponseWriter, r *http.Request, body *adminRequest, configured bool) {
	if configured {
		sendError(w, r, http.StatusConflict, "el administrador ya existe")
		return
	}
	if len(s.users.ListUserNames()) > 0 {
		// Not a fresh install - regular users already exist. Refuse the open,
		// no-login setup so a wiped server.json cannot be used to seize the box;
		// the admin restores it by hand instead.
		sendError(w, r, http.StatusConflict, adminLostMessage)
		return
	}
	name := NormaliseUsername(body.Name)
	pw := derefString(body.Password)
	if name == "" || pw == "" {
		sendError(w, r, http.StatusBadRequest, "usuario y contraseña requeridos")
		return
	}
	if !ValidUsername(name) { // the same rule as every account's name
		sendError(w, r, http.StatusBadRequest, "nombre de usuario no válido")
		return
	}
	if err := s.cfg.Update(func(c *ServerConfig) {
		c.Admin = &AdminAccount{Name: name, Password: hashPassword(pw)}
	}); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar la configuración")
		return
	}

	token := s.sessions.Create(name, "admin", s.cfg.SessionTTL, false)
	w.Header().Set("Set-Cookie", sessionCookieHeader(token, s.cfg.SessionTTL, false, r.TLS != nil))
	s.log.Info("admin account created", "name", name)
	sendJSON(w, r, http.StatusOK,
		map[string]string{"message": "administrador creado", "name": name})
}

// adminSetCredentials changes the admin name and/or password.
func (s *Server) adminSetCredentials(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	name := NormaliseUsername(body.Name)
	if name == "" {
		sendError(w, r, http.StatusBadRequest, "usuario requerido")
		return
	}
	// Keeping the name it already has is never refused: admin.html sends
	// set-admin on every Save, and an older install's admin may have a name
	// today's rule refuses, or one a user has too - it must still be able to
	// change the password.
	if name != s.cfg.AdminName() {
		if !ValidUsername(name) {
			sendError(w, r, http.StatusBadRequest, "nombre de usuario no válido")
			return
		}
		// Never a regular user's name: sessions, chat and the rest go by name,
		// so dropping the admin's sessions would drop theirs too, and the other
		// way round. The mirror of adminSaveUser's "ese nombre es del
		// administrador".
		if _, err := os.Lstat(filepath.Join(s.cfg.HomesDir, name)); err == nil {
			sendError(w, r, http.StatusConflict, "ese nombre ya está en uso")
			return
		}
	}
	// Hashed HERE, before the closure: a blank one keeps the stored value,
	// which is hashed already (or plaintext until the next sign-in).
	pw := hashPassword(derefString(body.Password))

	failed := false
	oldName := ""
	err := s.cfg.Update(func(c *ServerConfig) {
		if c.Admin != nil {
			oldName = c.Admin.Name
		}
		if pw == "" && c.Admin != nil {
			pw = c.Admin.Password // blank = keep the current one
		}
		if pw == "" {
			failed = true
			return
		}
		c.Admin = &AdminAccount{Name: name, Password: pw}
	})
	if failed {
		sendError(w, r, http.StatusBadRequest, "contraseña requerida")
		return
	}
	if err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar la configuración")
		return
	}
	// A new name: the sessions under the old one belong to nobody now - a
	// password change there would check the old name and say "wrong password".
	// End them all, then re-issue THIS one under the new name, as long-lived as
	// before, so the admin stays signed in here (the same as apiPassword).
	if oldName != "" && oldName != name {
		ttl, remember := s.sessions.Remembered(tokenFrom(r))
		if !remember {
			ttl = s.cfg.SessionTTL
		}
		s.sessions.DropUser(oldName)
		token := s.sessions.Create(name, "admin", ttl, remember)
		w.Header().Set("Set-Cookie", sessionCookieHeader(token, ttl, remember, r.TLS != nil))
	}
	s.log.Info("admin account updated", "name", name)
	sendJSON(w, r, http.StatusOK,
		map[string]string{"message": "administrador actualizado", "name": name})
}

// adminSetExtStore stores where big files should be offloaded to.
//
// UI + config only for now: this stores the admin's choices; the code that
// actually moves files onto the mounted volume is not written yet.
func (s *Server) adminSetExtStore(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	store := ExternalStorage{
		Mount:     strings.TrimSpace(body.Mount),
		AlwaysExt: normaliseExts(body.AlwaysExt),
		NeverExt:  normaliseExts(body.NeverExt),
	}
	if body.MinMB != nil && *body.MinMB > 0 {
		store.MinMB = roundTo(*body.MinMB, 3)
	}

	if err := s.cfg.Update(func(c *ServerConfig) { c.ExternalStorage = &store }); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar la configuración")
		return
	}
	s.log.Info("external storage set", "mount", store.Mount)
	sendJSON(w, r, http.StatusOK, map[string]any{
		"message":          "almacenamiento externo guardado",
		"external_storage": store,
	})
}

// adminSetSites stores the folder of plain web sites (sites.go). It applies at
// once - SitesPath reads it on every request. "" turns the sites off.
func (s *Server) adminSetSites(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	raw := strings.TrimSpace(body.SitesDir)
	if raw != "" {
		dir, err := s.cfg.resolveSitesDir(raw)
		if errors.Is(err, errSitesOverlap) {
			sendError(w, r, http.StatusBadRequest,
				"esa carpeta contiene datos de Nayive; elige otra")
			return
		}
		if info, statErr := os.Stat(dir); err != nil || statErr != nil || !info.IsDir() {
			sendError(w, r, http.StatusBadRequest, "no existe esa carpeta")
			return
		}
	}
	if err := s.cfg.Update(func(c *ServerConfig) { c.SitesDir = raw }); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar la configuración")
		return
	}
	s.log.Info("web sites folder set", "sites_dir", raw)
	sendJSON(w, r, http.StatusOK, map[string]any{
		"message":   "carpeta de sitios web guardada",
		"sites_dir": raw,
	})
}

// normaliseExts lowercases, de-duplicates and dot-prefixes a list of file
// extensions, keeping the order the admin typed them in.
func normaliseExts(list []string) []string {
	out := []string{}
	seen := make(map[string]bool)
	for _, t := range list {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" {
			continue
		}
		if !strings.HasPrefix(t, ".") {
			t = "." + t
		}
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// adminSaveUser creates or updates a regular user.
func (s *Server) adminSaveUser(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	name := NormaliseUsername(body.Name)
	if !ValidUsername(name) {
		sendError(w, r, http.StatusBadRequest, "nombre de usuario no válido")
		return
	}
	if name == s.cfg.AdminName() {
		sendError(w, r, http.StatusBadRequest, "ese nombre es del administrador")
		return
	}

	mustExist := body.Action == "update-user"
	opts := SaveAccountOptions{
		Password:  derefString(body.Password),
		MustExist: &mustExist,
	}
	// "password": null on an existing user removes it (the panel's in-field
	// trash); an absent key, or "", keeps it.
	if mustExist && body.has("password") && body.Password == nil {
		opts.ClearPassword = true
	}
	// Only pass a field through when the caller actually sent it. The raw JSON
	// goes down untouched: what "null", "0" and "abc" each mean is decided in
	// one place, in SaveAccount.
	if body.has("quota") {
		opts.SetQuota = true
		opts.Quota = body.Quota
	}
	if body.has("photo_max") {
		opts.SetPhoto = true
		opts.PhotoMax = body.PhotoMax
	}

	switch status := s.users.SaveAccount(name, opts); status {
	case "exists":
		sendError(w, r, http.StatusConflict, "el usuario ya existe")
	case "missing":
		sendError(w, r, http.StatusNotFound, "no existe ese usuario")
	case "bad-quota":
		sendError(w, r, http.StatusBadRequest, "cuota no válida")
	case "bad-photo-max":
		sendError(w, r, http.StatusBadRequest, "tamaño máximo de foto no válido")
	case "damaged":
		// Never "usuario guardado": nothing was written (F1).
		sendError(w, r, http.StatusConflict, "homes/"+name+"/data/config.json está dañado o no se puede leer: "+
			"no se ha cambiado nada; arréglalo a mano (el registro del servidor dice por qué)")
	case "write-failed":
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar el usuario: el disco no lo aceptó (el registro del servidor dice por qué)")
	default:
		if status == "created" {
			// A deleted or renamed-away person may have had this name: the
			// newcomer's eMail starts from their own empty home (L1).
			s.mail.NameReused(name)
		}
		if opts.ClearPassword || opts.Password != "" {
			// A password set or cleared here signs them out everywhere, as
			// their own change does: a kept session must not pick the next one.
			s.sessions.DropUser(name)
		}
		s.log.Info("user saved", "status", status, "name", name)
		sendJSON(w, r, http.StatusOK,
			map[string]string{"message": "usuario guardado", "name": name})
	}
}

// adminRenameUser renames the whole homes/<name> folder.
//
// Kept apart from "update-user" because it moves a directory rather than
// editing a field, and because it invalidates that user's sessions. The panel
// sends it FIRST, then updates the row under the new name.
func (s *Server) adminRenameUser(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	oldName := NormaliseUsername(body.Name)
	newName := NormaliseUsername(body.NewName)
	if !ValidUsername(oldName) || !ValidUsername(newName) {
		sendError(w, r, http.StatusBadRequest, "nombre de usuario no válido")
		return
	}
	if newName == s.cfg.AdminName() {
		sendError(w, r, http.StatusBadRequest, "ese nombre es del administrador")
		return
	}
	// The same guard as delete-user: the resolved home must be a direct child
	// of homes/, never a symlink pointing somewhere else.
	if !s.isRealHome(oldName) {
		sendError(w, r, http.StatusNotFound, "no existe ese usuario")
		return
	}

	// Two cheap pre-flight checks, so a no-op or a name clash does not sign a
	// real person out for nothing. RenameAccount repeats them under its lock -
	// that copy is the race-safe one, this one only spares the sessions.
	if oldName == newName {
		sendJSON(w, r, http.StatusOK,
			map[string]string{"message": "usuario renombrado", "name": newName})
		return
	}
	if _, err := os.Lstat(filepath.Join(s.cfg.HomesDir, newName)); err == nil {
		sendError(w, r, http.StatusConflict, "ese nombre ya está en uso")
		return
	}

	// Sign them out BEFORE the move: a session left alive would keep pointing
	// at a folder that no longer exists.
	s.sessions.DropUser(oldName)
	// eMail holds the old name until the folder has moved: nothing of the hub
	// may write a ghost homes/<old>/data/mail meanwhile (L1, admin_mail.go).
	finishMail := s.mail.BeginRename(oldName)
	status := s.users.RenameAccount(oldName, newName)
	s.users.ForgetUsage(oldName)
	if status == "renamed" {
		finishMail(newName) // their mail answers under the new name
	} else {
		finishMail("")
	}

	switch status {
	case "missing":
		sendError(w, r, http.StatusNotFound, "no existe ese usuario")
	case "exists":
		sendError(w, r, http.StatusConflict, "ese nombre ya está en uso")
	case "rename-failed":
		sendError(w, r, http.StatusInternalServerError,
			"no se pudo renombrar la carpeta del usuario")
	default:
		s.shares.RenameUser(oldName, newName)   // what they shared or got, their trip links
		s.trackers.RenameUser(oldName, newName) // their location URL keeps working
		s.chat.RenameUser(oldName, newName)     // read again under the new name; others' contacts follow
		s.devices.RenameUser(oldName, newName)  // their phones keep working
		s.convert.RenameUser(oldName, newName)  // their queued videos still convert
		s.log.Info("user renamed", "from", oldName, "to", newName)
		sendJSON(w, r, http.StatusOK,
			map[string]string{"message": "usuario renombrado", "name": newName})
	}
}

// adminDeleteUser removes the whole homes/<name> folder.
func (s *Server) adminDeleteUser(w http.ResponseWriter, r *http.Request, body *adminRequest) {
	name := NormaliseUsername(body.Name)
	if !ValidUsername(name) {
		sendError(w, r, http.StatusBadRequest, "nombre no válido")
		return
	}
	if !s.isRealHome(name) {
		sendError(w, r, http.StatusNotFound, "no existe ese usuario")
		return
	}

	home, err := resolveExisting(filepath.Join(s.cfg.HomesDir, name))
	if err != nil {
		sendError(w, r, http.StatusNotFound, "no existe ese usuario")
		return
	}
	// Signed out first: no request of theirs may write into a half-removed home.
	s.sessions.DropUser(name)
	// Their eMail stops before the home goes: the hub must never write a ghost
	// homes/<name>/data/mail, nor a new person with this name get their
	// mailboxes (L1, admin_mail.go).
	s.mail.DropUser(name)
	// A request let in just before (its session was alive) stops at its next
	// open: it must not re-create the home, nor reach a new person's (L2).
	// BEFORE the films go: an upload ending now must find the counter moved,
	// or it would queue its film under the name after the drop
	// (Converter.EnqueueAt).
	s.users.EndRequests(name)
	// And their queued films: never converted, binned or told of under the
	// name once a new person has it (L1).
	s.convert.DropUser(name)
	removed := os.RemoveAll(home)
	// The rest goes even when the home did not go whole: its config.json may be
	// gone already, and the account with it from the admin's list.
	s.users.ForgetUsage(name)
	// A new person given this name inherits none of its old names (L3).
	s.users.ForgetRenames(name)
	s.shares.DropUser(name)   // anything they shared, or was shared with them
	s.trackers.DropUser(name) // their location URL
	s.chat.DeleteUser(name)   // their chat links; others' chats with them end
	s.devices.DropUser(name)  // their phones' tokens die
	if removed != nil {
		s.log.Error("cannot delete a user's home", "name", name, "err", removed)
		sendError(w, r, http.StatusInternalServerError, "no se pudo borrar todo el usuario")
		return
	}

	s.log.Info("user deleted", "name", name)
	sendJSON(w, r, http.StatusOK, map[string]string{"message": "usuario eliminado"})
}

// isRealHome checks that homes/<name> resolves to a DIRECT CHILD of homes/ and
// is a real directory - never a symlink pointing somewhere else on the disk.
func (s *Server) isRealHome(name string) bool {
	homes, err := resolveExisting(s.cfg.HomesDir)
	if err != nil {
		return false
	}
	home, err := resolveExisting(filepath.Join(s.cfg.HomesDir, name))
	if err != nil {
		return false
	}
	if filepath.Dir(home) != homes {
		return false
	}
	info, err := os.Stat(home)
	return err == nil && info.IsDir()
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// roundTo rounds to `places` decimals, matching Python's round(x, 3).
func roundTo(v float64, places int) float64 {
	s := strconv.FormatFloat(v, 'f', places, 64)
	out, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return v
	}
	return out
}
