package main

// =============================================================================
// orderedJSON - a JSON object that remembers the order of its keys.
// =============================================================================
//
// Every settings file this server rewrites was written by Python, whose dicts
// keep insertion order: read a file, change one field, write it back, and the
// other keys stay exactly where they were.
//
// A Go map cannot do that. `for k := range m` is deliberately randomised, and
// encoding/json sorts map keys alphabetically on the way out - so the first
// time the Go server saved a config.json, every key jumped to a new line even
// though nothing about it had changed. Nothing BREAKS, but this project has no
// version control: the .gz sidecars and the hand-made copies in .bak/ are the
// only history there is, and a diff that reorders a whole file to record a
// one-word change destroys that history's usefulness.
//
// So the files keep their shape:
//
//	config/server.json          the whole thing
//	homes/<user>/data/config.json
//	.trash/index.json           (see trashIndex, which predates this and stays
//	                             typed because its values are all one shape)
//
// java: this is LinkedHashMap<String, RawJson>, plus the two methods
// encoding/json looks for. There is no annotation and no ObjectMapper module to
// register: a type that implements MarshalJSON / UnmarshalJSON simply IS its
// own codec, anywhere it appears.

import (
	"bytes"
	"encoding/json"
	"errors"
)

// orderedJSON is a JSON object whose keys come out in the order they went in.
type orderedJSON struct {
	order []string
	rows  map[string]json.RawMessage
}

func newOrderedJSON() *orderedJSON {
	return &orderedJSON{rows: make(map[string]json.RawMessage)}
}

// Get is the raw value for a key, and whether it was there at all.
func (o *orderedJSON) Get(key string) (json.RawMessage, bool) {
	if o == nil || o.rows == nil {
		return nil, false
	}
	raw, found := o.rows[key]
	return raw, found
}

// Set stores an already-encoded value, keeping an existing key in place and
// appending a new one at the end - exactly what Python's `d[k] = v` does.
func (o *orderedJSON) Set(key string, raw json.RawMessage) {
	if o.rows == nil {
		o.rows = make(map[string]json.RawMessage)
	}
	if _, found := o.rows[key]; !found {
		o.order = append(o.order, key)
	}
	o.rows[key] = raw
}

// Put encodes `value` and stores it. An unencodable value is dropped rather
// than failing the whole write: no single setting is worth losing the file for.
func (o *orderedJSON) Put(key string, value any) {
	if raw, err := json.Marshal(value); err == nil {
		o.Set(key, raw)
	}
}

// Remove deletes a key, and is a no-op when it was not there.
func (o *orderedJSON) Remove(key string) {
	if o == nil || o.rows == nil {
		return
	}
	if _, found := o.rows[key]; !found {
		return
	}
	delete(o.rows, key)
	kept := o.order[:0]
	for _, k := range o.order {
		if k != key {
			kept = append(kept, k)
		}
	}
	o.order = kept
}

// Keys is the key list in file order.
func (o *orderedJSON) Keys() []string {
	if o == nil {
		return nil
	}
	out := make([]string, len(o.order))
	copy(out, o.order)
	return out
}

// Fields is the plain map, for the readers that only look things up.
func (o *orderedJSON) Fields() map[string]json.RawMessage {
	if o == nil || o.rows == nil {
		return map[string]json.RawMessage{}
	}
	return o.rows
}

// Clone is a copy that can be modified without touching the original.
func (o *orderedJSON) Clone() *orderedJSON {
	out := newOrderedJSON()
	if o == nil {
		return out
	}
	for _, k := range o.order {
		out.Set(k, o.rows[k])
	}
	return out
}

// UnmarshalJSON captures the order the keys appear in the file.
//
// java: a Decoder read TOKEN BY TOKEN is the only way to see the raw key
// sequence - unmarshalling into a map throws it away before you can look.
func (o *orderedJSON) UnmarshalJSON(data []byte) error {
	o.order = nil
	o.rows = make(map[string]json.RawMessage)

	dec := json.NewDecoder(bytes.NewReader(data))
	open, err := dec.Token()
	if err != nil {
		return err
	}
	if delim, ok := open.(json.Delim); !ok || delim != '{' {
		return errors.New("not a JSON object")
	}
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return err
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("a key is not a string")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		o.Set(key, raw)
	}
	_, err = dec.Token() // the closing brace
	return err
}

// MarshalJSON writes the keys back in that same order.
func (o orderedJSON) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, key := range o.order {
		if i > 0 {
			buf.WriteByte(',')
		}
		encoded, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		buf.Write(encoded)
		buf.WriteByte(':')
		buf.Write(o.rows[key])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// loadOrderedJSON reads one settings file. A missing, unreadable or malformed
// file - or valid JSON that is not an object - reads as empty, never as an
// error.
func loadOrderedJSON(path string) *orderedJSON {
	out := newOrderedJSON()
	if !loadJSONFile(path, out) {
		return newOrderedJSON()
	}
	return out
}
