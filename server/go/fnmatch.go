package main

// =============================================================================
// fnmatch - Python's shell-style wildcard matcher, ported.
// =============================================================================
//
// The Drive search box documents its rules as "* ? [seq] [!seq]", which is
// Python's fnmatch.fnmatchcase. Go's path.Match looks similar and is NOT the
// same thing:
//
//	path.Match     "*" stops at a "/", negation is written "[^x]", and a
//	               malformed pattern is an ERROR rather than "no match".
//	fnmatch        "*" matches everything including "/", negation is "[!x]",
//	               and an unterminated "[" is a literal "[".
//
// Only the basename is ever matched here, so the "/" difference does not bite -
// but "[!x]" and the error behaviour would, and a user typing "[" into the
// search box must get no results, not a 500. So the matcher is written out.
//
// java: this is a straight backtracking matcher over runes. It is ~50 lines and
// has no dependencies, which is the whole point.

// fnmatch reports whether `name` matches the shell-style `pattern`. Both are
// expected to be lowercased by the caller when a case-insensitive match is
// wanted, exactly as filetree.Search does.
func fnmatch(name, pattern string) bool {
	return matchRunes([]rune(name), []rune(pattern))
}

func matchRunes(name, pat []rune) bool {
	// java: the classic two-cursor algorithm with one remembered "*" position,
	// so backtracking costs no recursion. star/mark hold where to resume when a
	// later mismatch means the "*" should have swallowed one more character.
	var (
		n, p       int
		star, mark = -1, 0
	)

	for n < len(name) {
		switch {
		case p < len(pat) && pat[p] == '*':
			star, mark = p, n
			p++
		case p < len(pat) && matchOne(name[n], pat, &p):
			n++
		case star >= 0:
			// Mismatch, but a "*" is open: let it eat one more character.
			p = star + 1
			mark++
			n = mark
		default:
			return false
		}
	}

	// Trailing "*"s may match the empty string.
	for p < len(pat) && pat[p] == '*' {
		p++
	}
	return p == len(pat)
}

// matchOne tests ONE character of `name` against the pattern element starting at
// *p, and advances *p past that element. It never sees a "*".
func matchOne(c rune, pat []rune, p *int) bool {
	switch pat[*p] {
	case '?':
		*p++
		return true
	case '[':
		return matchClass(c, pat, p)
	default:
		ok := pat[*p] == c
		*p++
		return ok
	}
}

// matchClass handles "[abc]", "[a-z]" and the negated "[!abc]".
//
// An unterminated "[" is a LITERAL "[", which is what Python does and why a
// stray bracket in the search box finds nothing instead of erroring.
func matchClass(c rune, pat []rune, p *int) bool {
	end := findClassEnd(pat, *p)
	if end < 0 {
		ok := c == '['
		*p++
		return ok
	}

	i := *p + 1
	negate := false
	if i < end && pat[i] == '!' {
		negate = true
		i++
	}

	hit := false
	for i < end {
		// A range needs three characters and a "-" that is not the last one.
		if i+2 < end && pat[i+1] == '-' {
			if c >= pat[i] && c <= pat[i+2] {
				hit = true
			}
			i += 3
			continue
		}
		if pat[i] == c {
			hit = true
		}
		i++
	}

	*p = end + 1
	return hit != negate
}

// findClassEnd is the index of the "]" closing the class that opens at `start`,
// or -1 when there is none. A "]" as the FIRST character of the class is a
// literal one ("[]]" is the class containing "]"), same as Python.
func findClassEnd(pat []rune, start int) int {
	i := start + 1
	if i < len(pat) && pat[i] == '!' {
		i++
	}
	if i < len(pat) && pat[i] == ']' {
		i++
	}
	for ; i < len(pat); i++ {
		if pat[i] == ']' {
			return i
		}
	}
	return -1
}
