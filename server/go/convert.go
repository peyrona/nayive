package main

// =============================================================================
// Converting a video browsers cannot play into an .mp4, on the server.
// =============================================================================
//
// Drive offers it when a user UPLOADS such a file: the upload itself carries
// "&convert=mp4" (see upload.go), and this queue takes it from there. There is
// no way to ask for a file already on the server - his call. The plan and the
// decisions behind it: docs/avi-to-mp4.md.
//
// ONE QUEUE, ONE FILM AT A TIME, FOR THE WHOLE SERVER. The VPS has one CPU
// core. ffmpeg runs at the lowest priority (nice 19) so web requests still
// win it, but two at once would only make both twice as slow.
//
// THE ORIGINAL IS NOT TOUCHED UNTIL THE MP4 IS PROVEN. ffmpeg writes to a
// hidden temp in the same folder (".convert-" + 8 chars, mode 0600 - the shape
// SweepStaleTemp removes after a crash). Only when ffmpeg exits 0 AND ffprobe
// says the result lasts as long as the original is the temp renamed to
// "<name>.mp4" and the original moved to the papelera. Any failure leaves the
// original where it was.
//
// THE QUEUE SURVIVES A RESTART. config/convert.json holds it; a job cut short
// by a restart starts again from zero - its original is still in place.
//
// When a job ends, every device of that user gets a push ("Película
// convertida" / "No se pudo convertir") through the same deliverPush the
// reminders use.
//
// java: mu guards the queue - Enqueue and Status run on request goroutines, the
// worker on its own. The phrasebook is the worker's alone.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// convertExts are the video formats Drive offers to convert. .mkv and .mov
// often DO play (when the video inside is H.264); they are here on purpose
// (his call, 2026-09-11), and for those the job is usually a fast copy - see
// ffmpegArgs. Keep apps/drive's CONVERT_EXT the same list.
var convertExts = map[string]bool{
	".avi": true, ".divx": true, ".wmv": true, ".asf": true, ".flv": true, ".f4v": true,
	".mpg": true, ".mpeg": true, ".vob": true, ".ts": true, ".m2ts": true, ".mts": true,
	".3gp": true, ".rm": true, ".rmvb": true, ".ogm": true, ".mkv": true, ".mov": true,
}

// IsConvertible is true for a name with one of convertExts, any case.
func IsConvertible(name string) bool {
	return convertExts[strings.ToLower(filepath.Ext(name))]
}

const (
	convertTTL   = 24 * 60 * 60 // a push waits up to a day for a sleeping phone
	convertSlack = 2.0          // seconds the mp4 may differ from the original
	convertNice  = 19           // the lowest CPU priority there is
)

// ConvertJob is one queued file, as config/convert.json stores it.
type ConvertJob struct {
	User  string `json:"user"`
	Path  string `json:"path"` // the virtual path: "files/Pelis/x.avi"
	Added int64  `json:"added"`
}

// ConvertStatus is one job as GET /api/convert shows it.
type ConvertStatus struct {
	Path    string `json:"path"`
	State   string `json:"state"`   // "queued" | "running"
	Percent int    `json:"percent"` // 0-99, while running
}

// Converter is the queue and its one worker.
type Converter struct {
	ffmpeg, ffprobe string // "" = not installed: the feature is off
	nice            string // /usr/bin/nice, or "" (then Setpriority after start)
	file            string // config/convert.json
	users           *Users
	trash           *Trash
	push            *VapidStore
	log             Logger
	phrases         *phrasebook // the worker's only

	mu      sync.Mutex
	queue   []ConvertJob // queue[0] is the one running, while running is true
	running bool
	percent int
	wake    chan struct{}
}

func NewConverter(cfg *Config, users *Users, trash *Trash, push *VapidStore, log Logger) *Converter {
	c := &Converter{
		file:    filepath.Join(cfg.ConfigDir, "convert.json"),
		users:   users,
		trash:   trash,
		push:    push,
		log:     log,
		phrases: newPhrasebook(cfg.AppsDir),
		wake:    make(chan struct{}, 1),
	}
	// Both or neither: without ffprobe nothing can be checked, and an
	// unchecked mp4 must never cost the user the original.
	ff, err1 := exec.LookPath("ffmpeg")
	fp, err2 := exec.LookPath("ffprobe")
	if err1 == nil && err2 == nil {
		c.ffmpeg, c.ffprobe = ff, fp
	}
	if n, err := exec.LookPath("nice"); err == nil {
		c.nice = n
	}

	var saved struct {
		Queue []ConvertJob `json:"queue"`
	}
	loadJSONFile(c.file, &saved)
	for _, j := range saved.Queue {
		if j.User != "" && j.Path != "" {
			c.queue = append(c.queue, j)
		}
	}
	return c
}

// Available says whether ffmpeg and ffprobe are installed.
func (c *Converter) Available() bool { return c.ffmpeg != "" }

// Enqueue adds one uploaded file. The same path twice is one job. False when
// the feature is off.
func (c *Converter) Enqueue(user, rel string) bool {
	if !c.Available() {
		return false
	}
	c.mu.Lock()
	for _, j := range c.queue {
		if j.User == user && j.Path == rel {
			c.mu.Unlock()
			return true
		}
	}
	c.queue = append(c.queue, ConvertJob{User: user, Path: rel, Added: time.Now().Unix()})
	c.saveLocked()
	c.mu.Unlock()

	c.log.Info("convert: queued", "user", user, "path", rel)
	select {
	case c.wake <- struct{}{}:
	default: // the worker is already awake
	}
	return true
}

// Status is this user's jobs, oldest first.
func (c *Converter) Status(user string) []ConvertStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []ConvertStatus{}
	for i, j := range c.queue {
		if j.User != user {
			continue
		}
		st := ConvertStatus{Path: j.Path, State: "queued"}
		if i == 0 && c.running {
			st.State, st.Percent = "running", c.percent
		}
		out = append(out, st)
	}
	return out
}

func (c *Converter) saveLocked() {
	if err := atomicWriteJSON(c.file, map[string]any{"queue": c.queue}, 1); err != nil {
		c.log.Error("convert: could not save the queue", "file", c.file, "err", err)
	}
}

func (c *Converter) setPercent(p int) {
	c.mu.Lock()
	c.percent = p
	c.mu.Unlock()
}

// Run works the queue until `ctx` is cancelled. Start it once from main.
func (c *Converter) Run(ctx context.Context) {
	if !c.Available() {
		return
	}
	for {
		c.mu.Lock()
		var job ConvertJob
		have := len(c.queue) > 0
		if have {
			job = c.queue[0]
			c.running, c.percent = true, 0
		}
		c.mu.Unlock()

		if !have {
			select {
			case <-ctx.Done():
				return
			case <-c.wake:
			}
			continue
		}

		c.runOne(ctx, job)
		if ctx.Err() != nil {
			return // shutting down: the job stays queued and starts again next boot
		}

		c.mu.Lock()
		c.running = false
		if len(c.queue) > 0 && c.queue[0] == job {
			c.queue = c.queue[1:]
		}
		c.saveLocked()
		c.mu.Unlock()
	}
}

// runOne converts one job and tells the user how it went.
//
// java: an unrecovered panic in a goroutine kills the whole process - see
// Reminders.safeTick. One odd file must cost only its own job.
func (c *Converter) runOne(ctx context.Context, job ConvertJob) {
	defer func() {
		if err := recover(); err != nil {
			c.log.Error("convert: crashed", "path", job.Path, "err", err)
			c.notify(job, "")
		}
	}()

	c.log.Info("convert: started", "user", job.User, "path", job.Path)
	out, err := c.convert(ctx, job)
	if ctx.Err() != nil {
		return // stopped, not failed: no push
	}
	if err != nil {
		c.log.Warn("convert: failed", "user", job.User, "path", job.Path, "err", err)
		c.notify(job, "")
		return
	}
	c.log.Info("convert: done", "user", job.User, "path", job.Path, "mp4", out)
	c.notify(job, out)
}

// convert does the work and returns the new file's virtual path.
func (c *Converter) convert(ctx context.Context, job ConvertJob) (string, error) {
	// Checked AGAIN now, not only at upload: the file may have been moved,
	// renamed or shared since.
	if IsSharedPath(job.Path) || !IsConvertible(job.Path) {
		return "", errors.New("not a file this can convert")
	}
	src, ok := c.users.Resolve("user", job.User, job.Path)
	if !ok || !src.Writable {
		return "", errors.New("forbidden")
	}
	info, err := src.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("the file is gone")
	}

	// The original AND the mp4 exist until the end; count on the mp4 being
	// about as big as the original.
	if q := c.users.UserQuotaBytes(job.User); q != nil &&
		*q-c.users.UserUsageBytes(job.User) < info.Size() {
		return "", errors.New("no room in the quota for the mp4")
	}
	if free := freeBytes(filepath.Dir(src.Abs)); free >= 0 && free < info.Size() {
		return "", errors.New("no room on the disk for the mp4")
	}

	before, err := c.probe(ctx, src.Abs)
	if err != nil {
		return "", fmt.Errorf("ffprobe: %w", err)
	}
	if !before.hasVideo || before.duration <= 0 {
		return "", errors.New("no video stream, or no duration")
	}

	root, err := src.open()
	if err != nil {
		return "", err
	}
	defer root.Close()

	dir := filepath.Dir(src.Rel)
	tmp, tmpRel, err := createTempNamed(root, dir, ".convert-")
	if err != nil {
		return "", err
	}
	tmp.Close()
	defer root.Remove(tmpRel) // a no-op once it has been renamed away

	// ffmpeg is handed absolute paths, the only thing it takes. Both sit
	// inside the root just resolved: the original, and the temp made through
	// it a moment ago.
	tmpAbs := filepath.Join(src.Root, tmpRel)
	if err := c.runFFmpeg(ctx, ffmpegArgs(src.Abs, tmpAbs, before), before.duration); err != nil {
		return "", err
	}

	after, err := c.probe(ctx, tmpAbs)
	if err != nil {
		return "", fmt.Errorf("ffprobe on the mp4: %w", err)
	}
	if !after.hasVideo || math.Abs(after.duration-before.duration) > convertSlack {
		return "", fmt.Errorf("the mp4 does not check out: %.1f s, the original %.1f s",
			after.duration, before.duration)
	}

	if err := root.Chmod(tmpRel, 0o644); err != nil {
		return "", err
	}
	outRel := freeMP4Name(root, src.Rel)
	if err := root.Rename(tmpRel, outRel); err != nil {
		return "", err
	}
	if st, err := root.Stat(outRel); err == nil {
		c.users.AdjustUsage(job.User, st.Size())
	}

	// Only now, with the mp4 in place and proven, does the original go. A
	// failure here is not a failed conversion: the user has the mp4 and still
	// has the original.
	if _, err := c.trash.MoveIn("user", job.User, src, job.Path); err != nil {
		c.log.Warn("convert: the mp4 is ready but the original could not go to the papelera",
			"path", job.Path, "err", err)
	}
	return path.Join(path.Dir(job.Path), filepath.Base(outRel)), nil
}

// freeMP4Name is "<name>.mp4" beside the original, or "<name> (1).mp4" and so
// on when that is taken. Never an existing file: nothing is overwritten.
func freeMP4Name(root *os.Root, srcRel string) string {
	dir := filepath.Dir(srcRel)
	base := strings.TrimSuffix(filepath.Base(srcRel), filepath.Ext(srcRel))
	for n := 0; ; n++ {
		name := base + ".mp4"
		if n > 0 {
			name = base + " (" + strconv.Itoa(n) + ").mp4"
		}
		rel := filepath.Join(dir, name)
		if _, err := root.Lstat(rel); errors.Is(err, os.ErrNotExist) {
			return rel
		}
	}
}

// freeBytes is the space left on the disk holding `dir`, or -1 when unknown.
func freeBytes(dir string) int64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return -1
	}
	return int64(st.Bavail) * int64(st.Bsize)
}

// -----------------------------------------------------------------------------
// ffprobe and ffmpeg
// -----------------------------------------------------------------------------

type probeInfo struct {
	duration    float64 // seconds
	hasVideo    bool
	videoCodec  string // of the first real video stream (not a cover picture)
	pixFmt      string
	audioCodecs []string
}

// videoCopyable: H.264 in 8-bit 4:2:0 plays in every browser, so it is copied
// as it is - a remux of a whole film takes seconds, not an hour. (H.264 "High
// 10" - yuv420p10le - does not play in most browsers and is re-encoded.)
func (p probeInfo) videoCopyable() bool {
	return p.videoCodec == "h264" && (p.pixFmt == "yuv420p" || p.pixFmt == "yuvj420p")
}

// audioCopyable: every audio track is already AAC (no tracks is fine too).
func (p probeInfo) audioCopyable() bool {
	for _, a := range p.audioCodecs {
		if a != "aac" {
			return false
		}
	}
	return true
}

func (c *Converter) probe(ctx context.Context, abs string) (probeInfo, error) {
	raw, err := exec.CommandContext(ctx, c.ffprobe, "-v", "error",
		"-protocol_whitelist", "file",
		"-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt:stream_disposition=attached_pic",
		"-of", "json", "file:"+abs).Output()
	if err != nil {
		return probeInfo{}, err
	}
	var doc struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			CodecType   string `json:"codec_type"`
			CodecName   string `json:"codec_name"`
			PixFmt      string `json:"pix_fmt"`
			Disposition struct {
				AttachedPic int `json:"attached_pic"`
			} `json:"disposition"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return probeInfo{}, err
	}
	var p probeInfo
	p.duration, _ = strconv.ParseFloat(doc.Format.Duration, 64)
	for _, s := range doc.Streams {
		switch {
		case s.CodecType == "video" && s.Disposition.AttachedPic == 0 && !p.hasVideo:
			p.hasVideo, p.videoCodec, p.pixFmt = true, s.CodecName, s.PixFmt
		case s.CodecType == "audio":
			p.audioCodecs = append(p.audioCodecs, s.CodecName)
		}
	}
	return p, nil
}

// ffmpegArgs is the whole command line after "ffmpeg".
//
//   - "file:" in front of both paths: a name with a ":" can never be read as a
//     protocol, and -protocol_whitelist stops the input pulling in URLs.
//   - 0:V:0 is the first REAL video stream (capital V skips a cover picture);
//     0:a? is every audio track - his films carry two languages - and the "?"
//     lets a silent video through.
//   - +faststart puts the index at the front, so a film starts playing before
//     it has fully loaded.
//   - The scale filter only rounds an odd width/height down to even, which
//     4:2:0 H.264 needs; every normal video passes through unchanged.
func ffmpegArgs(src, dst string, p probeInfo) []string {
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error",
		"-protocol_whitelist", "file,pipe",
		"-i", "file:" + src,
		"-map", "0:V:0", "-map", "0:a?"}
	if p.videoCopyable() {
		args = append(args, "-c:v", "copy")
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
			"-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2")
	}
	if p.audioCopyable() {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "aac", "-b:a", "160k")
	}
	return append(args, "-movflags", "+faststart", "-f", "mp4",
		"-progress", "pipe:1", "-nostats", "-y", "file:"+dst)
}

// runFFmpeg runs it at the lowest priority and turns its progress lines into
// the percent GET /api/convert shows.
func (c *Converter) runFFmpeg(ctx context.Context, args []string, duration float64) error {
	var cmd *exec.Cmd
	if c.nice != "" {
		// nice sets the priority BEFORE ffmpeg starts, so every thread it makes
		// inherits it. (Linux priorities are per thread.)
		cmd = exec.CommandContext(ctx, c.nice, append([]string{"-n", strconv.Itoa(convertNice), c.ffmpeg}, args...)...)
	} else {
		cmd = exec.CommandContext(ctx, c.ffmpeg, args...)
	}
	stderr := &tailBuffer{max: 2048}
	cmd.Stderr = stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	if c.nice == "" {
		syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, convertNice)
	}

	// "out_time_us=" (and the older, misnamed "out_time_ms=") are both in
	// microseconds.
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		line := sc.Text()
		v, ok := strings.CutPrefix(line, "out_time_us=")
		if !ok {
			v, ok = strings.CutPrefix(line, "out_time_ms=")
		}
		if !ok {
			continue
		}
		if us, err := strconv.ParseInt(v, 10, 64); err == nil && us > 0 {
			c.setPercent(min(99, int(float64(us)/(duration*1e6)*100)))
		}
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("ffmpeg: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// tailBuffer keeps the last `max` bytes written to it: the end of ffmpeg's
// error output is what explains a failure.
type tailBuffer struct {
	max int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string { return string(t.buf) }

// -----------------------------------------------------------------------------
// telling the user
// -----------------------------------------------------------------------------

// notify pushes "ready" (outPath set) or "failed" (outPath "") to every device
// of the job's user. Tapping it opens Drive with the file selected.
func (c *Converter) notify(job ConvertJob, outPath string) {
	name, sel := path.Base(job.Path), job.Path
	if outPath != "" {
		name, sel = path.Base(outPath), outPath
	}
	link := URLPrefix + "/drive/?sel=" + url.QueryEscape(sel)

	for _, sub := range c.users.UserPush(job.User).Subs {
		var title, body string
		if outPath != "" {
			title = c.phrases.phrase(sub.Lang, "push.convertDoneTitle", "Película convertida")
			body = c.phrases.phrase(sub.Lang, "push.convertDoneBody", "«{name}» ya se puede ver.")
		} else {
			title = c.phrases.phrase(sub.Lang, "push.convertFailedTitle", "No se pudo convertir")
			body = c.phrases.phrase(sub.Lang, "push.convertFailedBody",
				"«{name}» no se pudo convertir. El original sigue en su sitio.")
		}
		// A plain Replace, never a format call - see Reminders.eventText.
		body = strings.NewReplacer("{name}", ellipsis(name)).Replace(body)
		payload := map[string]string{
			"title": title,
			"body":  body,
			"url":   link,
			"tag":   "convert:" + job.Path, // its own tag: never replaces a calendar reminder
		}
		deliverPush(c.push, c.users, c.log, job.User, sub, payload, convertTTL)
	}
}
