/*
 * toolbar.js - Write's formatting strip (#toolbar in index.html).
 *
 * Every button that DOES something carries data-slot="text.bold" etc.: one of
 * the engine's toolbar slots (its chrome vocabulary). A click runs it, and the
 * engine says what each one looks like - enabled, pressed, its current value -
 * through toolbarCommandStates(). So a button can never disagree with the
 * engine about whether bold is on, whether there is anything to undo, or
 * whether the caret is somewhere a footnote may go.
 *
 * The drop-downs (aria-haspopup) open the pull-down menus' own panel
 * (AyniMenus.openItems in shared/ayni/ayni-menutable.js) with the SAME item tables the
 * Formato / Insertar / Ver menus use - the colours, the styles, the zoom - so a
 * drop-down and its menu entry are one table and one set of handlers.
 *
 * The two drop-down LISTS (font, size) are .tb-select, as in Calc.
 *
 * No engine import here: write.js hands in the functions (it is the one file
 * tools/build-docx-editor.sh rewrites when the engine is bumped).
 *
 *   const bar = createToolbar( {
 *       states   : slots => toolbarCommandStates( editor, slots ),
 *       run      : ( slot, value ) => ...,        // runToolbarCommand + focus
 *       painter  : () => ...,                     // the format painter's on / off
 *       blocked  : slot => bool,                  // greyed although the engine would run it
 *       menus    : MENUBAR,                       // AyniMenus.create( ... )
 *       dropdowns: { stylesBtn: items | fn, ... },
 *       fonts    : [ 'Arial', ... ],  sizes: [ '8', ... ],  // points
 *       after    : () => ...                     // Write's own buttons, painted in the same frame
 *   } );
 *   bar.refresh()    after a selection move or an edit (coalesced to a frame)
 */

// Slots whose control is a pressed / not-pressed toggle (aria-pressed).
const TOGGLES = new Set( [ 'text.bold', 'text.italic', 'text.underline', 'text.strike',
                           'script.super', 'script.sub', 'list.bullet', 'list.numbered',
                           'format.painter', 'review.paragraphMarks' ] );

// Slots read for a drop-down's trigger or a list's value, not a button of their own.
const VALUE_SLOTS = [ 'styles.style', 'font.family', 'font.size', 'text.color', 'text.highlight',
                      'list.lineSpacing', 'alignment.left', 'alignment.center', 'alignment.right',
                      'alignment.justify' ];

// Which slot decides whether a drop-down's trigger is usable.
const TRIGGER_SLOT = { stylesBtn: 'styles.style', colorBtn: 'text.color', highlightBtn: 'text.highlight',
                       alignBtn: 'alignment.left', lineSpacingBtn: 'list.lineSpacing' };

// Word's highlight colours by name (the engine takes ST_HighlightColor names).
const HIGHLIGHT_HEX = { yellow: '#FFFF00', green: '#00FF00', cyan: '#00FFFF', magenta: '#FF00FF',
                        blue: '#0000FF', red: '#FF0000', darkBlue: '#000080', darkCyan: '#008080',
                        darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
                        darkYellow: '#808000', darkGray: '#808080', lightGray: '#C0C0C0',
                        black: '#000000', white: '#FFFFFF' };

export function createToolbar( o )
{
    const bar     = document.getElementById( 'toolbar' );
    const buttons = [ ...bar.querySelectorAll( 'button[data-slot]' ) ];
    // Ayni list pickers (the size a combo box: any size can be typed)
    const famSel  = Ayni.picker( document.getElementById( 'fontFamilySel' ) );
    const sizeSel = Ayni.picker( document.getElementById( 'fontSizeSel' ), { mode: 'combo' } );
    const slots   = [ ...new Set( buttons.map( function( b ) { return b.dataset.slot; } ).concat( VALUE_SLOTS ) ) ];

    let queued  = false;

    fill( famSel,  o.fonts.map( function( f ) { return [ f, f ]; } ) );
    fill( sizeSel, o.sizes.map( function( s ) { return [ s, s ]; } ) );

    // A toolbar button never takes the focus: the engine keeps its caret and
    // selection, and the command lands where the user left them. (The two
    // lists are Ayni's: in a toolbar they hand the focus back themselves.)
    bar.addEventListener( 'mousedown', function( e )
    {
        if( e.target.closest( 'button' ) ) e.preventDefault();
    } );

    bar.addEventListener( 'click', function( e )
    {
        const b = e.target.closest( 'button' );
        if( ! b || b.ariaDisabled === 'true' ) return;

        const slot = b.dataset.slot;
        if( slot === 'format.painter' ) { o.painter(); return; }
        if( slot ) { o.run( slot ); return; }

        const items = o.dropdowns[ b.id ];
        if( ! items ) return;

        e.stopPropagation();
        o.menus.openItems( items, b );        // a second press closes it (Ayni.menuAt)
    } );

    famSel.element.addEventListener( 'ayni:change', function( e )
    {
        if( e.detail.value ) o.run( 'font.family', e.detail.value );
    } );

    // The list is in points; the engine counts half-points. A typed size that
    // is not one (or past Word's 1638) changes nothing: the selection's own comes back.
    sizeSel.element.addEventListener( 'ayni:change', function( e )
    {
        const pt = parseFloat( String( e.detail.value ).replace( ',', '.' ) );
        if( pt > 0 && pt <= 1638 ) o.run( 'font.size', Math.round( pt * 2 ) );
        else refresh();
    } );

    //---- showing the engine's state ------------------------------------------

    function refresh()
    {
        if( queued ) return;
        queued = true;
        requestAnimationFrame( function() { queued = false; paint(); } );
    }

    function paint()
    {
        let list;
        try { list = o.states( slots ); } catch( _ ) { return; }
        if( ! list ) return;

        const by = {};
        for( const s of list ) by[ s.id ] = s;

        for( const b of buttons )
        {
            const s = by[ b.dataset.slot ];
            if( ! s ) continue;

            b.ariaDisabled = ! s.enabled || ( !! o.blocked && o.blocked( b.dataset.slot ) );
            b.setAttribute( 'aria-pressed', !! s.active );
            if( TOGGLES.has( b.dataset.slot ) ) b.setAttribute( 'aria-pressed', String( !! s.active ) );
        }

        for( const id in TRIGGER_SLOT )
        {
            const s = by[ TRIGGER_SLOT[ id ] ];
            document.getElementById( id ).ariaDisabled = ! s || ! s.enabled;
        }

        showValue( famSel,  by[ 'font.family' ], function( v ) { return v; } );
        showValue( sizeSel, by[ 'font.size' ],   function( v ) { return String( Number( v ) / 2 ); } );

        const col = by[ 'text.color' ]     && by[ 'text.color' ].value;
        const hl  = by[ 'text.highlight' ] && by[ 'text.highlight' ].value;

        bar.querySelector( '#colorBtn' ).style.setProperty( '--tb-bar', /^[0-9A-Fa-f]{6}$/.test( col || '' ) ? '#' + col : '' );
        bar.querySelector( '#highlightBtn' ).style.setProperty( '--tb-bar', HIGHLIGHT_HEX[ hl ] || '' );

        if( o.after ) o.after();
    }

    // A list shows the selection's value, also one it does not name (a 10.5 pt
    // size, a font the list does not hold: shown, not added).
    function showValue( sel, st, fmt )
    {
        sel.disabled = ! st || ! st.enabled;

        const v = st && st.value !== undefined && st.value !== null && st.value !== '' ? fmt( st.value ) : '';

        // '' = a mixed selection: nothing shown. Never under the user's typing (the size box)
        if( document.activeElement !== sel.field ) sel.set( v );
    }

    function fill( sel, pairs )
    {
        sel.options = pairs.map( function( p ) { return { value: p[ 0 ], text: p[ 1 ] }; } );
    }

    return { refresh: refresh };
}
