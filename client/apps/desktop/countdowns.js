/* desktop/countdowns.js - the desktop's countdowns, out of Ayni's desk page (2026-11-23): they run on timers and
   ring, so they are Nayive's, not UI. One chip each on the bar (#cds, from #cdTpl), the dialog that starts or
   changes one (#cdBackdrop), kept on this device (localStorage "<KEYS>countdowns"). A press on the clock's time
   opens a new one; the clock and its month are desktop/clocks.js's.
   A plain script: desktop/index.html puts the markup in the desk page's slots, then calls
     NayiveDesk.countdowns( D, hooks, C )     C: what NayiveDesk.clocks gave back. */
( window.NayiveDesk = window.NayiveDesk || {} ).countdowns = function ( D, h, C )
{
    var store = D.store, KEYS = D.KEYS, setTip = D.setTip, t = D.t, pad = Ayni.dates.pad, clock = C.clock;

    // THE COUNTDOWNS - as many as wanted at once, on this device (localStorage),
    // so they go on after a reload. Each: running = `end` (a wall-clock time,
    // never a counter a sleeping tab would slow down); paused = `left` (ms still
    // to go); `len` its length in seconds. `last` is the length last started, to
    // offer it again for a new one. Each has its own chip on the bar, just before
    // the clock (oldest first) - the time left (not the text) and small Pause /
    // Play and Stop buttons. The clock adds a new one; a chip changes its own.
    // Time's up (`done`): beeps again and again until a press on a chip, a
    // system notice when the desktop is not on screen, and NO dialog - the chip
    // stays on the bar with the text (or 0:00 when there is none) and a small x
    // at its end that takes it away.

    var CD_KEY = KEYS + 'countdowns', CD_OLD = KEYS + 'countdown';   // until 2026-10-12: one countdown
    var cds = cdLoad();
    var cdBox = document.getElementById( 'cds' ), cdTpl = document.getElementById( 'cdTpl' ), cdBack = document.getElementById( 'cdBackdrop' );
    var cdH = document.getElementById( 'cdH' ), cdM = document.getElementById( 'cdM' ), cdS = document.getElementById( 'cdS' );
    var cdText = document.getElementById( 'cdText' ), cdPlay = document.getElementById( 'cdPlay' );
    var cdTitle = document.getElementById( 'cdTitle' ), cdNote = document.getElementById( 'cdNote' );
    var cdTimer = 0, audio = null, ringTimer = 0, cdEdit = 0;      // cdEdit: the id the dialog changes (0 = a new one)

    function cdLoad()
    {
        var v = store( CD_KEY );
        if( ! v )                                           // the old single one, if any
        {
            var o = store( CD_OLD ) || {};
            v = { list: ( o.end || o.left || o.done ) ? [ { id: 1, end: o.end || 0, left: o.left || 0, done: !! o.done, text: o.text || '', len: o.last || 300 } ] : [],
                  last: o.last };
        }
        return { list: Array.isArray( v.list ) ? v.list : [], last: v.last > 0 ? v.last : 300 };
    }
    function cdSave() { store( CD_KEY, cds ); try { localStorage.removeItem( CD_OLD ); } catch( e ) {} }
    function cdById( id ) { return cds.list.filter( function ( c ) { return c.id === id; } )[ 0 ]; }
    function cdMs( c )    { return c.end ? Math.max( 0, c.end - Date.now() ) : c.left; }
    function cdFmt( ms )
    {
        var s = Math.ceil( ms / 1000 ), h = Math.floor( s / 3600 ), m = Math.floor( s / 60 ) % 60;
        s %= 60;
        return ( h ? h + ':' + pad( m ) : m ) + ':' + pad( s );
    }

    // One chip per countdown, in the list's order; chips of ones gone go too.
    function cdPaint()
    {
        if( ! cds.list.some( function ( c ) { return c.done; } ) ) stopRing();   // all started again, stopped or taken away (also in another tab)
        var keep = {};
        cds.list.forEach( function ( c )
        {
            keep[ c.id ] = true;
            var el = cdBox.querySelector( '[data-id="' + c.id + '"]' );
            if( ! el ) { el = cdTpl.content.firstElementChild.cloneNode( true ); el.setAttribute( 'data-id', c.id ); }
            cdBox.appendChild( el );                        // (re)placed in order
            cdPaintChip( el, c );
        } );
        Array.prototype.slice.call( cdBox.children ).forEach( function ( el ) { if( ! keep[ el.getAttribute( 'data-id' ) ] ) el.remove(); } );
    }

    function cdPaintChip( el, c )
    {
        var on = !! ( c.end || c.left ), done = ! on && !! c.done;
        var pp = el.querySelector( '.cd-pp' ), stop = el.querySelector( '.cd-stop' ), x = el.querySelector( '.cd-x' );
        el.classList.toggle( 'paused', on && ! c.end );
        el.classList.toggle( 'done', done );
        el.querySelector( 'b' ).textContent = on ? cdFmt( cdMs( c ) ) : done && ! c.text ? cdFmt( 0 ) : '';
        el.querySelector( '.cd-text' ).textContent = done ? c.text : '';   // the text only once time is up
        setTip( el.querySelector( '.cd-main' ), done ? t( 'desktop.cdDone' ) : t( 'desktop.countdown' ) + ( c.text ? ' - ' + c.text : '' ) );
        pp.hidden = stop.hidden = ! on;
        x.hidden = ! done;
        var icon = c.end ? 'pause' : 'play';
        if( pp.getAttribute( 'data-icon' ) !== icon )
        {
            pp.innerHTML = Ayni.icon( icon );
            pp.setAttribute( 'data-icon', icon );
        }
        if( ! stop.firstChild ) stop.innerHTML = Ayni.icon( 'stop' );
        tip( pp, c.end ? 'desktop.cdPause' : 'desktop.cdContinue' );
        tip( stop, 'desktop.cdStop' );
        tip( x, 'ayni.close' );
    }

    function tip( el, key ) { setTip( el, t( key ) ); el.setAttribute( 'aria-label', el.dataset.tip ); }

    // Ends the ones whose time is up, repaints, and comes back at the next
    // second change of the soonest running one.
    function cdTick()
    {
        clearTimeout( cdTimer );
        var now = Date.now(), ended = cds.list.filter( function ( c ) { return c.end && c.end <= now; } );
        if( ended.length ) cdDone( ended );
        cdPaint();
        var next = 0;
        cds.list.forEach( function ( c )
        {
            if( ! c.end ) return;
            var ms = ( c.end - now ) % 1000 + 20;
            if( ! next || ms < next ) next = ms;
        } );
        if( next ) cdTimer = setTimeout( cdTick, next );
    }

    // The AudioContext is made on a press (Start), or a browser keeps it silent.
    function wakeAudio()
    {
        var AC = window.AudioContext || window.webkitAudioContext;
        try { if( ! audio && AC ) audio = new AC(); if( audio && audio.state !== 'running' ) audio.resume(); } catch( e ) {}
    }
    // Only a context a press already woke: one made now (no press) would hold
    // the beeps and play them at the next Start.
    function beep()
    {
        if( ! audio || audio.state !== 'running' ) return;
        try
        {
            for( var i = 0; i < 6; i++ )           // 3 pairs of short beeps
            {
                var at = audio.currentTime + 0.05 + Math.floor( i / 2 ) * 0.8 + ( i % 2 ) * 0.22;
                var o = audio.createOscillator(), g = audio.createGain();
                o.frequency.value = 880;
                g.gain.setValueAtTime( 0.0001, at );
                g.gain.exponentialRampToValueAtTime( 0.25, at + 0.01 );
                g.gain.exponentialRampToValueAtTime( 0.0001, at + 0.16 );
                o.connect( g ); g.connect( audio.destination );
                o.start( at ); o.stop( at + 0.18 );
            }
        } catch( e ) {}
    }

    // Time's up rings until the user stops it (his call, 2026-10-11): the 3
    // pairs again every 2.5 s, until a press on the chip.
    function ring()     { stopRing(); beep(); ringTimer = setInterval( beep, 2500 ); }
    function stopRing() { clearInterval( ringTimer ); ringTimer = 0; }

    function cdDone( ended )
    {
        ended.forEach( function ( c )
        {
            c.end = c.left = 0;
            c.done = true;
            try
            {
                if( document.hidden && window.Notification && Notification.permission === 'granted' )
                    new Notification( t( 'desktop.cdDone' ), { body: c.text, icon: '../icons/icon-192.png' } );
            } catch( e ) {}
        } );
        cdSave();
        ring();
    }

    // `by`: what was pressed (the clock or a chip); the dialog sits beside it,
    // on the desk side of the bar, as the month does. `c`: the countdown to
    // change (its chip), or none for a new one (the clock).
    var cdBy = clock;
    function cdOpen( by, c )
    {
        h.closeMenu();
        cdEdit = c ? c.id : 0;
        var s = c && c.len > 0 ? c.len : cds.last;
        cdH.value = Math.floor( s / 3600 ); cdM.value = Math.floor( s / 60 ) % 60; cdS.value = s % 60;
        cdText.value = c ? c.text : '';
        cdTitle.textContent = t( c ? 'desktop.cdChange' : 'desktop.cdNew' );
        cdNote.hidden = !! c;
        cdBack.showModal();
        cdBy = by || clock;
        Ayni.place( cdBack, cdBy );
    }
    window.addEventListener( 'resize', function ()
    {
        if( cdBack.open ) Ayni.place( cdBack, cdBy.isConnected ? cdBy : clock );
    } );

    function num( el, max ) { var n = Math.floor( +el.value ); return n > 0 ? Math.min( n, max ) : 0; }

    // Play: restarts the one being changed (if still there), else adds a new one.
    function cdStart()
    {
        var secs = num( cdH, 99 ) * 3600 + num( cdM, 59 ) * 60 + num( cdS, 59 );
        if( ! secs ) { cdH.focus(); return; }
        wakeAudio();
        var c = cdEdit && cdById( cdEdit );
        if( ! c )
        {
            c = { id: cds.list.reduce( function ( n, x ) { return Math.max( n, x.id ); }, 0 ) + 1 };
            cds.list.push( c );
        }
        Object.assign( c, { end: Date.now() + secs * 1000, left: 0, done: false, text: cdText.value.trim(), len: secs } );
        cds.last = secs;
        cdSave();
        cdBack.close();
        cdTick();
    }

    // The clock: its weekday / date opens the month (a second press closes it), the rest a new countdown.
    clock.addEventListener( 'click', function ( e )
    {
        var head = clock.querySelector( 'span:not(.icon)' );
        if( ! head.hidden && head.contains( e.target ) ) { if( ! C.calWasOpen() ) C.calOpen(); return; }
        cdOpen( clock );
    } );
    cdPlay.addEventListener( 'click', cdStart );
    [ cdH, cdM, cdS, cdText ].forEach( function ( el )
    {
        el.addEventListener( 'keydown', function ( e ) { if( e.key === 'Enter' ) { e.preventDefault(); cdStart(); } } );
    } );
    // A chip: Pause / Play, Stop (at once, no "are you sure") and, time's up,
    // the x that takes it away; anywhere else opens the dialog to change it.
    cdBox.addEventListener( 'click', function ( e )
    {
        var chip = e.target.closest( '.cd-chip' ), c = chip && cdById( +chip.getAttribute( 'data-id' ) );
        if( ! c ) return;
        var b = e.target.closest( '[data-cd]' ), what = b && b.getAttribute( 'data-cd' );
        stopRing();                                         // any press on a chip silences it
        if( ! what ) { cdOpen( chip, c ); return; }
        if( what === 'pp' )
        {
            if( c.end ) { c.left = Math.max( 1000, c.end - Date.now() ); c.end = 0; }
            else        { wakeAudio(); c.end = Date.now() + c.left; c.left = 0; }
        }
        else                                                // stop / x
        {
            var at = cds.list.indexOf( c ), was = Object.assign( {}, c );
            cds.list.splice( at, 1 );
            // Undo: back in its place with the same end moment (never one gone by
            // meanwhile), the same time left when paused, or its time's-up chip.
            Ayni.toast( 'ok', t( what === 'stop' ? 'desktop.cdStopped' : 'ayni.toast.removed' ), { undo: function ()
            {
                if( cdById( was.id ) || ( was.end && was.end <= Date.now() ) ) return;
                if( was.end ) wakeAudio();
                cds.list.splice( Math.min( at, cds.list.length ), 0, was );
                cdSave();
                cdTick();
            } } );
        }
        cdSave();
        cdTick();
    } );
    // Another tab of the desktop started / paused / stopped one: follow.
    window.addEventListener( 'storage', function ( e )
    {
        if( e.key !== CD_KEY ) return;
        cds = cdLoad();
        cdTick();
    } );
    // First look once shared/ui.js (deferred) is in: a countdown that ended while
    // the desktop was closed still says so, on its chip.
    if( document.readyState === 'loading' ) document.addEventListener( 'DOMContentLoaded', cdTick );
    else cdTick();
    if( window.Ayni ) Ayni.i18n.ready.then( cdPaint );
};
