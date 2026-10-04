// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.

package main

// =============================================================================
// ETag - a file's version tag.
// =============================================================================
//
// A file's Last-Modified is whole seconds, and some writers keep an OLD time
// (a bin restore, a move, a zip extract) or change the file inside the second
// a page already holds (a direct write, the Office twin). A save checked by
// If-Unmodified-Since then passed over a file it had never seen (data-safety
// B1-B3). The tag below changes on every one of those writes.
//
// THE TAG: `"<inode>-<size>-<mtime in ns>"`, hex, strong. It changes on every
// write: a PUT, the twin, a server write go through temp + rename (a new
// inode); a restore or a move puts ANOTHER file at the path (another inode);
// an extract makes a new file; a write in place moves the time (ns). It stays
// the same when the SAME file is renamed or moved inside the disk (inode,
// size and time kept), so a page may carry it to the new name. It names the
// file's version, not the bytes on the wire: a gzipped answer carries it too.
//
// THE CONTRACT (the browser half - store.js, gum-api.js - is built on it):
//
//	GET/HEAD ?file=   ETag + Last-Modified. If-None-Match: 304 only when one
//	                  listed tag is the file's (W/ ignored); when it is sent,
//	                  If-Modified-Since is not looked at. If-Modified-Since
//	                  alone: as before, to the second.
//	PUT ?file=        answers the NEW file's ETag + Last-Modified (taken under
//	                  the path's lock, so it is this save's file).
//	  If-Match: "t"   (or a list) the file at the path must be that version;
//	                  else 412 and nothing is written. Checked before the body
//	                  AND again at the rename. Strong: a W/ tag never passes.
//	  If-Match: *     there must be a file there.
//	                  No file at the path: 412 for both forms (RFC 9110
//	                  13.1.1) - the page merges ("theirs missing") or offers
//	                  to save a copy.
//	                  A value that holds no tag at all - an EMPTY one too:
//	                  412 (see ifMatchPasses). Send it only with a tag held.
//	  If-Unmodified-Since   only when no If-Match is sent (RFC 9110 13.2.2):
//	                  pages loaded before the tag, judged exactly as before.
//	  If-None-Match: *      create only (upload.go createOnly), unchanged.
//
// Known limits, for the reader who wonders: a write IN PLACE (same inode) of
// the same size inside one tick of the kernel's file clock (a few ms) is not
// seen - the server writes the apps' files by temp + rename, so only a hand
// edit on the disk could do that; and a filesystem with whole-second times (FAT) sees
// only what the inode and size show.

import (
	"fmt"
	"net/http"
	"os"
	"strings"
)

// fileETag is the strong version tag of a file (see above). The size and the
// time go in as unsigned, so a pre-1970 date from a zip cannot put a "-" sign
// into the tag.
func fileETag(info os.FileInfo) string {
	return fmt.Sprintf(`"%x-%x-%x"`, fileID(info), uint64(info.Size()), uint64(info.ModTime().UnixNano()))
}

// etagList splits an If-Match / If-None-Match value into its entity tags,
// each with its quotes and its W/ when weak. Scanned, not split on commas: a
// comma is legal inside a tag. Stops at the first thing that is not a tag.
func etagList(header string) []string {
	var out []string
	s := header
	for {
		s = strings.TrimLeft(s, " \t,")
		if s == "" {
			return out
		}
		weak := ""
		if strings.HasPrefix(s, "W/") {
			weak, s = "W/", s[2:]
		}
		if !strings.HasPrefix(s, `"`) {
			return out
		}
		end := strings.IndexByte(s[1:], '"')
		if end < 0 {
			return out
		}
		out = append(out, weak+s[:end+2])
		s = s[end+2:]
	}
}

// ifMatchHeader is the request's If-Match, every copy of the header joined;
// `sent` false when there is none.
func ifMatchHeader(r *http.Request) (string, bool) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 {
		return "", false
	}
	return strings.Join(values, ","), true
}

// ifMatchPasses decides a PUT's If-Match against the file now at the path
// (`info`; nil when there is none). Strong comparison: a W/ tag never passes
// a write. No file, or not a regular one, never passes - "*" included.
//
// A value that holds no tag at all ("abc", a half-quoted tag) is FALSE, not
// "no check" as a garbled If-Unmodified-Since is: the page meant this save to
// be conditional, and a condition it cannot have meant is no reason to write
// over the file.
func ifMatchPasses(header string, info os.FileInfo) bool {
	if info == nil || !info.Mode().IsRegular() {
		return false
	}
	if strings.TrimSpace(header) == "*" {
		return true
	}
	current := fileETag(info)
	for _, tag := range etagList(header) {
		if tag == current {
			return true
		}
	}
	return false
}

// noneMatchHit is a GET's If-None-Match against the answer's tag: weak
// comparison (RFC 9110 13.1.2), so W/"x" matches "x". "*" matches any file
// there is. No tag to compare with (`etag` ""): only "*" matches.
func noneMatchHit(header, etag string) bool {
	if strings.TrimSpace(header) == "*" {
		return true
	}
	if etag == "" {
		return false
	}
	want := strings.TrimPrefix(etag, "W/")
	for _, tag := range etagList(header) {
		if strings.TrimPrefix(tag, "W/") == want {
			return true
		}
	}
	return false
}
