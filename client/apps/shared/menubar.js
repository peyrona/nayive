/* -----------------------------------------------------------------------------
 * shared/menubar.js  -  NayiveMenus
 *
 * The classic pull-down menu bar (Archivo · Edición · Ver …) that Write and Calc
 * offer as an ALTERNATIVE to their icon toolbar, plus the little switch that
 * remembers which of the two the user picked.
 *
 * Written once here because both apps need exactly the same machinery: a row of
 * text buttons, one panel under the open one, one submenu to the side, hover to
 * slide from menu to menu, click-outside to close. What differs between the two
 * apps is only the TABLE of menus and how an entry is carried out - both of
 * which come in as options.
 *
 * THE GOLDEN RULE. A menu entry never re-implements anything. It either clicks
 * the app's real (hidden) toolbar button (`el`), calls the very function that
 * button is wired to (`run`), or hands the app a verb to run (`cmd`, through
 * cfg.exec). So there is only ever ONE set of handlers, whichever chrome shows.
 *
 * -----------------------------------------------------------------------------
 * NayiveMenus.create( cfg ) -> { build, close, isOpen, openAt, anchorRect, rect }
 *
 *   cfg.bar / .panel / .sub   element ids  (default menuBar / menuPanel / menuSub)
 *   cfg.menus                 [ { key|text, items: [...] } ]  - array or a function
 *   cfg.hint( scKey )         -> "Ctrl+S"   the key combo shown on the right
 *   cfg.ready()               -> false greys EVERY entry (a document still loading)
 *   cfg.enabled( it )         -> true/false, or undefined to fall through
 *   cfg.checked( it )         -> true/false, or undefined to fall through
 *   cfg.exec( it )            carry out an entry that has neither `run` nor `el`
 *
 * An item is:
 *
 *   { key }                   label (an i18n key)
 *   { text }                  label already in plain text (a font name, "12")
 *   { el:'saveAsBtn' }        click that button - and grey the entry out when
 *                             the button itself is disabled
 *   { cmd:'bold', arg }       hand it to cfg.exec
 *   { run: fn }               call it
 *   { sub: [...] | fn }       a submenu (a function is called at open time)
 *   { sep: true }             a hairline
 *   { checked: fn }           tick when fn() says so
 *   { enabled: fn }           grey out when fn() says no
 *   { sc:'ui.openDoc' }       show that shortcut's key combo on the right
 *   { swatch:'#c00' }         a colour chip before the label
 *   { iconOf:'#x svg' }       a glyph before the label: that element's <svg>,
 *                             cloned - the toolbar's own icon, so the two never
 *                             drift. An `el` entry does this for its button by
 *                             itself, unless it names an `icon` instead.
 *   { icon:'cut' }            ... or a NayiveUI.icon() name, or SVG markup -
 *                             for entries the toolbar has no button for
 *
 * Anything else on an item (check, radio, arg …) is the app's business and
 * reaches it untouched through cfg.checked / cfg.enabled / cfg.exec.
 *
 * -----------------------------------------------------------------------------
 * NayiveMenus.chrome( cfg ) -> { on, mode, set, apply, sync, wire }
 *
 *   cfg.key       localStorage key            ('nayive-calc-chrome')
 *   cfg.root      element to carry .is-menus  (default 'app')
 *   cfg.bar       the menu bar to show / hide (default 'menuBar')
 *   cfg.menus     the object create() returned - closed on every switch
 *   cfg.load()    async -> 'menus' | 'toolbar' | null   the ACCOUNT's copy
 *   cfg.save( m ) async, fire and forget                push it up
 *   cfg.apply( on )  whatever else the app must do (move the "?", unfold …)
 *
 * The choice is remembered TWICE: in localStorage, so this browser opens the
 * same way with no network, and in the account's config.json, so a different
 * device opens the way the user left it. At boot the account's copy wins
 * (sync()); after that a click writes both (set()).
 *
 * The CSS - #menuBar, .menu-top, .menu-panel, .mi-* - lives in shared/app.css,
 * next to the .top-menu / .menu-item vocabulary the panels are built on.
 * ---------------------------------------------------------------------------*/

const NayiveMenus = ( function ()
{
    "use strict";

    function gid( id ) { return document.getElementById( id ); }

    //-------------------------------------------------------------------------
    // THE BAR
    //-------------------------------------------------------------------------
    function create( cfg )
    {
        const BAR   = cfg.bar   || 'menuBar';
        const PANEL = cfg.panel || 'menuPanel';
        const SUB   = cfg.sub   || 'menuSub';

        let openIdx    = -1;     // which top-level menu is showing, or -1
        let panelItems = [];     // the items the open panel was built from
        let subItems   = [];     // ... and its submenu
        let lastRect   = null;   // rect of the entry that opened an anchored popup

        function list() { return typeof cfg.menus === 'function' ? cfg.menus() : ( cfg.menus || [] ); }

        //---- one entry -------------------------------------------------------

        function itemEnabled( it )
        {
            if( cfg.ready && ! cfg.ready() ) return false;
            if( it.enabled ) return !! it.enabled();

            if( it.el )
            {
                const b = gid( it.el );
                return !! b && ! b.disabled;
            }

            if( cfg.enabled )
            {
                const r = cfg.enabled( it );
                if( r !== undefined ) return !! r;
            }

            return true;
        }

        function itemChecked( it )
        {
            if( it.checked ) return !! it.checked();

            if( cfg.checked )
            {
                const r = cfg.checked( it );
                if( r !== undefined ) return !! r;
            }

            return false;
        }

        // The glyph before the label (an <svg>, or a character), or null. Read at open time like everything
        // else on a row, so an icon a toolbar draws late (SuperDoc's) still
        // shows up, and a bad selector costs the glyph - never the menu.
        function iconNode( it )
        {
            const src = it.iconOf || ( it.el && ! it.icon ? '#' + it.el : null );
            let   svg = null;

            if( src )
            {
                let n = null;
                try { n = document.querySelector( src ); } catch ( _ ) {}

                if( n ) svg = n instanceof SVGSVGElement ? n : n.querySelector( 'svg' );
                if( svg ) svg = svg.cloneNode( true );

                // A button whose glyph is a character (Calc's "∑") lends that
                // instead - the same rule the help sheet's list follows.
                const txt = ! svg && n && ( n.textContent || '' ).trim();
                if( txt && txt.length <= 2 ) return document.createTextNode( txt );
            }

            if( ! svg && it.icon )
            {
                const t = document.createElement( 'template' );
                t.innerHTML = it.icon.charAt( 0 ) === '<' ? it.icon : NayiveUI.icon( it.icon );
                svg = t.content.querySelector( 'svg' );
            }

            if( ! svg ) return null;

            svg.removeAttribute( 'width' );          // CSS sizes it
            svg.removeAttribute( 'height' );
            svg.removeAttribute( 'id' );
            svg.setAttribute( 'aria-hidden', 'true' );

            return svg;
        }

        // `glyph` undefined: the panel has no icons, so no slot at all.
        // null: an empty slot, so this label lines up with its neighbours'.
        function menuItemNode( it, idx, glyph )
        {
            if( it.sep )
            {
                const d = document.createElement( 'div' );
                d.className = 'menu-sep';
                return d;
            }

            const b = document.createElement( 'button' );
            b.type        = 'button';
            b.className   = 'menu-item';
            b.dataset.idx = String( idx );
            b.setAttribute( 'role', 'menuitem' );

            const chk = document.createElement( 'span' );
            chk.className   = 'mi-check';
            chk.textContent = '✓';
            b.appendChild( chk );

            if( glyph !== undefined )
            {
                const ic = document.createElement( 'span' );
                ic.className = 'mi-icon';
                if( glyph ) ic.appendChild( glyph );
                b.appendChild( ic );
            }

            if( it.swatch )
            {
                const sw = document.createElement( 'span' );
                sw.className        = 'mi-swatch';
                sw.style.background = it.swatch;
                b.appendChild( sw );
            }

            const lab = document.createElement( 'span' );
            lab.className   = 'mi-label';
            lab.textContent = it.text !== undefined ? it.text : NayiveUI.t( it.key );
            b.appendChild( lab );

            if( it.sub )
            {
                const a = document.createElement( 'span' );
                a.className   = 'mi-arrow';
                a.textContent = '▸';
                b.appendChild( a );
            }
            else if( it.sc && cfg.hint )
            {
                const k = document.createElement( 'span' );
                k.className   = 'mi-key';
                k.textContent = cfg.hint( it.sc );
                b.appendChild( k );
            }

            if( itemChecked( it ) ) b.classList.add( 'is-active' );
            if( ! it.sub && ! itemEnabled( it ) ) b.disabled = true;

            return b;
        }

        // Icons are all or nothing per panel: once one row has a glyph, every row
        // keeps the slot. A panel with none (fonts, sizes, colours) stays tight.
        function fillPanel( panel, items )
        {
            panel.innerHTML = '';

            const glyphs = items.map( function ( it ) { return it.sep ? null : iconNode( it ); } );
            const slot   = glyphs.some( Boolean );

            items.forEach( function ( it, i ) { panel.appendChild( menuItemNode( it, i, slot ? glyphs[ i ] : undefined ) ); } );
        }

        //---- placing ---------------------------------------------------------

        // Under the thing that opened it, pushed left if it would fall off the edge.
        function placePanel( panel, rect )
        {
            const vw = document.documentElement.clientWidth;

            let left = Math.min( rect.left, vw - panel.offsetWidth - 8 );
            if( left < 8 ) left = 8;

            panel.style.top  = ( rect.bottom + 2 ) + 'px';
            panel.style.left = left + 'px';
        }

        // A submenu goes to the RIGHT of its row, or to the left when there is no room.
        function placeSub( panel, rect )
        {
            const vw = document.documentElement.clientWidth;
            const vh = document.documentElement.clientHeight;

            let left = rect.right - 2;
            if( left + panel.offsetWidth > vw - 8 ) left = Math.max( 8, rect.left - panel.offsetWidth + 2 );

            let top = rect.top - 4;
            if( top + panel.offsetHeight > vh - 8 ) top = Math.max( 8, vh - panel.offsetHeight - 8 );

            panel.style.top  = top  + 'px';
            panel.style.left = left + 'px';
        }

        //---- opening and closing ---------------------------------------------

        function closeSub()
        {
            const p = gid( SUB );
            if( ! p ) return;

            p.hidden    = true;
            p.innerHTML = '';
            subItems    = [];
        }

        function close()
        {
            closeSub();

            const p = gid( PANEL );
            if( p ) { p.hidden = true; p.innerHTML = ''; }
            panelItems = [];

            for( const b of document.querySelectorAll( '#' + BAR + ' .menu-top' ) )
                b.setAttribute( 'aria-expanded', 'false' );

            openIdx = -1;
        }

        function openAt( i )
        {
            close();

            const btn   = document.querySelector( '#' + BAR + ' [data-menu="' + i + '"]' );
            const panel = gid( PANEL );
            const m     = list()[ i ];
            if( ! btn || ! panel || ! m ) return;

            panelItems = m.items;
            fillPanel( panel, panelItems );

            panel.hidden = false;              // lay it out before measuring
            placePanel( panel, btn.getBoundingClientRect() );
            btn.setAttribute( 'aria-expanded', 'true' );

            openIdx = i;
        }

        function openSubFor( row, it )
        {
            closeSub();

            const panel = gid( SUB );
            if( ! panel ) return;

            subItems = typeof it.sub === 'function' ? it.sub() : it.sub;
            fillPanel( panel, subItems );

            panel.hidden = false;
            placeSub( panel, row.getBoundingClientRect() );
        }

        // Run what an entry stands for. The rect is kept because a popup anchored
        // to a toolbar button (borders, symbols) must hang from the menu row
        // instead while that button is collapsed - see anchorRect().
        function runItem( it, rect )
        {
            if( ! it || it.sub ) return;

            lastRect = rect || null;
            close();

            if( it.run ) { it.run(); return; }

            if( it.el )
            {
                const b = gid( it.el );
                if( b && ! b.disabled ) b.click();
                return;
            }

            if( cfg.exec ) cfg.exec( it );
        }

        //---- the bar itself --------------------------------------------------

        function build()
        {
            const bar = gid( BAR );
            if( ! bar ) return;

            bar.innerHTML = '';

            list().forEach( function ( m, i )
            {
                const b = document.createElement( 'button' );
                b.type         = 'button';
                b.className    = 'menu-top';
                b.dataset.menu = String( i );
                b.setAttribute( 'role', 'menuitem' );
                b.setAttribute( 'aria-haspopup', 'true' );
                b.setAttribute( 'aria-expanded', 'false' );

                // applyI18n fills it in - and re-fills it on a language change.
                if( m.key ) b.setAttribute( 'data-i18n', m.key );
                else        b.textContent = m.text || '';

                bar.appendChild( b );
            } );

            NayiveUI.applyI18n( bar );
        }

        function wire()
        {
            const bar   = gid( BAR );
            const panel = gid( PANEL );
            const sub   = gid( SUB );
            if( ! bar || ! panel || ! sub ) return;

            // Never let a menu click blur the page: the commands act on the caret
            // (Write) or the grid selection (Calc), and a lost selection greys
            // half of "Formato" out.
            //
            // A real field parked in the bar is the one exception - Calc moves its
            // name box in here in menu mode, and a cancelled mousedown never gives
            // an <input> the focus, so it could be seen but not typed into.
            for( const el of [ bar, panel, sub ] )
                el.addEventListener( 'mousedown', function ( e )
                {
                    if( e.target.closest( 'input, select, textarea' ) ) return;
                    e.preventDefault();
                } );

            bar.addEventListener( 'click', function ( e )
            {
                const b = e.target.closest( '.menu-top' );
                if( ! b ) return;

                e.stopPropagation();

                const i = Number( b.dataset.menu );
                if( i === openIdx ) close(); else openAt( i );
            } );

            // Once one menu is open, sliding along the bar switches between them -
            // the way a pull-down bar has always behaved.
            bar.addEventListener( 'mouseover', function ( e )
            {
                if( openIdx < 0 ) return;

                const b = e.target.closest( '.menu-top' );
                if( ! b ) return;

                const i = Number( b.dataset.menu );
                if( i !== openIdx ) openAt( i );
            } );

            panel.addEventListener( 'mouseover', function ( e )
            {
                const row = e.target.closest( '.menu-item' );
                if( ! row ) return;

                const it = panelItems[ Number( row.dataset.idx ) ];
                if( it && it.sub ) openSubFor( row, it ); else closeSub();
            } );

            panel.addEventListener( 'click', function ( e )
            {
                const row = e.target.closest( '.menu-item' );
                if( ! row || row.disabled ) return;

                e.stopPropagation();

                const it = panelItems[ Number( row.dataset.idx ) ];
                if( ! it ) return;

                if( it.sub ) { openSubFor( row, it ); return; }

                runItem( it, row.getBoundingClientRect() );
            } );

            sub.addEventListener( 'click', function ( e )
            {
                const row = e.target.closest( '.menu-item' );
                if( ! row || row.disabled ) return;

                e.stopPropagation();
                runItem( subItems[ Number( row.dataset.idx ) ], row.getBoundingClientRect() );
            } );

            document.addEventListener( 'pointerdown', function ( e )
            {
                if( openIdx < 0 ) return;
                if( bar.contains( e.target ) || panel.contains( e.target ) || sub.contains( e.target ) ) return;

                close();
            }, true );

            // Escape closes the open menu and goes no further - the app's own
            // Escape chain (a popup, a dialog) must not fire at the same time.
            document.addEventListener( 'keydown', function ( e )
            {
                if( e.key !== 'Escape' || openIdx < 0 ) return;

                e.stopPropagation();
                close();
            }, true );

            window.addEventListener( 'resize', close );
        }

        // Where an anchored popup should hang from. In toolbar mode that is the
        // toolbar button that opened it; in menu mode the button is collapsed to
        // a zero-height sliver, so the menu row that ran the entry is the honest
        // anchor. `menusOn` is passed in - the bar does not know about chromes.
        function anchorRect( selector, menusOn, fallbackId )
        {
            if( menusOn && lastRect ) return lastRect;

            const btn = document.querySelector( selector ) || gid( fallbackId || 'app' );
            return btn.getBoundingClientRect();
        }

        build();
        wire();

        return {
            build:      build,
            close:      close,
            isOpen:     function () { return openIdx >= 0; },
            openAt:     openAt,
            anchorRect: anchorRect,
            rect:       function () { return lastRect; }
        };
    }

    //-------------------------------------------------------------------------
    // THE SWITCH
    //-------------------------------------------------------------------------
    function chrome( cfg )
    {
        const KEY  = cfg.key;
        const ROOT = cfg.root || 'app';
        const BAR  = cfg.bar  || 'menuBar';

        let mode = read();

        // Writes queue behind each other: the app's config.json is one
        // read-modify-write file, so two fast clicks must not race and lose
        // whatever else lives in it.
        let saving = Promise.resolve();

        function read()
        {
            try { return localStorage.getItem( KEY ) === 'menus' ? 'menus' : 'toolbar'; }
            catch ( _ ) { return 'toolbar'; }
        }

        function remember()
        {
            try { localStorage.setItem( KEY, mode ); } catch ( _ ) {}
        }

        function push()
        {
            if( ! cfg.save ) return;

            // Fire and forget: the local copy already took effect, and a
            // preference is not worth blocking the UI or a toast when the
            // network is down - the next change (or the next load, which pushes
            // it up) will carry it.
            const m = mode;
            saving  = saving.then( function () { return cfg.save( m ); } ).catch( function () {} );
        }

        function on() { return mode === 'menus'; }

        // The only things CSS cannot do: close whatever is open, mark the two
        // header buttons, and let the app put its own pieces back.
        function apply()
        {
            if( cfg.menus ) cfg.menus.close();

            const root = gid( ROOT );
            const bar  = gid( BAR );

            if( root ) root.classList.toggle( 'is-menus', on() );
            if( bar  ) bar.hidden = ! on();

            for( const b of document.querySelectorAll( '.chrome-btn' ) )
            {
                const isOn = ( b.dataset.chrome === 'menus' ) === on();
                b.classList.toggle( 'is-active', isOn );
                b.setAttribute( 'aria-pressed', isOn ? 'true' : 'false' );
            }

            if( cfg.apply ) cfg.apply( on() );
        }

        function set( next )
        {
            mode = next === 'menus' ? 'menus' : 'toolbar';

            remember();
            push();
            apply();
        }

        // At boot the ACCOUNT's copy wins, so a browser that has never been told
        // about the choice still opens the way the user left the app somewhere
        // else. Call it early, while the chrome is still hidden, so the switch -
        // if any - is invisible. Offline this reads nothing and the local copy
        // simply stands.
        async function sync()
        {
            if( ! cfg.load ) return;

            let saved;
            try { saved = await cfg.load(); } catch ( _ ) { return; }

            if( saved === 'menus' || saved === 'toolbar' )
            {
                if( saved === mode ) return;

                mode = saved;
                remember();
                apply();
                return;
            }

            // The account has no copy yet (first load since this was built).
            // Push this browser's choice up rather than silently dropping it.
            if( mode !== 'toolbar' ) push();
        }

        // The two header buttons, <button class="icon-btn chrome-btn" data-chrome="…">.
        function wire()
        {
            for( const b of document.querySelectorAll( '.chrome-btn' ) )
                b.addEventListener( 'click', function ( e ) { set( e.currentTarget.dataset.chrome ); } );
        }

        return {
            on:    on,
            mode:  function () { return mode; },
            set:   set,
            apply: apply,
            sync:  sync,
            wire:  wire
        };
    }

    return { create: create, chrome: chrome };
} )();
