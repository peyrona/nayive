/*
 * refs.js - Calc's coloured references: while a cell's "=…" is edited, each
 * reference in it gets a colour of its own - its text in the cell editor,
 * and a frame of the same colour round the cells it points at - as every
 * spreadsheet does. Imported by grid.js.
 *
 * Its top level runs BEFORE calc.js's `await NayiveI18n.ready`: nothing out
 * here may call T() or read another file's names - keep that inside functions.
 */

import
{
    decodeCell
}
from './lib/xlsx-format_v2.4.1.js';
import
{
    table, activeSheet
}
from './grid.js';

//------------------------------------------------------------------------//
// READING THE REFERENCES
//
// "B3", "B3:D7", "B:D", "3:5", each with an optional sheet in front
// ("Hoja2!A1", "'Mis datos'!A1:B2"). Text in quotes is skipped. Not a
// reference: anything glued to a name before it, or followed by "(" (LOG10(
// is a function) or more name. A cell just typed with its ":" still to be
// finished ("A1:") is already one - the colour comes on as it is typed.
// The character before it is matched (group 2) rather than looked behind
// at: a lookbehind does not even parse on an older Safari, and Calc would
// not load at all.

const REF = /("(?:[^"]|"")*")|(^|[^\w.$:!])((?:'(?:[^']|'')*'|[A-Za-z_][\w.]*)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)(?![\w(!])/g;

const COLORS = 8;            // --rf-0 … --rf-7 in calc.css, both colour schemes

// Column letters to an index: "A" 0, "AB" 27.
function colIndex( letters )
{
    return decodeCell( letters.toUpperCase() + '1' ).c;
}

// Where `text` (a reference, no sheet) sits on the grid. A whole column
// runs down to Infinity, a whole row across to it.
function refBounds( text )
{
    const ends = text.replace( /\$/g, '' ).toUpperCase().split( ':' );

    if( /^\d+$/.test( ends[ 0 ] ) )          // rows
    {
        const a = +ends[ 0 ] - 1, b = +ends[ 1 ] - 1;
        return { r1: Math.min( a, b ), r2: Math.max( a, b ), c1: 0, c2: Infinity };
    }

    if( /^[A-Z]+$/.test( ends[ 0 ] ) )       // columns
    {
        const a = colIndex( ends[ 0 ] ), b = colIndex( ends[ 1 ] );
        return { r1: 0, r2: Infinity, c1: Math.min( a, b ), c2: Math.max( a, b ) };
    }

    const a = decodeCell( ends[ 0 ] );
    const b = ends[ 1 ] ? decodeCell( ends[ 1 ] ) : a;
    return { r1: Math.min( a.r, b.r ), r2: Math.max( a.r, b.r ), c1: Math.min( a.c, b.c ), c2: Math.max( a.c, b.c ) };
}

// Every reference in `formula`, in order: where it is in the text, its
// colour, and - when it is on the sheet on screen - the cells it covers.
// The same reference twice gets the same colour; the colours go round
// again after the eighth.
function formulaRefs( formula )
{
    const list   = [];
    const colour = {};
    const here   = String( activeSheet.name || '' ).toLowerCase();
    let   m;

    REF.lastIndex = 0;
    while( ( m = REF.exec( formula ) ) !== null )
    {
        if( m[ 1 ] ) continue;               // a string

        const sheet = m[ 3 ] ? m[ 3 ].slice( 0, -1 ).replace( /^'([\s\S]*)'$/, '$1' ).replace( /''/g, "'" ) : null;
        const key   = ( sheet || '' ).toLowerCase() + '!' + m[ 4 ].replace( /\$/g, '' ).toUpperCase();
        if( ! ( key in colour ) ) colour[ key ] = Object.keys( colour ).length % COLORS;

        const b = refBounds( m[ 4 ] );
        const ok = b.r1 >= 0 && b.c1 >= 0 && ( sheet === null || sheet.toLowerCase() === here );

        const from = m.index + m[ 2 ].length;
        list.push( { from: from, to: m.index + m[ 0 ].length, color: colour[ key ], bounds: ok ? b : null } );
    }

    return list;
}

//------------------------------------------------------------------------//
// THE FRAMES ON THE GRID
//
// styledRenderer (grid.js) asks refAt() for every cell it draws. A cell in
// two references takes the smaller one's colour, so a cell named inside a
// range named too keeps a frame of its own.

let refs    = [];            // formulaRefs() of the editor's text, while it is a formula
let refsKey = '';            // what the grid was last drawn for

function refAt( row, col )
{
    let best = null, area = Infinity;

    for( const rf of refs )
    {
        const b = rf.bounds;
        if( ! b || row < b.r1 || row > b.r2 || col < b.c1 || col > b.c2 ) continue;

        const a = ( b.r2 - b.r1 + 1 ) * ( b.c2 - b.c1 + 1 );
        if( ! best || a < area ) { best = rf; area = a; }     // a whole column's area is Infinity
    }

    if( ! best ) return null;

    const b = best.bounds;
    return { color: best.color, t: row === b.r1, b: row === b.r2, l: col === b.c1, r: col === b.c2 };
}

//------------------------------------------------------------------------//
// THE COLOURS IN THE CELL EDITOR
//
// A textarea draws its text in one colour. So the coloured text is drawn by
// a copy laid exactly under it (.rf-mirror, inside the editor's holder):
// the textarea keeps the caret, the selection and every key, with its own
// text and background made transparent (.rf-on, calc.css). The copy takes
// the textarea's box and type on each change - Handsontable grows the
// editor as it is typed into - and follows its scroll.

const MIRROR_COPY = [ 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
                      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
                      'boxSizing', 'whiteSpace', 'overflowWrap', 'wordBreak', 'textAlign', 'tabSize', 'textIndent' ];

function escapeHtml( s )
{
    return s.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );
}

function mirrorOf( ta, make )
{
    let m = ta.parentNode && ta.parentNode.querySelector( ':scope > .rf-mirror' );
    if( ! m && make )
    {
        m = document.createElement( 'div' );
        m.className = 'rf-mirror';
        m.setAttribute( 'aria-hidden', 'true' );
        ta.parentNode.insertBefore( m, ta );

        ta.addEventListener( 'scroll', function() { m.scrollTop = ta.scrollTop; m.scrollLeft = ta.scrollLeft; } );
        if( window.ResizeObserver ) new ResizeObserver( function() { if( ta.classList.contains( 'rf-on' ) ) placeMirror( ta, m ); } ).observe( ta );
    }
    return m;
}

function placeMirror( ta, m )
{
    m.style.left   = ta.offsetLeft   + 'px';
    m.style.top    = ta.offsetTop    + 'px';
    m.style.width  = ta.offsetWidth  + 'px';
    m.style.height = ta.offsetHeight + 'px';
    m.scrollTop    = ta.scrollTop;
    m.scrollLeft   = ta.scrollLeft;
}

function paintMirror( ta, list )
{
    const m = mirrorOf( ta, true );

    // The textarea's own text colour and background, read while they are
    // still its own (before .rf-on makes them transparent).
    if( ! ta.classList.contains( 'rf-on' ) )
    {
        const cs = getComputedStyle( ta );
        m.style.color           = cs.color;
        m.style.backgroundColor = cs.backgroundColor;
        for( const p of MIRROR_COPY ) m.style[ p ] = cs[ p ];
        ta.classList.add( 'rf-on' );
    }

    const text = ta.value;
    let   html = '', at = 0;
    for( const rf of list )
    {
        html += escapeHtml( text.slice( at, rf.from ) )
              + '<span style="color:var(--rf-' + rf.color + ')">' + escapeHtml( text.slice( rf.from, rf.to ) ) + '</span>';
        at = rf.to;
    }
    // The space keeps a last empty line as tall as the textarea's.
    m.innerHTML = html + escapeHtml( text.slice( at ) ) + ' ';
    m.hidden    = false;

    placeMirror( ta, m );
}

function hideMirror( ta )
{
    ta.classList.remove( 'rf-on' );
    const m = mirrorOf( ta, false );
    if( m ) { m.hidden = true; m.textContent = ''; }
}

//------------------------------------------------------------------------//
// KEEPING UP WITH THE EDITOR
//
// grid.js calls syncRefs() when the cell editor opens, on every change of
// its text (typed, pointed at or put in by the formula editor) and when it
// closes. The grid is redrawn only when the frames really changed.

function syncRefs()
{
    const ed = table && table.getActiveEditor();
    const ta = ed && ed.TEXTAREA;
    const on = !! ta && ed.isOpened() && ta.value.charAt( 0 ) === '=';

    refs = on ? formulaRefs( ta.value ) : [];

    if( ta ) { if( on ) paintMirror( ta, refs ); else hideMirror( ta ); }

    const key = refs.map( function( rf ) { const b = rf.bounds; return b ? rf.color + ':' + b.r1 + ',' + b.c1 + ',' + b.r2 + ',' + b.c2 : ''; } ).join( '|' );
    if( key !== refsKey ) { refsKey = key; if( table ) table.render(); }
}

// A new grid (New, Open) starts with no editor open.
function resetRefs()
{
    refs    = [];
    refsKey = '';
}

export
{
    syncRefs, resetRefs, refAt, formulaRefs
};
