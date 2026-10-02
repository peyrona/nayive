package main

// =============================================================================
// The phone's photo upload (api_device_media.go): the folder choice, a cut and
// resumed upload, the same file twice, a full quota, the week-old parts.
// =============================================================================

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fptr(v float64) *float64 { return &v }

func TestMediaFolder(t *testing.T) {
	madrid, _ := time.LoadLocation("Europe/Madrid")
	ny, _ := time.LoadLocation("America/New_York")
	stage := func(start, end, tz string, lat, lon float64) publicTripStage {
		return publicTripStage{StartDate: start, EndDate: end, Tz: tz, Lat: fptr(lat), Lon: fptr(lon)}
	}
	off := false
	lisboa := publicTripFile{StartDate: "2026-05-01", EndDate: "2026-05-05", PhotosDir: "files/fotos/lisboa",
		Stages: []publicTripStage{stage("2026-05-01", "2026-05-05", "Europe/Lisbon", 38.72, -9.14)}}
	porto := publicTripFile{StartDate: "2026-05-04", EndDate: "2026-05-08", PhotosDir: "files/fotos/porto",
		Stages: []publicTripStage{stage("2026-05-04", "2026-05-08", "Europe/Lisbon", 41.15, -8.63)}}
	noDir := publicTripFile{StartDate: "2026-06-01", EndDate: "2026-06-03",
		Stages: []publicTripStage{stage("2026-06-01", "2026-06-03", "", 40.4, -3.7)}}
	tracked := publicTripFile{StartDate: "2026-07-01", EndDate: "2026-07-02", PhotosDir: "files/fotos/roma", Track: &off}
	newYork := publicTripFile{StartDate: "2026-08-01", EndDate: "2026-08-05", PhotosDir: "files/fotos/ny",
		Stages: []publicTripStage{stage("2026-08-01", "2026-08-05", "America/New_York", 40.71, -74.0)}}
	bad := publicTripFile{StartDate: "2026-09-01", EndDate: "2026-09-02", PhotosDir: "data/trips"}
	all := []publicTripFile{lisboa, porto, noDir, tracked, newYork, bad}

	at := func(loc *time.Location, s string) time.Time {
		t, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
		if err != nil {
			panic(err)
		}
		return t
	}
	cases := []struct {
		name     string
		trips    []publicTripFile
		taken    time.Time
		lat, lon *float64
		want     string
	}{
		{"no trip at all", nil, at(madrid, "2026-05-02 12:00"), nil, nil, ""},
		{"no trip that day", all, at(madrid, "2026-04-20 12:00"), nil, nil, ""},
		{"one trip", all, at(madrid, "2026-05-02 12:00"), nil, nil, "files/fotos/lisboa"},
		{"trip without a photo folder", all, at(madrid, "2026-06-02 12:00"), nil, nil, ""},
		{"positions off still takes photos", all, at(madrid, "2026-07-01 12:00"), nil, nil, "files/fotos/roma"},
		{"a folder outside files/ is no folder", all, at(madrid, "2026-09-01 12:00"), nil, nil, ""},
		{"two trips, no GPS: the first", all, at(madrid, "2026-05-04 12:00"), nil, nil, "files/fotos/lisboa"},
		{"two trips, GPS near Porto", all, at(madrid, "2026-05-04 12:00"), fptr(41.14), fptr(-8.61), "files/fotos/porto"},
		{"two trips, GPS near Lisboa", all, at(madrid, "2026-05-05 12:00"), fptr(38.7), fptr(-9.1), "files/fotos/lisboa"},
		// 22:30 in New York on the last day is already the next day in Madrid:
		// the stage's own clock says it is still the trip.
		{"late on the last day, abroad", all, at(ny, "2026-08-05 22:30"), nil, nil, "files/fotos/ny"},
		// 00:30 in Madrid on the first day is still the day before in New York.
		{"just past midnight at home, not yet there", all, at(madrid, "2026-08-01 00:30"), nil, nil, ""},
	}
	for _, c := range cases {
		if got := mediaFolder(c.trips, c.taken, c.lat, c.lon, madrid); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestCleanMediaName(t *testing.T) {
	for in, want := range map[string]string{
		"IMG_1.jpg": "IMG_1.jpg", "../../x.jpg": "x.jpg", "a\\b\\c.mp4": "c.mp4", ".hidden.jpg": "hidden.jpg",
		"": "foto", "..": "foto", "a\x00b.jpg": "ab.jpg", "  VID 2.mp4 ": "VID 2.mp4",
	} {
		if got := cleanMediaName(in); got != want {
			t.Errorf("cleanMediaName(%q) = %q, want %q", in, got, want)
		}
	}
}

// mediaPhone is the app's side of an upload.
type mediaPhone struct {
	t    *testing.T
	base string
}

func (m mediaPhone) start(id, name string, size int64, taken time.Time) (int, map[string]any) {
	m.t.Helper()
	body := fmt.Sprintf(`{"id":%q,"name":%q,"size":%d,"taken":%d,"mime":"image/jpeg"}`, id, name, size, taken.UnixMilli())
	code, raw := phone(m.t, m.base, "POST", "/api/device/media/start", phoneToken, body)
	out := map[string]any{}
	json.Unmarshal(raw, &out)
	return code, out
}

func (m mediaPhone) put(upload string, offset int64, data []byte) (int, map[string]any) {
	m.t.Helper()
	req, _ := http.NewRequest("PUT", fmt.Sprintf("%s/api/device/media/%s?offset=%d", m.base, upload, offset), bytes.NewReader(data))
	req.Header.Set(deviceHeader, phoneToken)
	resp, err := anonymous().Do(req)
	if err != nil {
		m.t.Fatalf("PUT: %v", err)
	}
	out := map[string]any{}
	json.Unmarshal(readBody(m.t, resp), &out)
	return resp.StatusCode, out
}

func (m mediaPhone) end(upload string) (int, map[string]any) {
	m.t.Helper()
	code, raw := phone(m.t, m.base, "POST", "/api/device/media/"+upload+"/end", phoneToken, "")
	out := map[string]any{}
	json.Unmarshal(raw, &out)
	return code, out
}

// send is one whole file in one go: its home-relative path.
func (m mediaPhone) send(id, name string, data []byte, taken time.Time) string {
	m.t.Helper()
	code, st := m.start(id, name, int64(len(data)), taken)
	if code != 200 {
		m.t.Fatalf("start %s = %d %v", id, code, st)
	}
	if st["done"] == true {
		return ""
	}
	up := st["upload"].(string)
	if code, out := m.put(up, 0, data); code != 200 {
		m.t.Fatalf("put %s = %d %v", id, code, out)
	}
	code, out := m.end(up)
	if code != 200 {
		m.t.Fatalf("end %s = %d %v", id, code, out)
	}
	return out["path"].(string)
}

func TestDeviceMediaUpload(t *testing.T) {
	shortHold(t)
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)
	m := mediaPhone{t, base}
	home := filepath.Join(srv.cfg.HomesDir, "ana")
	now := time.Now()

	// Off: nothing goes up, and the phone is told "off".
	if st := phoneWait(t, base, phoneToken, ""); st.Media != 0 {
		t.Fatalf("media before the switch = %d", st.Media)
	}
	if code, _ := m.start("1", "a.jpg", 3, now); code != http.StatusForbidden {
		t.Fatalf("start with the switch off = %d", code)
	}
	// Only a session switches it; a folder outside files/ is refused.
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"mediaDir":"data/trips"}`, 400, nil)
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{}`, 400, nil)
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"media":true}`, 200, nil)
	first := phoneWait(t, base, phoneToken, "")
	if first.Media == 0 {
		t.Fatal("the wait does not say media is on")
	}
	// Switching on twice keeps the first moment.
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"media":true}`, 200, nil)
	if st := phoneWait(t, base, phoneToken, ""); st.Media != first.Media {
		t.Fatalf("on again moved the moment: %d -> %d", first.Media, st.Media)
	}
	var list deviceListOut
	jsonCall(t, client, "GET", base+"/api/device", "", 200, &list)
	if !list.Devices[0].Media || list.Devices[0].MediaDir != mediaDefaultDir {
		t.Fatalf("list = %+v", list.Devices[0])
	}

	// A cut in the middle: start again, go on from where it stopped.
	data := bytes.Repeat([]byte("0123456789"), 1000)
	code, st := m.start("img-1", "IMG_1.jpg", int64(len(data)), now)
	if code != 200 || st["offset"].(float64) != 0 {
		t.Fatalf("start = %d %v", code, st)
	}
	up := st["upload"].(string)
	if code, out := m.put(up, 0, data[:4000]); code != 200 || out["offset"].(float64) != 4000 {
		t.Fatalf("first half = %d %v", code, out)
	}
	if code, out := m.end(up); code != http.StatusConflict || out["offset"].(float64) != 4000 {
		t.Fatalf("end too soon = %d %v", code, out)
	}
	code, st = m.start("img-1", "IMG_1.jpg", int64(len(data)), now)
	if code != 200 || st["upload"] != up || st["offset"].(float64) != 4000 {
		t.Fatalf("start again = %d %v", code, st)
	}
	// A chunk cut halfway, its connection still open (Wi-Fi gone, no FIN):
	// it holds nothing up - the retry goes through at once - and leaves no
	// half chunk behind when it finally dies.
	stale, err := net.Dial("tcp", strings.TrimPrefix(base, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(stale, "PUT /api/device/media/%s?offset=4000 HTTP/1.1\r\nHost: x\r\n%s: %s\r\nContent-Length: 6000\r\n\r\n%s",
		up, deviceHeader, phoneToken, data[4000:6500])
	time.Sleep(200 * time.Millisecond)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if code, st := m.start("img-1", "IMG_1.jpg", int64(len(data)), now); code != 200 || st["offset"].(float64) != 4000 {
			t.Errorf("start beside a stale chunk = %d %v", code, st)
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("start waited for the stale chunk")
	}
	stale.Close()
	time.Sleep(200 * time.Millisecond)
	if info, _ := os.Stat(filepath.Join(home, "data", mediaPartDir, up+".part")); info.Size() != 4000 {
		t.Fatalf("part after a cut chunk = %d, want 4000", info.Size())
	}
	if left, _ := filepath.Glob(filepath.Join(home, "data", mediaPartDir, "*chunk*")); len(left) != 0 {
		t.Fatalf("chunk temps left: %v", left)
	}

	// A wrong offset is told the right one, and writes nothing.
	if code, out := m.put(up, 3000, data[3000:]); code != http.StatusConflict || out["offset"].(float64) != 4000 {
		t.Fatalf("wrong offset = %d %v", code, out)
	}
	// More than the file is refused.
	if code, _ := m.put(up, 4000, append(append([]byte{}, data[4000:]...), 'x')); code != http.StatusBadRequest {
		t.Fatalf("past the end = %d", code)
	}
	if code, out := m.put(up, 4000, data[4000:]); code != 200 || out["offset"].(float64) != float64(len(data)) {
		t.Fatalf("second half = %d %v", code, out)
	}
	code, out := m.end(up)
	year := fmt.Sprint(now.Year())
	want := "files/Camera/" + year + "/IMG_1.jpg"
	if code != 200 || out["path"] != want {
		t.Fatalf("end = %d %v, want %s", code, out, want)
	}
	got, err := os.ReadFile(filepath.Join(home, want))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("filed file differs: %v", err)
	}
	if info, _ := os.Stat(filepath.Join(home, want)); info.Mode().Perm() != 0o644 {
		t.Fatalf("filed mode = %v", info.Mode())
	}
	if left, _ := os.ReadDir(filepath.Join(home, "data", mediaPartDir)); len(left) != 0 {
		t.Fatalf("parts left behind: %v", left)
	}

	// The same file again (its answer was lost): done, no copy.
	if code, st := m.start("img-1", "IMG_1.jpg", int64(len(data)), now); code != 200 || st["done"] != true {
		t.Fatalf("same id again = %d %v", code, st)
	}
	if code, _ := m.end(up); code != http.StatusNotFound {
		t.Fatalf("end again = %d", code)
	}
	// Another file with the same name: " (2)".
	if p := m.send("img-2", "IMG_1.jpg", []byte("other"), now); p != "files/Camera/"+year+"/IMG_1 (2).jpg" {
		t.Fatalf("same name = %q", p)
	}

	// Taken during a trip: its photo folder. The phone's own folder otherwise.
	writeTripDates(t, srv, -1, 1)
	if p := m.send("img-3", "trip.jpg", []byte("trip"), now); p != "files/fotos/porto/trip.jpg" {
		t.Fatalf("during the trip = %q", p)
	}
	// A trip folder that cannot be made (a file has its name): the phone's own.
	os.RemoveAll(filepath.Join(home, "files/fotos/porto"))
	os.WriteFile(filepath.Join(home, "files/fotos/porto"), []byte("not a folder"), 0o644)
	if p := m.send("img-6", "blocked.jpg", []byte("b"), now); p != "files/Camera/"+year+"/blocked.jpg" {
		t.Fatalf("unusable trip folder = %q", p)
	}
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"mediaDir":"files/Móvil"}`, 200, nil)
	old := now.AddDate(-2, 0, 0)
	if p := m.send("img-4", "old.jpg", []byte("old"), old); p != fmt.Sprintf("files/Móvil/%d/old.jpg", old.Year()) {
		t.Fatalf("own folder = %q", p)
	}

	// Another phone cannot touch this one's upload.
	code, st = m.start("img-5", "x.jpg", 10, now)
	up5 := st["upload"].(string)
	req, _ := http.NewRequest("POST", base+"/api/device/media/"+up5+"/end", nil)
	req.Header.Set(deviceHeader, "tok_OTHERPHONEOTHERPHONEOTHERPHONEOTHERPHONE")
	if resp, _ := anonymous().Do(req); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown phone = %d", resp.StatusCode)
	}

	// Off again: start refuses, the wait says 0.
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"media":false}`, 200, nil)
	if st := phoneWait(t, base, phoneToken, ""); st.Media != 0 {
		t.Fatalf("media after off = %d", st.Media)
	}
}

func TestDeviceMediaQuotaAndSweep(t *testing.T) {
	srv, ts, client := newTestServer(t)
	base := ts.URL
	signIn(t, client, base, "ana", "abc")
	id := enrolPhone(t, client, base)
	jsonCall(t, client, "PUT", base+"/api/device/"+id, `{"media":true}`, 200, nil)
	m := mediaPhone{t, base}
	now := time.Now()

	// A week-old part goes at the next start; a fresh one stays.
	code, st := m.start("stale", "s.mp4", 100, now)
	if code != 200 {
		t.Fatalf("start = %d", code)
	}
	stale := st["upload"].(string)
	m.put(stale, 0, make([]byte, 50))
	dir := filepath.Join(srv.cfg.HomesDir, "ana", "data", mediaPartDir)
	week := now.Add(-mediaPartTTL - time.Hour)
	for _, ext := range []string{".part", ".json"} {
		os.Chtimes(filepath.Join(dir, stale+ext), week, week)
	}
	m.start("fresh", "f.mp4", 100, now)
	if _, err := os.Stat(filepath.Join(dir, stale+".part")); !os.IsNotExist(err) {
		t.Fatalf("stale part still there: %v", err)
	}

	// Quota: a file bigger than what is left is refused at start (507), and
	// so is a chunk once the space is gone.
	if got := srv.users.SaveAccount("ana", SaveAccountOptions{SetQuota: true, Quota: json.RawMessage(`0.000001`)}); got != "updated" {
		t.Fatalf("quota = %q", got)
	}
	os.WriteFile(filepath.Join(srv.cfg.HomesDir, "ana", "files", "lleno.bin"), make([]byte, 4000), 0o644)
	srv.users.ForgetUsage("ana")
	if code, _ := m.start("big", "big.mp4", 50<<20, now); code != http.StatusInsufficientStorage {
		t.Fatalf("too big = %d", code)
	}
	if code, _ := m.start("fresh", "f.mp4", 100, now); code != http.StatusInsufficientStorage {
		t.Fatalf("fresh again = %d", code)
	}
	if code, _ := m.put(mediaUploadID(id, "fresh"), 0, make([]byte, 100)); code != http.StatusInsufficientStorage {
		t.Fatalf("chunk past the quota = %d", code)
	}
}
