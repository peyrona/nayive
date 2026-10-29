package main

// Data-safety seal: a Nayive account put in a group with no 1:1 chat in the
// owner's home (ChatContact.Group).
//   G1 it gets a contact in the owner's home, made once; no 1:1 shows or
//      takes messages on either side
//   G2 a later 1:1 keeps one chat per pair: the other home's, or the same
//      contact turned into a normal one

import "testing"

// TestDS_ChatGroupOnlyContact: an account goes into a group with no 1:1 chat in the
// owner's home - even when their 1:1 lives in the other home. Starting a 1:1
// later keeps one chat per pair.
func TestDS_ChatGroupOnlyContact(t *testing.T) {
	f := newChatFixture(t)
	f.addHome(t, "carla", "ccc")
	beto := f.signedIn(t, "beto", "xyz")
	carla := f.signedIn(t, "carla", "ccc")

	// beto started his 1:1 with ana: it lives in beto's home.
	var bst chatUserStart
	f.call(t, beto, "POST", "/api/chat/contacts", `{"user":"ana"}`, 201, &bst)

	// ana puts beto (1:1 in his home) and carla (no chat yet) in a group.
	var gb, gc chatUserStart
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto","group":true}`, 201, &gb)
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"carla","group":true}`, 201, &gc)
	if gb.Contact == nil || !gb.Contact.Group || gc.Contact == nil || !gc.Contact.Group {
		t.Fatalf("group-only starts = %+v %+v", gb.Contact, gc.Contact)
	}
	var again chatUserStart // asked twice: the same contact
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto","group":true}`, 200, &again)
	if again.Contact == nil || again.Contact.ID != gb.Contact.ID {
		t.Fatalf("group-only again = %+v", again.Contact)
	}
	var g struct{ ID string }
	f.call(t, f.owner, "POST", "/api/chat/groups",
		`{"name":"Amigos","members":["`+gb.Contact.ID+`","`+gc.Contact.ID+`"]}`, 201, &g)

	// No 1:1 shows for them in ana's home, on either side; the group does.
	var asum struct{ Convs []chatConvOut }
	f.call(t, f.owner, "GET", "/api/chat", "", 200, &asum)
	for _, c := range asum.Convs {
		if c.ID == "d-"+gb.Contact.ID || c.ID == "d-"+gc.Contact.ID {
			t.Fatalf("ana lists a group-only 1:1: %s", c.ID)
		}
	}
	var vsum struct{ Convs []chatConvOut }
	f.call(t, carla, "GET", "/api/chat/via/ana", "", 200, &vsum)
	if len(vsum.Convs) != 1 || vsum.Convs[0].ID != "g-"+g.ID {
		t.Fatalf("carla's view of ana's home = %+v", vsum.Convs)
	}
	f.call(t, carla, "POST", "/api/chat/via/ana/conv/g-"+g.ID+"/messages", `{"kind":"text","text":"hola"}`, 201, nil)
	f.call(t, carla, "POST", "/api/chat/via/ana/conv/d-"+gc.Contact.ID+"/messages", `{"kind":"text","text":"x"}`, 403, nil)

	// A 1:1 with beto is still his chat, in his home...
	var one chatUserStart
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"beto"}`, 200, &one)
	if one.Via != "beto" || one.Conv != bst.Conv {
		t.Fatalf("ana's 1:1 with beto = %+v", one)
	}
	// ...and with carla it starts in ana's home, on the same contact.
	f.call(t, f.owner, "POST", "/api/chat/contacts", `{"user":"carla"}`, 200, &one)
	if one.Via != "" || one.Contact == nil || one.Contact.ID != gc.Contact.ID || one.Contact.Group {
		t.Fatalf("ana's 1:1 with carla = %+v %+v", one, one.Contact)
	}
	f.call(t, carla, "GET", "/api/chat/via/ana", "", 200, &vsum)
	if len(vsum.Convs) != 2 {
		t.Fatalf("carla's view after the 1:1 = %+v", vsum.Convs)
	}
	// carla starting it from her side finds that same chat.
	f.call(t, carla, "POST", "/api/chat/contacts", `{"user":"ana"}`, 200, &one)
	if one.Via != "ana" || one.Conv != "d-"+gc.Contact.ID {
		t.Fatalf("carla's 1:1 with ana = %+v", one)
	}
	// beto starting his 1:1 again does not land on ana's group-only contact.
	f.call(t, beto, "POST", "/api/chat/contacts", `{"user":"ana"}`, 200, &one)
	if one.Via != "" || one.Conv != bst.Conv {
		t.Fatalf("beto's 1:1 again = %+v", one)
	}
}
