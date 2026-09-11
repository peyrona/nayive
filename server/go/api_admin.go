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
	// typed field the answer was a flat "bad JSON", where the Python says
	// "cuota no válida" - and the panel shows that message to the person who
	// typed it.
	Quota    json.RawMessage `json:"quota"`
	PhotoMax json.RawMessage `json:"photo_max"`

	// set-extstore
	Mount     string   `json:"mount"`
	AlwaysExt []string `json:"always_ext"`
	NeverExt  []string `json:"never_ext"`
	MinMB     *float64 `json:"min_mb"`

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
		var adminName string
		var ext *ExternalStorage
		s.cfg.Read(func(c *ServerConfig) {
			if c.Admin != nil {
				adminName = c.Admin.Name
			}
			ext = c.ExternalStorage
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
	if len(s.users.ListUsers()) > 0 {
		// Not a fresh install - regular users already exist. Refuse the open,
		// no-login setup so a wiped server.json cannot be used to seize the box;
		// the admin restores it by hand instead.
		sendError(w, r, http.StatusConflict,
			"ya existen usuarios; restaura el administrador editando config/server.json")
		return
	}
	name := NormaliseUsername(body.Name)
	pw := derefString(body.Password)
	if name == "" || pw == "" {
		sendError(w, r, http.StatusBadRequest, "usuario y contraseña requeridos")
		return
	}
	if err := s.cfg.Update(func(c *ServerConfig) {
		c.Admin = &AdminAccount{Name: name, Password: pw}
	}); err != nil {
		sendError(w, r, http.StatusInternalServerError, "no se pudo guardar la configuración")
		return
	}

	token := s.sessions.Create(name, "admin", s.cfg.SessionTTL)
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
	pw := derefString(body.Password)

	failed := false
	err := s.cfg.Update(func(c *ServerConfig) {
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
	default:
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
	status := s.users.RenameAccount(oldName, newName)
	s.users.ForgetUsage(oldName)

	switch status {
	case "missing":
		sendError(w, r, http.StatusNotFound, "no existe ese usuario")
	case "exists":
		sendError(w, r, http.StatusConflict, "ese nombre ya está en uso")
	case "rename-failed":
		sendError(w, r, http.StatusInternalServerError,
			"no se pudo renombrar la carpeta del usuario")
	default:
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
	os.RemoveAll(home)
	s.sessions.DropUser(name)
	s.users.ForgetUsage(name)
	s.shares.DropUser(name) // anything they shared, or was shared with them

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
