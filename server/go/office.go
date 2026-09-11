package main

// =============================================================================
// Turning a LibreOffice document into its Microsoft Office twin, on the server.
// =============================================================================
//
// Write opens .docx and Calc opens .xlsx; neither can read OpenDocument. So a
// Writer document (.odt, its template, flat and 1.x forms) becomes a .docx, and
// a Calc one (.ods ...) an .xlsx - by LibreOffice itself, run headless. Impress,
// Draw, Math and Base files have no app here: Drive refuses them (his call,
// 2026-09-11) and the server never converts them.
//
// THE TWIN SITS BESIDE THE ORIGINAL, and the original is never touched (his
// call). "Informe.odt" -> "Informe.docx", same folder. That name IS the record
// of "already converted": Drive's double-click opens the twin when it is there
// and converts only when it is not. An upload asks with replace=1 instead - a
// freshly uploaded file must never be answered with an older twin.
//
// ONE AT A TIME, and while the user waits. The VPS has one core, and two
// soffice runs on one profile fight over it. Unlike the video queue this is
// synchronous: a document takes seconds, and the user is waiting to open it.
// It runs at nice 10 - below web requests, above a film being converted.
//
// LIBREOFFICE NEVER SEES A USER'S PATH. The document is copied into a private
// temp folder as "doc.<ext>" and converted there. Its profile (one per server
// run, made on first use) turns off what a document could use to reach outside
// itself: macros, updating links (a section or picture linked to another file
// on the server would be pulled INTO the twin - another user's file, even) and
// recalculating on load. office_test.go proves the link case.
//
// The twin is written like an upload: a ".convert-" temp beside it (the
// startup sweep's shape, 0600 until done), chmod 0644, renamed into place.
//
// java: `turn` is a one-slot channel used as a lock that a waiting request can
// give up on (a sync.Mutex cannot be abandoned). It also guards `profile`.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// officeKind is what one extension becomes, and the ONE import filter it is
// read with. Forcing the filter matters: left to guess, LibreOffice opens
// whatever the bytes look like - plain text, HTML, RTF, an old .doc - so an
// ".odt" name would be a door to every format it reads, and HTML can link to
// other files. With the filter forced, anything that is not really that kind
// fails to load. Names from LibreOffice's own registry (writer.xcd, calc.xcd).
type officeKind struct{ twin, filter string }

// officeKinds keys are what LibreOffice converts. Keep apps/drive's
// OFFICE_WRITE / OFFICE_CALC the same lists.
var officeKinds = map[string]officeKind{
	// Writer -> .docx
	".odt":  {".docx", "writer8"},
	".ott":  {".docx", "writer8_template"},
	".fodt": {".docx", "OpenDocument Text Flat XML"},
	".sxw":  {".docx", "StarOffice XML (Writer)"},
	".stw":  {".docx", "writer_StarOffice_XML_Writer_Template"},
	// Calc -> .xlsx
	".ods":  {".xlsx", "calc8"},
	".ots":  {".xlsx", "calc8_template"},
	".fods": {".xlsx", "OpenDocument Spreadsheet Flat XML"},
	".sxc":  {".xlsx", "StarOffice XML (Calc)"},
	".stc":  {".xlsx", "calc_StarOffice_XML_Calc_Template"},
}

// officeFilter is LibreOffice's export filter for each twin.
var officeFilter = map[string]string{
	".docx": "docx:MS Word 2007 XML",
	".xlsx": "xlsx:Calc MS Excel 2007 XML",
}

const (
	officeTimeout = 3 * time.Minute // a first run makes the profile: ~20 s on the VPS
	officeMaxIn   = 200 << 20       // no real document is bigger
	officeNice    = 10
)

var (
	errOfficeQuota = errors.New("no room in the quota for the twin")
	errOfficeBig   = errors.New("the document is too big to convert")
)

// OfficeTwinName is "x.odt" -> "x.docx", "y.ODS" -> "y.xlsx"; false for any
// other kind of file.
func OfficeTwinName(name string) (string, bool) {
	ext := filepath.Ext(name)
	kind, ok := officeKinds[strings.ToLower(ext)]
	if !ok || len(name) == len(ext) {
		return "", false
	}
	return strings.TrimSuffix(name, ext) + kind.twin, true
}

// Office runs LibreOffice. Available() is false when it is not installed.
type Office struct {
	soffice string // "" = not installed: the feature is off
	nice    string // /usr/bin/nice, or "" (then Setpriority after start)
	log     Logger

	turn    chan struct{} // one slot: holding it is "my turn"
	profile string        // the LibreOffice profile; "" until the first run
}

func NewOffice(log Logger) *Office {
	o := &Office{log: log, turn: make(chan struct{}, 1)}
	if p, err := exec.LookPath("soffice"); err == nil {
		o.soffice = p
	}
	if n, err := exec.LookPath("nice"); err == nil {
		o.nice = n
	}
	return o
}

// Available says whether LibreOffice is installed.
func (o *Office) Available() bool { return o.soffice != "" }

// Close removes the profile. Waits for a run in progress.
func (o *Office) Close() {
	o.turn <- struct{}{}
	defer func() { <-o.turn }()
	if o.profile != "" {
		os.RemoveAll(o.profile)
		o.profile = ""
	}
}

// Convert writes src's twin at dst, replacing a file already there, and
// returns its size. `name` is the document's name as the user sees it: its
// extension says what it is (src may be reached through a link with another
// name). `budget` is how many bytes the twin may take (-1: no quota). `ctx`
// is the request's: a browser that gives up stops the run.
func (o *Office) Convert(ctx context.Context, name string, src, dst Resolved, budget int64) (int64, error) {
	if !o.Available() {
		return 0, errors.New("LibreOffice is not installed")
	}
	ext := strings.ToLower(filepath.Ext(name))
	kind, ok := officeKinds[ext]
	if !ok {
		return 0, errors.New("not a LibreOffice document this converts")
	}

	select {
	case o.turn <- struct{}{}:
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	defer func() { <-o.turn }()

	work, err := os.MkdirTemp("", "nayive-office-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(work)

	in := filepath.Join(work, "doc"+ext)
	if err := copyResolvedTo(src, in, officeMaxIn); err != nil {
		return 0, err
	}
	outDir := filepath.Join(work, "out")
	if err := o.run(ctx, work, kind.filter, officeFilter[kind.twin], outDir, in); err != nil {
		return 0, err
	}

	out := filepath.Join(outDir, "doc"+kind.twin)
	info, err := os.Stat(out)
	if err != nil {
		return 0, errors.New("LibreOffice made no file")
	}
	// Both twins are zip files. Anything else is not something to hand Write.
	if head := readHead(out, 4); !bytes.Equal(head, []byte("PK\x03\x04")) {
		return 0, errors.New("LibreOffice made something that is not a docx/xlsx")
	}
	if budget >= 0 && info.Size() > budget {
		return 0, errOfficeQuota
	}
	if err := placeFile(out, dst); err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// run is soffice itself. A run that is killed (timeout, browser gone) may
// leave the profile half-written, so it is thrown away and made again next time.
func (o *Office) run(ctx context.Context, work, inFilter, outFilter, outDir, in string) error {
	if o.profile == "" {
		p, err := newOfficeProfile()
		if err != nil {
			return err
		}
		o.profile = p
	}

	ctx, cancel := context.WithTimeout(ctx, officeTimeout)
	defer cancel()

	args := []string{
		"-env:UserInstallation=" + (&url.URL{Scheme: "file", Path: o.profile}).String(),
		"--headless", "--invisible", "--norestore", "--nologo", "--nodefault",
		"--nolockcheck", "--infilter=" + inFilter, "--convert-to", outFilter,
		"--outdir", outDir, in,
	}
	var cmd *exec.Cmd
	if o.nice != "" {
		cmd = exec.CommandContext(ctx, o.nice, append([]string{"-n", strconv.Itoa(officeNice), o.soffice}, args...)...)
	} else {
		cmd = exec.CommandContext(ctx, o.soffice, args...)
	}
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/bin:/usr/bin:/bin"
	}
	cmd.Env = []string{"PATH=" + path, "HOME=" + work, "TMPDIR=" + work, "LANG=C.UTF-8"}
	cmd.Dir = work

	// soffice is a script that starts oosplash that starts soffice.bin, so
	// killing the one process Go started would leave the real one running. Its
	// own process group lets a kill take all three.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second

	tail := &tailBuffer{max: 2048}
	cmd.Stdout, cmd.Stderr = tail, tail
	if err := cmd.Start(); err != nil {
		return err
	}
	if o.nice == "" {
		syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, officeNice)
	}
	err := cmd.Wait()
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // anything it left behind

	if ctx.Err() != nil {
		os.RemoveAll(o.profile)
		o.profile = ""
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("LibreOffice took longer than %v", officeTimeout)
		}
		return ctx.Err()
	}
	if err != nil {
		return fmt.Errorf("soffice: %v: %s", err, strings.TrimSpace(tail.String()))
	}
	return nil
}

// officeRegistry is the profile's settings, written before LibreOffice first
// starts it. Each one closes a door a document could open from inside:
//
//   - macros: never run, whatever the document asks;
//   - links (Writer and Calc): never updated on load, so a section, picture
//     or cell linked to another file keeps the copy it was saved with instead
//     of reading that file now;
//   - recalculation on load: never, so a formula that reads the machine
//     (INFO, CELL("filename"), an external reference) keeps its saved value.
//
// The two "Link" settings count differently: Writer 0 never / 1 on request /
// 2 always (its default is 1), Calc 0 always / 1 never / 2 on request (its
// default is 2). office_test.go proves both.
const officeRegistry = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>1</value></prop></item>
</oor:items>
`

// newOfficeProfile makes a fresh profile folder with officeRegistry in it.
func newOfficeProfile() (string, error) {
	dir, err := os.MkdirTemp("", "nayive-office-profile-")
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(dir, "user"), 0o700); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	xcu := filepath.Join(dir, "user", "registrymodifications.xcu")
	if err := os.WriteFile(xcu, []byte(officeRegistry), 0o600); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	return dir, nil
}

// copyResolvedTo copies an approved file (read through its root) to a plain
// path, refusing one bigger than `max`.
func copyResolvedTo(src Resolved, to string, max int64) error {
	f, err := src.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(f, max+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n > max {
		return errOfficeBig
	}
	return nil
}

// placeFile copies a finished file to dst through dst's root: a ".convert-"
// temp beside it, 0644, then one rename - a reader never sees half a file.
func placeFile(from string, dst Resolved) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()

	root, err := dst.open()
	if err != nil {
		return err
	}
	defer root.Close()
	tmp, tmpRel, err := createTempNamed(root, filepath.Dir(dst.Rel), ".convert-")
	if err != nil {
		return err
	}
	defer root.Remove(tmpRel) // a no-op once it has been renamed away

	_, err = io.Copy(tmp, in)
	if err == nil {
		err = tmp.Chmod(0o644)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return root.Rename(tmpRel, dst.Rel)
}

// readHead is the first n bytes of a file, or fewer.
func readHead(file string, n int) []byte {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, n)
	got, _ := io.ReadFull(f, buf)
	return buf[:got]
}
