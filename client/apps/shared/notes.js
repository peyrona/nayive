// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/* notes.js - Quick notes (2026-11-12): small text notes, one file per
   user, data/notes/notes.json, a plain array:

     [ { "id": "n_…", "title": "", "text": "", "list": false,
         "items": [ { "id": "i_…", "text": "", "done": false } ],
         "pinned": false, "color": null, "created": 1731400000000, "updated": … } ]

   list + items: old checklists, read as text (norm). color = null or 0..7, the
   eight identity hues ([data-c] in ayni-base.css). Fields this file does not
   know are kept as they are.

   Two faces, the same notes:
     NayiveNotes.desk( layer )  the desktop (desktop/index.html): sticky notes on
                                the wallpaper, under the windows. Where each one
                                sits is this device's (localStorage), the rest is shared.
     NayiveNotes.wall( host )   the launcher (index.html), on a phone: cards,
                                pinned first; a tap opens one full screen.
     NayiveNotes.add()          a new empty note, its text field focused.
     NayiveNotes.dot            a .sync-indicator the page may mirror (the desktop's plug).

   SAVING - the Habits / Tasks rules: AyniStore with a merge by id, note by note
   and item by item. Nothing is written before the first good read (a "+"
   before it says so); an unreachable or damaged file is never taken for an
   empty one; a read that answers after an edit is dropped (loadSeq); a blank
   note and a blank item are never saved; what this page has typed and not yet
   saved goes over a merge (an edit beats a delete); a re-read waits while a
   note is being typed. A delete has Undo, which puts the note back in the list
   as it is NOW. */
( function ()
{
    'use strict';

    var FILE  = 'data/notes/notes.json';
    var API   = ( window.AyniNames && window.AyniNames.api ) || '/api/';
    var PAGE  = 6;          // cards shown on the launcher before "More notes"
    var W0 = 240, H0 = 220, MINW = 170, MINH = 110, GAP = 16;     // a sticky note's first size, its least, the space around

    var T  = function ( k ) { return Ayni.t( k ); };
    var TF = function ( k, v ) { return Ayni.tf( k, v ); };

    var store = null;
    var notes = [];         // the list on screen (blank ones included)
    var readOnce = false;   // a good read came back: saving is allowed
    var corrupt  = false;   // the file is there but cannot be understood: never written over
    var loadSeq  = 0;
    var saveT    = 0;
    var dirty    = {};      // ids changed here since the last save
    var lastBody = null;    // the body of the last read or save
    var lastRead = 0;
    var views    = [];
    var dot = document.createElement( 'span' );
    dot.className = 'sync-indicator';

    //------------------------------------------------------------------------//
    // THE MODEL

    function str( v ) { return typeof v === 'string' ? v : ''; }
    function num( v ) { return typeof v === 'number' && isFinite( v ) ? v : 0; }
    function newId( p ) { return p + '_' + Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 7 ); }

    function norm( n )
    {
        if( ! n || typeof n !== 'object' || Array.isArray( n ) || typeof n.id !== 'string' || ! n.id ) return null;
        var c = n.color;
        var items = ( Array.isArray( n.items ) ? n.items : [] )
                        .filter( function ( i ) { return i && typeof i === 'object' && typeof i.id === 'string' && i.id; } )
                        .map( function ( i ) { return Object.assign( {}, i, { text: str( i.text ), done: !! i.done } ); } );
        var text = str( n.text );
        // Checklists are gone (2026-11-12): an old one becomes its text, one line per item, none lost.
        if( n.list ) { text = [ text ].concat( items.map( function ( i ) { return i.text; } ) ).filter( function ( t ) { return t.trim(); } ).join( '\n' ); items = []; }
        return Object.assign( {}, n, {
            title:   str( n.title ),
            text:    text,
            list:    false,
            items:   items,
            pinned:  !! n.pinned,
            color:   typeof c === 'number' && c >= 0 && c <= 7 ? Math.floor( c ) : null,
            created: num( n.created ),
            updated: num( n.updated )
        } );
    }

    function blankItem( i ) { return ! i.text.trim(); }
    function blank( n )     { return ! n.title.trim() && ! n.text.trim() && n.items.every( blankItem ); }
    function find( id )     { for( var i = 0; i < notes.length; i++ ) if( notes[ i ].id === id ) return notes[ i ]; return null; }
    function clone( v )     { return JSON.parse( JSON.stringify( v ) ); }

    // The list as saved: no blank note, no blank item.
    function bodyOf()
    {
        var out = notes.filter( function ( n ) { return ! blank( n ); } ).map( function ( n )
        {
            return n.items.some( blankItem ) ? Object.assign( {}, n, { items: n.items.filter( function ( i ) { return ! blankItem( i ); } ) } ) : n;
        } );
        return JSON.stringify( out, null, 2 );
    }

    // Two devices saved from the same copy: both kept, by id (shared/ayni/ayni-store.js
    // MERGE). A note changed on both takes each field from the side that changed
    // it - mine when both did - and its items merge the same way. null = a side
    // that is not a list: nothing is merged over it.
    function merge( path, base, mine, theirs )
    {
        if( path !== FILE ) return null;
        var list = function ( t ) { try { var v = JSON.parse( t ); return Array.isArray( v ) ? v : null; } catch( e ) { return null; } };
        var m = list( mine ), t = list( theirs );
        if( ! m || ! t ) return null;
        var S = AyniStore, byId = function ( x ) { return x && x.id; };
        var merged = S.mergeLists( base == null ? null : list( base ), m, t,
        {
            id:   byId,
            both: function ( b, x, y )
            {
                return S.mergeFields( b, x, y, { items: function ( bi, xi, yi )
                {
                    return S.mergeLists( bi || null, xi || [], yi || [], { id: byId, both: S.mergeFields } );
                } } );
            }
        } );
        return JSON.stringify( merged.map( norm ).filter( Boolean ), null, 2 );
    }

    //------------------------------------------------------------------------//
    // READ AND SAVE

    function start()
    {
        if( store ) return;
        store = AyniStore.createStore( { apiBase: location.origin + API + 'files', conflicts: true, merge: merge } );
        store.onState( function ( s ) { if( Ayni.plug ) Ayni.plug.set( dot, s ); } );
        store.onMerged( onMerged );
        load();
        // Away: what waits goes now. Back: read again (another device may have
        // saved) - not while a note is being typed (see busy).
        document.addEventListener( 'visibilitychange', function ()
        {
            if( document.visibilityState === 'hidden' ) flush(); else reread( true );
        } );
        window.addEventListener( 'pagehide', flush );
        window.addEventListener( 'focus', function () { reread( false ); } );
        window.addEventListener( 'online', function () { reread( true ); } );
    }

    function busy()
    {
        return !! saveT || views.some( function ( v ) { return v.busy(); } );
    }

    function reread( force )
    {
        if( ! store || ( ! force && Date.now() - lastRead < 20000 ) || busy() ) return;
        load();
    }

    async function load()
    {
        var my = ++loadSeq;
        lastRead = Date.now();
        var res = await store.read( FILE );
        if( my !== loadSeq ) return;          // an edit came in meanwhile: this answer is older than the screen

        if( res.source === 'empty' )
        {
            take( [] );                       // no notes.json yet: a safe first run
            lastBody = '[]';
        }
        else if( res.body !== null )
        {
            var v = null;
            try { v = JSON.parse( res.body ); } catch( e ) {}
            if( Array.isArray( v ) ) { take( v.map( norm ).filter( Boolean ) ); lastBody = res.body; }
            else
            {
                // A damaged file shows nothing and is never written over.
                notes = []; readOnce = false;
                if( ! corrupt ) Ayni.toast( 'err', T( 'notes.corrupt' ) );
                corrupt = true;
                render();
            }
        }
        // else: no server and nothing cached - leave everything as it is;
        // taking it for "no notes" would let the next save wipe the real file.
    }

    // A good list from the server or a merge: it replaces the screen's, except
    // what this page typed and has not saved yet, and the note open in an
    // editor (its fields hold that very copy; the next read brings the other
    // device's change to it). A note deleted elsewhere comes back only when
    // it was changed here, or is a new one still blank.
    function take( list )
    {
        var mine = notes.filter( function ( n ) { return dirty[ n.id ] || editing( n.id ); } );
        notes = list;
        mine.forEach( function ( n )
        {
            var at = -1;
            for( var i = 0; i < notes.length; i++ ) if( notes[ i ].id === n.id ) at = i;
            if( at >= 0 ) notes[ at ] = n;
            else if( dirty[ n.id ] || blank( n ) ) notes.unshift( n );
        } );
        readOnce = true;
        corrupt  = false;
        views.forEach( function ( v ) { if( v.took ) v.took(); } );
        render();
        if( mine.some( function ( n ) { return dirty[ n.id ]; } ) ) later();
    }

    function onMerged( path, body )
    {
        if( path !== FILE ) return;
        var v;
        try { v = JSON.parse( body ); } catch( e ) { return; }
        if( ! Array.isArray( v ) ) return;
        loadSeq++;
        lastBody = body;
        take( v.map( norm ).filter( Boolean ) );
    }

    function editing( id ) { return views.some( function ( v ) { return v.editing() === id; } ); }

    // A change to note n: saved a moment after the typing stops.
    function changed( n )
    {
        n.updated = Date.now();
        dirty[ n.id ] = true;
        later();
    }
    function later() { clearTimeout( saveT ); saveT = setTimeout( save, 700 ); }

    function save()
    {
        clearTimeout( saveT );
        saveT = 0;
        if( ! readOnce ) return;
        loadSeq++;                        // a read already out is now stale
        var body = bodyOf();
        dirty = {};
        if( body === lastBody ) return;
        lastBody = body;
        store.write( FILE, body );
    }
    function flush() { if( saveT ) save(); }

    // Saving is not allowed yet (not read, or the file is damaged): says so.
    function refuse()
    {
        if( readOnce ) return false;
        Ayni.toast( corrupt ? 'err' : 'warn', T( corrupt ? 'notes.corrupt' : 'notes.notYet' ) );
        return true;
    }

    function add()
    {
        if( refuse() ) return null;
        var now = Date.now();
        var n = { id: newId( 'n' ), title: '', text: '', list: false, items: [], pinned: false, color: null, created: now, updated: now };
        notes.unshift( n );
        return n;
    }

    // Deleted: Undo puts it back where it stood in the list as it is now (a
    // re-read may have changed the list meanwhile), unless the list holds it again.
    function remove( n )
    {
        var at = notes.indexOf( n );
        if( at < 0 ) return;
        notes.splice( at, 1 );
        delete dirty[ n.id ];
        render();
        if( blank( n ) ) return;           // never saved: nothing to say
        var copy = clone( n );
        save();
        Ayni.toast( 'ok', T( 'notes.deleted' ), { undo: function ()
        {
            if( refuse() ) return;
            if( ! find( copy.id ) ) notes.splice( Math.min( at, notes.length ), 0, copy );
            render();
            save();
        } } );
    }

    // A blank note left behind (the focus went elsewhere, the full view closed): gone.
    function dropIfBlank( n )
    {
        if( n && blank( n ) && notes.indexOf( n ) >= 0 ) { notes.splice( notes.indexOf( n ), 1 ); delete dirty[ n.id ]; render(); }
    }

    function render() { views.forEach( function ( v ) { v.render(); } ); }

    // Pinned first, then the newest.
    function ordered()
    {
        return notes.slice().sort( function ( a, b ) { return ( b.pinned - a.pinned ) || ( b.created - a.created ); } );
    }

    //------------------------------------------------------------------------//
    // THE EDITOR - the text; its title (box.titleInput) sits in
    // the view's toolbar row. The same on a sticky note and in the phone's full view.

    function el( tag, cls, html )
    {
        var e = document.createElement( tag );
        if( cls ) e.className = cls;
        if( html != null ) e.innerHTML = html;
        return e;
    }

    function button( icon, tip, cls )
    {
        var b = el( 'button', 'btn sm' + ( cls ? ' ' + cls : '' ), Ayni.icon( icon ) );
        b.type = 'button';
        Ayni.setTip( b, tip );
        b.setAttribute( 'aria-label', tip );
        return b;
    }

    function editor( n )
    {
        var box = el( 'div', 'note-ed' );
        var title = el( 'input', 'note-title' );
        title.type = 'text';
        title.maxLength = 200;
        title.value = n.title;
        title.placeholder = T( 'notes.titlePh' );
        title.setAttribute( 'aria-label', T( 'notes.titlePh' ) );
        title.addEventListener( 'input', function () { n.title = title.value; changed( n ); } );
        title.addEventListener( 'keydown', function ( e )
        {
            if( e.key !== 'Enter' ) return;
            e.preventDefault();
            var f = box.querySelector( '.note-text' );
            if( f ) f.focus();
        } );
        var body = el( 'div', 'note-body' );
        box.append( body );
        box.titleInput = title;                  // the view puts it in its toolbar row
        box.fill = function ( focusId ) { fill( n, body, focusId ); };
        box.fill();
        return box;
    }

    function caretEnd( f ) { f.focus(); try { f.setSelectionRange( f.value.length, f.value.length ); } catch( e ) {} }

    function fill( n, body, focusId )
    {
        body.textContent = '';
        var ta = el( 'textarea', 'note-text' );
        ta.value = n.text;
        ta.placeholder = T( 'notes.textPh' );
        ta.setAttribute( 'aria-label', T( 'notes.textPh' ) );
        ta.addEventListener( 'input', function () { n.text = ta.value; changed( n ); } );
        body.append( ta );
        if( focusId === 'text' ) caretEnd( ta );
    }

    // The note's buttons: colour, pin, delete. paint() is the
    // view's: the note's colour or pin changed.
    function tools( n, box, paint )
    {
        var bar = el( 'div', 'note-tools' );
        var co = button( 'palette', T( 'notes.color' ) );
        co.setAttribute( 'aria-haspopup', 'true' );
        co.addEventListener( 'click', function () { palette( co, n, paint ); } );
        var pin = button( 'pin', T( 'notes.pin' ) );
        pin.setAttribute( 'aria-pressed', n.pinned ? 'true' : 'false' );
        pin.addEventListener( 'click', function ()
        {
            n.pinned = ! n.pinned;
            pin.setAttribute( 'aria-pressed', n.pinned ? 'true' : 'false' );
            changed( n );
            paint();
        } );
        var del = button( 'trash', T( 'notes.delete' ), 'danger' );
        del.addEventListener( 'click', function () { remove( n ); } );
        bar.append( co, pin, del );
        return bar;
    }

    // The colour popup: none, then the eight hues.
    var palPop = null;
    function palette( btn, n, paint )
    {
        if( ! palPop )
        {
            palPop = el( 'div', 'panel popup notes-pal' );
            palPop.setAttribute( 'popover', '' );
            palPop.setAttribute( 'role', 'group' );
            palPop.setAttribute( 'aria-label', T( 'notes.color' ) );
            for( var c = -1; c < 8; c++ )
            {
                var s = el( 'button', 'notes-swatch' );
                s.type = 'button';
                if( c >= 0 ) s.dataset.c = c;
                s.dataset.v = c;
                Ayni.setTip( s, c < 0 ? T( 'notes.noColor' ) : TF( 'notes.colorN', { n: c + 1 } ) );
                s.setAttribute( 'aria-label', s.dataset.tip || '' );
                palPop.append( s );
            }
            palPop.addEventListener( 'click', function ( e )
            {
                var s = e.target.closest( '.notes-swatch' );
                if( ! s || ! palPop.pick ) return;
                palPop.pick( +s.dataset.v );
                palPop.hidePopover();
            } );
            document.body.append( palPop );
        }
        // A sticky note's popup goes in the note's own layer when it is a dialog's: the
        // full view is modal, and a popup outside it could not be clicked.
        var host = btn.closest( 'dialog' ) || document.body;
        if( palPop.parentNode !== host ) host.append( palPop );
        [].forEach.call( palPop.children, function ( s ) { s.setAttribute( 'aria-pressed', +s.dataset.v === ( n.color == null ? -1 : n.color ) ? 'true' : 'false' ); } );
        palPop.pick = function ( v ) { n.color = v < 0 ? null : v; changed( n ); paint(); };
        Ayni.showPopup( palPop, btn );
    }

    function paintColor( e, n )
    {
        if( n.color == null ) e.removeAttribute( 'data-c' ); else e.dataset.c = n.color;
        e.classList.toggle( 'pinned', n.pinned );
    }

    //------------------------------------------------------------------------//
    // THE DESKTOP - sticky notes on the wallpaper. Moved by their top strip,
    // sized by the corner; the last one touched comes on top. A pinned one
    // floats above the windows too (a second layer, .notes-layer.top), so it
    // stays in sight while an app is in use. Where they sit is this device's only.

    function posKey() { return 'nayive-notes-pos:' + ( ( window.AyniStore && AyniStore.me ) || '' ); }
    function readPos() { try { return JSON.parse( localStorage.getItem( posKey() ) ) || {}; } catch( e ) { return {}; } }
    function writePos( p ) { try { localStorage.setItem( posKey(), JSON.stringify( p ) ); } catch( e ) {} }

    function desk( layer )
    {
        var els = {}, pos = readPos(), zTop = 0, editId = null;
        var topLayer = el( 'div', 'notes-layer top' );
        layer.parentNode.append( topLayer );
        Object.keys( pos ).forEach( function ( id ) { zTop = Math.max( zTop, pos[ id ].z || 0 ); } );

        var V = {
            busy:    function () { return !! document.querySelector( '.note.sticky:focus-within, .note.sticky.moving' ); },     // either layer
            editing: function () { var f = document.querySelector( '.note.sticky:focus-within' ); return f ? f.dataset.id : null; },
            // A good read: positions of notes that are gone are dropped.
            took:    function ()
            {
                var keep = {};
                notes.forEach( function ( n ) { if( pos[ n.id ] ) keep[ n.id ] = pos[ n.id ]; } );
                pos = keep;
                writePos( pos );
            },
            render:  render
        };

        function size() { return { w: layer.clientWidth || 800, h: layer.clientHeight || 600 }; }

        // The first free place from the top left, row by row; else a step down from the last note.
        function freeSpot()
        {
            var L = size(), taken = notes.map( function ( n ) { return pos[ n.id ]; } ).filter( Boolean );
            for( var y = GAP; y + H0 <= L.h; y += H0 + GAP )
                for( var x = GAP; x + W0 <= L.w; x += W0 + GAP )
                    if( ! taken.some( function ( p ) { return x < p.x + p.w && x + W0 > p.x && y < p.y + p.h && y + H0 > p.y; } ) )
                        return { x: x, y: y };
            return { x: GAP + ( taken.length % 8 ) * 24, y: GAP + ( taken.length % 8 ) * 24 };
        }

        function place( e, n )
        {
            var p = pos[ n.id ];
            if( ! p ) { var f = freeSpot(); p = pos[ n.id ] = { x: f.x, y: f.y, w: W0, h: H0, z: ++zTop }; writePos( pos ); }
            var L = size();
            var w = Math.min( Math.max( p.w, MINW ), L.w ), h = Math.min( Math.max( p.h, MINH ), L.h );
            e.style.width  = w + 'px';
            e.style.height = h + 'px';
            e.style.left   = Math.max( 0, Math.min( p.x, L.w - w ) ) + 'px';     // a smaller screen: kept in sight, not moved for good
            e.style.top    = Math.max( 0, Math.min( p.y, L.h - h ) ) + 'px';
            e.style.zIndex = p.z || 0;
            var host = n.pinned ? topLayer : layer;
            if( e.parentNode && e.parentNode !== host ) host.append( e );
        }

        function front( n, e )
        {
            var p = pos[ n.id ];
            if( ! p || p.z === zTop ) return;
            p.z = ++zTop;
            writePos( pos );
            place( e, n );
        }

        function make( n )
        {
            var e = el( 'article', 'note sticky' );
            e.dataset.id = n.id;
            var strip = el( 'div', 'note-strip' );
            var box = editor( n );
            strip.append( box.titleInput, tools( n, box, function () { paintColor( e, n ); place( e, n ); } ) );
            var grip = el( 'div', 'note-size' );
            e.append( strip, box, grip );
            paintColor( e, n );

            e.addEventListener( 'pointerdown', function () { front( n, e ); } );
            // The whole strip moves the note, the title too: a drag moves it, a click types in it
            // (once the title has the focus, a press selects text as usual).
            strip.addEventListener( 'pointerdown', function ( ev )
            {
                if( ev.target.closest( 'button' ) ) return;
                var t = ev.target.closest( 'input' );
                if( t && document.activeElement === t ) return;
                drag( ev, n, e, false, t );
            } );
            grip.addEventListener( 'pointerdown', function ( ev ) { drag( ev, n, e, true ); } );
            // The focus leaves a note never written in: it goes.
            e.addEventListener( 'focusout', function ( ev )
            {
                if( ev.relatedTarget && e.contains( ev.relatedTarget ) ) return;
                setTimeout( function () { if( ! e.contains( document.activeElement ) && ! ( palPop && palPop.matches( ':popover-open' ) ) ) { dropIfBlank( n ); flush(); } }, 0 );
            } );
            e.note = n;
            return e;
        }

        function drag( ev, n, e, sizing, tapTo )
        {
            if( ev.button !== 0 ) return;
            ev.preventDefault();
            var p = pos[ n.id ], L = size(), x0 = ev.clientX, y0 = ev.clientY;
            var r0 = { x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }, moved = false;
            e.classList.add( 'moving' );
            e.setPointerCapture( ev.pointerId );
            function move( m )
            {
                var dx = m.clientX - x0, dy = m.clientY - y0;
                if( ! moved && Math.abs( dx ) + Math.abs( dy ) < 4 ) return;
                moved = true;
                if( sizing )
                {
                    p.w = Math.max( MINW, Math.min( r0.w + dx, L.w - r0.x ) );
                    p.h = Math.max( MINH, Math.min( r0.h + dy, L.h - r0.y ) );
                    p.x = r0.x; p.y = r0.y;
                }
                else
                {
                    p.x = Math.max( 0, Math.min( r0.x + dx, L.w - r0.w ) );
                    p.y = Math.max( 0, Math.min( r0.y + dy, L.h - r0.h ) );
                    p.w = r0.w; p.h = r0.h;
                }
                place( e, n );
            }
            function up()
            {
                e.removeEventListener( 'pointermove', move );
                e.removeEventListener( 'pointerup', up );
                e.removeEventListener( 'pointercancel', up );
                e.classList.remove( 'moving' );
                if( moved ) writePos( pos );
                else if( tapTo ) caretEnd( tapTo );
            }
            e.addEventListener( 'pointermove', move );
            e.addEventListener( 'pointerup', up );
            e.addEventListener( 'pointercancel', up );
        }

        function render()
        {
            var seen = {};
            notes.forEach( function ( n )
            {
                seen[ n.id ] = true;
                var e = els[ n.id ];
                // The note being typed in keeps its fields (and the caret); only its look follows.
                if( e && e.contains( document.activeElement ) && e.note === n ) { paintColor( e, n ); place( e, n ); return; }
                var fresh = make( n );
                if( e ) e.replaceWith( fresh ); else layer.append( fresh );
                els[ n.id ] = fresh;
                place( fresh, n );
            } );
            Object.keys( els ).forEach( function ( id ) { if( ! seen[ id ] ) { els[ id ].remove(); delete els[ id ]; } } );
            if( editId && els[ editId ] )
            {
                var f = els[ editId ].querySelector( '.note-text' );
                editId = null;
                if( f ) f.focus();
            }
        }

        new ResizeObserver( function () { notes.forEach( function ( n ) { if( els[ n.id ] ) place( els[ n.id ], n ); } ); } ).observe( layer );

        V.add = function ()
        {
            var n = add();
            if( ! n ) return;
            editId = n.id;
            render();
        };
        views.push( V );
        start();
        render();
        return V;
    }

    //------------------------------------------------------------------------//
    // THE LAUNCHER - cards, pinned first; PAGE of them until "More notes".
    // A tap opens the note full screen (a big dialog: the whole screen on a
    // phone).

    function wall( host )
    {
        var expanded = false, full = null, fullNote = null;
        var sec = el( 'section', 'notes-wall' );
        sec.setAttribute( 'aria-label', T( 'notes.title' ) );
        var head = el( 'div', 'notes-head' );
        var plus = button( 'sticky-plus', T( 'notes.new' ) );
        plus.id = 'notesNewBtn';
        var h2 = el( 'h2' );
        h2.textContent = T( 'notes.title' );
        head.append( plus, h2 );
        var cards = el( 'div', 'notes-cards' );
        var empty = el( 'p', 'notes-empty' );
        empty.textContent = T( 'notes.empty' );
        var more = el( 'button', 'btn text sm notes-more' );
        more.type = 'button';
        more.addEventListener( 'click', function () { expanded = true; render(); } );
        sec.append( head, cards, empty, more );
        host.append( sec );

        var V = {
            busy:    function () { return !! ( full && full.open ); },
            editing: function () { return full && full.open && fullNote ? fullNote.id : null; },
            render:  render
        };

        plus.addEventListener( 'click', function ()
        {
            var n = add();
            if( ! n ) return;
            render();
            open( n, 'text' );
        } );

        function card( n )
        {
            var c = el( 'article', 'note card' );
            c.dataset.id = n.id;
            c.tabIndex = 0;
            c.setAttribute( 'role', 'button' );
            paintColor( c, n );
            if( n.pinned ) c.append( el( 'span', 'note-pin', Ayni.icon( 'pin' ) ) );
            if( n.title.trim() ) { var b = el( 'b', 'note-card-title' ); b.textContent = n.title; c.append( b ); }
            var p = el( 'p', 'note-card-text' );
            p.textContent = n.text;
            c.append( p );
            c.addEventListener( 'click', function () { open( find( n.id ) || n ); } );
            c.addEventListener( 'keydown', function ( e ) { if( ( e.key === 'Enter' || e.key === ' ' ) && e.target === c ) { e.preventDefault(); open( find( n.id ) || n ); } } );
            return c;
        }

        function render()
        {
            var list = ordered().filter( function ( n ) { return ! blank( n ) || n === fullNote; } );
            var shown = expanded ? list : list.slice( 0, PAGE );
            cards.textContent = '';
            shown.forEach( function ( n ) { cards.append( card( n ) ); } );
            empty.hidden = !! list.length || ! readOnce;
            more.hidden = shown.length >= list.length;
            more.textContent = TF( 'notes.more', { n: list.length - shown.length } );
            // The open note deleted (its own button, or another device): the full view
            // closes. Replaced by a merge: the full view follows the new copy.
            if( full && full.open && fullNote )
            {
                var now = find( fullNote.id );
                if( ! now ) full.close();
                else if( now !== fullNote ) open( now );
            }
        }

        // The full view: ← back, the note's buttons, the editor. Changes are kept as they are typed.
        function open( n, focus )
        {
            if( ! full )
            {
                full = el( 'dialog', 'panel big notes-full' );
                full.setAttribute( 'aria-label', T( 'notes.title' ) );
                full.addEventListener( 'close', function ()
                {
                    var was = fullNote;
                    fullNote = null;
                    dropIfBlank( was );
                    flush();
                    render();
                } );
                document.body.append( full );
            }
            fullNote = n;
            full.textContent = '';
            var hd = el( 'header' );
            var back = button( 'back', T( 'notes.back' ) );
            back.setAttribute( 'data-close', '' );
            back.classList.remove( 'sm' );
            var body = el( 'div', 'body' );
            var box = editor( n );
            var bar = tools( n, box, function () { paintColor( full, n ); } );
            hd.append( back, box.titleInput, bar );
            body.append( box );
            full.append( hd, body );
            paintColor( full, n );
            if( ! full.open ) full.showModal();
            if( focus ) box.fill( focus === 'text' ? 'text' : 'new' );
        }

        views.push( V );
        start();
        render();
        return V;
    }

    window.NayiveNotes = {
        desk:  desk,
        wall:  wall,
        add:   function () { views.forEach( function ( v ) { if( v.add ) v.add(); } ); },
        dot:   dot,
        refresh: function () { if( store ) store.flush(); reread( true ); },
        FILE:  FILE
    };
} )();
