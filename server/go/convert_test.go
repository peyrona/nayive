package main

// =============================================================================
// The video converter, end to end: upload with &convert=mp4, let the queue run,
// check the mp4 and the papelera. Needs ffmpeg + ffprobe; skipped without them.
// =============================================================================

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func needFFmpeg(t *testing.T) {
	t.Helper()
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip(bin + " not installed")
		}
	}
}

// makeAVI writes a 2-second AVI with TWO audio tracks - the shape of his real
// film (XviD video, Spanish + English MP3).
func makeAVI(t *testing.T) []byte {
	t.Helper()
	out := filepath.Join(t.TempDir(), "gen.avi")
	cmd := exec.Command("ffmpeg", "-v", "error",
		"-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=25",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-f", "lavfi", "-i", "sine=frequency=880:duration=2",
		"-map", "0", "-map", "1", "-map", "2",
		"-c:v", "mpeg4", "-c:a", "libmp3lame", out)
	if msg, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("making the test AVI: %v\n%s", err, msg)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func upload(t *testing.T, client *http.Client, url string, body []byte) map[string]string {
	t.Helper()
	resp := do(t, client, "PUT", url, bytes.NewReader(body), nil)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT %s: %d %s", url, resp.StatusCode, raw)
	}
	var answer map[string]string
	json.Unmarshal(raw, &answer)
	return answer
}

func TestConvertOnUpload(t *testing.T) {
	needFFmpeg(t)
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	// GET /api/convert says it is on, with nothing queued.
	resp := do(t, client, "GET", ts.URL+"/api/convert", nil, nil)
	var st struct {
		Available bool            `json:"available"`
		Jobs      []ConvertStatus `json:"jobs"`
	}
	json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	if !st.Available || len(st.Jobs) != 0 {
		t.Fatalf("GET /api/convert = %+v, want available and no jobs", st)
	}

	// A plain upload of the same kind of file is NOT converted: it must be asked.
	avi := makeAVI(t)
	if a := upload(t, client, ts.URL+"/api/files?file=files/Pelis/sin.avi", avi); a["convert"] != "" {
		t.Fatalf("an upload without &convert= was queued: %v", a)
	}
	// Nor is a file that is not a video, even when asked.
	if a := upload(t, client, ts.URL+"/api/files?file=files/Pelis/nota.txt&convert=mp4",
		[]byte("hola")); a["convert"] != "" {
		t.Fatalf("a .txt was queued: %v", a)
	}

	a := upload(t, client, ts.URL+"/api/files?file=files/Pelis/prueba.avi&convert=mp4", avi)
	if a["convert"] != "queued" {
		t.Fatalf("upload answer %v, want convert=queued", a)
	}
	if jobs := srv.convert.Status("ana"); len(jobs) != 1 || jobs[0].Path != "files/Pelis/prueba.avi" {
		t.Fatalf("queue = %+v", jobs)
	}

	// A name that is taken is never overwritten: this one must survive.
	pelis := filepath.Join(srv.cfg.HomesDir, "ana", "files", "Pelis")
	os.WriteFile(filepath.Join(pelis, "prueba.mp4"), []byte("ya estaba"), 0o644)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { srv.convert.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	deadline := time.Now().Add(60 * time.Second)
	for len(srv.convert.Status("ana")) > 0 {
		if time.Now().After(deadline) {
			t.Fatal("the conversion did not finish in 60 s")
		}
		time.Sleep(100 * time.Millisecond)
	}

	if raw, _ := os.ReadFile(filepath.Join(pelis, "prueba.mp4")); string(raw) != "ya estaba" {
		t.Fatal("the existing prueba.mp4 was overwritten")
	}
	mp4 := filepath.Join(pelis, "prueba (1).mp4")
	info, err := os.Stat(mp4)
	if err != nil {
		t.Fatalf("no mp4: %v", err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Errorf("mp4 mode %v, want 0644", info.Mode().Perm())
	}
	p, err := srv.convert.probe(context.Background(), mp4)
	if err != nil {
		t.Fatal(err)
	}
	if p.videoCodec != "h264" || len(p.audioCodecs) != 2 || p.duration < 1.5 {
		t.Fatalf("mp4 = %+v, want h264 with BOTH audio tracks, ~2 s", p)
	}

	// The original went to the papelera, not away.
	if _, err := os.Stat(filepath.Join(pelis, "prueba.avi")); !os.IsNotExist(err) {
		t.Fatal("the AVI is still in its folder")
	}
	inTrash := false
	for _, it := range srv.trash.List("user", "ana") {
		if it.Name == "prueba.avi" {
			inTrash = true
		}
	}
	if !inTrash {
		t.Fatal("the AVI is not in the papelera")
	}

	// No temp left behind, and the saved queue is empty.
	entries, _ := os.ReadDir(pelis)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".convert-") {
			t.Fatalf("temp left behind: %s", e.Name())
		}
	}
	var saved struct {
		Queue []ConvertJob `json:"queue"`
	}
	loadJSONFile(filepath.Join(srv.cfg.ConfigDir, "convert.json"), &saved)
	if len(saved.Queue) != 0 {
		t.Fatalf("convert.json still holds %v", saved.Queue)
	}
}

// A job whose file cannot be converted fails WITHOUT touching the original.
func TestConvertFailureKeepsOriginal(t *testing.T) {
	needFFmpeg(t)
	srv, ts, client := newTestServer(t)
	signIn(t, client, ts.URL, "ana", "abc")

	junk := []byte("this is not a video at all")
	if a := upload(t, client, ts.URL+"/api/files?file=files/roto.avi&convert=mp4", junk); a["convert"] != "queued" {
		t.Fatalf("upload answer %v", a)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { srv.convert.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	deadline := time.Now().Add(20 * time.Second)
	for len(srv.convert.Status("ana")) > 0 {
		if time.Now().After(deadline) {
			t.Fatal("the job did not end")
		}
		time.Sleep(50 * time.Millisecond)
	}
	files := filepath.Join(srv.cfg.HomesDir, "ana", "files")
	if raw, _ := os.ReadFile(filepath.Join(files, "roto.avi")); !bytes.Equal(raw, junk) {
		t.Fatal("the original was touched")
	}
	if _, err := os.Stat(filepath.Join(files, "roto.mp4")); !os.IsNotExist(err) {
		t.Fatal("an mp4 was left for a failed job")
	}
}

func TestConvertibleAndTempNames(t *testing.T) {
	for name, want := range map[string]bool{
		"a.avi": true, "B.AVI": true, "c.mkv": true, "d.MOV": true, "e.wmv": true,
		"f.mp4": false, "g.webm": false, "h.txt": false, "avi": false,
	} {
		if IsConvertible(name) != want {
			t.Errorf("IsConvertible(%q) = %v", name, !want)
		}
	}
	if !isTempName(".convert-abcd1234") || isTempName(".convert-mis-pelis") {
		t.Error("isTempName must match exactly the .convert- temp shape")
	}
}

// H.264 in 8-bit is copied (seconds, not an hour); anything else is re-encoded.
func TestFFmpegArgsCopyWhenPlayable(t *testing.T) {
	has := func(args []string, pair ...string) bool {
		for i := 0; i+len(pair) <= len(args); i++ {
			if slices.Equal(args[i:i+len(pair)], pair) {
				return true
			}
		}
		return false
	}
	h264 := probeInfo{videoCodec: "h264", pixFmt: "yuv420p", audioCodecs: []string{"aac", "aac"}}
	if a := ffmpegArgs("/s", "/d", h264); !has(a, "-c:v", "copy") || !has(a, "-c:a", "copy") {
		t.Errorf("h264+aac not copied: %v", a)
	}
	ten := probeInfo{videoCodec: "h264", pixFmt: "yuv420p10le", audioCodecs: []string{"mp3"}}
	if a := ffmpegArgs("/s", "/d", ten); !has(a, "-c:v", "libx264") || !has(a, "-c:a", "aac") {
		t.Errorf("10-bit h264 + mp3 not re-encoded: %v", a)
	}
	if a := ffmpegArgs("/s", "/d", ten); !has(a, "-map", "0:a?") || !has(a, "-i", "file:/s") {
		t.Errorf("must keep every audio track and read through file: %v", a)
	}
}
