/*
 * listing.js - Drive: search, the file listing rows, icons, file-type lists and
 * size / date formats.
 */
"use strict";

// What the box asks the server, which matches basenames accent- and
// case-blind. A query with * or ? is an anchored shell glob - the rule the
// search box has always shown (GET ?find=). Anything else is the shared rule
// (Ayni.matcher): one word or "phrase" is still a ?find= substring;
// several, or a -word, become the advanced search's name rules (has / not,
// every one must hold).
function buildQuery( raw )
{
    const q = (raw || '').trim();
    if( ! q ) return null;
    if( q.indexOf( '*' ) !== -1 || q.indexOf( '?' ) !== -1 ) return { glob: q };
    const m = Ayni.matcher( q );
    if( ! m ) return null;
    if( m.terms.length === 1 && ! m.not.length ) return { glob: '*' + m.terms[ 0 ] + '*' };
    return { spec: { rules: m.terms.map( t => ( { op: 'has', text: t } ) )
                            .concat( m.not.map( t => ( { op: 'not', text: t } ) ) ) } };
}

// Runs whichever search is on: the "Biggest files" list, the advanced one
// (advsearch.js) when it is in force, else the box's (buildQuery).
async function runSearch()
{
    const asked = advSearch || bigMode ? null : buildQuery( searchQuery );
    if( ! advSearch && ! bigMode && ! asked )
    {
        searchHits = null;
        searchTruncated = false;
        render();
        return;
    }

    const seq = ++searchSeq;
    try
    {
        const r = bigMode   ? await AyniNet.biggest( BIG_COUNT )
                : advSearch ? await AyniNet.search( advSearch.spec, true )
                : asked.spec ? await AyniNet.search( asked.spec, true )
                :             await AyniNet.find( asked.glob, true );
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
        Ayni.toast( 'err', T( 'drive.searchFailed' ) );
    }
}

// "Biggest files": the BIG_COUNT largest files of the whole Drive, biggest
// first. The header's #bigFilesBtn opens and closes it, like the bin's
// button; the "space almost full" card (shared/ui.js) opens it too - with ?big=1,
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
// while every row's hover / border still spans the full width. `grid`: the
// same rows, drawn as icons in a grid instead (drive.css .is-grid).
function listRowsHost( grid )
{
    const host = document.getElementById( 'listing' );
    host.innerHTML = '';
    const rows = document.createElement( 'div' );
    rows.className = 'list-rows' + ( grid ? ' is-grid' : '' );
    host.appendChild( rows );
    return rows;
}

// "Shared with me" (server/go/shares.go): a virtual folder beside Home.
// With no folder tree to hang it on, it is the first thing in Home - not a
// pickable row (nothing can be done TO it), only a way in.
function sharedEntry()
{
    const row = document.createElement( 'div' );
    row.className = 'row row-virtual';
    row.tabIndex  = 0;
    row.setAttribute( 'role', 'link' );

    const ic = document.createElement( 'span' );
    ic.className = 'row-ic ic-shared';
    ic.innerHTML = SVG_SHARED;
    const label = document.createElement( 'span' );
    label.className   = 'row-name';
    label.textContent = T( 'drive.sharedWithMe' );
    const meta = document.createElement( 'span' );
    meta.className = 'row-meta';

    row.appendChild( ic );
    row.appendChild( label );
    row.appendChild( meta );
    row.addEventListener( 'click', function() { navigateTo( 'shared' ); } );
    row.addEventListener( 'keydown', function( e )
    {
        if( e.key !== 'Enter' && e.key !== ' ' ) return;
        e.preventDefault();
        e.stopPropagation();
        navigateTo( 'shared' );
    } );
    return row;
}

// Home shows it while the server has the folder, and the listing has not
// got it already (an admin's real root lists it as it is).
function showsSharedEntry()
{
    return currentFolder === FS_ROOT && !! findNode( 'shared' ) &&
         ! curListing.nodes.some( function( n ) { return n.path === 'shared'; } );
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

        const host = listRowsHost( viewMode === 'grid' && ! bigMode );   // "Biggest files" is about the sizes: a list
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
        const grid = viewMode === 'grid' && ! bigMode;
        hits.forEach( function( child )
        {
            const row = buildListRow( child, true );
            if( grid ) addThumb( row, child );
            host.appendChild( row );
        } );
        return;
    }

    if( listingLoading )
    {
        box.innerHTML = '<div class="empty-hint" data-i18n="ui.loading"></div>';
        return;
    }

    const kids = curListing.nodes.slice().sort( function( a, b )
    {
        const da = dirLike( a ), db = dirLike( b );
        if( da !== db ) return da ? -1 : 1;                 // folders first
        return displayName( a ).localeCompare( displayName( b ), Ayni.i18n.lang(), { sensitivity: 'base', numeric: true } );
    });

    const shared = showsSharedEntry();
    if( ! kids.length && ! shared )
    {
        box.innerHTML = '<div class="empty-hint" data-i18n="drive.emptyFolderHint"></div>';
        return;
    }

    const grid = viewMode === 'grid';
    const host = listRowsHost( grid );
    if( shared ) host.appendChild( sharedEntry() );
    kids.forEach( function( child )
    {
        const row = buildListRow( child );
        if( grid ) addThumb( row, child );      // a picture shows itself (thumbs.js)
        host.appendChild( row );
    });
}

// Icons shown in the listing. The document / spreadsheet / code glyphs are the
// Write, Calc and Text app marks, so a row looks like the tool that opens it.
// The folder, image and restore glyphs and the Write / Calc logos come from
// the shared set (Ayni.icon, with Nayive's icons from ui.js), so a logo changed there
// changes here too; driveGlyph only puts back Drive's own markup (width and
// height 18 when `size`, no aria-hidden), the row's DOM stays as it was.
function driveGlyph( svg, size )
{
    svg = svg.replace( ' aria-hidden="true"', '' );
    return size ? svg.replace( '<svg ', '<svg width="' + size + '" height="' + size + '" ' ) : svg;
}
const SVG_FOLDER = driveGlyph( Ayni.icon( 'folder' ), 18 );
// "Shared with me": the folder, with a person in it.
const SVG_SHARED = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><circle cx="12" cy="11.6" r="1.7"></circle><path d="M8.9 17.2a3.1 3.1 0 0 1 6.2 0"></path></svg>';
// Trash-view action glyphs: close, restore, permanent delete.
const SVG_RESTORE = driveGlyph( Ayni.icon( 'restore' ) );
const SVG_TRASH   = Ayni.icon( 'trash' );
const SVG_FILE   = Ayni.icon( 'file-plain', '', 18 );
const SVG_DOC    = driveGlyph( Ayni.icon( 'write' ), 18 );
const SVG_SHEET  = driveGlyph( Ayni.icon( 'calc' ), 18 );
const SVG_PDF    = Ayni.icon( 'pdf', '', 18 );
// An archive (ARCHIVE_EXT): the page with a zipper down it and its pull tab.
const SVG_ZIP    = Ayni.icon( 'zip', '', 18 );
const SVG_CODE   = Ayni.icon( 'code', '', 18 );
const SVG_IMAGE  = driveGlyph( Ayni.icon( 'image' ), 18 );
// A shortcut's arrow, laid over the corner of its icon (drive.css .link-arrow).
const SVG_LINK_ARROW = '<svg class="link-arrow" viewBox="0 0 12 12" aria-hidden="true"><rect x="0.5" y="0.5" width="11" height="11" rx="2.5"></rect><path d="M4 8.5 8.5 4M5 4h3.5v3.5"></path></svg>';
const SVG_VIDEO  = Ayni.icon( 'video', '', 18 );
const SVG_AUDIO  = Ayni.icon( 'music', '', 18 );
// Only used inside "Compartido conmigo": the Photos and Trips launcher
// glyphs, so a shared album / trip looks like the app that opens it.
const SVG_PHOTOS = Ayni.icon( 'photos', '', 18 );
const SVG_TRIPS  = Ayni.icon( 'trips', '', 18 );
const SVG_SPLIT  = Ayni.icon( 'euro', '', 18 );

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
//   IMAGE_EDIT  the formats the photo editor can load AND re-encode
//               (canvas.toDataURL) → they open in Image (apps/image).
//   IMAGE_VIEW  every other raster type → the plain lightbox (view only), and
//               it also stays the superset used for the file-row icon.
const IMAGE_EDIT = AyniPhoto.EDIT_EXT;     // shared/ayni/ayni-photo.js: Image takes the same list
const IMAGE_VIEW = [ 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif' ];
// Audio / video → Drive's own player (browser-native <audio>/<video> controls,
// view only, no editing). What actually plays depends on the browser's codecs.
const VIDEO_VIEW = [ 'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv' ];
const AUDIO_VIEW = [ 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba' ];

const extOf = Ayni.extOf, pad2 = Ayni.dates.pad;   // shared/ui.js (loads before this file)

// Server nodes carry `size` (bytes, files only) and `mtime` (last-modified,
// Unix seconds). Dates always render yyyy-mm-dd (Nayive ANSI-date rule).
function fmtSize( bytes ) { return bytes == null ? '' : Ayni.fmtBytes( bytes ); }

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

// A folder, or a shortcut to one: sorted with the folders.
function dirLike( node ) { return isDir( node ) || ( isLink( node ) && !! node.link.dir ); }

function listIcon( node )
{
    // A shortcut wears what it leads to (its arrow: buildListRow).
    if( isLink( node ) && ! linkBroken( node ) ) return listIcon( linkTarget( node ) );
    if( isLink( node ) ) return node.link.dir ? { cls: '', svg: SVG_FOLDER } : { cls: '', svg: SVG_FILE };

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
    // folder row are the shared item list's (menus.js wires it): the row
    // is only what it shows.
    const row = document.createElement( 'div' );
    row.className     = 'row';
    row.dataset.path  = node.path;
    if( dir ) row.dataset.dir = '1';

    // One icon, always: the app (or file type) that opens this row. Inside
    // "Compartido conmigo" it doubles as the "who lent me this" tooltip —
    // the whole folder already says the items are somebody else's.
    const icon = listIcon( node );
    const ic   = document.createElement( 'span' );
    ic.className = 'row-ic' + icon.cls;
    ic.innerHTML = icon.svg;

    // A shortcut: the icon of what it leads to, with an arrow in its corner;
    // a broken one is dimmed (drive.css .is-link, .is-broken).
    if( isLink( node ) )
    {
        row.classList.add( 'is-link' );
        if( linkBroken( node ) ) row.classList.add( 'is-broken' );
        ic.insertAdjacentHTML( 'beforeend', SVG_LINK_ARROW );
    }
    if( node.shared )
        ic.title = node.shared.by ? TF( 'drive.sharedByWho', { who: node.shared.by } ) : T( 'drive.sharedWithYou' );

    const label = document.createElement( 'span' );
    label.className   = 'row-name';
    label.textContent = name;
    label.title       = name;        // an icon cuts a long name after two lines

    const meta = document.createElement( 'span' );
    meta.className = 'row-meta';

    if( showPath )
    {
        meta.textContent = fsRel( Ayni.dirOf( node.path ) ) || homeName();
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
    else if( isLink( node ) )
    {
        // Where the original is, not the shortcut's own size and date.
        if( linkBroken( node ) ) meta.textContent = T( 'drive.shortcutBroken' );
        else
        {
            meta.textContent = '→ ' + ( fsRel( Ayni.dirOf( node.link.to ) ) || homeName() );
            meta.title       = TF( 'drive.shortcutTo', { path: fsRel( node.link.to ) } );
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

