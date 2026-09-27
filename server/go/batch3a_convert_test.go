package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestFFmpegHangIsKilled: an ffmpeg that never ends is killed at the job's cap,
// so it cannot hold the one queue for good.
func TestFFmpegHangIsKilled(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "ffmpeg")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := convertMinCap
	convertMinCap = 200 * time.Millisecond
	t.Cleanup(func() { convertMinCap = old })

	c := &Converter{ffmpeg: fake} // no nice: the fake is run directly
	done := make(chan error, 1)
	go func() { done <- c.runFFmpeg(context.Background(), nil, 0.01) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a killed ffmpeg reported success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ffmpeg ran past its time cap")
	}
}

// TestConvertCap: four times the video, never under the floor.
func TestConvertCap(t *testing.T) {
	if got := convertCap(10); got != convertMinCap {
		t.Errorf("convertCap(10 s) = %v, want the floor %v", got, convertMinCap)
	}
	if got := convertCap(3 * 3600); got != 12*time.Hour {
		t.Errorf("convertCap(3 h) = %v, want 12h", got)
	}
}
