/* -----------------------------------------------------------------------------
 * ayni-menutable.js  -  AyniMenus
 *
 * The classic pull-down menu bar (Archivo · Edición · Ver …) that Write and Calc
 * offer as an ALTERNATIVE to their icon toolbar, plus the little switch that
 * remembers which of the two the user picked.
 *
 * The bar is an Ayni menu bar and its menus are Ayni menus (shared/ayni/
 * ayni-menus.js: F10, the arrows, sliding along the bar, one level of
 * submenus, Escape, a press outside). What differs between the two apps is
 * only the TABLE of menus and how an entry is carried out - both of which
 * come in as options.
 *
 * THE GOLDEN RULE. A menu entry never re-implements anything. It either clicks
 * the app's real (hidden) toolbar button (`el`), calls the very function that
 * button is wired to (`run`), or hands the app a verb to run (`cmd`, through
 * cfg.exec). So there is only ever ONE set of handlers, whichever chrome shows.
 *
 * -----------------------------------------------------------------------------
 * AyniMenus.create( cfg ) -> { build, close, isOpen, openAt, openItems, anchorRect, rect }
 *
 *   cfg.bar                   the bar's id (default menuBar); its menus get
 *                             the ids menuBar-0, menuBar-1 ...
 *   cfg.menus                 [ { key|text, items: [...] } ]  - array or a function
 *   cfg.hint( scKey )         -> "Ctrl+S"   the key combo shown on the right
 *   cfg.ready()               -> false greys EVERY entry (a document still loading)
 *   cfg.enabled( it )         -> true/false, or undefined to fall through
 *   cfg.checked( it )         -> true/false (a row that can be ticked), or
 *                                undefined to fall through (a plain row)
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
 *   { label: 'key' }          a small heading over the rows below it (not a row)
 *   { info: 'key' }           ... on a row: that text as the row's tooltip
 *   { checked: fn }           tick when fn() says so
 *   { enabled: fn }           grey out when fn() says no
 *   { sc:'ui.openDoc' }       show that shortcut's key combo on the right
 *   { swatch:'#c00' }         a colour chip before the label
 *   { iconOf:'#x svg' }       a glyph before the label: that element's <svg>,
 *                             cloned - the toolbar's own icon, so the two never
 *                             drift. An `el` entry does this for its button by
 *                             itself, unless it names an `icon` instead.
 *   { icon:'cut' }            ... or a Ayni.icon() name, or SVG markup -
 *                             for entries the toolbar has no button for
 *
 * Anything else on an item (check, radio, arg …) is the app's business and
 * reaches it untouched through cfg.checked / cfg.enabled / cfg.exec.
 *
 * openItems( items, trigger ) opens the same rows in a drop-down (Ayni.menuAt)
 * hanging under a button that is not on the bar - a toolbar drop-down
 * (Write's styles, colours, zoom ...); a second press on the trigger closes
 * it. Given a rectangle instead of a button, it hangs from that - a
 * right-click menu at the pointer (Write's spelling suggestions).
 *
 * -----------------------------------------------------------------------------
 * AyniMenus.chrome( cfg ) -> { on, mode, set, apply, sync, wire }
 *
 *   cfg.key       localStorage key            ('app-chrome')
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
 * The bar's place - #menuBar - is in shared/app.css; the bar and its menus are Ayni's.
 *
 * -----------------------------------------------------------------------------
 * AyniMenus.COLORS   the text colours both menus offer (Word's and Excel's
 *                      own first row, plus white): [ swatch, name key ], the
 *                      name as 'ui.color.' + key - no interface string lives
 *                      in the source (docs/i18n.md).
 * ---------------------------------------------------------------------------*/

const AyniMenus = ( function ()
{
    "use strict";

    function gid( id ) { return document.getElementById( id ); }

    //-------------------------------------------------------------------------
    // THE BAR
    //-------------------------------------------------------------------------
    function create( cfg )
    {
        const BAR = cfg.bar || 'menuBar';

        let lastRect = null;     // rect of the entry that opened an anchored popup

        function list() { return typeof cfg.menus === 'function' ? cfg.menus() : ( cfg.menus || [] ); }

        //---- one entry -------------------------------------------------------

        function itemEnabled( it )
        {
            if( cfg.ready && ! cfg.ready() ) return false;
            if( it.enabled ) return !! it.enabled();

            if( it.el )
            {
                const b = gid( it.el );
                return !! b && ! b.disabled && b.ariaDisabled !== 'true';
            }

            if( cfg.enabled )
            {
                const r = cfg.enabled( it );
                if( r !== undefined ) return !! r;
            }

            return true;
        }

        // true / false for a row that can be ticked, null for one that cannot.
        function itemChecked( it )
        {
            if( it.checked ) return !! it.checked();

            if( cfg.checked )
            {
                const r = cfg.checked( it );
                if( r !== undefined ) return !! r;
            }

            return null;
        }

        // The glyph before the label: markup (an <svg>, or a character), or ''.
        // Read at open time like everything else on a row, so an icon a toolbar
        // draws late still shows up, and a bad selector costs the glyph - never
        // the menu.
        function iconFor( it )
        {
            if( it.swatch )
                return '<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="2" width="14" height="14" rx="3" fill="' + it.swatch +
                       '" stroke="currentColor" stroke-opacity=".35"></rect></svg>';

            const src = it.iconOf || ( it.el && ! it.icon ? '#' + it.el : null );
            let   svg = null;

            if( src )
            {
                let n = null;
                try { n = document.querySelector( src ); } catch ( _ ) {}

                // A named icon may not be drawn yet: the name is enough.
                const named = n && ! ( n instanceof SVGSVGElement ) && n.querySelector( '.icon[data-icon]' );
                if( named ) return Ayni.icon( named.dataset.icon );
                if( n ) svg = n instanceof SVGSVGElement ? n : n.querySelector( 'svg' );
                if( svg ) svg = svg.cloneNode( true );

                // A button whose glyph is a character (Calc's "∑") lends that
                // instead - the same rule the help sheet's list follows.
                const txt = ! svg && n && ( n.textContent || '' ).trim();
                if( txt && txt.length <= 2 )
                {
                    const d = document.createElement( 'span' );
                    d.className   = 'icon mi-char';
                    d.textContent = txt;
                    return d.outerHTML;
                }
            }

            if( ! svg ) return it.icon || '';

            svg.removeAttribute( 'width' );          // CSS sizes it
            svg.removeAttribute( 'height' );
            svg.removeAttribute( 'id' );
            svg.setAttribute( 'aria-hidden', 'true' );
            return svg.outerHTML;
        }

        // A table's rows as Ayni menu rows (Ayni.menuAt, Ayni.fillMenu).
        function rows( items )
        {
            return ( typeof items === 'function' ? items() : items || [] ).map( function ( it )
            {
                if( it.sep )   return { sep: true };
                if( it.label ) return { caption: Ayni.t( it.label ) };
                return {
                    id:       it.el || it.cmd || it.key || '',
                    label:    it.text !== undefined ? it.text : Ayni.t( it.key ),
                    icon:     iconFor( it ),
                    key:      ! it.sub && it.sc && cfg.hint ? cfg.hint( it.sc ) : '',
                    checked:  it.sub ? null : itemChecked( it ),
                    disabled: ! it.sub && ! itemEnabled( it ),
                    why:      it.info ? Ayni.t( it.info ) : '',
                    sub:      it.sub ? function () { return rows( it.sub ); } : null,
                    run:      function ( e )
                    {
                        const row = e && e.target && e.target.closest && e.target.closest( '[role^="menuitem"]' );
                        runItem( it, row && row.ayniRect );
                    }
                };
            } );
        }

        //---- opening and closing ---------------------------------------------

        // A drop-down off a button that is not on the bar (Ayni.menuAt: a second
        // press on the button closes it), or off a rectangle (a right-click
        // menu at the pointer, a list under a menu row).
        function openItems( items, anchor )
        {
            if( ! anchor ) return;
            const btn = typeof anchor.getBoundingClientRect === 'function' ? anchor : null;
            Ayni.menuAt( rows( items ), btn ? { anchor: btn } : { x: anchor.left, y: anchor.bottom + 2 } );
        }

        // Run what an entry stands for. The rect is kept because a popup anchored
        // to a toolbar button (borders, symbols) must hang from the menu row
        // instead while that button is collapsed - see anchorRect().
        function runItem( it, rect )
        {
            if( ! it || it.sub ) return;

            lastRect = rect || null;

            if( it.run ) { it.run(); return; }

            if( it.el )
            {
                const b = gid( it.el );
                if( b && ! b.disabled && b.ariaDisabled !== 'true' ) b.click();
                return;
            }

            if( cfg.exec ) cfg.exec( it );
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

        // The bar itself is Ayni's (F10, the arrows, sliding along it): each menu
        // is filled from the table when it opens, so its rows show what is true now.
        const bar = gid( BAR ) && Ayni.menuBar( gid( BAR ), { menus: function ()
        {
            return list().map( function ( m )
            {
                return { key: m.key, label: m.text, items: function () { return rows( m.items ); } };
            } );
        } } );

        return {
            build:      function () { if( bar ) bar.build(); },
            close:      function () { document.querySelectorAll( '.panel.menu:popover-open' ).forEach( function ( m ) { m.hidePopover(); } ); },
            isOpen:     function () { return !! document.querySelector( '.panel.menu:popover-open' ); },
            openAt:     function ( i ) { if( bar ) bar.openAt( i ); },
            openItems:  openItems,
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

        // The two header buttons, <button class="btn chrome-btn" data-chrome="…">.
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

    const COLORS = [ [ '#000000', 'black'  ], [ '#808080', 'gray'   ], [ '#C00000', 'red'    ],
                     [ '#E36C0A', 'orange' ], [ '#FFC000', 'yellow' ], [ '#00B050', 'green'  ],
                     [ '#0070C0', 'blue'   ], [ '#7030A0', 'purple' ], [ '#FFFFFF', 'white'  ] ];

    return { create: create, chrome: chrome, COLORS: COLORS };
} )();
