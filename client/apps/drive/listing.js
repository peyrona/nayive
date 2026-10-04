/*
 * listing.js - Drive: search, the file listing rows, icons, file-type lists and
 * size / date formats.
 */
"use strict";

// A plain word searches as a substring; a query with * or ? is an
// anchored wildcard — the rule the search box has always shown. Either
// way we hand the server a shell glob and it matches basenames,
// case-insensitive (GET /api/files?find=).
function buildPattern( raw )
{
    const q = (raw || '').trim();
    if( ! q ) return null;
    return (q.indexOf( '*' ) !== -1 || q.indexOf( '?' ) !== -1) ? q : ('*' + q + '*');
}

// Runs whichever search is on: the "Biggest files" list, the advanced one
// (advsearch.js) when it is in force, else the box's glob.
async function runSearch()
{
    const pattern = advSearch || bigMode ? null : buildPattern( searchQuery );
    if( ! advSearch && ! bigMode && ! pattern )
    {
        searchHits = null;
        searchTruncated = false;
        render();
        return;
    }

    const seq = ++searchSeq;
    try
    {
        const r = bigMode   ? await GumApi.biggest( BIG_COUNT )
                : advSearch ? await GumApi.search( advSearch.spec )
                :             await GumApi.find( pattern );
        if( seq !== searchSeq ) return;          // a newer query already went out
        searchHits      = pruneNodes( r.nodes || [] );
        searchTruncated = !! r.truncated;
        render();
    }
    catch( err )
    {
        if( seq !== searchSeq ) return;
        searchHits = [];
        searchTruncated = false;
        render();
        NayiveUI.toast( T( 'drive.searchFailed' ) );
    }
}

// "Biggest files": the BIG_COUNT largest files of the whole Drive, biggest
// first. The header's #bigFilesBtn opens and closes it, like the bin next to
// it; the "space almost full" card (shared/ui.js) opens it too - with ?big=1,
// or with its "nayive:bigfiles" event when Drive is already open. It rides on
// the search view: a row shows its size and folder, and the toolbar acts on
// the ticked rows as usual.
const BIG_COUNT = 50;

function openBigFiles()
{
    if( trashMode ) { trashMode = false; trashItems = []; }
    clearSearch();
    clearSel();
    bigMode = true;
    driveSearch.close( true );          // fold the box; the list below replaces the search
    render();                           // "Buscando…" until the server answers
    runSearch();
}

// The breadcrumb: just "Biggest files" - the way out is the lit header
// button, as with the bin. The reminder that a deleted file still takes
// space in the bin sits over the rows (renderListing).
function bigFilesCrumbs( host, info )
{
    info.textContent = T( 'drive.bigTitle' );
    host.appendChild( info );
}

// Rows live in a .list-rows wrapper so the wrapper can grow to the widest
// row (width: max-content) and the #listing box scrolls it horizontally,
// while every row's hover / border still spans the full width.
function listRowsHost()
{
    const host = document.getElementById( 'listing' );
    host.innerHTML = '';
    const rows = document.createElement( 'div' );
    rows.className = 'list-rows';
    host.appendChild( rows );
    return rows;
}

function renderListing()
{
    const box = document.getElementById( 'listing' );

    if( isSearching() )
    {
        if( searchHits === null )                 // still waiting on the server
        {
            box.innerHTML = '<div class="empty-hint" data-i18n="drive.searching"></div>';
            return;
        }

        const hits = searchHits.slice().sort( bigMode
            ? function( a, b ) { return ( b.size || 0 ) - ( a.size || 0 ); }   // biggest first
            : function( a, b )
            {
                const da = isDir( a ), db = isDir( b );
                if( da !== db ) return da ? -1 : 1;             // folders first
                return a.path.localeCompare( b.path );
            });

        if( ! hits.length )
        {
            box.innerHTML = '';
            const hint = document.createElement( 'div' );
            hint.className   = 'empty-hint';
            hint.textContent = bigMode   ? T( 'drive.bigNone' )
                             : advSearch ? T( 'drive.sbNoResults' )
                             :             TF( 'drive.noResultsFor', { q: searchQuery.trim() } );
            box.appendChild( hint );
            return;
        }

        const host = listRowsHost();
        if( bigMode )
        {
            const note = document.createElement( 'div' );
            note.className   = 'big-note';
            note.textContent = T( 'drive.bigNote' );
            box.insertBefore( note, host );
        }
        if( searchTruncated )
        {
            const note = document.createElement( 'div' );
            note.className   = 'empty-hint';
            note.textContent = TF( 'drive.tooManyResults', { n: hits.length } );
            box.insertBefore( note, host );
        }
        hits.forEach( function( child ) { host.appendChild( buildListRow( child, true ) ); } );
        return;
    }

    if( listingLoading )
    {
        box.innerHTML = '<div class="empty-hint" data-i18n="ui.loading"></div>';
        return;
    }

    const kids = curListing.nodes.slice().sort( function( a, b )
    {
        const da = isDir( a ), db = isDir( b );
        if( da !== db ) return da ? -1 : 1;                 // folders first
        return displayName( a ).localeCompare( displayName( b ), NayiveUI.lang(), { sensitivity: 'base', numeric: true } );
    });

    if( ! kids.length )
    {
        box.innerHTML = '<div class="empty-hint" data-i18n="drive.emptyFolderHint"></div>';
        return;
    }

    const host = listRowsHost();
    kids.forEach( function( child )
    {
        host.appendChild( buildListRow( child ) );
    });
}

// Icons shown in the listing. The document / spreadsheet / code glyphs are the
// Write, Calc and Text app marks, so a row looks like the tool that opens it.
const SVG_FOLDER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
// Trash-view action glyphs: close, restore, permanent delete.
const SVG_RESTORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>';
const SVG_TRASH   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
const SVG_FILE   = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
const SVG_DOC    = '<svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor"><g transform="translate(45 465) rotate(-48)"><path d="M0 0 28 -14 82 -36C96 -36 110 -27 122 -19L122 19C110 27 96 36 82 36L28 14Z"></path><rect x="132" y="-26" width="350" height="52"></rect><path d="M494 -26 522 -26C542 -26 550 -14 550 0 550 14 542 26 522 26L494 26Z"></path></g><rect x="262" y="220" width="176" height="50" rx="12"></rect><path fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" d="M294 270 294 300C294 314 228 312 228 332L228 445C228 460 240 472 255 472L445 472C460 472 472 460 472 445L472 332C472 312 406 314 406 300L406 270"></path><path d="M228 355 472 355 472 445C472 460 460 472 445 472L255 472C240 472 228 460 228 445Z"></path></svg>';
const SVG_SHEET  = '<svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor"><g transform="translate(-213.2 -558.1) scale(1.8891 3.2191)"><g transform="translate(37.3 3.7)"><path d="m 159.5,210.8 v 7.2 h 25.2 v 16.5 H 159.5 V 300 h -21.5 v -65.6 h -19.9 v -16.5 h 19.9 v -5.7 q 0,-14.8 6.2,-20.5 6.2,-5.7 22.9,-5.7 h 17.7 v 16.5 h -16.8 q -4.8,0 -6.6,1.8 -1.7,1.8 -1.8,6.5 z"></path><g transform="translate(67.4 112.5) scale(.625)"><path d="m 243.4,186.2 q -9.7,17.5 -14.4,33.9 -4.7,16.4 -4.7,32.8 0,16.3 4.7,32.8 4.7,16.5 14.4,34.1 h -16.7 q -11.6,-16.9 -17.3,-33.3 -5.6,-16.5 -5.6,-33.5 0,-17 5.6,-33.5 5.7,-16.6 17.3,-33.3 z"></path><path d="M 329.9,218 302.2,257.2 332.3,300 H 307.2 L 291.1,272.4 275.1,300 h -25 l 30.3,-42.8 -27.9,-39.3 h 25 l 13.6,24.5 13.7,-24.5 z"></path><path d="m 338.9,186.2 h 16.7 q 11.6,16.7 17.2,33.3 5.7,16.5 5.7,33.5 0,17.1 -5.6,33.5 -5.6,16.4 -17.3,33.3 h -16.7 q 9.7,-17.6 14.4,-34.1 4.7,-16.6 4.7,-32.8 0,-16.4 -4.7,-32.8 -4.7,-16.4 -14.4,-33.9 z"></path></g></g></g></svg>';
const SVG_PDF    = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><text x="12" y="18.5" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">PDF</text></svg>';
// An archive (ARCHIVE_EXT): the page with a zipper down it and its pull tab.
const SVG_ZIP    = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M11 3.5h1M10 6h1M11 8.5h1M10 11h1"></path><rect x="8.5" y="13.5" width="5" height="5" rx="1"></rect></svg>';
const SVG_CODE   = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
const SVG_IMAGE  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
const SVG_VIDEO  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="16" rx="2"></rect><polygon points="22 7 16 11 16 13 22 17"></polygon><polygon points="7 9 11 12 7 15" fill="currentColor" stroke="none"></polygon></svg>';
const SVG_AUDIO  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
// Only used inside "Compartido conmigo": the Photos and Trips launcher
// glyphs, so a shared album / trip looks like the app that opens it.
const SVG_PHOTOS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="16" height="16" rx="2"></rect><circle cx="12" cy="8" r="2"></circle><path d="m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L11 18"></path><path d="M18 22H4a2 2 0 0 1-2-2V6"></path></svg>';
const SVG_TRIPS  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="5.5" cy="9" rx="2" ry="2.5"></ellipse><ellipse cx="12" cy="6" rx="2.1" ry="2.6"></ellipse><ellipse cx="18.5" cy="9" rx="2" ry="2.5"></ellipse><path d="M12 12c-4.5 0-7.8 2-7.8 4.4 0 2 2.55 3.3 5.4 2.9 1.35-.2 1.5-.7 2.4-.7s1.05.5 2.4.7c2.85.4 5.4-.9 5.4-2.9C19.8 14 16.5 12 12 12z"></path></svg>';
const SVG_SPLIT  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 7A7 7 0 1 0 16.5 17"></path><line x1="3" y1="10.2" x2="13.5" y2="10.2"></line><line x1="3" y1="13.8" x2="13.5" y2="13.8"></line></svg>';

// Extensions each tool can open/import (mirrors the accept="" of their import
// inputs — see apps/write, apps/calc). Kept disjoint so a double-click routes
// to exactly one tool.
const WRITE_IMPORT = [ 'docx' ];
const CALC_IMPORT  = [ 'xlsx', 'csv' ];
// Compressed files: all get the zipper icon. Only the last part of the name
// counts, so "x.tar.gz" is 'gz'.
const ARCHIVE_EXT  = [ 'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'lz', 'lzma', 'z', 'cab', 'arj', 'lzh' ];
// LibreOffice documents. Write and Calc cannot read them, so the server
// makes a .docx / .xlsx twin beside the original (openOffice below; keep
// officeTwin in server/go/office.go the same lists). The other LibreOffice
// kinds have no app here: they upload as they are (no twin) and a
// double-click only says Nayive cannot open them: Impress, Draw, Math, Base.
const OFFICE_WRITE  = [ 'odt', 'ott', 'fodt', 'sxw', 'stw' ];
const OFFICE_CALC   = [ 'ods', 'ots', 'fods', 'sxc', 'stc' ];
const OFFICE_REFUSE = [ 'odp', 'otp', 'fodp', 'sxi', 'sti',      // Impress
                        'odg', 'otg', 'fodg', 'sxd', 'std',      // Draw
                        'odf', 'sxm', 'odb' ];                   // Math, Base
// Plain-text / code / markup files → the Text editor (see apps/text), which is
// also the catch-all: it opens anything not owned by another tool and not a
// known-binary type, so this list only steers the file-row ICON.
const TEXT_IMPORT  =
[
    'txt', 'log', 'une', 'model', 'md', 'markdown', 'mkd',
    'html', 'htm', 'xhtml', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts',
    'json', 'map', 'webmanifest', 'xml', 'xsl', 'xsd', 'svg', 'rss',
    'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env',
    'sh', 'bash', 'zsh', 'ksh', 'ps1', 'bat', 'sql',
    'py', 'pyw', 'r', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'java', 'cs', 'tex'
];
// Raster images → an image opener. '.svg' is deliberately absent: it is
// text (the server sends it as image/svg+xml), so it stays in TEXT_IMPORT
// and opens in the Text editor.
//   IMAGE_EDIT  the formats the TOAST UI Image Editor can load AND re-encode
//               (canvas.toDataURL) → they open in Image (apps/image).
//   IMAGE_VIEW  every other raster type → the plain lightbox (view only), and
//               it also stays the superset used for the file-row icon.
const IMAGE_EDIT = [ 'png', 'jpg', 'jpeg', 'webp' ];
const IMAGE_VIEW = [ 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif' ];
// Audio / video → Drive's own player (browser-native <audio>/<video> controls,
// view only, no editing). What actually plays depends on the browser's codecs.
const VIDEO_VIEW = [ 'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv' ];
const AUDIO_VIEW = [ 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba' ];

const extOf = NayiveUI.extOf, pad2 = NayiveUI.pad2;   // shared/ui.js (loads before this file)

// Server nodes carry `size` (bytes, files only) and `mtime` (last-modified,
// Unix seconds). Dates always render yyyy-mm-dd (Nayive ANSI-date rule).
function fmtSize( bytes ) { return bytes == null ? '' : NayiveUI.fmtBytes( bytes ); }

// A day as yyyy-mm-dd (the listing's dates, the search dialog's fields).
function isoDay( d ) { return d.getFullYear() + '-' + pad2( d.getMonth() + 1 ) + '-' + pad2( d.getDate() ); }

function fmtDate( unixSec )
{
    if( ! unixSec ) return '';
    return isoDay( new Date( unixSec * 1000 ) );
}

function fmtDateTime( unixSec )
{
    if( ! unixSec ) return '';
    const d = new Date( unixSec * 1000 );
    return fmtDate( unixSec ) + ' ' + pad2( d.getHours() ) + ':' + pad2( d.getMinutes() );
}

// The app a shared item belongs to. Only the top-level rows of
// "Compartido conmigo" carry node.shared (server/go/shares.go RootNodes) —
// 'photos' | 'trips' | 'folder' | 'file'. Anything deeper inside a share
// is an ordinary file again.
function sharedApp( node )
{
    return ( node && node.shared && node.shared.app ) || '';
}

// The extension that decides the icon and the opener. A shared item's name
// is its slug ("SEPE.txt" -> "sepe-txt", the dot is gone), so its type comes
// from the grant's own title instead — see server/go/shares.go Slugify().
function typeExt( node )
{
    return extOf( node && node.shared ? ( node.shared.title || '' ) : nameOf( node ) );
}

function listIcon( node )
{
    // A shared album / trip shows ITS app's glyph, not a plain folder.
    const app = sharedApp( node );
    if( app === 'photos' ) return { cls: ' ic-photos', svg: SVG_PHOTOS };
    if( app === 'trips'  ) return { cls: ' ic-trips',  svg: SVG_TRIPS  };
    if( app === 'split'  ) return { cls: ' ic-trips',  svg: SVG_SPLIT  };   // a shared expenses group, opens in Split

    if( isDir( node ) ) return { cls: '', svg: SVG_FOLDER };

    const ext = typeExt( node );

    if( WRITE_IMPORT.includes( ext ) || OFFICE_WRITE.includes( ext ) ) return { cls: ' ic-doc',   svg: SVG_DOC   };
    if( CALC_IMPORT.includes( ext )  || OFFICE_CALC.includes( ext )  ) return { cls: ' ic-sheet', svg: SVG_SHEET };
    if( ext === 'pdf'                ) return { cls: ' ic-pdf',   svg: SVG_PDF   };
    if( ARCHIVE_EXT.includes( ext )  ) return { cls: ' ic-zip',   svg: SVG_ZIP   };
    if( TEXT_IMPORT.includes( ext )  ) return { cls: ' ic-code',  svg: SVG_CODE  };
    if( IMAGE_VIEW.includes( ext )   ) return { cls: ' ic-image', svg: SVG_IMAGE };
    if( VIDEO_VIEW.includes( ext )   ) return { cls: ' ic-media', svg: SVG_VIDEO };
    if( AUDIO_VIEW.includes( ext )   ) return { cls: ' ic-media', svg: SVG_AUDIO };

    return { cls: '', svg: SVG_FILE };
}

function buildListRow( node, showPath )
{
    const dir = isDir( node );
    const name = displayName( node );

    // Picking, opening, the row's tick and ⋮, its drag and the drop onto a
    // folder row are the shared item browser's (menus.js wires it): the row
    // is only what it shows.
    const row = document.createElement( 'div' );
    row.className     = 'row' + (selectedPaths.has( node.path ) ? ' is-selected' : '');
    row.dataset.path  = node.path;
    if( dir ) row.dataset.dir = '1';

    // One icon, always: the app (or file type) that opens this row. Inside
    // "Compartido conmigo" it doubles as the "who lent me this" tooltip —
    // the whole folder already says the items are somebody else's.
    const icon = listIcon( node );
    const ic   = document.createElement( 'span' );
    ic.className = 'row-ic' + icon.cls;
    ic.innerHTML = icon.svg;
    if( node.shared )
        ic.title = node.shared.by ? TF( 'drive.sharedByWho', { who: node.shared.by } ) : T( 'drive.sharedWithYou' );

    const label = document.createElement( 'span' );
    label.className   = 'row-name';
    label.textContent = name;

    const meta = document.createElement( 'span' );
    meta.className = 'row-meta';

    if( showPath )
    {
        meta.textContent = fsRel( NayiveMedia.dirOf( node.path ) ) || 'Drive';
        meta.title       = node.path;

        // The "Biggest files" list leads with the size - the one thing it is
        // about - and keeps it on a phone, where the rest of the meta hides.
        if( bigMode && node.size != null )
        {
            const size  = document.createElement( 'span' );
            const where = document.createElement( 'span' );
            size.textContent  = fmtSize( node.size );
            where.className   = 'row-where';
            where.textContent = ' · ' + meta.textContent;
            meta.textContent  = '';
            meta.appendChild( size );
            meta.appendChild( where );
            meta.classList.add( 'row-meta--big' );
        }
    }
    else
    {
        const bits = [];
        // A folder shows just its date: every listing sends its `nodes` as
        // an empty stub, so there is no child count to show.
        if( ! dir && node.size != null ) bits.push( fmtSize( node.size ) );
        if( node.mtime )                 bits.push( fmtDate( node.mtime ) );

        meta.textContent = bits.join( ' · ' );
        if( node.mtime ) meta.title = fmtDateTime( node.mtime );
    }

    row.appendChild( ic );
    row.appendChild( label );
    row.appendChild( meta );
    paintConvertBadge( row );

    return row;
}

