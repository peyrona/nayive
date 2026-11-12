// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/* launcher-bar.js - the launcher's top row (2026-11-12): between the magnifier
   and the gear, the buttons the person picked, in their order. Only in the one
   top row (html.ls-top: a phone, the desktop's menu); the big-screen launcher
   has no such row.

   ONE PER USER: data/launcher/bar.json = { "items": [ id, ... ] }, other keys
   kept as they are. An id is "desk" (show the desk: the desktop's #deskBtn,
   only there), "note" (a new note: the desktop's #noteNewBtn or the phone's
   #notesNewBtn) or an app's href as its tile has it ("drive/index.html").
   No file yet = "desk", "note". An id this launcher does not know (an app
   gone) stays in the file, unshown. "search" (the magnifier) and "gear" (the
   settings) are always in the row: moved like the rest, never removed; a list
   without them gets search first and gear last (2026-11-12).

   SAVING - the Top bar dialog: tap an icon, then ← → ×, or drag it; "Add…"
   puts a new one first. Each
   press is ONE change made over the file as it is NOW (AyniNet.updateJson:
   version-checked, read again on a 412), so another device's change in
   between is kept. A file that cannot be read is never written over: the
   list shows what was last known, read-only, and says why.

   This device keeps a copy (localStorage, per user) to paint the row at once
   and when offline - never written up. */
( function ()
{
    'use strict';

    var FILE = 'data/launcher/bar.json', MAX = 6, DEFAULT = [ 'desk', 'note' ], FIXED = [ 'search', 'gear' ];
    var items = null;          // the list as last read or saved (null: not yet)
    var canEdit = false;       // the file was read: the editor may change it

    function $( id ) { return document.getElementById( id ); }
    function T( k ) { return Ayni.t( k ); }
    function esc( s ) { return Ayni.esc( s ); }

    function cacheKey() { return 'nayive-bar:' + ( ( window.AyniStore && AyniStore.me ) || '' ); }
    function cacheGet() { try { var v = JSON.parse( localStorage.getItem( cacheKey() ) || 'null' ); return Array.isArray( v ) ? v : null; } catch ( e ) { return null; } }
    function cachePut( v ) { try { localStorage.setItem( cacheKey(), JSON.stringify( v ) ); } catch ( e ) {} }

    // The ids of a file's JSON (null: no file yet -> the default).
    function idsOf( f )
    {
        if( ! f ) return DEFAULT.slice();
        var seen = {};
        return ( Array.isArray( f.items ) ? f.items : [] ).filter( function ( x )
        {
            if( typeof x !== 'string' || ! x || seen[ x ] ) return false;
            return ( seen[ x ] = true );
        } );
    }

    // The ids with the two fixed ones in: search first, gear last when missing.
    function full( ids )
    {
        var out = ids.slice();
        if( out.indexOf( 'search' ) < 0 ) out.unshift( 'search' );
        if( out.indexOf( 'gear' ) < 0 ) out.push( 'gear' );
        return out;
    }
    function fixed( id ) { return FIXED.indexOf( id ) >= 0; }

    // AyniNet is not loaded up front by the launcher: fetched when first needed.
    var netLoad = null;
    function needNet()
    {
        if( window.AyniNet ) return Promise.resolve();
        if( ! netLoad )
            netLoad = new Promise( function ( resolve, reject )
            {
                var sc = document.createElement( 'script' );
                sc.src = 'shared/ayni/ayni-net.js';
                sc.onload = resolve;
                sc.onerror = function () { netLoad = null; reject( new Error( 'ayni-net' ) ); };
                document.head.appendChild( sc );
            } );
        return netLoad;
    }

    //------------------------------------------------------------------------//
    // WHAT CAN GO IN THE ROW - the two actions, then every app tile (the
    // grid's and its groups' popups), as the launcher shows them.

    function catalog()
    {
        var desk = $( 'deskBtn' ), note = $( 'noteNewBtn' ) || $( 'notesNewBtn' ), mag = document.querySelector( '#lsBox > [data-search]' );
        var out = [
            { id: 'search', name: T( 'search.title' ), icon: mag ? mag.innerHTML : Ayni.icon( 'search' ) },
            { id: 'gear', name: T( 'ui.settings' ), icon: Ayni.icon( 'settings' ) },
            { id: 'desk', name: T( 'desktop.showDesk' ), icon: desk ? desk.innerHTML : Ayni.icon( 'show-desk' ) },
            { id: 'note', name: T( 'notes.new' ),        icon: note ? note.innerHTML : Ayni.icon( 'plus' ) }
        ];
        document.querySelectorAll( '.apps-panel a.btn.large[href]' ).forEach( function ( a )
        {
            if( a.closest( '[hidden]' ) ) return;
            var name = ( a.querySelector( 'span' ) || a ).textContent.trim(), svg = a.querySelector( 'svg' );
            // top: a first-level tile, always in sight - never offered by Add.
            if( name ) out.push( { id: a.getAttribute( 'href' ), name: name, icon: svg ? svg.outerHTML : '', top: ! a.closest( '[popover]' ) } );
        } );
        return out;
    }
    function byId( cat, id ) { return cat.filter( function ( c ) { return c.id === id; } )[ 0 ]; }

    //------------------------------------------------------------------------//
    // THE ROW - #quickBar in #lsBox. The two action buttons are the pages' own
    // (their handlers go with them): moved into the row, or parked (hidden).

    function render()
    {
        var bar = $( 'quickBar' ), park = $( 'quickPark' );
        if( ! bar || ! park || ! document.documentElement.classList.contains( 'ls-top' ) ) return;
        var list = full( items || cacheGet() || DEFAULT ), cat = catalog();
        var own = { desk: $( 'deskBtn' ), note: $( 'noteNewBtn' ) || $( 'notesNewBtn' ) };
        Object.keys( own ).forEach( function ( k ) { if( own[ k ] ) park.appendChild( own[ k ] ); } );
        bar.textContent = '';
        // #quickBar is display: contents here, so every button - and the
        // magnifier, the field and the gear's #tools beside it - takes its
        // place in the row by CSS order.
        list.forEach( function ( id, n )
        {
            if( id === 'search' )
            {
                [ document.querySelector( '#lsBox > [data-search]' ), $( 'lsField' ) ].forEach( function ( el ) { if( el ) el.style.order = n; } );
                return;
            }
            if( id === 'gear' ) { if( $( 'tools' ) ) $( 'tools' ).style.order = n; return; }
            if( id === 'desk' || id === 'note' ) { if( own[ id ] ) { own[ id ].classList.remove( 'sm' ); own[ id ].style.order = n; bar.appendChild( own[ id ] ); } return; }
            var c = byId( cat, id );
            if( ! c ) return;
            var a = document.createElement( 'a' );
            a.style.order = n;
            a.className = 'btn qb-app';
            a.href = c.id;
            a.setAttribute( 'data-tip', c.name );
            a.setAttribute( 'aria-label', c.name );
            a.innerHTML = c.icon;
            bar.appendChild( a );
        } );
        bar.hidden = ! bar.children.length;
    }

    function load()
    {
        return needNet().then( function () { return AyniNet.readJson( FILE ); } ).then( function ( f )
        {
            items = idsOf( f );
            canEdit = true;
            cachePut( items );
            render();
            return true;
        }, function () { canEdit = false; render(); return false; } );
    }

    //------------------------------------------------------------------------//
    // THE EDITOR - the Top bar dialog (#barList, #barActs, #barAdd, #barMsg).
    // #barList is the row itself, its icons as they will look. Tap one to pick
    // it: ← → move it, × removes it (never Search or Settings). Or drag it.

    var sel = null;            // the picked icon's id
    var dragged = false;       // a drag just ended: its click is not a pick

    function say( text ) { var m = $( 'barMsg' ); if( m ) { m.hidden = ! text; m.textContent = text || ''; } }

    function drawEditor()
    {
        var list = $( 'barList' ), add = $( 'barAdd' ), acts = $( 'barActs' );
        if( ! list ) return;
        var ids = full( items || cacheGet() || DEFAULT ), cat = catalog();
        var shown = ids.filter( function ( id ) { return byId( cat, id ); } );
        if( shown.indexOf( sel ) < 0 ) sel = null;
        list.innerHTML = shown.map( function ( id )
        {
            var c = byId( cat, id );
            return '<button type="button" class="btn' + ( id === sel ? ' is-picked' : '' ) + '" data-id="' + esc( id ) + '" data-tip="' + esc( c.name ) +
                   '" aria-label="' + esc( c.name ) + '" aria-pressed="' + ( id === sel ) + '">' + c.icon + '</button>';
        } ).join( '' );
        var at = shown.indexOf( sel );
        if( acts )
        {
            acts.hidden = ! sel;
            acts.querySelectorAll( '[data-bar-act]' ).forEach( function ( b )
            {
                var a = b.getAttribute( 'data-bar-act' );
                b.disabled = ! canEdit || ! sel || ( a === 'up' && at === 0 ) || ( a === 'down' && at === shown.length - 1 ) || ( a === 'del' && fixed( sel ) );
                if( a === 'del' ) b.hidden = !! sel && fixed( sel );
            } );
        }
        var picked = shown.filter( function ( id ) { return ! fixed( id ); } ).length;
        if( add ) add.disabled = ! canEdit || picked >= MAX || cat.every( function ( c ) { return c.top || ids.indexOf( c.id ) >= 0; } );
    }

    // One change, made over the file as it is now. `op( ids )` returns the new
    // ids, or false when there is nothing to do on what is there now.
    function change( op )
    {
        if( ! canEdit ) return;
        say( '' );
        needNet().then( function ()
        {
            return AyniNet.updateJson( FILE, function ( f )
            {
                var next = op( full( idsOf( f ) ) );
                if( ! next ) return false;
                var out = {};
                if( f && typeof f === 'object' && ! Array.isArray( f ) ) Object.keys( f ).forEach( function ( k ) { out[ k ] = f[ k ]; } );
                out.items = next;
                return out;
            } );
        } ).then( function ( f )
        {
            items = idsOf( f );
            cachePut( items );
            render();
            drawEditor();
        }, function ( e )
        {
            if( e && e.notRead ) canEdit = false;
            say( T( e && e.notRead ? 'acct.barNotRead' : 'ui.saveFailed' ) );
            drawEditor();
        } );
    }

    // `id` to place `to` among the SHOWN ones; unknown ids stay where they are.
    function moveTo( id, to )
    {
        change( function ( ids )
        {
            var cat = catalog(), shown = ids.filter( function ( x ) { return byId( cat, x ); } );
            var at = shown.indexOf( id );
            if( at < 0 || to < 0 || to >= shown.length || to === at ) return false;
            shown.splice( at, 1 );
            shown.splice( to, 0, id );
            var k = 0;
            return ids.map( function ( x ) { return byId( cat, x ) ? shown[ k++ ] : x; } );
        } );
    }
    function move( id, by )
    {
        var cat = catalog(), shown = full( items || DEFAULT ).filter( function ( x ) { return byId( cat, x ); } );
        moveTo( id, shown.indexOf( id ) + by );
    }

    // Drag an icon along the row: where it is let go, it goes.
    function wireDrag( list )
    {
        var d = null;
        list.addEventListener( 'pointerdown', function ( e )
        {
            var b = e.target.closest( '[data-id]' );
            if( ! b || ! canEdit || e.button > 0 ) return;
            d = { b: b, x: e.clientX, on: false, id: e.pointerId };
        } );
        list.addEventListener( 'pointermove', function ( e )
        {
            if( ! d || e.pointerId !== d.id ) return;
            var dx = e.clientX - d.x;
            if( ! d.on && Math.abs( dx ) < 8 ) return;
            if( ! d.on ) { d.on = true; d.b.setPointerCapture( e.pointerId ); d.b.classList.add( 'is-dragged' ); }
            d.b.style.transform = 'translateX(' + dx + 'px)';
        } );
        function end( e )
        {
            if( ! d || e.pointerId !== d.id ) return;
            var was = d; d = null;
            if( ! was.on ) return;
            dragged = true;
            setTimeout( function () { dragged = false; }, 0 );
            var others = [].slice.call( list.querySelectorAll( '[data-id]' ) ).filter( function ( x ) { return x !== was.b; } );
            var to = others.filter( function ( x ) { var r = x.getBoundingClientRect(); return r.left + r.width / 2 < e.clientX; } ).length;
            was.b.style.transform = '';
            was.b.classList.remove( 'is-dragged' );
            if( e.type === 'pointerup' ) { sel = was.b.getAttribute( 'data-id' ); moveTo( sel, to ); }
            drawEditor();
        }
        list.addEventListener( 'pointerup', end );
        list.addEventListener( 'pointercancel', end );
    }

    function wire()
    {
        var list = $( 'barList' ), add = $( 'barAdd' ), acts = $( 'barActs' );
        if( ! list || list.dataset.wired ) return;
        list.dataset.wired = '1';
        list.addEventListener( 'click', function ( e )
        {
            var b = e.target.closest( '[data-id]' );
            if( ! b || dragged ) return;
            var id = b.getAttribute( 'data-id' );
            sel = sel === id ? null : id;
            drawEditor();
        } );
        wireDrag( list );
        if( acts ) acts.addEventListener( 'click', function ( e )
        {
            var btn = e.target.closest( '[data-bar-act]' );
            if( ! btn || btn.disabled || ! sel ) return;
            var id = sel, act = btn.getAttribute( 'data-bar-act' );
            if( act === 'up' ) move( id, -1 );
            else if( act === 'down' ) move( id, 1 );
            else if( ! fixed( id ) ) { sel = null; change( function ( ids ) { return ids.indexOf( id ) < 0 ? false : ids.filter( function ( x ) { return x !== id; } ); } ); }
        } );
        if( add ) add.addEventListener( 'click', function ()
        {
            var ids = full( items || DEFAULT );
            var rows = catalog().filter( function ( c ) { return ! c.top && ids.indexOf( c.id ) < 0; } ).map( function ( c )
            {
                return { id: 'bar:' + c.id, label: c.name, icon: c.icon, run: function ()
                {
                    // first: the left-most button
                    sel = c.id;
                    change( function ( now ) { return now.indexOf( c.id ) >= 0 ? false : [ c.id ].concat( now ); } );
                } };
            } );
            if( rows.length ) Ayni.menuAt( rows, { anchor: add } );
        } );
    }

    // My account opens: the list as it is on the server now.
    function openEditor()
    {
        wire();
        say( '' );
        drawEditor();
        load().then( function ( ok )
        {
            if( ! ok ) say( T( 'acct.barNotRead' ) );
            drawEditor();
        } );
    }

    window.NayiveBar = { render: render, openEditor: openEditor };

    document.addEventListener( 'DOMContentLoaded', function ()
    {
        ( window.Ayni && Ayni.i18n ? Ayni.i18n.ready : Promise.resolve() ).then( function () { render(); load(); } );
    } );
} )();
