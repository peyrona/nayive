/*
 * advsearch.js - Drive: the advanced search ("Búsqueda avanzada").
 *
 * The magnifier inside the search box opens a dialog with name rules, kinds
 * and a date window. It goes to the server as ?search= (server/go/search.go),
 * never as a glob. While it is in force the box gives way to a button that
 * says so and reopens the dialog; clearSearch() (navigate.js) ends it like
 * any other search, and runSearch() (listing.js) re-runs it.
 */
"use strict";

const SB_OPS      = [ 'has', 'not', 'starts', 'ends', 'is' ];
const SB_WHEN     = [ 'any', 'today', 'd7', 'd30', 'year', 'range' ];

// What each "Tipo" pill finds, built on the lists listing.js keeps for the
// row icons and the openers. A function, not a table: CONVERT_EXT lives in
// upload.js, which loads after this file.
function sbKindList()
{
    return [
        { id: 'dir'   },
        { id: 'doc',   exts: WRITE_IMPORT.concat( OFFICE_WRITE, [ 'doc', 'rtf' ] ) },
        { id: 'sheet', exts: CALC_IMPORT.concat( OFFICE_CALC, [ 'xls' ] ) },
        { id: 'pdf',   exts: [ 'pdf' ] },
        { id: 'img',   exts: IMAGE_VIEW.concat( [ 'heic', 'heif' ] ) },
        { id: 'video', exts: VIDEO_VIEW.concat( CONVERT_EXT ) },
        { id: 'audio', exts: AUDIO_VIEW },
        { id: 'code',  exts: TEXT_IMPORT },
        { id: 'zip',   exts: ARCHIVE_EXT }
    ];
}

let sbDraft   = null;       // the dialog's working copy; advSearch keeps the one applied
let sbSeq     = 0;          // guards the live count against a late answer
let sbTimer   = null;       // debounce for the live count
let sbPreview = null;       // { key, nodes, truncated }: the last count, reused by Search

function sbIso( d ) { return d.getFullYear() + '-' + pad2( d.getMonth() + 1 ) + '-' + pad2( d.getDate() ); }

function sbMidnight( iso )
{
    const p = iso.split( '-' );
    return new Date( +p[0], +p[1] - 1, +p[2] );
}

function sbEmpty()
{
    const now = new Date();
    return { rules: [ { op: 'has', text: '' } ], any: false, kinds: [], when: 'any',
             from: sbIso( new Date( now.getFullYear(), now.getMonth(), 1 ) ), to: sbIso( now ) };
}

// "Hoy", "Últimos 7 días"... are the user's own days: local midnights, sent
// as Unix seconds. `until` is exclusive.
function sbWindow( d )
{
    const today = new Date();
    today.setHours( 0, 0, 0, 0 );
    const back = function( n ) { const x = new Date( today ); x.setDate( x.getDate() - n ); return x; };
    const secs = function( x ) { return Math.floor( x.getTime() / 1000 ); };

    switch( d.when )
    {
        case 'today': return { since: secs( today ) };
        case 'd7':    return { since: secs( back( 6 ) ) };
        case 'd30':   return { since: secs( back( 29 ) ) };
        case 'year':  return { since: secs( new Date( today.getFullYear(), 0, 1 ) ) };
        case 'range':
        {
            const out = {};
            if( d.from ) out.since = secs( sbMidnight( d.from ) );
            if( d.to )
            {
                const x = sbMidnight( d.to );
                x.setDate( x.getDate() + 1 );
                out.until = secs( x );
            }
            return out;
        }
    }
    return {};
}

// The draft as GumApi.search() wants it, or null when nothing is asked.
function sbSpec( d )
{
    const spec  = {};
    const rules = d.rules.filter( function( r ) { return r.text.trim(); } )
                         .map( function( r ) { return { op: r.op, text: r.text.trim() }; } );
    if( rules.length ) { spec.rules = rules; spec.any = d.any; }

    if( d.kinds.length )
    {
        spec.folders = d.kinds.indexOf( 'dir' ) !== -1;
        spec.exts    = [];
        sbKindList().forEach( function( k ) { if( k.exts && d.kinds.indexOf( k.id ) !== -1 ) spec.exts = spec.exts.concat( k.exts ); } );
    }

    const w = sbWindow( d );
    if( w.since ) spec.since = w.since;
    if( w.until ) spec.until = w.until;

    return Object.keys( spec ).length ? spec : null;
}

function sbJoin( list, word )
{
    if( list.length < 2 ) return list[0] || '';
    return list.slice( 0, -1 ).join( ', ' ) + ' ' + word + ' ' + list[ list.length - 1 ];
}

// The draft in words: "PDF o Documentos · nombre contiene «factura» · Últimos 30 días".
function sbDescribe( d )
{
    const bits  = [];
    const kinds = sbKindList().filter( function( k ) { return d.kinds.indexOf( k.id ) !== -1; } )
                           .map( function( k ) { return T( 'drive.kind.' + k.id ); } );
    if( kinds.length ) bits.push( sbJoin( kinds, T( 'drive.sbOr' ) ) );

    const rules = d.rules.filter( function( r ) { return r.text.trim(); } );
    if( rules.length )
        bits.push( T( 'drive.sbNameSum' ) + ' ' + rules.map( function( r )
        {
            return TF( 'drive.sbRuleSum', { op: T( 'drive.op.' + r.op ), q: r.text.trim() } );
        }).join( ' ' + T( d.any ? 'drive.sbOr' : 'drive.sbAnd' ) + ' ' ) );

    if( d.when === 'range' )
    {
        if( d.from || d.to ) bits.push( TF( 'drive.sbRangeSum', { from: d.from || '…', to: d.to || '…' } ) );
    }
    else if( d.when !== 'any' ) bits.push( T( 'drive.when.' + d.when ) );

    return bits.length ? bits.join( ' · ' ) : T( 'drive.sbNoFilters' );
}

function sbFilterCount( d )
{
    const w = sbWindow( d );
    return d.rules.filter( function( r ) { return r.text.trim(); } ).length
         + ( d.kinds.length ? 1 : 0 ) + ( w.since || w.until ? 1 : 0 );
}

// ---- the dialog ------------------------------------------------------------

// A row of shared .pill buttons: `on(id)` says which are lit, `pick(id)`
// changes the draft.
function sbPills( hostId, ids, label, on, pick )
{
    const host = document.getElementById( hostId );
    host.innerHTML = '';
    ids.forEach( function( id )
    {
        const b = document.createElement( 'button' );
        b.type        = 'button';
        b.className   = 'pill' + ( on( id ) ? ' is-active' : '' );
        b.textContent = label( id );
        b.setAttribute( 'aria-pressed', on( id ) ? 'true' : 'false' );
        b.addEventListener( 'click', function() { pick( id ); sbRender(); } );
        host.appendChild( b );
    });
}

// One name rule: condition, text, ✕.
function sbRuleRow( rule, i )
{
    const row = document.createElement( 'div' );
    row.className = 'sb-rule';

    const sel = document.createElement( 'select' );
    sel.setAttribute( 'aria-label', T( 'drive.sbName' ) );
    SB_OPS.forEach( function( op )
    {
        const o = document.createElement( 'option' );
        o.value       = op;
        o.textContent = T( 'drive.op.' + op );
        sel.appendChild( o );
    });
    sel.value = rule.op;

    const inp = document.createElement( 'input' );
    inp.type         = 'text';
    inp.autocomplete = 'off';
    inp.spellcheck   = false;
    inp.value        = rule.text;
    inp.placeholder  = T( 'drive.opPh.' + rule.op );
    inp.setAttribute( 'aria-label', T( 'drive.sbName' ) );

    const del = document.createElement( 'button' );
    del.type      = 'button';
    del.className = 'icon-btn sm';
    del.title     = T( 'drive.sbRemoveRule' );
    del.setAttribute( 'aria-label', T( 'drive.sbRemoveRule' ) );
    del.innerHTML = NayiveUI.icon( 'x' );

    sel.addEventListener( 'change', function() { rule.op = sel.value; inp.placeholder = T( 'drive.opPh.' + rule.op ); sbChanged(); } );
    inp.addEventListener( 'input',  function() { rule.text = inp.value; sbChanged(); } );
    inp.addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) applySearchBuilder(); } );
    del.addEventListener( 'click', function()
    {
        if( sbDraft.rules.length > 1 ) sbDraft.rules.splice( i, 1 );
        else                           sbDraft.rules[0] = { op: 'has', text: '' };
        sbRender();
    });

    row.appendChild( sel );
    row.appendChild( inp );
    row.appendChild( del );
    return row;
}

// The native date text is hidden (.dt-field): the overlay shows yyyy-mm-dd.
function sbShowDates()
{
    [ [ 'sbFrom', sbDraft.from ], [ 'sbTo', sbDraft.to ] ].forEach( function( p )
    {
        const inp = document.getElementById( p[0] );
        inp.value = p[1];
        inp.parentNode.querySelector( '.dt-display' ).textContent = p[1];
    });
}

function sbRender()
{
    const d = sbDraft;

    const host = document.getElementById( 'sbRules' );
    host.innerHTML = '';
    d.rules.forEach( function( rule, i ) { host.appendChild( sbRuleRow( rule, i ) ); } );

    document.getElementById( 'sbModeRow' ).hidden = d.rules.length < 2;
    sbPills( 'sbMode', [ 'all', 'any' ],
             function( id ) { return T( id === 'any' ? 'drive.sbAny' : 'drive.sbAll' ); },
             function( id ) { return ( id === 'any' ) === d.any; },
             function( id ) { d.any = id === 'any'; } );

    const kinds = sbKindList().map( function( k ) { return k.id; } );
    sbPills( 'sbKinds', kinds,
             function( id ) { return T( 'drive.kind.' + id ); },
             function( id ) { return d.kinds.indexOf( id ) !== -1; },
             function( id )
             {
                 const on = d.kinds.indexOf( id ) === -1;
                 d.kinds = kinds.filter( function( k ) { return k === id ? on : d.kinds.indexOf( k ) !== -1; } );
             } );

    sbPills( 'sbWhen', SB_WHEN,
             function( id ) { return T( 'drive.when.' + id ); },
             function( id ) { return d.when === id; },
             function( id ) { d.when = id; } );

    document.getElementById( 'sbRange' ).hidden = d.when !== 'range';
    sbShowDates();
    sbChanged();
}

// Something in the draft changed: the words at once, the count a moment later.
function sbChanged()
{
    document.getElementById( 'sbSummary' ).textContent = sbDescribe( sbDraft );

    const count = document.getElementById( 'sbCount' );
    const spec  = sbSpec( sbDraft );
    if( sbTimer ) { clearTimeout( sbTimer ); sbTimer = null; }
    ++sbSeq;                                    // whatever is in flight is stale now

    if( ! spec ) { count.hidden = true; return; }

    const key = JSON.stringify( spec );
    count.hidden = false;
    if( sbPreview && sbPreview.key === key ) { sbShowCount( sbPreview ); return; }

    count.classList.remove( 'none' );
    count.textContent = T( 'drive.searching' );
    sbTimer = setTimeout( function() { sbFetchCount( spec, key ); }, 300 );
}

async function sbFetchCount( spec, key )
{
    const seq = ++sbSeq;
    try
    {
        const r = await GumApi.search( spec );
        if( seq !== sbSeq ) return;
        sbPreview = { key: key, nodes: pruneNodes( r.nodes || [] ), truncated: !! r.truncated };
        sbShowCount( sbPreview );
    }
    catch( _ )
    {
        if( seq !== sbSeq ) return;
        const count = document.getElementById( 'sbCount' );
        count.textContent = T( 'drive.searchFailed' );
        count.classList.add( 'none' );
    }
}

function sbShowCount( p )
{
    const n     = p.nodes.length;
    const count = document.getElementById( 'sbCount' );
    count.textContent = p.truncated ? TF( 'drive.sbFoundMore', { n: n } )
                      : n === 0     ? T( 'drive.sbFoundNone' )
                      : n === 1     ? T( 'drive.sbFoundOne' )
                      :               TF( 'drive.sbFoundMany', { n: n } );
    count.classList.toggle( 'none', n === 0 );
}

// Opens on the search in force, else empty - a plain word already in the box
// carries over as "contiene".
function openSearchBuilder()
{
    if( advSearch ) sbDraft = JSON.parse( JSON.stringify( advSearch.draft ) );
    else
    {
        sbDraft = sbEmpty();
        const box = document.getElementById( 'searchInput' ).value.trim();
        if( box && ! /[*?[]/.test( box ) ) sbDraft.rules[0].text = box;
    }
    sbPreview = null;
    sbRender();
    setBackdrop( 'searchBuilderBackdrop', true );
    document.querySelector( '#sbRules input' ).focus();
}

function addBuilderRule()
{
    sbDraft.rules.push( { op: 'has', text: '' } );
    sbRender();
    const inputs = document.querySelectorAll( '#sbRules input' );
    inputs[ inputs.length - 1 ].focus();
}

function clearSearchBuilder()
{
    sbDraft = sbEmpty();
    sbRender();
}

function onBuilderDate()
{
    sbDraft.from = document.getElementById( 'sbFrom' ).value;
    sbDraft.to   = document.getElementById( 'sbTo'   ).value;
    sbShowDates();
    sbChanged();
}

// Search: nothing asked = back to the plain folder view.
function applySearchBuilder()
{
    const d    = sbDraft;
    const spec = sbSpec( d );
    if( sbTimer ) { clearTimeout( sbTimer ); sbTimer = null; }
    ++sbSeq;
    setBackdrop( 'searchBuilderBackdrop', false );

    clearSearch();                      // the box's own search, and any earlier advanced one
    clearSel();
    if( ! spec ) { render(); return; }

    advSearch = { draft: JSON.parse( JSON.stringify( d ) ), spec: spec,
                  summary: sbDescribe( d ), nFilters: sbFilterCount( d ) };
    showAdvSearchBox();

    const key = JSON.stringify( spec );
    if( sbPreview && sbPreview.key === key )        // the live count already fetched these
    {
        ++searchSeq;
        searchHits      = sbPreview.nodes;
        searchTruncated = sbPreview.truncated;
        render();
        return;
    }
    render();                           // "Buscando…" until the server answers
    runSearch();
}

// ---- while it is in force ----------------------------------------------------

// The box, or the button that stands in for it.
function showAdvSearchBox()
{
    const chip = document.getElementById( 'advChip' );
    document.querySelector( '.search-wrap' ).classList.toggle( 'adv-on', !! advSearch );
    document.getElementById( 'searchInput' ).hidden = !! advSearch;
    chip.hidden = ! advSearch;
    if( ! advSearch ) return;

    document.getElementById( 'advChipText' ).textContent =
        advSearch.nFilters === 1 ? T( 'drive.sbActiveOne' ) : TF( 'drive.sbActiveMany', { n: advSearch.nFilters } );
    chip.title = advSearch.summary;
    driveSearch.open();                 // the box stays unfolded while it is in force
}

// The breadcrumb: "Resultados (n)", what was asked, and the way out.
function advSearchCrumbs( host, info )
{
    info.textContent = searchHits === null
        ? T( 'drive.searching' )
        : TF( 'drive.sbResults', { n: searchHits.length + ( searchTruncated ? '+' : '' ) } );
    host.appendChild( info );

    const sum = document.createElement( 'span' );
    sum.className   = 'crumb-summary';
    sum.textContent = advSearch.summary;
    sum.title       = advSearch.summary;
    host.appendChild( sum );

    const out = document.createElement( 'button' );
    out.type        = 'button';
    out.className   = 'pill crumb-clear';
    out.textContent = T( 'drive.sbClearFilters' );
    out.addEventListener( 'click', endAdvSearch );
    host.appendChild( out );
}

// "Quitar filtros", or Escape on the button in the box: back to the folder,
// and the box folds away, as its × and Escape in the box itself do.
function endAdvSearch()
{
    driveSearch.close();                // its onClose: clearSearch, render
}
