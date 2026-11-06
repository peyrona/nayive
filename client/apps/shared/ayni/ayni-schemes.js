/* Ayni library 0.2.0, colour schemes: the dialog that lists, edits, makes and deletes them, and the schemes Ayni ships
   (dark: Oscuro, Noche; light: Beige, Niebla). Plain JavaScript, no build step, evergreen browsers 2024+. Optional: only a
   page that offers the dialog loads it, after ayni-dialogs.js and ayni-pickers.js, with ayni-schemes.css and ayni-icons-more.js:
     <button onclick="Ayni.schemeDialog()">
   The base applies the schemes on every page; this file only edits them. Loading it brings stored schemes up to date. */
( function ()
{
    "use strict";

    var scmBack = document.createElement( 'dialog' );
    scmBack.className = 'panel';
    scmBack.id = 'scmBackdrop';
    scmBack.setAttribute( 'data-i18n-attr', 'aria-label:ayni.scm.title' );
    scmBack.innerHTML = `
<header>
    <h2 data-i18n="ayni.scm.title"></h2>
    <button class="btn" id="scmCloseBtn" type="button" data-close data-i18n-attr="data-tip:ayni.close"><span class="icon" data-icon="close"></span></button>
</header>
<div class="body">
    <p class="scm-h" data-i18n="ayni.scm.saved"></p>
    <div class="scm-list" id="scmList"></div>

    <p class="scm-h" id="scmEditTitle"><span data-i18n="ayni.scm.edit"></span><button class="info-tip" data-i18n-attr="data-help:ayni.scm.info"></button></p>
    <div class="scm-name-row">
        <input class="input scm-input" id="scmName" spellcheck="false" autocomplete="off" data-i18n-attr="placeholder:ayni.scm.namePh">
        <div class="scm-seg" role="group" data-i18n-attr="aria-label:ayni.scm.kind">
            <button type="button" class="btn text sm bordered" aria-pressed="false" data-kind="dark" id="scmKindDark" data-i18n="ayni.scm.dark"></button>
            <button type="button" class="btn text sm bordered" aria-pressed="false" data-kind="light" id="scmKindLight" data-i18n="ayni.scm.light"></button>
        </div>
    </div>
    <div id="scmTokens">
        <label class="scm-tok"><input type="color" data-k="--bg" aria-label="--bg"><code>--bg</code><input class="input" type="text" data-k="--bg" maxlength="7" spellcheck="false" aria-label="--bg hex"></label>
        <label class="scm-tok"><input type="color" data-k="--card" aria-label="--card"><code>--card</code><input class="input" type="text" data-k="--card" maxlength="7" spellcheck="false" aria-label="--card hex"></label>
        <label class="scm-tok"><input type="color" data-k="--card2" aria-label="--card2"><code>--card2</code><input class="input" type="text" data-k="--card2" maxlength="7" spellcheck="false" aria-label="--card2 hex"></label>
        <label class="scm-tok"><input type="color" data-k="--line" aria-label="--line"><code>--line</code><input class="input" type="text" data-k="--line" maxlength="7" spellcheck="false" aria-label="--line hex"></label>
        <label class="scm-tok"><input type="color" data-k="--accent" aria-label="--accent"><code>--accent</code><input class="input" type="text" data-k="--accent" maxlength="7" spellcheck="false" aria-label="--accent hex"></label>
    </div>
    <p class="scm-msg" id="scmAccentMsg" hidden></p>
    <div class="actions-row">
        <div class="extra"><button id="scmDelete"  class="btn danger" type="button" data-i18n-attr="data-tip:ayni.scm.deleteThis"><span class="icon" data-icon="trash"></span></button></div>
        <button class="btn" id="scmSaveNew" type="button" data-i18n-attr="data-tip:ayni.scm.saveAsNew"><span class="icon" data-icon="save-as"></span></button>
        <button class="btn primary" id="scmSave"    type="button" data-i18n-attr="data-tip:ayni.scm.saveChanges"><span class="icon" data-icon="check"></span></button>
    </div>
    <p class="scm-msg" id="scmMsg" hidden></p>

    <p class="scm-h" data-i18n="ayni.scm.assignHead"></p>
    <div class="scm-assign-row">
        <div class="scm-assign"><label for="scmActiveDark" data-i18n="ayni.scm.dark"></label><div class="picker" id="scmActiveDark"></div></div>
        <div class="scm-assign"><label for="scmActiveLight" data-i18n="ayni.scm.light"></label><div class="picker" id="scmActiveLight"></div></div>
    </div>
</div>
`;
    document.body.appendChild( scmBack );

    var KEY   = 'ayni-schemes';
    var NKEYS = [ '--bg', '--card', '--card2', '--line', '--accent' ];   // what the dialog edits
    // The highlight colour: ayni-base.css's accent per mode, used when a scheme has
    // none of its own. Its text colour (--on-accent) is never typed - onAccent()
    // picks ayni-base.css's dark or light ink, whichever reads better on it.
    var ACCENT     = { dark: '#1f80b1', light: '#61410a' };
    var INK        = { dark: '#0D0F17', light: '#F9F9FB' };
    var LOW_ACCENT = 3;   // accent contrast on page / cards / fields below this -> warn
    var HEX   = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    // The built-in schemes' names are DATA, not interface text: they are
    // written into localStorage (and the user can rename them), so they stay
    // literal in every language - like "Beige" beside them.
    // Bump SEED_VERSION whenever a built-in changes or is added: load() then
    // brings stored data up to date (see upgrade()).
    var SEED_VERSION = 4;
    var SEED  = {
        schemes: [
            { id: 'dark-default',  name: 'Oscuro', kind: 'dark',  tokens: { '--bg': '#1E1F23', '--card': '#25272B', '--card2': '#2F3034', '--line': '#424349', '--accent': '#1F80B1', '--on-accent': '#0D0F17' } },
            { id: 'dark-noche',    name: 'Noche',  kind: 'dark',  tokens: { '--bg': '#101722', '--card': '#18202C', '--card2': '#212B38', '--line': '#353F4E', '--accent': '#16A085', '--on-accent': '#0D0F17' } },
            { id: 'light-default', name: 'Beige',  kind: 'light', tokens: { '--bg': '#D8D0C0', '--card': '#E3DCCC', '--card2': '#F2ECDF', '--line': '#86714B', '--accent': '#61410A', '--on-accent': '#F9F9FB' } },
            { id: 'light-niebla',  name: 'Niebla', kind: 'light', tokens: { '--bg': '#D4DBD9', '--card': '#DFE5E3', '--card2': '#F0F5F3', '--line': '#76847F', '--accent': '#0A4061', '--on-accent': '#F9F9FB' } }
        ],
        activeDark: 'dark-default',
        activeLight: 'light-default',
        seedVersion: SEED_VERSION
    };
    // The built-ins as older versions shipped them: a stored copy still equal
    // to one of these was never edited, so upgrade() may refresh it.
    var SEED_OLD = {
        'dark-default':  [ { '--bg': '#1E1F23', '--card': '#25272B', '--card2': '#2F3034', '--line': '#343539' },
                           { '--bg': '#1E1F23', '--card': '#25272B', '--card2': '#2F3034', '--line': '#424349', '--accent': '#16A085' },
                           { '--bg': '#1E1F23', '--card': '#25272B', '--card2': '#2F3034', '--line': '#424349', '--accent': '#0876A6' } ],
        'light-default': [ { '--bg': '#D8D0C0', '--card': '#E0D9CB', '--card2': '#F2ECDF', '--line': '#735C2E' },
                           { '--bg': '#D8D0C0', '--card': '#E3DCCC', '--card2': '#F2ECDF', '--line': '#86714B', '--accent': '#0A6151' } ],
        'light-niebla':  [ { '--bg': '#D4DBD9', '--card': '#DFE5E3', '--card2': '#F0F5F3', '--line': '#76847F', '--accent': '#0A6151' } ]
    };
    // The SEED_VERSION that first shipped each built-in (1 when not listed).
    var SEED_BORN = { 'dark-noche': 2, 'light-niebla': 2 };

    var root     = document.documentElement;
    var listEl   = document.getElementById( 'scmList' );
    var nameEl   = document.getElementById( 'scmName' );
    var titleEl  = document.getElementById( 'scmEditTitle' );
    var kindDark = document.getElementById( 'scmKindDark' );
    var kindLite = document.getElementById( 'scmKindLight' );
    var saveBtn  = document.getElementById( 'scmSave' );
    var newBtn   = document.getElementById( 'scmSaveNew' );
    var delBtn   = document.getElementById( 'scmDelete' );
    var msgEl    = document.getElementById( 'scmMsg' );
    var selDark  = document.getElementById( 'scmActiveDark' );
    var selLite  = document.getElementById( 'scmActiveLight' );
    var closeBtn = document.getElementById( 'scmCloseBtn' );
    var accentMsg = document.getElementById( 'scmAccentMsg' );

    var col = {}, hex = {};
    scmBack.querySelectorAll( '.scm-tok input[type="color"]' ).forEach( function ( el ){ col[ el.dataset.k ] = el; } );
    scmBack.querySelectorAll( '.scm-tok input[type="text"]'  ).forEach( function ( el ){ hex[ el.dataset.k ] = el; } );

    var data      = load();
    var editingId = null;
    var draft     = null;

    function load()
    {
        try
        {
            var d = JSON.parse( localStorage.getItem( KEY ) || 'null' );
            if( d && d.schemes && d.schemes.some( isDark ) && d.schemes.some( isLight ) ) return upgrade( d );
        }
        catch ( e ) { /* ignore */ }
        return JSON.parse( JSON.stringify( SEED ) );
    }
    // Stored data from an older SEED_VERSION: add the built-ins it lacks
    // (only NEW ones - an old built-in the user deleted stays deleted) and
    // refresh an old built-in the user never edited. Saved at once, so every
    // other page picks the new tones up.
    function upgrade( d )
    {
        var from = d.seedVersion || 1;
        if( from >= SEED_VERSION ) return d;
        SEED.schemes.forEach( function ( s )
        {
            var have = null, last = -1;
            for( var i = 0; i < d.schemes.length; i++ )
            {
                if( d.schemes[ i ].id === s.id )     have = d.schemes[ i ];
                if( d.schemes[ i ].kind === s.kind ) last = i;
            }
            if( have )
            {
                if( ( SEED_OLD[ s.id ] || [] ).some( function ( o ){ return sameTokens( have.tokens, o ); } ) ) have.tokens = JSON.parse( JSON.stringify( s.tokens ) );
            }
            else if( ( SEED_BORN[ s.id ] || 1 ) > from ) d.schemes.splice( last + 1, 0, JSON.parse( JSON.stringify( s ) ) );
        } );
        d.seedVersion = SEED_VERSION;
        try { localStorage.setItem( KEY, JSON.stringify( d ) ); } catch ( e ) {}
        return d;
    }
    function sameTokens( a, b ){ return Object.keys( b ).every( function ( k ){ return String( ( a && a[ k ] ) || '' ).toLowerCase() === b[ k ].toLowerCase(); } ); }
    // A scheme's editable tokens, with the mode's default accent when it has no accent yet.
    function tokensOf( s ){ var t = {}; NKEYS.forEach( function ( k ){ t[ k ] = ( s.tokens && s.tokens[ k ] ) || ( k === '--accent' ? ACCENT[ s.kind ] : '' ); } ); return t; }
    // What gets stored: the edited tokens plus the derived --on-accent.
    function toStore( t ){ var o = {}; NKEYS.forEach( function ( k ){ o[ k ] = t[ k ]; } ); o[ '--on-accent' ] = onAccent( t[ '--accent' ] ); return o; }
    function lum( h )
    {
        var n = parseInt( h.slice( 1 ), 16 ), w = [ 0.2126, 0.7152, 0.0722 ];
        return [ n >> 16 & 255, n >> 8 & 255, n & 255 ].reduce( function ( sum, v, i )
        {
            v /= 255;
            return sum + w[ i ] * ( v <= 0.03928 ? v / 12.92 : Math.pow( ( v + 0.055 ) / 1.055, 2.4 ) );
        }, 0 );
    }
    function contrast( a, b ){ var x = lum( a ), y = lum( b ); return ( Math.max( x, y ) + 0.05 ) / ( Math.min( x, y ) + 0.05 ); }
    function onAccent( a ){ return contrast( a, INK.dark ) >= contrast( a, INK.light ) ? INK.dark : INK.light; }
    function isDark( s ){ return s.kind === 'dark'; }
    function isLight( s ){ return s.kind === 'light'; }
    function persist(){ try { localStorage.setItem( KEY, JSON.stringify( data ) ); } catch ( e ) {} }
    function find( id ){ for( var i = 0; i < data.schemes.length; i++ ) if( data.schemes[ i ].id === id ) return data.schemes[ i ]; return null; }
    function firstOfKind( k ){ for( var i = 0; i < data.schemes.length; i++ ) if( data.schemes[ i ].kind === k ) return data.schemes[ i ]; return null; }
    function countKind( k, exceptId ){ return data.schemes.filter( function ( s ){ return s.kind === k && s.id !== exceptId; } ).length; }
    function reconcile()
    {
        if( ! find( data.activeDark )  || find( data.activeDark ).kind  !== 'dark'  ) data.activeDark  = firstOfKind( 'dark' ).id;
        if( ! find( data.activeLight ) || find( data.activeLight ).kind !== 'light' ) data.activeLight = firstOfKind( 'light' ).id;
    }
    function loadDraft()
    {
        var s = find( editingId ) || firstOfKind( 'dark' );
        editingId = s.id;
        draft = { name: s.name, kind: s.kind, tokens: tokensOf( s ) };
    }
    function norm( h )
    {
        h = h.trim().toLowerCase();
        if( h && h[ 0 ] !== '#' ) h = '#' + h;
        if( h.length === 4 ) h = '#' + h[ 1 ] + h[ 1 ] + h[ 2 ] + h[ 2 ] + h[ 3 ] + h[ 3 ];
        return h;
    }
    function showMsg( t ){ msgEl.textContent = t; msgEl.hidden = false; }
    function clearMsg(){ msgEl.hidden = true; }

    // Paint the draft on :root so the whole page previews it live.
    function previewDraft()
    {
        root.setAttribute( 'data-theme', draft.kind === 'light' ? 'light' : 'dark' );
        NKEYS.forEach( function ( k ){ root.style.setProperty( k, draft.tokens[ k ] ); } );
        root.style.setProperty( '--on-accent', onAccent( draft.tokens[ '--accent' ] ) );
    }

    function render()
    {
        // scheme list
        listEl.innerHTML = '';
        data.schemes.forEach( function ( s )
        {
            var b = document.createElement( 'button' );
            b.type = 'button';
            b.className = 'scm-row' + ( s.id === editingId ? ' sel' : '' );
            b.dataset.id = s.id;
            var isActive = s.id === data.activeDark || s.id === data.activeLight;
            var st = tokensOf( s );
            b.innerHTML =
                '<span class="scm-sw">' + NKEYS.map( function ( k ){ return '<i style="background:' + st[ k ] + '"></i>'; } ).join( '' ) + '</span>' +
                '<span class="scm-name"></span>' +
                '<span class="scm-kind">' + ( s.kind === 'dark' ? Ayni.t( 'ayni.scm.darkWord' ) : Ayni.t( 'ayni.scm.lightWord' ) ) + '</span>' +
                ( isActive ? '<span class="scm-badge" data-i18n="ayni.scm.activeBadge"></span>' : '' );
            b.querySelector( '.scm-name' ).textContent = s.name;
            listEl.appendChild( b );
        } );

        if( document.activeElement !== nameEl ) nameEl.value = draft.name;
        // Into the title's own span: the info dot beside it stays.
        // Its data-i18n goes, so a later translation pass keeps the name.
        var titleSpan = titleEl.querySelector( 'span' );
        titleSpan.removeAttribute( 'data-i18n' );
        titleSpan.textContent = Ayni.tf( 'ayni.scm.editing', { name: draft.name || Ayni.t( 'ayni.scm.unnamed' ) } );
        kindDark.setAttribute( 'aria-pressed', draft.kind === 'dark'  ? 'true' : 'false' );
        kindLite.setAttribute( 'aria-pressed', draft.kind === 'light' ? 'true' : 'false' );
        kindDark.setAttribute( 'aria-pressed', draft.kind === 'dark' );
        kindLite.setAttribute( 'aria-pressed', draft.kind === 'light' );

        NKEYS.forEach( function ( k )
        {
            if( document.activeElement !== col[ k ] ) col[ k ].value = draft.tokens[ k ];
            if( document.activeElement !== hex[ k ] ) { hex[ k ].value = draft.tokens[ k ].toUpperCase(); hex[ k ].classList.remove( 'bad' ); }
        } );

        delBtn.ariaDisabled = countKind( find( editingId ).kind, editingId ) === 0;

        // Warn (never block) when the highlight is hard to see on the scheme's tones.
        var worst = Math.min( contrast( draft.tokens[ '--accent' ], draft.tokens[ '--bg' ] ),
                              contrast( draft.tokens[ '--accent' ], draft.tokens[ '--card' ] ),
                              contrast( draft.tokens[ '--accent' ], draft.tokens[ '--card2' ] ) );
        accentMsg.hidden = worst >= LOW_ACCENT;
        if( ! accentMsg.hidden ) accentMsg.textContent = Ayni.tf( 'ayni.scm.accentLow', { ratio: worst.toFixed( 1 ) } );

        fillSelect( selDark, 'dark', data.activeDark );
        fillSelect( selLite, 'light', data.activeLight );

        previewDraft();
    }

    function fillSelect( sel, kind, activeId )
    {
        var pk = Ayni.picker( sel );
        pk.options = data.schemes.filter( function ( s ){ return s.kind === kind; } ).map( function ( s ){ return { value: s.id, text: s.name }; } );
        pk.set( activeId );
    }

    function openDialog()
    {
        editingId = ( root.getAttribute( 'data-theme' ) === 'light' ) ? data.activeLight : data.activeDark;
        loadDraft();
        clearMsg();
        document.getElementById( 'scmBackdrop' ).showModal();
        render();
    }
    function closeDialog() { document.getElementById( 'scmBackdrop' ).close(); }

    // However it closes - its x, or Escape (Ayni presses the x) - the
    // live preview goes.
    scmBack.addEventListener( 'close', function ()
    {
        NKEYS.forEach( function ( k ){ root.style.removeProperty( k ); } );
        root.style.removeProperty( '--on-accent' );
        if( window.Ayni ) Ayni.setTheme( Ayni.theme.mode() );   // re-applies the stored schemes
    } );

    closeBtn.addEventListener( 'click', closeDialog );

    listEl.addEventListener( 'click', function ( e )
    {
        var row = e.target.closest( '.scm-row' );
        if( ! row ) return;
        editingId = row.dataset.id;
        loadDraft();
        clearMsg();
        render();
    } );

    nameEl.addEventListener( 'input', function (){ draft.name = this.value; render(); } );

    [ kindDark, kindLite ].forEach( function ( btn )
    {
        btn.addEventListener( 'click', function ()
        {
            var k = this.dataset.kind;
            if( k === draft.kind ) return;
            var savedKind = find( editingId ).kind;
            if( savedKind !== k && countKind( savedKind, editingId ) === 0 )
            {
                showMsg( Ayni.tf( 'ayni.scm.needOne', { kind: savedKind === 'dark' ? Ayni.t( 'ayni.scm.darkWord' ) : Ayni.t( 'ayni.scm.lightWord' ) } ) );
                return;
            }
            // Keep the default accent right for the new mode; a chosen colour stays.
            if( draft.tokens[ '--accent' ].toLowerCase() === ACCENT[ draft.kind ] ) draft.tokens[ '--accent' ] = ACCENT[ k ];
            draft.kind = k;
            clearMsg();
            render();
        } );
    } );

    NKEYS.forEach( function ( k )
    {
        col[ k ].addEventListener( 'input', function (){ draft.tokens[ k ] = this.value.toLowerCase(); render(); } );
        hex[ k ].addEventListener( 'input', function ()
        {
            var v = norm( this.value );
            if( HEX.test( v ) ) { draft.tokens[ k ] = v; this.classList.remove( 'bad' ); render(); }
            else this.classList.add( 'bad' );
        } );
        hex[ k ].addEventListener( 'blur', render );
    } );

    saveBtn.addEventListener( 'click', function ()
    {
        var s = find( editingId );
        s.name   = draft.name.trim() || s.name;
        s.kind   = draft.kind;
        s.tokens = toStore( draft.tokens );
        reconcile();
        loadDraft();
        persist(); clearMsg(); Ayni.toast( 'ok', Ayni.t( 'ayni.saved' ) ); render();
    } );

    newBtn.addEventListener( 'click', function ()
    {
        var id = 's' + Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 5 );
        data.schemes.push( {
            id: id,
            name: draft.name.trim() || Ayni.t( 'ayni.scm.newScheme' ),
            kind: draft.kind,
            tokens: toStore( draft.tokens )
        } );
        editingId = id;
        loadDraft();
        persist(); clearMsg(); Ayni.toast( 'ok', Ayni.t( 'ayni.scm.created' ) ); render();
    } );

    delBtn.addEventListener( 'click', function ()
    {
        if( delBtn.ariaDisabled === 'true' ) return;
        var s = find( editingId );
        var at = data.schemes.indexOf( s ), wasDark = data.activeDark === s.id, wasLight = data.activeLight === s.id;
        data.schemes = data.schemes.filter( function ( x ){ return x.id !== s.id; } );
        reconcile();
        editingId = ( firstOfKind( s.kind ) || data.schemes[ 0 ] ).id;
        loadDraft();
        persist(); clearMsg(); render();
        // Undo: the scheme back in its place, and in use again if it was.
        Ayni.toast( 'ok', Ayni.t( 'ayni.deleted' ), { undo: function ()
        {
            if( find( s.id ) ) return;
            data.schemes.splice( Math.min( at, data.schemes.length ), 0, s );
            if( wasDark )  data.activeDark  = s.id;
            if( wasLight ) data.activeLight = s.id;
            persist();
            if( ! scmBack.open ) { if( window.Ayni ) Ayni.setTheme( Ayni.theme.mode() ); return; }   // re-applies the stored schemes
            editingId = s.id;
            loadDraft(); clearMsg(); render();
        } } );
    } );

    selDark.addEventListener( 'ayni:change', function ( e ){ data.activeDark  = e.detail.value; persist(); render(); } );
    selLite.addEventListener( 'ayni:change', function ( e ){ data.activeLight = e.detail.value; persist(); render(); } );

    // Keep the in-memory model consistent, but don't write to localStorage until
    // the user actually changes something - a fresh install stays 100% ayni-base.css.
    reconcile();

    // A page that loads this file late still gets the dialog wired and translated.
    Ayni.ready.then( function () { Ayni.i18n.apply( scmBack ); Ayni.init( scmBack ); } );

    Ayni.schemeDialog = openDialog;
} )();
