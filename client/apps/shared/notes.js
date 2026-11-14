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
     NayiveNotes.desk( host, btn ) the desktop (desktop/index.html): a panel on the
                                right of the desk (a board over all of it on its ←);
                                pinned notes float over the windows, where each one
                                sits is this device's (localStorage), the rest is shared.
     NayiveNotes.open( on )     the desktop's panel: open, shut, or nothing = flip.
     NayiveNotes.wall( host )   the launcher (index.html), on a phone: cards,
                                pinned first; a tap opens one full screen.
     NayiveNotes.add( text )    a new note, its text field focused; empty, or
                                with this text (shared from another app) - saved.
     NayiveNotes.show( id )     that note, opened (launcher) or brought forward (desk).
     NayiveNotes.ready          a Promise: the first good read is in (saving allowed).
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
    var readyNow = null;
    var ready    = new Promise( function ( r ) { readyNow = r; } );
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
        readyNow();
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

    function add( text )
    {
        if( refuse() ) return null;
        var now = Date.now();
        var n = { id: newId( 'n' ), title: '', text: '', list: false, items: [], pinned: false, color: null, created: now, updated: now };
        notes.unshift( n );
        if( typeof text === 'string' && text.trim() ) { n.text = text; changed( n ); }     // shared text: saved as typed text is
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
    // THE DESKTOP (2026-11-14: notes on the wallpaper were messy) - a panel on
    // the right of the desk, over the windows but not in their way: they stay
    // usable beside it. The notes are cards you type in, the newest first. Its
    // ← spreads the same panel over the whole desk as a board: a grid of ALL
    // the notes, pinned first, the floating ones hidden meanwhile; → brings it
    // back to the side. Shut by its ×, by the bar's notes button, or by Esc.
    // A PINNED note leaves the side panel: it floats over the windows as a
    // sticky note, moved by its top strip, sized by its corner; the last one
    // touched comes on top. Where it sits is this device's only. Only one
    // editor of a note is in sight at a time.

    function posKey() { return 'nayive-notes-pos:' + ( ( window.AyniStore && AyniStore.me ) || '' ); }
    function readPos() { try { return JSON.parse( localStorage.getItem( posKey() ) ) || {}; } catch( e ) { return {}; } }
    function writePos( p ) { try { localStorage.setItem( posKey(), JSON.stringify( p ) ); } catch( e ) {} }

    // host: the desk (#desk). btn: the bar's notes button (optional), pressed while the panel is open.
    function desk( host, btn )
    {
        var sticks = {}, sheets = {}, pos = readPos(), zTop = 0, editId = null;

        // The panel: ← (board) · Notes · + · ×, then the cards.
        var pane = el( 'aside', 'notes-pane' );
        pane.hidden = true;
        pane.setAttribute( 'aria-label', T( 'notes.title' ) );
        var head = el( 'header', 'notes-phead' );
        var wide = button( 'back', T( 'notes.wide' ) );
        var h2 = el( 'h2' );
        h2.textContent = T( 'notes.title' );
        var plus = button( 'sticky-plus', T( 'notes.new' ) );
        var shut = button( 'close', T( 'ui.close' ) );
        head.append( wide, h2, plus, shut );
        var list = el( 'div', 'notes-list' );
        pane.append( head, list );
        // pinned notes: a layer over the panel and the windows
        var layer = el( 'div', 'notes-layer' );
        host.append( pane, layer );
        Object.keys( pos ).forEach( function ( id ) { zTop = Math.max( zTop, pos[ id ].z || 0 ); } );

        var V = {
            busy:    function () { return !! document.querySelector( '.note.sticky:focus-within, .note.sheet:focus-within, .note.sticky.moving' ); },
            editing: function () { var f = document.querySelector( '.note.sticky:focus-within, .note.sheet:focus-within' ); return f ? f.dataset.id : null; },
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

        //--- the panel

        function board( on )
        {
            if( on === pane.classList.contains( 'board' ) ) return;
            pane.classList.toggle( 'board', on );
            // Back to the side: the floating notes are made again, the board may have changed them.
            if( ! on ) Object.keys( sticks ).forEach( function ( id ) { sticks[ id ].remove(); delete sticks[ id ]; } );
            render();
            wide.innerHTML = Ayni.icon( on ? 'forward' : 'back' );
            var tip = T( on ? 'notes.narrow' : 'notes.wide' );
            Ayni.setTip( wide, tip );
            wide.setAttribute( 'aria-label', tip );
        }

        function paneOpen() { return ! pane.hidden; }

        // Open: no note at all yet = a new one (the "+" does it). Shut: back to the side next time.
        function open( on )
        {
            if( on == null ) on = pane.hidden;
            if( on )
            {
                pane.hidden = false;
                if( ! notes.length && readOnce ) { V.add(); return; }
            }
            else if( ! pane.hidden )
            {
                if( pane.contains( document.activeElement ) ) document.activeElement.blur();     // a blank note goes, what waits is saved
                pane.hidden = true;
                board( false );
            }
            if( btn ) btn.setAttribute( 'aria-pressed', paneOpen() ? 'true' : 'false' );
        }

        wide.addEventListener( 'click', function () { board( ! pane.classList.contains( 'board' ) ); } );
        plus.addEventListener( 'click', function () { V.add(); } );
        shut.addEventListener( 'click', function () { open( false ); } );
        // Esc: not while a popup, a dialog or the desktop's menu is up - it is theirs (seen first: capture).
        document.addEventListener( 'keydown', function ( e )
        {
            if( e.key !== 'Escape' || pane.hidden || e.defaultPrevented ) return;
            var menu = document.getElementById( 'menu' );
            if( document.querySelector( ':popover-open:not([popover=manual]), dialog[open]' ) || ( menu && ! menu.hidden ) ) return;     // not a tooltip or a toast
            open( false );
        }, true );
        // A window comes forward (opened, or picked on the bar) while the board is up:
        // the board goes back to the side, or it would hide that window.
        new MutationObserver( function ( list )
        {
            if( ! pane.classList.contains( 'board' ) ) return;
            var up = list.some( function ( m )
            {
                if( m.type === 'childList' ) return [].some.call( m.addedNodes, function ( x ) { return x.classList && x.classList.contains( 'win' ); } );
                var w = m.target;
                if( ! w.classList.contains( 'win' ) || w.hidden ) return false;
                if( m.attributeName === 'hidden' ) return true;
                var z0 = /z-index:\s*(\d+)/.exec( m.oldValue || '' );
                return ( +w.style.zIndex || 0 ) > ( z0 ? +z0[ 1 ] : 0 );
            } );
            if( up ) board( false );
        } ).observe( host, { childList: true, attributes: true, attributeFilter: [ 'style', 'hidden' ], attributeOldValue: true, subtree: true } );

        // A card in the panel: the title and the note's buttons on top, the text below.
        function sheet( n )
        {
            var e = el( 'article', 'note sheet' );
            e.dataset.id = n.id;
            var strip = el( 'div', 'note-strip' );
            var box = editor( n );
            strip.append( box.titleInput, tools( n, box, function () { paintColor( e, n ); render(); } ) );
            e.append( strip, box );
            paintColor( e, n );
            leave( e, n );
            e.note = n;
            return e;
        }

        // The focus leaves a note never written in: it goes.
        function leave( e, n )
        {
            e.addEventListener( 'focusout', function ( ev )
            {
                if( ev.relatedTarget && e.contains( ev.relatedTarget ) ) return;
                setTimeout( function () { if( ! e.contains( document.activeElement ) && ! ( palPop && palPop.matches( ':popover-open' ) ) ) { dropIfBlank( n ); flush(); } }, 0 );
            } );
        }

        //--- the pinned notes, floating

        function size() { return { w: layer.clientWidth || 800, h: layer.clientHeight || 600 }; }

        // The first free place from the top left, row by row; else a step down from the last note.
        function freeSpot()
        {
            var L = size(), taken = notes.filter( function ( n ) { return n.pinned; } ).map( function ( n ) { return pos[ n.id ]; } ).filter( Boolean );
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
            strip.append( box.titleInput, tools( n, box, function () { paintColor( e, n ); render(); } ) );
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
            leave( e, n );
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

        //--- both

        // A card is kept while it holds the same note (its fields are bound to
        // it; the one being typed in keeps its caret), else made again. A card
        // that must move in the list gets its focus back.
        function render()
        {
            var act = document.activeElement, inPane = {}, pinned = {}, at = 0, all = pane.classList.contains( 'board' );
            ordered().forEach( function ( n )
            {
                if( n.pinned )
                {
                    pinned[ n.id ] = true;
                    var s = sticks[ n.id ];
                    if( ! s || s.note !== n ) { var fs = make( n ); if( s ) s.replaceWith( fs ); else layer.append( fs ); s = sticks[ n.id ] = fs; }
                    else paintColor( s, n );
                    place( s, n );
                    if( ! all ) return;      // the board: in it too (the floating one is hidden)
                }
                inPane[ n.id ] = true;
                var e = sheets[ n.id ];
                if( ! e || e.note !== n ) { var fe = sheet( n ); if( e ) e.replaceWith( fe ); e = sheets[ n.id ] = fe; }
                else paintColor( e, n );
                if( list.children[ at ] !== e ) list.insertBefore( e, list.children[ at ] || null );
                at++;
            } );
            Object.keys( sheets ).forEach( function ( id ) { if( ! inPane[ id ] ) { sheets[ id ].remove(); delete sheets[ id ]; } } );
            Object.keys( sticks ).forEach( function ( id ) { if( ! pinned[ id ] ) { sticks[ id ].remove(); delete sticks[ id ]; } } );
            if( act && act !== document.activeElement && act.isConnected ) act.focus( { preventScroll: true } );
            if( editId && ( sheets[ editId ] || sticks[ editId ] ) )
            {
                var f = ( sheets[ editId ] || sticks[ editId ] ).querySelector( '.note-text' );
                editId = null;
                if( f ) f.focus();
            }
        }

        new ResizeObserver( function () { notes.forEach( function ( n ) { if( sticks[ n.id ] ) place( sticks[ n.id ], n ); } ); } ).observe( layer );

        // A new note: first in the panel, its text field focused.
        V.add = function ( text )
        {
            var n = add( text );
            if( ! n ) return;
            open( true );
            editId = n.id;
            render();
        };
        // A search result: that note, its text field focused - in the panel, or in front when pinned.
        V.show = function ( id )
        {
            var n = find( id );
            if( ! n ) return;
            if( ! n.pinned ) open( true );
            var e = sheets[ id ] || sticks[ id ];     // a pinned one: its board card while the board is up
            if( ! e ) return;
            if( e === sticks[ id ] ) front( n, e );
            caretEnd( e.querySelector( '.note-text' ) );
        };
        V.open = open;
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
        var more = el( 'button', 'btn text sm notes-more' );
        more.type = 'button';
        more.addEventListener( 'click', function () { expanded = true; render(); } );
        sec.append( head, cards, more );
        host.append( sec );

        var V = {
            busy:    function () { return !! ( full && full.open ); },
            editing: function () { return full && full.open && fullNote ? fullNote.id : null; },
            render:  render
        };

        V.add = function ( text )
        {
            var n = add( text );
            if( ! n ) return;
            render();
            open( n, 'text' );
        };
        plus.addEventListener( 'click', function () { V.add(); } );
        V.show = function ( id ) { var n = find( id ); if( n ) open( n ); };      // a search result

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
            // a phone with no notes: nothing to show (Office › Notes makes the first)
            sec.hidden = ! list.length && document.documentElement.classList.contains( 'ls-top' );
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
        add:   function ( text ) { views.forEach( function ( v ) { if( v.add ) v.add( text ); } ); },
        show:  function ( id ) { views.forEach( function ( v ) { if( v.show ) v.show( id ); } ); },
        open:  function ( on ) { views.forEach( function ( v ) { if( v.open ) v.open( on ); } ); },
        ready: ready,
        dot:   dot,
        refresh: function () { if( store ) store.flush(); reread( true ); },
        FILE:  FILE
    };
} )();
