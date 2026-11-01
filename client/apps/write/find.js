/*
 * find.js - Write's find / replace bar (#findBar in index.html): Ctrl+F, Ctrl+H,
 * Edicion > Buscar / Reemplazar and the toolbar's magnifier.
 *
 * A strip above the pages: Ayni's find bar (Ayni.findBar draws it and keeps its
 * keys: Enter / Shift+Enter step, Enter in the replacement replaces, Esc clears
 * then closes; its buttons never take the cursor). The engine finds (findMatches, with
 * match case) and selects a match (selectMatch, which also scrolls it into
 * view); every match on screen gets a mark of ours, drawn the way the spell
 * check draws its red lines (proofing-overlay.js, runRects) in #findLayer.
 *
 * Replacing is select-then-type, because the engine's own replaceMatch /
 * replaceAllMatches are refused in 2.21.0 (quirks.js, replaceMatchUnsupported):
 * selectMatch( m ), then insertText over the selection. "Replace all" does that
 * from the last match to the first, so the earlier ones keep their offsets -
 * one undo step per match (the engine's history grouping does not take
 * insertText).
 *
 * selectMatch and insertText put the focus in the document; the bar takes it
 * back (keepFocus), so Enter, Enter, Enter walks the matches as in any editor.
 *
 * Only the BODY is searched: a match in a header or footer would have to open
 * it first. Regular expressions and "ignore accents" are gone with the old
 * engine (docs/write-docx-editor-plan.md, losses).
 *
 *   const find = createFindBar( {
 *       editor : () => editor,
 *       ready  : () => bool,          // a document is on screen
 *       focus  : () => ...            // back to the document
 *   } );
 *   find.open( withReplace )   find.close()   find.isOpen()
 */
import { runRects, runIndex } from './proofing-overlay.js';

const TYPE_MS   = 150;      // after the last key in the find box
const EDIT_MS   = 300;      // after the last edit to the document
const SCROLL_MS = 120;      // after the last scroll: newly painted pages get their marks

export function createFindBar( o )
{
    const bar      = document.getElementById( 'findBar' );
    const scroller = document.getElementById( 'editor' );
    const layer    = document.getElementById( 'findLayer' );

    let query = '';            // what the bar's field asks for
    let matches = [];          // body matches for the current query, in document order
    let current = -1;          // index into `matches`, -1 = none picked yet
    let matchCase = false;
    let typeT = null, editT = null, scrollT = null;
    let hooked = null;         // the editor whose 'change' we listen to

    //---- the bar -------------------------------------------------------------

    const fb = Ayni.findBar( bar, {
        // The words or Match case changed: a new look, a moment after the last key.
        find: function( text, opts )
        {
            query = text; matchCase = !! opts.matchCase;
            clearTimeout( typeT );
            typeT = setTimeout( function() { search( true ); }, TYPE_MS );
        },
        step:    step,
        replace: function( text, all ) { if( all ) replaceAll( text ); else replaceOne( text ); },
        // The selection, when it is a word or a phrase, is what to look for.
        selected: function()
        {
            const ed = o.editor();
            try { return ( ed && ed.query( { type: 'selectedText' } ) ) || ''; } catch( _ ) { return ''; }
        },
        onClose: function()
        {
            clearTimeout( typeT ); clearTimeout( editT );
            matches = []; current = -1;
            layer.textContent = '';
            o.focus();                 // the last match stays selected, as in Word
        }
    } );

    function isOpen() { return fb.isOpen(); }

    function open( withReplace )
    {
        const ed = o.editor();
        if( ! ed ) return;

        if( hooked !== ed ) { ed.on( 'change', onDocChange ); hooked = ed; }
        fb.open( !! withReplace );
    }

    function close() { fb.close(); }

    //---- finding -------------------------------------------------------------

    function find()
    {
        const ed = o.editor(), q = query;
        if( ! ed || ! q ) return [];

        let list = [];
        try { list = ed.findMatches( q, { matchCase: matchCase } ) || []; } catch( _ ) {}
        return list.filter( function( m ) { return ! m.scope || m.scope.kind === 'body'; } );
    }

    // Run the query again. `go` = select the first match (a new query); else
    // keep the one that was current, if it is still there.
    function search( go )
    {
        const was = matches[ current ];
        matches = find();
        current = -1;

        if( was && ! go ) current = matches.findIndex( function( m ) { return m.blockId === was.blockId && m.start === was.start; } );
        if( go && matches.length ) select( 0 );

        paint();
    }

    function select( i )
    {
        const ed = o.editor();
        if( ! ed || ! matches.length ) return;

        current = ( i + matches.length ) % matches.length;
        keepFocus( function() { try { ed.selectMatch( matches[ current ] ); } catch( _ ) {} } );

        paint();
    }

    // Run fn, and if the focus was in the bar, put it back where it was.
    function keepFocus( fn )
    {
        const had = document.activeElement;
        try { return fn(); }
        finally { if( had && bar.contains( had ) && document.activeElement !== had ) had.focus(); }
    }

    // Next / previous: from the current match, after a fresh look (the text may
    // have changed since).
    function step( dir )
    {
        if( ! query ) return;

        const was = matches[ current ];
        matches = find();
        if( ! matches.length ) { current = -1; paint(); return; }

        let i = was ? matches.findIndex( function( m ) { return m.blockId === was.blockId && m.start === was.start; } ) : -1;
        i = i < 0 ? ( dir > 0 ? 0 : matches.length - 1 ) : i + dir;
        select( i );
    }

    //---- replacing -----------------------------------------------------------

    // Put `text` over one match: select it, type it. False when the engine said no.
    function putOver( ed, m, text )
    {
        return keepFocus( function()
        {
            const s = ed.selectMatch( m );
            if( s && s.ok === false ) return false;

            const r = ed.exec( { type: 'insertText', text: text } );
            return ! ( r && r.ok === false );
        } );
    }

    function replaceOne( text )
    {
        const ed = o.editor();
        if( ! ed || ! o.ready() || ! query ) return;

        matches = find();
        if( ! matches.length ) { current = -1; paint(); return; }

        const i = Math.max( 0, Math.min( current, matches.length - 1 ) );
        if( ! putOver( ed, matches[ i ], text ) ) { Ayni.toast( 'err', Ayni.t( 'write.actionFailed' ) ); return; }

        // The next one is the match that now sits at the same index.
        matches = find();
        if( matches.length ) select( i ); else { current = -1; paint(); }
    }

    function replaceAll( text )
    {
        const ed = o.editor();
        if( ! ed || ! o.ready() || ! query ) return;

        const list = find();
        let failed = 0;

        for( let i = list.length - 1; i >= 0; i-- ) if( ! putOver( ed, list[ i ], text ) ) failed++;

        // How many, and that Undo takes them back one at a time (quirks.js,
        // replaceAllOneStepPerMatch) - fifty Ctrl+Z are a surprise otherwise.
        if( failed ) Ayni.toast( 'err', Ayni.t( 'write.actionFailed' ) );
        else if( list.length ) Ayni.toast( 'ok', Ayni.tf( 'write.find.replaced', { n: list.length } ) );
        search( false );
    }

    //---- the marks -----------------------------------------------------------

    function paint()
    {
        fb.count( current + 1, matches.length );      // "3 / 12", "– / 12", a red "0"

        layer.textContent = '';
        if( ! matches.length ) return;

        const origin = layer.getBoundingClientRect();
        const view   = scroller.getBoundingClientRect();
        const frag   = document.createDocumentFragment();
        const spans  = runIndex( scroller );       // once per paint, not once per match

        matches.forEach( function( m, i )
        {
            for( const r of runRects( scroller, m.blockId, m.start, m.start + m.length, spans ) )
            {
                if( r.bottom < view.top - view.height || r.top > view.bottom + view.height ) continue;

                const d = document.createElement( 'div' );
                d.className = 'find-mark' + ( i === current ? ' is-current' : '' );
                d.style.left   = ( r.left - origin.left ) + 'px';
                d.style.top    = ( r.top  - origin.top  ) + 'px';
                d.style.width  = r.width  + 'px';
                d.style.height = r.height + 'px';
                frag.appendChild( d );
            }
        } );
        layer.appendChild( frag );
    }

    function onDocChange()
    {
        if( ! isOpen() ) return;
        clearTimeout( editT );
        editT = setTimeout( function() { search( false ); }, EDIT_MS );
    }

    scroller.addEventListener( 'scroll', function()
    {
        if( ! isOpen() || ! matches.length ) return;
        clearTimeout( scrollT );
        scrollT = setTimeout( paint, SCROLL_MS );
    }, { passive: true } );

    new ResizeObserver( function() { if( isOpen() ) paint(); } ).observe( document.getElementById( 'editorHost' ) );

    return { open: open, close: close, isOpen: isOpen };
}
