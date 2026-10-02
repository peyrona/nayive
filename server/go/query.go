package main

// =============================================================================
// Query - the query string, with its blank values dropped.
// =============================================================================
//
// This tiny type exists because the file API tests for PRESENCE - is there a
// "dir", is there a "trash" - and a blank value must count as absent:
//
//	"?dir="      no key -> falls through to the whole-tree answer
//	             (url.ParseQuery alone keeps it, as "": the root's children)
//
// So every blank value is filtered out ONCE, here, and every route reads the
// query through this type. "?dir=&dir=x" keeps the "x".

import "net/http"

// Query is the request's query string with blank values removed.
type Query map[string][]string

// cleanQuery parses r.URL.RawQuery and drops every blank value.
func cleanQuery(r *http.Request) Query {
	out := Query{}
	for key, values := range r.URL.Query() {
		kept := make([]string, 0, len(values))
		for _, v := range values {
			if v != "" {
				kept = append(kept, v)
			}
		}
		if len(kept) > 0 {
			out[key] = kept
		}
	}
	return out
}

// Has reports whether the key was given with a non-blank value.
func (q Query) Has(key string) bool { return len(q[key]) > 0 }

// Get is the first value for `key`, or "".
func (q Query) Get(key string) string {
	if v := q[key]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// All is every value for `key` - what "?paths=a&paths=b" needs.
func (q Query) All(key string) []string { return q[key] }

// queryValue is Get for a route that needs only one parameter and no presence
// test.
func queryValue(r *http.Request, key string) string {
	return r.URL.Query().Get(key)
}
