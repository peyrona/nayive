package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestConvertCapClamped: the length comes from the file itself, so a video
// that claims to last years still gets one day at most.
func TestConvertCapClamped(t *testing.T) {
	for _, d := range []float64{1e8, 1e12, 1e300} {
		if got := convertCap(d); got != convertMaxCap {
			t.Errorf("convertCap(%g s) = %v, want %v", d, got, convertMaxCap)
		}
	}
}

// TestFFmpegStallIsKilled: an ffmpeg whose progress stops moving is killed
// long before its time cap.
func TestFFmpegStallIsKilled(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "ffmpeg")
	script := "#!/bin/sh\nfor i in 1 2 3 4 5 6 7 8 9 10; do echo out_time_us=1000; echo progress=continue; sleep 0.2; done\nexec sleep 30\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	oldCap, oldStall := convertMinCap, convertStall
	convertMinCap, convertStall = time.Hour, 500*time.Millisecond
	t.Cleanup(func() { convertMinCap, convertStall = oldCap, oldStall })

	c := &Converter{ffmpeg: fake}
	done := make(chan error, 1)
	go func() { done <- c.runFFmpeg(context.Background(), nil, 60) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a stalled ffmpeg reported success")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a stalled ffmpeg was not killed")
	}
}

// TestFFmpegMovingIsNotKilled: progress that keeps moving is never a stall,
// even when it takes longer than the stall limit in all.
func TestFFmpegMovingIsNotKilled(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "ffmpeg")
	script := "#!/bin/sh\nfor i in 1 2 3 4 5 6 7 8 9 10; do echo out_time_us=${i}000000; sleep 0.1; done\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	oldStall := convertStall
	convertStall = 400 * time.Millisecond
	t.Cleanup(func() { convertStall = oldStall })

	c := &Converter{ffmpeg: fake}
	if err := c.runFFmpeg(context.Background(), nil, 10); err != nil {
		t.Fatalf("a moving ffmpeg failed: %v", err)
	}
}
